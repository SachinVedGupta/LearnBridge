import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'learnbridge-life-http-')), dataRoot = join(base, 'private'), runtimes = [];
  t.after(async () => { for (const runtime of runtimes.reverse()) await runtime.close(); await rm(base, { recursive: true, force: true }); });
  async function start() { const runtime = await startRuntime({ dataRoot, port: 0 }); runtimes.push(runtime); return runtime; }
  return { start, runtime: await start() };
}
async function pair(runtime) {
  const response = await fetch(`${runtime.origin}/api/local/v1/pair`, { method: 'POST', headers: { Origin: runtime.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: runtime.createPairingCode() }) });
  assert.equal(response.status, 200); return { nonce: (await response.json()).nonce, cookie: response.headers.get('set-cookie').split(';')[0] };
}
async function call(runtime, session, path, { method = 'GET', body, origin = runtime.origin, key, extraHeaders = {} } = {}) {
  const response = await fetch(`${runtime.origin}/api/local/v1${path}`, { method, headers: {
    ...(session ? { Cookie: session.cookie, 'X-LearnBridge-Nonce': session.nonce } : {}),
    ...(method === 'GET' ? {} : { Origin: origin, 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}), ...extraHeaders,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json() };
}
const pantry = { name: 'Rice', quantity: '100', unit: 'g', confirmed: true };

test('paired life HTTP flows verify accepted grocery snapshot, self-reported routine/next task and exact separate-currency totals after restart', async t => {
  const { runtime, start } = await fixture(t); let session = await pair(runtime);
  assert.equal((await call(runtime, session, '/life/pantry', { method: 'POST', body: pantry, key: 'http-life-pantry-0001' })).status, 201);
  const recipe = await call(runtime, session, '/life/recipes', { method: 'POST', body: { title: 'Rice fixture', servings: 2, prep_minutes: 20,
    ingredients: [{ name: 'rice', quantity: '200', unit: 'g', labels_complete: true }] }, key: 'http-life-recipe-0001' }); assert.equal(recipe.status, 201);
  const meal = await call(runtime, session, '/life/meals', { method: 'POST', body: { meals: [{ recipe_id: recipe.data.item.id, servings: 4, date: '2026-10-04' }], restrictions: [] }, key: 'http-life-meal-0001' }); assert.equal(meal.status, 201);
  const plan = (await call(runtime, session, '/life/meals')).data.items[0]; assert.equal(plan.data.plan.grocery[0].quantity, '300');
  assert.equal((await call(runtime, session, `/life/meals/${plan.id}/accept`, { method: 'POST', body: { expected_revision: plan.revision, plan_hash: plan.plan_hash } })).status, 200);
  const date = new Date().toISOString().slice(0, 10);
  const routine = await call(runtime, session, '/life/routines', { method: 'POST', body: { title: 'Read fixture notes', start_date: date, every_days: 1, timezone: 'UTC', create_next_task: true }, key: 'http-life-routine-0001' }); assert.equal(routine.status, 201);
  const complete = { expected_revision: routine.data.item.revision, date };
  assert.equal((await call(runtime, session, `/life/routines/${routine.data.item.id}/complete`, { method: 'POST', body: complete })).status, 200);
  assert.equal((await call(runtime, session, `/life/routines/${routine.data.item.id}/complete`, { method: 'POST', body: complete })).status, 200);
  const tasks = (await call(runtime, session, '/tasks')).data.items; assert.equal(tasks.length, 2); assert.equal(tasks.filter(task => task.status === 'completed').length, 1);
  for (const [source_id, amount_cents, currency] of [['a', 10, 'CAD'], ['b', 20, 'CAD'], ['refund', -5, 'CAD'], ['usd', 1000, 'USD']]) {
    assert.equal((await call(runtime, session, '/life/expenses', { method: 'POST', body: { source_id, date, merchant: 'Fixture', category: 'Food', amount_cents, currency, confirmed: true }, key: `http-life-expense-${source_id}` })).status, 201);
  }
  assert.deepEqual((await call(runtime, session, '/life/expenses/totals')).data.totals.sort((a, b) => a.currency.localeCompare(b.currency)), [{ currency: 'CAD', cents: 25 }, { currency: 'USD', cents: 1000 }]);
  await runtime.close(); const restarted = await start(); session = await pair(restarted);
  assert.equal((await call(restarted, session, '/life/meals')).data.items[0].data.state, 'accepted');
  assert.equal((await call(restarted, session, '/life/routines')).data.items[0].data.routine.observations.length, 1);
  assert.equal((await call(restarted, session, '/tasks')).data.items.length, 2);
  assert.equal((await call(restarted, session, '/life/expenses')).data.items.length, 4);
});
test('life HTTP rejects unpaired/forged/cross-origin/query/credential data and exposes no purchase/payment/booking writes', async t => {
  const { runtime } = await fixture(t); assert.equal((await call(runtime, null, '/life/pantry')).status, 401); const session = await pair(runtime);
  assert.equal((await call(runtime, { ...session, nonce: 'wrong' }, '/life/pantry')).status, 403);
  assert.equal((await call(runtime, session, '/life/pantry', { method: 'POST', body: pantry, origin: 'https://hostile.invalid', key: randomUUID() })).status, 403);
  assert.equal((await call(runtime, session, '/life/pantry?private=PRIVATE_QUERY_CANARY')).status, 400);
  assert.equal((await call(runtime, session, '/life/pantry', { method: 'POST', body: { ...pantry, token: 'PRIVATE_TOKEN_CANARY' }, key: randomUUID() })).status, 400);
  for (const path of ['/life/purchase', '/life/payment', '/life/booking']) assert.equal((await call(runtime, session, path, { method: 'POST', body: {} })).status, 404);
  assert.equal((await call(runtime, session, '/life/pantry')).data.items.length, 0);
});

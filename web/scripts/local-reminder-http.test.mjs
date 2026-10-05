import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'learnbridge-reminder-http-')), runtimes = [];
  t.after(async () => { for (const runtime of runtimes.reverse()) await runtime.close(); await rm(root, { force: true, recursive: true }); });
  async function start() { const runtime = await startRuntime({ dataRoot: root, port: 0 }); runtimes.push(runtime); return runtime; }
  return { root, start, runtime: await start() };
}
async function pair(runtime) {
  const response = await fetch(`${runtime.origin}/api/local/v1/pair`, { method: 'POST', headers: { Origin: runtime.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: runtime.createPairingCode() }) });
  assert.equal(response.status, 200); return { nonce: (await response.json()).nonce, cookie: response.headers.get('set-cookie').split(';')[0] };
}
async function call(runtime, session, path, { method = 'GET', body, origin = runtime.origin, headers = {} } = {}) {
  const response = await fetch(`${runtime.origin}/api/local/v1${path}`, { method, headers: { ...(session ? { Cookie: session.cookie, 'X-LearnBridge-Nonce': session.nonce } : {}), ...(method === 'GET' ? {} : { Origin: origin, 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, cache: response.headers.get('cache-control'), data: await response.json() };
}
async function setup(runtime, session) {
  const created = await call(runtime, session, '/tasks', { method: 'POST', body: { title: 'PRIVATE_REMINDER_HTTP_CANARY', deadline: { precision: 'instant', instant: new Date(Date.now() - 60000).toISOString() } } }); assert.equal(created.status, 201);
  const task = created.data.task, body = { title: 'HTTP selected reminders', task_ids: [task.id], timezone: 'America/Toronto', due_within_minutes: 1440 };
  const response = await call(runtime, session, '/reminders/schedules', { method: 'POST', body, headers: { 'Idempotency-Key': 'reminder-http-fixture-1' } }); assert.equal(response.status, 201, JSON.stringify(response.data));
  return { task, schedule: response.data.item, body };
}

test('REMHTTP01: real paired HTTP create/activate/check/ack round trip survives actual runtime restart and stays quiet', async t => {
  const f = await fixture(t); let runtime = f.runtime, session = await pair(runtime); const { task, schedule, body } = await setup(runtime, session);
  assert.equal(schedule.data.state, 'paused'); assert.equal((await call(runtime, session, '/reminders/check', { method: 'POST', body: { confirmed: true } })).data.notifications, 0);
  const retry = await call(runtime, session, '/reminders/schedules', { method: 'POST', body, headers: { 'Idempotency-Key': 'reminder-http-fixture-1' } }); assert.equal(retry.data.item.id, schedule.id);
  assert.equal((await call(runtime, session, `/reminders/schedules/${schedule.id}/state`, { method: 'POST', body: { expected_revision: schedule.revision, state: 'active', confirmed: true } })).status, 200);
  const checked = await call(runtime, session, '/reminders/check', { method: 'POST', body: { confirmed: true } }); assert.equal(checked.data.notifications, 1);
  const listed = await call(runtime, session, '/reminders/inbox'); assert.equal(listed.cache, 'private, no-store'); const event = listed.data.items[0]; assert.equal(event.task_id, task.id); assert.equal(event.stage, 'overdue');
  assert.equal((await call(runtime, session, `/reminders/schedules/${schedule.id}/ack`, { method: 'POST', body: { expected_revision: event.schedule_revision, event_id: event.id } })).status, 200);
  await runtime.close(); runtime = await f.start(); session = await pair(runtime); assert.equal((await call(runtime, session, '/reminders/check', { method: 'POST', body: { confirmed: true } })).data.notifications, 0);
  assert.equal((await call(runtime, session, '/reminders/inbox')).data.items.length, 1); assert((await call(runtime, session, '/reminders/inbox')).data.items[0].acknowledged_at);
  assert.equal((await call(runtime, session, '/tasks')).data.items.length, 1); assert.equal((await call(runtime, session, '/agent-grants')).data.items.length, 0);
});

test('REMHTTP02: origin/session/nonce/query/unknown-field guards prevent unapproved content access and mutations', async t => {
  const f = await fixture(t), runtime = f.runtime; const unpaired = await call(runtime, null, '/reminders/context'); assert.equal(unpaired.status, 401); assert.doesNotMatch(JSON.stringify(unpaired.data), /PRIVATE_REMINDER_HTTP_CANARY/);
  const session = await pair(runtime), { schedule } = await setup(runtime, session);
  assert.equal((await call(runtime, { ...session, nonce: 'forged' }, '/reminders/inbox')).status, 403);
  assert.equal((await call(runtime, session, '/reminders/check', { method: 'POST', body: { confirmed: true }, origin: 'https://hostile.invalid' })).status, 403);
  assert.equal((await call(runtime, session, '/reminders/inbox?token=PRIVATE_QUERY_CANARY')).status, 400);
  assert.equal((await call(runtime, session, `/reminders/schedules/${schedule.id}/state`, { method: 'POST', body: { expected_revision: 1, state: 'active', confirmed: true, provider: 'gmail' } })).status, 400);
  assert.equal((await call(runtime, session, `/reminders/schedules/${schedule.id}/state`, { method: 'POST', body: { expected_revision: 1, state: 'active', confirmed: false } })).status, 403);
  for (const path of ['/reminders/token', '/reminders/provider-refresh', '/reminders/send', '/reminders/native-notification']) assert.equal((await call(runtime, session, path, { method: 'POST', body: {} })).status, 404);
  assert.equal((await call(runtime, session, '/reminders/schedules')).data.items[0].revision, 1); assert.equal((await call(runtime, session, '/reminders/inbox')).data.items.length, 0);
  assert.equal((await call(runtime, session, '/logout', { method: 'POST', body: {} })).status, 200); assert.equal((await call(runtime, session, '/reminders/inbox')).status, 401);
});

test('REMHTTP03: actual 30-second runtime interval publishes without manual check and is explicitly cleared on shutdown', { timeout: 50000 }, async t => {
  const originalSetInterval = globalThis.setInterval, originalClearInterval = globalThis.clearInterval, observed = [], cleared = [];
  globalThis.setInterval = (...args) => { const timer = originalSetInterval(...args); if (args[1] === 30000) observed.push(timer); return timer; };
  globalThis.clearInterval = timer => { cleared.push(timer); return originalClearInterval(timer); };
  try {
    const f = await fixture(t), runtime = f.runtime, session = await pair(runtime); assert.equal(observed.length, 2, 'actual bounded reminder and focus runtime timers created');
    assert(observed.every(timer => !timer.hasRef()), 'owned timers do not keep a closed application alive'); const { schedule } = await setup(runtime, session);
    await call(runtime, session, `/reminders/schedules/${schedule.id}/state`, { method: 'POST', body: { expected_revision: schedule.revision, state: 'active', confirmed: true } });
    assert.equal((await call(runtime, session, '/reminders/inbox')).data.items.length, 0);
    const deadline = Date.now() + 36000; let inbox;
    do { await new Promise(resolve => setTimeout(resolve, 500)); inbox = await call(runtime, session, '/reminders/inbox'); } while (!inbox.data.items.length && Date.now() < deadline);
    assert.equal(inbox.data.items.length, 1, 'real running-laptop interval delivered to local inbox without manual /check');
    assert.equal(inbox.data.items[0].stage, 'overdue'); const status = await call(runtime, session, '/reminders/status'); assert.equal(status.data.last_check.notifications, 1);
    await runtime.close(); assert(observed.slice(0, 2).every(timer => cleared.includes(timer)), 'both owned intervals cleared before runtime closes');
    const restarted = await f.start(), restartedSession = await pair(restarted); assert.equal((await call(restarted, restartedSession, '/reminders/inbox')).data.items.length, 1);
    assert.equal((await call(restarted, restartedSession, '/reminders/check', { method: 'POST', body: { confirmed: true } })).data.notifications, 0);
    await restarted.close(); assert.equal(observed.length, 4); assert(observed.slice(2).every(timer => cleared.includes(timer)), 'restarted owned intervals cleared');
  } finally { globalThis.setInterval = originalSetInterval; globalThis.clearInterval = originalClearInterval; }
});

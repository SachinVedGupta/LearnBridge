import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { setTimeout as delay } from 'node:timers/promises';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';
async function fixture(t, capture = false) {
  const root = await mkdtemp(join(tmpdir(), 'learnbridge-focus-http-')), runtimes = [], timers = [], cleared = new Set(); const originalSet = globalThis.setInterval, originalClear = globalThis.clearInterval;
  if (capture) { globalThis.setInterval = (callback, ms, ...args) => { const timer = originalSet(callback, ms, ...args); if (ms === 30000) timers.push({ callback, timer, focus: callback.toString().includes('focus.observe') }); return timer; }; globalThis.clearInterval = timer => { cleared.add(timer); return originalClear(timer); }; }
  t.after(async () => { for (const runtime of runtimes.reverse()) await runtime.close(); globalThis.setInterval = originalSet; globalThis.clearInterval = originalClear; await rm(root, { recursive: true, force: true }); });
  async function start() { const runtime = await startRuntime({ dataRoot: root, port: 0 }); runtimes.push(runtime); return runtime; } return { root, timers, cleared, start, runtime: await start() };
}
async function pair(runtime) { const response = await fetch(`${runtime.origin}/api/local/v1/pair`, { method: 'POST', headers: { Origin: runtime.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: runtime.createPairingCode() }) }); assert.equal(response.status, 200); return { cookie: response.headers.get('set-cookie').split(';')[0], nonce: (await response.json()).nonce }; }
async function call(runtime, session, path, { method = 'GET', body, origin = runtime.origin, headers = {} } = {}) { const response = await fetch(`${runtime.origin}/api/local/v1${path}`, { method, headers: { ...(session ? { Cookie: session.cookie, 'X-LearnBridge-Nonce': session.nonce } : {}), ...(method === 'GET' ? {} : { Origin: origin, 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, cache: response.headers.get('cache-control'), data: await response.json() }; }
const intention = { title: 'Synthetic focus session', planned_minutes: 25, timezone: 'America/Toronto', confirmed: true };
async function start(runtime, session, patch = {}) { const result = await call(runtime, session, '/focus/sessions', { method: 'POST', body: { ...intention, ...patch }, headers: { 'Idempotency-Key': 'focus-http-start-key' } }); assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data.item; }
const review = row => ({ expected_revision: row.revision, session_hash: row.session_hash, confirmed: true });
const counts = root => { const db = new Database(join(root, 'learnbridge.sqlite'), { readonly: true }); try { return db.prepare('SELECT count(*) n FROM workspace_revisions').get().n; } finally { db.close(); } };

test('FSHTTP01: actual2-second observed timer→reviewed pause→end→restart saves duration once and preserves associated task', async t => {
  const f = await fixture(t); let runtime = f.runtime, session = await pair(runtime); const task = (await call(runtime, session, '/tasks', { method: 'POST', body: { title: 'Student task must not complete' } })).data.task;
  const row = await start(runtime, session, { task_id: task.id }); assert.equal(row.data.observed_active_ms, 0); assert.equal((await call(runtime, session, '/life/routines')).data.items.length, 0);
  await delay(2100); const paused = await call(runtime, session, `/focus/sessions/${row.id}/pause`, { method: 'POST', body: review(row) }); assert.equal(paused.status, 200); assert.equal(paused.data.item.data.state, 'paused'); assert(paused.data.item.data.observed_active_ms >= 1900 && paused.data.item.data.observed_active_ms < 10000); assert.equal(paused.data.item.data.planned_minutes, 25);
  const ended = await call(runtime, session, `/focus/sessions/${row.id}/end`, { method: 'POST', body: review(paused.data.item) }); assert.equal(ended.status, 200); assert.equal(ended.data.item.data.state, 'completed'); assert.equal(ended.data.item.data.observed_active_ms, paused.data.item.data.observed_active_ms);
  assert.equal((await call(runtime, session, `/focus/sessions/${row.id}/end`, { method: 'POST', body: review(paused.data.item) })).data.item.revision, ended.data.item.revision); assert.deepEqual((await call(runtime, session, `/tasks/${task.id}`)).data.task, task); assert.equal((await call(runtime, session, '/focus/context')).data.open_session, null);
  await runtime.close(); runtime = await f.start(); session = await pair(runtime); assert.equal((await call(runtime, session, `/focus/sessions/${row.id}`)).data.item.data.observed_active_ms, ended.data.item.data.observed_active_ms); assert.equal((await call(runtime, session, '/life/routines')).data.items.length, 0);
});

test('FSHTTP02: actual30-second unref heartbeat saves one running observation; shutdown clears timers and no callback writes afterclose', async t => {
  const f = await fixture(t, true), runtime = f.runtime, session = await pair(runtime), row = await start(runtime, session, { planned_minutes: 1 }); const heartbeat = f.timers.find(item => item.focus); assert(heartbeat); assert.equal(heartbeat.timer.hasRef(), false);
  await delay(31000); const current = await call(runtime, session, `/focus/sessions/${row.id}`); assert.equal(current.status, 200); assert.equal(current.data.item.data.state, 'running'); assert(current.data.item.data.observed_active_ms >= 28000 && current.data.item.data.observed_active_ms < 45000); assert.equal(current.data.item.data.interval_count, 1); assert.equal(current.data.item.data.planned_minutes, 1); assert.equal((await call(runtime, session, '/tasks')).data.items.length, 0);
  await runtime.close(); assert(f.cleared.has(heartbeat.timer)); const before = counts(f.root); heartbeat.callback(); await delay(20); assert.equal(counts(f.root), before);
  const restored = await f.start(), restoredSession = await pair(restored), saved = (await call(restored, restoredSession, `/focus/sessions/${row.id}`)).data.item; assert.equal(saved.data.state, 'interrupted'); assert.equal(saved.needs_recovery, true); assert(saved.data.observed_active_ms >= current.data.item.data.observed_active_ms); assert.equal(saved.data.last_gap.reason, 'runtime_stopped');
});

test('FSHTTP03: actual exact revisions/hash/session/origin/query/consent guards refuse unintended timer effects', async t => {
  const f = await fixture(t), runtime = f.runtime; assert.equal((await call(runtime, null, '/focus/context')).status, 401); const session = await pair(runtime), row = await start(runtime, session);
  assert.equal((await call(runtime, { ...session, nonce: 'forged' }, '/focus/sessions')).status, 403); assert.equal((await call(runtime, session, '/focus/sessions?token=PRIVATE_FOCUS_QUERY')).status, 400);
  assert.equal((await call(runtime, session, `/focus/sessions/${row.id}/end`, { method: 'POST', body: review(row), origin: 'https://hostile.invalid' })).status, 403);
  assert.equal((await call(runtime, session, `/focus/sessions/${row.id}/end`, { method: 'POST', body: { ...review(row), session_hash: 'a'.repeat(64) } })).status, 409);
  assert.equal((await call(runtime, session, `/focus/sessions/${row.id}/end`, { method: 'POST', body: { ...review(row), confirmed: false } })).status, 403);
  assert.equal((await call(runtime, session, `/focus/sessions/${row.id}/end`, { method: 'POST', body: { ...review(row), complete_task: true } })).status, 400);
  assert.equal((await call(runtime, session, `/focus/sessions/${row.id}/complete-task`, { method: 'POST', body: {} })).status, 404); assert.equal((await call(runtime, session, `/focus/sessions/${row.id}`)).cache, 'private, no-store');
  assert.equal((await call(runtime, session, '/logout', { method: 'POST', body: {} })).status, 200); assert.equal((await call(runtime, session, '/focus/sessions')).status, 401);
});

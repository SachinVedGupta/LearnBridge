import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
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

test('REMHTTP03: actual reminder, focus and dynamic 30-second callbacks persist their own effects and all stop on shutdown', { timeout: 50000 }, async t => {
  const originalSetInterval = globalThis.setInterval, originalClearInterval = globalThis.clearInterval, observed = [], cleared = [];
  globalThis.setInterval = (callback, ms, ...args) => {
    if (ms !== 30000) return originalSetInterval(callback, ms, ...args);
    const item = { callback, ticks: 0, timer: null };
    item.timer = originalSetInterval(() => { item.ticks++; callback(...args); }, ms);
    observed.push(item); return item.timer;
  };
  globalThis.clearInterval = timer => { cleared.push(timer); return originalClearInterval(timer); };
  const storedState = root => {
    const db = new Database(join(root, 'learnbridge.sqlite'), { readonly: true });
    try { return { records: db.prepare('SELECT json FROM records ORDER BY id').all(), workspace: db.prepare('SELECT json FROM workspace_records ORDER BY id').all(), revisions: db.prepare('SELECT count(*) n FROM workspace_revisions').get().n }; }
    finally { db.close(); }
  };
  try {
    const f = await fixture(t), runtime = f.runtime, session = await pair(runtime); assert.equal(observed.length, 3, 'actual bounded reminder, dynamic and focus runtime timers created');
    assert(observed.every(item => !item.timer.hasRef()), 'owned timers do not keep a closed application alive'); const { schedule } = await setup(runtime, session);
    await call(runtime, session, `/reminders/schedules/${schedule.id}/state`, { method: 'POST', body: { expected_revision: schedule.revision, state: 'active', confirmed: true } });
    assert.equal((await call(runtime, session, '/reminders/inbox')).data.items.length, 0);
    const focus = await call(runtime, session, '/focus/sessions', { method: 'POST', body: { title: 'Synthetic interval focus', planned_minutes: 1, timezone: 'America/Toronto', confirmed: true }, headers: { 'Idempotency-Key': 'reminder-http-focus-interval' } });
    assert.equal(focus.status, 201); assert.equal(focus.data.item.data.interval_count, 0);
    const imported = await call(runtime, session, '/productivity/updates', { method: 'POST', body: { provider: 'gmail', account: 'selected-interval@example.test', source_id: 'interval-update', subject: 'Selected interval action', body: 'TODO: Review interval timetable', section: 'communications', observed_at: new Date(Date.now() - 60000).toISOString() }, headers: { 'Idempotency-Key': 'reminder-http-update-interval' } });
    assert.equal(imported.status, 201);
    const selected = await call(runtime, session, '/dynamic-tasks/config', { method: 'POST', body: { expected_revision: 0, selections: [{ kind: 'update', id: imported.data.item.id, course_ids: [] }], enabled: true, auto_create: true, auto_complete: false, confirmed: true } });
    assert.equal(selected.status, 200); assert.equal((await call(runtime, session, '/dynamic-tasks/list')).data.observations.length, 0);
    const deadline = Date.now() + 36000; let inbox, sampled, dynamic;
    do {
      await new Promise(resolve => setTimeout(resolve, 500));
      [inbox, sampled, dynamic] = await Promise.all([
        call(runtime, session, '/reminders/inbox'), call(runtime, session, `/focus/sessions/${focus.data.item.id}`), call(runtime, session, '/dynamic-tasks/list'),
      ]);
    } while ((!inbox.data.items.length || !sampled.data.item.data.interval_count || !dynamic.data.observations.length || observed.some(item => item.ticks === 0)) && Date.now() < deadline);
    assert.equal(inbox.data.items.length, 1, 'real running-laptop interval delivered to local inbox without manual /check');
    assert.equal(inbox.data.items[0].stage, 'overdue'); const status = await call(runtime, session, '/reminders/status'); assert.equal(status.data.last_check.notifications, 1);
    assert.equal(sampled.data.item.data.interval_count, 1, 'actual focus callback saved exactly one observed interval');
    assert.equal(sampled.data.item.data.state, 'running'); assert(sampled.data.item.data.observed_active_ms >= 25000 && sampled.data.item.data.observed_active_ms < 45000);
    assert.equal(dynamic.data.observations.length, 1, 'actual selected-source callback reconciled without manual /refresh');
    assert.equal(dynamic.data.observations[0].data.state, 'active'); assert.equal(dynamic.data.observations[0].data.acceptance.kind, 'selected_source_auto_create_policy');
    assert.equal(dynamic.data.tasks.find(row => row.task.title === 'Review interval timetable').task.status, 'pending');
    assert(observed.every(item => item.ticks === 1), 'each actual registered callback fired exactly once');
    assert.equal((await call(runtime, session, '/agent-grants')).data.items.length, 0, 'deterministic source refresh never invokes the model');
    await runtime.close(); assert(observed.slice(0, 3).every(item => cleared.includes(item.timer)), 'all three owned intervals cleared before runtime closes');
    const closedState = storedState(f.root); for (const item of observed.slice(0, 3)) item.callback();
    assert.deepEqual(storedState(f.root), closedState, 'late captured reminder, focus and dynamic callbacks cannot write after close');
    const restarted = await f.start(), restartedSession = await pair(restarted); assert.equal((await call(restarted, restartedSession, '/reminders/inbox')).data.items.length, 1);
    assert.equal((await call(restarted, restartedSession, '/reminders/check', { method: 'POST', body: { confirmed: true } })).data.notifications, 0);
    assert.equal((await call(restarted, restartedSession, '/dynamic-tasks/list')).data.observations.length, 1);
    assert.equal((await call(restarted, restartedSession, `/focus/sessions/${focus.data.item.id}`)).data.item.data.state, 'interrupted');
    await restarted.close(); assert.equal(observed.length, 6); assert(observed.slice(3).every(item => cleared.includes(item.timer)), 'all restarted owned intervals cleared');
    const restartedState = storedState(f.root); for (const item of observed.slice(3)) item.callback();
    assert.deepEqual(storedState(f.root), restartedState, 'all restarted callbacks also remain quiet after close');
  } finally { globalThis.setInterval = originalSetInterval; globalThis.clearInterval = originalClearInterval; }
});

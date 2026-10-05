import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { LearnBridgeError } from '../packages/core/src/index.mjs';
import { createReminderService } from '../apps/local-runtime/src/reminder-service.mjs';
import { handleRemindersRoute } from '../apps/local-runtime/src/reminder-routes.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'learnbridge-reminder-routes-')), store = LocalStore.open({ root, timezone: 'UTC' });
  const service = createReminderService({ store, clock: () => '2026-10-04T16:00:00.000Z' });
  t.after(() => { service.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const task = store.createTask({ title: 'Selected route task', deadline: { precision: 'date', date: '2026-10-04', timezone: 'UTC' } });
  const session = { nonce: 'synthetic-paired-local-session' }, input = { title: 'Route reminder', task_ids: [task.id], timezone: 'UTC', due_within_minutes: 1440 };
  return { root, store, service, task, session, input };
}
function request(f, route, method = 'GET', input = {}, extras = {}) {
  return handleRemindersRoute({ route, method, session: f.session, service: f.service, idempotencyKey: 'reminder-route-fixture',
    privateBody: async (allowed, required, bytes) => { assert(bytes > 0 && bytes <= 12000); assert(Object.keys(input).every(key => allowed.includes(key))); assert(required.every(key => Object.hasOwn(input, key))); return input; }, ...extras });
}

test('REMR01: unpaired requests fail before local content read/body read; other route namespaces remain unhandled', async t => {
  const f = fixture(t); let read = 0; const args = { route: '/reminders/schedules', method: 'POST', service: f.service, privateBody: async () => { read++; return f.input; } };
  await assert.rejects(handleRemindersRoute(args), { code: 'AUTH_REQUIRED' });
  await assert.rejects(handleRemindersRoute({ ...args, session: { nonce: '' } }), { code: 'AUTH_REQUIRED' }); assert.equal(read, 0); assert.equal(f.service.listSchedules().length, 0);
  assert.equal(await handleRemindersRoute({ ...args, route: '/not-reminders' }), null);
});

test('REMR02: real SQLite paused create/list/context/status stays authenticated and has no external capabilities', async t => {
  const f = fixture(t), saved = await request(f, '/reminders/schedules', 'POST', f.input);
  assert.equal(saved.status, 201); assert.equal(saved.data.item.data.state, 'paused'); assert.equal((await request(f, '/reminders/schedules')).data.items.length, 1);
  const context = await request(f, '/reminders/context'); assert.equal(context.data.tasks[0].id, f.task.id);
  const status = await request(f, '/reminders/status'); assert.equal(status.data.provider_reads, false); assert.equal(status.data.os_notifications, false); assert.equal(status.data.requires_runtime_running, true);
  assert.equal((await request(f, '/reminders/inbox')).data.items.length, 0);
});

test('REMR03: paired explicit activation/manual check/ack round trip persists exact local events and does not create tasks', async t => {
  const f = fixture(t), created = (await request(f, '/reminders/schedules', 'POST', f.input)).data.item;
  await request(f, `/reminders/schedules/${created.id}/state`, 'POST', { expected_revision: 1, state: 'active', confirmed: true });
  const checked = await request(f, '/reminders/check', 'POST', { confirmed: true }); assert.equal(checked.data.notifications, 1);
  const event = (await request(f, '/reminders/inbox')).data.items[0]; assert.equal(event.stage, 'due_today');
  await request(f, `/reminders/schedules/${created.id}/ack`, 'POST', { expected_revision: event.schedule_revision, event_id: event.id });
  assert.equal((await request(f, '/reminders/inbox')).data.items[0].acknowledged_at, '2026-10-04T16:00:00.000Z');
  assert.equal((await request(f, '/reminders/check', 'POST', { confirmed: true })).data.notifications, 0); assert.equal(f.store.listTasks().length, 1);
});

test('REMR04: authority revoked while request body waits prevents state change and reminder publication', async t => {
  const f = fixture(t); let authorized = true, checks = 0;
  await assert.rejects(request(f, '/reminders/schedules', 'POST', f.input, {
    stillAuthorized: () => { checks++; if (!authorized) throw new LearnBridgeError('AUTH_REQUIRED'); },
    privateBody: async () => { authorized = false; return f.input; },
  }), { code: 'AUTH_REQUIRED' }); assert.equal(checks, 2); assert.equal(f.service.listSchedules().length, 0);
});

test('REMR05: unknown/provider/token/query/invalid-ID operations reject before private-body acquisition', async t => {
  const f = fixture(t); let reads = 0;
  for (const route of ['/reminders/token', '/reminders/provider-refresh', '/reminders/send', '/reminders/native-notification', '/reminders/schedules?account=other', '/reminders/schedules/bad-id/state', '/reminders/check/extra']) {
    await assert.rejects(request(f, route, 'POST', {}, { privateBody: async () => { reads++; return {}; } }), error => error.status === 404);
  }
  assert.equal(reads, 0); assert.equal(f.store.listWorkspaceRecords({ kind: 'routine' }).length, 0);
});

test('REMR06: read routes/mutation routes enforce exact methods before body reads', async t => {
  const f = fixture(t); let reads = 0;
  for (const [route, method] of [['/reminders/status', 'POST'], ['/reminders/context', 'DELETE'], ['/reminders/inbox', 'POST'], ['/reminders/check', 'GET'], ['/reminders/schedules', 'PUT']]) {
    await assert.rejects(request(f, route, method, {}, { privateBody: async () => { reads++; return {}; } }), error => error.status === 405);
  }
  assert.equal(reads, 0);
});

test('REMR07: refused action confirmation and stale acknowledgement never publish', async t => {
  const f = fixture(t), created = (await request(f, '/reminders/schedules', 'POST', f.input)).data.item;
  await assert.rejects(request(f, `/reminders/schedules/${created.id}/state`, 'POST', { expected_revision: 1, state: 'active', confirmed: false }), { code: 'CONSENT_REQUIRED' });
  await assert.rejects(request(f, '/reminders/check', 'POST', { confirmed: false }), { code: 'CONSENT_REQUIRED' });
  assert.equal(f.service.listSchedules()[0].revision, 1); assert.equal(f.service.listInbox().length, 0);
});

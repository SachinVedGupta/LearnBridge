import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { LearnBridgeError } from '../packages/core/src/index.mjs';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { createStudentWorkspace } from '../apps/local-runtime/src/student-workspace.mjs';
import { createProductivityWorkspace } from '../apps/local-runtime/src/productivity-service.mjs';
import { createDynamicTaskService } from '../apps/local-runtime/src/dynamic-task-service.mjs';
import { handleDynamicTaskRoute } from '../apps/local-runtime/src/dynamic-task-routes.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'learnbridge-dynamic-route-')), store = LocalStore.open({ root, timezone: 'UTC' }); t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const source = createProductivityWorkspace(store).importUpdate({ provider: 'gmail', account: 'selected-fixture', source_id: 'one', subject: 'Selected actions', body: 'TODO: Review timetable', section: 'communications', observed_at: '2026-10-05T10:00:00.000Z' }, { idempotencyKey: randomUUID() });
  return { store, source, service: createDynamicTaskService({ store, studentWorkspace: createStudentWorkspace(store), clock: () => '2026-10-05T16:00:00.000Z' }), session: { nonce: 'dynamic-route-fixture' } };
}
const request = (f, route, method = 'GET', input = {}, extra = {}) => handleDynamicTaskRoute({ route, method, service: f.service, session: f.session,
  privateBody: async (allowed, required, limit) => { assert.equal(limit, 16000); assert.deepEqual(Object.keys(input).sort(), [...required].sort()); assert.deepEqual(allowed, required); return input; }, ...extra });

test('DTR01: paired authority is checked before private metadata or body, and unrelated paths remain unhandled', async t => {
  const f = fixture(t); let reads = 0;
  await assert.rejects(request(f, '/dynamic-tasks/config', 'POST', {}, { session: null, privateBody: () => { reads++; } }), { code: 'AUTH_REQUIRED' }); assert.equal(reads, 0);
  assert.equal(await request(f, '/other'), null); assert.equal(f.service.config().revision, 0);
});
test('DTR02: real route policy -> saved-source refresh -> exact pending acceptance persists one local task', async t => {
  const f = fixture(t), context = await request(f, '/dynamic-tasks/context'); assert.equal(context.data.sources.length, 1);
  await request(f, '/dynamic-tasks/config', 'POST', { expected_revision: 0, selections: [{ kind: 'update', id: f.source.id, course_ids: [] }], auto_create: false, auto_complete: false, enabled: true, confirmed: true });
  const refresh = await request(f, '/dynamic-tasks/refresh', 'POST'); assert.equal(refresh.data.created_observations, 1); assert.equal(f.store.listTasks().length, 0);
  const list = await request(f, '/dynamic-tasks/list'), row = list.data.observations[0]; await request(f, `/dynamic-tasks/items/${row.id}/accept`, 'POST', { expected_revision: row.revision, review_hash: row.review_hash, confirmed: true, existing_task_id: null });
  assert.equal(f.store.listTasks().length, 1); assert.equal((await request(f, `/dynamic-tasks/items/${row.id}`)).data.item.data.state, 'active'); assert.equal(f.store.listAgentGrants().length, 0);
});
test('DTR03: session revocation while body waits blocks configuration before any durable write', async t => {
  const f = fixture(t); let authorized = true;
  await assert.rejects(request(f, '/dynamic-tasks/config', 'POST', {}, { privateBody: async () => { authorized = false; return {}; }, stillAuthorized: () => { if (!authorized) throw new LearnBridgeError('AUTH_REQUIRED'); } }), { code: 'AUTH_REQUIRED' });
  assert.equal(f.service.config().revision, 0);
});
test('DTR04: provider write, arbitrary task/action/id/query and wrong-method paths fail before body access', async t => {
  const f = fixture(t); let reads = 0;
  for (const route of ['/dynamic-tasks/send', '/dynamic-tasks/provider-refresh', '/dynamic-tasks/list?account=other', '/dynamic-tasks/items/bad/accept', `/dynamic-tasks/items/${randomUUID()}/complete`]) await assert.rejects(request(f, route, 'POST', {}, { privateBody: () => { reads++; } }), error => error.status === 404);
  for (const [route, method] of [['/dynamic-tasks/list', 'POST'], ['/dynamic-tasks/refresh', 'GET'], ['/dynamic-tasks/context', 'POST']]) await assert.rejects(request(f, route, method), error => error.status === 405);
  assert.equal(reads, 0); assert.equal(f.store.listTasks().length, 0);
});
test('DTR05: refused exact task confirmation leaves the pending observation and independently inspected task table untouched', async t => {
  const f = fixture(t); f.service.configure({ expected_revision: 0, selections: [{ kind: 'update', id: f.source.id, course_ids: [] }], auto_create: false, auto_complete: false, enabled: true, confirmed: true }); f.service.refresh();
  const row = f.service.list().observations[0]; await assert.rejects(request(f, `/dynamic-tasks/items/${row.id}/accept`, 'POST', { expected_revision: row.revision, review_hash: row.review_hash, confirmed: false, existing_task_id: null }), { code: 'CONSENT_REQUIRED' });
  assert.equal(f.service.getItem(row.id).data.state, 'awaiting_review'); assert.equal(f.store.listTasks().length, 0);
});

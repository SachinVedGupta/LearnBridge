import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { LearnBridgeError } from '../packages/core/src/index.mjs';
import { createStudentWorkspace } from '../apps/local-runtime/src/student-workspace.mjs';
import { createAcademicTaskService } from '../apps/local-runtime/src/academic-task-service.mjs';
import { handleAcademicTaskRoute } from '../apps/local-runtime/src/academic-task-routes.mjs';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'learnbridge-academic-task-routes-')), store = LocalStore.open({ root, timezone: 'UTC' }), studentWorkspace = createStudentWorkspace(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const raw = { schema_version: 1, institution: { name: 'Synthetic University', origin: 'https://synthetic.example.edu', timezone: 'UTC' }, account_ref: 'fixture-student', retrieved_at: '2026-10-04T10:00:00.000Z',
    courses: [{ source_id: 'A', title: 'Selected synthetic course', code: 'SYN101' }], assignments: [{ source_id: 'a', course_id: 'A', title: 'Synthetic exercise', description: 'PRIVATE_ROUTE_SOURCE_CANARY', due: '2026-10-10' }], announcements: [], materials: [] };
  const p = studentWorkspace.previewAcademicExport({ export: raw, selected_course_ids: ['A'] }), saved = studentWorkspace.commitAcademicRefresh(p, { review_hash: p.review_hash, expected_head_revision: p.base.revision, idempotency_key: randomUUID() });
  const service = createAcademicTaskService({ store, studentWorkspace, clock: () => '2026-10-04T16:00:00.000Z' }), scope = { snapshot_ids: [saved.snapshot.id], course_ids: ['A'] }, item = service.inspect(scope).items[0];
  return { root, store, service, session: { nonce: 'synthetic-paired-academic-session' }, scope, input: { ...scope, assignment_ids: [item.source.item_id] } };
}
const request = (f, route, method = 'GET', input = {}, extras = {}) => handleAcademicTaskRoute({ route, method, service: f.service, session: f.session, idempotencyKey: 'academic-route-preview-fixture',
  privateBody: async (allowed, required, bound) => { assert.equal(bound, 12000); assert(Object.keys(input).every(key => allowed.includes(key))); assert(required.every(key => Object.hasOwn(input, key))); return input; }, ...extras });

test('ATR01: paired authority is required before metadata or request-body access, with unrelated namespaces unhandled', async t => {
  const f = fixture(t); let reads = 0; const args = { service: f.service, route: '/academic-tasks/previews', method: 'POST', privateBody: async () => { reads++; return f.input; } };
  await assert.rejects(handleAcademicTaskRoute(args), { code: 'AUTH_REQUIRED' }); assert.equal(reads, 0); assert.equal(await handleAcademicTaskRoute({ ...args, route: '/other' }), null); assert.equal(f.service.listPreviews().length, 0);
});

test('ATR02: inspect/preview/exact pending save/separate acceptance execute a real SQLite task flow with no grant', async t => {
  const f = fixture(t), inspected = await request(f, '/academic-tasks/inspect', 'POST', f.scope); assert.equal(inspected.data.items.length, 1); assert.doesNotMatch(JSON.stringify(inspected), /PRIVATE_ROUTE_SOURCE_CANARY/);
  const preview = (await request(f, '/academic-tasks/previews', 'POST', f.input)).data.item; assert.equal(f.store.listTasks().length, 0);
  const pending = await request(f, `/academic-tasks/previews/${preview.id}/save`, 'POST', { expected_revision: 1, review_hash: preview.data.review_hash }); assert.equal(pending.data.proposals.length, 1); assert.equal(f.store.listTasks().length, 0);
  const proposal = pending.data.proposals[0], accepted = await request(f, `/academic-tasks/proposals/${proposal.id}/accept`, 'POST', { expected_revision: proposal.revision, payload_hash: proposal.data.payload_hash, confirmed: true }); assert.equal(accepted.data.item.data.state, 'accepted'); assert.equal(f.store.listTasks().length, 1); assert.equal(f.store.listAgentGrants().length, 0);
  assert.equal((await request(f, `/academic-tasks/previews/${preview.id}`)).data.item.data.state, 'saved'); assert.equal((await request(f, `/academic-tasks/proposals/${proposal.id}`)).data.item.data.task_id, f.store.listTasks()[0].id);
});

test('ATR03: revocation during awaited body prevents durable preview publication', async t => {
  const f = fixture(t); let authorized = true, checks = 0;
  await assert.rejects(request(f, '/academic-tasks/previews', 'POST', f.input, { stillAuthorized: () => { checks++; if (!authorized) throw new LearnBridgeError('AUTH_REQUIRED'); }, privateBody: async () => { authorized = false; return f.input; } }), { code: 'AUTH_REQUIRED' });
  assert.equal(checks, 2); assert.equal(f.service.listPreviews().length, 0); assert.equal(f.store.listTasks().length, 0);
});

test('ATR04: unsupported provider/send/query/ID/cross-action routes reject before reading private bodies', async t => {
  const f = fixture(t); let reads = 0;
  for (const path of ['/academic-tasks/provider-refresh', '/academic-tasks/send', '/academic-tasks/task-autofill', '/academic-tasks/previews?account=other', '/academic-tasks/previews/bad-id/save', `/academic-tasks/previews/${randomUUID()}/accept`, `/academic-tasks/proposals/${randomUUID()}/save`]) {
    await assert.rejects(request(f, path, 'POST', {}, { privateBody: async () => { reads++; return {}; } }), error => error.status === 404);
  }
  assert.equal(reads, 0); assert.equal(f.store.listTasks().length, 0);
});

test('ATR05: exact methods and refused acceptance preserve the pending record', async t => {
  const f = fixture(t);
  for (const [path, method] of [['/academic-tasks/context', 'POST'], ['/academic-tasks/inspect', 'GET'], ['/academic-tasks/proposals', 'POST'], ['/academic-tasks/previews', 'PUT']]) await assert.rejects(request(f, path, method), error => error.status === 405);
  const preview = f.service.preview(f.input, { idempotencyKey: 'refused-consent-preview' }), proposal = f.service.savePending(preview.id, { expected_revision: 1, review_hash: preview.data.review_hash }).proposals[0];
  await assert.rejects(request(f, `/academic-tasks/proposals/${proposal.id}/accept`, 'POST', { expected_revision: 1, payload_hash: proposal.data.payload_hash, confirmed: false }), { code: 'CONSENT_REQUIRED' }); assert.equal(f.service.getProposal(proposal.id).revision, 1); assert.equal(f.store.listTasks().length, 0);
});

test('ATR06: get lists and exact reject are metadata/source-pinned local views, never task acceptance', async t => {
  const f = fixture(t), preview = f.service.preview(f.input, { idempotencyKey: 'route-reject-preview' }), proposal = f.service.savePending(preview.id, { expected_revision: 1, review_hash: preview.data.review_hash }).proposals[0];
  const rejected = await request(f, `/academic-tasks/proposals/${proposal.id}/reject`, 'POST', { expected_revision: 1, payload_hash: proposal.data.payload_hash, confirmed: true }); assert.equal(rejected.data.item.data.state, 'rejected');
  for (const path of ['/academic-tasks/context', '/academic-tasks/previews', '/academic-tasks/proposals']) assert.doesNotMatch(JSON.stringify(await request(f, path)), /PRIVATE_ROUTE_SOURCE_CANARY/);
  assert.equal(f.store.listTasks().length, 0);
});

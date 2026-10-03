import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { normalizeAcademicExport } from '../packages/local-academic/src/index.mjs';
import { buildAcademicLibrary, searchAcademicLibrary } from '../packages/local-academic/src/library.mjs';
import { createLearningService } from '../apps/local-runtime/src/learning-service.mjs';
import { handleLearningRoute } from '../apps/local-runtime/src/learning-routes.mjs';

function academic(body = 'PRIVATE_SOURCE_CANARY: recursion needs a base case.', retrievedAt = new Date(Date.now() - 30000).toISOString()) {
  return normalizeAcademicExport({ schema_version: 1, institution: { name: 'Fixture School', origin: 'https://learn.fixture.test', timezone: 'America/Toronto' }, account_ref: 'fixture_student', retrieved_at: retrievedAt, courses: [{ source_id: 'A', title: 'Algorithms' }, { source_id: 'B', title: 'Other course' }], assignments: [], announcements: [], materials: [{ source_id: 'lesson', course_id: 'A', title: 'Recursion lesson', body }, { source_id: 'other', course_id: 'B', title: 'PRIVATE_OTHER_COURSE', body: 'Other private context.' }] }, { selectedCourseIds: ['A', 'B'] });
}
function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-learning-')); const root = join(parent, 'workspace'); let store = LocalStore.open({ root, timezone: 'America/Toronto' });
  t.after(() => { store.close(); rmSync(parent, { recursive: true, force: true }); });
  const snapshot = store.createWorkspaceRecord({ kind: 'academic_item', title: 'Course snapshot', data: { format: 'academic_snapshot', snapshot: academic() } });
  const getLibrary = scope => buildAcademicLibrary({ snapshots: scope.snapshot_ids.map(recordId => { const record = store.getWorkspaceRecord(recordId); if (!record) { const error = new Error('Unavailable'); error.code = 'SCOPE_DENIED'; throw error; } return record.data.snapshot; }), selectedCourseIds: scope.course_ids });
  const scope = { snapshot_ids: [snapshot.id], course_ids: ['A'] }; const found = searchAcademicLibrary(getLibrary(scope), { query: 'base case', courseIds: ['A'] }).results[0];
  const input = { scope, citations: [{ source_id: found.source_id, version_hash: found.version_hash, chunk_id: found.chunk_id }], topic: 'Base cases', mode: 'hint', academic_policy: { grading: 'ungraded', ai_rule: 'allowed' } };
  return { parent, root, snapshot, scope, input, get store() { return store; }, get service() { return createLearningService({ store, getLibrary }); }, getLibrary, restart() { store.close(); store = LocalStore.open({ root, timezone: 'America/Toronto' }); } };
}
const exact = record => ({ expected_revision: record.revision, session_hash: record.data.recipe.session_hash });
const code = (fn, value) => assert.throws(fn, error => error.code === value);

test('source-selected session persists and retries remain one record across restart; lists never return cached excerpts', t => {
  const f = fixture(t); const first = f.service.createSession(f.input, { idempotencyKey: 'learning-session-fixture-1' }); const repeated = f.service.createSession(f.input, { idempotencyKey: 'learning-session-fixture-1' }); assert.equal(repeated.id, first.id); assert.equal(f.store.listWorkspaceRecords({ kind: 'tutoring_session' }).length, 1);
  const list = f.service.listSessions(); assert.equal(list[0].state, 'ready'); assert.equal(JSON.stringify(list).includes('PRIVATE_SOURCE_CANARY'), false); assert.equal(JSON.stringify(list).includes('PRIVATE_OTHER_COURSE'), false);
  f.restart(); const saved = f.service.getSession(first.id); assert.equal(saved.data.recipe.session_hash, first.data.recipe.session_hash); assert.match(saved.data.recipe.selected_evidence[0].text, /PRIVATE_SOURCE_CANARY/); assert.equal(f.service.createSession(f.input, { idempotencyKey: 'learning-session-fixture-1' }).id, first.id);
  code(() => f.service.createSession({ ...f.input, topic: 'Changed retry' }, { idempotencyKey: 'learning-session-fixture-1' }), 'REVISION_CONFLICT');
});

test('explicit actual attempt and reviewed assessment persist once; topic reset is exact, atomic and isolated', t => {
  const f = fixture(t); const session = f.service.createSession(f.input); const body = { ...exact(session), question: 'What terminates recursion?', student_response: 'The base case returns without recursion.', assessment: 'correct', feedback: 'Termination was identified on this check.', reviewed_by_student: true };
  const checkpoint = f.service.saveAttempt(session.id, body, { idempotencyKey: 'learning-attempt-fixture-1' }); assert.equal(checkpoint.data.checkpoint.exact_student_response, body.student_response); assert.equal(checkpoint.data.checkpoint.assessment.mastery_claim, false); assert.equal(f.service.saveAttempt(session.id, body, { idempotencyKey: 'learning-attempt-fixture-1' }).id, checkpoint.id);
  const other = f.service.createSession({ ...f.input, topic: 'Other topic' }); f.service.saveAttempt(other.id, { ...exact(other), question: 'Another question?', student_response: 'An actual different attempt.' });
  f.restart(); assert.equal(f.service.listCheckpoints().length, 2); const reset = { expected_revisions: [{ id: checkpoint.id, revision: checkpoint.revision }] };
  code(() => f.service.resetTopic('Base cases', { expected_revisions: [{ id: checkpoint.id, revision: 999 }] }), 'REVISION_CONFLICT'); assert.equal(f.service.listCheckpoints().length, 2);
  assert.equal(f.service.resetTopic('Base cases', reset).deleted_count, 1); assert.equal(f.service.resetTopic('Base cases', reset).deleted_count, 1); assert.equal(f.service.listCheckpoints().length, 1); assert.equal(f.service.listCheckpoints()[0].topic, 'Other topic'); assert.ok(f.store.getWorkspaceRecord(checkpoint.id), 'Original private history is explicitly retained');
  f.restart(); assert.equal(f.service.listCheckpoints().length, 1); assert.equal(f.store.listWorkspaceRecords({ kind: 'learning_checkpoint' }).filter(record => record.data.format === 'learning_topic_reset').length, 1);
});

test('removed snapshots invalidate full session, attempt, export and catch-up; safe lists omit source/response canaries', t => {
  const f = fixture(t); const session = f.service.createSession(f.input); f.service.saveAttempt(session.id, { ...exact(session), question: 'What terminates?', student_response: 'PRIVATE_RESPONSE_CANARY: base case.' });
  f.store.deleteWorkspaceRecord(f.snapshot.id, f.snapshot.revision);
  code(() => f.service.getSession(session.id), 'STALE_EVIDENCE'); code(() => f.service.exportRecipe(session.id, exact(session)), 'STALE_EVIDENCE'); code(() => f.service.saveAttempt(session.id, { ...exact(session), question: 'Q', student_response: 'A' }), 'STALE_EVIDENCE');
  const list = JSON.stringify({ sessions: f.service.listSessions(), checkpoints: f.service.listCheckpoints() }); assert.equal(list.includes('PRIVATE_SOURCE_CANARY'), false); assert.equal(list.includes('PRIVATE_RESPONSE_CANARY'), false); assert.equal(f.service.listSessions()[0].state, 'stale'); assert.equal(f.service.listCheckpoints()[0].state, 'stale');
});

test('new same-owner source versions invalidate sessions; unrelated courses and identities do not widen context', t => {
  const f = fixture(t); const session = f.service.createSession(f.input); const next = academic('The newly revised lecture has new source content.', new Date(Date.now() + 1000).toISOString()); f.store.createWorkspaceRecord({ kind: 'academic_item', title: 'New snapshot', data: { format: 'academic_snapshot', snapshot: next } });
  code(() => f.service.getSession(session.id), 'STALE_EVIDENCE'); assert.equal(f.service.listSessions()[0].state, 'stale'); assert.equal(JSON.stringify(f.service.listSessions()).includes('PRIVATE_SOURCE_CANARY'), false);
});

test('recipe export is exactly pinned, read back and idempotent; it grants no model sharing', t => {
  const f = fixture(t); const session = f.service.createSession(f.input); code(() => f.service.exportRecipe(session.id, { ...exact(session), expected_revision: 999 }), 'REVISION_CONFLICT'); const exported = f.service.exportRecipe(session.id, exact(session));
  assert.equal(exported.sharing, 'not_granted'); assert.equal(f.service.exportRecipe(session.id, exact(session)).document.id, exported.document.id); assert.equal(f.store.listDocuments().length, 1); assert.equal(f.store.listAgentGrants().length, 0);
  const note = f.store.getDocument(exported.document.id); const recipe = JSON.parse(note.text); assert.equal(recipe.session_revision, session.revision); assert.equal(recipe.session_hash, session.data.recipe.session_hash); assert.deepEqual(recipe.recipe, session.data.recipe); assert.equal(createHash('sha256').update(note.text).digest('hex'), exported.text_sha256); assert.match(exported.retention, /separately removed/);
});

test('catch-up capacity preview stores one proposal, preserves unknown dates and makes zero tasks/calendar writes', t => {
  const f = fixture(t); const session = f.service.createSession(f.input); const start = new Date(Date.now() + 60000).toISOString(); const end = new Date(Date.now() + 91 * 60000).toISOString();
  const input = { ...exact(session), topics: [{ id: 'A', title: 'Base cases', effort_minutes: 60, source_citations: f.input.citations }, { id: 'B', title: 'Recursion practice', effort_minutes: 60, dependency_ids: ['A'], source_citations: f.input.citations }], selected_topic_ids: ['A', 'B'], exam: { title: 'Practice exam', deadline: { precision: 'unknown', original: 'Evening Oct 5' } }, planning_input: { now: start, timezone: 'America/Toronto', horizonEnd: end, availability: [{ start, end }] } };
  const plan = f.service.previewCatchUp(session.id, input, { idempotencyKey: 'learning-catchup-fixture-1' }); assert.equal(plan.data.state, 'proposal'); assert.equal(plan.data.catch_up.exam.time_needs_review, true); assert.equal(plan.data.plan.coverage.proposed_minutes, 90); assert.equal(plan.data.plan.coverage.unscheduled_minutes, 30); assert.equal(f.store.listTasks().length, 0); assert.equal(f.service.previewCatchUp(session.id, input, { idempotencyKey: 'learning-catchup-fixture-1' }).id, plan.id);
  f.restart(); assert.equal(f.store.listWorkspaceRecords({ kind: 'plan' }).length, 1);
});

test('paired route contract fails closed and rejects forged session receipts, malformed fields and nested accessors', async t => {
  const f = fixture(t); const args = { store: f.store, getLibrary: f.getLibrary, route: '/learning/sessions', method: 'GET', privateBody: async () => ({}) };
  await assert.rejects(handleLearningRoute(args), error => error.code === 'AUTH_REQUIRED'); assert.equal(await handleLearningRoute({ ...args, route: '/not-learning' }), null);
  const created = await handleLearningRoute({ ...args, method: 'POST', session: { nonce: 'synthetic-authenticated-session' }, privateBody: async () => f.input, idempotencyKey: 'learning-route-fixture-1' }); assert.equal(created.status, 201); assert.equal(created.data.item.kind, 'tutoring_session');
  const list = await handleLearningRoute({ ...args, session: { nonce: 'synthetic-authenticated-session' } }); assert.equal(list.status, 200); assert.equal(list.data.items.length, 1); assert.equal(JSON.stringify(list).includes('PRIVATE_SOURCE_CANARY'), false);
  code(() => f.service.createSession({ ...f.input, reviewer: 'forged' }), 'INVALID_INPUT'); let invoked = false; const bad = {}; Object.defineProperty(bad, 'source_id', { enumerable: true, get() { invoked = true; return 'anything'; } }); code(() => f.service.createSession({ ...f.input, citations: [bad] }), 'INVALID_INPUT'); assert.equal(invoked, false);
});

test('catch-up acceptance reviews the exact source-bound preview once, survives restart and rejects changed payloads', t => {
  const f = fixture(t); const session = f.service.createSession(f.input); const start = new Date(Date.now() + 60000).toISOString(); const end = new Date(Date.now() + 61 * 60000).toISOString();
  const plan = f.service.previewCatchUp(session.id, { ...exact(session), topics: [{ id: 'A', title: 'Base cases', effort_minutes: 30, source_citations: f.input.citations }], selected_topic_ids: ['A'], exam: { title: 'Catch-up goal', deadline: { precision: 'unknown' } }, planning_input: { now: start, timezone: 'America/Toronto', horizonEnd: end, availability: [{ start, end }] } });
  const review = { expected_revision: plan.revision, plan_hash: plan.data.plan.plan_hash, catch_up_hash: plan.data.catch_up.catch_up_hash };
  code(() => f.service.acceptCatchUp(plan.id, { ...review, plan_hash: 'a'.repeat(64) }), 'REVISION_CONFLICT'); const accepted = f.service.acceptCatchUp(plan.id, review); assert.equal(accepted.data.state, 'accepted'); assert.equal(accepted.revision, 2); assert.deepEqual(accepted.data.review_receipt.effects, { task_writes: 0, calendar_writes: 0 }); assert.equal(f.service.acceptCatchUp(plan.id, review).revision, 2); assert.equal(f.store.listTasks().length, 0);
  f.restart(); assert.equal(f.service.acceptCatchUp(plan.id, review).revision, 2); assert.equal(f.store.getWorkspaceRecord(plan.id).data.state, 'accepted'); f.store.deleteWorkspaceRecord(f.snapshot.id, f.snapshot.revision); code(() => f.service.acceptCatchUp(plan.id, review), 'STALE_EVIDENCE');
});

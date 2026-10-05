import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { normalizeAcademicExport } from '../packages/local-academic/src/index.mjs';
import { buildAcademicLibrary, searchAcademicLibrary } from '../packages/local-academic/src/library.mjs';
import { createLearningService } from '../apps/local-runtime/src/learning-service.mjs';
import { createPlanTaskService } from '../apps/local-runtime/src/plan-task-service.mjs';
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const sha = value => createHash('sha256').update(canonical(value)).digest('hex'), copy = value => JSON.parse(JSON.stringify(value));
function academic(body = 'PRIVATE_TASK_SOURCE_BODY_CANARY: recursion needs a base case.') { return normalizeAcademicExport({ schema_version: 1, institution: { name: 'Synthetic School', origin: 'https://school.fixture.test', timezone: 'America/Toronto' }, account_ref: 'PRIVATE_ACCOUNT_REF_CANARY', retrieved_at: '2026-10-04T12:00:00.000Z', courses: [{ source_id: 'A', title: 'Algorithms', code: 'SYN101' }], assignments: [], announcements: [], materials: [{ source_id: 'lesson', course_id: 'A', title: 'Base cases', body }] }, { selectedCourseIds: ['A'] }); }
function fixture(t, policy = { grading: 'graded', ai_rule: 'scaffolding_only' }) {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-agent-task-source-')), root = join(parent, 'workspace'); let store = LocalStore.open({ root }); t.after(() => { store.close(); rmSync(parent, { recursive: true, force: true }); });
  const snapshot = store.createWorkspaceRecord({ kind: 'academic_item', title: 'Synthetic learning source', data: { format: 'academic_snapshot', snapshot: academic() } });
  const getLibrary = scope => buildAcademicLibrary({ snapshots: scope.snapshot_ids.map(value => { const row = store.getWorkspaceRecord(value); if (!row) { const error = new Error('Unavailable selected source'); error.code = 'SCOPE_DENIED'; throw error; } return row.data.snapshot; }), selectedCourseIds: scope.course_ids });
  const scope = { snapshot_ids: [snapshot.id], course_ids: ['A'] }, found = searchAcademicLibrary(getLibrary(scope), { query: 'base case', courseIds: ['A'] }).results[0], citation = { source_id: found.source_id, version_hash: found.version_hash, chunk_id: found.chunk_id }, learning = () => createLearningService({ store, getLibrary }), service = () => createPlanTaskService({ store, getLibrary });
  const session = learning().createSession({ scope, citations: [citation], topic: 'Recursion', mode: 'hint', academic_policy: policy });
  const draftPlan = learning().previewCatchUp(session.id, { expected_revision: session.revision, session_hash: session.data.recipe.session_hash, topics: [{ id: 'intro', title: 'Review recursion base cases', effort_minutes: 30, source_citations: [citation] }], selected_topic_ids: ['intro'], exam: { title: 'Synthetic study goal', deadline: { precision: 'unknown' } }, planning_input: { now: '2026-10-05T13:00:00.000Z', horizonEnd: '2026-10-05T16:00:00.000Z', timezone: 'America/Toronto', availability: [{ start: '2026-10-05T13:00:00.000Z', end: '2026-10-05T16:00:00.000Z' }] } });
  const plan = learning().acceptCatchUp(draftPlan.id, { expected_revision: draftPlan.revision, plan_hash: draftPlan.data.plan.plan_hash, catch_up_hash: draftPlan.data.catch_up.catch_up_hash });
  const preview = service().preview({ plan_ref: { id: plan.id, revision: plan.revision, plan_hash: plan.data.plan.plan_hash, catch_up_hash: plan.data.catch_up.catch_up_hash }, topic_ids: ['intro'] }, { idempotencyKey: 'agent-task-source-preview' }).preview;
  const acceptance = { expected_revision: preview.revision, preview_hash: preview.data.preview_hash, topic_id: 'intro', task_hash: preview.rows[0].task_hash, confirmed: true };
  return { root, snapshot, plan, preview, acceptance, get store() { return store; }, get service() { return service(); }, accept() { return service().accept(preview.id, acceptance); }, bind(resolver) { store.bindAgentTaskProvenance(resolver ?? (taskId => service().taskProvenance(taskId))); }, restart() { store.close(); store = LocalStore.open({ root }); } };
}
const grant = (store, task_ids, extra = {}) => store.createAgentGrant({ destination: 'codex', task_ids, document_ids: [], source_entry_ids: [], max_bytes: 50000, expires_in_minutes: 10, ...extra });
const context = (store, value, extra = {}) => store.agentContext({ destination: 'codex', grant_id: value.id, ...extra });
const authority = value => ({ destination: 'codex', grant_id: value.id });
const error = (fn, code) => assert.throws(fn, { code });

test('ATP01: unbound and empty-provenance manual tasks retain exact existing task grant hashes and minimal context with no annotation', t => {
  const f = fixture(t), task = f.store.createTask({ title: 'Unrelated manual next step' }), initial = grant(f.store, [task.id]); assert.equal(initial.pins.tasks[0].version_hash, sha(task));
  f.bind(); const permission = grant(f.store, [task.id]), result = context(f.store, permission); assert.equal(permission.pins.tasks[0].version_hash, initial.pins.tasks[0].version_hash);
  assert.deepEqual(result.tasks[0], { id: task.id, revision: task.revision, title: task.title, status: task.status, deadline: task.deadline, course_label: null, effort_minutes: null }); assert.equal('source' in result.tasks[0], false); assert.equal(f.store.assertAgentAcademicPolicy(authority(permission)).academic_policy, 'unrestricted'); assert.equal(f.store.assertAgentGrant(authority(initial)).id, initial.id);
});

test('ATP02: a real accepted study-plan task shares reduced source receipt/pin/policy metadata only, no source bodies/citations/profile or implicit source selection', t => {
  const f = fixture(t), accepted = f.accept(); f.store.createDocument({ title: 'UNSELECTED_TASK_DOCUMENT_CANARY', text: 'PRIVATE_DOCUMENT_BODY_CANARY', academic_policy: 'unrestricted' }); f.store.createWorkspaceRecord({ kind: 'profile_fact', title: 'PRIVATE_FULL_PROFILE_CANARY', data: { value: 'PRIVATE_PROFILE_BODY_CANARY' } }); f.bind(); const permission = grant(f.store, [accepted.task.id]);
  assert.deepEqual(permission.pins.documents, []); assert.deepEqual(permission.pins.source_entries, []); const before = f.store.getAgentGrant(permission.id); assert.deepEqual(f.store.assertAgentAcademicPolicy(authority(permission)), { academic_policy: 'graded_restricted' }); assert.equal(f.store.getAgentGrant(permission.id).used_bytes, before.used_bytes);
  const result = context(f.store, permission), source = result.tasks[0].source; assert.equal(source.academic_policy, 'graded_restricted'); assert.equal(source.metadata_only, true); assert.deepEqual(source.provenance_receipts[0].source.academic_policy, { grading: 'graded', ai_rule: 'scaffolding_only' }); assert.equal(source.provenance_receipts[0].local_task_differs, false); assert.equal(source.provenance_receipts[0].id, accepted.receipt.id);
  assert.deepEqual(source.provenance_pins.map(pin => pin.kind), ['learning_plan_task_receipt', 'learning_catchup_plan', 'tutoring_session', 'learning_academic_snapshot']); assert.equal(permission.pins.tasks[0].version_hash, sha({ ...accepted.task, source })); assert.notEqual(permission.pins.tasks[0].version_hash, sha(accepted.task));
  const text = JSON.stringify(result); for (const marker of ['PRIVATE_TASK_SOURCE_BODY_CANARY', 'PRIVATE_ACCOUNT_REF_CANARY', 'PRIVATE_DOCUMENT_BODY_CANARY', 'PRIVATE_PROFILE_BODY_CANARY', 'source_citations', 'reviewed_task', 'completed_prerequisites', 'dependency_pins']) assert.equal(text.includes(marker), false); assert.deepEqual(result.documents, []); assert.deepEqual(result.source_entries, []); assert.equal(result.serialized_bytes, Buffer.byteLength(text));
});

test('ATP03: forgetting a task source denies grant creation/assert/read/policy/proposal even with unchanged task revision and no requested task body', t => {
  const f = fixture(t), accepted = f.accept(); f.bind(); const permission = grant(f.store, [accepted.task.id]), original = f.store.getTask(accepted.task.id); f.store.deleteWorkspaceRecord(f.snapshot.id, f.snapshot.revision);
  for (const call of [() => grant(f.store, [accepted.task.id]), () => f.store.assertAgentGrant(authority(permission)), () => f.store.assertAgentAcademicPolicy(authority(permission)), () => context(f.store, permission), () => context(f.store, permission, { task_ids: [] }), () => f.store.proposeTask({ ...authority(permission), title: 'Must not be queued', idempotency_key: 'stale-task-source-proposal' })]) assert.throws(call, error => ['REVISION_CONFLICT', 'SCOPE_DENIED', 'VERSION_MISMATCH'].includes(error.code));
  assert.deepEqual(f.store.getTask(original.id), original); assert.equal(f.store.getAgentGrant(permission.id).used_bytes, 0); assert.equal(f.store.listTaskProposals().length, 0); const manual = f.store.createTask({ title: 'Independent manual task' }); assert.equal(context(f.store, grant(f.store, [manual.id])).tasks[0].source, undefined);
});

test('ATP04: changed source snapshot invalidates existing task-only authority without changing or deleting its accepted local task', t => {
  const f = fixture(t), accepted = f.accept(); f.bind(); const permission = grant(f.store, [accepted.task.id]); f.store.updateWorkspaceRecord(f.snapshot.id, { expected_revision: f.snapshot.revision, data: { format: 'academic_snapshot', snapshot: academic('Updated official-source observation supplied in fixture.') } });
  assert.throws(() => f.store.assertAgentGrant(authority(permission)), error => ['REVISION_CONFLICT', 'VERSION_MISMATCH'].includes(error.code)); assert.equal(f.store.getTask(accepted.task.id).revision, accepted.task.revision); assert.equal(f.store.getAgentGrant(permission.id).used_bytes, 0);
});

test('ATP05: manual task edits remain local and are flagged against original review; source academic policy survives new grants', t => {
  const f = fixture(t), accepted = f.accept(); f.store.updateTask(accepted.task.id, { title: 'Student edited this local title', effort_minutes: 45 }, accepted.task.revision); f.bind(); const permission = grant(f.store, [accepted.task.id]), result = context(f.store, permission);
  assert.equal(result.tasks[0].title, 'Student edited this local title'); assert.equal(result.tasks[0].source.provenance_receipts[0].local_task_differs, true); assert.equal(result.tasks[0].source.academic_policy, 'graded_restricted'); assert.equal(result.tasks[0].source.provenance_receipts[0].source.mastery_claim, false);
  f.store.updateTask(accepted.task.id, { title: 'Changed after grant review' }, 2); error(() => context(f.store, permission), 'VERSION_MISMATCH'); assert.equal(f.store.assertAgentAcademicPolicy(authority(grant(f.store, [accepted.task.id]))).academic_policy, 'graded_restricted');
});

test('ATP06: actual task created before an incomplete acceptance journal cannot enter an agent grant until explicit recovery finalizes the source receipt', t => {
  const f = fixture(t), original = f.store.createTask.bind(f.store); f.store.createTask = (...args) => { original(...args); throw new Error('Synthetic unfinished handoff'); }; assert.throws(() => f.accept()); f.store.createTask = original; const task = f.store.listTasks()[0]; assert(task); f.bind(); error(() => grant(f.store, [task.id]), 'CONSENT_REQUIRED'); assert.equal(f.store.listAgentGrants().length, 0);
  const recovered = f.accept(); assert.equal(recovered.task.id, task.id); assert.equal(context(f.store, grant(f.store, [task.id])).tasks[0].source.metadata_only, true); assert.equal(f.store.listTasks().length, 1);
});

test('ATP07: binder is trusted one-time synchronous configuration; malformed resolver results and missing provenance halves fail closed', t => {
  const f = fixture(t); error(() => f.store.bindAgentTaskProvenance(null), 'INVALID_INPUT'); error(() => f.store.bindAgentTaskProvenance(async () => ({ receipts: [], pins: [] })), 'INVALID_INPUT'); f.bind(); error(() => f.bind(), 'REVISION_CONFLICT');
  for (const result of [null, [], {}, { receipts: [] }, { receipts: [], pins: [{}] }, { receipts: [{}], pins: [] }, Promise.resolve({ receipts: [], pins: [] })]) { const other = fixture(t), task = other.store.createTask({ title: 'Manual test' }); other.bind(() => result); assert.throws(() => grant(other.store, [task.id])); assert.equal(other.store.listAgentGrants().length, 0); }
  const other = fixture(t), task = other.store.createTask({ title: 'Getter test' }); let accessed = false; other.bind(() => Object.defineProperty({ pins: [] }, 'receipts', { enumerable: true, get() { accessed = true; return []; } })); assert.throws(() => grant(other.store, [task.id])); assert.equal(accessed, false);
});

test('ATP08: verifier exceptions or disappearing provenance cannot silently become source-free context; failed reads/proposals charge zero and reveal no exception text', t => {
  const f = fixture(t), accepted = f.accept(); let mode = 'valid'; f.bind(taskId => { if (mode === 'empty') return { receipts: [], pins: [] }; if (mode === 'throw') throw new Error('PRIVATE_VERIFIER_ERROR_CANARY'); return f.service.taskProvenance(taskId); }); const permission = grant(f.store, [accepted.task.id]);
  for (const next of ['empty', 'throw']) { mode = next; assert.throws(() => context(f.store, permission), error => error.code === 'VERSION_MISMATCH' && !String(error).includes('PRIVATE_VERIFIER_ERROR_CANARY')); error(() => f.store.assertAgentAcademicPolicy(authority(permission)), 'VERSION_MISMATCH'); error(() => f.store.proposeTask({ ...authority(permission), title: 'Blocked', idempotency_key: `disappearing-source-${next}` }), 'VERSION_MISMATCH'); assert.equal(f.store.getAgentGrant(permission.id).used_bytes, 0); }
  assert.equal(f.store.listTaskProposals().length, 0);
});

test('ATP09: serialized metadata is charged to exact cumulative/request budgets while source-policy assertions are read-only and free of content', t => {
  const f = fixture(t), accepted = f.accept(); f.bind(); const small = grant(f.store, [accepted.task.id], { max_bytes: 1000 }); assert.deepEqual(f.store.assertAgentAcademicPolicy(authority(small)), { academic_policy: 'graded_restricted' }); error(() => context(f.store, small), 'BUDGET_EXCEEDED'); assert.equal(f.store.getAgentGrant(small.id).used_bytes, 0);
  const permission = grant(f.store, [accepted.task.id]); error(() => context(f.store, permission, { max_bytes: 1000 }), 'BUDGET_EXCEEDED'); const one = context(f.store, permission), two = context(f.store, permission); assert.equal(one.serialized_bytes, Buffer.byteLength(JSON.stringify(one))); assert.equal(two.used_bytes, one.serialized_bytes + two.serialized_bytes); const before = f.store.getAgentGrant(permission.id).used_bytes; assert.deepEqual(f.store.assertAgentAcademicPolicy(authority(permission)), { academic_policy: 'graded_restricted' }); assert.equal(f.store.getAgentGrant(permission.id).used_bytes, before);
});

test('ATP10: scope-wide strongest policy includes every selected document/task, preventing an unrestricted target from ignoring a restricted source', t => {
  const f = fixture(t), accepted = f.accept(), plain = f.store.createDocument({ title: 'Unrestricted target', text: 'Selected literal outline.', academic_policy: 'unrestricted' }), restricted = f.store.createDocument({ title: 'Restricted note', text: 'Restricted conceptual evidence.', academic_policy: 'graded_restricted' }); f.bind();
  assert.deepEqual(f.store.assertAgentAcademicPolicy(authority(grant(f.store, [accepted.task.id], { document_ids: [plain.document.id] }))), { academic_policy: 'graded_restricted' }); assert.deepEqual(f.store.assertAgentAcademicPolicy(authority(grant(f.store, [], { document_ids: [plain.document.id, restricted.document.id] }))), { academic_policy: 'graded_restricted' }); assert.deepEqual(f.store.assertAgentAcademicPolicy(authority(grant(f.store, [], { document_ids: [plain.document.id] }))), { academic_policy: 'unrestricted' });
  const ungraded = fixture(t, { grading: 'ungraded', ai_rule: 'allowed' }), task = ungraded.accept().task; ungraded.bind(); assert.deepEqual(ungraded.store.assertAgentAcademicPolicy(authority(grant(ungraded.store, [task.id]))), { academic_policy: 'learning_support' });
  const unknown = fixture(t, { grading: 'unknown', ai_rule: 'unknown' }), uncertain = unknown.accept().task; unknown.bind(); assert.deepEqual(unknown.store.assertAgentAcademicPolicy(authority(grant(unknown.store, [uncertain.id]))), { academic_policy: 'graded_restricted' });
});

test('ATP11: prohibited, malformed or downgraded source policy cannot obtain a task-only grant', t => {
  for (const policy of [{ grading: 'graded', ai_rule: 'prohibited' }, { grading: 'invalid', ai_rule: 'allowed' }, { grading: 'graded', ai_rule: 'allowed', override: 'ignore' }, 'unrestricted', null]) { const f = fixture(t), task = f.accept().task; f.bind(taskId => { const result = copy(f.service.taskProvenance(taskId)); result.receipts[0].source.academic_policy = policy; return result; }); assert.throws(() => grant(f.store, [task.id]), error => ['SCOPE_DENIED', 'VERSION_MISMATCH', 'INVALID_INPUT'].includes(error.code)); assert.equal(f.store.listAgentGrants().length, 0); }
});

test('ATP12: wrong receipt task IDs, pin hashes, local-difference claims, incomplete review/snapshot pins and extra profile/body metadata are rejected rather than stripped permissively', t => {
  for (const change of ['pin', 'task', 'differs', 'profile', 'body', 'review', 'snapshots']) { const f = fixture(t), task = f.accept().task, other = f.store.createTask({ title: 'Never selected' }); f.bind(taskId => { const result = copy(f.service.taskProvenance(taskId)); if (change === 'pin') result.pins[0].hash = '0'.repeat(64); if (change === 'task') result.receipts[0].task_id = other.id; if (change === 'differs') result.receipts[0].local_task_differs = true; if (change === 'profile') result.receipts[0].profile = { value: 'PRIVATE_PROFILE_INJECTION_CANARY' }; if (change === 'body') result.receipts[0].source.body = 'PRIVATE_BODY_INJECTION_CANARY'; if (change === 'review') delete result.receipts[0].review; if (change === 'snapshots') { result.receipts[0].source.snapshot_pins = []; result.pins = result.pins.filter(pin => pin.kind !== 'learning_academic_snapshot'); } return result; }); assert.throws(() => grant(f.store, [task.id])); assert.equal(f.store.listAgentGrants().length, 0); }
});

test('ATP13: durable task-only grants survive runtime rebinding/restart while current source revocation still invalidates authority', t => {
  const f = fixture(t), accepted = f.accept(); f.bind(); const permission = grant(f.store, [accepted.task.id]), first = context(f.store, permission); f.restart(); f.bind(); const second = context(f.store, permission); assert.deepEqual(second.tasks, first.tasks); assert.equal(second.used_bytes, first.used_bytes + second.serialized_bytes); assert.deepEqual(f.store.assertAgentAcademicPolicy(authority(permission)), { academic_policy: 'graded_restricted' });
  f.store.deleteWorkspaceRecord(f.snapshot.id, f.snapshot.revision); assert.throws(() => f.store.assertAgentAcademicPolicy(authority(permission))); assert.equal(f.store.getTask(accepted.task.id).revision, 1); assert.equal(f.store.integrity().integrity, 'ok');
});

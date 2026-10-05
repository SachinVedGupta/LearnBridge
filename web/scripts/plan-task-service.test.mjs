import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { normalizeAcademicExport } from '../packages/local-academic/src/index.mjs';
import { buildAcademicLibrary, searchAcademicLibrary } from '../packages/local-academic/src/library.mjs';
import { createLearningService } from '../apps/local-runtime/src/learning-service.mjs';
import { createPlanTaskService, verifyPlanTaskProvenance, PLAN_TASK_FORMAT, PLAN_TASK_RECEIPT } from '../apps/local-runtime/src/plan-task-service.mjs';
import { handlePlanTaskRoute } from '../apps/local-runtime/src/plan-task-routes.mjs';

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const sha = value => createHash('sha256').update(canonical(value)).digest('hex');
const ref = plan => ({ id: plan.id, revision: plan.revision, plan_hash: plan.data.plan.plan_hash, catch_up_hash: plan.data.catch_up.catch_up_hash });
const pins = preview => ({ expected_revision: preview.revision, preview_hash: preview.data.preview_hash });
const accept = (preview, topic = preview.rows[0].topic_id) => ({ ...pins(preview), topic_id: topic, task_hash: preview.rows.find(row => row.topic_id === topic).task_hash, confirmed: true });
function exported(body = 'PRIVATE_LEARNING_SOURCE: recursion stops at a base case.', retrieved_at = '2026-10-04T12:00:00.000Z') {
  return normalizeAcademicExport({ schema_version: 1, institution: { name: 'Synthetic School', origin: 'https://school.fixture.test', timezone: 'America/Toronto' }, account_ref: 'fixture-student', retrieved_at,
    courses: [{ source_id: 'A', title: 'Algorithms', code: 'SYN101' }, { source_id: 'B', title: 'Other course' }], assignments: [], announcements: [], materials: [{ source_id: 'lesson', course_id: 'A', title: 'Base cases', body }, { source_id: 'other', course_id: 'B', title: 'Other course', body: 'PRIVATE_OTHER_COURSE' }] }, { selectedCourseIds: ['A', 'B'] });
}
function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-plan-tasks-')), root = join(parent, 'workspace'); let store = LocalStore.open({ root, timezone: 'America/Toronto' });
  t.after(() => { store.close(); rmSync(parent, { recursive: true, force: true }); });
  const snapshot = store.createWorkspaceRecord({ kind: 'academic_item', title: 'Synthetic selected course source', data: { format: 'academic_snapshot', snapshot: exported() } });
  const getLibrary = scope => buildAcademicLibrary({ snapshots: scope.snapshot_ids.map(value => { const actual = store.getWorkspaceRecord(value); if (!actual) { const error = new Error('Missing selected source'); error.code = 'SCOPE_DENIED'; throw error; } return actual.data.snapshot; }), selectedCourseIds: scope.course_ids });
  const scope = { snapshot_ids: [snapshot.id], course_ids: ['A'] }, found = searchAcademicLibrary(getLibrary(scope), { query: 'base case', courseIds: ['A'] }).results[0], citation = { source_id: found.source_id, version_hash: found.version_hash, chunk_id: found.chunk_id };
  const learning = () => createLearningService({ store, getLibrary }), service = () => createPlanTaskService({ store, getLibrary });
  const session = learning().createSession({ scope, citations: [citation], topic: 'Recursion', mode: 'hint', academic_policy: { grading: 'graded', ai_rule: 'scaffolding_only' } });
  function plan({ deadline = { precision: 'unknown', original: 'Student goal; exact date not supplied' }, topics = [{ id: 'intro', title: 'Review base cases', effort_minutes: 30 }, { id: 'practice', title: 'Practice recursion', effort_minutes: 45, dependency_ids: ['intro'] }], accepted = true } = {}) {
    const start = '2026-10-05T13:00:00.000Z', end = '2026-10-05T16:00:00.000Z';
    const item = learning().previewCatchUp(session.id, { expected_revision: session.revision, session_hash: session.data.recipe.session_hash, topics: topics.map(row => ({ source_citations: [citation], ...row })), selected_topic_ids: topics.map(row => row.id), exam: { title: 'Synthetic study goal', deadline }, planning_input: { now: start, horizonEnd: end, timezone: 'America/Toronto', availability: [{ start, end }] } });
    return accepted ? learning().acceptCatchUp(item.id, { expected_revision: item.revision, plan_hash: item.data.plan.plan_hash, catch_up_hash: item.data.catch_up.catch_up_hash }) : item;
  }
  return { parent, root, snapshot, session, scope, citation, getLibrary, plan, get store() { return store; }, get service() { return service(); }, learning,
    preview(plan, topic_ids = plan.data.catch_up.selected_topic_ids, requestKey = 'fixture-plan-task-preview') { return service().preview({ plan_ref: ref(plan), topic_ids }, { idempotencyKey: requestKey }).preview; },
    restart() { store.close(); store = LocalStore.open({ root, timezone: 'America/Toronto' }); },
    async restore() { const backup = join(parent, 'backup'); await store.backup(backup); store.close(); const restored = join(parent, 'restored'); await LocalStore.restore({ backupRoot: backup, root: restored }); store = LocalStore.open({ root: restored }); } };
}

test('PTS01: only an already human-accepted current catch-up plan is eligible; preview has zero task or learning effects', t => {
  const f = fixture(t), proposed = f.plan({ accepted: false }); assert.throws(() => f.service.inspect(proposed.id), { code: 'CONSENT_REQUIRED' }); assert.throws(() => f.preview(proposed), { code: 'CONSENT_REQUIRED' }); assert.equal(f.store.getWorkspaceRecord(proposed.id).data.state, 'proposal');
  const plan = f.plan(), before = f.store.getWorkspaceRecord(plan.id), preview = f.preview(plan); assert.equal(preview.rows.length, 2); assert.equal(preview.rows[0].selectable, true); assert.equal(preview.rows[1].selectable, false); assert.equal(preview.rows[1].blockers[0].reason, 'prerequisite_needs_separate_task_acceptance');
  assert.equal(f.store.listTasks().length, 0); assert.equal(f.store.listWorkspaceRecords({ kind: 'inbox_item' }).length, 0); assert.deepEqual(f.store.getWorkspaceRecord(plan.id), before); assert.equal(preview.data.format, PLAN_TASK_FORMAT); assert.equal(preview.data.preview.source.mastery_claim, false); assert.equal(preview.data.preview.source.academic_policy.ai_rule, 'scaffolding_only');
  assert.equal(JSON.stringify(f.service.state()).includes('PRIVATE_LEARNING_SOURCE'), false); assert.equal(JSON.stringify(f.service.inspect(plan.id)).includes('PRIVATE_OTHER_COURSE'), false);
});

test('PTS02: one exact separately accepted topic creates one pending local task with evidence/effort/deadline receipt; retry creates no duplicate', t => {
  const f = fixture(t), plan = f.plan(), preview = f.preview(plan), request = accept(preview), result = f.service.accept(preview.id, request); assert.equal(result.task_effects, 1); assert.equal(result.task.title, 'Review base cases'); assert.equal(result.task.status, 'pending'); assert.equal(result.task.effort_minutes, 30); assert.deepEqual(result.task.deadline, { precision: 'unknown', original: 'Student goal; exact date not supplied', reason: 'not_provided' });
  assert.equal(result.receipt.data.format, PLAN_TASK_RECEIPT); assert.deepEqual(result.receipt.data.source_citations, [f.citation]); assert.equal(result.receipt.data.review.reviewer, f.store.identity.student_id); assert.equal(result.receipt.data.review.task_hash, request.task_hash); assert.equal(f.store.listTasks().length, 1); assert.equal(f.store.listWorkspaceRecords({ kind: 'learning_checkpoint' }).length, 0);
  const retry = f.service.accept(preview.id, request); assert.equal(retry.task_effects, 0); assert.equal(retry.task.id, result.task.id); assert.equal(retry.replayed, true); assert.equal(f.store.listTasks().length, 1);
});

test('PTS03: pending prerequisites require separate review, then resolve exact local graph IDs; no dependent task is silently accepted', t => {
  const f = fixture(t), plan = f.plan(), preview = f.preview(plan); assert.throws(() => f.service.accept(preview.id, accept(preview, 'practice')), { code: 'REVISION_CONFLICT' }); assert.equal(f.store.listTasks().length, 0);
  const parent = f.service.accept(preview.id, accept(preview, 'intro')), current = parent.preview, child = current.rows.find(row => row.topic_id === 'practice'); assert.equal(child.selectable, true); assert.deepEqual(child.task.dependency_ids, [parent.task.id]); assert.equal(child.dependency_pins[0].task_revision, parent.task.revision); assert.equal(f.store.listTasks().length, 1);
  const second = f.service.accept(current.id, accept(current, 'practice')); assert.deepEqual(second.task.dependency_ids, [parent.task.id]); assert.equal(f.store.listTasks().length, 2); assert.equal(second.preview.counts.accepted, 2);
});

test('PTS04: date-only and exact instant source goal deadlines survive untouched and never become study-block start/end', t => {
  const f = fixture(t); for (const [index, deadline] of [{ precision: 'date', date: '2026-10-10', timezone: 'America/Toronto', original: 'October 10' }, { precision: 'instant', instant: '2026-10-10T16:00:00.000Z', timezone: 'America/Toronto', original: 'Noon October 10' }].entries()) {
    const plan = f.plan({ deadline }), preview = f.preview(plan, ['intro'], `fixture-deadline-${index}`), result = f.service.accept(preview.id, accept(preview)); assert.deepEqual(result.task.deadline, deadline); assert.notEqual(result.task.deadline.instant, plan.data.plan.blocks[0].start);
  }
});

test('PTS05: stale source edits, newer same-owner versions, removed sources/session/plan and changed accepted-plan pins deny new task effects', t => {
  for (const change of ['snapshot-edit', 'new-source', 'forget-snapshot', 'forget-session', 'forget-plan', 'change-plan']) {
    const f = fixture(t), plan = f.plan(), preview = f.preview(plan); if (change === 'snapshot-edit') f.store.updateWorkspaceRecord(f.snapshot.id, { expected_revision: f.snapshot.revision, data: { format: 'academic_snapshot', snapshot: exported('Changed lecture') } });
    if (change === 'new-source') f.store.createWorkspaceRecord({ kind: 'academic_item', title: 'New selected version', data: { format: 'academic_snapshot', snapshot: exported('New lecture', '2026-10-04T13:00:00.000Z') } });
    if (change.startsWith('forget-')) { const old = change === 'forget-snapshot' ? f.snapshot : change === 'forget-session' ? f.session : plan; f.store.deleteWorkspaceRecord(old.id, old.revision); }
    if (change === 'change-plan') f.store.updateWorkspaceRecord(plan.id, { expected_revision: plan.revision, title: 'Changed local plan' });
    assert.equal(f.service.get(preview.id).preview.stale, true, change); assert.throws(() => f.service.accept(preview.id, accept(preview)), error => ['REVISION_CONFLICT', 'SCOPE_DENIED'].includes(error.code), change); assert.equal(f.store.listTasks().length, 0, change);
  }
});

test('PTS06: unselected topics, stale revisions, source/task hashes, missing confirmation and unknown/accessor inputs cannot authorize tasks', t => {
  const f = fixture(t), plan = f.plan(), preview = f.preview(plan, ['intro']), request = accept(preview);
  for (const patch of [{ topic_id: 'practice' }, { expected_revision: 999 }, { preview_hash: 'f'.repeat(64) }, { task_hash: 'f'.repeat(64) }, { confirmed: false }, { auto_accept: true }, { deadline: { precision: 'instant', instant: '2026-10-05T13:00:00.000Z' } }]) assert.throws(() => f.service.accept(preview.id, { ...request, ...patch }), error => ['SCOPE_DENIED', 'REVISION_CONFLICT', 'CONSENT_REQUIRED', 'INVALID_INPUT'].includes(error.code));
  let invoked = false; const bad = { ...request }; Object.defineProperty(bad, 'task_hash', { enumerable: true, get() { invoked = true; return request.task_hash; } }); assert.throws(() => f.service.accept(preview.id, bad), { code: 'INVALID_INPUT' }); assert.equal(invoked, false); assert.equal(f.store.listTasks().length, 0);
  assert.throws(() => f.preview({ ...plan, revision: 999 }, ['intro'], 'fixture-stale-plan-ref'), { code: 'REVISION_CONFLICT' }); assert.throws(() => f.service.get(randomUUID()), { code: 'SCOPE_DENIED' });
});

test('PTS07: same-title different topic identities are distinct; repeated previews and forgotten previews never duplicate or recreate source tasks', t => {
  const f = fixture(t), plan = f.plan({ topics: [{ id: 'one', title: 'Same title', effort_minutes: 10 }, { id: 'two', title: 'Same title', effort_minutes: 10 }] }), preview = f.preview(plan), first = f.service.accept(preview.id, accept(preview, 'one'));
  const next = f.preview(plan, ['one', 'two'], 'fixture-another-preview'); assert.equal(next.rows.find(row => row.topic_id === 'one').state, 'already_accepted'); assert.equal(next.rows.find(row => row.topic_id === 'two').selectable, true);
  f.service.forget(preview.id, pins(first.preview)); f.store.deleteTask(first.task.id, first.task.revision); const latest = f.service.get(next.id).preview; assert.equal(latest.rows.find(row => row.topic_id === 'one').accepted_task.unavailable, true); assert.throws(() => f.service.accept(next.id, accept(latest, 'one')), { code: 'REVISION_CONFLICT' });
  const second = f.service.accept(next.id, accept(latest, 'two')); assert.equal(second.task.title, first.task.title); assert.notEqual(second.task.id, first.task.id); assert.equal(f.store.listTasks().length, 1); assert.equal(f.store.listWorkspaceRecords({ kind: 'inbox_item' }).filter(row => row.data.format === PLAN_TASK_RECEIPT).length, 2);
});

test('PTS08: actual task creation followed by lost response recovers durable receipt across restart with no duplicate or auto-acceptance', t => {
  const f = fixture(t), plan = f.plan(), preview = f.preview(plan), request = accept(preview), original = f.store.createTask.bind(f.store); let once = true;
  f.store.createTask = (...args) => { const task = original(...args); if (once) { once = false; throw new Error('Lost task completion response'); } return task; };
  assert.throws(() => f.service.accept(preview.id, request), /Lost task/); assert.equal(f.store.listTasks().length, 1); assert.equal(f.service.get(preview.id).preview.rows[0].state, 'acceptance_pending'); f.restart();
  const recovery = f.service.accept(preview.id, request); assert.equal(recovery.replayed, true); assert.equal(recovery.task_effects, 0); assert.equal(recovery.receipt.data.state, 'accepted'); assert.equal(f.store.listTasks().length, 1); assert.equal(recovery.preview.rows[1].state, 'awaiting_review');
});

test('PTS09: interrupted pre-task acceptance cannot create after source revocation; already committed task can finalize only its original receipt', t => {
  for (const committed of [false, true]) { const f = fixture(t), plan = f.plan(), preview = f.preview(plan), request = accept(preview), original = f.store.createTask.bind(f.store);
    f.store.createTask = (...args) => { if (committed) original(...args); throw new Error('Task interruption'); }; assert.throws(() => f.service.accept(preview.id, request), /interruption/); f.store.deleteWorkspaceRecord(f.snapshot.id, f.snapshot.revision); f.restart();
    if (!committed) assert.throws(() => f.service.accept(preview.id, request), error => ['SCOPE_DENIED', 'REVISION_CONFLICT'].includes(error.code)); else { const result = f.service.accept(preview.id, request); assert.equal(result.task_effects, 0); assert.equal(result.preview.stale, true); assert.equal(result.receipt.data.state, 'accepted'); }
    assert.equal(f.store.listTasks().length, committed ? 1 : 0);
  }
});

test('PTS10: restart and fresh backup restore preserve exact accepted task/source receipts and preview identity', async t => {
  const f = fixture(t), plan = f.plan(), preview = f.preview(plan), request = accept(preview), result = f.service.accept(preview.id, request), before = f.service.get(preview.id); f.restart(); assert.deepEqual(f.service.get(preview.id), before); await f.restore(); assert.deepEqual(f.service.get(preview.id), before); assert.equal(f.service.accept(preview.id, request).task.id, result.task.id); assert.equal(f.store.listTasks().length, 1);
});

test('PTS11: dependency edits/delete and changed current prerequisite revision block stale exact child selection', t => {
  for (const change of ['complete', 'edit', 'delete']) { const f = fixture(t), plan = f.plan(), preview = f.preview(plan), first = f.service.accept(preview.id, accept(preview)), ready = first.preview, childRequest = accept(ready, 'practice');
    if (change === 'delete') f.store.deleteTask(first.task.id, first.task.revision); else f.store.updateTask(first.task.id, change === 'edit' ? { title: 'Changed prerequisite' } : { status: 'completed' }, first.task.revision);
    assert.throws(() => f.service.accept(ready.id, childRequest), { code: 'REVISION_CONFLICT' }); assert.equal(f.store.listTasks().length, change === 'delete' ? 0 : 1);
    const current = f.service.get(ready.id).preview; assert.equal(current.rows[1].selectable, change === 'complete'); if (change === 'complete') { const result = f.service.accept(current.id, accept(current, 'practice')); assert.deepEqual(result.task.dependency_ids, [first.task.id]); }
  }
});

test('PTS12: completed topics stay explicitly student-reported, unknown effort remains unknown, and no learning-completion claims are created', t => {
  const f = fixture(t), plan = f.plan({ topics: [{ id: 'done', title: 'Reported done', effort_minutes: 10, completed: true }, { id: 'next', title: 'Unknown effort', effort_minutes: null, dependency_ids: ['done'] }] });
  assert.equal(f.service.inspect(plan.id).topics[0].state, 'student_reported_complete_no_new_task'); assert.throws(() => f.preview(plan, ['done']), { code: 'CONSENT_REQUIRED' });
  const preview = f.preview(plan, ['next']), result = f.service.accept(preview.id, accept(preview)); assert.equal(result.task.status, 'pending'); assert.equal(result.task.effort_minutes, null); assert.deepEqual(result.task.dependency_ids, []); assert.equal(result.receipt.data.completed_prerequisites[0].claim, 'student_reported_complete_not_mastery'); assert.equal(f.store.listWorkspaceRecords({ kind: 'learning_checkpoint' }).length, 0);
});

test('PTS13: preparation idempotence, strict selected topic arrays and accepted-human receipt validation fail closed', t => {
  const f = fixture(t), plan = f.plan(), item = f.preview(plan); assert.equal(f.preview(plan).id, item.id); assert.throws(() => f.preview(plan, ['intro']), { code: 'REVISION_CONFLICT' });
  for (const topic_ids of [[], ['intro', 'intro'], Array(21).fill('intro'), ['unknown']]) assert.throws(() => f.preview(plan, topic_ids, `fixture-invalid-${randomUUID()}`), error => ['INVALID_INPUT', 'CONSENT_REQUIRED'].includes(error.code));
  let invoked = false; const topic_ids = []; Object.defineProperty(topic_ids, 0, { enumerable: true, get() { invoked = true; return 'intro'; } }); assert.throws(() => f.service.preview({ plan_ref: ref(plan), topic_ids }, { idempotencyKey: 'fixture-accessor-topics' }), { code: 'INVALID_INPUT' }); assert.equal(invoked, false);
  const changed = f.store.updateWorkspaceRecord(plan.id, { expected_revision: plan.revision, data: { ...plan.data, review_receipt: { ...plan.data.review_receipt, reviewer: randomUUID() } } }); assert.throws(() => f.service.inspect(changed.id), { code: 'CONSENT_REQUIRED' }); assert.equal(f.store.listTasks().length, 0);
});

test('PTS14: forgetting exact previews preserves original accepted plan, tasks and durable independent dedup receipts', t => {
  const f = fixture(t), plan = f.plan(), preview = f.preview(plan), first = f.service.accept(preview.id, accept(preview)), before = f.store.getWorkspaceRecord(plan.id); assert.throws(() => f.service.forget(preview.id, pins(preview)), { code: 'REVISION_CONFLICT' });
  const result = f.service.forget(preview.id, pins(first.preview)); assert.equal(result.deleted, true); assert.match(result.retention, /Created tasks and independent/); assert.equal(f.store.listTasks().length, 1); assert.deepEqual(f.store.getWorkspaceRecord(plan.id), before); assert.throws(() => f.service.get(preview.id), { code: 'SCOPE_DENIED' }); assert.equal(f.service.state().previews.length, 0);
});

test('PTS15: twenty selected topics remain bounded independent proposals and accepting one cannot publish any other task', t => {
  const f = fixture(t), plan = f.plan({ topics: Array.from({ length: 20 }, (_, index) => ({ id: `topic-${index}`, title: `Study concept ${index}`, effort_minutes: 5 })) }), preview = f.preview(plan); assert.equal(preview.rows.length, 20); assert.equal(preview.counts.awaiting_review, 20);
  const result = f.service.accept(preview.id, accept(preview, 'topic-10')); assert.equal(result.task_effects, 1); assert.equal(f.store.listTasks().length, 1); assert.equal(result.preview.counts.awaiting_review, 19); assert.equal(result.preview.counts.accepted, 1);
});

test('PTS16: pending dependent-task recovery cannot use changed prerequisite pins, while saved task recovery preserves exact original receipt', t => {
  for (const committed of [false, true]) { const f = fixture(t), plan = f.plan(), preview = f.preview(plan), parent = f.service.accept(preview.id, accept(preview)), ready = parent.preview, request = accept(ready, 'practice'), original = f.store.createTask.bind(f.store);
    f.store.createTask = (...args) => { if (committed) original(...args); throw new Error('Interrupted child'); }; assert.throws(() => f.service.accept(ready.id, request), /Interrupted/); f.store.updateTask(parent.task.id, { status: 'completed' }, parent.task.revision); f.restart();
    const pending = f.service.get(ready.id).preview.rows.find(row => row.topic_id === 'practice'); assert.equal(pending.task_hash, request.task_hash); assert.notEqual(pending.current_task_hash, request.task_hash);
    if (!committed) assert.throws(() => f.service.accept(ready.id, request), { code: 'REVISION_CONFLICT' }); else { const result = f.service.accept(ready.id, request); assert.equal(result.task_effects, 0); assert.equal(result.receipt.data.review.task_hash, request.task_hash); }
    assert.equal(f.store.listTasks().length, committed ? 2 : 1);
  }
});

test('PTS17: read-only downstream provenance pins current learning source/policy, marks task edits, and denies stale or unfinalized sourced tasks without blocking unrelated manual tasks', t => {
  const f = fixture(t), plan = f.plan(), preview = f.preview(plan), first = f.service.accept(preview.id, accept(preview)), before = f.service.get(preview.id), provenance = verifyPlanTaskProvenance({ store: f.store, getLibrary: f.getLibrary, taskId: first.task.id });
  assert.deepEqual(provenance.pins.map(pin => pin.kind), ['learning_plan_task_receipt', 'learning_catchup_plan', 'tutoring_session', 'learning_academic_snapshot']); assert.equal(provenance.receipts.length, 1); assert.equal(provenance.receipts[0].source.plan_id, plan.id); assert.deepEqual(provenance.receipts[0].source.academic_policy, { grading: 'graded', ai_rule: 'scaffolding_only' }); assert.equal(provenance.receipts[0].local_task_differs, false);
  for (const pin of provenance.pins) { const actual = f.store.getWorkspaceRecord(pin.id); assert.equal(actual.revision, pin.revision); assert.equal(sha(actual.data), pin.hash); } assert.equal(JSON.stringify(provenance).includes('PRIVATE_LEARNING_SOURCE'), false); assert.deepEqual(f.service.get(preview.id), before); assert.equal(f.store.listTasks().length, 1);
  f.store.updateTask(first.task.id, { title: 'Manually edited local task' }, first.task.revision); assert.equal(f.service.taskProvenance(first.task.id).receipts[0].local_task_differs, true);
  const manual = f.store.createTask({ title: 'Unrelated manual task', deadline: { precision: 'unknown' } }); assert.deepEqual(f.service.taskProvenance(manual.id), { receipts: [], pins: [] }); f.store.deleteWorkspaceRecord(f.snapshot.id, f.snapshot.revision); assert.throws(() => f.service.taskProvenance(first.task.id), error => ['SCOPE_DENIED', 'REVISION_CONFLICT'].includes(error.code)); assert.deepEqual(f.service.taskProvenance(manual.id), { receipts: [], pins: [] });
  const second = fixture(t), nextPlan = second.plan(), nextPreview = second.preview(nextPlan), original = second.store.createTask.bind(second.store); second.store.createTask = (...args) => { original(...args); throw new Error('Lost completion'); }; assert.throws(() => second.service.accept(nextPreview.id, accept(nextPreview)), /Lost completion/); assert.throws(() => second.service.taskProvenance(second.store.listTasks()[0].id), { code: 'CONSENT_REQUIRED' }); assert.equal(second.store.listTasks().length, 1);
});

test('PTS18: immutable task-create readback binds final receipt IDs/hashes; tampering cannot misassociate source to another task or make original source-free', t => {
  for (const change of ['task-id', 'create-hash']) {
    const f = fixture(t), plan = f.plan(), preview = f.preview(plan), first = f.service.accept(preview.id, accept(preview)), manual = f.store.createTask({ title: 'Independent manual task', deadline: { precision: 'unknown' } }), data = { ...first.receipt.data, ...(change === 'task-id' ? { task_id: manual.id } : { task_create_receipt_hash: 'f'.repeat(64) }) };
    f.store.updateWorkspaceRecord(first.receipt.id, { expected_revision: first.receipt.revision, data }); assert.throws(() => f.service.taskProvenance(first.task.id), { code: 'VERSION_MISMATCH' });
    if (change === 'task-id') assert.throws(() => f.service.taskProvenance(manual.id), { code: 'VERSION_MISMATCH' }); else assert.deepEqual(f.service.taskProvenance(manual.id), { receipts: [], pins: [] });
    assert.equal(f.store.listTasks().length, 2);
  }
});

test('PTR01: route requires paired authority, exact methods/fields and still-current authorization before mutations', async t => {
  const f = fixture(t), plan = f.plan(), args = { route: '/plan-tasks/state', method: 'GET', store: f.store, getLibrary: f.getLibrary, privateBody: async () => ({}) };
  await assert.rejects(handlePlanTaskRoute(args), { code: 'AUTH_REQUIRED' }); assert.equal(await handlePlanTaskRoute({ ...args, route: '/elsewhere' }), null);
  const session = { nonce: 'synthetic-paired-session' }; assert.equal((await handlePlanTaskRoute({ ...args, session })).status, 200); await assert.rejects(handlePlanTaskRoute({ ...args, session, method: 'POST' }), { code: 'INVALID_INPUT' });
  await assert.rejects(handlePlanTaskRoute({ ...args, session, route: '/plan-tasks/previews', method: 'POST', idempotencyKey: 'fixture-revoked-route', privateBody: async () => ({ plan_ref: ref(plan), topic_ids: ['intro'] }), stillAuthorized() { const error = new Error('Revoked session'); error.code = 'AUTH_REQUIRED'; throw error; } }), { code: 'AUTH_REQUIRED' }); assert.equal(f.service.state().previews.length, 0);
  assert.equal(sha(f.store.getWorkspaceRecord(plan.id).data), sha(plan.data));
});

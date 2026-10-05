import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { normalizeAcademicExport } from '../packages/local-academic/src/index.mjs';
import { createStudentWorkspace } from '../apps/local-runtime/src/student-workspace.mjs';
import { createLearningService } from '../apps/local-runtime/src/learning-service.mjs';
import { createPlanTaskService, PLAN_TASK_RECEIPT } from '../apps/local-runtime/src/plan-task-service.mjs';
import { createCalendarExportService } from '../apps/local-runtime/src/calendar-export-service.mjs';
import { createCalendarImportService } from '../apps/local-runtime/src/calendar-import-service.mjs';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';

const start = '2026-10-05T13:00:00.000Z', end = '2026-10-05T16:00:00.000Z';
const planRef = row => ({ id: row.id, revision: row.revision, plan_hash: row.data.plan.plan_hash, catch_up_hash: row.data.catch_up.catch_up_hash });
const handoffPins = row => ({ expected_revision: row.revision, preview_hash: row.data.preview_hash });
const acceptTask = row => ({ ...handoffPins(row), topic_id: 'intro', task_hash: row.rows[0].task_hash, confirmed: true });
const reviewCalendar = row => ({ expected_revision: row.revision, review_hash: row.data.review_hash, confirmed: true });
const studyRequest = row => ({ mode: 'study_plan', plan_id: row.id, expected_revision: row.revision, plan_hash: row.data.plan.plan_hash });
const stale = fn => assert.throws(fn, error => ['REVISION_CONFLICT', 'SCOPE_DENIED', 'CONSENT_REQUIRED', 'VERSION_MISMATCH', 'STALE_EVIDENCE'].includes(error.code));
function exported(body = 'PRIVATE_LEARNING_SOURCE: recursion stops at a base case.', retrieved_at = '2026-10-04T12:00:00.000Z') {
  return normalizeAcademicExport({ schema_version: 1, institution: { name: 'Synthetic School', origin: 'https://school.fixture.test', timezone: 'America/Toronto' }, account_ref: 'fixture-student', retrieved_at,
    courses: [{ source_id: 'A', title: 'Algorithms', code: 'SYN101' }, { source_id: 'B', title: 'Other course' }], assignments: [], announcements: [],
    materials: [{ source_id: 'lesson', course_id: 'A', title: 'Base cases', body }, { source_id: 'other', course_id: 'B', title: 'Other course', body: 'PRIVATE_OTHER_COURSE' }] }, { selectedCourseIds: ['A', 'B'] });
}
function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-calendar-learning-')), root = join(parent, 'workspace'); let store = LocalStore.open({ root, timezone: 'America/Toronto' });
  t.after(() => { try { store.close(); } catch {} rmSync(parent, { recursive: true, force: true }); });
  const workspace = () => createStudentWorkspace(store), learning = () => createLearningService({ store, getLibrary: workspace().library }), handoff = () => createPlanTaskService({ store, getLibrary: workspace().library });
  const calendar = () => createCalendarExportService({ store, studentWorkspace: workspace(), clock: () => '2026-10-04T16:00:00.000Z' });
  const snapshot = store.createWorkspaceRecord({ kind: 'academic_item', title: 'Synthetic selected course source', data: { format: 'academic_snapshot', snapshot: exported() } });
  const scope = { snapshot_ids: [snapshot.id], course_ids: ['A'] }, found = workspace().search({ ...scope, query: 'base case' }).results[0];
  const citation = { source_id: found.source_id, version_hash: found.version_hash, chunk_id: found.chunk_id };
  const session = learning().createSession({ scope, citations: [citation], topic: 'Recursion', mode: 'hint', academic_policy: { grading: 'graded', ai_rule: 'scaffolding_only' } });
  const f = { parent, root, snapshot, session, citation, get store() { return store; }, get workspace() { return workspace(); }, get handoff() { return handoff(); }, get calendar() { return calendar(); },
    plan(effort = 30) { const proposed = learning().previewCatchUp(session.id, { expected_revision: session.revision, session_hash: session.data.recipe.session_hash,
      topics: [{ id: 'intro', title: 'Review base cases', effort_minutes: effort, source_citations: [citation] }], selected_topic_ids: ['intro'],
      exam: { title: 'Synthetic study goal', deadline: { precision: 'date', date: '2026-10-10', original: 'October 10', timezone: 'America/Toronto' } },
      planning_input: { now: start, horizonEnd: end, timezone: 'America/Toronto', availability: [{ start, end }] } });
      return learning().acceptCatchUp(proposed.id, { expected_revision: proposed.revision, plan_hash: proposed.data.plan.plan_hash, catch_up_hash: proposed.data.catch_up.catch_up_hash }); },
    task(effort = 30) { const plan = f.plan(effort), preview = handoff().preview({ plan_ref: planRef(plan), topic_ids: ['intro'] }, { idempotencyKey: 'learning-calendar-handoff' }).preview;
      return { plan, preview, ...handoff().accept(preview.id, acceptTask(preview)) }; },
    exportTask(task, key = 'learning-calendar-export') { return calendar().preview({ mode: 'tasks', task_ids: [task.id] }, { idempotencyKey: key }); },
    restart() { store.close(); store = LocalStore.open({ root, timezone: 'America/Toronto' }); },
    async restore() { const backup = join(parent, 'backup'); await store.backup(backup); store.close(); const restored = join(parent, 'restored'); await LocalStore.restore({ backupRoot: backup, root: restored }); store = LocalStore.open({ root: restored }); } };
  return f;
}

test('CEL01: actual accepted learning task exports exact read-only origin pins, citations and review without source bodies or task mutations', t => {
  const f = fixture(t), accepted = f.task(), before = [f.snapshot, f.session, accepted.plan, accepted.receipt].map(row => f.store.getWorkspaceRecord(row.id)), taskBefore = f.store.getTask(accepted.task.id), preview = f.exportTask(accepted.task);
  const source = preview.data.events[0].provenance.accepted_learning_plan_sources[0];
  assert.equal(source.task_id, accepted.task.id); assert.equal(source.source.plan_id, accepted.plan.id); assert.equal(source.source.session_id, f.session.id); assert.equal(source.source.mastery_claim, false);
  assert.equal(source.review.reviewer, f.store.identity.student_id); assert.deepEqual(source.source_citations, [f.citation]); assert.deepEqual(source.reviewed_task, accepted.receipt.data.task); assert.equal(source.local_task_differs, false);
  assert.deepEqual(preview.data.pins.map(pin => pin.kind), ['task', 'learning_plan_task_receipt', 'learning_catchup_plan', 'tutoring_session', 'learning_academic_snapshot']);
  assert.doesNotMatch(JSON.stringify(preview), /PRIVATE_LEARNING_SOURCE|PRIVATE_OTHER_COURSE/); assert.deepEqual(taskBefore.source_refs, []);
  const downloaded = f.calendar.download(preview.id, reviewCalendar(preview)); assert.equal(downloaded.provider_writes, 0); assert.equal(downloaded.task_writes, 0);
  assert.deepEqual([f.snapshot, f.session, accepted.plan, accepted.receipt].map(row => f.store.getWorkspaceRecord(row.id)), before); assert.deepEqual(f.store.getTask(accepted.task.id), taskBefore);
  const unfolded = downloaded.content.replace(/\r\n /g, ''), encoded = /^X-LEARNBRIDGE-PROVENANCE:(.+)$/m.exec(unfolded)[1].trim();
  assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')).accepted_learning_plan_sources[0], source);
});

for (const mutation of ['snapshot-edit', 'new-source', 'forget-snapshot', 'forget-session', 'forget-plan', 'revoke-plan', 'receipt-tamper']) {
  test(`CEL02/${mutation}: source change blocks prepared download, replay and new preview while retaining the accepted task`, t => {
    const f = fixture(t), accepted = f.task(), preview = f.exportTask(accepted.task), request = reviewCalendar(preview); f.calendar.download(preview.id, request);
    if (mutation === 'snapshot-edit') f.store.updateWorkspaceRecord(f.snapshot.id, { expected_revision: f.snapshot.revision, data: { format: 'academic_snapshot', snapshot: exported('Changed selected lecture') } });
    if (mutation === 'new-source') f.store.createWorkspaceRecord({ kind: 'academic_item', title: 'New selected source', data: { format: 'academic_snapshot', snapshot: exported('New selected lecture', '2026-10-04T13:00:00.000Z') } });
    if (mutation.startsWith('forget-')) { const row = mutation === 'forget-snapshot' ? f.snapshot : mutation === 'forget-session' ? f.session : accepted.plan; f.store.deleteWorkspaceRecord(row.id, row.revision); }
    if (mutation === 'revoke-plan') f.store.updateWorkspaceRecord(accepted.plan.id, { expected_revision: accepted.plan.revision, data: { ...accepted.plan.data, state: 'proposal' } });
    if (mutation === 'receipt-tamper') f.store.updateWorkspaceRecord(accepted.receipt.id, { expected_revision: accepted.receipt.revision, data: { ...accepted.receipt.data, task_create_receipt_hash: 'f'.repeat(64) } });
    assert.equal(f.calendar.getPreview(preview.id).needs_refresh, true); stale(() => f.calendar.download(preview.id, request)); stale(() => f.exportTask(accepted.task)); stale(() => f.exportTask(accepted.task, 'learning-calendar-new-export'));
    assert.deepEqual(f.store.getTask(accepted.task.id), accepted.task); assert.equal(f.store.listTasks().length, 1); assert.equal(f.store.getWorkspaceRecord(preview.id).revision, 2);
    if (mutation === 'revoke-plan') assert.equal(f.store.getWorkspaceRecord(accepted.plan.id).data.state, 'proposal', 'read-only export must not reaccept a revoked learning plan');
  });
}

test('CEL03: exact downloaded source bindings and no-effect replay survive runtime restart and independent backup restore', async t => {
  const f = fixture(t), accepted = f.task(), preview = f.exportTask(accepted.task), result = f.calendar.download(preview.id, reviewCalendar(preview)); f.restart();
  assert.equal(f.calendar.download(preview.id, reviewCalendar(preview)).content, result.content); await f.restore();
  assert.equal(f.calendar.download(preview.id, reviewCalendar(preview)).sha256, result.sha256); assert.equal(f.exportTask(accepted.task).id, preview.id); assert.equal(f.store.listTasks().length, 1); assert.equal(f.store.getWorkspaceRecord(accepted.receipt.id).revision, accepted.receipt.revision);
});

test('CEL04: explicit manual task edits remain usable and labeled while immutable reviewed source/task origin remains exact', t => {
  const f = fixture(t), accepted = f.task(), old = f.exportTask(accepted.task);
  const changed = f.store.updateTask(accepted.task.id, { title: 'Student revised study wording', effort_minutes: 45, deadline: { precision: 'instant', instant: '2026-10-11T14:00:00.000Z', timezone: 'America/Toronto' } }, accepted.task.revision);
  stale(() => f.calendar.download(old.id, reviewCalendar(old))); const current = f.exportTask(changed, 'learning-calendar-manual-edit'), source = current.data.events[0].provenance.accepted_learning_plan_sources[0];
  assert.equal(source.local_task_differs, true); assert.equal(source.reviewed_task.title, 'Review base cases'); assert.equal(source.source.plan_id, accepted.plan.id); assert.deepEqual(source.reviewed_task.deadline, accepted.task.deadline);
  assert.equal(current.data.events[0].title, 'Due: Student revised study wording'); assert.equal(current.data.events[0].start, changed.deadline.instant); assert.equal(f.calendar.download(current.id, reviewCalendar(current)).task_writes, 0);
  assert.deepEqual(f.store.getWorkspaceRecord(accepted.receipt.id), accepted.receipt);
});

test('CEL05: forgetting only a handoff preview preserves independent task provenance; an unrelated manual export ignores unselected stale sources', t => {
  const f = fixture(t), accepted = f.task(); f.handoff.forget(accepted.preview.id, handoffPins(accepted.preview));
  const sourced = f.exportTask(accepted.task); assert.equal(sourced.data.events[0].provenance.accepted_learning_plan_sources.length, 1);
  const manual = f.store.createTask({ title: 'Unrelated manual deadline', deadline: { precision: 'date', date: '2026-10-11' } }); f.store.deleteWorkspaceRecord(f.session.id, f.session.revision);
  stale(() => f.exportTask(accepted.task, 'learning-calendar-forgotten-source')); const unrelated = f.exportTask(manual, 'learning-calendar-manual-only');
  assert.equal(Object.hasOwn(unrelated.data.events[0].provenance, 'accepted_learning_plan_sources'), false); assert.deepEqual(unrelated.data.pins.map(pin => pin.kind), ['task']); assert.equal(f.calendar.download(unrelated.id, reviewCalendar(unrelated)).provider_writes, 0);
});

test('CEL06: an interrupted committed task cannot export before separate exact handoff recovery; export never finalizes its receipt', t => {
  const f = fixture(t), plan = f.plan(), preview = f.handoff.preview({ plan_ref: planRef(plan), topic_ids: ['intro'] }, { idempotencyKey: 'learning-calendar-interrupted' }).preview, request = acceptTask(preview), original = f.store.createTask.bind(f.store);
  f.store.createTask = (...args) => { original(...args); throw new Error('Synthetic lost completion response'); }; assert.throws(() => f.handoff.accept(preview.id, request), /lost completion/);
  const task = f.store.listTasks()[0], receipt = f.store.listWorkspaceRecords({ kind: 'inbox_item' }).find(row => row.data.format === PLAN_TASK_RECEIPT); assert.equal(receipt.data.state, 'accepting');
  assert.throws(() => f.exportTask(task), { code: 'CONSENT_REQUIRED' }); assert.deepEqual(f.store.getWorkspaceRecord(receipt.id), receipt); assert.equal(f.store.listTasks().length, 1); assert.equal(f.calendar.listPreviews().length, 0);
  f.restart(); const recovered = f.handoff.accept(preview.id, request); assert.equal(recovered.task_effects, 0); assert.equal(recovered.task.id, task.id); assert.equal(f.exportTask(recovered.task).data.events[0].provenance.accepted_learning_plan_sources[0].task_id, task.id);
});

test('CEL07: source-backed unscheduled work still pins accepted plan capacity without entering another task event; forgetting source revokes study export', async t => {
  const f = fixture(t), accepted = f.task(null), manual = f.store.createTask({ title: 'Only scheduled manual task', effort_minutes: 30, deadline: { precision: 'instant', instant: '2026-10-06T20:00:00.000Z' } });
  const run = f.workspace.runner.prepare('plan.today', { now: start, horizonEnd: end, timezone: 'America/Toronto', availability: [{ start, end }] }); assert.equal((await f.workspace.runner.execute(run.id)).state, 'completed');
  const proposed = f.workspace.listPlans().find(row => row.data.run_id === run.id), plan = f.workspace.acceptPlan(proposed.id, { expected_revision: proposed.revision, plan_hash: proposed.data.plan.plan_hash });
  const preview = f.calendar.preview(studyRequest(plan), { idempotencyKey: 'learning-calendar-unscheduled' }); assert.equal(preview.data.events.length, 1); assert.equal(preview.data.events[0].task_id, manual.id);
  assert(preview.data.pins.some(pin => pin.kind === 'learning_plan_task_receipt' && pin.id === accepted.receipt.id)); assert.equal(Object.hasOwn(preview.data.events[0].provenance, 'accepted_learning_plan_sources'), false); assert.doesNotMatch(preview.data.content, /Review base cases|PRIVATE_LEARNING_SOURCE/);
  f.store.deleteWorkspaceRecord(f.snapshot.id, f.snapshot.revision); assert.equal(f.calendar.context().plans.find(row => row.id === plan.id).eligible, false); stale(() => f.calendar.download(preview.id, reviewCalendar(preview))); stale(() => f.calendar.preview(studyRequest(plan), { idempotencyKey: 'learning-calendar-stale-unscheduled' }));
  assert.equal(f.exportTask(manual, 'learning-calendar-independent-manual').data.events.length, 1); assert.equal(f.store.listTasks().length, 2);
});

test('CEL08: calendar-aware accepted study export binds both reviewed busy source and learning origin, and separately revokes on lost teaching source', async t => {
  const f = fixture(t), accepted = f.task(), service = createCalendarImportService({ store: f.store, studentWorkspace: f.workspace, clock: () => '2026-10-04T16:00:00.000Z' });
  const file = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synthetic//EN\r\nBEGIN:VEVENT\r\nUID:lecture\r\nDTSTAMP:20261004T160000Z\r\nSUMMARY:Selected lecture\r\nDTSTART:20261005T133000Z\r\nDTEND:20261005T143000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const selected = service.preview({ filename: 'selected.ics', content: file, timezone: 'America/Toronto' }, { idempotencyKey: 'learning-calendar-busy-preview' });
  const source = service.accept(selected.id, { expected_revision: selected.revision, review_hash: selected.data.review_hash, selected_indexes: [0], scope: { start, end }, confirmed: true }, { idempotencyKey: 'learning-calendar-busy-accept' }).source;
  const sourceBefore = f.store.getWorkspaceRecord(source.id);
  const result = await service.plan({ calendar_source: source.source_pin, availability: [{ start, end }], timezone: 'America/Toronto', horizonEnd: end, maxDailyMinutes: 180, bufferMinutes: 10, minBlockMinutes: 25 }, { idempotencyKey: 'learning-calendar-aware-plan' });
  assert.equal(result.run.recipe_id, 'plan.with_calendar'); const plan = f.workspace.acceptPlan(result.plan.id, { expected_revision: result.plan.revision, plan_hash: result.plan.data.plan.plan_hash });
  const preview = f.calendar.preview(studyRequest(plan), { idempotencyKey: 'learning-calendar-aware-export' }); assert(preview.data.pins.some(pin => pin.kind === 'calendar_busy_source')); assert(preview.data.pins.some(pin => pin.kind === 'learning_catchup_plan' && pin.id === accepted.plan.id));
  assert.equal(preview.data.events[0].provenance.calendar_availability.source_pin.id, source.id); assert.equal(preview.data.events[0].provenance.accepted_learning_plan_sources[0].source.plan_id, accepted.plan.id);
  assert.equal(f.calendar.download(preview.id, reviewCalendar(preview)).provider_writes, 0); f.store.deleteWorkspaceRecord(f.session.id, f.session.revision);
  assert.equal(f.calendar.context().plans.find(row => row.id === plan.id).eligible, false); stale(() => f.calendar.download(preview.id, reviewCalendar(preview))); assert.deepEqual(f.store.getWorkspaceRecord(source.id), sourceBefore); assert.deepEqual(f.store.getTask(accepted.task.id), accepted.task);
});

test('CEL09: paired actual HTTP download readback and restart preserve source origin; revoked source returns conflict and keeps exactly one task', async t => {
  const f = fixture(t), accepted = f.task(); f.store.close(); let runtime;
  const unsupported = async () => ({ state: 'unsupported', verification: 'synthetic_calendar_handoff_no_native_parser' }), sourceAdapter = { probeSourceCapability: unsupported, probePdfCapability: unsupported, probeOfficeCapability: unsupported, describeRoot: async () => { throw new Error('No private discovery'); }, inventorySource: async () => { throw new Error('No private inventory'); }, readSelectedEntry: async () => { throw new Error('No private file read'); } };
  t.after(async () => { await runtime?.close(); });
  let credentials;
  async function restart() { await runtime?.close(); runtime = await startRuntime({ dataRoot: f.root, port: 0, sourceAdapter, publicJobFetch: async () => { throw new Error('No provider read'); } }); const response = await fetch(runtime.origin + '/api/local/v1/pair', { method: 'POST', headers: { Origin: runtime.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: runtime.createPairingCode() }) }); assert.equal(response.status, 200); const data = await response.json(); credentials = { Cookie: response.headers.get('set-cookie').split(';')[0], 'X-LearnBridge-Nonce': data.nonce }; }
  async function call(route, body, method = body === undefined ? 'GET' : 'POST', extra = {}) { const response = await fetch(runtime.origin + '/api/local/v1' + route, { method, headers: { Origin: runtime.origin, ...credentials, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, cache: response.headers.get('cache-control'), data: await response.json() }; }
  await restart(); const result = await call('/calendar-export/previews', { mode: 'tasks', task_ids: [accepted.task.id] }, 'POST', { 'Idempotency-Key': 'learning-calendar-http' }); assert.equal(result.status, 201, JSON.stringify(result.data)); assert.equal(result.cache, 'private, no-store'); const preview = result.data.item;
  const downloaded = await call(`/calendar-export/previews/${preview.id}/download`, reviewCalendar(preview)); assert.equal(downloaded.status, 200); assert.equal(downloaded.data.outcome, 'download_payload_prepared'); assert.equal(downloaded.data.item.data.events[0].provenance.accepted_learning_plan_sources[0].source.plan_id, accepted.plan.id);
  await restart(); const replay = await call(`/calendar-export/previews/${preview.id}/download`, reviewCalendar(preview)); assert.equal(replay.status, 200); assert.equal(replay.data.sha256, downloaded.data.sha256); assert.equal((await call('/tasks')).data.items.length, 1);
  assert.equal((await call(`/learning/sessions/${f.session.id}`, { expected_revision: f.session.revision }, 'DELETE')).status, 200);
  assert.equal((await call(`/calendar-export/previews/${preview.id}/download`, reviewCalendar(preview))).status, 409); assert.equal((await call('/calendar-export/previews', { mode: 'tasks', task_ids: [accepted.task.id] }, 'POST', { 'Idempotency-Key': 'learning-calendar-http' })).status, 409);
  const current = await call(`/calendar-export/previews/${preview.id}`); assert.equal(current.data.item.needs_refresh, true); assert.equal(current.data.item.revision, 2); assert.equal((await call('/tasks')).data.items.length, 1); assert.doesNotMatch(JSON.stringify(downloaded.data), /PRIVATE_LEARNING_SOURCE|PRIVATE_OTHER_COURSE/);
});

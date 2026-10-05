import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { createStudentWorkspace } from '../apps/local-runtime/src/student-workspace.mjs';
import { createAcademicTaskService } from '../apps/local-runtime/src/academic-task-service.mjs';
import { createCalendarExportService, CALENDAR_EXPORT_LIMITS } from '../apps/local-runtime/src/calendar-export-service.mjs';
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'learnbridge-calendar-')), root = join(base, 'private'); let store = LocalStore.open({ root, timezone: 'America/Toronto' }), studentWorkspace = createStudentWorkspace(store), now = '2026-10-04T16:00:00.000Z', service = createCalendarExportService({ store, studentWorkspace, clock: () => now });
  t.after(() => { try { store.close(); } catch {} rmSync(base, { recursive: true, force: true }); });
  return { base, root, get store() { return store; }, get service() { return service; }, get studentWorkspace() { return studentWorkspace; }, at(value) { now = value; }, restart() { store.close(); store = LocalStore.open({ root, timezone: 'America/Toronto' }); studentWorkspace = createStudentWorkspace(store); service = createCalendarExportService({ store, studentWorkspace, clock: () => now }); } };
}
const create = (f, title = 'Review recursion', deadline = { precision: 'date', date: '2026-11-01', timezone: 'America/Toronto', original: '2026-11-01' }) => f.store.createTask({ title, deadline });
const preview = (f, tasks, key = 'calendar-preview-1') => f.service.preview({ mode: 'tasks', task_ids: tasks.map(task => task.id) }, { idempotencyKey: key });
const review = row => ({ expected_revision: row.revision, review_hash: row.data.review_hash, confirmed: true });
const code = (fn, value) => assert.throws(fn, { code: value });
async function plan(f, patch = {}) {
  const task = f.store.createTask({ title: 'Exact saved study interval', effort_minutes: 90, deadline: { precision: 'instant', instant: '2026-11-02T00:00:00.000Z', timezone: 'America/Toronto' } });
  const run = f.studentWorkspace.runner.prepare('plan.today', { now: '2026-11-01T04:00:00.000Z', horizonEnd: '2026-11-01T08:00:00.000Z', timezone: 'America/Toronto', availability: [{ start: '2026-11-01T05:30:00.000Z', end: '2026-11-01T07:30:00.000Z' }], ...patch });
  assert.equal((await f.studentWorkspace.runner.execute(run.id)).state, 'completed');
  const saved = f.studentWorkspace.listPlans().find(row => row.data.run_id === run.id), accepted = f.studentWorkspace.acceptPlan(saved.id, { expected_revision: saved.revision, plan_hash: saved.data.plan.plan_hash }); return { task, saved, accepted };
}
const planInput = row => ({ mode: 'study_plan', plan_id: row.id, expected_revision: row.revision, plan_hash: row.data.plan.plan_hash });

test('CE01: exact selected actual tasks produce DATE all-day marker and UTC zero-duration marker; unknowns visible without invented hours', t => {
  const f = fixture(t), date = create(f), instant = create(f, 'DST exact deadline', { precision: 'instant', instant: '2026-11-01T06:30:00.000Z', timezone: 'America/Toronto', original: '2026-11-01T01:30:00-05:00' }), unknown = create(f, 'Uncertain due time', { precision: 'unknown', original: 'next week', reason: 'ambiguous_source' }), sub = create(f, 'Subsecond deadline', { precision: 'instant', instant: '2026-11-01T06:30:00.123Z' });
  create(f, 'UNSELECTED_TASK_CANARY'); const row = preview(f, [date, instant, unknown, sub]); assert.equal(row.data.events.length, 2); assert.deepEqual(row.data.omitted.map(item => item.reason).sort(), ['subsecond_precision_unsupported', 'unknown_deadline']);
  const content = row.data.content; assert.match(content, /DTSTART;VALUE=DATE:20261101\r\nDTEND;VALUE=DATE:20261102/); assert.match(content, /DTSTART:20261101T063000Z/);
  const event = content.split('BEGIN:VEVENT').find(item => item.includes('DTSTART:20261101T063000Z')); assert.doesNotMatch(event, /DTEND/); assert.match(event, /TRANSP:TRANSPARENT/); assert.doesNotMatch(content, /UNSELECTED_TASK_CANARY|BEGIN:VALARM|ATTENDEE|ORGANIZER|METHOD:/);
  assert.equal(row.data.events.find(item => item.task_id === instant.id).provenance.deadline.original, instant.deadline.original); assert.equal(f.store.listTasks().length, 5); assert.equal(f.store.listAgentGrants().length, 0);
});

test('CE02: date-only without a source timezone remains DATE across spring DST and leap-day boundaries', t => {
  const f = fixture(t), spring = create(f, 'Spring date', { precision: 'date', date: '2026-03-08' }), leap = create(f, 'Leap date', { precision: 'date', date: '2028-02-29' });
  const row = preview(f, [spring, leap]); assert.match(row.data.content, /DTSTART;VALUE=DATE:20260308\r\nDTEND;VALUE=DATE:20260309/); assert.match(row.data.content, /DTSTART;VALUE=DATE:20280229\r\nDTEND;VALUE=DATE:20280301/);
  assert.equal(row.data.events.find(item => item.task_id === spring.id).timezone, null); assert.doesNotMatch(row.data.content, /TZID|VTIMEZONE/);
});

test('CE03: exact preview hash/confirmation/revision gates prepare one durable download receipt and survive restart', t => {
  const f = fixture(t), task = create(f), row = preview(f, [task]); assert.equal(row.data.state, 'preview'); assert.equal(row.data.receipt, null);
  code(() => f.service.download(row.id, { ...review(row), confirmed: false }), 'CONSENT_REQUIRED'); code(() => f.service.download(row.id, { ...review(row), review_hash: 'a'.repeat(64) }), 'REVISION_CONFLICT'); code(() => f.service.download(row.id, { ...review(row), expected_revision: 77 }), 'REVISION_CONFLICT');
  const result = f.service.download(row.id, review(row)); assert.equal(result.outcome, 'download_payload_prepared'); assert.equal(result.item.revision, 2); assert.equal(result.sha256, createHash('sha256').update(result.content).digest('hex')); assert.equal(result.task_writes, 0); assert.equal(result.provider_writes, 0);
  assert.equal(f.service.download(row.id, review(row)).item.revision, 2); f.restart(); assert.equal(f.service.download(row.id, review(row)).content, result.content); assert.equal(f.service.listPreviews().length, 1); assert.equal(f.store.listTasks().length, 1);
});

test('CE04: repeat exports use stable UIDs, unchanged file bytes; a task revision changes sequence/content without changing event identity', t => {
  const f = fixture(t), task = create(f), a = preview(f, [task]); f.at('2026-10-04T16:01:00.000Z'); const b = preview(f, [task], 'calendar-repeat-2'); assert.equal(a.data.content, b.data.content); assert.equal(a.data.events[0].uid, b.data.events[0].uid);
  const changed = f.store.updateTask(task.id, { deadline: { precision: 'date', date: '2026-11-03', timezone: 'America/Toronto' } }, task.revision), c = preview(f, [changed], 'calendar-repeat-3'); assert.equal(c.data.events[0].uid, a.data.events[0].uid); assert.equal(c.data.events[0].sequence, 2); assert.notEqual(c.data.sha256, a.data.sha256); code(() => f.service.download(a.id, review(a)), 'REVISION_CONFLICT');
});

test('CE05: source/task edit, completion and deletion invalidate prior exact downloads without restoring tasks', t => {
  for (const kind of ['title', 'completed', 'deleted']) {
    const f = fixture(t), task = create(f), row = preview(f, [task]); f.service.download(row.id, review(row));
    if (kind === 'deleted') f.store.deleteTask(task.id, task.revision); else f.store.updateTask(task.id, kind === 'title' ? { title: 'Student changed it' } : { status: 'completed' }, task.revision);
    assert.equal(f.service.getPreview(row.id).needs_refresh, true); code(() => f.service.download(row.id, review(row)), 'REVISION_CONFLICT'); assert.equal(f.store.listTasks().length, kind === 'deleted' ? 0 : 1);
  }
});

test('CE06: preview expiry and backward clock preserve exact TTL; no expired download retry is grandfathered', t => {
  const f = fixture(t), row = preview(f, [create(f)]); f.at('2026-10-04T15:59:59.000Z'); code(() => f.service.download(row.id, review(row)), 'REVISION_CONFLICT'); f.at(row.data.created_at); f.service.download(row.id, review(row)); f.at(row.data.expires_at); assert.equal(f.service.getPreview(row.id).expired, true); code(() => f.service.download(row.id, review(row)), 'REVISION_CONFLICT');
});

test('CE07: exact selected IDs, mode schemas, getters, holey arrays and idempotency collisions reject before effects', t => {
  const f = fixture(t), task = create(f), getter = { mode: 'tasks' }; Object.defineProperty(getter, 'task_ids', { get() { throw new Error('getter must not run'); }, enumerable: true });
  for (const input of [getter, { mode: 'tasks', task_ids: [] }, { mode: 'tasks', task_ids: [task.id, task.id] }, { mode: 'tasks', task_ids: [, task.id] }, { mode: 'tasks', task_ids: [task.id], send_calendar: true }, { mode: 'provider', task_ids: [task.id] }]) code(() => f.service.preview(input, { idempotencyKey: 'calendar-invalid' }), 'INVALID_INPUT');
  code(() => preview(f, [{ id: randomUUID() }]), 'SCOPE_DENIED'); const row = preview(f, [task]); assert.equal(preview(f, [task]).id, row.id); const other = create(f, 'Other selected'); code(() => preview(f, [other]), 'REVISION_CONFLICT'); assert.equal(f.service.listPreviews().length, 1);
});

test('CE08: no dated active content never produces an empty or invented calendar', t => {
  const f = fixture(t), unknown = create(f, 'No date', { precision: 'unknown' }), completed = f.store.createTask({ title: 'Already done', status: 'completed', deadline: { precision: 'date', date: '2026-11-01' } });
  code(() => preview(f, [unknown, completed]), 'UNSUPPORTED'); assert.equal(f.service.listPreviews().length, 0); const known = create(f); const row = preview(f, [known, completed]); assert.equal(row.data.events.length, 1); assert.equal(row.data.omitted[0].reason, 'task_not_active');
});

test('CE09: escaped text and 75-octet UTF-8 folding cannot inject extra components/properties', t => {
  const f = fixture(t), title = 'Unicode 🍁, semicolon; slash\\ ' + '🍁'.repeat(60), task = create(f, title, { precision: 'date', date: '2026-11-01', original: 'source\r\nEND:VEVENT\r\nBEGIN:VALARM\r\nACTION:EMAIL' });
  const row = preview(f, [task]), lines = row.data.content.split('\r\n'); assert(lines.every(line => Buffer.byteLength(line) <= 75)); assert(!row.data.content.includes('\uFFFD')); assert.equal(lines.filter(line => line === 'BEGIN:VEVENT').length, 1); assert.equal(lines.filter(line => line === 'BEGIN:VALARM').length, 0);
  const unfolded = row.data.content.replace(/\r\n /g, ''); assert.match(unfolded, /SUMMARY:Due: Unicode 🍁\\, semicolon\\; slash\\\\/); assert.match(unfolded, /Original source date: source\\nEND:VEVENT\\nBEGIN:VALARM/);
});

test('CE10: accepted real study-plan export uses exact existing intervals across DST and carries unscheduled capacity warnings', async t => {
  const f = fixture(t), result = await plan(f, { availability: [{ start: '2026-11-01T05:30:00.000Z', end: '2026-11-01T06:30:00.000Z' }] }), row = f.service.preview(planInput(result.accepted), { idempotencyKey: 'calendar-study-1' });
  assert.equal(row.data.events.length, 1); assert.equal(row.data.events[0].kind, 'study_block'); assert.match(row.data.content, /DTSTART:20261101T053000Z\r\nDTEND:20261101T063000Z/); assert.equal(row.data.events[0].timezone, 'America/Toronto'); assert.equal(row.data.warnings.coverage.unscheduled_minutes, 30);
  assert.deepEqual(row.data.events[0].provenance.block, result.accepted.data.plan.blocks[0]); assert.equal(f.store.listTasks().length, 1); assert.equal(f.service.download(row.id, review(row)).provider_writes, 0);
});

test('CE11: unaccepted plan, exact plan revision/hash mismatch and plan acceptance revocation deny export', async t => {
  const f = fixture(t), result = await plan(f); code(() => f.service.preview(planInput(result.saved), { idempotencyKey: 'calendar-unaccepted' }), 'REVISION_CONFLICT');
  code(() => f.service.preview({ ...planInput(result.accepted), plan_hash: 'a'.repeat(64) }, { idempotencyKey: 'calendar-bad-hash' }), 'REVISION_CONFLICT');
  const row = f.service.preview(planInput(result.accepted), { idempotencyKey: 'calendar-plan-revoke' }); f.store.updateWorkspaceRecord(result.accepted.id, { expected_revision: result.accepted.revision, data: { ...result.accepted.data, state: 'proposal' } }); code(() => f.service.download(row.id, review(row)), 'REVISION_CONFLICT');
});

test('CE12: adding or changing even an unscheduled task invalidates saved plan capacity pins', async t => {
  const f = fixture(t), result = await plan(f), row = f.service.preview(planInput(result.accepted), { idempotencyKey: 'calendar-plan-taskset' }); create(f, 'New competing task'); code(() => f.service.download(row.id, review(row)), 'REVISION_CONFLICT'); assert.equal(f.store.listTasks().length, 2);
});

test('CE13: unreviewed unknown-deadline blocks and nonzero subsecond study intervals are not silently reinterpreted', async t => {
  const f = fixture(t); f.store.createTask({ title: 'Unknown deadline study', effort_minutes: 30 }); const result = await plan(f); code(() => f.service.preview(planInput(result.accepted), { idempotencyKey: 'calendar-unknown-plan' }), 'CONSENT_REQUIRED');
  const g = fixture(t), sub = await plan(g, { availability: [{ start: '2026-11-01T05:30:00.123Z', end: '2026-11-01T07:30:00.123Z' }] }); code(() => g.service.preview(planInput(sub.accepted), { idempotencyKey: 'calendar-subsecond-plan' }), 'UNSUPPORTED');
});

function academic(f, minute = 0, due = '2026-11-01') {
  const raw = { schema_version: 1, institution: { name: 'Synthetic University', origin: 'https://synthetic.example.edu', timezone: 'America/Toronto' }, account_ref: 'fixture', retrieved_at: `2026-10-04T10:${String(minute).padStart(2, '0')}:00.000Z`, courses: [{ source_id: 'A', title: 'Synthetic course', code: 'SYN101' }], assignments: [{ source_id: 'a', course_id: 'A', title: 'Selected source exercise', description: 'PRIVATE_ACADEMIC_BODY_CANARY', due }], announcements: [], materials: [] };
  const p = f.studentWorkspace.previewAcademicExport({ export: raw, selected_course_ids: ['A'] }); return f.studentWorkspace.commitAcademicRefresh(p, { review_hash: p.review_hash, expected_head_revision: p.base.revision, idempotency_key: randomUUID() }).snapshot;
}
function acceptedAcademic(f) {
  const saved = academic(f), service = createAcademicTaskService({ store: f.store, studentWorkspace: f.studentWorkspace }), scope = { snapshot_ids: [saved.id], course_ids: ['A'] }, item = service.inspect(scope).items[0], p = service.preview({ ...scope, assignment_ids: [item.source.item_id] }, { idempotencyKey: 'academic-calendar-source' }), proposal = service.savePending(p.id, { expected_revision: p.revision, review_hash: p.data.review_hash }).proposals[0];
  const accepted = service.accept(proposal.id, { expected_revision: proposal.revision, payload_hash: proposal.data.payload_hash, confirmed: true }); return { saved, task: f.store.getTask(accepted.data.task_id) };
}
test('CE14: accepted academic task carries exact source refs/hash but no source body; source-head refresh or forget revokes earlier download', t => {
  for (const change of ['refresh', 'forget']) {
    const f = fixture(t), imported = acceptedAcademic(f), row = preview(f, [imported.task]); const source = row.data.events[0].provenance.accepted_academic_sources[0]; assert.equal(source.source.snapshot_hash, imported.saved.data.snapshot.snapshot_hash); assert.equal(source.source.deadline.precision, 'date'); assert.doesNotMatch(JSON.stringify(row), /PRIVATE_ACADEMIC_BODY_CANARY/);
    if (change === 'refresh') academic(f, 1, '2026-11-03'); else f.studentWorkspace.forgetSnapshot(imported.saved.id, imported.saved.revision, { expected_stream_revision: imported.saved.stream_revision });
    code(() => f.service.download(row.id, review(row)), 'REVISION_CONFLICT'); assert.deepEqual(f.store.getTask(imported.task.id), imported.task);
  }
});

test('CE15: actual SQLite CAS failure leaves no reviewed receipt or false download success', t => {
  const f = fixture(t), row = preview(f, [create(f)]), db = new Database(join(f.root, 'learnbridge.sqlite')); db.exec("CREATE TRIGGER fail_calendar_update BEFORE UPDATE ON workspace_records BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
  code(() => f.service.download(row.id, review(row)), 'PROVIDER_FAILURE'); assert.equal(f.service.getPreview(row.id).revision, 1); assert.equal(f.service.getPreview(row.id).data.receipt, null); db.exec('DROP TRIGGER fail_calendar_update'); db.close(); assert.equal(f.service.download(row.id, review(row)).item.revision, 2);
});

test('CE16: selected task/event/retention bounds reject without private scans or empty effects', t => {
  const f = fixture(t), task = create(f); code(() => f.service.preview({ mode: 'tasks', task_ids: Array.from({ length: 26 }, () => randomUUID()) }, { idempotencyKey: 'calendar-too-many' }), 'INVALID_INPUT');
  for (let i = 0; i < CALENDAR_EXPORT_LIMITS.retained_previews; i++) preview(f, [task], `calendar-retained-${i}`); code(() => preview(f, [task], 'calendar-cap-next'), 'BUDGET_EXCEEDED'); assert.equal(f.service.listPreviews().length, 100);
});

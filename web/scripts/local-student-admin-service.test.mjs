import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { createStudentWorkspace } from '../apps/local-runtime/src/student-workspace.mjs';
import { createAdminDeadlineService } from '../apps/local-runtime/src/admin-deadline-service.mjs';
import { lifeHash } from '../apps/local-runtime/src/life.mjs';

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'learnbridge-student-admin-')), root = join(base, 'private'); let store = LocalStore.open({ root, timezone: 'America/Toronto' }), now = '2026-10-04T16:00:00.000Z', workspace = createStudentWorkspace(store), service = createAdminDeadlineService({ store, studentWorkspace: workspace, clock: () => now });
  t.after(() => { try { store.close(); } catch {} rmSync(base, { recursive: true, force: true }); });
  return { root, get store() { return store; }, get workspace() { return workspace; }, get service() { return service; }, at(value) { now = value; }, restart() { store.close(); store = LocalStore.open({ root, timezone: 'America/Toronto' }); workspace = createStudentWorkspace(store); service = createAdminDeadlineService({ store, studentWorkspace: workspace, clock: () => now }); } };
}
function input(patch = {}) { return { title: 'Synthetic student scholarship', category: 'scholarship', official_url: 'https://university.edu/awards/synthetic?utm_source=fixture', source_text: 'Must be enrolled full time. Provide one recommendation letter. Deadline October 10.', checked_at: '2026-10-04T15:00:00.000Z', timezone: 'America/Toronto', deadline: { precision: 'date', date: '2026-10-10', original: 'Deadline October 10.' },
  requirements: [{ key: 'enrolled', excerpt: 'Must be enrolled full time.', status: 'unknown', review_note: 'Enrollment has not been confirmed.', profile_fact_ids: [] }], checklist: [{ key: 'letter', title: 'Ask for the recommendation letter', done: false }], ...patch }; }
const create = (f, value = input(), key = 'student-admin-record-fixture') => f.service.create(value, { idempotencyKey: key });
const prepare = (f, row, key = 'student-admin-preview-fixture') => f.service.prepare(row.id, { expected_revision: row.revision, item_hash: row.data.item_hash }, { idempotencyKey: key });
const review = row => ({ expected_revision: row.data.receipt?.reviewed_revision ?? row.revision, review_hash: row.data.review_hash, confirmed: true });
const correct = (f, row, definition) => f.service.correct(row.id, { expected_revision: row.revision, item_hash: row.data.item_hash, definition, confirmed: true });
const error = (fn, code) => assert.throws(fn, { code });
function profile(f, field = 'goals', value = 'Manage school funding') { const candidate = f.workspace.createProfile({ field, value }); return f.workspace.reviewProfile(candidate.id, { expected_revision: candidate.revision, decision: 'confirm', fingerprint: f.workspace.listProfiles().find(row => row.id === candidate.id).fingerprint }); }

test('SA01: explicit pasted scholarship preserves unknown eligibility, precise quotation/date/timezone and checklist blockers without fetching or scanning', t => {
  const f = fixture(t), row = create(f), preview = prepare(f, row);
  assert.equal(row.data.provenance, 'student_pasted_unverified'); assert.equal(row.data.definition.official_url, 'https://university.edu/awards/synthetic'); assert.equal(row.eligibility, 'unresolved');
  assert.deepEqual(preview.data.task.deadline, { precision: 'date', date: '2026-10-10', original: 'Deadline October 10.', timezone: 'America/Toronto' }); assert.equal(preview.data.task.title, 'Review requirements: Synthetic student scholarship');
  assert.deepEqual(preview.data.blockers.map(row => row.reason), ['requirement_unresolved', 'checklist_incomplete']); assert.equal(preview.tasks_created, 0); assert.equal(f.store.listTasks().length, 0); assert.equal(f.store.listAgentGrants().length, 0);
  assert.equal(preview.model_calls + preview.provider_reads + preview.external_submissions, 0); assert.equal(f.service.context().profiles.length, 0);
});

test('SA02: every initial category works; manual requirement reviews never declare verified eligibility or complete checklist steps', t => {
  const f = fixture(t); for (const [index, category] of ['school', 'scholarship', 'financial_aid', 'administration'].entries()) {
    const value = input({ category, title: `${category} requirement`, requirements: [{ ...input().requirements[0], status: 'met', review_note: 'I checked my current enrollment statement.' }] }), row = create(f, value, `student-admin-category-${index}`), draft = prepare(f, row, `student-admin-preview-${index}`);
    assert.equal(row.eligibility, 'student_reviewed_requirements_met'); assert.equal(draft.data.task.title, `Prepare: ${category} requirement`); assert.equal(draft.data.blockers[0].reason, 'checklist_incomplete'); assert.equal(f.store.listTasks().length, 0);
  }
  const row = create(f, input({ title: 'Not met', requirements: [{ ...input().requirements[0], status: 'not_met', review_note: 'I am enrolled part time.' }] }), 'student-admin-not-met'); assert.equal(row.eligibility, 'student_reviewed_requirements_not_met'); assert.equal(row.blockers[0].reason, 'student_reports_requirement_not_met');
});

test('SA03: prepare then exact human acceptance creates one real task; duplicate review and restart replay link that same task', t => {
  const f = fixture(t), row = create(f), draft = prepare(f, row); error(() => f.service.accept(draft.id, { ...review(draft), confirmed: false }), 'CONSENT_REQUIRED'); assert.equal(f.store.listTasks().length, 0);
  const accepted = f.service.accept(draft.id, review(draft)), linked = f.service.get(row.id); assert.equal(accepted.data.state, 'accepted'); assert.equal(linked.data.linked_task_id, accepted.data.task_id); assert.equal(f.store.listTasks().length, 1); assert.deepEqual(f.store.listTasks()[0].deadline, draft.data.task.deadline);
  assert.equal(f.service.accept(draft.id, review(draft)).data.task_id, accepted.data.task_id); assert.equal(prepare(f, row).id, draft.id); error(() => prepare(f, linked, 'another-admin-preview-key'), 'REVISION_CONFLICT');
  f.restart(); assert.equal(f.service.accept(draft.id, review(draft)).data.task_id, accepted.data.task_id); assert.equal(f.store.listTasks().length, 1); assert.equal(f.service.get(row.id).accepted_task.changed, false);
});

test('SA04: source corrections invalidate all old preparations; correcting an accepted record leaves the task unchanged and blocks second task', t => {
  const f = fixture(t), row = create(f), old = prepare(f, row), corrected = correct(f, row, input({ source_text: `${input().source_text} New official wording supplied by student.`, checked_at: '2026-10-04T15:30:00.000Z' }));
  assert.equal(f.service.getPreview(old.id).needs_refresh, true); error(() => f.service.accept(old.id, review(old)), 'REVISION_CONFLICT'); assert.equal(f.store.listTasks().length, 0);
  const next = prepare(f, corrected, 'student-admin-new-source-preview'), accepted = f.service.accept(next.id, review(next)), task = f.store.getTask(accepted.data.task_id), latest = f.service.get(row.id);
  const changed = correct(f, latest, { ...latest.data.definition, deadline: { precision: 'date', date: '2026-10-12', original: 'Student checked corrected due date.' } }); assert.equal(changed.source_changed_since_acceptance, true); assert.deepEqual(f.store.getTask(task.id), task); error(() => prepare(f, changed, 'student-admin-third-preview'), 'REVISION_CONFLICT');
});

test('SA05: only explicitly selected current confirmed general facts enter pins; career-only eligibility is denied and missing facts remain unknown', t => {
  const f = fixture(t), fact = profile(f), other = profile(f, 'eligibility', 'CAREER_ONLY_PRIVATE_CANARY'); assert.doesNotMatch(JSON.stringify(f.service.context()), /CAREER_ONLY_PRIVATE_CANARY/);
  const value = input({ requirements: [{ ...input().requirements[0], profile_fact_ids: [fact.id] }] }), row = create(f, value), draft = prepare(f, row); assert.deepEqual(draft.data.profile_pins.map(pin => pin.id), [fact.id]); assert.equal(draft.data.eligibility, 'unresolved'); assert.equal(draft.data.profile_pins[0].fact.value, fact.data.value);
  error(() => create(f, input({ requirements: [{ ...value.requirements[0], profile_fact_ids: [other.id] }] }), 'student-admin-forbidden-profile'), 'SCOPE_DENIED');
  const candidate = f.workspace.createProfile({ field: 'availability', value: 'Weekends' }); error(() => create(f, input({ requirements: [{ ...value.requirements[0], profile_fact_ids: [candidate.id] }] }), 'student-admin-unconfirmed-profile'), 'SCOPE_DENIED');
});

test('SA06: corrected/forgotten/conflicting/expired profile evidence invalidates saved preview until separately corrected and reviewed', t => {
  for (const reason of ['correct', 'forget', 'conflict', 'expire']) {
    const f = fixture(t); let fact = reason === 'expire' ? f.workspace.createProfile({ field: 'goals', value: 'Review funding', expires_at: '2099-01-01T00:00:00.000Z' }) : profile(f);
    if (reason === 'expire') fact = f.workspace.reviewProfile(fact.id, { expected_revision: fact.revision, decision: 'confirm', fingerprint: f.workspace.listProfiles().find(row => row.id === fact.id).fingerprint });
    const row = create(f, input({ requirements: [{ ...input().requirements[0], profile_fact_ids: [fact.id] }] })), draft = prepare(f, row);
    if (reason === 'correct') f.workspace.reviewProfile(fact.id, { expected_revision: fact.revision, decision: 'correct', fingerprint: f.workspace.listProfiles().find(row => row.id === fact.id).fingerprint, value: 'New reviewed goal' });
    if (reason === 'forget') f.workspace.forgetProfile(fact.id, fact.revision); if (reason === 'conflict') profile(f, 'goals', 'Different goal'); if (reason === 'expire') f.at('2100-01-01T00:00:00.000Z');
    assert.equal(f.service.get(row.id).profile_stale, true); assert.equal(f.service.getPreview(draft.id).needs_refresh, true); error(() => f.service.accept(draft.id, review(draft)), reason === 'expire' ? 'CONSENT_REQUIRED' : 'REVISION_CONFLICT'); assert.equal(f.store.listTasks().length, 0);
  }
});

test('SA07: unknown/declarative deadline never becomes a fabricated instant; exact UTC and DST-associated zone remain as supplied', t => {
  const f = fixture(t), unknown = create(f, input({ deadline: { precision: 'unknown', original: 'Later this term', reason: 'No exact date provided' } })), draft = prepare(f, unknown);
  assert.equal(draft.data.task.deadline.precision, 'unknown'); assert.equal(draft.data.blockers.some(row => row.reason === 'deadline_unconfirmed'), true); const accepted = f.service.accept(draft.id, review(draft)); assert.deepEqual(f.store.getTask(accepted.data.task_id).deadline, draft.data.task.deadline);
  const exact = create(f, input({ title: 'DST exact deadline', deadline: { precision: 'instant', instant: '2026-11-01T06:30:00.000Z', original: 'Second 1:30 AM on November 1, eastern time' } }), 'student-admin-dst-record'), next = prepare(f, exact, 'student-admin-dst-preview'); assert.equal(next.data.task.deadline.instant, '2026-11-01T06:30:00.000Z'); assert.equal(next.data.task.deadline.timezone, 'America/Toronto');
});

test('SA08: malformed or secret-bearing URLs, deadlines, quotations, duplicate keys, profile counts and malicious accessors are denied before storing', t => {
  const f = fixture(t), invalid = [input({ official_url: 'http://university.edu/award' }), input({ official_url: 'https://user:password@university.edu/award' }), input({ official_url: 'https://university.edu/award?access_token=PRIVATE_SECRET_CANARY' }), input({ official_url: 'https://localhost/award' }), input({ deadline: { precision: 'date', date: '2026-02-30' } }), input({ deadline: { precision: 'instant', instant: '2026-11-01T01:30:00' } }), input({ deadline: { precision: 'unknown', timezone: 'America/Toronto' } }), input({ timezone: 'Invalid/Time' }), input({ checked_at: '2027-01-01T00:00:00.000Z' }), input({ requirements: [{ ...input().requirements[0], excerpt: 'Not in chosen source' }] }), input({ requirements: [] }), input({ checklist: [{ key: 'a', title: 'One', done: false }, { key: 'a', title: 'Two', done: false }] }), input({ category: 'bank_transfer' })];
  for (const [index, value] of invalid.entries()) assert.throws(() => create(f, value, `student-admin-invalid-${index}`));
  let accessed = false; const getter = input(); Object.defineProperty(getter, 'source_text', { enumerable: true, get() { accessed = true; return input().source_text; } }); error(() => create(f, getter), 'INVALID_INPUT'); assert.equal(accessed, false);
  const nested = input(); Object.defineProperty(nested.requirements[0], 'status', { enumerable: true, get() { accessed = true; return 'met'; } }); error(() => create(f, nested), 'INVALID_INPUT'); assert.equal(accessed, false); assert.equal(f.service.list().length, 0); assert.equal(f.store.listTasks().length, 0);
});

test('SA09: changed task-set match, stale revisions, wrong hashes and expired reviews cannot create or edit tasks', t => {
  const f = fixture(t), row = create(f), draft = prepare(f, row); error(() => f.service.accept(draft.id, { ...review(draft), review_hash: '0'.repeat(64) }), 'REVISION_CONFLICT'); error(() => f.service.accept(draft.id, { ...review(draft), expected_revision: 99 }), 'REVISION_CONFLICT');
  const task = f.store.createTask({ title: draft.data.task.title, deadline: draft.data.task.deadline }); error(() => f.service.accept(draft.id, review(draft)), 'REVISION_CONFLICT'); assert.deepEqual(f.store.getTask(task.id), task);
  f.store.deleteTask(task.id, task.revision); f.at('2026-10-04T16:10:00.000Z'); error(() => f.service.accept(draft.id, review(draft)), 'CONSENT_REQUIRED'); assert.equal(f.store.listTasks().length, 0);
});

test('SA10: SQL failure atomically rolls back both review journal and reservation, leaving zero accepted task or lock', t => {
  const f = fixture(t), row = create(f), draft = prepare(f, row), db = new Database(join(f.root, 'learnbridge.sqlite'));
  db.exec(`CREATE TRIGGER fail_admin_reservation BEFORE UPDATE ON workspace_records WHEN NEW.id='${row.id}' BEGIN SELECT RAISE(ABORT,'fixture reservation failure'); END;`);
  assert.throws(() => f.service.accept(draft.id, review(draft))); assert.equal(f.service.getPreview(draft.id).data.state, 'prepared'); assert.equal(f.service.get(row.id).data.acceptance_preview_id, null); assert.equal(f.store.listTasks().length, 0); db.exec('DROP TRIGGER fail_admin_reservation'); db.close(); assert.equal(f.service.accept(draft.id, review(draft)).data.state, 'accepted');
});

test('SA11: crash before task create preserves a reserved journal; restart replay creates exactly one task and blocks another pending preview', t => {
  const f = fixture(t), row = create(f), draft = prepare(f, row), second = prepare(f, row, 'student-admin-second-preview'), original = f.store.createTask.bind(f.store); f.store.createTask = () => { throw new Error('Synthetic crash before create'); };
  assert.throws(() => f.service.accept(draft.id, review(draft))); assert.equal(f.service.getPreview(draft.id).data.state, 'accepting'); assert.equal(f.store.listTasks().length, 0); error(() => f.service.accept(second.id, review(second)), 'REVISION_CONFLICT'); error(() => correct(f, f.service.get(row.id), input()), 'CONSENT_REQUIRED'); f.store.createTask = original;
  f.restart(); const accepted = f.service.accept(draft.id, review(draft)); assert.equal(accepted.data.state, 'accepted'); assert.equal(f.store.listTasks().length, 1); assert.equal(f.service.accept(draft.id, review(draft)).data.task_id, accepted.data.task_id);
});

test('SA12: crash after durable task create recovers exact receipt; edited/deleted tasks remain changed/unavailable and are never overwritten/recreated', t => {
  for (const change of ['edit', 'delete']) { const f = fixture(t), row = create(f), draft = prepare(f, row), commit = f.store.commitWorkspaceBatch.bind(f.store);
    f.store.commitWorkspaceBatch = batch => { if (batch.updates.some(update => update.id === draft.id && update.data.state === 'accepted')) throw new Error('Synthetic crash after task create'); return commit(batch); };
    assert.throws(() => f.service.accept(draft.id, review(draft))); const task = f.store.listTasks()[0]; assert(task); if (change === 'edit') f.store.updateTask(task.id, { title: 'Student changed task', status: 'completed' }, task.revision); else f.store.deleteTask(task.id, task.revision);
    error(() => f.service.cancel(draft.id, review(f.service.getPreview(draft.id))), 'CONSENT_REQUIRED'); f.store.commitWorkspaceBatch = commit; f.restart(); const result = f.service.accept(draft.id, review(draft));
    assert.equal(result.data.task_id, task.id); if (change === 'edit') { assert.equal(result.accepted_task.changed, true); assert.equal(f.store.getTask(task.id).title, 'Student changed task'); assert.equal(f.store.getTask(task.id).status, 'completed'); } else { assert.equal(result.accepted_task.unavailable, true); assert.equal(f.store.getTask(task.id), null); assert.equal(f.store.listTasks().length, 0); }
  }
});

test('SA13: reserved no-task journal cancellation releases the item for new source review; exact cancellation replay is durable', t => {
  const f = fixture(t), row = create(f), draft = prepare(f, row), original = f.store.createTask.bind(f.store); f.store.createTask = () => { throw new Error('Synthetic paused create'); }; assert.throws(() => f.service.accept(draft.id, review(draft))); f.store.createTask = original;
  const pending = f.service.getPreview(draft.id), cancelled = f.service.cancel(draft.id, review(pending)); assert.equal(cancelled.data.state, 'cancelled'); assert.equal(f.service.get(row.id).data.acceptance_preview_id, null); assert.equal(f.store.listTasks().length, 0); f.restart(); assert.equal(f.service.cancel(draft.id, review(pending)).data.state, 'cancelled'); error(() => f.service.accept(draft.id, review(draft)), 'REVISION_CONFLICT');
  const updated = correct(f, f.service.get(row.id), input({ title: 'Corrected after cancellation' })); assert.equal(prepare(f, updated, 'student-admin-after-cancel').data.state, 'prepared');
});

test('SA14: exact create/prepare retry keys reject changed payloads and preserve current corrected record rather than resurrect its initial version', t => {
  const f = fixture(t), row = create(f); assert.equal(create(f).id, row.id); error(() => create(f, input({ title: 'Different record' })), 'REVISION_CONFLICT'); const draft = prepare(f, row); assert.equal(prepare(f, row).id, draft.id);
  const corrected = correct(f, row, input({ title: 'Corrected title' })); assert.equal(create(f).data.definition.title, corrected.data.definition.title); error(() => prepare(f, corrected), 'REVISION_CONFLICT'); assert.equal(f.store.listTasks().length, 0);
});

test('SA15: captured task payload tampering cannot turn reviewed quotations into an arbitrary accepted task, even with a recomputed outer hash', t => {
  const f = fixture(t), row = create(f), draft = prepare(f, row), data = { ...draft.data, task: { ...draft.data.task, title: 'UNREVIEWED_TASK_CANARY' } };
  data.review_hash = lifeHash({ item_pin: data.item_pin, definition: data.definition, source_hash: data.source_hash, profile_pins: data.profile_pins, task: data.task, blockers: data.blockers, eligibility: data.eligibility, matches: data.matches, created_at: data.created_at, expires_at: data.expires_at });
  f.store.updateWorkspaceRecord(draft.id, { expected_revision: draft.revision, data }); error(() => f.service.getPreview(draft.id), 'VERSION_MISMATCH'); error(() => f.service.accept(draft.id, { expected_revision: 2, review_hash: data.review_hash, confirmed: true }), 'VERSION_MISMATCH'); assert.equal(f.store.listTasks().length, 0);
});

test('SA16: bounded retention keeps exact replays available and refuses further drafts without silently removing history', t => {
  const f = fixture(t), row = create(f), draft = prepare(f, row);
  for (let index = 1; index < 200; index++) f.store.createWorkspaceRecord({ kind: row.kind, title: row.title, data: { ...row.data, operation: { ...row.data.operation, key: `student-admin-cap-record-${index}` } } });
  assert.equal(create(f).id, row.id); error(() => create(f, input({ title: 'Over cap' }), 'student-admin-over-cap'), 'BUDGET_EXCEEDED'); assert.equal(f.service.list().length, 200);
  for (let index = 1; index < 300; index++) f.store.createWorkspaceRecord({ kind: draft.kind, title: draft.title, data: { ...draft.data, operation: { ...draft.data.operation, key: `student-admin-cap-preview-${index}` } } });
  assert.equal(prepare(f, row).id, draft.id); error(() => prepare(f, row, 'student-admin-over-preview-cap'), 'BUDGET_EXCEEDED'); assert.equal(f.service.listPreviews().length, 300); assert.equal(f.store.listTasks().length, 0);
});

test('SA17: excessively many matching tasks and large Unicode evidence fail before a preview or task is created; no provider/model network call occurs', t => {
  const f = fixture(t), original = globalThis.fetch; let calls = 0; globalThis.fetch = () => { calls++; throw new Error('Unexpected external fetch'); }; t.after(() => { globalThis.fetch = original; });
  const row = create(f), taskTitle = `Review requirements: ${row.title}`; for (let index = 0; index < 51; index++) f.store.createTask({ title: taskTitle }); error(() => prepare(f, row), 'BUDGET_EXCEEDED'); assert.equal(f.service.listPreviews().length, 0);
  const source_text = '漢'.repeat(11990), requirements = Array.from({ length: 20 }, (_, index) => ({ key: `large_${index}`, excerpt: '漢'.repeat(990), status: 'unknown', review_note: '漢'.repeat(990), profile_fact_ids: [] }));
  error(() => create(f, input({ title: 'Large bounded fixture', source_text, requirements }), 'student-admin-large-unicode'), 'BUDGET_EXCEEDED'); assert.equal(f.service.list().length, 1); assert.equal(calls, 0);
});

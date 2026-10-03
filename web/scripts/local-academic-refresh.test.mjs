import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { LocalStore, STORAGE_SCHEMA_VERSION } from '../packages/local-storage/src/index.mjs';
import { normalizeAcademicExport } from '../packages/local-academic/src/index.mjs';
import { createStudentWorkspace } from '../apps/local-runtime/src/student-workspace.mjs';

const code = (fn, value) => assert.throws(fn, error => error.code === value);
const timestamp = number => `2026-10-03T10:${String(number).padStart(2, '0')}:00.000Z`;
const storageURL = new URL('../packages/local-storage/src/index.mjs', import.meta.url).href;
const serviceURL = new URL('../apps/local-runtime/src/student-workspace.mjs', import.meta.url).href;
function exported(minute = 0, extra = {}) {
  return { schema_version: 1, institution: { name: 'Synthetic University', origin: 'https://synthetic.example.edu', timezone: 'America/Toronto' },
    account_ref: 'synthetic-student', retrieved_at: timestamp(minute),
    courses: [{ source_id: 'A', title: 'Synthetic algorithms', code: 'SYN101' }, { source_id: 'B', title: 'Unselected synthetic course' }],
    assignments: [{ source_id: 'assignment-1', course_id: 'A', title: 'Recursion practice', description: 'PRIVATE_REFRESH_BODY_CANARY: reason about a base case. 🧠', due: '2026-10-10' }],
    announcements: [], materials: [{ source_id: 'lecture-1', course_id: 'A', title: 'Lecture note', body: 'A base case terminates recursion.' }],
    coverage: Object.fromEntries(['courses', 'assignments', 'announcements', 'materials'].map(category => [category, { state: 'complete' }])), ...extra };
}
function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-academic-refresh-')); const root = join(parent, 'workspace'); let store = LocalStore.open({ root });
  t.after(() => { store.close(); rmSync(parent, { recursive: true, force: true }); });
  return { parent, root, get store() { return store; }, get service() { return createStudentWorkspace(store); },
    restart() { store.close(); store = LocalStore.open({ root }); } };
}
function preview(f, raw = exported(), courses = ['A']) { return f.service.previewAcademicExport({ export: raw, selected_course_ids: courses }); }
function accept(f, value, key = randomUUID()) { return f.service.commitAcademicRefresh(value, { review_hash: value.review_hash, expected_head_revision: value.base.revision, idempotency_key: key }); }
function rowCounts(root) {
  const db = new Database(join(root, 'learnbridge.sqlite'), { readonly: true });
  try { return { records: db.prepare('SELECT count(*) AS n FROM workspace_records').get().n,
    revisions: db.prepare('SELECT count(*) AS n FROM workspace_revisions').get().n,
    orphans: db.prepare('SELECT count(*) AS n FROM workspace_revisions h LEFT JOIN workspace_records r ON r.id=h.record_id WHERE r.id IS NULL').get().n }; }
  finally { db.close(); }
}

test('same semantic export keeps one current snapshot; exact accepted retry has one receipt and no task/note effects', t => {
  const f = fixture(t); const task = f.store.createTask({ title: 'Student-owned task' }); const note = f.store.createDocument({ title: 'Student-owned note', text: 'Leave this note unchanged.' });
  const firstPreview = preview(f); const key = randomUUID(); const first = accept(f, firstPreview, key);
  assert.equal(first.status, 'imported'); assert.equal(first.receipt.verification, 'atomic_private_snapshot_head_readback');
  assert.equal(accept(f, firstPreview, key).status, 'replayed'); assert.equal(f.service.listAcademicStreams()[0].observation_count, 1);
  const same = accept(f, preview(f)); assert.equal(same.status, 'unchanged'); assert.equal(same.snapshot.id, first.snapshot.id);
  const later = accept(f, preview(f, exported(1))); assert.equal(later.status, 'unchanged'); assert.equal(later.snapshot.id, first.snapshot.id);
  assert.equal(later.snapshot.data.snapshot.retrieved_at, timestamp(0)); assert.equal(later.stream.last_observation.reported_retrieved_at, timestamp(1));
  assert.equal(later.stream.snapshot_count, 1); assert.equal(later.stream.observation_count, 3); assert.equal(f.service.listSnapshots().length, 1);
  assert.deepEqual(f.store.getTask(task.id), task); assert.deepEqual(f.store.getDocument(note.document.id), note); assert.equal(f.store.listAgentGrants().length, 0);
  assert.deepEqual(rowCounts(f.root), { records: 2, revisions: 4, orphans: 0 });
});

test('changed deadline and then missing source create reviewed history without resurrecting old current facts or editing tasks', t => {
  const f = fixture(t); const task = f.store.createTask({ title: 'Manual deadline override', deadline: { precision: 'date', date: '2026-10-20', timezone: 'America/Toronto' } });
  const first = accept(f, preview(f)); const nextRaw = exported(1); nextRaw.assignments[0].due = '2026-10-12';
  const changed = preview(f, nextRaw); assert.equal(changed.changes.changed.length, 1); assert.equal(changed.changes.not_returned.length, 0);
  const second = accept(f, changed); assert.notEqual(second.snapshot.id, first.snapshot.id);
  const missing = preview(f, exported(2, { assignments: [], coverage: { ...exported().coverage, assignments: { state: 'unavailable' } }, errors: [{ category: 'assignments', code: 'PROVIDER_FAILURE' }] }));
  assert.equal(missing.changes.not_returned.length, 1); assert.equal(missing.changes.not_returned[0].reason, 'not_seen_in_this_export');
  const third = accept(f, missing); assert.equal(third.stream.snapshot_count, 3);
  assert.deepEqual(f.service.listSnapshots().map(record => record.id), [third.snapshot.id]);
  code(() => f.service.search({ snapshot_ids: [first.snapshot.id, third.snapshot.id], course_ids: ['A'], query: 'PRIVATE_REFRESH' }), 'SCOPE_DENIED');
  assert.equal(f.service.search({ snapshot_ids: [third.snapshot.id], course_ids: ['A'], query: 'PRIVATE_REFRESH' }).results.length, 0);
  const history = f.service.academicStreamHistory(third.stream.id); assert.equal(history.items.length, 3); assert.equal(JSON.stringify(history).includes('PRIVATE_REFRESH_BODY_CANARY'), false);
  assert.equal(history.items.filter(item => item.status === 'historical').length, 2); const retained = f.service.academicHistorySnapshot(third.stream.id, first.snapshot.id);
  assert.equal(retained.item.status, 'historical'); assert.match(retained.item.snapshot.assignments[0].description, /PRIVATE_REFRESH_BODY_CANARY/);
  assert.deepEqual(f.store.getTask(task.id), task);
});

test('simultaneous new heads and competing changed previews fail their stale CAS without retaining a candidate row', t => {
  const f = fixture(t); const a = preview(f); const b = preview(f, exported(1)); accept(f, a); const before = rowCounts(f.root);
  code(() => accept(f, b), 'REVISION_CONFLICT'); assert.deepEqual(rowCounts(f.root), before);
  const rawA = exported(2); rawA.assignments[0].due = '2026-10-11'; const rawB = exported(3); rawB.assignments[0].due = '2026-10-13';
  const one = preview(f, rawA); const two = preview(f, rawB); const accepted = accept(f, one); const after = rowCounts(f.root);
  code(() => accept(f, two), 'REVISION_CONFLICT'); assert.deepEqual(rowCounts(f.root), after);
  assert.equal(f.service.listSnapshots()[0].id, accepted.snapshot.id); assert.equal(f.service.listAcademicStreams().length, 1);
});

test('review hash, base, diff, receipt key and hostile object tampering are rejected before writes', t => {
  const f = fixture(t); const original = preview(f); const key = randomUUID();
  code(() => f.service.commitAcademicRefresh(original, { review_hash: 'a'.repeat(64), expected_head_revision: 0, idempotency_key: key }), 'REVISION_CONFLICT');
  code(() => accept(f, { ...original, base: { ...original.base, revision: 1 } }), 'INVALID_INPUT');
  code(() => accept(f, { ...original, changes: { ...original.changes, added: [] } }), 'INVALID_INPUT');
  let reads = 0; const hostile = { ...original }; Object.defineProperty(hostile, 'snapshot', { enumerable: true, get() { reads++; return original.snapshot; } });
  code(() => accept(f, hostile), 'INVALID_INPUT'); assert.equal(reads, 0); assert.deepEqual(rowCounts(f.root), { records: 0, revisions: 0, orphans: 0 });
  accept(f, original, key); code(() => accept(f, preview(f, exported(1)), key), 'REVISION_CONFLICT'); assert.equal(f.service.listAcademicStreams()[0].observation_count, 1);
});

test('latest accepted report time stays monotone after dedup; ambiguous equal-time content is rejected while exact retry remains valid', t => {
  const f = fixture(t); const original = preview(f); const key = randomUUID(); const first = accept(f, original, key); accept(f, preview(f, exported(5)));
  assert.equal(f.service.listSnapshots()[0].data.snapshot.retrieved_at, timestamp(0));
  code(() => preview(f, exported(2)), 'INVALID_INPUT'); const changed = exported(5); changed.assignments[0].due = '2026-10-14'; code(() => preview(f, changed), 'INVALID_INPUT');
  assert.equal(accept(f, original, key).snapshot.id, first.snapshot.id); assert.equal(f.service.listAcademicStreams()[0].last_observation.reported_retrieved_at, timestamp(5));
});

test('account and exact course-set identities remain independent and never generate cross-scope missing changes', t => {
  const f = fixture(t); const first = accept(f, preview(f)); const other = accept(f, preview(f, exported(1, { account_ref: 'another-synthetic-student' })));
  assert.notEqual(other.stream.id, first.stream.id); assert.notEqual(other.snapshot.data.snapshot.assignments[0].id, first.snapshot.data.snapshot.assignments[0].id);
  const broad = preview(f, exported(2), ['A', 'B']); assert.equal(broad.base.head_id, null); assert.equal(broad.changes.not_returned.length, 0); accept(f, broad);
  assert.equal(f.service.listAcademicStreams().length, 3); assert.equal(f.service.listSnapshots().length, 3);
});

test('forget requires both revisions and hides current plus historical retrieval; explicit reviewed reimport can reactivate', t => {
  const f = fixture(t); const first = accept(f, preview(f)); const raw = exported(1); raw.assignments[0].due = '2026-10-12'; const second = accept(f, preview(f, raw));
  code(() => f.service.forgetSnapshot(second.snapshot.id, 1), 'REVISION_CONFLICT');
  code(() => f.service.forgetSnapshot(second.snapshot.id, 1, { expected_stream_revision: 1 }), 'REVISION_CONFLICT');
  f.service.forgetSnapshot(second.snapshot.id, 1, { expected_stream_revision: second.stream.revision });
  assert.equal(f.service.listSnapshots().length, 0); assert.equal(f.service.listAcademicStreams().length, 0);
  code(() => f.service.academicStreamHistory(second.stream.id), 'CONSENT_REQUIRED');
  code(() => f.service.academicHistorySnapshot(second.stream.id, first.snapshot.id), 'CONSENT_REQUIRED');
  code(() => f.service.search({ snapshot_ids: [second.snapshot.id], course_ids: ['A'], query: 'base case' }), 'SCOPE_DENIED');
  raw.retrieved_at = timestamp(2); const reactivated = accept(f, preview(f, raw)); assert.equal(reactivated.status, 'unchanged');
  assert.equal(reactivated.snapshot.id, second.snapshot.id); assert.equal(reactivated.stream.snapshot_count, 2); assert.equal(f.service.listSnapshots().length, 1);
});

test('restart and real backup/restore retain exact receipts and bounded separately selected history', async t => {
  const f = fixture(t); const original = preview(f); const key = randomUUID(); const first = accept(f, original, key); const raw = exported(1); raw.assignments[0].due = '2026-10-15'; const second = accept(f, preview(f, raw));
  const expected = f.service.academicStreamHistory(second.stream.id); f.restart(); assert.deepEqual(f.service.academicStreamHistory(second.stream.id), expected);
  assert.equal(accept(f, original, key).status, 'replayed'); const backup = join(f.parent, 'backup'); await f.store.backup(backup); const restored = join(f.parent, 'restored'); await LocalStore.restore({ backupRoot: backup, root: restored });
  const copy = LocalStore.open({ root: restored }); try {
    const service = createStudentWorkspace(copy); assert.deepEqual(service.academicStreamHistory(second.stream.id), expected);
    assert.deepEqual(service.academicHistorySnapshot(second.stream.id, first.snapshot.id).item.snapshot, first.snapshot.data.snapshot);
    assert.equal(copy.integrity().schema_version, STORAGE_SCHEMA_VERSION); assert.equal(service.listSnapshots()[0].id, second.snapshot.id);
  } finally { copy.close(); }
});

test('legacy adoption uses unique newest exact-scope authority, preserves all evidence and rejects equal-time disagreement', t => {
  const f = fixture(t); const older = f.store.createWorkspaceRecord({ kind: 'academic_item', title: 'Legacy old', data: { format: 'academic_snapshot', snapshot: normalizeAcademicExport(exported(), { selectedCourseIds: ['A'] }) } });
  const raw = exported(1); raw.assignments[0].due = '2026-10-11'; const newer = f.store.createWorkspaceRecord({ kind: 'academic_item', title: 'Legacy new', data: { format: 'academic_snapshot', snapshot: normalizeAcademicExport(raw, { selectedCourseIds: ['A'] }) } });
  assert.deepEqual(f.service.listSnapshots().map(item => item.id), [newer.id]); const value = preview(f, exported(2)); assert.equal(value.base.head_id, null); assert.equal(value.base.current_snapshot_id, newer.id);
  const adopted = accept(f, value); assert.equal(adopted.stream.snapshot_count, 3); assert.deepEqual(f.service.listSnapshots().map(item => item.id), [adopted.snapshot.id]);
  assert.equal(f.service.academicHistorySnapshot(adopted.stream.id, older.id).item.status, 'historical'); code(() => f.service.library({ snapshot_ids: [newer.id], course_ids: ['A'] }), 'SCOPE_DENIED');
  const conflictRaw = exported(3, { account_ref: 'ambiguous-student' }); const conflictA = normalizeAcademicExport(conflictRaw, { selectedCourseIds: ['A'] }); conflictRaw.assignments[0].due = '2026-10-16'; const conflictB = normalizeAcademicExport(conflictRaw, { selectedCourseIds: ['A'] });
  for (const snapshot of [conflictA, conflictB]) f.store.createWorkspaceRecord({ kind: 'academic_item', title: 'Ambiguous legacy', data: { format: 'academic_snapshot', snapshot } });
  const before = rowCounts(f.root); code(() => preview(f, exported(4, { account_ref: 'ambiguous-student' })), 'INVALID_INPUT'); assert.deepEqual(rowCounts(f.root), before);
});

test('trusted workspace batch denies unknown fields, oversized batches, duplicate IDs, accessors and stale updates without a write', t => {
  const f = fixture(t); const record = f.store.createWorkspaceRecord({ kind: 'plan', title: 'Existing', data: {} }); const before = rowCounts(f.root);
  const item = () => ({ id: randomUUID(), kind: 'academic_item', title: 'Synthetic', data: {} });
  code(() => f.store.commitWorkspaceBatch({ creates: Array.from({ length: 5 }, item), updates: [] }), 'INVALID_INPUT');
  code(() => f.store.commitWorkspaceBatch({ creates: [{ ...item(), student_id: randomUUID() }], updates: [] }), 'INVALID_INPUT');
  const duplicate = item(); code(() => f.store.commitWorkspaceBatch({ creates: [duplicate, duplicate], updates: [] }), 'INVALID_INPUT');
  code(() => f.store.commitWorkspaceBatch({ creates: [item()], updates: [{ id: record.id, expected_revision: 2, data: {} }] }), 'REVISION_CONFLICT');
  let calls = 0; const hostile = item(); Object.defineProperty(hostile, 'data', { enumerable: true, get() { calls++; return {}; } }); code(() => f.store.commitWorkspaceBatch({ creates: [hostile], updates: [] }), 'INVALID_INPUT'); assert.equal(calls, 0);
  assert.deepEqual(rowCounts(f.root), before);
});

test('actual SQLite error after candidate insert rolls back snapshot, head and revisions; exact retry imports once', t => {
  const f = fixture(t); const value = preview(f); const key = randomUUID(); const injector = new Database(join(f.root, 'learnbridge.sqlite'));
  try {
    injector.exec(`CREATE TRIGGER synthetic_academic_head_abort BEFORE INSERT ON workspace_records
      WHEN json_extract(NEW.json,'$.data.format')='academic_stream' BEGIN
      SELECT CASE WHEN EXISTS(SELECT 1 FROM workspace_records WHERE json_extract(json,'$.data.format')='academic_snapshot')
      THEN RAISE(ABORT,'synthetic academic publication SQL abort') ELSE RAISE(ABORT,'missed academic publication boundary') END;
    END;`);
    code(() => accept(f, value, key), 'PROVIDER_FAILURE'); assert.deepEqual(rowCounts(f.root), { records: 0, revisions: 0, orphans: 0 });
  } finally { injector.exec('DROP TRIGGER IF EXISTS synthetic_academic_head_abort'); injector.close(); }
  f.restart(); const first = accept(f, value, key); assert.equal(accept(f, value, key).snapshot.id, first.snapshot.id);
  assert.deepEqual(rowCounts(f.root), { records: 2, revisions: 2, orphans: 0 });
});

test('actual child SIGKILL between candidate and head writes rolls back all academic rows on reopen; exact retry is one publication', t => {
  const f = fixture(t); const value = preview(f); const key = randomUUID(); f.store.close();
  const script = `import {LocalStore} from ${JSON.stringify(storageURL)};import {createStudentWorkspace} from ${JSON.stringify(serviceURL)};import Database from 'better-sqlite3';import {writeSync} from 'node:fs';
    const original=Database.prototype.prepare;Database.prototype.prepare=function(sql){const statement=original.call(this,sql);
      if(sql==='INSERT INTO workspace_records VALUES (?,?,?,?,?,?)'){const db=this;return{run(...args){
        if(JSON.parse(args[5]).data.format==='academic_stream'){
          if(original.call(db,"SELECT count(*) AS n FROM workspace_records WHERE json_extract(json,'$.data.format')='academic_snapshot'").get().n!==1)throw new Error('missed academic two-row boundary');
          writeSync(1,'ACADEMIC_TWO_ROW_BOUNDARY\\n');process.kill(process.pid,'SIGKILL');
        }return statement.run(...args);}};}return statement;};
    const store=LocalStore.open({root:${JSON.stringify(f.root)}});createStudentWorkspace(store).commitAcademicRefresh(${JSON.stringify(value)},${JSON.stringify({ review_hash: value.review_hash, expected_head_revision: value.base.revision, idempotency_key: key })});`;
  const env = Object.fromEntries(['PATH', 'TMPDIR', 'TEMP', 'TMP'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), env, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.signal, 'SIGKILL'); assert.equal(child.stdout, 'ACADEMIC_TWO_ROW_BOUNDARY\n'); assert.equal(child.stderr, '');
  assert.deepEqual(rowCounts(f.root), { records: 0, revisions: 0, orphans: 0 }); f.restart(); const first = accept(f, value, key);
  assert.equal(accept(f, value, key).snapshot.id, first.snapshot.id); assert.deepEqual(rowCounts(f.root), { records: 2, revisions: 2, orphans: 0 });
});

test('head update SQL failure rolls back a changed snapshot and leaves the prior published evidence intact', t => {
  const f = fixture(t); const first = accept(f, preview(f)); const raw = exported(1); raw.assignments[0].due = '2026-10-18'; const value = preview(f, raw); const before = rowCounts(f.root);
  const injector = new Database(join(f.root, 'learnbridge.sqlite')); try {
    injector.exec(`CREATE TRIGGER synthetic_academic_update_abort BEFORE UPDATE ON workspace_records
      WHEN json_extract(NEW.json,'$.data.format')='academic_stream' BEGIN
      SELECT CASE WHEN (SELECT count(*) FROM workspace_records WHERE json_extract(json,'$.data.format')='academic_snapshot')=2
      THEN RAISE(ABORT,'synthetic changed snapshot SQL abort') ELSE RAISE(ABORT,'missed academic update boundary') END; END;`);
    code(() => accept(f, value), 'PROVIDER_FAILURE'); assert.deepEqual(rowCounts(f.root), before);
    assert.equal(f.service.listSnapshots()[0].id, first.snapshot.id); assert.equal(f.service.academicStreamHistory(first.stream.id).items.length, 1);
  } finally { injector.exec('DROP TRIGGER IF EXISTS synthetic_academic_update_abort'); injector.close(); }
  f.restart(); const next = accept(f, value); assert.equal(next.stream.snapshot_count, 2); assert.equal(f.service.listSnapshots()[0].id, next.snapshot.id);
});

test('bounded observation capacity refuses before any row write and keeps the last published evidence available', t => {
  const f = fixture(t); const first = accept(f, preview(f));
  let stopped = false;
  for (let index = 1; index <= 128; index++) {
    const before = rowCounts(f.root);
    try { accept(f, preview(f)); }
    catch (error) { assert.equal(error.code, 'BUDGET_EXCEEDED'); assert.deepEqual(rowCounts(f.root), before); stopped = true; break; }
  }
  assert.equal(stopped, true); const stream = f.service.listAcademicStreams()[0];
  assert.ok(stream.observation_count >= 2 && stream.observation_count <= 128); assert.equal(stream.snapshot_count, 1);
  const before = rowCounts(f.root); const next = preview(f, exported(1)); code(() => accept(f, next), 'BUDGET_EXCEEDED');
  assert.deepEqual(rowCounts(f.root), before); assert.equal(f.service.listSnapshots()[0].id, first.snapshot.id);
});

test('compatibility save retry returns the original immutable artifact after a later refresh, without allowing historical current retrieval', t => {
  const f = fixture(t); const original = normalizeAcademicExport(exported(), { selectedCourseIds: ['A'] }); const key = randomUUID();
  const first = f.service.saveSnapshot(original, key); const nextRaw = exported(1); nextRaw.assignments[0].due = '2026-10-18';
  const second = accept(f, preview(f, nextRaw)); assert.notEqual(first.id, second.snapshot.id);
  assert.equal(f.service.saveSnapshot(original, key).id, first.id); code(() => f.service.library({ snapshot_ids: [first.id], course_ids: ['A'] }), 'SCOPE_DENIED');
});

test('actual workspace batch distinguishes explicit JSON null from omitted data across readback and reopen', t => {
  const f = fixture(t); const record = f.store.createWorkspaceRecord({ kind: 'plan', title: 'Synthetic JSON record', data: { selected: true } });
  const cleared = f.store.commitWorkspaceBatch({ creates: [], updates: [{ id: record.id, expected_revision: 1, data: null }] }).updates[0];
  assert.equal(cleared.data, null); assert.equal(f.store.getWorkspaceRecord(record.id).data, null);
  const unchanged = f.store.commitWorkspaceBatch({ creates: [], updates: [{ id: record.id, expected_revision: 2, title: 'Renamed synthetic record' }] }).updates[0];
  assert.equal(unchanged.data, null); f.restart(); assert.equal(f.store.getWorkspaceRecord(record.id).data, null);
  assert.deepEqual(rowCounts(f.root), { records: 1, revisions: 3, orphans: 0 });
});

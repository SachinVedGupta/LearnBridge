import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync, symlinkSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { LocalStore, STORAGE_LIMITS } from '../packages/local-storage/src/index.mjs';

const moduleUrl = new URL('../packages/local-storage/src/index.mjs', import.meta.url).href;
const childEnv = Object.fromEntries(['PATH', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'learnbridge-storage-test-'));
  const root = join(base, 'data');
  const store = LocalStore.open({ root, timezone: 'America/Toronto' });
  t.after(() => { try { store.close(); } catch {} rmSync(base, { recursive: true, force: true }); });
  return { base, root, store };
}
function child(code) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: new URL('..', import.meta.url), env: childEnv, encoding: 'utf8', timeout: 10000, maxBuffer: 2_000_000 });
  assert.ifError(result.error); return result;
}
const envelope = tasks => ({ value: tasks, revision: 4 });
const legacy = (overrides = {}) => ({ id: randomUUID(), title: 'Synthetic task', course: 'Synthetic course', due: '2026-10-09', done: false, ...overrides });

test('LS01 tasks and random installation identity survive a real new process', t => {
  const { root, store } = fixture(t);
  const task = store.createTask({ title: "Synthetic '; DROP TABLE records; --", deadline: { precision: 'date', date: '2026-10-12', timezone: 'America/Toronto' } });
  const installation = store.identity; store.close();
  const result = child(`import {LocalStore} from ${JSON.stringify(moduleUrl)}; const s=LocalStore.open({root:${JSON.stringify(root)}}); console.log(JSON.stringify({installation:s.identity,task:s.getTask(${JSON.stringify(task.id)})})); s.close();`);
  assert.equal(result.status, 0); assert.deepEqual(JSON.parse(result.stdout), { installation, task });
  assert.equal(Object.hasOwn(task.deadline, 'instant'), false);
});

test('LS02 expected revisions reject stale writes without losing the winning edit', t => {
  const { store } = fixture(t); const task = store.createTask({ title: 'Original' });
  const winner = store.updateTask(task.id, { title: 'Winning edit', status: 'in_progress' }, 1);
  assert.equal(winner.revision, 2);
  assert.throws(() => store.updateTask(task.id, { title: 'Stale edit' }, 1), { code: 'REVISION_CONFLICT' });
  assert.throws(() => store.deleteTask(task.id, 1), { code: 'REVISION_CONFLICT' });
  assert.deepEqual(store.getTask(task.id), winner); assert.equal(store.integrity().integrity, 'ok');
});

test('LS03 idempotency persists and detects changed payloads instead of duplicate creation', t => {
  const { root, store } = fixture(t); const options = { idempotencyKey: 'synthetic_retry_001' };
  const task = store.createTask({ title: 'Retry-safe' }, options);
  assert.deepEqual(store.createTask({ title: 'Retry-safe' }, options), task);
  assert.throws(() => store.createTask({ title: 'Changed payload' }, options), { code: 'REVISION_CONFLICT' });
  store.close(); const reopened = LocalStore.open({ root });
  try { assert.deepEqual(reopened.createTask({ title: 'Retry-safe' }, options), task); assert.equal(reopened.listTasks().length, 1); } finally { reopened.close(); }
});

test('LS04 immutable document history, exact hashes and revision conflicts', t => {
  const { root, store } = fixture(t); const original = store.createDocument({ title: 'Study note', text: 'First synthetic text.' });
  const edited = store.updateDocument(original.document.id, { text: 'Second synthetic text.', title: 'Revised note' }, 1);
  assert.equal(edited.document.revision, 2); assert.equal(edited.document.current_revision, 2);
  assert.throws(() => store.updateDocument(original.document.id, { text: 'Stale' }, 1), { code: 'REVISION_CONFLICT' });
  const history = store.listDocumentRevisions(original.document.id);
  assert.deepEqual(history.map(row => row.text), ['First synthetic text.', 'Second synthetic text.']);
  assert.ok(history.every(row => row.sha256 === sha(row.text) && row.revision.sha256 === row.sha256));
  const db = new Database(join(root, 'learnbridge.sqlite'));
  try {
    assert.throws(() => db.prepare('UPDATE document_revisions SET text=?').run('replacement'), /immutable revision/);
    assert.throws(() => db.prepare('DELETE FROM document_revisions').run(), /immutable revision/);
  } finally { db.close(); }
  assert.deepEqual(store.getDocument(original.document.id), edited); assert.equal(store.integrity().integrity, 'ok');
});

test('LS05 FTS follows edits and hides deleted text after restart; query operators remain literal', t => {
  const { root, store } = fixture(t);
  const first = store.createDocument({ title: 'Thermodynamics', text: 'entropy synthetic science' });
  const other = store.createDocument({ title: 'Other', text: 'synthetic unrelated' });
  assert.deepEqual(store.searchDocuments('entropy').map(row => row.document.id), [first.document.id]);
  assert.equal(store.searchDocuments('entropy OR unrelated').length, 0);
  assert.doesNotThrow(() => store.searchDocuments('"; DROP TABLE records; --'));
  store.updateDocument(first.document.id, { text: 'kinematics replacement' }, 1);
  assert.equal(store.searchDocuments('entropy').length, 0);
  assert.equal(store.searchDocuments('kinematics').length, 1);
  store.deleteDocument(first.document.id, 2); store.close();
  const reopened = LocalStore.open({ root });
  try { assert.equal(reopened.searchDocuments('kinematics').length, 0); assert.equal(reopened.getDocument(first.document.id), null); assert.deepEqual(reopened.listDocuments().map(row => row.id), [other.document.id]); assert.equal(reopened.integrity().integrity, 'ok'); } finally { reopened.close(); }
});

test('LS06 supplied ownership, source claims, oversized text and accessors fail closed', t => {
  const { store } = fixture(t);
  assert.throws(() => store.createTask({ title: 'Spoof', student_id: randomUUID() }), { code: 'INVALID_INPUT' });
  assert.throws(() => store.createTask({ title: 'Spoof', id: randomUUID() }), { code: 'INVALID_INPUT' });
  let invoked = false; const input = { get title() { invoked = true; return 'Do not invoke'; } };
  assert.throws(() => store.createTask(input), { code: 'INVALID_INPUT' }); assert.equal(invoked, false);
  const provenance = { source_id: randomUUID(), object_id: randomUUID(), source_version_id: randomUUID(), locator: { kind: 'opaque', ref: 'synthetic source' }, range: null, retrieved_at: new Date().toISOString(), grant_id: randomUUID() };
  assert.throws(() => store.createTask({ title: 'Sourced', source_refs: [provenance] }), { code: 'CONSENT_REQUIRED' });
  assert.throws(() => store.createDocument({ title: 'Oversize', text: 'x'.repeat(STORAGE_LIMITS.documentBytes + 1) }), { code: 'INVALID_INPUT' });
  assert.equal(store.listTasks().length, 0); assert.equal(store.listDocuments().length, 0);
});

test('LS07 missing dependencies, cycles and deleting an in-use parent reject atomically', t => {
  const { store } = fixture(t);
  assert.throws(() => store.createTask({ title: 'Missing parent', parent_id: randomUUID() }), { code: 'INVALID_INPUT' });
  const parent = store.createTask({ title: 'Parent' });
  const childTask = store.createTask({ title: 'Child', parent_id: parent.id });
  assert.throws(() => store.updateTask(parent.id, { dependency_ids: [childTask.id] }, 1), { code: 'INVALID_INPUT' });
  assert.throws(() => store.deleteTask(parent.id, 1), { code: 'INVALID_INPUT' });
  assert.equal(store.getTask(parent.id).revision, 1); assert.equal(store.listTasks().length, 2);
});

test('LS08 explicit hosted import preserves duplicates, dates, completion, exact backup and journal', t => {
  const { root, store } = fixture(t);
  const id = randomUUID(); const input = JSON.stringify(envelope([legacy({ id, title: 'Same', done: true }), legacy({ id, title: 'Same', due: 'tomorrow' })]), null, 2);
  const plan = store.planHostedTaskImport(input); assert.equal(plan.status, 'ready'); assert.equal(store.listTasks().length, 0);
  assert.equal(store.commitHostedTaskImport(input, { snapshotHash: plan.snapshot_hash }).imported, 2);
  assert.deepEqual(store.listTasks().map(task => task.title), ['Same', 'Same']);
  assert.equal(store.listTasks().filter(task => task.status === 'completed').length, 1);
  assert.equal(store.listTasks().find(task => task.deadline.precision === 'unknown').deadline.original, 'tomorrow');
  assert.equal(store.commitHostedTaskImport(input, { snapshotHash: plan.snapshot_hash }).status, 'already_imported');
  const db = new Database(join(root, 'learnbridge.sqlite'), { readonly: true });
  try { const journal = db.prepare('SELECT * FROM import_journal').get(); assert.equal(JSON.parse(journal.backup_json).original_text, input); assert.equal(db.prepare("SELECT count(*) AS n FROM records WHERE kind='task'").get().n, 2); } finally { db.close(); }
  assert.equal(store.integrity().integrity, 'ok');
});

test('LS09 deferred/changed/unreviewed snapshots never partially merge into local data', t => {
  const { store } = fixture(t);
  const deferred = envelope([legacy(), legacy({ title: '' })]); const review = store.planHostedTaskImport(deferred);
  assert.equal(review.deferred_count, 1); assert.throws(() => store.commitHostedTaskImport(deferred, { snapshotHash: review.snapshot_hash }), { code: 'CONSENT_REQUIRED' });
  assert.equal(store.listTasks().length, 0);
  const original = envelope([legacy()]); const first = store.planHostedTaskImport(original); store.commitHostedTaskImport(original, { snapshotHash: first.snapshot_hash });
  const different = envelope([legacy({ title: 'Changed snapshot' })]); const next = store.planHostedTaskImport(different);
  assert.throws(() => store.commitHostedTaskImport(different, { snapshotHash: first.snapshot_hash }), { code: 'REVISION_CONFLICT' });
  assert.throws(() => store.commitHostedTaskImport(different, { snapshotHash: next.snapshot_hash }), { code: 'CONSENT_REQUIRED' });
  assert.equal(store.listTasks().length, 1);
});

test('LS10 real SQL insertion failure rolls back all imported rows, journal and backup', t => {
  const { root, store } = fixture(t); const input = envelope([legacy(), legacy()]); const plan = store.planHostedTaskImport(input);
  const db = new Database(join(root, 'learnbridge.sqlite'));
  try { db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON records WHEN (SELECT count(*) FROM records)>0 BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;"); } finally { db.close(); }
  assert.throws(() => store.commitHostedTaskImport(input, { snapshotHash: plan.snapshot_hash }), { code: 'PROVIDER_FAILURE' });
  assert.equal(store.listTasks().length, 0);
  const read = new Database(join(root, 'learnbridge.sqlite'), { readonly: true });
  try { assert.equal(read.prepare('SELECT count(*) AS n FROM import_journal').get().n, 0); } finally { read.close(); }
});

test('LS11 single writer rejects another runtime and recovers a SIGKILL owner', t => {
  const { root, store } = fixture(t); const task = store.createTask({ title: 'Committed before crash' });
  assert.throws(() => LocalStore.open({ root }), { code: 'REVISION_CONFLICT' }); store.close();
  const result = child(`import {LocalStore} from ${JSON.stringify(moduleUrl)}; const s=LocalStore.open({root:${JSON.stringify(root)}}); process.kill(process.pid,'SIGKILL');`);
  assert.equal(result.signal, 'SIGKILL');
  const reopened = LocalStore.open({ root });
  try { assert.deepEqual(reopened.getTask(task.id), task); assert.equal(reopened.integrity().integrity, 'ok'); } finally { reopened.close(); }
});

test('LS12 SIGKILL during SQL migration transaction rolls back schema, version and data', t => {
  const { root, store } = fixture(t); const task = store.createTask({ title: 'Stable committed record' }); store.close();
  const result = child(`import {LocalStore} from ${JSON.stringify(moduleUrl)}; import Database from 'better-sqlite3'; const s=LocalStore.open({root:${JSON.stringify(root)}}); const d=new Database(${JSON.stringify(join(root, 'learnbridge.sqlite'))}); d.exec("BEGIN IMMEDIATE; CREATE TABLE partial_upgrade(id INTEGER); UPDATE records SET revision=999; PRAGMA user_version=2;"); process.kill(process.pid,'SIGKILL');`);
  assert.equal(result.signal, 'SIGKILL'); const reopened = LocalStore.open({ root });
  try { assert.deepEqual(reopened.getTask(task.id), task); assert.equal(reopened.integrity().schema_version, 1); } finally { reopened.close(); }
  const db = new Database(join(root, 'learnbridge.sqlite'), { readonly: true });
  try { assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='partial_upgrade'").get().n, 0); } finally { db.close(); }
});

test('LS13 root/database modes, symlink roots and symlink database files', t => {
  const { base, root, store } = fixture(t);
  assert.equal(statSync(root).mode & 0o777, 0o700); assert.equal(statSync(join(root, 'learnbridge.sqlite')).mode & 0o777, 0o600);
  for (const suffix of ['-wal', '-shm']) if (existsSync(join(root, 'learnbridge.sqlite' + suffix))) assert.equal(statSync(join(root, 'learnbridge.sqlite' + suffix)).mode & 0o777, 0o600);
  symlinkSync(root, join(base, 'linked-root')); assert.throws(() => LocalStore.open({ root: join(base, 'linked-root') }), { code: 'SCOPE_DENIED' });
  store.close(); const bad = join(base, 'linked-db'); const prepared = LocalStore.open({ root: bad }); prepared.close();
  rmSync(join(bad, 'learnbridge.sqlite')); symlinkSync(join(root, 'learnbridge.sqlite'), join(bad, 'learnbridge.sqlite'));
  assert.throws(() => LocalStore.open({ root: bad }), { code: 'SCOPE_DENIED' });
});

test('LS14 unsupported future schemas reject without modifying database bytes', t => {
  const { root, store } = fixture(t); store.close(); const path = join(root, 'learnbridge.sqlite');
  const db = new Database(path); db.pragma('user_version=99'); db.close(); const before = sha(readFileSync(path));
  assert.throws(() => LocalStore.open({ root }), { code: 'VERSION_MISMATCH' }); assert.equal(sha(readFileSync(path)), before); assert.equal(existsSync(join(root, 'writer.lock')), false);
});

test('LS15 online backup restores exact tasks and immutable revisions into a fresh root', async t => {
  const { base, root, store } = fixture(t); const task = store.createTask({ title: 'Backup task' });
  const doc = store.createDocument({ title: 'Backup doc', text: 'Synthetic backup text.' });
  const edited = store.updateDocument(doc.document.id, { text: 'Synthetic immutable second revision.' }, 1);
  const manifest = await store.backup(join(base, 'backup'));
  assert.equal(manifest.database.sha256, sha(readFileSync(join(base, 'backup', 'learnbridge.sqlite'))));
  store.updateTask(task.id, { title: 'Later edit outside snapshot' }, 1);
  const restored = join(base, 'restored'); await LocalStore.restore({ backupRoot: join(base, 'backup'), root: restored });
  const copy = LocalStore.open({ root: restored });
  try { assert.deepEqual(copy.getTask(task.id), task); assert.deepEqual(copy.getDocument(doc.document.id), edited); assert.equal(copy.listDocumentRevisions(doc.document.id).length, 2); assert.equal(copy.identity.id, store.identity.id); assert.equal(copy.integrity().integrity, 'ok'); } finally { copy.close(); }
  await assert.rejects(LocalStore.restore({ backupRoot: join(base, 'backup'), root }), { code: 'REVISION_CONFLICT' });
  assert.equal(store.getTask(task.id).title, 'Later edit outside snapshot');
});

test('LS16 corrupt candidates fail before restore and preserve the live source and destination', async t => {
  const { base, root, store } = fixture(t); const task = store.createTask({ title: 'Preserve me' }); await store.backup(join(base, 'backup'));
  const source = join(base, 'backup', 'learnbridge.sqlite'); const bytes = readFileSync(source); bytes[0] ^= 1; writeFileSync(source, bytes);
  const target = join(base, 'must-not-exist');
  await assert.rejects(LocalStore.restore({ backupRoot: join(base, 'backup'), root: target }), { code: 'VERSION_MISMATCH' });
  assert.equal(existsSync(target), false); assert.deepEqual(store.getTask(task.id), task); assert.equal(store.integrity().integrity, 'ok'); assert.equal(statSync(root).mode & 0o777, 0o700);
});

test('LS17 selecting a nonempty unmarked user folder preserves contents and permissions', t => {
  const { base } = fixture(t); const unrelated = join(base, 'unrelated-user-folder'); mkdirSync(unrelated, { mode: 0o755 });
  writeFileSync(join(unrelated, 'personal-placeholder.txt'), 'Synthetic unrelated contents.', { mode: 0o644 });
  const beforeMode = statSync(unrelated).mode & 0o777;
  assert.throws(() => LocalStore.open({ root: unrelated }), { code: 'SCOPE_DENIED' });
  assert.equal(statSync(unrelated).mode & 0o777, beforeMode);
  assert.deepEqual(readdirSync(unrelated), ['personal-placeholder.txt']);
  assert.equal(readFileSync(join(unrelated, 'personal-placeholder.txt'), 'utf8'), 'Synthetic unrelated contents.');
});

test('LS18 a rehashed backup with forged document revision lineage is rejected', async t => {
  const { base, store } = fixture(t); store.createDocument({ title: 'Preserve lineage', text: 'Synthetic immutable content' }); await store.backup(join(base, 'backup'));
  const path = join(base, 'backup', 'learnbridge.sqlite'); const db = new Database(path);
  try { const row = db.prepare("SELECT id,json FROM records WHERE kind='document'").get(); const value = JSON.parse(row.json); value.content_ref = 'sqlite:forged'; db.prepare("UPDATE records SET json=? WHERE id=?").run(JSON.stringify(value), row.id); } finally { db.close(); }
  const manifestPath = join(base, 'backup', 'manifest.json'); const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); const bytes = readFileSync(path);
  manifest.database.bytes = bytes.length; manifest.database.sha256 = sha(bytes); writeFileSync(manifestPath, JSON.stringify(manifest));
  const target = join(base, 'forged-restore');
  await assert.rejects(LocalStore.restore({ backupRoot: join(base, 'backup'), root: target }), { code: 'VERSION_MISMATCH' });
  assert.equal(existsSync(target), false); assert.equal(store.integrity().integrity, 'ok');
});

test('LS19 simulated SQLite capacity exhaustion leaves a committed task intact', t => {
  const { root, store } = fixture(t); const task = store.createTask({ title: 'Committed before capacity limit' }); store.close();
  const path = join(root, 'learnbridge.sqlite'); const constrained = new Database(path);
  try {
    const count = constrained.pragma('page_count', { simple: true }); constrained.pragma(`max_page_count=${count}`);
    assert.throws(() => constrained.transaction(() => {
      constrained.prepare('INSERT INTO idempotency VALUES (?,?,?,?)').run('synthetic_partial', 'fixture', '0'.repeat(64), '{}');
      constrained.prepare('INSERT INTO idempotency VALUES (?,?,?,?)').run('synthetic_full', 'fixture', '0'.repeat(64), 'x'.repeat(900_000));
    }).immediate(), { code: 'SQLITE_FULL' });
    assert.equal(constrained.prepare('SELECT count(*) AS n FROM idempotency').get().n, 0);
  } finally { constrained.close(); }
  const reopened = LocalStore.open({ root });
  try {
    assert.deepEqual(reopened.getTask(task.id), task); assert.equal(reopened.listDocuments().length, 0); assert.equal(reopened.integrity().integrity, 'ok');
  } finally { reopened.close(); }
});

test('LS20 backup respects the same explicit repository boundary as storage', async t => {
  const { base } = fixture(t); const repo = join(base, 'synthetic-repository'); mkdirSync(repo, { mode: 0o700 });
  const store = LocalStore.open({ root: join(base, 'boundary-data'), repositoryRoot: repo });
  try {
    const target = join(repo, 'must-not-export');
    await assert.rejects(store.backup(target), { code: 'SCOPE_DENIED' });
    assert.equal(existsSync(target), false); assert.equal(store.integrity().integrity, 'ok');
  } finally { store.close(); }
});

test('LS21 failed checkpoint still closes the database before releasing its writer claim', t => {
  const { root, store } = fixture(t); const task = store.createTask({ title: 'Preserved despite checkpoint failure' });
  const originalPragma = Database.prototype.pragma; const originalClose = Database.prototype.close; let closeCalls = 0;
  Database.prototype.pragma = function(statement, options) {
    if (statement === 'wal_checkpoint(TRUNCATE)') throw new Error('Synthetic checkpoint failure');
    return originalPragma.call(this, statement, options);
  };
  Database.prototype.close = function() { closeCalls++; return originalClose.call(this); };
  try { assert.throws(() => store.close(), /Synthetic checkpoint failure/); }
  finally { Database.prototype.pragma = originalPragma; Database.prototype.close = originalClose; }
  assert.equal(closeCalls, 1); assert.equal(existsSync(join(root, 'writer.lock')), false);
  const reopened = LocalStore.open({ root });
  try { assert.deepEqual(reopened.getTask(task.id), task); assert.equal(reopened.integrity().integrity, 'ok'); } finally { reopened.close(); }
});

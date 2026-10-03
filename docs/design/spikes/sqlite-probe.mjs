#!/usr/bin/env node
/**
 * W02 dependency feasibility probe, not LearnBridge storage.
 * Creates only synthetic data in a newly created OS temporary directory, then
 * removes it. No default student data root, imported content, secrets or network.
 * Run: node docs/design/spikes/sqlite-probe.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { DatabaseSync, backup } = await import('node:sqlite');
const script = fileURLToPath(import.meta.url);
const marker = 'learnbridge-synthetic-sqlite-probe-v1';
const migration = `
  CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0)
  ) STRICT;
  INSERT INTO schema_migrations VALUES (1, 'synthetic-base');
  PRAGMA user_version = 1;
`;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
// An explicit allowlist avoids giving synthetic child probes unrelated secrets.
const childEnv = Object.fromEntries(
  ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR'].filter((k) => process.env[k] !== undefined)
    .map((k) => [k, process.env[k]]),
);

function checkedFixtureRoot(candidate) {
  const root = realpathSync(candidate);
  assert.equal(dirname(root), realpathSync(tmpdir()));
  assert.ok(basename(root).startsWith('learnbridge-sqlite-probe-'));
  assert.equal(readFileSync(join(root, 'fixture.marker'), 'utf8'), marker);
  return root;
}

function open(root, name, options = {}) {
  return new DatabaseSync(join(root, name), { allowExtension: false, ...options });
}

function migrate(db) {
  if (db.prepare('PRAGMA user_version').get().user_version === 1) return;
  db.exec('BEGIN IMMEDIATE');
  try { db.exec(migration); db.exec('COMMIT'); }
  catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

if (process.argv[2]?.startsWith('--child-')) {
  const root = checkedFixtureRoot(process.argv[3]);
  if (process.argv[2] === '--child-killed-migration') {
    const db = open(root, 'killed.sqlite');
    db.exec(`BEGIN IMMEDIATE; CREATE TABLE partial_migration (id INTEGER);
      INSERT INTO tasks VALUES ('uncommitted', 'synthetic incomplete', 0);
      PRAGMA user_version = 2;`);
    process.kill(process.pid, 'SIGKILL');
  } else if (process.argv[2] === '--child-restart-read') {
    const db = open(root, 'restart.sqlite', { readOnly: true });
    const result = db.prepare('SELECT id, title, revision FROM tasks ORDER BY id').all();
    db.close();
    process.stdout.write(JSON.stringify(result));
  } else if (process.argv[2] === '--child-revision-write') {
    const db = open(root, 'concurrency.sqlite', { timeout: 2000 });
    const result = db.prepare('UPDATE tasks SET title = ?, revision = revision + 1 WHERE id = ? AND revision = ?')
      .run('synthetic writer', 'task', 0);
    db.close();
    process.stdout.write(JSON.stringify({ changes: result.changes }));
  } else { throw new Error('Unknown synthetic child mode'); }
  process.exit(0);
}

if (process.argv.length !== 2) {
  throw new Error('No data-root arguments accepted: this probe creates its own synthetic temporary root.');
}
const root = mkdtempSync(join(tmpdir(), 'learnbridge-sqlite-probe-'));
chmodSync(root, 0o700);
writeFileSync(join(root, 'fixture.marker'), marker, { mode: 0o600 });
const results = [];
const handles = new Set();
function trackedOpen(name, options) { const db = open(root, name, options); handles.add(db); return db; }
function close(db) { db.close(); handles.delete(db); }
async function check(id, name, fn) {
  const started = performance.now();
  try {
    const evidence = await fn();
    results.push({ id, name, status: 'PASS', evidence, durationMs: Math.round(performance.now() - started) });
  } catch (error) {
    results.push({ id, name, status: 'FAIL', error: error.message, durationMs: Math.round(performance.now() - started) });
  } finally {
    for (const db of handles) { try { db.close(); } catch {} }
    handles.clear();
  }
}

function child(mode) {
  const result = spawnSync(process.execPath, [script, mode, root], {
    env: childEnv, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  return result;
}
function concurrentChild() {
  return new Promise((resolve, reject) => {
    const processChild = spawn(process.execPath, [script, '--child-revision-write', root], { env: childEnv });
    const timeout = setTimeout(() => { processChild.kill(); reject(new Error('Synthetic child timed out')); }, 10000);
    let output = '';
    processChild.stdout.on('data', (part) => { output += part; });
    processChild.on('error', (error) => { clearTimeout(timeout); reject(error); });
    // Consume the expected experimental warning without including raw stderr in evidence.
    processChild.stderr.resume();
    processChild.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`Synthetic writer exited ${code}`));
      else { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } }
    });
  });
}

try {
  await check('SQL01', 'Installed runtime, STRICT tables and WAL', () => {
    const db = trackedOpen('runtime.sqlite');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('CREATE TABLE strict_probe (id INTEGER PRIMARY KEY) STRICT');
    assert.throws(() => db.prepare('INSERT INTO strict_probe VALUES (?)').run('wrong-type'));
    const sqliteVersion = db.prepare('SELECT sqlite_version() AS version').get().version;
    const journal = db.prepare('PRAGMA journal_mode').get().journal_mode;
    assert.equal(journal, 'wal');
    return { sqliteVersion, journal, nativeCompilerRequiredForThisProbe: false };
  });

  await check('SQL02', 'Transaction migration and idempotent repeat', () => {
    const db = trackedOpen('migration.sqlite');
    migrate(db); migrate(db);
    assert.equal(db.prepare('SELECT count(*) AS count FROM schema_migrations').get().count, 1);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    return { schemaVersion: 1, migrationRows: 1 };
  });

  await check('SQL03', 'Failed migration rolls back schema, data and version', () => {
    const db = trackedOpen('rollback.sqlite'); migrate(db);
    db.exec(`INSERT INTO tasks VALUES ('original', 'synthetic original', 0); BEGIN IMMEDIATE;`);
    assert.throws(() => db.exec(`CREATE TABLE partial_migration (id INTEGER);
      INSERT INTO tasks VALUES ('partial', 'synthetic partial', 0);
      PRAGMA user_version = 2; SELECT * FROM deliberately_absent_table;`));
    if (db.isTransaction) db.exec('ROLLBACK');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'partial_migration'").get().count, 0);
    assert.equal(db.prepare('SELECT count(*) AS count FROM tasks').get().count, 1);
    return { noPartialSchema: true, noPartialRows: true, schemaVersion: 1 };
  });

  await check('SQL04', 'Killed migration process leaves no committed partial state', () => {
    const db = trackedOpen('killed.sqlite'); migrate(db);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec("INSERT INTO tasks VALUES ('original', 'synthetic original', 0)"); close(db);
    const result = child('--child-killed-migration');
    assert.equal(result.signal, 'SIGKILL');
    const reopened = trackedOpen('killed.sqlite');
    assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(reopened.prepare('SELECT count(*) AS count FROM tasks').get().count, 1);
    assert.equal(reopened.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'partial_migration'").get().count, 0);
    assert.equal(reopened.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    return { interruptedBy: 'SIGKILL', recoveredSchemaVersion: 1, integrity: 'ok' };
  });

  await check('SQL05', 'Persisted synthetic task read in a new process', () => {
    const db = trackedOpen('restart.sqlite'); migrate(db);
    db.prepare('INSERT INTO tasks VALUES (?, ?, ?)').run('task', 'synthetic restart task', 3); close(db);
    const result = child('--child-restart-read'); assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), [{ id: 'task', title: 'synthetic restart task', revision: 3 }]);
    return { differentProcessRead: true, revision: 3 };
  });

  await check('SQL06', 'Three cross-process stale-revision writes commit once', async () => {
    const db = trackedOpen('concurrency.sqlite'); migrate(db);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec("INSERT INTO tasks VALUES ('task', 'synthetic original', 0)"); close(db);
    const writes = await Promise.all([concurrentChild(), concurrentChild(), concurrentChild()]);
    assert.deepEqual(writes.map((r) => r.changes).sort(), [0, 0, 1]);
    const reopened = trackedOpen('concurrency.sqlite');
    assert.equal(reopened.prepare("SELECT revision FROM tasks WHERE id = 'task'").get().revision, 1);
    return { writers: 3, successfulCommits: 1, detectedStaleWrites: 2, finalRevision: 1 };
  });

  await check('SQL07', 'Writer contention rejects safely and later recovers', () => {
    const first = trackedOpen('busy.sqlite'); migrate(first);
    first.exec("INSERT INTO tasks VALUES ('task', 'synthetic original', 0); BEGIN IMMEDIATE");
    const second = trackedOpen('busy.sqlite', { timeout: 0 });
    assert.throws(() => second.prepare("UPDATE tasks SET revision = revision + 1 WHERE id = 'task'").run(), /locked|busy/i);
    assert.equal(second.prepare("SELECT revision FROM tasks WHERE id = 'task'").get().revision, 0);
    first.exec('ROLLBACK');
    assert.equal(second.prepare("UPDATE tasks SET revision = revision + 1 WHERE id = 'task'").run().changes, 1);
    return { busyRejected: true, noPartialWrite: true, retryAfterReleaseSucceeded: true };
  });

  await check('SQL08', 'Foreign keys and SQL parameter binding', () => {
    const db = trackedOpen('constraints.sqlite'); migrate(db);
    db.exec('CREATE TABLE child (task_id TEXT NOT NULL REFERENCES tasks(id)) STRICT');
    assert.throws(() => db.prepare('INSERT INTO child VALUES (?)').run('missing'), /FOREIGN KEY/i);
    const title = "synthetic '; DROP TABLE tasks; --";
    db.prepare('INSERT INTO tasks VALUES (?, ?, ?)').run('safe', title, 0);
    assert.equal(db.prepare('SELECT title FROM tasks WHERE id = ?').get('safe').title, title);
    return { orphanRejected: true, userTextStayedData: true };
  });

  await check('SQL09', 'Scoped FTS5 retrieval and transactional lineage deletion', () => {
    const db = trackedOpen('fts.sqlite');
    db.exec(`CREATE TABLE sources (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE chunks (id INTEGER PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, body TEXT NOT NULL) STRICT;
      CREATE VIRTUAL TABLE chunks_fts USING fts5(body, content='chunks', content_rowid='id');
      CREATE TRIGGER chunks_insert AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid, body) VALUES (new.id, new.body); END;
      CREATE TRIGGER chunks_delete AFTER DELETE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts, rowid, body) VALUES ('delete', old.id, old.body); END;
      INSERT INTO sources VALUES ('approved'), ('other');
      INSERT INTO chunks VALUES (1, 'approved', 'synthetic thermodynamics lesson'), (2, 'other', 'synthetic thermodynamics private scope');`);
    const query = db.prepare(`SELECT c.id, c.source_id FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid WHERE chunks_fts MATCH ? AND c.source_id = ?`);
    assert.deepEqual(query.all('thermodynamics', 'approved').map((r) => r.id), [1]);
    db.exec("BEGIN IMMEDIATE; DELETE FROM sources WHERE id = 'approved'; COMMIT"); close(db);
    const reopened = trackedOpen('fts.sqlite');
    assert.equal(reopened.prepare("SELECT count(*) AS count FROM chunks WHERE source_id = 'approved'").get().count, 0);
    assert.deepEqual(reopened.prepare('SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?').all('thermodynamics').map((r) => r.rowid), [2]);
    return { scopeQueryExcludedOther: true, revokedSourceChunksAndSearchGoneAfterReopen: true };
  });

  await check('SQL10', 'Online database snapshot plus immutable attachment manifest', async () => {
    const db = trackedOpen('export.sqlite'); migrate(db); db.exec('PRAGMA journal_mode = WAL');
    db.exec('CREATE TABLE attachments (id TEXT PRIMARY KEY, name TEXT NOT NULL, sha256 TEXT NOT NULL) STRICT');
    const bytes = Buffer.from('synthetic attachment content\n');
    writeFileSync(join(root, 'synthetic.txt'), bytes, { mode: 0o600 });
    db.prepare('INSERT INTO tasks VALUES (?, ?, ?)').run('exported-task', 'synthetic export', 7);
    db.prepare('INSERT INTO attachments VALUES (?, ?, ?)').run('file', 'synthetic.txt', hash(bytes));
    const pages = await backup(db, join(root, 'snapshot.sqlite'), { rate: 1 });
    assert.ok(pages > 0);
    // A later committed write must not retroactively alter the completed snapshot.
    db.prepare('UPDATE tasks SET revision = revision + 1 WHERE id = ?').run('exported-task');
    const snapshot = trackedOpen('snapshot.sqlite', { readOnly: true });
    assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(snapshot.prepare('SELECT revision FROM tasks').get().revision, 7);
    const files = snapshot.prepare('SELECT name, sha256 FROM attachments ORDER BY id').all();
    assert.equal(hash(readFileSync(join(root, files[0].name))), files[0].sha256);
    writeFileSync(join(root, 'export-manifest.json'), JSON.stringify({ format: 1, schemaVersion: 1, files }), { mode: 0o600 });
    return { pages, snapshotRevision: 7, liveRevision: 8, attachmentHashesMatched: true };
  });

  await check('SQL11', 'Restore synthetic snapshot into a fresh root and verify manifest', () => {
    const restoredRoot = join(root, 'fresh-restore'); mkdirSync(restoredRoot, { mode: 0o700 });
    const manifest = JSON.parse(readFileSync(join(root, 'export-manifest.json'), 'utf8'));
    copyFileSync(join(root, 'snapshot.sqlite'), join(restoredRoot, 'database.sqlite'));
    for (const file of manifest.files) {
      assert.equal(file.name, 'synthetic.txt');
      copyFileSync(join(root, file.name), join(restoredRoot, file.name));
      assert.equal(hash(readFileSync(join(restoredRoot, file.name))), file.sha256);
    }
    const db = new DatabaseSync(join(restoredRoot, 'database.sqlite'), { readOnly: true, allowExtension: false }); handles.add(db);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, manifest.schemaVersion);
    assert.equal(db.prepare('SELECT count(*) AS count FROM tasks').get().count, 1);
    assert.equal(db.prepare('SELECT revision FROM tasks').get().revision, 7);
    return { freshRootRestore: true, rows: 1, revision: 7, attachmentHashesMatched: true };
  });

  await check('SQL12', 'Corrupted candidate is rejected without changing original', () => {
    const originalHash = hash(readFileSync(join(root, 'snapshot.sqlite')));
    writeFileSync(join(root, 'corrupted.sqlite'), 'synthetic non-SQLite candidate', { mode: 0o600 });
    assert.throws(() => {
      const candidate = trackedOpen('corrupted.sqlite', { readOnly: true });
      candidate.prepare('PRAGMA integrity_check').get();
    }, /database|file|malformed/i);
    assert.equal(hash(readFileSync(join(root, 'snapshot.sqlite'))), originalHash);
    return { candidateRejected: true, originalHashUnchanged: true };
  });

  await check('SQL13', 'SQLite capacity failure preserves committed rows', () => {
    const db = trackedOpen('capacity.sqlite'); migrate(db);
    db.exec("INSERT INTO tasks VALUES ('original', 'synthetic original', 0)");
    const pageCount = db.prepare('PRAGMA page_count').get().page_count;
    db.exec(`PRAGMA max_page_count = ${pageCount}; BEGIN IMMEDIATE`);
    assert.throws(() => db.prepare('INSERT INTO tasks VALUES (?, ?, ?)').run('oversized', 'x'.repeat(1024 * 1024), 0), /full/i);
    if (db.isTransaction) db.exec('ROLLBACK'); close(db);
    const reopened = trackedOpen('capacity.sqlite');
    assert.equal(reopened.prepare('SELECT count(*) AS count FROM tasks').get().count, 1);
    assert.equal(reopened.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    return { sqliteCapacityFailureInjected: true, committedRows: 1, integrity: 'ok', realFilesystemDiskFullNotTested: true };
  });

  await check('SQL14', 'Explicit POSIX fixture permissions', () => {
    if (process.platform === 'win32') throw new Error('POSIX mode check unsupported on Windows; ACLs need a separate probe');
    chmodSync(join(root, 'snapshot.sqlite'), 0o600);
    assert.equal(statSync(root).mode & 0o777, 0o700);
    assert.equal(statSync(join(root, 'snapshot.sqlite')).mode & 0o777, 0o600);
    return { rootMode: '0700', explicitlySetDatabaseMode: '0600', productionAclEnforcementNotTested: true };
  });
} finally {
  for (const db of handles) { try { db.close(); } catch {} }
  rmSync(root, { recursive: true, force: true });
}

const report = {
  schemaVersion: 1, purpose: 'W02 synthetic SQLite dependency feasibility, not production storage',
  generatedAt: new Date().toISOString(), environment: { node: process.version, platform: process.platform, arch: process.arch },
  isolation: { syntheticOnly: true, temporaryRootRemoved: true, realStudentRootUsed: false, networkUsed: false, dependenciesInstalled: false },
  summary: { passed: results.filter((r) => r.status === 'PASS').length, failed: results.filter((r) => r.status === 'FAIL').length },
  limitations: [
    'node:sqlite remains experimental in the tested Node 22 release',
    'Only the current OS/runtime combination is tested',
    'No production repository, local daemon locking, HTTP policy, secrets store or auth integration is tested',
    'Capacity failure uses SQLite max_page_count, not a genuinely full filesystem',
    'Attachments are immutable synthetic files; coordinated production export locking is not implemented',
  ],
  results,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.summary.failed > 0) process.exitCode = 1;

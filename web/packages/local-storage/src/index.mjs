import Database from 'better-sqlite3';
import { randomUUID, createHash } from 'node:crypto';
import {
  mkdirSync, lstatSync, existsSync, readFileSync, writeFileSync, chmodSync,
  realpathSync, unlinkSync, rmSync, rmdirSync, copyFileSync, renameSync, openSync, closeSync, readdirSync,
} from 'node:fs';
import { resolve, dirname, basename, join, relative, isAbsolute } from 'node:path';
import {
  createInstallation, parseInstallation, createTask, parseTask, assertTaskGraph,
  createDocument, parseDocument, createDocumentRevision, parseDocumentRevision,
  assertRevision, LearnBridgeError, invalidInput, migrateHostedTasks,
} from '@learnbridge/core';

export const STORAGE_SCHEMA_VERSION = 1;
export const STORAGE_LIMITS = Object.freeze({ documentBytes: 1_000_000, importBytes: 1_000_000, backupBytes: 512_000_000 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTERNAL = Symbol('local-storage-internal');
const ROOT_MARKER = '.learnbridge-local-root';
const ROOT_MARKER_CONTENT = 'learnbridge-local-data-v1\n';
const hash = value => createHash('sha256').update(value).digest('hex');
const canonicalJson = value => Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}` : JSON.stringify(value);
const now = () => new Date().toISOString();
const failure = (code = 'INVALID_INPUT') => { throw new LearnBridgeError(code); };

function checkedObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalidInput();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key)
    || !('value' in descriptors[key]) || !descriptors[key].enumerable)) invalidInput();
  return value;
}
function checkedId(value) { if (typeof value !== 'string' || !UUID.test(value)) invalidInput(); return value.toLowerCase(); }
function inside(path, parent) { const rel = relative(parent, path); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); }
function owned(path, directory = false) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) failure('SCOPE_DENIED');
  return stat;
}
function privatePath(path, directory = false) {
  owned(path, directory);
  chmodSync(path, directory ? 0o700 : 0o600);
}
function checkedRoot(candidate, repositoryRoot, { fresh = false } = {}) {
  if (!['darwin', 'linux'].includes(process.platform)) failure('UNSUPPORTED');
  if (typeof candidate !== 'string' || !isAbsolute(candidate) || candidate.includes('\0')) invalidInput();
  const proposed = resolve(candidate);
  // Canonicalize existing ancestors, but reject an explicitly symlinked root.
  if (existsSync(proposed)) owned(proposed, true);
  let ancestor = dirname(proposed);
  const parts = [basename(proposed)];
  while (!existsSync(ancestor)) { parts.unshift(basename(ancestor)); ancestor = dirname(ancestor); }
  const canonical = join(realpathSync(ancestor), ...parts);
  const repo = repositoryRoot ? realpathSync(resolve(repositoryRoot)) : realpathSync(process.cwd());
  if (inside(canonical, repo) || canonical === '/') failure('SCOPE_DENIED');
  if (fresh && existsSync(canonical)) failure('REVISION_CONFLICT');
  return canonical;
}
function boundedText(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > STORAGE_LIMITS.documentBytes || value.includes('\0')) invalidInput();
  return value;
}
function readJsonFile(path, maxBytes) {
  const stat = owned(path);
  if (stat.size > maxBytes) invalidInput();
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { invalidInput(); }
}
function acquireLock(root) {
  const path = join(root, 'writer.lock');
  const token = randomUUID();
  const claim = () => {
    const fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token }), 'utf8'); } finally { closeSync(fd); }
    return { path, token };
  };
  try { return claim(); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  // Reclaiming is also single-writer: two processes cannot both unlink a stale
  // claim after one has already replaced it. An interrupted reclamation guard
  // fails closed for operator inspection rather than stealing a possibly live lock.
  const recovery = join(root, 'lock-recovery');
  try { mkdirSync(recovery, { mode: 0o700 }); } catch { failure('REVISION_CONFLICT'); }
  try {
    const before = owned(path);
    const prior = readJsonFile(path, 1024);
    checkedObject(prior, ['pid', 'token']);
    if (!Number.isSafeInteger(prior.pid) || prior.pid < 1 || typeof prior.token !== 'string' || !UUID.test(prior.token)) invalidInput();
    try { process.kill(prior.pid, 0); failure('REVISION_CONFLICT'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    const after = owned(path);
    if (before.ino !== after.ino || before.dev !== after.dev || readJsonFile(path, 1024).token !== prior.token) failure('REVISION_CONFLICT');
    unlinkSync(path);
    try { return claim(); } catch { failure('REVISION_CONFLICT'); }
  } finally { rmdirSync(recovery); }
}
function releaseLock(lock) {
  if (!lock || !existsSync(lock.path)) return;
  try { if (readJsonFile(lock.path, 1024).token === lock.token) unlinkSync(lock.path); } catch { /* Never remove an unowned replacement. */ }
}

const MIGRATION = `
  CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL) STRICT;
  CREATE TABLE installation (singleton INTEGER PRIMARY KEY CHECK(singleton=1), json TEXT NOT NULL) STRICT;
  CREATE TABLE records (
    kind TEXT NOT NULL CHECK(kind IN ('task','document')), id TEXT NOT NULL,
    student_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1),
    deleted_at TEXT, json TEXT NOT NULL, PRIMARY KEY(kind,id)
  ) STRICT;
  CREATE INDEX records_owner ON records(student_id,kind,deleted_at);
  CREATE TABLE document_revisions (
    document_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>=1),
    student_id TEXT NOT NULL, json TEXT NOT NULL, text TEXT NOT NULL,
    sha256 TEXT NOT NULL, PRIMARY KEY(document_id,sequence)
  ) STRICT;
  CREATE TRIGGER immutable_revisions_update BEFORE UPDATE ON document_revisions BEGIN SELECT RAISE(ABORT,'immutable revision'); END;
  CREATE TRIGGER immutable_revisions_delete BEFORE DELETE ON document_revisions BEGIN SELECT RAISE(ABORT,'immutable revision'); END;
  CREATE VIRTUAL TABLE documents_fts USING fts5(document_id UNINDEXED,student_id UNINDEXED,title,text);
  CREATE TABLE idempotency (key TEXT PRIMARY KEY, operation TEXT NOT NULL, payload_hash TEXT NOT NULL, result_json TEXT NOT NULL) STRICT;
  CREATE TABLE import_journal (snapshot_hash TEXT PRIMARY KEY, student_id TEXT NOT NULL, committed_at TEXT NOT NULL, plan_json TEXT NOT NULL, backup_json TEXT NOT NULL) STRICT;
  PRAGMA user_version=1;
`;

/** SQLite storage is private to a single OS user and one local runtime writer.
 * It is not an authentication mechanism or an importer of arbitrary laptop files.
 */
export class LocalStore {
  #db; #lock; #repositoryRoot; #closed = false; #backups = 0;
  constructor(token, db, lock, root, identity, repositoryRoot) {
    if (token !== INTERNAL) failure('UNSUPPORTED');
    this.#db = db; this.#lock = lock; this.#repositoryRoot = repositoryRoot;
    Object.defineProperties(this, { root: { value: root, enumerable: true }, identity: { value: Object.freeze(identity), enumerable: true } });
    this.#permissions();
  }
  static open(options) {
    checkedObject(options, ['root', 'timezone', 'repositoryRoot']);
    const repositoryRoot = realpathSync(options.repositoryRoot ? resolve(options.repositoryRoot) : process.cwd());
    const root = checkedRoot(options.root, repositoryRoot);
    // Selecting an arbitrary existing folder must not change its permissions or
    // create a database beside unrelated user files. Only empty or marked roots
    // are adopted. The marker contains no identity or credentials.
    if (existsSync(root) && readdirSync(root).length) {
      const marker = join(root, ROOT_MARKER);
      if (!existsSync(marker) || owned(marker).size !== Buffer.byteLength(ROOT_MARKER_CONTENT)
        || readFileSync(marker, 'utf8') !== ROOT_MARKER_CONTENT) failure('SCOPE_DENIED');
    }
    mkdirSync(root, { recursive: true, mode: 0o700 });
    privatePath(root, true);
    if (!existsSync(join(root, ROOT_MARKER))) writeFileSync(join(root, ROOT_MARKER), ROOT_MARKER_CONTENT, { flag: 'wx', mode: 0o600 });
    privatePath(join(root, ROOT_MARKER));
    const lock = acquireLock(root);
    let db;
    try {
      const path = join(root, 'learnbridge.sqlite');
      for (const suffix of ['', '-wal', '-shm', '-journal']) if (existsSync(path + suffix)) privatePath(path + suffix);
      // Pre-create restrictively; SQLite inherits main-file mode for WAL/SHM.
      if (!existsSync(path)) { const fd = openSync(path, 'wx', 0o600); closeSync(fd); }
      db = new Database(path, { timeout: 1000 });
      db.pragma('foreign_keys=ON');
      const version = db.pragma('user_version', { simple: true });
      if (version !== 0 && version !== STORAGE_SCHEMA_VERSION) failure('VERSION_MISMATCH');
      if (version === 0) {
        if (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get().n !== 0) failure('VERSION_MISMATCH');
        const installation = createInstallation({ student_id: randomUUID(), platform: process.platform,
          data_root_ref: 'private-local-root', edition: 'local', timezone: options.timezone ?? 'UTC', setup_version: '0.1.0' });
        db.transaction(() => { db.exec(MIGRATION); db.prepare('INSERT INTO installation VALUES (1,?)').run(JSON.stringify(installation)); db.prepare('INSERT INTO schema_migrations VALUES (1,?)').run(hash(MIGRATION)); }).immediate();
      }
      validateDatabase(db);
      db.pragma('journal_mode=WAL'); db.pragma('synchronous=FULL');
      const row = db.prepare('SELECT json FROM installation WHERE singleton=1').get();
      const identity = parseInstallation(JSON.parse(row?.json));
      if (identity.edition !== 'local') failure('SCOPE_DENIED');
      return new LocalStore(INTERNAL, db, lock, root, identity, repositoryRoot);
    } catch (error) { try { db?.close(); } catch {} releaseLock(lock); throw error; }
  }
  #permissions() {
    privatePath(this.root, true);
    for (const suffix of ['', '-wal', '-shm', '-journal']) if (existsSync(join(this.root, 'learnbridge.sqlite' + suffix))) privatePath(join(this.root, 'learnbridge.sqlite' + suffix));
  }
  #active() { if (this.#closed) failure('OFFLINE'); }
  #transaction(fn) {
    this.#active();
    try { const result = this.#db.transaction(fn).immediate(); this.#permissions(); return result; }
    catch (error) { if (error instanceof LearnBridgeError || error?.name === 'LegacyStateError') throw error; failure('PROVIDER_FAILURE'); }
  }
  #record(kind, id, includeDeleted = false) {
    this.#active(); checkedId(id);
    const row = this.#db.prepare(`SELECT * FROM records WHERE kind=? AND id=? AND student_id=? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`).get(kind, id.toLowerCase(), this.identity.student_id);
    if (!row) return null;
    const value = (kind === 'task' ? parseTask : parseDocument)(JSON.parse(row.json));
    if (value.student_id !== this.identity.student_id) failure('SCOPE_DENIED');
    if (value.id !== row.id || value.revision !== row.revision || value.deleted_at !== row.deleted_at) failure('VERSION_MISMATCH');
    if (value.source_refs.length) failure('CONSENT_REQUIRED');
    return value;
  }
  #all(kind) {
    this.#active();
    return this.#db.prepare('SELECT id FROM records WHERE kind=? AND student_id=? AND deleted_at IS NULL ORDER BY id').all(kind, this.identity.student_id).map(row => this.#record(kind, row.id));
  }
  #insert(kind, record) {
    if (record.student_id !== this.identity.student_id || record.source_refs.length) failure('CONSENT_REQUIRED');
    this.#db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?)').run(kind, record.id, record.student_id, record.revision, record.deleted_at, JSON.stringify(record));
  }
  #update(kind, record, expectedRevision) {
    const result = this.#db.prepare('UPDATE records SET revision=?,deleted_at=?,json=? WHERE kind=? AND id=? AND student_id=? AND revision=? AND deleted_at IS NULL')
      .run(record.revision, record.deleted_at, JSON.stringify(record), kind, record.id, this.identity.student_id, expectedRevision);
    if (result.changes !== 1) failure('REVISION_CONFLICT');
  }
  #idempotent(operation, payload, options, fn) {
    checkedObject(options, ['idempotencyKey']);
    const key = options.idempotencyKey;
    if (key === undefined) return fn();
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(key)) invalidInput();
    const payloadHash = hash(canonicalJson(payload));
    const prior = this.#db.prepare('SELECT * FROM idempotency WHERE key=?').get(key);
    if (prior) {
      if (prior.operation !== operation || prior.payload_hash !== payloadHash) failure('REVISION_CONFLICT');
      return validateCreateResult(operation, JSON.parse(prior.result_json), this.identity.student_id);
    }
    const result = fn();
    this.#db.prepare('INSERT INTO idempotency VALUES (?,?,?,?)').run(key, operation, payloadHash, JSON.stringify(result));
    return result;
  }
  getTask(id) { return this.#record('task', id); }
  listTasks() { return this.#all('task'); }
  createTask(input, options = {}) {
    checkedObject(input, ['title', 'status', 'course_id', 'course_label', 'deadline', 'effort_minutes', 'parent_id', 'dependency_ids', 'recurrence', 'source_refs']);
    const task = createTask({ ...input, student_id: this.identity.student_id, origin: 'manual', student_overrides: [] });
    if (task.source_refs.length) failure('CONSENT_REQUIRED');
    return this.#transaction(() => this.#idempotent('task.create', input, options, () => {
      assertTaskGraph([...this.listTasks(), task]); this.#insert('task', task); return task;
    }));
  }
  updateTask(id, patch, expectedRevision) {
    checkedObject(patch, ['title', 'status', 'course_id', 'course_label', 'deadline', 'effort_minutes', 'parent_id', 'dependency_ids', 'recurrence']);
    return this.#transaction(() => {
      const prior = this.getTask(id); if (!prior) invalidInput(); assertRevision(expectedRevision, prior.revision);
      const record = parseTask({ ...prior, ...patch, revision: prior.revision + 1, updated_at: now(), student_overrides: [...new Set([...prior.student_overrides, ...Object.keys(patch)])] });
      assertTaskGraph(this.listTasks().map(task => task.id === record.id ? record : task));
      this.#update('task', record, expectedRevision); return record;
    });
  }
  deleteTask(id, expectedRevision) {
    return this.#transaction(() => {
      const prior = this.getTask(id); if (!prior) invalidInput(); assertRevision(expectedRevision, prior.revision);
      const stamp = now(); const record = parseTask({ ...prior, revision: prior.revision + 1, updated_at: stamp, deleted_at: stamp });
      assertTaskGraph(this.listTasks().filter(task => task.id !== record.id));
      this.#update('task', record, expectedRevision); return record;
    });
  }
  #revision(document, text, sequence, reason) {
    const stamp = now();
    const revision = parseDocumentRevision({ ...createDocumentRevision({ student_id: this.identity.student_id,
      document_id: document.id, content_ref: document.content_ref, sha256: hash(text), author: { kind: 'student', principal_ref: this.identity.student_id }, change_reason: reason }, { now: stamp }), revision: sequence });
    this.#db.prepare('INSERT INTO document_revisions VALUES (?,?,?,?,?,?)').run(document.id, sequence, this.identity.student_id, JSON.stringify(revision), text, revision.sha256);
    return revision;
  }
  #index(document, text) {
    this.#db.prepare('DELETE FROM documents_fts WHERE document_id=? AND student_id=?').run(document.id, this.identity.student_id);
    if (!document.deleted_at) this.#db.prepare('INSERT INTO documents_fts VALUES (?,?,?,?)').run(document.id, this.identity.student_id, document.title, text);
  }
  createDocument(input, options = {}) {
    checkedObject(input, ['title', 'text', 'kind', 'academic_policy']); boundedText(input.text);
    const id = randomUUID();
    const document = createDocument({ student_id: this.identity.student_id, title: input.title, kind: input.kind ?? 'note', course_id: null,
      current_revision: 1, source_refs: [], content_ref: `sqlite:document:${id}:1`, academic_policy: input.academic_policy ?? 'learning_support' }, { id });
    return this.#transaction(() => this.#idempotent('document.create', input, options, () => {
      this.#insert('document', document); const revision = this.#revision(document, input.text, 1, 'Created in local workspace.');
      this.#index(document, input.text); return { document, text: input.text, sha256: revision.sha256 };
    }));
  }
  listDocuments() { return this.#all('document'); }
  getDocument(id) {
    const document = this.#record('document', id); if (!document) return null;
    const row = this.#db.prepare('SELECT json,text,sha256 FROM document_revisions WHERE document_id=? AND sequence=? AND student_id=?').get(document.id, document.current_revision, this.identity.student_id);
    if (!row || hash(row.text) !== row.sha256) failure('PROVIDER_FAILURE');
    const revision = parseDocumentRevision(JSON.parse(row.json));
    if (revision.document_id !== document.id || revision.revision !== document.current_revision || revision.content_ref !== document.content_ref
      || revision.student_id !== this.identity.student_id || revision.sha256 !== row.sha256) failure('VERSION_MISMATCH');
    return { document, text: row.text, sha256: row.sha256 };
  }
  updateDocument(id, patch, expectedRevision) {
    checkedObject(patch, ['title', 'text', 'kind', 'academic_policy']); if ('text' in patch) boundedText(patch.text);
    return this.#transaction(() => {
      const current = this.getDocument(id); if (!current) invalidInput(); const prior = current.document; assertRevision(expectedRevision, prior.revision);
      const text = patch.text ?? current.text; const sequence = prior.current_revision + 1;
      const fields = { ...patch }; delete fields.text;
      const document = parseDocument({ ...prior, ...fields, revision: prior.revision + 1, updated_at: now(), current_revision: sequence, content_ref: `sqlite:document:${prior.id}:${sequence}` });
      const revision = this.#revision(document, text, sequence, 'Updated in local workspace.');
      this.#update('document', document, expectedRevision); this.#index(document, text);
      return { document, text, sha256: revision.sha256 };
    });
  }
  deleteDocument(id, expectedRevision) {
    return this.#transaction(() => {
      const current = this.getDocument(id); if (!current) invalidInput(); assertRevision(expectedRevision, current.document.revision);
      const stamp = now(); const document = parseDocument({ ...current.document, revision: current.document.revision + 1, updated_at: stamp, deleted_at: stamp });
      this.#update('document', document, expectedRevision); this.#index(document, ''); return document;
    });
  }
  listDocumentRevisions(id) {
    // Deleted document history is intentionally unavailable through normal tools.
    if (!this.#record('document', id)) return [];
    return this.#db.prepare('SELECT json,text,sha256 FROM document_revisions WHERE document_id=? AND student_id=? ORDER BY sequence').all(id.toLowerCase(), this.identity.student_id)
      .map(row => { const revision = parseDocumentRevision(JSON.parse(row.json)); if (hash(row.text) !== row.sha256 || revision.sha256 !== row.sha256) failure('PROVIDER_FAILURE'); return { revision, text: row.text, sha256: row.sha256 }; });
  }
  searchDocuments(query) {
    this.#active(); if (typeof query !== 'string' || query.length > 200 || !query.trim()) invalidInput();
    // Treat the whole input as a quoted FTS phrase; operators remain literal data.
    const phrase = `"${query.replaceAll('"', '""')}"`;
    return this.#db.prepare('SELECT document_id FROM documents_fts WHERE documents_fts MATCH ? AND student_id=? ORDER BY rank LIMIT 50').all(phrase, this.identity.student_id)
      .map(row => this.getDocument(row.document_id)).filter(Boolean);
  }
  planHostedTaskImport(input) {
    this.#active();
    const hashes = this.#db.prepare('SELECT snapshot_hash FROM import_journal WHERE student_id=?').all(this.identity.student_id).map(row => row.snapshot_hash);
    const ids = this.#db.prepare("SELECT id FROM records WHERE kind='task' AND student_id=?").all(this.identity.student_id).map(row => row.id);
    return migrateHostedTasks(input, { studentId: this.identity.student_id, importedAt: now(), timezone: this.identity.timezone, existingSnapshotHashes: hashes, existingTaskIds: ids });
  }
  commitHostedTaskImport(input, options) {
    checkedObject(options, ['snapshotHash']);
    if (typeof options.snapshotHash !== 'string' || !/^[0-9a-f]{64}$/.test(options.snapshotHash)) invalidInput();
    return this.#transaction(() => {
      const plan = this.planHostedTaskImport(input);
      if (plan.snapshot_hash !== options.snapshotHash) failure('REVISION_CONFLICT');
      if (plan.status === 'already_imported') return { status: 'already_imported', snapshot_hash: plan.snapshot_hash, imported: 0 };
      // Initial importer commits only fully reviewed, complete snapshots.
      if (plan.status !== 'ready' || plan.skipped_count || plan.warnings.some(warning => warning.code === 'DIFFERENT_SNAPSHOT_REQUIRES_REVIEW')) failure('CONSENT_REQUIRED');
      assertTaskGraph([...this.listTasks(), ...plan.records]);
      for (const record of plan.records) this.#insert('task', record);
      this.#db.prepare('INSERT INTO import_journal VALUES (?,?,?,?,?)').run(plan.snapshot_hash, this.identity.student_id, now(), JSON.stringify({ ...plan, backup: undefined }), JSON.stringify(plan.backup));
      return { status: 'committed', snapshot_hash: plan.snapshot_hash, imported: plan.pending_count, warnings: plan.warnings };
    });
  }
  integrity() {
    this.#active(); return validateDatabase(this.#db);
  }
  async backup(destination) {
    this.#active();
    const target = checkedRoot(destination, this.#repositoryRoot, { fresh: true });
    if (inside(target, this.root) || inside(this.root, target)) failure('SCOPE_DENIED');
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    // Claim the destination atomically. A losing concurrent exporter must not
    // enter cleanup and remove the winner's partially written backup folder.
    try { mkdirSync(target, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') failure('REVISION_CONFLICT'); throw error; }
    privatePath(target, true); this.#backups++;
    try {
      const path = join(target, 'learnbridge.sqlite');
      const fd = openSync(path, 'wx', 0o600); closeSync(fd);
      await this.#db.backup(path);
      privatePath(path);
      const db = new Database(path, { readonly: true, fileMustExist: true });
      let validation; try { validation = validateDatabase(db); } finally { db.close(); }
      const bytes = readFileSync(path);
      if (bytes.length > STORAGE_LIMITS.backupBytes) failure('BUDGET_EXCEEDED');
      const manifest = { format: 'learnbridge-local-backup', schema_version: STORAGE_SCHEMA_VERSION, created_at: now(), installation_id: validation.installation_id,
        student_id: validation.student_id, database: { name: 'learnbridge.sqlite', bytes: bytes.length, sha256: hash(bytes) } };
      writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      return manifest;
    } catch (error) { rmSync(target, { recursive: true, force: true }); if (error instanceof LearnBridgeError) throw error; failure('PROVIDER_FAILURE'); }
    finally { this.#backups--; }
  }
  static async restore(options) {
    checkedObject(options, ['backupRoot', 'root', 'repositoryRoot']);
    if (typeof options.backupRoot !== 'string' || !isAbsolute(options.backupRoot)) invalidInput();
    owned(options.backupRoot, true); const source = realpathSync(options.backupRoot);
    const target = checkedRoot(options.root, options.repositoryRoot, { fresh: true });
    if (inside(target, source) || inside(source, target)) failure('SCOPE_DENIED');
    const manifest = readJsonFile(join(source, 'manifest.json'), 10_000);
    checkedObject(manifest, ['format', 'schema_version', 'created_at', 'installation_id', 'student_id', 'database']);
    checkedObject(manifest.database, ['name', 'bytes', 'sha256']);
    if (manifest.format !== 'learnbridge-local-backup' || manifest.schema_version !== STORAGE_SCHEMA_VERSION || manifest.database.name !== 'learnbridge.sqlite'
      || !Number.isSafeInteger(manifest.database.bytes) || manifest.database.bytes < 1 || manifest.database.bytes > STORAGE_LIMITS.backupBytes
      || typeof manifest.database.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.database.sha256)) invalidInput();
    checkedId(manifest.student_id); checkedId(manifest.installation_id);
    const sourcePath = join(source, 'learnbridge.sqlite'); const stat = owned(sourcePath);
    if (stat.size !== manifest.database.bytes || hash(readFileSync(sourcePath)) !== manifest.database.sha256) failure('VERSION_MISMATCH');
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const stage = `${target}.restore-${randomUUID()}`; mkdirSync(stage, { mode: 0o700 });
    try {
      const path = join(stage, 'learnbridge.sqlite'); copyFileSync(sourcePath, path); privatePath(path);
      if (hash(readFileSync(path)) !== manifest.database.sha256) failure('VERSION_MISMATCH');
      const db = new Database(path, { readonly: true, fileMustExist: true });
      let validation; try { validation = validateDatabase(db); } finally { db.close(); }
      if (validation.student_id !== manifest.student_id || validation.installation_id !== manifest.installation_id) failure('VERSION_MISMATCH');
      writeFileSync(join(stage, ROOT_MARKER), ROOT_MARKER_CONTENT, { mode: 0o600, flag: 'wx' });
      if (existsSync(target)) failure('REVISION_CONFLICT'); renameSync(stage, target);
      return { status: 'restored', ...validation };
    } catch (error) { rmSync(stage, { recursive: true, force: true }); if (error instanceof LearnBridgeError) throw error; failure('PROVIDER_FAILURE'); }
  }
  close() {
    if (this.#closed) return; if (this.#backups) failure('REVISION_CONFLICT');
    let firstError;
    try { this.#db.pragma('wal_checkpoint(TRUNCATE)'); } catch (error) { firstError = error; }
    // A failed checkpoint is not a reason to keep the connection alive while
    // giving its writer claim to another runtime. Preserve the first failure.
    try { this.#db.close(); } catch (error) { firstError ??= error; }
    this.#closed = !this.#db.open;
    if (this.#closed) releaseLock(this.#lock);
    if (firstError) throw firstError;
  }
}

function validateDatabase(db) {
  if (db.pragma('user_version', { simple: true }) !== STORAGE_SCHEMA_VERSION) failure('VERSION_MISMATCH');
  const ledger = db.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all();
  if (ledger.length !== 1 || ledger[0].version !== STORAGE_SCHEMA_VERSION || ledger[0].checksum !== hash(MIGRATION)
    || schemaFingerprint(db) !== expectedSchemaFingerprint()) failure('VERSION_MISMATCH');
  if (db.pragma('integrity_check', { simple: true }) !== 'ok' || db.pragma('foreign_key_check').length) failure('PROVIDER_FAILURE');
  const installation = parseInstallation(JSON.parse(db.prepare('SELECT json FROM installation WHERE singleton=1').get()?.json));
  if (installation.edition !== 'local') failure('SCOPE_DENIED');
  const records = db.prepare('SELECT * FROM records ORDER BY kind,id').all();
  const tasks = []; let documents = 0;
  for (const row of records) {
    const record = (row.kind === 'task' ? parseTask : parseDocument)(JSON.parse(row.json));
    if (record.id !== row.id || record.student_id !== row.student_id || record.student_id !== installation.student_id || record.revision !== row.revision || record.deleted_at !== row.deleted_at || record.source_refs.length) failure('SCOPE_DENIED');
    if (row.kind === 'task') { if (!record.deleted_at) tasks.push(record); }
    else {
      documents++;
      const revisions = db.prepare('SELECT * FROM document_revisions WHERE document_id=? ORDER BY sequence').all(record.id);
      if (revisions.length !== record.current_revision) failure('VERSION_MISMATCH');
      for (const [index, saved] of revisions.entries()) {
        const revision = parseDocumentRevision(JSON.parse(saved.json));
        if (saved.sequence !== index + 1 || revision.revision !== saved.sequence || saved.student_id !== installation.student_id || revision.student_id !== installation.student_id
          || revision.document_id !== record.id || saved.sha256 !== revision.sha256 || hash(saved.text) !== saved.sha256
          || revision.content_ref !== `sqlite:document:${record.id}:${saved.sequence}`) failure('VERSION_MISMATCH');
      }
      if (record.content_ref !== `sqlite:document:${record.id}:${record.current_revision}`) failure('VERSION_MISMATCH');
    }
  }
  assertTaskGraph(tasks);
  const indexed = db.prepare('SELECT document_id,student_id,title,text FROM documents_fts ORDER BY document_id').all();
  const liveDocuments = records.filter(row => row.kind === 'document' && row.deleted_at === null);
  if (indexed.length !== liveDocuments.length) failure('VERSION_MISMATCH');
  for (const row of indexed) {
    const saved = liveDocuments.find(record => record.id === row.document_id);
    if (!saved || row.student_id !== installation.student_id) failure('SCOPE_DENIED');
    const document = parseDocument(JSON.parse(saved.json));
    const current = db.prepare('SELECT text FROM document_revisions WHERE document_id=? AND sequence=?').get(document.id, document.current_revision);
    if (row.title !== document.title || row.text !== current?.text) failure('VERSION_MISMATCH');
  }
  const journal = db.prepare('SELECT snapshot_hash,student_id,plan_json,backup_json FROM import_journal').all();
  for (const entry of journal) {
    if (entry.student_id !== installation.student_id) failure('SCOPE_DENIED');
    const savedPlan = JSON.parse(entry.plan_json); const backup = JSON.parse(entry.backup_json);
    if (savedPlan.snapshot_hash !== entry.snapshot_hash || backup.snapshot_hash !== entry.snapshot_hash
      || savedPlan.status !== 'ready' || savedPlan.deferred_count !== 0) failure('VERSION_MISMATCH');
    const recomputed = migrateHostedTasks(backup.original_text ?? backup.original_input, { studentId: installation.student_id, importedAt: backup.imported_at, timezone: installation.timezone });
    if (recomputed.snapshot_hash !== entry.snapshot_hash || JSON.stringify(recomputed.backup) !== JSON.stringify(backup)
      || JSON.stringify({ ...recomputed, backup: undefined }) !== JSON.stringify(savedPlan)) failure('VERSION_MISMATCH');
  }
  for (const entry of db.prepare('SELECT operation,result_json FROM idempotency').all()) validateCreateResult(entry.operation, JSON.parse(entry.result_json), installation.student_id);
  if (db.prepare('SELECT count(*) AS n FROM document_revisions WHERE document_id NOT IN (SELECT id FROM records WHERE kind=\'document\')').get().n !== 0) failure('VERSION_MISMATCH');
  return { integrity: 'ok', schema_version: STORAGE_SCHEMA_VERSION, installation_id: installation.id, student_id: installation.student_id, task_count: tasks.length, document_count: documents };
}

let schemaReference;
function schemaFingerprint(db) {
  return hash(JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()));
}
function expectedSchemaFingerprint() {
  if (schemaReference) return schemaReference;
  const fixture = new Database(':memory:');
  try { fixture.exec(MIGRATION); schemaReference = schemaFingerprint(fixture); return schemaReference; } finally { fixture.close(); }
}

function validateCreateResult(operation, result, studentId) {
  if (operation === 'task.create') {
    const task = parseTask(result);
    if (task.student_id !== studentId || task.source_refs.length) failure('SCOPE_DENIED');
    return task;
  }
  if (operation === 'document.create') {
    checkedObject(result, ['document', 'text', 'sha256']); const document = parseDocument(result.document); boundedText(result.text);
    if (document.student_id !== studentId || document.source_refs.length || hash(result.text) !== result.sha256) failure('SCOPE_DENIED');
    return { document, text: result.text, sha256: result.sha256 };
  }
  failure('VERSION_MISMATCH');
}

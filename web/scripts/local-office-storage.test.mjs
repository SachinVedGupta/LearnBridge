import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { LocalStore, STORAGE_SCHEMA_VERSION } from '../packages/local-storage/src/index.mjs';
import { validateOfficeProvenance, OFFICE_PROVENANCE_LIMITS } from '../packages/local-storage/src/office-provenance.mjs';
import { createInstallation, createTask } from '../packages/core/src/index.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const storageSource = readFileSync(new URL('../packages/local-storage/src/index.mjs', import.meta.url), 'utf8');
const migration = n => new RegExp('const MIGRATION' + (n === 1 ? '' : '_V' + n) + ' = `([\\s\\S]*?)`;', 'u').exec(storageSource)[1];
const moduleUrl = new URL('../packages/local-storage/src/index.mjs', import.meta.url).href;
const historicalChecksums = [
  '9ad0f0e2852466afb58b2763567ed371005632164b14a9dad94723b539ca2c41',
  '993a183debe4f6641f168f024c32bba6f9f1e887e0b043bdc36a7e63baa20bcb',
  'c45fb5769c186502549d521d405c8e258a677a13505f11c81a178a6309de52a8',
  'e83edbe67f1352d7d740f9bd35703239393a0d04574cc8ae1192119760590967',
];
function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-office-storage-')), root = join(parent, 'workspace'), store = LocalStore.open({ root });
  t.after(() => { store.close(); rmSync(parent, { recursive: true, force: true }); });
  return { parent, root, store };
}
function extracted(kind = 'docx', bodies = [kind.toUpperCase(), 'A synthetic explanation. café 🧠', kind.toUpperCase()]) {
  const unit = kind === 'docx' ? 'paragraph' : 'slide', label = kind === 'pdf' ? 'PDF page' : `${kind.toUpperCase()} ${unit}`;
  let cursor = 0;
  const sections = bodies.map((text, index) => {
    cursor += (index ? 2 : 0) + Buffer.byteLength(`[${label} ${index + 1}]\n`);
    const start = cursor; cursor += Buffer.byteLength(text);
    return { position: index + 1, unit, text, sha256: sha(text), byte_range: { start, end: cursor } };
  });
  const text = sections.map(section => `[${label} ${section.position}]\n${section.text}`).join('\n\n');
  if (kind === 'pdf') return { text, pdf: { schema_version: 1, format: 'pdf_text', parser_version: 'macos_pdfkit.v1', source_sha256: sha(Buffer.alloc(400)), source_bytes: 400,
    page_count: sections.length, pages: sections.map(({ position, unit: _unit, ...page }) => ({ physical_page: position, printed_label: null, ...page })), extraction_status: 'available', coverage: { state: 'complete', reasons: [] } } };
  return { text, office: { schema_version: 1, format: 'office_text', parser_version: 'stdlib_ooxml.v1', document_type: kind,
    source_sha256: sha(Buffer.alloc(400)), source_bytes: 400, section_count: sections.length, sections,
    extraction_status: 'available', coverage: { state: 'partial', reasons: ['layout_not_preserved'] } } };
}
function selection(kind = 'docx') {
  const descriptor = { schema_version: 1, kind: 'local-directory', root: '/synthetic-selected-office-root', label: 'Synthetic selected source', identity: { dev: '10', ino: '20' }, version: sha('synthetic descriptor') };
  const entryId = randomUUID(), version = sha(`synthetic ${kind} file metadata`), title = `lecture.${kind}`;
  const inventory = { schema_version: 1, id: randomUUID(), source_version: descriptor.version, version: sha('synthetic inventory'),
    entries: [{ id: entryId, relativePath: title, kind, title, snapshot: { dev: '10', ino: '21', size: 400, mtimeNs: '100', ctimeNs: '100', nlink: 1, version },
      directories: [{ relativePath: '', identity: { dev: '10', ino: '20', mtimeNs: '90', ctimeNs: '90' } }] }],
    counts: { entriesVisited: 1, directoriesVisited: 1, eligibleFiles: 1, excludedEntries: 0, totalBytes: 400 },
    exclusions: { secret: 0, symlink: 0, special: 0, unsupportedType: 0, hardlink: 0, depth: 0, permission: 0, changed: 0 },
    budget: { maxEntries: 100, maxFiles: 100, maxDepth: 3 }, coverage: { state: 'complete', reasons: [] }, retrieved_at: new Date().toISOString() };
  const value = extracted(kind);
  return { descriptor, inventory, input: { inventory_id: inventory.id, entry_id: entryId, title, version, ...value, sha256: sha(value.text) } };
}
function selected(store, kind = 'docx') {
  const value = selection(kind), source = store.createSource({ label: value.descriptor.label, descriptor: value.descriptor });
  store.saveSourceInventory(source.id, value.inventory);
  return { source, input: { source_id: source.id, ...value.input } };
}
function assertRows(root, expected) {
  const db = new Database(join(root, 'learnbridge.sqlite'), { readonly: true, fileMustExist: true });
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM source_entries').get().n, expected);
    assert.equal(db.prepare('SELECT count(*) AS n FROM source_office_provenance').get().n, expected);
    assert.equal(db.prepare('SELECT count(*) AS n FROM source_entries e LEFT JOIN source_office_provenance p ON p.entry_id=e.id WHERE p.entry_id IS NULL').get().n, 0);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally { db.close(); }
}
function retryOnce(root, input) {
  const store = LocalStore.open({ root });
  try {
    assert.equal(store.listSourceEntries().length, 0); assert.equal(store.integrity().source_office_provenance_count, 0);
    const saved = store.importSourceEntry(input); assert.equal(store.importSourceEntry(input).id, saved.id);
    assert.deepEqual(store.getSourceEntry(saved.id).office, input.office);
    assert.equal(store.integrity().source_office_provenance_count, 1);
  } finally { store.close(); }
  assertRows(root, 1);
}

test('Office provenance binds exact ordered UTF-8 paragraph/slide bodies, excluding repeated headers and other sections', () => {
  for (const kind of ['docx', 'pptx']) {
    const { text, office } = extracted(kind);
    assert.deepEqual(validateOfficeProvenance(office, text, 400, kind), office);
    const header = text.indexOf(office.sections[0].text);
    assert.throws(() => validateOfficeProvenance({ ...office, sections: [{ ...office.sections[0], byte_range: { start: header, end: header + 4 } }, ...office.sections.slice(1)] }, text, 400, kind), { code: 'VERSION_MISMATCH' });
    assert.throws(() => validateOfficeProvenance({ ...office, sections: [...office.sections.slice(0, 2), { ...office.sections[2], byte_range: office.sections[0].byte_range }] }, text, 400, kind));
    assert.throws(() => validateOfficeProvenance(office, text + 'UNREFERENCED', 400, kind), { code: 'VERSION_MISMATCH' });
    assert.throws(() => validateOfficeProvenance({ ...office, sections: office.sections.map((section, i) => i === 1 ? { ...section, sha256: '0'.repeat(64) } : section) }, text, 400, kind), { code: 'VERSION_MISMATCH' });
  }
});

test('Office provenance denies wrong types, unavailable extraction, complete claims, unsafe objects and bounded payload violations', () => {
  const { text, office } = extracted();
  const altered = [
    { ...office, schema_version: 2 }, { ...office, parser_version: 'external_parser' }, { ...office, source_bytes: 401 },
    { ...office, source_bytes: 4_000_001 }, { ...office, source_sha256: 'invalid' }, { ...office, document_type: 'pptx' },
    { ...office, extraction_status: 'encrypted' }, { ...office, section_count: 0 }, { ...office, section_count: 1001 },
    { ...office, coverage: { state: 'complete', reasons: [] } }, { ...office, coverage: { state: 'partial', reasons: ['unknown_omission'] } },
    { ...office, coverage: { state: 'partial', reasons: ['layout_not_preserved', 'layout_not_preserved'] } },
    { ...office, coverage: { state: 'partial', reasons: ['layout_not_preserved', 'UPPER'] } },
    { ...office, sections: [{ ...office.sections[0], unit: 'slide' }, ...office.sections.slice(1)] },
    { ...office, sections: [{ ...office.sections[0], position: 2 }, ...office.sections.slice(1)] },
    { ...office, unexpected: true }, { ...office, sections: [{ ...office.sections[0], extra: true }, ...office.sections.slice(1)] },
    extracted('docx', ['x'.repeat(OFFICE_PROVENANCE_LIMITS.metadataBytes)]).office,
  ];
  for (const value of altered) assert.throws(() => validateOfficeProvenance(value, text, 400, 'docx'));
  assert.throws(() => validateOfficeProvenance(office, 'x'.repeat(OFFICE_PROVENANCE_LIMITS.textBytes + 1), 400, 'docx'), { code: 'INVALID_INPUT' });
  let calls = 0; const getter = { ...office }; Object.defineProperty(getter, 'sections', { enumerable: true, get() { calls++; return office.sections; } });
  assert.throws(() => validateOfficeProvenance(getter, text, 400, 'docx')); assert.equal(calls, 0);
  const cycle = { ...office }; cycle.sections = [cycle]; assert.throws(() => validateOfficeProvenance(cycle, text));
  const sparse = { ...office, sections: new Array(3) }; assert.throws(() => validateOfficeProvenance(sparse, text));
  const symbol = { ...office, [Symbol('hidden')]: 1 }; assert.throws(() => validateOfficeProvenance(symbol, text));
  const prototype = Object.assign(Object.create({ inherited: true }), office); assert.throws(() => validateOfficeProvenance(prototype, text));
});

test('selected DOCX/PPTX snapshots persist exact provenance, immutable retries and body-free metadata across reopen', t => {
  const { root, store } = fixture(t); const saved = [];
  for (const kind of ['docx', 'pptx']) {
    const { input } = selected(store, kind), imported = store.importSourceEntry(input);
    saved.push(imported); assert.deepEqual(imported.office, input.office);
    assert.equal(store.importSourceEntry(input).id, imported.id);
    assert.throws(() => store.importSourceEntry({ ...input, office: { ...input.office, source_sha256: '1'.repeat(64) } }), { code: 'REVISION_CONFLICT' });
    const mutated = store.getSourceEntry(imported.id); mutated.office.sections[0].text = 'Changed returned copy';
    assert.deepEqual(store.getSourceEntry(imported.id).office, input.office);
  }
  const metadata = store.listSourceEntries(); assert.equal(metadata.length, 2);
  for (const entry of metadata) {
    assert.equal('text' in entry, false); assert.equal('sections' in entry.office, false);
    assert.equal(JSON.stringify(entry).includes('synthetic explanation'), false);
    assert.equal(entry.office.coverage.state, 'partial'); assert.equal(entry.office.section_count, 3);
  }
  store.close(); const reopened = LocalStore.open({ root });
  try { for (const entry of saved) assert.deepEqual(reopened.getSourceEntry(entry.id), entry); assert.equal(reopened.integrity().source_office_provenance_count, 2); }
  finally { reopened.close(); }
});

test('Office input requires the correct selected kind and unavailable or missing provenance saves no source entry', t => {
  const { store } = fixture(t), { input } = selected(store);
  for (const changed of [
    { ...input, office: undefined }, { ...input, office: { ...input.office, extraction_status: 'text_unavailable' } },
    { ...input, office: { ...input.office, document_type: 'pptx' } }, { ...input, pdf: extracted('pdf').pdf },
  ]) assert.throws(() => store.importSourceEntry(changed));
  const { input: pdf } = selected(store, 'pdf'); assert.throws(() => store.importSourceEntry({ ...pdf, office: input.office }));
  const textSelection = selection(); textSelection.inventory.entries[0].kind = 'text';
  const textSource = store.createSource({ label: textSelection.descriptor.label, descriptor: textSelection.descriptor }); store.saveSourceInventory(textSource.id, textSelection.inventory);
  assert.throws(() => store.importSourceEntry({ source_id: textSource.id, ...textSelection.input }));
  assert.equal(store.listSourceEntries().length, 0); assert.equal(store.integrity().source_office_provenance_count, 0);
});

test('selected agent context includes immutable Office evidence only with a current source grant; source revocation denies it', t => {
  const { store } = fixture(t), { source, input } = selected(store, 'pptx'), imported = store.importSourceEntry(input);
  const grant = store.createAgentGrant({ destination: 'codex', task_ids: [], document_ids: [], source_entry_ids: [imported.id], max_bytes: 48000, expires_in_minutes: 10 });
  const context = store.agentContext({ destination: 'codex', grant_id: grant.id });
  assert.deepEqual(context.source_entries[0].office, input.office); assert.equal(context.source_entries[0].trust, 'untrusted_source_content');
  assert.equal(JSON.stringify(context).includes('/synthetic-selected-office-root'), false);
  assert.throws(() => store.agentContext({ destination: 'claude', grant_id: grant.id }), { code: 'SCOPE_DENIED' });
  store.revokeSource(source.id, source.revision);
  assert.throws(() => store.getSourceEntry(imported.id), { code: 'CONSENT_REQUIRED' });
  assert.throws(() => store.agentContext({ destination: 'codex', grant_id: grant.id }), { code: 'CONSENT_REQUIRED' });
  assert.deepEqual(store.listSourceEntries(), []); assert.equal(store.integrity().source_office_provenance_count, 1);
});

test('actual Office provenance SQL abort rolls back both tables; reopen and exact duplicate retry import one', t => {
  const { root, store } = fixture(t), { input } = selected(store), injector = new Database(join(root, 'learnbridge.sqlite'));
  const original = Database.prototype.prepare; let nativeError;
  try {
    injector.exec(`CREATE TRIGGER synthetic_office_abort BEFORE INSERT ON source_office_provenance BEGIN
      SELECT CASE WHEN EXISTS(SELECT 1 FROM source_entries WHERE id=NEW.entry_id)
      THEN RAISE(ABORT,'synthetic Office two-table SQL abort') ELSE RAISE(ABORT,'missed Office boundary') END;
    END;`);
    Database.prototype.prepare = function(sql) { const statement = original.call(this, sql);
      if (sql === 'INSERT INTO source_office_provenance VALUES (?,?,?,?)') return { run(...args) { try { return statement.run(...args); } catch (error) { nativeError = error; throw error; } } };
      return statement;
    };
    assert.throws(() => store.importSourceEntry(input), { code: 'PROVIDER_FAILURE' });
    assert.equal(nativeError?.code, 'SQLITE_CONSTRAINT_TRIGGER'); assert.equal(nativeError?.message, 'synthetic Office two-table SQL abort');
  } finally { Database.prototype.prepare = original; injector.exec('DROP TRIGGER IF EXISTS synthetic_office_abort'); injector.close(); }
  assert.equal(store.listSourceEntries().length, 0); assert.equal(store.integrity().source_office_provenance_count, 0);
  store.close(); assertRows(root, 0); retryOnce(root, input);
});

test('actual child SIGKILL between Office entry/provenance inserts leaves no orphan; exact retry imports once', t => {
  const { root, store } = fixture(t), { input } = selected(store, 'pptx'); store.close();
  const code = `import{LocalStore}from${JSON.stringify(moduleUrl)};import Database from'better-sqlite3';import{writeSync}from'node:fs';
    const original=Database.prototype.prepare;Database.prototype.prepare=function(sql){const statement=original.call(this,sql);
    if(sql==='INSERT INTO source_office_provenance VALUES (?,?,?,?)'){const db=this;return{run(...args){
      if(original.call(db,'SELECT count(*) AS n FROM source_entries WHERE id=?').get(args[0]).n!==1)throw new Error('missed Office boundary');
      writeSync(1,'OFFICE_TWO_TABLE_BOUNDARY\\n');process.kill(process.pid,'SIGKILL');}};}return statement;};
    const store=LocalStore.open({root:${JSON.stringify(root)}});store.importSourceEntry(${JSON.stringify(input)});`;
  const env = Object.fromEntries(['PATH', 'TMPDIR', 'TEMP', 'TMP'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10000 });
  assert.equal(child.signal, 'SIGKILL'); assert.equal(child.stdout, 'OFFICE_TWO_TABLE_BOUNDARY\n'); assert.equal(child.stderr, '');
  assertRows(root, 0); retryOnce(root, input);
});

function legacyV4(parent) {
  const root = join(parent, 'legacy-v4'); mkdirSync(root, { mode: 0o700 }); writeFileSync(join(root, '.learnbridge-local-root'), 'learnbridge-local-data-v1\n', { mode: 0o600 });
  const installation = createInstallation({ student_id: randomUUID(), platform: process.platform, data_root_ref: 'private-local-root', edition: 'local', timezone: 'UTC', setup_version: '0.1.0' });
  const task = createTask({ student_id: installation.student_id, title: 'Legacy v4 synthetic task' }), value = selection('pdf');
  const sourceId = randomUUID(), entryId = randomUUID(), timestamp = new Date().toISOString(), db = new Database(join(root, 'learnbridge.sqlite'));
  try {
    for (let n = 1; n <= 4; n++) { db.exec(migration(n)); db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(n, historicalChecksums[n - 1]); }
    db.prepare('INSERT INTO installation VALUES (1,?)').run(JSON.stringify(installation));
    db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?)').run('task', task.id, installation.student_id, task.revision, null, JSON.stringify(task));
    db.prepare('INSERT INTO sources VALUES (?,?,?,?,?,?,?,?)').run(sourceId, installation.student_id, 1, 'active', value.descriptor.label, JSON.stringify(value.descriptor), timestamp, timestamp);
    db.prepare('INSERT INTO source_inventories VALUES (?,?,?,?,?,?)').run(value.inventory.id, sourceId, installation.student_id, JSON.stringify(value.inventory), sha(canonical(value.inventory)), timestamp);
    db.prepare('INSERT INTO source_entries VALUES (?,?,?,?,?,?,?,?,?,?)').run(entryId, sourceId, value.inventory.id, value.input.entry_id, installation.student_id, value.input.version, value.input.sha256, value.input.title, value.input.text, timestamp);
    const encoded = canonical(value.input.pdf); db.prepare('INSERT INTO source_provenance VALUES (?,?,?,?)').run(entryId, installation.student_id, encoded, sha(encoded));
  } finally { db.close(); }
  return { root, installation, task, pdf: value.input.pdf, entryId, text: value.input.text };
}

test('additive v4→v5 upgrade preserves literal historical checksums, identity, task and existing PDF bodies/provenance', t => {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-office-upgrade-')); t.after(() => rmSync(parent, { recursive: true, force: true }));
  const old = legacyV4(parent), store = LocalStore.open({ root: old.root });
  try {
    assert.deepEqual(store.identity, old.installation); assert.deepEqual(store.getTask(old.task.id), old.task);
    assert.deepEqual(store.getSourceEntry(old.entryId).pdf, old.pdf); assert.equal(store.getSourceEntry(old.entryId).text, old.text);
    assert.equal(store.integrity().schema_version, 5); assert.equal(store.integrity().source_provenance_count, 1); assert.equal(store.integrity().source_office_provenance_count, 0);
  } finally { store.close(); }
  const db = new Database(join(old.root, 'learnbridge.sqlite'));
  try { const ledger = db.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all(); assert.equal(ledger.length, 5);
    for (let n = 1; n <= 4; n++) { assert.equal(ledger[n - 1].checksum, historicalChecksums[n - 1]); assert.equal(sha(migration(n)), historicalChecksums[n - 1]); }
    assert.equal(ledger[4].checksum, sha(migration(5)));
  } finally { db.close(); }
});

test('SIGKILL during v5 migration keeps valid v4/PDF state and safely upgrades on reopen', t => {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-office-migration-kill-')); t.after(() => rmSync(parent, { recursive: true, force: true }));
  const old = legacyV4(parent);
  const code = `import{LocalStore}from${JSON.stringify(moduleUrl)};import Database from'better-sqlite3';const original=Database.prototype.prepare;
    Database.prototype.prepare=function(sql){if(sql==='INSERT INTO schema_migrations VALUES (5,?)')return{run(){process.kill(process.pid,'SIGKILL');}};return original.call(this,sql);};LocalStore.open({root:${JSON.stringify(old.root)}});`;
  const env = Object.fromEntries(['PATH', 'TMPDIR', 'TEMP', 'TMP'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, cwd: new URL('..', import.meta.url), timeout: 10000 }); assert.equal(child.signal, 'SIGKILL');
  const db = new Database(join(old.root, 'learnbridge.sqlite'));
  try { assert.equal(db.pragma('user_version', { simple: true }), 4); assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='source_office_provenance'").get().n, 0); }
  finally { db.close(); }
  const store = LocalStore.open({ root: old.root });
  try { assert.deepEqual(store.identity, old.installation); assert.deepEqual(store.getSourceEntry(old.entryId).pdf, old.pdf); assert.equal(store.integrity().schema_version, 5); }
  finally { store.close(); }
});

function writeManifest(backup, identity, version) {
  const bytes = readFileSync(join(backup, 'learnbridge.sqlite'));
  writeFileSync(join(backup, 'manifest.json'), JSON.stringify({ format: 'learnbridge-local-backup', schema_version: version, created_at: new Date().toISOString(),
    installation_id: identity.id, student_id: identity.student_id, database: { name: 'learnbridge.sqlite', bytes: bytes.length, sha256: sha(bytes) } }), { mode: 0o600 });
}
test('unchanged v4 PDF backup restores as v4 then upgrades with exact evidence and original checksums', async t => {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-office-v4-backup-')); t.after(() => rmSync(parent, { recursive: true, force: true }));
  const old = legacyV4(parent); writeManifest(old.root, old.installation, 4);
  const before = sha(readFileSync(join(old.root, 'learnbridge.sqlite'))), restored = join(parent, 'restored');
  const result = await LocalStore.restore({ backupRoot: old.root, root: restored }); assert.equal(result.schema_version, 4);
  assert.equal(sha(readFileSync(join(old.root, 'learnbridge.sqlite'))), before);
  const store = LocalStore.open({ root: restored });
  try { assert.deepEqual(store.getSourceEntry(old.entryId).pdf, old.pdf); assert.deepEqual(store.getTask(old.task.id), old.task); assert.equal(store.integrity().schema_version, STORAGE_SCHEMA_VERSION); }
  finally { store.close(); }
});

test('v5 backup restores exact Office/PDF evidence and immutable provenance triggers', async t => {
  const { parent, store } = fixture(t), saved = ['docx', 'pptx', 'pdf'].map(kind => store.importSourceEntry(selected(store, kind).input));
  const backup = join(parent, 'backup'); await store.backup(backup);
  const restored = join(parent, 'restored'); await LocalStore.restore({ backupRoot: backup, root: restored }); const copy = LocalStore.open({ root: restored });
  try { for (const entry of saved) assert.deepEqual(copy.getSourceEntry(entry.id), entry); assert.equal(copy.integrity().source_office_provenance_count, 2); assert.equal(copy.integrity().source_provenance_count, 1); }
  finally { copy.close(); }
  const db = new Database(join(backup, 'learnbridge.sqlite'));
  try {
    assert.throws(() => db.prepare('UPDATE source_office_provenance SET json=?').run('{}'), /immutable source office provenance/);
    assert.throws(() => db.prepare('DELETE FROM source_office_provenance').run(), /immutable source office provenance/);
  } finally { db.close(); }
});

test('rehashed backup with corrupt Office original-size evidence is rejected before restore promotion', async t => {
  const { parent, store } = fixture(t); store.importSourceEntry(selected(store).input); const backup = join(parent, 'backup'); await store.backup(backup);
  const db = new Database(join(backup, 'learnbridge.sqlite'));
  try {
    const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE name='immutable_source_office_provenance_update'").get().sql;
    const row = db.prepare('SELECT * FROM source_office_provenance').get(), office = JSON.parse(row.json); office.source_bytes++;
    const encoded = canonical(office); db.exec('DROP TRIGGER immutable_source_office_provenance_update');
    db.prepare('UPDATE source_office_provenance SET json=?,sha256=? WHERE entry_id=?').run(encoded, sha(encoded), row.entry_id); db.exec(trigger);
  } finally { db.close(); }
  writeManifest(backup, store.identity, 5); const destination = join(parent, 'rejected');
  await assert.rejects(LocalStore.restore({ backupRoot: backup, root: destination })); assert.equal(existsSync(destination), false);
  assert.equal(store.integrity().source_office_provenance_count, 1);
});

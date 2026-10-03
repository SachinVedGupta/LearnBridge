import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createTask, createDocument, createDocumentRevision, parseTask, parseDocument, parseDocumentRevision } from '../src/contracts.mjs';

// W01 demonstration only: JSON files in a newly created synthetic fixture.
// This is not a repository implementation, daemon, backup format, or student
// storage path. It reads no existing files/accounts and accepts no data root.
const DEMO_KIND = 'core_contract_fixture_round_trip';
const PREFIX = 'learnbridge-core-fixture-';
const MARKER = '.learnbridge-fixture.json';
const STUDENT_ID = 'a3ace0a1-f07c-4d57-b900-16cb3c664171';
const NOW = '2026-10-02T15:00:00.000Z';
const CONTRACT_URL = new URL('../src/contracts.mjs', import.meta.url).href;

function file(root, name, value) {
  writeFileSync(join(root, name), value, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

function fixtureRecords() {
  const content = '# Synthetic study note\n\nRecursion reduces a problem to a smaller instance.\n';
  const contentHash = createHash('sha256').update(content).digest('hex');
  const document = createDocument({
    student_id: STUDENT_ID,
    title: 'Synthetic recursion note',
    kind: 'study',
    current_revision: 1,
    content_ref: 'fixture-content:recursion-v1',
    source_refs: [],
    academic_policy: 'learning_support',
  }, { id: '86c9bc52-d147-4a04-8078-43b38362b919', now: NOW });
  const revision = createDocumentRevision({
    student_id: STUDENT_ID,
    document_id: document.id,
    content_ref: document.content_ref,
    sha256: contentHash,
    author: { kind: 'student', principal_ref: STUDENT_ID },
    change_reason: 'Synthetic W01 fixture; no real student data.',
  }, { id: 'c99d8fa9-1e4f-43ee-afd0-bfa4b2dc621e', now: NOW });
  const task = createTask({
    student_id: STUDENT_ID,
    title: 'Review the synthetic recursion note',
    status: 'pending',
    source_refs: [],
    deadline: { precision: 'date', date: '2026-10-15', timezone: 'America/Toronto' },
    origin: 'manual',
  }, { id: 'ed15f46e-a248-43c8-abeb-0e3de817b30b', now: NOW });
  assert.deepEqual(parseTask(task), task);
  assert.deepEqual(parseDocument(document), document);
  assert.deepEqual(parseDocumentRevision(revision), revision);
  assert.equal(Object.isFrozen(revision) && Object.isFrozen(revision.author), true);
  return { records: { schema_version: 1, tasks: [task], documents: [document], document_revisions: [revision] }, content };
}

function verifyInFreshProcess(root, marker, records, content) {
  // Only reviewed code and synthetic values enter the child. No full process
  // environment, NODE_OPTIONS, provider credentials, shell, or agent is used.
  const code = `
    import assert from 'node:assert/strict';
    import { createHash } from 'node:crypto';
    import { lstatSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
    import { join } from 'node:path';
    import { parseTask, parseDocument, parseDocumentRevision } from ${JSON.stringify(CONTRACT_URL)};
    const root = ${JSON.stringify(root)};
    const marker = ${JSON.stringify(marker)};
    const expected = ${JSON.stringify(records)};
    // macOS may inject its CoreFoundation text-encoding hint after spawn.
    // Everything supplied by LearnBridge is still explicitly allowlisted.
    assert(Object.keys(process.env).every(key => ['TZ', '__CF_USER_TEXT_ENCODING'].includes(key)));
    assert.equal(process.env.TZ, 'UTC');
    assert.equal(realpathSync(root), root);
    assert.equal(lstatSync(root).isDirectory(), true);
    assert.equal(lstatSync(root).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(root).sort(), ['.learnbridge-fixture.json', 'content.md', 'records.json']);
    for (const name of ['.learnbridge-fixture.json', 'content.md', 'records.json']) {
      const stat = lstatSync(join(root, name));
      assert.equal(stat.isFile() && !stat.isSymbolicLink(), true);
      assert.equal(stat.mode & 0o777, 0o600);
      assert(stat.size <= 32_000);
    }
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.learnbridge-fixture.json'), 'utf8')), marker);
    const raw = JSON.parse(readFileSync(join(root, 'records.json'), 'utf8'));
    assert.deepEqual(raw, expected);
    const tasks = raw.tasks.map(parseTask);
    const documents = raw.documents.map(parseDocument);
    const revisions = raw.document_revisions.map(parseDocumentRevision);
    assert.deepEqual({ schema_version: 1, tasks, documents, document_revisions: revisions }, expected);
    assert.equal(tasks.length, 1);
    assert.equal(documents.length, 1);
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].document_id, documents[0].id);
    assert.equal(revisions[0].student_id, documents[0].student_id);
    assert.equal(revisions[0].revision, documents[0].current_revision);
    assert.equal(revisions[0].content_ref, documents[0].content_ref);
    assert.equal(Object.isFrozen(revisions[0]) && Object.isFrozen(revisions[0].author), true);
    const content = readFileSync(join(root, 'content.md'), 'utf8');
    assert.equal(content, ${JSON.stringify(content)});
    assert.equal(createHash('sha256').update(content).digest('hex'), revisions[0].sha256);
    process.stdout.write(JSON.stringify({ status: 'PASS', tasks: 1, documents: 1, document_revisions: 1, content_hash_matches: true, records_equal_after_restart: true, revision_immutable: true, private_file_modes: true, child_environment_allowlisted: true }));
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '--eval', code], {
    cwd: root,
    env: { TZ: 'UTC' },
    timeout: 5_000,
    maxBuffer: 32_000,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const proof = JSON.parse(output);
  assert.deepEqual(proof, {
    status: 'PASS', tasks: 1, documents: 1, document_revisions: 1,
    content_hash_matches: true, records_equal_after_restart: true,
    revision_immutable: true, private_file_modes: true, child_environment_allowlisted: true,
  });
  return proof;
}

let root = null;
let marker = null;
let rootIdentity = null;
let report;
let cleanupComplete = false;
let failureCode = 'FIXTURE_VERIFICATION_FAILED';
try {
  if (process.argv.length !== 2) {
    failureCode = 'INVALID_ARGUMENTS';
    throw new Error('This synthetic demo accepts no arguments.');
  }
  if (!['darwin', 'linux'].includes(process.platform)) {
    failureCode = 'UNSUPPORTED_PERMISSION_PLATFORM';
    throw new Error('POSIX private-file permission proof is required.');
  }
  root = realpathSync(mkdtempSync(join(tmpdir(), PREFIX)));
  rootIdentity = lstatSync(root);
  chmodSync(root, 0o700);
  const newMarker = { kind: DEMO_KIND, token: randomBytes(24).toString('hex') };
  file(root, MARKER, JSON.stringify(newMarker));
  marker = newMarker;
  const { records, content } = fixtureRecords();
  file(root, 'records.json', JSON.stringify(records));
  file(root, 'content.md', content);
  const proof = verifyInFreshProcess(root, marker, records, content);
  report = {
    schema_version: 1,
    kind: DEMO_KIND,
    status: 'PASS',
    evidence_type: 'synthetic_fixture',
    platform: process.platform,
    counts: { tasks: proof.tasks, documents: proof.documents, document_revisions: proof.document_revisions },
    assertions: {
      validated_before_write: true,
      verified_in_fresh_process: true,
      records_equal_after_restart: proof.records_equal_after_restart,
      content_hash_matches: proof.content_hash_matches,
      revision_immutable: proof.revision_immutable,
      private_file_modes: proof.private_file_modes,
      child_environment_allowlisted: proof.child_environment_allowlisted,
    },
    limitations: ['W01 contract/file round-trip only; no production repository, SQLite, runtime, accounts or cloud providers.'],
  };
} catch {
  report = { schema_version: 1, kind: DEMO_KIND, status: 'FAIL', evidence_type: 'synthetic_fixture', code: failureCode };
} finally {
  if (root !== null) {
    try {
      // Only the exact newly created directory may be removed. Never follow a
      // replacement symlink or delete a folder without our fresh marker.
      assert.equal(basename(root).startsWith(PREFIX), true);
      assert.equal(realpathSync(root), root);
      const currentRoot = lstatSync(root);
      assert.equal(currentRoot.isDirectory() && !currentRoot.isSymbolicLink(), true);
      assert.equal(currentRoot.dev, rootIdentity.dev);
      assert.equal(currentRoot.ino, rootIdentity.ino);
      if (marker !== null) assert.deepEqual(JSON.parse(readFileSync(join(root, MARKER), 'utf8')), marker);
      rmSync(root, { recursive: true, force: false });
      cleanupComplete = !existsSync(root);
    } catch {
      report = { schema_version: 1, kind: DEMO_KIND, status: 'FAIL', evidence_type: 'synthetic_fixture', code: 'FIXTURE_CLEANUP_FAILED' };
    }
  }
  if (report.status === 'PASS') {
    report.assertions.cleanup_complete = cleanupComplete;
    if (!cleanupComplete) report.status = 'FAIL';
  }
}
process.stdout.write(`${JSON.stringify(report)}\n`);
if (report.status !== 'PASS') process.exitCode = 1;

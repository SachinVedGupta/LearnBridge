import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEMA_VERSION, createInstallation, parseInstallation, createSourceGrant,
  assertGrantAllows, parseSourceGrant, parseProvenanceRef, parseDeadline,
  createTask, parseTask, assertTaskGraph, createDocument, createDocumentRevision,
  parseDocumentRevision, assertNextDocumentRevision, parseCapabilityReport,
  createRun, parseRun, transitionRun, validateCheckpointForResume, parseExpectedRevision,
} from '../packages/core/src/contracts.mjs';
import { LearnBridgeError, assertRevision, toErrorEnvelope } from '../packages/core/src/errors.mjs';

const student = '10000000-0000-4000-8000-000000000001';
const source = '10000000-0000-4000-8000-000000000002';
const grantId = '10000000-0000-4000-8000-000000000003';
const objectId = '10000000-0000-4000-8000-000000000004';
const version = '10000000-0000-4000-8000-000000000005';
const taskId = '10000000-0000-4000-8000-000000000006';
const taskId2 = '10000000-0000-4000-8000-000000000007';
const documentId = '10000000-0000-4000-8000-000000000008';
const revisionId = '10000000-0000-4000-8000-000000000009';
const revisionId2 = '10000000-0000-4000-8000-00000000000a';
const now = '2026-10-02T13:00:00Z';
const later = '2026-10-02T13:01:00Z';
const hash = 'a'.repeat(64);
const provenance = {
  source_id: source, object_id: objectId, source_version_id: version,
  version_hash: hash, locator: { kind: 'opaque', ref: 'fixture:syllabus' },
  range: { kind: 'page', start: 2, end: 3 }, retrieved_at: now, grant_id: grantId,
};
const invalid = fn => assert.throws(fn, error => error instanceof LearnBridgeError && error.code === 'INVALID_INPUT');
const code = (fn, expected) => assert.throws(fn, error => error instanceof LearnBridgeError && error.code === expected);

function grant(overrides = {}) {
  return createSourceGrant({ student_id: student, principal_ref: student, source_ref: source,
    state: 'active', scope: { selection: 'selected', object_ids: ['syllabus'] },
    operations: ['metadata.read', 'content.read'], processing: { local: true, destinations: [] },
    retention: { mode: 'managed', days: 30 }, expires_at: later,
    review_receipt: { reviewer: student, decided_at: now, decision: 'approved',
      authorization_source: 'local_ui', fingerprint: hash }, ...overrides }, { id: grantId, now });
}
const used = { tool_calls: 1, source_pages: 1, read_bytes: 100, elapsed_ms: 10, model_requests: 0 };
const budget = { max_tool_calls: 10, max_source_pages: 5, max_read_bytes: 10_000,
  max_elapsed_ms: 60_000, max_model_requests: 0, used };
function run(overrides = {}) {
  return createRun({ student_id: student, recipe_id: 'fixture.course-day-plan', recipe_version: '0.1.0',
    grants: [{ grant_id: grantId, revision: 1 }], capabilities: [{ name: 'fixture.course.read', version: '1' }],
    budget, ...overrides }, { now });
}
const savedCheckpoint = { step_id: 'refresh', committed_at: now,
  grant_revisions: { [grantId]: 1 }, source_versions: { [objectId]: hash },
  capability_versions: { 'fixture.course.read': '1' }, budget_used: used, resumable: true };
const context = { grant_revisions: { [grantId]: 1 }, source_versions: { [objectId]: hash },
  capability_versions: { 'fixture.course.read': '1' }, budget_used: used };

test('W01 Installation has explicit identity, version and platform; creation preserves inputs', () => {
  const input = { student_id: student, platform: 'darwin', data_root_ref: 'managed:root',
    edition: 'local', timezone: 'America/Toronto', setup_version: '0.1.0' };
  const result = createInstallation(input, { now });
  assert.equal(result.student_id, student);
  assert.equal(result.schema_version, SCHEMA_VERSION);
  assert.equal(result.revision, 1);
  assert.equal(result.created_at, now);
  assert.equal(result.deleted_at, null);
  assert.match(result.id, /^[\da-f-]{36}$/);
  assert.deepEqual(input, { student_id: student, platform: 'darwin', data_root_ref: 'managed:root',
    edition: 'local', timezone: 'America/Toronto', setup_version: '0.1.0' });
  invalid(() => parseInstallation({ ...result, api_key: 'DO_NOT_ECHO' }));
  invalid(() => parseInstallation({ ...result, student_id: 'external-user' }));
  code(() => parseInstallation({ ...result, schema_version: 2 }), 'VERSION_MISMATCH');
  invalid(() => parseInstallation({ ...result, timezone: 'Invalid/Zone' }));
  invalid(() => parseInstallation({ ...result, updated_at: '2026-10-01T00:00:00Z' }));
  invalid(() => parseInstallation({ ...result, deleted_at: later }));
});

test('W01 deadline precision preserves date-only and unknown values without invented instants', () => {
  assert.deepEqual(parseDeadline({ precision: 'date', date: '2028-02-29', timezone: 'America/Toronto' }),
    { precision: 'date', date: '2028-02-29', timezone: 'America/Toronto' });
  assert.deepEqual(parseDeadline({ precision: 'unknown', reason: 'Source omitted it', original: '' }),
    { precision: 'unknown', reason: 'Source omitted it', original: '' });
  assert.equal('instant' in parseDeadline({ precision: 'date', date: '2026-10-02' }), false);
  assert.equal(parseDeadline({ precision: 'instant', instant: now }).instant, now);
  for (const date of ['2026-02-29', '2026-04-31', '2026-13-01', '0000-01-01', '2026-10-2']) {
    invalid(() => parseDeadline({ precision: 'date', date }));
  }
  for (const instant of ['2026-11-01T01:30:00', '2026-10-02T13:00:00+00:00', '2026-10-02T24:00:00Z']) {
    invalid(() => parseDeadline({ precision: 'instant', instant }));
  }
  invalid(() => parseDeadline({ precision: 'date', date: '2026-10-02', instant: now }));
  invalid(() => parseDeadline({ precision: 'unknown', timezone: 'America/Toronto' }));
});

test('W01 source read does not authorize provider processing; expired and revoked grants fail closed', () => {
  const local = grant();
  assert.equal(assertGrantAllows(local, { operation: 'content.read', content: true, now }).id, grantId);
  code(() => assertGrantAllows(local, { operation: 'content.read', content: true, provider: 'openai',
    destination_ref: 'student-plan', purpose: 'tutor', now }), 'SCOPE_DENIED');
  code(() => assertGrantAllows(local, { operation: 'external.send', now }), 'SCOPE_DENIED');
  code(() => assertGrantAllows(local, { operation: 'content.read', now: later }), 'CONSENT_REQUIRED');
  code(() => assertGrantAllows(local, { operation: 'content.read', now: '2026-10-02T12:59:59Z' }), 'CONSENT_REQUIRED');
  code(() => assertGrantAllows({ ...local, state: 'revoked' }, { operation: 'content.read', now }), 'CONSENT_REQUIRED');
  const remote = grant({ processing: { local: true, destinations: [{ provider: 'openai',
    destination_ref: 'student-plan', purposes: ['tutor'], allowed_metadata: true,
    allowed_content: false, max_payload_bytes: 1000 }] } });
  assert.equal(assertGrantAllows(remote, { operation: 'metadata.read', provider: 'openai',
    destination_ref: 'student-plan', purpose: 'tutor', payload_bytes: 1000, now }).id, grantId);
  code(() => assertGrantAllows(remote, { operation: 'metadata.read', provider: 'openai',
    destination_ref: 'student-plan', purpose: 'tutor', payload_bytes: 1001, now }), 'BUDGET_EXCEEDED');
  code(() => assertGrantAllows(remote, { operation: 'content.read', content: true, provider: 'openai',
    destination_ref: 'student-plan', purpose: 'tutor', now }), 'SCOPE_DENIED');
  code(() => assertGrantAllows(remote, { operation: 'metadata.read', provider: 'openai',
    destination_ref: 'different-account', purpose: 'tutor', now }), 'SCOPE_DENIED');
  code(() => assertGrantAllows(grant({ operations: ['metadata.read'] }),
    { operation: 'metadata.read', content: true, now }), 'SCOPE_DENIED');
});

test('W01 source grant bounds selected paths and binds human receipt ownership without claiming authentication', () => {
  const local = grant();
  invalid(() => parseSourceGrant({ ...local, principal_ref: source }));
  invalid(() => parseSourceGrant({ ...local, review_receipt: { ...local.review_receipt, reviewer: source } }));
  invalid(() => parseSourceGrant({ ...local, scope: { selection: 'selected' } }));
  for (const path of ['../secret', '/etc/passwd', 'C:\\Users\\secret', 'course/../../secret', 'course//file']) {
    invalid(() => parseSourceGrant({ ...local, scope: { selection: 'selected', relative_paths: [path] } }));
  }
  invalid(() => parseSourceGrant({ ...local, processing: { ...local.processing, implicit_cloud_access: true } }));
  invalid(() => parseSourceGrant({ ...local, retention: { mode: 'ephemeral', days: 30 } }));
});

test('W01 provenance pins immutable version and exact ranges; recognized credential URL fields cannot enter citations', () => {
  const result = parseProvenanceRef(provenance);
  assert.equal(result.source_version_id, version);
  assert.deepEqual(result.range, { kind: 'page', start: 2, end: 3 });
  invalid(() => parseProvenanceRef({ ...provenance, source_version_id: undefined }));
  invalid(() => parseProvenanceRef({ ...provenance, range: { kind: 'page', start: 3, end: 2 } }));
  invalid(() => parseProvenanceRef({ ...provenance, locator: { kind: 'url', ref: 'https://user:secret@example.invalid' } }));
  invalid(() => parseProvenanceRef({ ...provenance, locator: { kind: 'url', ref: 'javascript:alert(1)' } }));
  for (const url of ['https://example.invalid/doc?access_token=SECRET',
    'https://example.invalid/doc?api_key=SECRET', 'https://example.invalid/doc?X-Amz-Signature=SECRET',
    'https://example.invalid/doc#id_token=SECRET', 'https://example.invalid/doc#/route?client_secret=SECRET',
    'https://example.invalid/doc#access_token%3DSECRET']) {
    invalid(() => parseProvenanceRef({ ...provenance, locator: { kind: 'url', ref: url } }));
  }
  assert.equal(parseProvenanceRef({ ...provenance,
    locator: { kind: 'url', ref: 'https://example.invalid/doc?page=2#section-two' } }).locator.kind, 'url');
});

test('W01 tasks preserve exact student content while bounding invalid input and avoiding ownership spoofing', () => {
  const task = createTask({ student_id: student, title: '  Read Chapter 2  ', course_label: '',
    deadline: { precision: 'date', date: '2026-10-03' }, source_refs: [provenance] }, { id: taskId, now });
  assert.equal(task.title, '  Read Chapter 2  ');
  assert.equal(task.status, 'pending');
  assert.equal(task.origin, 'manual');
  assert.equal(task.course_id, null);
  assert.equal(task.effort_minutes, null);
  assert.equal(task.source_refs[0].version_hash, hash);
  invalid(() => createTask({ student_id: student, title: ' ', id: taskId }, { now }));
  invalid(() => parseTask({ ...task, effort_minutes: -1 }));
  invalid(() => parseTask({ ...task, parent_id: taskId }));
  invalid(() => parseTask({ ...task, dependency_ids: [taskId] }));
  invalid(() => parseTask({ ...task, title: 'x'.repeat(501) }));
  invalid(() => parseTask({ ...task, dependency_ids: [taskId2, taskId2] }));
  invalid(() => parseTask({ ...task, submitted: true }));
});

test('W01 full task graph rejects cycles, missing edges and mixed owners', () => {
  const a = createTask({ student_id: student, title: 'A', dependency_ids: [taskId2] }, { id: taskId, now });
  const b = createTask({ student_id: student, title: 'B' }, { id: taskId2, now });
  assert.equal(assertTaskGraph([a, b]).length, 2);
  invalid(() => assertTaskGraph([a]));
  invalid(() => assertTaskGraph([a, { ...b, dependency_ids: [taskId] }]));
  invalid(() => assertTaskGraph([a, { ...b, student_id: source }]));
  invalid(() => assertTaskGraph([a, a]));
});

test('W01 document revisions are immutable and append-only with the reviewed base revision', () => {
  const document = createDocument({ student_id: student, title: 'Draft', kind: 'note', current_revision: 1,
    content_ref: 'managed:draft-v1', academic_policy: 'learning_support' }, { id: documentId, now });
  const previous = createDocumentRevision({ student_id: student, document_id: documentId,
    content_ref: 'managed:draft-v1', sha256: hash,
    author: { kind: 'student', principal_ref: student }, change_reason: 'Created' }, { id: revisionId, now });
  assert.equal(Object.isFrozen(previous), true);
  assert.equal(Object.isFrozen(previous.author), true);
  assert.throws(() => { previous.sha256 = 'b'.repeat(64); }, TypeError);
  const next = parseDocumentRevision({ ...previous, id: revisionId2, revision: 2,
    content_ref: 'managed:draft-v2', created_at: later, updated_at: later, sha256: 'b'.repeat(64) });
  assert.equal(assertNextDocumentRevision(document, previous, next).revision, 2);
  code(() => assertNextDocumentRevision({ ...document, current_revision: 2 }, previous, next), 'REVISION_CONFLICT');
  code(() => assertNextDocumentRevision(document, previous, { ...next, revision: 3 }), 'REVISION_CONFLICT');
  invalid(() => parseDocumentRevision({ ...previous, updated_at: later }));
});

test('W01 capability reports distinguish fixture evidence from live proof and reject overclaims', () => {
  const report = { schema_version: 1, adapter_id: 'fixture.course', adapter_version: '0.1.0',
    account_ref: null, state: 'available', operations: [{ name: 'course.read', state: 'available',
      proof: 'fixture', last_verified_at: now }], retrieved_at: now };
  assert.equal(parseCapabilityReport(report).operations[0].proof, 'fixture');
  invalid(() => parseCapabilityReport({ ...report, operations: [] }));
  invalid(() => parseCapabilityReport({ ...report, api_key: 'DO_NOT_ECHO' }));
  invalid(() => parseCapabilityReport({ ...report, operations: [{ ...report.operations[0], proof: 'live', last_verified_at: null }] }));
  invalid(() => parseCapabilityReport({ ...report, operations: [...report.operations, ...report.operations] }));
  invalid(() => parseCapabilityReport({ ...report, operations: [{ ...report.operations[0], last_verified_at: later }] }));
});

test('W01 Run follows canonical transitions and cannot skip verification', () => {
  const created = run();
  invalid(() => transitionRun(created, 'completed', { now }));
  const validating = transitionRun(created, 'validating', { now });
  const ready = transitionRun(validating, 'ready', { now });
  const running = transitionRun(ready, 'running', { now });
  invalid(() => transitionRun(running, 'completed', { now }));
  const verifying = transitionRun(running, 'verifying', { now });
  const completed = transitionRun(verifying, 'completed', { now });
  assert.equal(completed.state, 'completed');
  assert.equal(completed.revision, 6);
  invalid(() => transitionRun(completed, 'running', { now }));
  invalid(() => parseRun({ ...created, state: 'needs_auth' }));
  code(() => parseRun({ ...created, budget: { ...budget, max_tool_calls: 0 } }), 'BUDGET_EXCEEDED');
});

test('W01 resume requires committed valid checkpoints and never resets consumed budgets', () => {
  const interrupted = run({ state: 'interrupted', checkpoint: savedCheckpoint });
  assert.equal(transitionRun(interrupted, 'ready', { now, current_context: context }).state, 'ready');
  const moreUsed = { ...context, budget_used: { ...used, tool_calls: 2, read_bytes: 200 } };
  assert.deepEqual(transitionRun(interrupted, 'ready', { now, current_context: moreUsed }).budget.used, moreUsed.budget_used);
  code(() => transitionRun(interrupted, 'ready', { now,
    current_context: { ...context, budget_used: { ...used, tool_calls: 11 } } }), 'BUDGET_EXCEEDED');
  code(() => transitionRun(run({ state: 'interrupted' }), 'ready', { now, current_context: context }), 'VERSION_MISMATCH');
  code(() => validateCheckpointForResume(savedCheckpoint, { ...context, grant_revisions: {} }), 'CONSENT_REQUIRED');
  code(() => validateCheckpointForResume(savedCheckpoint, { ...context, grant_revisions: { [grantId]: 2 } }), 'CONSENT_REQUIRED');
  code(() => validateCheckpointForResume(savedCheckpoint, { ...context, source_versions: { [objectId]: 'b'.repeat(64) } }), 'VERSION_MISMATCH');
  code(() => validateCheckpointForResume(savedCheckpoint, { ...context, capability_versions: {} }), 'VERSION_MISMATCH');
  invalid(() => validateCheckpointForResume(savedCheckpoint, { ...context, budget_used: { ...used, tool_calls: 0 } }));
  invalid(() => parseRun({ ...interrupted, checkpoint: { ...savedCheckpoint, budget_used: { ...used, read_bytes: 200 } } }));
});

test('W01 unknown external outcomes reconcile through verification, never blind execution', () => {
  const unknown = run({ state: 'unknown_outcome' });
  invalid(() => transitionRun(unknown, 'running', { now }));
  assert.equal(transitionRun(unknown, 'verifying', { now }).state, 'verifying');
  assert.equal(transitionRun(unknown, 'awaiting_student', { now }).state, 'awaiting_student');
});

test('W01 expected revisions and error envelopes do not silently overwrite or expose rejected data', () => {
  assert.equal(parseExpectedRevision(1), 1);
  for (const value of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) invalid(() => parseExpectedRevision(value));
  code(() => assertRevision(1, 2), 'REVISION_CONFLICT');
  assert.doesNotThrow(() => assertRevision(2, 2));
  const error = toErrorEnvelope(new Error('DO_NOT_ECHO_TOKEN'));
  assert.equal(error.code, 'PROVIDER_FAILURE');
  assert.equal(JSON.stringify(error).includes('DO_NOT_ECHO'), false);
  try { createTask({ student_id: student, title: 'safe', api_key: 'DO_NOT_ECHO' }); }
  catch (failure) { assert.equal(JSON.stringify(toErrorEnvelope(failure)).includes('DO_NOT_ECHO'), false); }
});

test('W01 schemas reject getter objects, array holes and prototype tricks before evaluating them', () => {
  let evaluated = 0;
  const getter = { student_id: student };
  Object.defineProperty(getter, 'title', { get() { evaluated++; return 'Unsafe'; }, enumerable: true });
  invalid(() => createTask(getter, { now }));
  assert.equal(evaluated, 0);
  const task = createTask({ student_id: student, title: 'Safe' }, { now });
  const holes = Array(1);
  invalid(() => parseTask({ ...task, dependency_ids: holes }));
  const accessorArray = [taskId];
  Object.defineProperty(accessorArray, '0', { get() { evaluated++; return taskId; } });
  invalid(() => parseTask({ ...task, dependency_ids: accessorArray }));
  assert.equal(evaluated, 0);
  const customArray = [taskId];
  Object.setPrototypeOf(customArray, { map() { evaluated++; return []; } });
  invalid(() => parseTask({ ...task, dependency_ids: customArray }));
  assert.equal(evaluated, 0);
  const runInput = { student_id: student };
  Object.defineProperty(runInput, 'recipe_id', { get() { evaluated++; return 'Unsafe'; }, enumerable: true });
  invalid(() => createRun(runInput, { now }));
  assert.equal(evaluated, 0);
  const hiddenGrant = {};
  Object.defineProperty(hiddenGrant, grantId, { value: 1, enumerable: false });
  invalid(() => validateCheckpointForResume(savedCheckpoint, { ...context, grant_revisions: hiddenGrant }));
  invalid(() => createTask(Object.assign(Object.create({ injected: true }), { student_id: student, title: 'Unsafe' })));
});

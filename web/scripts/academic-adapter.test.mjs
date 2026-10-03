import test from 'node:test';
import assert from 'node:assert/strict';
import { AcademicError, normalizeAcademicExport, normalizeAcademicDeadline, createAvenueReadAdapter, academicExportFromAvenueReads, AVENUE_READ_TOOLS } from '../packages/local-academic/src/index.mjs';

const origin = 'https://avenue.example.test';
const account = 'fixture-student';
const selected = ['781264'];
function fixture() {
  return { schema_version: 1, institution: { name: 'Fixture University', origin, timezone: 'America/Toronto' }, account_ref: account, retrieved_at: '2026-10-02T12:00:00Z',
    courses: [{ source_id: '781264', title: 'Fixture software design', code: 'DESIGN', url: '/d2l/home/781264' }, { source_id: '222', title: 'Unselected course' }],
    assignments: [{ source_id: '1', course_id: '781264', title: 'Design questions', due: '2026-10-05', description: 'Read and explain the trade-off.' }],
    announcements: [{ source_id: '7', course_id: '781264', title: 'Office hours', body: 'Bring your questions.', published_at: '2026-10-02T11:30:00-04:00' }],
    materials: [{ source_id: 'topic:9', course_id: '781264', title: 'Lecture 1', url: '/d2l/le/content/781264/viewContent/9/View', type: 'topic' }],
    coverage: Object.fromEntries(['courses', 'assignments', 'announcements', 'materials'].map(category => [category, { state: 'complete' }])) };
}
const normalize = (input = fixture(), opts = {}) => normalizeAcademicExport(input, { selectedCourseIds: selected, ...opts });
const expectCode = (fn, code) => assert.throws(fn, error => error instanceof AcademicError && error.code === code);
const schema = name => ({ type: 'object', properties: Object.fromEntries((name === 'get_assignment' ? ['orgUnitId', 'assignmentId'] : name === 'get_course_topic' ? ['orgUnitId', 'topicId'] : name === 'get_course_module' ? ['orgUnitId', 'moduleId'] : name === 'get_upcoming_due_dates' ? ['orgUnitId', 'daysBack', 'daysAhead'] : ['orgUnitId']).map(field => [field, { type: 'number' }])) });
function session() { return { account_ref: account, institution_origin: origin, verified_at: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() }; }
function client(data = [{ id: 1, name: 'Assignment', dueDate: 'Mon, Oct 5, 2026, 11:59 PM', instructions: 'Try first.' }]) {
  const calls = [];
  return { calls, listTools: async params => { calls.push({ method: 'listTools', params }); return { tools: [...AVENUE_READ_TOOLS.map(name => ({ name, inputSchema: schema(name) })), { name: 'read_file', inputSchema: { type: 'object', properties: { filePath: { type: 'string' } } } }] }; }, callTool: async params => { calls.push(params); return { content: [{ type: 'text', text: JSON.stringify(data) }] }; } };
}
function adapter(provider = client(), extra = {}) { return createAvenueReadAdapter({ client: provider, institutionOrigin: origin, accountRef: account, selectedCourseIds: selected, session: session(), ...extra }); }

test('academic export binds stable IDs to owner/institution/source, filters courses and preserves dates', () => {
  const first = normalize(); const second = normalize();
  assert.deepEqual(first, second);
  assert.equal(first.courses.length, 1);
  assert.deepEqual(first.assignments[0].deadline, { precision: 'date', date: '2026-10-05', timezone: 'America/Toronto', original: '2026-10-05' });
  assert.equal(first.announcements[0].published_at.instant, '2026-10-02T15:30:00.000Z');
  assert.equal(first.materials[0].url, origin + '/d2l/le/content/781264/viewContent/9/View');
  const other = fixture(); other.account_ref = 'other-student';
  assert.notEqual(normalize(other).assignments[0].id, first.assignments[0].id);
  const host = fixture(); host.institution.origin = 'https://other.example.test';
  assert.notEqual(normalize(host).assignments[0].id, first.assignments[0].id);
});

test('unknown, invalid, locale and timezone-less source dates are kept without guessing', () => {
  for (const value of ['Tue, Oct 6, 2026, 11:59 PM', '2026-02-30', '2026-10-05T23:59:00', 'TBD']) {
    assert.deepEqual(normalizeAcademicDeadline(value), { precision: 'unknown', reason: 'source_precision_unknown', original: value });
  }
  assert.equal(normalizeAcademicDeadline('2024-02-29').precision, 'date');
  assert.equal(normalizeAcademicDeadline('2026-10-05T23:59:00-04:00').instant, '2026-10-06T03:59:00.000Z');
  assert.equal(normalizeAcademicDeadline(null).reason, 'not_provided');
  expectCode(() => normalizeAcademicDeadline({ precision: 'date', date: '2026-02-30' }), 'INVALID_INPUT');
});

test('top-level secret/unknown fields and accessors are rejected without invocation', () => {
  const withSecret = { ...fixture(), token: 'SYNTHETIC_SECRET' };
  expectCode(() => normalize(withSecret), 'INVALID_INPUT');
  let invoked = false; const input = fixture(); Object.defineProperty(input, 'password', { enumerable: true, get() { invoked = true; return 'SYNTHETIC_SECRET'; } });
  expectCode(() => normalize(input), 'INVALID_INPUT'); assert.equal(invoked, false);
  const unsupported = fixture(); unsupported.schema_version = 2;
  expectCode(() => normalize(unsupported), 'UNSUPPORTED');
});

test('unsafe URLs and malformed selected rows produce bounded partial coverage', () => {
  const input = fixture();
  input.assignments.push({ source_id: 'evil', course_id: '781264', title: 'Unsafe', url: 'https://other.example.test/?access_token=SYNTHETIC_SECRET' });
  input.materials.push({ source_id: 'bad', course_id: '781264', title: 'Unsafe', url: origin + '/content?token=SYNTHETIC_SECRET' });
  const result = normalize(input);
  assert.equal(result.assignments.length, 1); assert.equal(result.coverage.assignments.state, 'partial');
  assert.equal(result.materials.length, 1); assert.equal(result.coverage.materials.state, 'partial');
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_SECRET'), false);
  expectCode(() => normalize({ ...fixture(), institution: { name: 'Unsafe', origin: 'https://user:password@avenue.example.test' } }), 'SCOPE_DENIED');
});

test('exact duplicates collapse while conflicting variants remain review items', () => {
  const input = fixture(); input.assignments.push({ ...input.assignments[0] });
  let result = normalize(input); assert.equal(result.assignments.length, 1); assert.equal(result.coverage.assignments.duplicates, 1);
  input.assignments.push({ ...input.assignments[0], due: '2026-10-07' });
  result = normalize(input); assert.equal(result.assignments.length, 0); assert.equal(result.conflicts.length, 1); assert.equal(result.conflicts[0].variants.length, 2);
  assert.equal(result.coverage.assignments.state, 'partial');
});

test('changes compare stable source rows; missing does not mean authoritative deletion', () => {
  const previous = normalize(); const input = fixture(); input.assignments[0].due = '2026-10-07'; input.materials = [];
  const next = normalize(input, { previous });
  assert.equal(next.assignments[0].id, previous.assignments[0].id);
  assert.ok(next.changes.changed.includes(previous.assignments[0].id));
  assert.ok(next.changes.missing.includes(previous.materials[0].id));
  assert.ok(next.changes.unchanged.includes(previous.courses[0].id));
  const tampered = structuredClone(previous); tampered.assignments[0].title = 'Changed behind hash';
  expectCode(() => normalize(input, { previous: tampered }), 'INVALID_INPUT');
  const differentOwner = fixture(); differentOwner.account_ref = 'different';
  expectCode(() => normalize(differentOwner, { previous }), 'SCOPE_DENIED');
});

test('empty selection yields no academic content and absent coverage stays unknown', () => {
  const input = fixture(); delete input.coverage;
  const result = normalize(input, { selectedCourseIds: [] });
  assert.equal(result.courses.length, 0); assert.equal(result.assignments.length, 0); assert.equal(result.announcements.length, 0); assert.equal(result.materials.length, 0);
  assert.equal(result.coverage.assignments.state, 'unknown');
});

test('partial errors are selected-course scoped and error messages cannot enter output', () => {
  const input = fixture(); input.errors = [{ category: 'assignments', course_id: '781264', code: 'AUTH_EXPIRED' }, { category: 'materials', course_id: '222', code: 'PROVIDER_FAILURE' }];
  const result = normalize(input); assert.equal(result.errors.length, 1); assert.equal(result.coverage.assignments.state, 'partial');
  input.errors[0].message = 'SYNTHETIC_SECRET'; expectCode(() => normalize(input), 'INVALID_INPUT');
});

test('no session/expired session reports auth missing/expired and makes no upstream calls', async () => {
  const provider = client(); const missing = adapter(provider, { session: undefined });
  assert.equal((await missing.probe()).auth_status, 'missing'); assert.equal(provider.calls.length, 0);
  await assert.rejects(missing.read('get_assignments', { orgUnitId: 781264 }), { code: 'AUTH_REQUIRED' });
  const expired = adapter(provider, { session: { ...session(), verified_at: new Date(Date.now() - 2000).toISOString(), expires_at: new Date(Date.now() - 1000).toISOString() } });
  assert.equal((await expired.probe()).auth_status, 'expired');
  await assert.rejects(expired.read('get_assignments', { orgUnitId: 781264 }), { code: 'AUTH_EXPIRED' }); assert.equal(provider.calls.length, 0);
});

test('account/institution mismatch rejects session metadata rather than reading', async () => {
  const provider = client(); const wrong = adapter(provider, { session: { ...session(), account_ref: 'wrong' } });
  await assert.rejects(wrong.probe(), { code: 'SCOPE_DENIED' }); assert.equal(provider.calls.length, 0);
});

test('tool discovery filters schema mismatches; selected read returns fixture proof only', async () => {
  const provider = client(); const read = adapter(provider); const report = await read.probe();
  assert.equal(report.capability.state, 'available'); assert.equal(report.capability.operations[0].proof, 'none');
  const result = await read.read('get_assignments', { orgUnitId: 781264 });
  assert.equal(result.proof, 'fixture'); assert.equal(result.course_id, '781264');
  assert.ok(result.warnings.includes('UPSTREAM_FORMATTED_DATES_REQUIRE_REVIEW'));
  assert.equal(read.capabilityReport().capability.operations.find(item => item.name === 'get_assignments').proof, 'fixture');
  const mismatch = client(); mismatch.listTools = async () => ({ tools: [{ name: 'get_assignments', inputSchema: { type: 'object', properties: { orgUnitId: { type: 'string' }, token: { type: 'string' } } } }] });
  const unsupported = adapter(mismatch); assert.equal((await unsupported.probe()).capability.state, 'unsupported');
  await assert.rejects(unsupported.read('get_assignments', { orgUnitId: 781264 }), { code: 'UNSUPPORTED' });
});

test('write/path/download/global-enrollment tools and out-of-scope inputs never reach callTool', async () => {
  const provider = client(); const read = adapter(provider); await read.probe(); const count = provider.calls.length;
  for (const name of ['read_file', 'download_file', 'delete_file', 'tasks_add', 'sync_all', 'get_my_courses', 'get_my_grades', 'get_assignment_submissions', 'unknown']) await assert.rejects(read.read(name, { orgUnitId: 781264 }), { code: 'UNSUPPORTED' });
  await assert.rejects(read.read('get_assignments', { orgUnitId: 222 }), { code: 'SCOPE_DENIED' });
  await assert.rejects(read.read('get_assignments', { orgUnitId: 781264, filePath: '/private/path' }), { code: 'INVALID_INPUT' });
  await assert.rejects(read.read('get_assignments', {}), { code: 'INVALID_INPUT' });
  await assert.rejects(read.read('get_upcoming_due_dates', { orgUnitId: 781264, daysAhead: 10000 }), { code: 'INVALID_INPUT' });
  assert.equal(provider.calls.length, count);
});

test('MCP source data schema, unsafe external URLs, credentials and size are rejected', async () => {
  for (const [data, code] of [[[{ id: 1, name: 'Unsafe', links: [{ name: 'Secret link', url: 'https://other.example.test/content' }] }], 'SCOPE_DENIED'], [[{ id: 1, name: 'Bad shape', token: 'SYNTHETIC_SECRET' }], 'SCOPE_DENIED'], [[{ name: 'Missing source ID' }], 'INVALID_INPUT']]) {
    const read = adapter(client(data)); await read.probe(); await assert.rejects(read.read('get_assignments', { orgUnitId: 781264 }), { code });
  }
  const huge = adapter(client([{ id: 1, name: 'Huge', instructions: 'x'.repeat(260000) }])); await huge.probe();
  await assert.rejects(huge.read('get_assignments', { orgUnitId: 781264 }), { code: 'BUDGET_EXCEEDED' });
});

test('timeouts/cancellation and call budget stop usable results; client receives abort signal', async () => {
  let sawSignal; const provider = client(); provider.callTool = async (_params, opts) => { sawSignal = opts.signal; return new Promise(() => {}); };
  const timed = adapter(provider, { timeoutMs: 15 }); await timed.probe();
  await assert.rejects(timed.read('get_assignments', { orgUnitId: 781264 }), { code: 'TIMEOUT' }); assert.equal(sawSignal.aborted, true);
  const cancelled = adapter(provider, { timeoutMs: 1000 }); await cancelled.probe(); const controller = new AbortController();
  const result = cancelled.read('get_assignments', { orgUnitId: 781264 }, { signal: controller.signal }); controller.abort();
  await assert.rejects(result, { code: 'CANCELLED' });
  const limited = adapter(client(), { maxCalls: 1 }); await limited.probe();
  await assert.rejects(limited.read('get_assignments', { orgUnitId: 781264 }), { code: 'BUDGET_EXCEEDED' });
});

test('upstream auth errors are redacted, distinguish expired and require a new session', async () => {
  const provider = client(); provider.callTool = async () => { throw new Error('D2L API error 401: SYNTHETIC_SECRET_TOKEN'); };
  const read = adapter(provider); await read.probe();
  await assert.rejects(read.read('get_assignments', { orgUnitId: 781264 }), error => error.code === 'AUTH_EXPIRED' && !JSON.stringify(error.toJSON()).includes('SYNTHETIC_SECRET'));
  assert.equal(read.capabilityReport().auth_status, 'expired');
  read.setSession(session()); assert.equal(read.capabilityReport().auth_status, 'ready'); assert.equal(read.capabilityReport().capability.state, 'unsupported');
});

test('bounded callable MCP fixture converts into a reviewed normalized academic snapshot', async () => {
  const read = adapter(client()); await read.probe(); const result = await read.read('get_assignments', { orgUnitId: 781264 });
  const exported = academicExportFromAvenueReads([result], { institution: fixture().institution, courses: [fixture().courses[0]], accountRef: account, retrievedAt: new Date().toISOString(), selectedCourseIds: selected });
  const snapshot = normalize(exported);
  assert.equal(snapshot.assignments[0].source_id, '1'); assert.equal(snapshot.assignments[0].deadline.precision, 'unknown');
  assert.equal(snapshot.assignments[0].deadline.original, 'Mon, Oct 5, 2026, 11:59 PM');
  assert.equal(snapshot.coverage.assignments.state, 'unknown');
  assert.equal(snapshot.assignments[0].title, 'Assignment');
});

test('duplicate tool names cannot establish an unambiguous read capability', async () => {
  const provider = client();
  provider.listTools = async () => ({ tools: [
    { name: 'get_assignments', inputSchema: schema('get_assignments') },
    { name: 'get_assignments', inputSchema: { type: 'object', properties: { filePath: { type: 'string' } } } },
    { name: 'get_assignments', inputSchema: schema('get_assignments') },
  ] });
  const reader = adapter(provider);
  assert.equal((await reader.probe()).capability.state, 'unsupported');
  await assert.rejects(reader.read('get_assignments', { orgUnitId: 781264 }), error => error.code === 'UNSUPPORTED');
  assert.equal(provider.calls.length, 0);
});

test('late metadata cannot re-enable discovery after session removal', async () => {
  let release; const provider = client();
  provider.listTools = async () => new Promise(resolve => { release = resolve; });
  const reader = adapter(provider); const discovering = reader.probe();
  await Promise.resolve();
  reader.setSession(null);
  release({ tools: [{ name: 'get_assignments', inputSchema: schema('get_assignments') }] });
  await assert.rejects(discovering, error => error.code === 'AUTH_REQUIRED');
  assert.equal(reader.capabilityReport().auth_status, 'missing');
  assert.equal(reader.capabilityReport().capability.operations.find(tool => tool.name === 'get_assignments').proof, 'none');
});

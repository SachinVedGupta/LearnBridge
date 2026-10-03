import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AcademicError, ACADEMIC_LIMITS, createAvenueReadAdapter, academicExportFromAvenueReads, normalizeAcademicExport } from '../packages/local-academic/src/index.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/academic-mcp-fixture.mjs', import.meta.url));
const origin = 'https://avenue.example.test';
const account = 'synthetic-student';
function session(offset = 60_000) {
  return { account_ref: account, institution_origin: origin, verified_at: new Date(Date.now() - 120_000).toISOString(), expires_at: new Date(Date.now() + offset).toISOString() };
}
function isCode(code) { return error => error instanceof AcademicError && error.code === code; }
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function connected(t, mode = 'normal', options = {}) {
  const previousCanary = process.env.LEARNBRIDGE_TEST_SECRET_CANARY;
  process.env.LEARNBRIDGE_TEST_SECRET_CANARY = 'synthetic-host-only-value';
  const transport = new StdioClientTransport({ command: process.execPath, args: [fixturePath, mode], env: { NODE_ENV: 'test' }, stderr: 'pipe' });
  const client = new Client({ name: 'learnbridge-academic-fixture-test', version: '1.0.0' }, { capabilities: {} });
  let diagnostics = ''; const calls = [];
  transport.stderr?.on('data', chunk => { diagnostics += chunk.toString(); });
  let pid;
  t.after(async () => {
    await client.close();
    if (previousCanary === undefined) delete process.env.LEARNBRIDGE_TEST_SECRET_CANARY;
    else process.env.LEARNBRIDGE_TEST_SECRET_CANARY = previousCanary;
    if (pid) {
      assert.equal(alive(pid), false, 'the synthetic MCP child must exit after client.close()');
    }
    assert.equal(diagnostics, '', 'synthetic server must not log source content, credentials or diagnostics');
  });
  await client.connect(transport, { timeout: 2000 });
  pid = transport.pid;
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.equal(alive(pid), true);
  const provider = {
    listTools: async (...args) => { calls.push({ method: 'listTools', input: args[0] }); return client.listTools(...args); },
    callTool: async (...args) => { calls.push({ method: 'callTool', input: args[0] }); return client.callTool(...args); },
  };
  const adapter = createAvenueReadAdapter({ client: provider, institutionOrigin: origin, accountRef: account, selectedCourseIds: ['781264'], session: session(), timeoutMs: 1000, ...options });
  return { adapter, calls, client, transport, pid };
}

test('official stdio SDK discovers tools and performs bounded selected-course reads', async t => {
  const { adapter, calls } = await connected(t);
  const report = await adapter.probe();
  assert.equal(report.auth_status, 'ready');
  assert.equal(report.capability.state, 'available');
  assert.equal(report.capability.operations.find(tool => tool.name === 'get_assignments').proof, 'none');
  assert.equal(report.capability.operations.find(tool => tool.name === 'get_assignment').state, 'unsupported');
  const assignments = await adapter.read('get_assignments', { orgUnitId: 781264 });
  const announcements = await adapter.read('get_announcements', { orgUnitId: 781264 });
  assert.equal(assignments.proof, 'fixture');
  assert.equal(assignments.account_ref, account);
  assert.equal(assignments.institution_origin, origin);
  assert.equal(assignments.course_id, '781264');
  const exported = academicExportFromAvenueReads([assignments, announcements], { institution: { name: 'Synthetic University', origin, timezone: 'America/Toronto' }, courses: [{ source_id: '781264', title: 'Synthetic design course' }], accountRef: account, selectedCourseIds: ['781264'], retrievedAt: new Date().toISOString() });
  const snapshot = normalizeAcademicExport(exported, { selectedCourseIds: ['781264'] });
  assert.equal(snapshot.assignments.length, 1);
  assert.deepEqual(snapshot.assignments[0].deadline, { precision: 'unknown', reason: 'source_precision_unknown', original: 'Mon, Oct 5, 2026, 11:59 PM' });
  assert.equal(snapshot.announcements[0].title, 'Fixture office hours');
  assert.equal(adapter.capabilityReport().capability.operations.find(tool => tool.name === 'get_assignments').proof, 'fixture');
  assert.deepEqual(calls.map(call => call.method), ['listTools', 'callTool', 'callTool']);
});

test('official stdio client receives no metadata or read calls when session is missing or expired', async t => {
  const { adapter, calls } = await connected(t, 'normal', { session: null });
  assert.equal((await adapter.probe()).auth_status, 'missing');
  await assert.rejects(adapter.read('get_assignments', { orgUnitId: 781264 }), isCode('AUTH_REQUIRED'));
  adapter.setSession(session(-1000));
  assert.equal((await adapter.probe()).auth_status, 'expired');
  await assert.rejects(adapter.read('get_assignments', { orgUnitId: 781264 }), isCode('AUTH_EXPIRED'));
  assert.deepEqual(calls, []);
});

test('unknown, write, path, global and unselected-course requests never reach the real stdio client', async t => {
  const { adapter, calls } = await connected(t);
  await adapter.probe();
  for (const name of ['unknown_tool', 'tasks_add', 'read_file', 'download_file', 'get_my_courses', 'get_grades', 'get_submissions']) {
    await assert.rejects(adapter.read(name, { orgUnitId: 781264, filePath: '/synthetic-only' }), isCode('UNSUPPORTED'));
  }
  await assert.rejects(adapter.read('get_assignments', { orgUnitId: 222 }), isCode('SCOPE_DENIED'));
  await assert.rejects(adapter.read('get_assignments', {}), isCode('INVALID_INPUT'));
  await assert.rejects(adapter.read('get_assignments', { orgUnitId: 781264, token: 'synthetic-only' }), isCode('INVALID_INPUT'));
  assert.deepEqual(calls.map(call => call.method), ['listTools']);
});

test('provider expiry over real stdio is redacted and blocks subsequent reads', async t => {
  const { adapter, calls } = await connected(t, 'expired');
  await adapter.probe();
  await assert.rejects(adapter.read('get_assignments', { orgUnitId: 781264 }), error => isCode('AUTH_EXPIRED')(error) && !error.message.includes('SYNTHETIC_ERROR_DO_NOT_EXPOSE'));
  assert.equal(adapter.capabilityReport().auth_status, 'expired');
  await assert.rejects(adapter.read('get_assignments', { orgUnitId: 781264 }), isCode('AUTH_EXPIRED'));
  assert.deepEqual(calls.map(call => call.method), ['listTools', 'callTool']);
});

test('real stdio output is refused above the policy UTF-8 bound', async t => {
  const { adapter } = await connected(t, 'oversized');
  await adapter.probe();
  await assert.rejects(adapter.read('get_assignments', { orgUnitId: 781264 }), isCode('BUDGET_EXCEEDED'));
  assert.equal(ACADEMIC_LIMITS.outputBytes, 256_000);
  assert.equal(adapter.capabilityReport().capability.operations.find(tool => tool.name === 'get_assignments').proof, 'none');
});

test('timeout and cancellation reject real stdio reads without recording verification', async t => {
  const { adapter } = await connected(t, 'slow', { timeoutMs: 50 });
  await adapter.probe();
  await assert.rejects(adapter.read('get_assignments', { orgUnitId: 781264 }), isCode('TIMEOUT'));
  const controller = new AbortController();
  const reading = adapter.read('get_assignments', { orgUnitId: 781264 }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(reading, isCode('CANCELLED'));
  assert.equal(adapter.capabilityReport().capability.operations.find(tool => tool.name === 'get_assignments').proof, 'none');
});

test('session removal while a real stdio read is in flight discards the late response', async t => {
  const { adapter, calls } = await connected(t, 'slow');
  await adapter.probe();
  const reading = adapter.read('get_assignments', { orgUnitId: 781264 });
  await new Promise(resolve => setTimeout(resolve, 20));
  adapter.setSession(null);
  await assert.rejects(reading, isCode('AUTH_REQUIRED'));
  assert.equal(adapter.capabilityReport().auth_status, 'missing');
  assert.equal(adapter.capabilityReport().capability.operations.find(tool => tool.name === 'get_assignments').proof, 'none');
  assert.deepEqual(calls.map(call => call.method), ['listTools', 'callTool']);
});

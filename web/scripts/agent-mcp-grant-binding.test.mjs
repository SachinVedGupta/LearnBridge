import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { startControl, requestAgentControl } from '../apps/local-runtime/src/ipc.mjs';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const entry = fileURLToPath(new URL('../apps/local-runtime/src/mcp.mjs', import.meta.url));
async function barrier(promise, label, timeoutMs = 5000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out.')), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
async function agent(t, root, destination = 'codex', boundGrant = undefined, embeddedLease = undefined) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, '--data-root', root, '--destination', destination, ...(boundGrant === undefined ? [] : ['--grant-id', boundGrant]), ...(embeddedLease === undefined ? [] : ['--embedded-lease', embeddedLease])], env: { PATH: '/usr/bin:/bin' }, stderr: 'pipe' });
  let stderr = ''; transport.stderr.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'synthetic-fixed-grant-verifier', version: '1' }); await client.connect(transport);
  t.after(async () => { await client.close(); assert.equal(stderr.includes('PRIVATE_OTHER_GRANT_CANARY'), false); });
  return { client, async tool(name, input = {}) { const result = await client.callTool({ name, arguments: input }); return { failed: result.isError === true, value: JSON.parse(result.content[0].text) }; } };
}
async function spy(t, leased = false) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'learnbridge-mcp-binding-'))), root = join(parent, 'workspace'); mkdirSync(root, { mode: 0o700 }); const calls = [];
  const lease = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', operations = []; let activeLease = true;
  const control = await startControl({ root, origin: 'http://127.0.0.1:3210', onCommand: () => ({}), onAgentCommand: (destination, command, input, embeddedLease) => {
    calls.push({ destination, command, input, embeddedLease });
    if (leased && (embeddedLease !== lease || !activeLease || destination !== 'codex' || (command !== 'status' && input.grant_id !== A))) { const error = new Error('Synthetic lease denied.'); error.code = 'CONSENT_REQUIRED'; throw error; }
    operations.push({ destination, command, input }); if (command === 'status') return { edition: 'local', destination, grants: [{ id: A }, { id: B }] };
    return { grant_id: input.grant_id, state: 'awaiting_review', text: input.grant_id === B ? 'PRIVATE_OTHER_GRANT_CANARY' : 'SYNTHETIC_SELECTED_CONTEXT' };
  } });
  t.after(async () => { await control.close(); rmSync(parent, { recursive: true, force: true }); }); return { root, calls, lease, operations, revokeLease() { activeLease = false; } };
}

test('MGB01: actual fixed-grant MCP stdio rejects every foreign context/proposal before IPC and filters status metadata', async t => {
  const f = await spy(t), bridge = await agent(t, f.root, 'codex', A); const status = await bridge.tool('learnbridge_status'); assert.equal(status.failed, false); assert.deepEqual(status.value.grants, [{ id: A }]);
  const count = f.calls.length;
  for (const [tool, body] of [
    ['learnbridge_context', { grant_id: B }],
    ['learnbridge_propose_task', { grant_id: B, title: 'Outside selected grant', idempotency_key: 'synthetic-task-idempotency' }],
    ['learnbridge_propose_document', { grant_id: B, source_document_id: B, source_revision: 1, source_sha256: 'b'.repeat(64), title: 'Outside selected grant', draft: 'Synthetic draft', purpose: 'outline', academic_policy: 'learning_support', idempotency_key: 'synthetic-doc-idempotency' }],
  ]) { const denied = await bridge.tool(tool, body); assert.equal(denied.failed, true); assert.equal(denied.value.error.code, 'SCOPE_DENIED'); assert.equal(JSON.stringify(denied).includes('PRIVATE_OTHER_GRANT_CANARY'), false); }
  assert.equal(f.calls.length, count, 'Foreign tool arguments must never reach the IPC handler.');
  const own = await bridge.tool('learnbridge_context', { grant_id: A }); assert.equal(own.failed, false); assert.equal(own.value.text, 'SYNTHETIC_SELECTED_CONTEXT'); assert.equal(f.calls.at(-1).input.grant_id, A);
});
test('MGB02: original four-argument external Codex/Claude bridge still supports separately approved explicit grant choices', async t => {
  const f = await spy(t);
  for (const destination of ['codex', 'claude']) {
    const bridge = await agent(t, f.root, destination), status = await bridge.tool('learnbridge_status'); assert.deepEqual(status.value.grants.map(grant => grant.id), [A, B]);
    for (const id of [A, B]) { assert.equal((await bridge.tool('learnbridge_context', { grant_id: id })).failed, false); assert.equal(f.calls.at(-1).destination, destination); }
  }
});
test('MGB03: invalid, missing, reordered or extra optional grant CLI arguments exit before serving or disclosing supplied values', () => {
  const root = '/tmp/SYNTHETIC_PRIVATE_PATH';
  for (const suffix of [['--grant-id', 'SYNTHETIC_SECRET_ARGUMENT'], ['--grant-id'], ['--wrong-flag', A], ['--grant-id', A, '--extra', B], ['--embedded-lease', A], ['--grant-id', A, '--embedded-lease', 'SYNTHETIC_SECRET_ARGUMENT']]) {
    const result = spawnSync(process.execPath, [entry, '--data-root', root, '--destination', 'codex', ...suffix], { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin' } });
    assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /valid optional grant binding/); assert.equal(result.stderr.includes('SYNTHETIC_SECRET_ARGUMENT'), false); assert.equal(result.stderr.includes(root), false);
  }
});
test('MGB04: actual paired runtime keeps another granted note unread and budget untouched while the bound note/proposal works', async t => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'learnbridge-mcp-bound-runtime-'))), root = join(parent, 'workspace'), runtime = await startRuntime({ dataRoot: root, port: 0, hostAdapter: { enabled: false } });
  t.after(async () => { await runtime.close(); rmSync(parent, { recursive: true, force: true }); });
  const pair = await fetch(runtime.origin + '/api/local/v1/pair', { method: 'POST', headers: { Origin: runtime.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: runtime.createPairingCode() }) }); const cookie = pair.headers.get('set-cookie').split(';')[0], nonce = (await pair.json()).nonce;
  const call = async (path, body) => { const response = await fetch(runtime.origin + '/api/local/v1' + path, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, 'X-LearnBridge-Nonce': nonce, ...(body ? { Origin: runtime.origin, 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); assert.ok(response.ok, `${path}: ${response.status}`); return response.json(); };
  const noteA = (await call('/documents', { title: 'Selected note', content: 'SYNTHETIC_BOUND_NOTE' })).document, noteB = (await call('/documents', { title: 'Other separately granted note', content: 'PRIVATE_OTHER_GRANT_CANARY' })).document;
  async function grant(note) { return (await call('/agent-grants', { destination: 'codex', task_ids: [], document_ids: [note.id], source_entry_ids: [], expected_records: { tasks: [], documents: [{ id: note.id, revision: note.revision }], source_entries: [] }, max_bytes: 48000, expires_in_minutes: 60 })).grant; }
  const own = await grant(noteA), other = await grant(noteB), bridge = await agent(t, root, 'codex', own.id), before = (await call('/agent-grants')).items.find(grant => grant.id === other.id);
  assert.equal((await bridge.tool('learnbridge_context', { grant_id: other.id })).failed, true);
  assert.equal((await bridge.tool('learnbridge_propose_task', { grant_id: other.id, title: 'Must not enter review', idempotency_key: 'bound-foreign-task' })).failed, true);
  const after = (await call('/agent-grants')).items.find(grant => grant.id === other.id); assert.equal(after.used_bytes, before.used_bytes); assert.equal(after.revision, before.revision); assert.deepEqual((await call('/task-proposals')).items, []);
  const context = await bridge.tool('learnbridge_context', { grant_id: own.id }); assert.equal(context.failed, false); assert.equal(context.value.documents[0].text, 'SYNTHETIC_BOUND_NOTE'); assert.equal(JSON.stringify(context).includes('PRIVATE_OTHER_GRANT_CANARY'), false);
  const proposed = await bridge.tool('learnbridge_propose_task', { grant_id: own.id, title: 'Review the selected note', idempotency_key: 'bound-own-task-proposal' }); assert.equal(proposed.failed, false); assert.equal(proposed.value.state, 'awaiting_review'); assert.deepEqual((await call('/tasks')).items, []);
});
test('MGB05: actual MCP forwards only its trusted outer lease; revoked/wrong leases refuse before source/proposal work', async t => {
  const f = await spy(t, true), bridge = await agent(t, f.root, 'codex', A, f.lease);
  const status = await bridge.tool('learnbridge_status'); assert.equal(status.failed, false); assert.deepEqual(status.value.grants, [{ id: A }]); assert.equal(f.calls.at(-1).embeddedLease, f.lease);
  assert.equal((await bridge.tool('learnbridge_context', { grant_id: A })).failed, false); assert.equal(f.calls.at(-1).embeddedLease, f.lease); const beforeIPC = f.calls.length, beforeWork = f.operations.length;
  assert.equal((await bridge.tool('learnbridge_context', { grant_id: B })).value.error.code, 'SCOPE_DENIED'); assert.equal(f.calls.length, beforeIPC);
  await assert.rejects(requestAgentControl(f.root, 'codex', 'context', { grant_id: B }, { embeddedLease: f.lease }), { code: 'CONSENT_REQUIRED' }); assert.equal(f.operations.length, beforeWork);
  const callsBeforeMalformed = f.calls.length; await assert.rejects(requestAgentControl(f.root, 'codex', 'context', { grant_id: A }, { embeddedLease: 'not-a-uuid' })); assert.equal(f.calls.length, callsBeforeMalformed);
  f.revokeLease();
  for (const [tool, input] of [['learnbridge_status', {}], ['learnbridge_context', { grant_id: A }], ['learnbridge_propose_task', { grant_id: A, title: 'Must not queue after logout', idempotency_key: 'synthetic-revoked-lease' }],
    ['learnbridge_propose_document', { grant_id: A, source_document_id: A, source_revision: 1, source_sha256: 'a'.repeat(64), title: 'Must not queue', draft: 'Synthetic outline', purpose: 'outline', academic_policy: 'learning_support', idempotency_key: 'synthetic-revoked-doc' }]]) {
    const denied = await bridge.tool(tool, input); assert.equal(denied.failed, true); assert.equal(denied.value.error.code, 'CONSENT_REQUIRED');
  }
  assert.equal(f.operations.length, beforeWork); assert.equal(JSON.stringify(f.calls.map(call => call.input)).includes('embedded_lease'), false);
});
test('MGB06: real embedded runtime lease binds one grant and logout refuses late stdio reads/proposals without spending another grant', { timeout: 15000 }, async t => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'learnbridge-mcp-native-lease-'))), root = join(parent, 'workspace');
  let releaseModel; const heldModel = new Promise(done => { releaseModel = done; }); let modelStarted; const began = new Promise(done => { modelStarted = done; }); let bridge, leaseId;
  const result = { status: 'completed', turn_id: 'synthetic-lease-model-turn', text: JSON.stringify({ answer: 'Synthetic selected-source explanation.', task_proposals: [], document_proposals: [] }), error: null };
  const adapterFactory = input => ({ initialize: async () => ({ state: 'available' }),
    async startThread() { leaseId = input.embeddedLease; assert.match(leaseId, /^[a-f0-9-]{36}$/); bridge = await agent(t, root, 'codex', input.grantId, leaseId); },
    async callLearnBridgeTool(tool, args) { const response = await bridge.tool(tool, args); assert.equal(response.failed, false); return { value: response.value, receipt: { tool, status: 'completed', failed: false, result_hash: createHash('sha256').update(JSON.stringify(response.value)).digest('hex') } }; },
    async startTurn() { modelStarted(); return { completion: heldModel }; }, close: async () => {} });
  // This fixture deliberately holds a model-requested turn while exercising
  // real MCP lease permissions. Catalogue/auto selection has separate tests.
  const runtime = await startRuntime({ dataRoot: root, port: 0, codexProfileOptions: { adapterFactory, executionMode: 'model' } });
  t.after(async () => { releaseModel(result); await runtime.close(); rmSync(parent, { recursive: true, force: true }); });
  async function pair() {
    const response = await fetch(runtime.origin + '/api/local/v1/pair', { method: 'POST', headers: { Origin: runtime.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: runtime.createPairingCode() }) });
    const cookie = response.headers.get('set-cookie').split(';')[0], nonce = (await response.json()).nonce;
    return async (path, body) => { const reply = await fetch(runtime.origin + '/api/local/v1' + path, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, 'X-LearnBridge-Nonce': nonce, ...(body ? { Origin: runtime.origin, 'Content-Type': 'application/json' } : {}), ...(path === '/host-turns' && body ? { 'Idempotency-Key': 'synthetic-embedded-host-request' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); assert.ok(reply.ok, `${path}: ${reply.status}`); return reply.json(); };
  }
  let call = await pair();
  const noteA = (await call('/documents', { title: 'Lease-selected note', content: 'SYNTHETIC_LEASE_BOUND_NOTE' })).document, noteB = (await call('/documents', { title: 'Other active grant', content: 'PRIVATE_OTHER_GRANT_CANARY' })).document;
  async function grant(note) { return (await call('/agent-grants', { destination: 'codex', task_ids: [], document_ids: [note.id], source_entry_ids: [], expected_records: { tasks: [], documents: [{ id: note.id, revision: note.revision }], source_entries: [] }, max_bytes: 48000, expires_in_minutes: 60 })).grant; }
  const own = await grant(noteA), other = await grant(noteB); assert.equal((await call('/ai/connect', { confirmed: true })).state, 'available');
  const turn = (await call('/host-turns', { grant_id: own.id, prompt: 'Explain my selected note.', confirmed: true })).item; await barrier(began, 'Synthetic model-start barrier');
  const before = (await call('/agent-grants')).items.find(item => item.id === other.id); assert.equal(before.used_bytes, 0);
  await assert.rejects(requestAgentControl(root, 'codex', 'context', { grant_id: other.id }, { embeddedLease: leaseId }), { code: 'CONSENT_REQUIRED' });
  // Possessing a live lease is insufficient: only a broker-minted one-use exact permit may execute.
  const status = await bridge.tool('learnbridge_status'); assert.equal(status.failed, true); assert.equal(status.value.error.code, 'SCOPE_DENIED');
  assert.equal(JSON.stringify(await call('/ai/status')).includes(leaseId), false); assert.equal(JSON.stringify(await call('/host-turns')).includes(leaseId), false);
  await call('/logout', {});
  assert.equal((await bridge.tool('learnbridge_context', { grant_id: own.id })).failed, true); assert.equal((await bridge.tool('learnbridge_propose_task', { grant_id: own.id, title: 'Must not queue after browser logout', idempotency_key: 'synthetic-logout-lease' })).failed, true);
  call = await pair(); const after = (await call('/agent-grants')).items.find(item => item.id === other.id); assert.equal(after.used_bytes, before.used_bytes); assert.equal(after.revision, before.revision); assert.deepEqual((await call('/task-proposals')).items, []); assert.deepEqual((await call('/tasks')).items, []);
  releaseModel(result);
  for (let index = 0; index < 20; index++) { const item = (await call(`/host-turns/${turn.id}`)).item; if (!['queued', 'running'].includes(item.data.state)) break; await new Promise(done => setImmediate(done)); }
  await assert.rejects(requestAgentControl(root, 'codex', 'status', undefined, { embeddedLease: leaseId }), { code: 'CONSENT_REQUIRED' });
});

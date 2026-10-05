import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalStore } from '@learnbridge/local-storage';
import { createHostTurns } from '../apps/local-runtime/src/host-turns.mjs';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';
const sha = text => createHash('sha256').update(text).digest('hex');
const result = text => ({ state: 'completed', complete: true, text, output_sha256: sha(text),
  tool_receipts: [{ tool: 'learnbridge_context', status: 'completed', failed: false, result_hash: sha('synthetic context') }],
  host_version: '0.154.0', error_code: null });
function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-host-turn-test-')), root = join(parent, 'private');
  const store = LocalStore.open({ root }); t.after(() => { store.close(); rmSync(parent, { recursive: true, force: true }); });
  const note = store.createDocument({ title: 'Synthetic study evidence', text: 'A base case terminates recursion.', kind: 'study' });
  const grant = store.createAgentGrant({ destination: 'codex', task_ids: [], document_ids: [note.document.id], source_entry_ids: [], max_bytes: 64000, expires_in_minutes: 10 });
  return { store, note, grant, root };
}
const start = (service, grant, key = 'synthetic-host-key-0001', authorize = () => true) => service.start({ grant_id: grant.id, prompt: 'Explain the base case from my selected note.', confirmed: true }, { idempotencyKey: key, authorize });
async function finished(service, id) { for (let n = 0; n < 100; n++) { const item = service.get(id); if (!['queued', 'running'].includes(item.data.state)) return item; await delay(5); } throw Error('Synthetic host did not finish'); }

test('official-host controller is disabled by default and rejects unconfirmed, wrong-host and arbitrary configuration requests', async t => {
  const { store, grant } = fixture(t); let called = 0; const service = createHostTurns({ store, execute: async () => { called++; return result('fixture'); } });
  await assert.rejects(start(service, grant), { code: 'UNSUPPORTED' }); assert.equal(called, 0);
  const enabled = createHostTurns({ store, enabled: true, execute: async () => { called++; return result('fixture'); } });
  await assert.rejects(enabled.start({ grant_id: grant.id, prompt: 'fixture', confirmed: false }, { idempotencyKey: 'synthetic-key-00001', authorize: () => true }), { code: 'INVALID_INPUT' });
  await assert.rejects(enabled.start({ grant_id: grant.id, prompt: 'fixture', confirmed: true, command: 'arbitrary' }, { idempotencyKey: 'synthetic-key-00001', authorize: () => true }), { code: 'INVALID_INPUT' });
  const claude = store.createAgentGrant({ destination: 'claude', task_ids: [], document_ids: [], source_entry_ids: [], max_bytes: 10000, expires_in_minutes: 10 });
  await assert.rejects(start(enabled, claude), { code: 'SCOPE_DENIED' }); assert.equal(called, 0);
});

test('selected-grant host output persists with exact hash, one execution per retry and proposal-only effects', async t => {
  const { store, grant, root } = fixture(t); let calls = 0;
  const service = createHostTurns({ store, enabled: true, execute: async input => {
    calls++; assert.equal(input.dataRoot, store.root); assert.equal(input.grantId, grant.id); assert.equal(input.authorize(), true);
    input.onProgress({ phase: 'tool', tool: 'learnbridge_context', state: 'finished' }); return result('The selected note says the base case terminates recursion.');
  } });
  const first = await start(service, grant), final = await finished(service, first.id);
  assert.equal(final.data.state, 'completed'); assert.equal(final.data.output_sha256, sha(final.data.text)); assert.equal(final.data.progress.length, 1);
  assert.equal((await start(service, grant)).id, first.id); assert.equal(calls, 1); assert.equal(store.listTasks().length, 0);
  store.close(); const reopened = LocalStore.open({ root }); t.after(() => reopened.close());
  const restarted = createHostTurns({ store: reopened, enabled: true, execute: async () => { calls++; return result('unexpected'); } });
  assert.equal(restarted.get(first.id).data.text, final.data.text); assert.equal(calls, 1);
});

test('an actual context read charges bytes without invalidating consent or repeating an identical host request', async t => {
  const { store, grant, note } = fixture(t); let calls = 0;
  const before = store.assertAgentGrant({ destination: 'codex', grant_id: grant.id });
  const service = createHostTurns({ store, enabled: true, execute: async input => {
    calls++;
    const context = store.agentContext({ destination: 'codex', grant_id: input.grantId,
      task_ids: [], document_ids: [note.document.id], source_entry_ids: [], max_bytes: 12000 });
    assert.equal(context.documents[0].text, note.text);
    assert.equal(input.authorize(), true);
    input.onProgress({ phase: 'tool', tool: 'learnbridge_context', state: 'finished' });
    return result('The approved note says a base case terminates recursion.');
  } });
  const first = await start(service, grant); const final = await finished(service, first.id);
  assert.equal(final.data.state, 'completed'); assert.ok(final.data.text.includes('base case'));
  const after = store.assertAgentGrant({ destination: 'codex', grant_id: grant.id });
  assert.equal(after.revision, before.revision + 1); assert.ok(after.remaining_bytes < before.remaining_bytes);
  assert.equal(after.consent_fingerprint, before.consent_fingerprint);
  assert.equal((await start(service, grant)).id, first.id); assert.equal(calls, 1);
  assert.equal(store.assertAgentGrant({ destination: 'codex', grant_id: grant.id }).remaining_bytes, after.remaining_bytes);
});

test('grant revocation or pinned note changes withhold cached text and late output', async t => {
  const { store, grant, note } = fixture(t); let release;
  const service = createHostTurns({ store, enabled: true, execute: () => new Promise(resolve => { release = resolve; }) });
  const first = await start(service, grant); await delay(5); store.updateDocument(note.document.id, { text: 'Changed source' }, note.document.revision);
  release(result('PRIVATE_LATE_CANARY')); const final = await finished(service, first.id);
  assert.equal(final.data.state, 'withheld'); assert.equal(final.data.text, ''); assert.equal(final.data.prompt, ''); assert.equal(final.data.visibility, 'withheld_scope_changed');
  assert.equal(JSON.stringify(service.list()).includes('PRIVATE_LATE_CANARY'), false);
  const nextGrant = store.createAgentGrant({ destination: 'codex', task_ids: [], document_ids: [note.document.id], source_entry_ids: [], max_bytes: 64000, expires_in_minutes: 10 });
  const completed = createHostTurns({ store, enabled: true, execute: async () => result('PRIVATE_CACHED_CANARY') });
  const next = await start(completed, nextGrant, 'synthetic-host-key-0002'); await finished(completed, next.id); store.revokeAgentGrant(nextGrant.id, nextGrant.revision);
  assert.equal(completed.get(next.id).data.text, ''); assert.equal(JSON.stringify(completed.list()).includes('PRIVATE_CACHED_CANARY'), false);
});

test('stop and revoked browser session prevent late output, duplicate starts and automatic restart replay', async t => {
  const { store, grant } = fixture(t); let release, allowed = true, captured;
  const service = createHostTurns({ store, enabled: true, execute: input => { captured = input; return new Promise(resolve => { release = resolve; }); } });
  const first = await start(service, grant, 'synthetic-host-key-0001', () => allowed); await delay(5);
  await assert.rejects(start(service, grant, 'synthetic-host-key-0002'), { code: 'REVISION_CONFLICT' });
  const running = service.get(first.id); service.cancel(first.id, { expected_revision: running.revision }); assert.equal(captured.signal.aborted, true);
  release(result('PRIVATE_CANCELLED_CANARY')); await delay(5); assert.equal(service.get(first.id).data.text, ''); assert.equal(service.get(first.id).data.state, 'interrupted');
  const second = await start(service, grant, 'synthetic-host-key-0002', () => allowed); await delay(5); allowed = false; release(result('PRIVATE_SESSION_CANARY')); await finished(service, second.id); assert.equal(service.get(second.id).data.state, 'withheld');
  allowed = true; const third = await start(service, grant, 'synthetic-host-key-0003'); await delay(5);
  const restarted = createHostTurns({ store, enabled: true, execute: async () => { throw Error('must not replay'); } });
  assert.equal(restarted.get(third.id).data.state, 'unknown_outcome');
  service.cancel(third.id, { expected_revision: service.get(third.id).revision }); release(result('')); await service.drain();
});

test('unverifiable successful output is refused instead of becoming a completed sourced answer', async t => {
  const { store, grant } = fixture(t); const service = createHostTurns({ store, enabled: true, execute: async () => ({ ...result('UNSOURCED_CANARY'), tool_receipts: [] }) });
  const first = await start(service, grant); const final = await finished(service, first.id);
  assert.equal(final.data.state, 'failed'); assert.equal(final.data.error_code, 'VERSION_MISMATCH'); assert.equal(final.data.text, '');
});

test('context delivery is persisted only with matching exact status/context origins and is never inferred for legacy output', async t => {
  const {store,grant}=fixture(t);
  for(const [index,delivery] of ['model_requested','runtime_prepared'].entries()){
    const origin=delivery==='model_requested'?'model':'runtime';
    const service=createHostTurns({store,enabled:true,execute:async()=>({...result('Synthetic attested context.'),context_delivery:delivery,
      tool_receipts:['learnbridge_status','learnbridge_context'].map(tool=>({tool,status:'completed',failed:false,result_hash:sha(tool),origin}))})});
    const first=await start(service,grant,'attested-context-'+index),final=await finished(service,first.id);
    assert.equal(final.data.state,'completed');assert.equal(final.data.context_delivery,delivery);await service.drain();
  }
  const cases=[
    {context_delivery:'model_requested',origin:'runtime'},
    {context_delivery:'runtime_prepared',origin:'model'},
    {context_delivery:'runtime_prepared',origin:undefined},
    {context_delivery:'guessed_mode',origin:'runtime'},
  ];
  for(const [index,value] of cases.entries()){
    const service=createHostTurns({store,enabled:true,execute:async()=>({...result('REJECTED_DELIVERY_CANARY'),context_delivery:value.context_delivery,
      tool_receipts:['learnbridge_status','learnbridge_context'].map(tool=>({tool,status:'completed',failed:false,result_hash:sha(tool),...(value.origin?{origin:value.origin}:{})}))})});
    const first=await start(service,grant,'invalid-delivery-'+index),final=await finished(service,first.id);
    assert.equal(final.data.state,'failed');assert.equal(final.data.error_code,'VERSION_MISMATCH');assert.equal(final.data.context_delivery,null);assert.equal(final.data.text,'');await service.drain();
  }
  const legacy=createHostTurns({store,enabled:true,execute:async()=>result('Legacy context proof.')});
  const first=await start(legacy,grant,'legacy-context-mode'),final=await finished(legacy,first.id);
  assert.equal(final.data.state,'completed');assert.equal(final.data.context_delivery,null);await legacy.drain();
});

test('actual paired host route binds grant/request/retry and rejects hostile origin, nonce and executable fields', async t => {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-host-http-test-')); const runtime = await startRuntime({ dataRoot: join(parent, 'private'), port: 0,
    hostAdapter: { enabled: true, execute: async () => result('Synthetic HTTP selected evidence answer.') } });
  t.after(async () => { await runtime.close(); rmSync(parent, { recursive: true, force: true }); });
  const paired = await fetch(`${runtime.origin}/api/local/v1/pair`, { method: 'POST', headers: { Origin: runtime.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: runtime.createPairingCode() }) });
  const cookie = paired.headers.get('set-cookie').split(';')[0], nonce = (await paired.json()).nonce;
  async function call(path, body, extra = {}) { const response = await fetch(`${runtime.origin}/api/local/v1${path}`, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: runtime.origin, 'X-LearnBridge-Nonce': nonce, 'Content-Type': 'application/json', 'Idempotency-Key': 'synthetic-http-turn-01', ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, data: await response.json() }; }
  const note = await call('/documents', { title: 'Selected synthetic note', content: 'Synthetic HTTP context.', kind: 'study' }); assert.equal(note.status, 201);
  const grant = await call('/agent-grants', { destination: 'codex', task_ids: [], document_ids: [note.data.document.id], source_entry_ids: [], expected_records: { tasks: [], documents: [{ id: note.data.document.id, revision: 1 }], source_entries: [] }, max_bytes: 64000, expires_in_minutes: 10 }); assert.equal(grant.status, 201);
  const body = { grant_id: grant.data.grant.id, prompt: 'Explain my synthetic note.', confirmed: true };
  assert.equal((await call('/host-turns', body, { Origin: 'https://hostile.invalid' })).status, 403);
  assert.equal((await call('/host-turns', body, { 'X-LearnBridge-Nonce': 'wrong' })).status, 403);
  assert.equal((await call('/host-turns', { ...body, binary: '/fake' })).status, 400);
  const response = await call('/host-turns', body); assert.equal(response.status, 202); assert.equal((await call('/host-turns', body)).data.item.id, response.data.item.id);
  for (let n = 0; n < 20; n++) { const saved = await call(`/host-turns/${response.data.item.id}`); if (saved.data.item.data.state === 'completed') { assert.equal(saved.data.item.data.text, 'Synthetic HTTP selected evidence answer.'); return; } await delay(5); }
  assert.fail('Synthetic paired HTTP host did not finish');
});

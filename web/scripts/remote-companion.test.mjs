import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { REMOTE_VERSION, REMOTE_ORIGIN, remoteHash, parseRemoteStudyRequest, parseRemotePolicy, parseRemoteLease, boundedRemoteBody } from '../packages/core/src/remote-companion.mjs';
import { createRemoteCompanion, openRemoteInstance, createRemoteTransport } from '../apps/local-runtime/src/remote-companion.mjs';

const request = binding_id => ({ schema_version: 1, binding_id, client_request_id: randomUUID(), recipe_id: 'study.explain', recipe_version: REMOTE_VERSION, prompt: 'Explain one selected course concept.' });
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'learnbridge-remote-')), root = join(base, 'workspace'), repository = join(base, 'repo'); mkdirSync(repository, { mode: 0o700 });
  const store = LocalStore.open({ root, timezone: 'UTC' }), instance = openRemoteInstance({ root: join(base, 'remote-instance'), workspaceRoot: root, repositoryRoot: repository });
  const chosen = store.createDocument({ title: 'Selected synthetic lecture', text: 'SELECTED_STUDENT_BODY: a foreign key references a related row.' });
  store.createDocument({ title: 'Excluded private fixture', text: 'HOST_AUTH_CANARY CONTROL_AUTH_CANARY UNIVERSITY_AUTH_CANARY UNSELECTED_CANARY' });
  const grant = store.createAgentGrant({ destination: 'codex', task_ids: [], document_ids: [chosen.document.id], source_entry_ids: [], max_bytes: 64000, expires_in_minutes: 60 });
  t.after(() => { try { store.close(); } catch {} rmSync(base, { recursive: true, force: true }); });
  let currentTime = Date.now(); const clock = () => new Date(currentTime).toISOString();
  const kernel = relayFixture(instance, clock); let authorized = true;
  const options = { store, instance, enabled: true, authorize: () => authorized, transportFactory: kernel.factory, clock };
  return { base, root, repository, store, instance, chosen, grant, kernel, options, setAuthorized: value => { authorized = value; }, advance: ms => { currentTime += ms; } };
}
/** Synthetic relay, deliberately separate from the unexecuted PostgreSQL/RLS gate. */
function relayFixture(instance, clock) {
  const ledger = [], account = randomUUID(), phone = randomUUID(); let binding, job, token, hook = null, outage = false;
  const factory = credentials => ({ async send(operation, payload) {
    if (outage) throw Object.assign(new Error('synthetic transport unavailable'), { code: 'REMOTE_OFFLINE' });
    if (operation !== 'confirm') assert.equal(credentials.token, token); ledger.push({ operation, payload: structuredClone(payload) });
    if (operation === 'confirm') { token = credentials.token; binding = { id: randomUUID(), account_id: account, phone_session_ref: phone,
      installation_instance_id: instance.installation_instance_id, workspace_ref: instance.workspace_ref, policy: payload.policy, state: 'active', revision: 1, last_seen_at: null }; }
    if (hook) await hook(operation, payload);
    if (operation === 'confirm' || operation === 'heartbeat') return structuredClone(binding);
    if (operation === 'claim') { if (job && ['cancel_requested', 'awaiting_student'].includes(job.state) && job.lease_expires_at <= clock()) {
      job.lease_epoch++; job.lease_expires_at = new Date(Date.parse(clock()) + 60000).toISOString(); }
      return job && !['cancelled', 'unknown_outcome'].includes(job.state) ? structuredClone(job) : null; }
    if (operation === 'revoke') { binding.state = 'revoked'; return { status: 'revoked' }; }
    if (operation === 'accept' || operation === 'state') {
      assert(Number.isSafeInteger(payload.sequence)); assert(Number.isSafeInteger(payload.lease_epoch)); assert.equal(payload.lease_epoch, job.lease_epoch);
      assert(job.lease_expires_at > clock());
      if (payload.sequence <= job.sequence) { assert.equal(payload.sequence, job.sequence); assert.equal(payload.state, job.state); return { status: 'duplicate', state: job.state }; }
      assert.equal(payload.sequence, job.sequence + 1);
      if (payload.state === 'local_accepted') assert.equal(job.state, 'leased');
      if (payload.state === 'awaiting_student') assert.equal(job.state, 'local_accepted');
      if (payload.state === 'cancelled') assert.equal(job.state, 'cancel_requested');
      job.sequence = payload.sequence; job.state = payload.state; job.local_run_ref = payload.local_run_ref;
      return { status: 'accepted', state: job.state };
    }
    throw new Error('Unsupported synthetic operation');
  } });
  return { factory, ledger, binding: () => binding, job: () => job, setHook: fn => { hook = fn; }, setOutage: value => { outage = value; },
    enqueue() { const input = request(binding.id); job = { id: randomUUID(), binding_id: binding.id, account_id: account, request: input, input_hash: remoteHash(input),
      state: 'leased', lease_epoch: 1, lease_expires_at: new Date(Date.parse(clock()) + 60000).toISOString(), local_run_ref: null, expires_at: new Date(Date.parse(clock()) + 900000).toISOString(), sequence: 0 }; return job; } };
}
async function pair(companion, grant) { return companion.pair({ pending_id: randomUUID(), challenge: 'a'.repeat(32), confirmed: true, host_grant_id: grant.id,
  expires_in_minutes: 30, max_requests: 3, max_request_bytes: 16384 }); }

test('remote envelopes permit one fixed study recipe and reject commands, paths, credentials, budget/scope expansion and malformed leases', async () => {
  const input = request(randomUUID()); assert.deepEqual(parseRemoteStudyRequest(input), input);
  for (const bad of [{ ...input, command: 'arbitrary shell' }, { ...input, recipe_id: 'computer.control' }, { ...input, api_key: 'PRIVATE_KEY_CANARY' }, { ...input, prompt: 'x'.repeat(4001) }, { ...input, installation_instance_id: randomUUID() }]) assert.throws(() => parseRemoteStudyRequest(bad));
  const now = new Date().toISOString(), policy = { version: REMOTE_VERSION, destination: 'codex', host_grant_id: randomUUID(), selection_hash: 'a'.repeat(64),
    expires_at: new Date(Date.now() + 60000).toISOString(), max_requests: 3, max_request_bytes: 16384, recipes: ['study.explain'], relay_processing_confirmed: true,
    plaintext_notice_confirmed: true, retention_hours: 24, result_scope: 'status_only' };
  assert.equal(parseRemotePolicy(policy, { now }).result_scope, 'status_only');
  for (const bad of [{ ...policy, result_scope: 'all_private_text' }, { ...policy, destination: 'claude' }, { ...policy, relay_processing_confirmed: false }, { ...policy, telemetry: true }, { ...policy, expires_at: now }]) assert.throws(() => parseRemotePolicy(bad, { now }));
  const lease = { id: randomUUID(), binding_id: input.binding_id, account_id: randomUUID(), request: input, input_hash: remoteHash(input), state: 'leased', lease_epoch: 1,
    lease_expires_at: new Date(Date.now() + 60000).toISOString(), local_run_ref: null, expires_at: policy.expires_at, sequence: 0 };
  assert.equal(parseRemoteLease(lease).input_hash, remoteHash(input)); assert.throws(() => parseRemoteLease({ ...lease, request: { ...input, prompt: 'Changed bytes' } }));
  await assert.rejects(boundedRemoteBody(new Request('https://example.invalid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(16385) })), { code: 'REMOTE_TOO_LARGE' });
});

test('companion is disabled by default: zero stores, credentials, network or automatic model calls', async () => {
  const companion = createRemoteCompanion({ store: new Proxy({}, { get() { throw new Error('store touched'); } }), transportFactory: () => { throw new Error('network touched'); } });
  assert.equal(companion.capability().enabled, false); assert.equal(companion.capability().telemetry, false);
  await assert.rejects(companion.pollOnce(), { code: 'REMOTE_DISABLED' }); assert.throws(() => companion.result(), { code: 'REMOTE_RESULT_WITHHELD' });
});

test('body deadline and oversize cancellation do not await a hanging stream cancel', async () => {
  let cancelled = 0;
  const hanging = new Request('https://example.invalid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, duplex: 'half',
    body: new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } }) });
  const started = Date.now(); await assert.rejects(boundedRemoteBody(hanging, 16384, 20), { code: 'REMOTE_BODY_TIMEOUT' });
  assert(Date.now() - started < 1000); assert.equal(cancelled, 1);
  const large = new Request('https://example.invalid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, duplex: 'half',
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(16385)); }, cancel() { return new Promise(() => {}); } }) });
  await assert.rejects(boundedRemoteBody(large, 16384, 20), { code: 'REMOTE_TOO_LARGE' });
});

test('expired status/control leases renew without another selected read, note or execution', async t => {
  const f = fixture(t); let reads = 0;
  const measured = new Proxy(f.store, { get(target, key) { const value = target[key]; if (key === 'agentContext') return (...args) => { reads++; return value.apply(target, args); };
    return typeof value === 'function' ? value.bind(target) : value; } });
  const companion = createRemoteCompanion({ ...f.options, store: measured }); await pair(companion, f.grant); f.kernel.enqueue(); await companion.pollOnce();
  assert.equal(reads, 1); f.advance(120000); assert.equal((await companion.pollOnce()).dispatch_repeated, false);
  assert.equal(f.kernel.job().lease_epoch, 2); assert.equal(reads, 1); assert.equal(f.store.listDocuments().length, 3);
  f.advance(120000); f.kernel.job().state = 'cancel_requested'; assert.equal((await companion.pollOnce()).state, 'cancelled');
  assert.equal(f.kernel.job().lease_epoch, 3); assert.equal(f.kernel.job().sequence, 3); assert.equal(reads, 1); assert.equal(f.store.listDocuments().length, 3);
  assert.equal((await companion.pollOnce()).state, 'idle'); assert.equal(f.store.listTasks().length, 0);
});

test('actual SQLite companion prepares only selected cited local context, retains one note and sends only content-free status on replay', async t => {
  const f = fixture(t), companion = createRemoteCompanion(f.options); await pair(companion, f.grant); f.kernel.enqueue();
  assert.equal(f.store.listDocuments().length, 2); const result = await companion.pollOnce(); assert.equal(result.state, 'awaiting_student');
  assert.equal(result.native_execution, false); assert.equal(result.result_text_delivery, false);
  const note = f.store.getDocument(result.local_note_id); assert.match(note.text, /SELECTED_STUDENT_BODY/); assert.doesNotMatch(note.text, /UNSELECTED_CANARY/);
  assert.match(note.text, /no_model_invocation/); assert.equal(f.store.listDocuments().length, 3); assert.equal(f.store.listTasks().length, 0);
  assert.equal((await companion.pollOnce()).dispatch_repeated, false); assert.equal(f.store.listDocuments().length, 3);
  assert.doesNotMatch(JSON.stringify(f.kernel.ledger), /SELECTED_STUDENT_BODY|Selected synthetic lecture|UNSELECTED_CANARY|HOST_AUTH_CANARY|CONTROL_AUTH_CANARY|UNIVERSITY_AUTH_CANARY/);
  assert.throws(() => companion.result(), { code: 'REMOTE_RESULT_WITHHELD' });
  const marker = JSON.parse(readFileSync(join(f.base, 'remote-instance', 'remote-instance.json'), 'utf8')); assert.deepEqual(Object.keys(marker).sort(), ['installation_instance_id', 'schema_version']);
});

test('late source revocation and forged account/instance/expired lease reject before selected-body read or upload', async t => {
  const f = fixture(t), companion = createRemoteCompanion(f.options); await pair(companion, f.grant); f.kernel.enqueue();
  f.kernel.setHook(operation => { if (operation === 'claim') { f.kernel.setHook(null); f.store.revokeAgentGrant(f.grant.id, f.store.getAgentGrant(f.grant.id).revision); } });
  await assert.rejects(companion.pollOnce(), { code: 'CONSENT_REQUIRED' }); assert.equal(f.store.listDocuments().length, 2); assert.equal(f.store.listTasks().length, 0);
  assert.doesNotMatch(JSON.stringify(f.kernel.ledger), /SELECTED_STUDENT_BODY|UNSELECTED_CANARY/);
  const second = fixture(t), other = createRemoteCompanion(second.options); await pair(other, second.grant); second.kernel.enqueue().account_id = randomUUID();
  await assert.rejects(other.pollOnce(), { code: 'REMOTE_LEASE_DENIED' }); assert.equal(second.store.listDocuments().length, 2);
  second.kernel.job().account_id = second.kernel.binding().account_id; second.kernel.job().lease_expires_at = new Date(Date.now() - 1000).toISOString();
  await assert.rejects(other.pollOnce(), { code: 'REMOTE_LEASE_DENIED' }); assert.equal(second.store.listDocuments().length, 2);
});

test('remote cancellation arriving after acceptance blocks source acquisition and is durably acknowledged on the next manual poll', async t => {
  const f = fixture(t), companion = createRemoteCompanion(f.options); await pair(companion, f.grant); f.kernel.enqueue(); let claims = 0;
  f.kernel.setHook(operation => { if (operation === 'claim' && ++claims === 2) f.kernel.job().state = 'cancel_requested'; });
  await assert.rejects(companion.pollOnce(), { code: 'REMOTE_CANCELLED_OR_CHANGED' }); assert.equal(f.store.listDocuments().length, 2);
  f.kernel.setHook(null); assert.equal((await companion.pollOnce()).state, 'cancelled');
  assert.equal(f.store.listWorkspaceRecords({ kind: 'artifact' }).find(r => r.data.format === 'learnbridge_remote_dispatch.v1').data.state, 'cancelled');
  assert.equal(f.store.listTasks().length, 0);
});

test('late cancellation on pre-write heartbeat discards prepared context and persists no local recipe note', async t => {
  const f = fixture(t), companion = createRemoteCompanion(f.options); await pair(companion, f.grant); f.kernel.enqueue(); let heartbeats = 0;
  f.kernel.setHook(operation => { if (operation === 'heartbeat' && ++heartbeats === 4) f.kernel.job().state = 'cancel_requested'; });
  assert.equal((await companion.pollOnce()).state, 'cancelled'); assert.equal(f.kernel.job().state, 'cancelled'); assert.equal(f.store.listDocuments().length, 2);
  const record = f.store.listWorkspaceRecords({ kind: 'artifact' }).find(r => r.data.format === 'learnbridge_remote_dispatch.v1');
  assert.equal(record.data.state, 'cancelled'); assert.equal(record.data.recipe_note_id, null); assert.equal(f.store.listTasks().length, 0);
  assert.doesNotMatch(JSON.stringify(f.kernel.ledger), /SELECTED_STUDENT_BODY|UNSELECTED_CANARY/);
});

test('same-process ambiguous failure after recipe save records uncertainty immediately and never charges a second context read', async t => {
  const f = fixture(t); let reads = 0;
  const interrupted = new Proxy(f.store, { get(target, key) { const value = target[key];
    if (key === 'agentContext') return (...args) => { reads++; return value.apply(target, args); };
    if (key === 'createDocument') return (...args) => { value.apply(target, args); throw new Error('synthetic ambiguous post-write failure'); };
    return typeof value === 'function' ? value.bind(target) : value; } });
  const companion = createRemoteCompanion({ ...f.options, store: interrupted }); await pair(companion, f.grant); f.kernel.enqueue();
  await assert.rejects(companion.pollOnce(), /synthetic ambiguous/); assert.equal(f.store.listDocuments().length, 3);
  assert.equal(f.store.listWorkspaceRecords({ kind: 'artifact' }).find(r => r.data.format === 'learnbridge_remote_dispatch.v1').data.state, 'unknown_outcome');
  assert.equal((await companion.pollOnce()).state, 'unknown_outcome'); assert.equal(reads, 1); assert.equal(f.store.listDocuments().length, 3);
});

test('crash after actual durable local recipe save stays uncertain after SQLite restart, requires re-pair and never blindly repeats dispatch', async t => {
  const f = fixture(t); let crash = true;
  const interrupted = new Proxy(f.store, { get(target, key) { const value = target[key]; if (key === 'createDocument') return (...args) => { const result = value.apply(target, args);
    if (crash) { crash = false; throw new Error('fixture crash after recipe note write'); } return result; }; return typeof value === 'function' ? value.bind(target) : value; } });
  const companion = createRemoteCompanion({ ...f.options, store: interrupted }); await pair(companion, f.grant); f.kernel.enqueue();
  await assert.rejects(companion.pollOnce(), /fixture crash/); assert.equal(f.store.listDocuments().length, 3); f.store.close();
  const reopened = LocalStore.open({ root: f.root }); try { const before = f.kernel.ledger.length, recovered = createRemoteCompanion({ ...f.options, store: reopened });
    assert.equal(recovered.capability().status, 'requires_pairing'); await assert.rejects(recovered.pollOnce(), { code: 'REMOTE_PAIRING_REQUIRED' }); assert.equal(f.kernel.ledger.length, before);
    const saved = reopened.listWorkspaceRecords({ kind: 'artifact' }).find(r => r.data.format === 'learnbridge_remote_dispatch.v1'); assert.equal(saved.data.state, 'unknown_outcome');
    assert.equal(reopened.listDocuments().length, 3); assert.equal(reopened.listTasks().length, 0); assert.equal(reopened.integrity().integrity, 'ok'); } finally { reopened.close(); }
});

test('separate private instance identity survives local reopen but a restored root is a distinct binding; no credential travels in backups', async t => {
  const f = fixture(t); const reopenedIdentity = openRemoteInstance({ root: join(f.base, 'remote-instance'), workspaceRoot: f.root, repositoryRoot: f.repository });
  assert.equal(reopenedIdentity.installation_instance_id, f.instance.installation_instance_id); assert.equal(reopenedIdentity.workspace_ref, f.instance.workspace_ref);
  await f.store.backup(join(f.base, 'backup')); f.store.close(); await LocalStore.restore({ backupRoot: join(f.base, 'backup'), root: join(f.base, 'restored') });
  const restoredIdentity = openRemoteInstance({ root: join(f.base, 'remote-restored-instance'), workspaceRoot: join(f.base, 'restored'), repositoryRoot: f.repository });
  assert.notEqual(restoredIdentity.installation_instance_id, f.instance.installation_instance_id); assert.notEqual(restoredIdentity.workspace_ref, f.instance.workspace_ref);
  assert.throws(() => openRemoteInstance({ root: join(f.repository, 'unsafe'), workspaceRoot: join(f.base, 'restored'), repositoryRoot: f.repository }), { code: 'REMOTE_PRIVATE_STORE_DENIED' });
  chmodSync(join(f.base, 'remote-instance', 'remote-instance.json'), 0o644); assert.throws(() => f.instance.assertCurrent(), { code: 'REMOTE_PRIVATE_STORE_DENIED' });
});

test('offline unpair retains an honest pending receipt and stops future calls; acknowledged unpair records actual relay revocation', async t => {
  const f = fixture(t), companion = createRemoteCompanion(f.options); await pair(companion, f.grant); f.kernel.setOutage(true);
  const result = await companion.unpair({ confirmed: true }); assert.equal(result.state, 'unpair_pending'); assert.equal(result.acknowledged, false);
  const calls = f.kernel.ledger.length; await assert.rejects(companion.pollOnce(), { code: 'REMOTE_DISABLED' }); assert.equal(f.kernel.ledger.length, calls);
  assert.equal(f.store.listWorkspaceRecords({ kind: 'artifact' }).find(r => r.data.format === 'learnbridge_remote_control.v1').data.acknowledged, false);
  const other = fixture(t), acknowledged = createRemoteCompanion(other.options); await pair(acknowledged, other.grant);
  assert.equal((await acknowledged.unpair({ confirmed: true })).state, 'revoked'); assert.equal(other.kernel.binding().state, 'revoked');
});

test('fixed outbound transport permits no arbitrary URL/command, omits cookies, forbids redirects and does not inherit environment secrets', async t => {
  const original = globalThis.fetch, calls = []; t.after(() => { globalThis.fetch = original; }); globalThis.fetch = async (url, options) => {
    calls.push({ url, options }); return new Response(JSON.stringify({ status: 'accepted' }), { headers: { 'Content-Type': 'application/json' } }); };
  const transport = createRemoteTransport({ token: 'a'.repeat(43), installation_instance_id: randomUUID(), binding_id: randomUUID() });
  await transport.send('heartbeat', {}); assert.equal(calls[0].url, `${REMOTE_ORIGIN}/api/remote/v1/device`); assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[0].options.credentials, 'omit');
  assert.deepEqual(Object.keys(calls[0].options.headers).sort(), ['Authorization','Content-Type','X-LearnBridge-Binding','X-LearnBridge-Instance','X-LearnBridge-Operation']);
  await assert.rejects(transport.send('execute_shell', { path: '/private' })); assert.equal(calls.length, 1);
});

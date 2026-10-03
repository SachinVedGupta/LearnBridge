import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import * as protocol from '../packages/core/src/remote-companion.mjs';
const require = createRequire(import.meta.url), ownerA = randomUUID(), ownerB = randomUUID(), sessionA = randomUUID(), sessionB = randomUUID(), bindingId = randomUUID(), instanceId = randomUUID();
function fixture(t) {
  const prior = { enabled: process.env.REMOTE_COMPANION_ENABLED, gate: process.env.REMOTE_COMPANION_RELEASE_GATE }; delete process.env.REMOTE_COMPANION_ENABLED; delete process.env.REMOTE_COMPANION_RELEASE_GATE;
  t.after(() => { for (const [key, value] of [['REMOTE_COMPANION_ENABLED', prior.enabled], ['REMOTE_COMPANION_RELEASE_GATE', prior.gate]]) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const state = { owner: ownerA, session: sessionA, active: true, authenticated: true, authCalls: 0, rpcCalls: [], saved: [] };
  const db = { auth: { getClaims: async () => ({ data: { claims: { sub: state.owner, session_id: state.session } }, error: null }) }, rpc: async (name, args) => {
    state.rpcCalls.push({ name, args }); const owned = state.owner === ownerA && args.p_phone_session === sessionA && args.p_binding === bindingId;
    if (name === 'remote_phone_preflight') return { data: owned && state.active, error: null };
    if (name === 'remote_phone_status') return { data: { bindings: owned ? [{ id: bindingId, state: state.active ? 'active' : 'revoked' }] : [], jobs: owned ? state.saved.map(j => ({ id: j.id, state: 'queued' })) : [] }, error: null };
    if (name === 'remote_submit_study') {
      if (!owned || !state.active) return { error: { message: 'REMOTE_CONSENT_REQUIRED' } };
      const prior = state.saved.find(job => job.request.client_request_id === args.p_request.client_request_id);
      if (prior && prior.hash !== args.p_input_hash) return { error: { message: 'REMOTE_ENVELOPE_CONFLICT' } };
      if (prior) return { data: { id: prior.id, duplicate: true, state: 'queued' }, error: null };
      const job = { id: randomUUID(), request: args.p_request, hash: args.p_input_hash }; state.saved.push(job); return { data: { id: job.id, state: 'queued' }, error: null };
    }
    if (name === 'remote_phone_control') {
      const ownerDelete = state.owner === ownerA && args.p_binding === bindingId && args.p_operation === 'delete' && args.p_phone_session === state.session;
      return owned || ownerDelete ? { data: { status: args.p_operation, ...(ownerDelete ? { prompt_erased: true, delivery_state: 'cancel_requested', cancellation_acknowledged: false } : {}) }, error: null } : { error: { message: 'REMOTE_AUTH_REQUIRED' } };
    }
    if (name === 'remote_phone_recover') { if (state.owner === ownerA) state.active = false; return { data: { status: 'revoked_all_own_bindings', text: 'withheld' }, error: null }; }
    return { data: null, error: null };
  } };
  const modules = new Map();
  function load(file) {
    if (modules.has(file)) return modules.get(file);
    const source = readFileSync(new URL(`../apps/web/src/${file}`, import.meta.url), 'utf8'), code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const module = { exports: {} }; new Function('require', 'module', 'exports', code)(id => {
      if (id.endsWith('packages/core/src/remote-companion.mjs')) return protocol;
      if (id === '@/lib/server/remote-companion') return load('lib/server/remote-companion.ts');
      if (id === './auth') return { requireUser: async () => { state.authCalls++; if (!state.authenticated) protocol.remoteFail('REMOTE_AUTH_REQUIRED', 401); return { db, user: { id: state.owner } }; } };
      if (id === '@/lib/server/access') return { sameOrigin: request => request.headers.get('origin') === protocol.REMOTE_ORIGIN ? null : require('next/server').NextResponse.json({ error: 'ORIGIN_DENIED' }, { status: 403 }) };
      if (id === '@supabase/supabase-js') return { createClient: () => db };
      return require(id);
    }, module, module.exports); modules.set(file, module.exports); return module.exports;
  }
  const phone = load('app/api/remote/v1/route.ts'), device = load('app/api/remote/v1/device/route.ts');
  return { state, phone, device, enable() { process.env.REMOTE_COMPANION_ENABLED = 'true'; process.env.REMOTE_COMPANION_RELEASE_GATE = 'status_only_verified_policy'; } };
}
const study = () => ({ schema_version: 1, binding_id: bindingId, client_request_id: randomUUID(), recipe_id: 'study.explain', recipe_version: protocol.REMOTE_VERSION, prompt: 'Explain one selected concept.' });
function req({ operation = 'submit', body = study(), method = 'POST', origin = protocol.REMOTE_ORIGIN, query = '', onBody } = {}) {
  const request = new Request(`${protocol.REMOTE_ORIGIN}/api/remote/v1${query}`, { method, headers: { Origin: origin, 'Content-Type': 'application/json', 'X-LearnBridge-Operation': operation,
    'X-LearnBridge-Binding': bindingId }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
  if (onBody) { const original = request.body.getReader.bind(request.body); request.body.getReader = () => { onBody(); return original(); }; } return request;
}

test('actual Next remote routes default disabled before authentication or acquiring a private request body', async t => {
  const f = fixture(t); let bodies = 0;
  const response = await f.phone.POST(req({ onBody: () => { bodies++; } })); assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'REMOTE_DISABLED');
  assert.equal(f.state.authCalls, 0); assert.equal(bodies, 0); assert.equal(f.state.rpcCalls.length, 0);
  assert.equal((await f.phone.GET(req({ method: 'GET' }))).status, 503);
  assert.equal((await f.device.POST(req())).status, 503);
});

test('authenticated phone preflight happens before body acquisition; canonical retries deduplicate and changed bytes conflict', async t => {
  const f = fixture(t); f.enable(); const input = study(); let observedPreflight = false;
  const first = await f.phone.POST(req({ body: input, onBody: () => { observedPreflight = f.state.rpcCalls.at(-1)?.name === 'remote_phone_preflight'; } }));
  assert.equal(first.status, 202); assert.equal(observedPreflight, true); assert.equal(f.state.saved.length, 1);
  assert.equal((await f.phone.POST(req({ body: input }))).status, 202); assert.equal(f.state.saved.length, 1);
  assert.equal((await f.phone.POST(req({ body: { ...input, prompt: 'Changed exact bytes' } }))).status, 409); assert.equal(f.state.saved.length, 1);
  const args = f.state.rpcCalls.find(call => call.name === 'remote_submit_study').args;
  assert.equal(args.p_phone_session, sessionA); assert(!Object.hasOwn(args, 'account_id')); assert.equal(args.p_input_hash, protocol.remoteHash(input));
});

test('owner/session/origin/query/extra-identity and late grant/auth changes cannot store prompt bytes or list another account work', async t => {
  const f = fixture(t); f.enable();
  f.state.owner = ownerB; f.state.session = sessionB; let bodyReads = 0;
  assert.equal((await f.phone.POST(req({ onBody: () => { bodyReads++; } }))).status, 403); assert.equal(bodyReads, 0);
  assert.deepEqual((await (await f.phone.GET(req({ method: 'GET' }))).json()).jobs, []); assert.equal(f.state.saved.length, 0);
  f.state.owner = ownerA; f.state.session = sessionA;
  assert.equal((await f.phone.POST(req({ origin: 'https://hostile.invalid' }))).status, 403);
  assert.equal((await f.phone.POST(req({ query: '?token=PRIVATE_TOKEN_CANARY' }))).status, 400);
  assert.equal((await f.phone.POST(req({ body: { ...study(), account_id: ownerB } }))).status, 400);
  assert.equal((await f.phone.POST(req({ onBody: () => { f.state.active = false; } }))).status, 403); assert.equal(f.state.saved.length, 0);
  f.state.active = true; assert.equal((await f.phone.POST(req({ onBody: () => { f.state.owner = ownerB; f.state.session = sessionB; } }))).status, 401); assert.equal(f.state.saved.length, 0);
});

test('device API has no human approval/completion/text upload endpoint and never accepts privileged payload properties', async t => {
  const f = fixture(t); f.enable(); const previous = { NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY };
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fixture.supabase.co'; process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'fixture-public-key';
  t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const deviceRequest = (operation, body) => new Request(`${protocol.REMOTE_ORIGIN}/api/remote/v1/device`, { method: 'POST', headers: {
    'Content-Type': 'application/json', Authorization: `Bearer ${'a'.repeat(43)}`, 'X-LearnBridge-Instance': instanceId, 'X-LearnBridge-Binding': bindingId, 'X-LearnBridge-Operation': operation }, body: JSON.stringify(body) });
  for (const operation of ['human_review', 'complete', 'result_text', 'native_turn', 'execute_shell']) assert.equal((await f.device.POST(deviceRequest(operation, {}))).status, 400);
  const event = { job_id: randomUUID(), lease_epoch: 1, sequence: 1, local_run_ref: randomUUID(), state: 'completed', text: 'PRIVATE_RESULT_CANARY' };
  assert.equal((await f.device.POST(deviceRequest('state', event))).status, 400); assert.equal(f.state.rpcCalls.length, 0);
  const response = await f.device.POST(deviceRequest('claim', {})); assert.equal(response.status, 200);
  const args = f.state.rpcCalls.at(-1).args; assert.equal(args.p_instance, instanceId); assert.equal(args.p_binding, bindingId); assert.equal(args.p_operation, 'claim'); assert(!Object.hasOwn(args, 'account_id'));
});

test('fresh verified phone session has content-free revoke-all recovery without accepting an owner from the request', async t => {
  const f = fixture(t); f.enable(); f.state.session = randomUUID();
  assert.equal((await f.phone.POST(req({ operation: 'revoke_all', body: { account_id: ownerB } }))).status, 400); assert.equal(f.state.active, true);
  f.state.owner = ownerB; assert.equal((await f.phone.POST(req({ operation: 'revoke_all', body: {} }))).status, 200); assert.equal(f.state.active, true);
  f.state.owner = ownerA; const reply = await f.phone.POST(req({ operation: 'revoke_all', body: {} })); assert.equal(reply.status, 200);
  assert.equal((await reply.json()).text, 'withheld'); assert.equal(f.state.active, false);
  const args = f.state.rpcCalls.at(-1).args; assert.deepEqual(Object.keys(args), ['p_phone_session']); assert.equal(args.p_phone_session, f.state.session);
});

test('fresh owner prompt erasure forwards current verified session and preserves unacknowledged cancellation metadata', async t => {
  const f = fixture(t); f.enable(); f.state.session = randomUUID(); const jobId = randomUUID();
  f.state.owner = ownerB; assert.equal((await f.phone.POST(req({ operation: 'delete', body: { job_id: jobId } }))).status, 403);
  f.state.owner = ownerA; const response = await f.phone.POST(req({ operation: 'delete', body: { job_id: jobId } })); assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.prompt_erased, true); assert.equal(result.delivery_state, 'cancel_requested'); assert.equal(result.cancellation_acknowledged, false);
  assert.equal(f.state.rpcCalls.at(-1).args.p_phone_session, f.state.session); assert.equal(f.state.rpcCalls.at(-1).args.p_job, jobId);
  assert.equal(Object.hasOwn(f.state.rpcCalls.at(-1).args, 'account_id'), false);
});

test('unapplied migration specifies private RLS/RPC ownership, credential verifier, locks/dedup/cancel/purge and status-only limits', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/202610030003_remote_companion_foundation.sql', import.meta.url), 'utf8');
  for (const table of ['remote_pairing_challenges', 'remote_device_bindings', 'remote_relay_grants', 'remote_jobs', 'remote_delivery_events']) assert(sql.includes(`alter table public.${table} enable row level security`));
  assert.match(sql, /revoke all on public\.remote_pairing_challenges.*from public,anon,authenticated/);
  assert.match(sql, /p_session::text=auth\.jwt\(\)->>'session_id'/); assert.match(sql, /account_id=auth\.uid\(\) and phone_session_ref=p_phone_session for update/);
  assert.match(sql, /credential_hash<>encode\(extensions\.digest\(p_token,'sha256'\),'hex'\)/); assert.match(sql, /unique\(binding_id,client_request_id\)/);
  assert.match(sql, /for update skip locked/); assert.match(sql, /Expired leases are uncertain, never requeued/); assert.match(sql, /created_at<now\(\)-interval '24 hours'/);
  assert.match(sql, /result_scope.*status_only/); assert.doesNotMatch(sql, /grant select|service_role.*credential|state='completed'/i);
  assert.match(sql, /jsonb_typeof\(p_payload->'lease_epoch'\) is distinct from 'number'/);
  assert.match(sql, /job\.lease_epoch is distinct from \(p_payload->>'lease_epoch'\)::bigint/);
  assert.match(sql, /jsonb_typeof\(p_request->'client_request_id'\) is distinct from 'string'/);
  assert.match(sql, /job\.state in \('cancel_requested','awaiting_student'\) and job\.lease_expires_at<=now\(\)/);
  assert.equal(sql.match(/pg_advisory_xact_lock\(298327493\)/g).length, 3);
  assert.match(sql, /remote_phone_recover\(p_phone_session uuid\)/);
  assert.match(sql, /create unique index remote_one_active_installation_workspace[\s\S]*installation_instance_id,workspace_ref\) where state='active'/);
  assert.match(sql, /job\.state in \('cancel_requested','cancelled'\)/);
  assert.match(sql, /elsif binding\.state='revoked' then[\s\S]*set request=null/);
  assert.match(sql, /phone_session_ref=p_phone_session or p_operation='delete'/);
  // This validates source policy only. No PostgreSQL or deployed Supabase proof is implied.
});

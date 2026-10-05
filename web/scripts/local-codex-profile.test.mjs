import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { LocalStore } from '@learnbridge/local-storage';
import { createCodexProfile } from '../apps/local-runtime/src/codex-profile.mjs';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
function fixture(t, mode = 'normal') {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'learnbridge-codex-profile-test-')));
  const store = LocalStore.open({ root: join(parent, 'workspace') }); const profileRoot = join(parent, 'owned-profile');
  const calls = []; let signedIn = false, release = null;
  const adapterFactory = (input, options) => {
    const call = { input, options, closed: false }; calls.push(call);
    const result = { status: 'completed', turn_id:'synthetic-turn', text: JSON.stringify({answer:'A base case ends the selected recursion.',task_proposals:[],document_proposals:[]}), tool_receipts: [], error: null };
    return { async initialize() { if (mode === 'late') await new Promise(resolve => { release = resolve; }); return { state: signedIn ? 'available' : 'requires_auth' }; },
      async startLogin() { return { auth_url: 'https://auth.openai.com/synthetic-login' }; },
      async accountStatus() { return { state: signedIn ? 'available' : 'requires_auth' }; },
      async cancelLogin() { calls.push({ cancelled: true }); }, async logoutAccount() { signedIn = false; calls.push({ loggedOut: true }); },
      async startThread() { assert.equal(input.authorize(), true); },
      async callLearnBridgeTool(tool){ if(mode==='missing_context'&&tool==='learnbridge_context')return {value:{},receipt:{tool:'learnbridge_status',status:'completed',failed:false,result_hash:sha(tool),origin:'runtime'}};return {value:{documents:[]},receipt:{tool,status:'completed',failed:false,result_hash:sha(tool),origin:'runtime'}}; },
      async startTurn({ prompt, outputSchema }) { assert.ok(prompt.includes('prepared approved context'));assert.equal(outputSchema.type,'object'); if (mode === 'revoke') signedIn = false; return { completion: Promise.resolve(result) }; },
      async close() { call.closed = true; } };
  };
  const service = createCodexProfile({ store, executionMode: 'structured', profileRoot, adapterFactory });
  t.after(async () => { await service.stop(); store.close(); rmSync(parent, { recursive: true, force: true }); });
  return { service, store, parent, profileRoot, calls, adapterFactory, signIn: () => { signedIn = true; }, release: () => release?.() };
}
const auth = { sessionId: 'paired-browser-fixture', authorize: () => true };

test('CP01 official login is explicit, private, isolated and does not read a desktop token', async t => {
  const { service, parent, profileRoot, calls, signIn } = fixture(t);
  const unrelated = join(parent, 'existing-codex'); mkdirSync(unrelated, { mode: 0o700 }); writeFileSync(join(unrelated, 'auth.json'), 'PRIVATE_DESKTOP_TOKEN_CANARY');
  assert.equal(existsSync(profileRoot), false); assert.equal(service.status().state, 'requires_auth');
  assert.equal((await service.connect(auth)).auth_url, 'https://auth.openai.com/synthetic-login');
  assert.equal(calls[0].options.configurationHome, profileRoot); assert.equal(calls[0].input.persistSessions, false);
  assert.equal(calls[0].options.limits.maxOutputBytes,1_000_000);
  await assert.rejects(service.check({ ...auth, sessionId: 'another-browser' }), { code: 'CONSENT_REQUIRED' });
  signIn(); assert.equal((await service.check(auth)).state, 'available'); assert.equal(calls[0].closed, true); assert.equal(existsSync(calls[0].input.projectRoot), false);
  assert.equal(JSON.stringify(service.status()).includes('PRIVATE_DESKTOP_TOKEN_CANARY'), false);
});
test('CP02 execution requires completed sign-in and both actual context/status receipts', async t => {
  const { service, signIn, store, calls } = fixture(t);
  const input = { grantId: store.identity.student_id, prompt: 'Explain the selected note.', authorize: () => true };
  await assert.rejects(service.execute(input), { code: 'AUTH_REQUIRED' });
  await service.connect(auth); signIn(); await service.check(auth);
  const output = await service.execute(input); assert.equal(output.state, 'completed'); assert.equal(output.complete, true); assert.equal(output.output_sha256, sha(output.text)); assert.equal(output.tool_receipts.length, 2);
  assert.equal(output.context_delivery,'runtime_prepared'); assert.equal(service.status().tool_execution,'runtime_prepared');
  assert.equal(existsSync(calls[1].input.projectRoot), false); assert.equal(calls[1].closed, true);
});
test('CP03 an answer without selected-context proof is rejected instead of marked successful', async t => {
  const { service, signIn, store } = fixture(t, 'missing_context'); await service.connect(auth); signIn(); await service.check(auth);
  await assert.rejects(service.execute({ grantId: store.identity.student_id, prompt: 'Explain.', authorize: () => true }), { code: 'VERSION_MISMATCH' });
});
test('CP04 another student, unmarked directory or profile inside a backup is rejected', async t => {
  const { store, parent } = fixture(t); const root = join(parent, 'unowned'); mkdirSync(root, { mode: 0o700 }); writeFileSync(join(root, 'auth.json'), 'PRIVATE_TOKEN_CANARY', { mode: 0o600 });
  const other = createCodexProfile({ store, executionMode: 'structured', profileRoot: root }); await assert.rejects(other.connect(auth));
  assert.throws(() => createCodexProfile({ store, executionMode: 'structured', profileRoot: join(store.root, 'auth') }), { code: 'SCOPE_DENIED' });
});
test('CP05 disconnect uses official logout and source execution remains disabled after browser reset', async t => {
  const { service, signIn, calls } = fixture(t); await service.connect(auth); signIn(); await service.check(auth);
  await service.disconnect(auth); assert.equal(service.status().state, 'requires_auth'); assert.equal(calls.some(call => call.loggedOut), true);
  await service.connect(auth); await service.clear(); assert.equal(service.status().login_in_progress, false);
});
test('CP06 a late login completion cannot restore authority after logout', async t => {
  const { service, release } = fixture(t, 'late'); const pending = service.connect(auth);
  await new Promise(resolve => setImmediate(resolve)); await service.clear(); release(); await assert.rejects(pending, { code: 'CONSENT_REQUIRED' });
  assert.equal(service.status().state, 'requires_auth'); assert.equal(service.status().login_in_progress, false);
});
test('CP07 paired HTTP sign-in is nonce protected and uses the installed profile controller', async t => {
  const { store, adapterFactory, profileRoot, signIn } = fixture(t); const root = store.root; store.close();
  const runtime = await startRuntime({ dataRoot: root, port: 0, codexProfileOptions: { profileRoot, adapterFactory } }); t.after(() => runtime.close());
  const call = async (path, method='GET', body, headers={}) => fetch(runtime.origin + '/api/local/v1' + path,{method,headers:{Origin:runtime.origin,...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await call('/ai/status')).status,401);
  const paired=await call('/pair','POST',{code:runtime.createPairingCode()}), session=await paired.json(); const headers={Cookie:paired.headers.get('set-cookie').split(';')[0],'X-LearnBridge-Nonce':session.nonce};
  assert.equal((await call('/ai/connect','POST',{confirmed:true},{Cookie:headers.Cookie})).status,403);
  assert.equal((await call('/ai/connect?binary=unsafe','POST',{confirmed:true},headers)).status,400);
  assert.equal((await call('/ai/connect','POST',{confirmed:true,token:'PRIVATE_TOKEN_CANARY'},headers)).status,400);
  const result=await call('/ai/connect','POST',{confirmed:true},headers); assert.equal(result.status,200); assert.equal((await result.json()).auth_url,'https://auth.openai.com/synthetic-login');
  signIn(); assert.equal((await (await call('/ai/check','POST',{confirmed:true},headers)).json()).state,'available');
  assert.equal((await call('/logout','POST',{},headers)).status,200); assert.equal((await call('/ai/status','GET',undefined,headers)).status,401);
});

test('CP09 failed native adapter construction releases its lease and removes its temporary project', async t => {
  const f=fixture(t);f.signIn();let constructions=0,project,released=false;
  const service=createCodexProfile({store:f.store,profileRoot:join(f.parent,'failure-profile'),
    leaseFactory:()=>({id:randomUUID(),release(){released=true;}}),adapterFactory(input,options){
      if(++constructions===2){project=input.projectRoot;throw new Error('Synthetic constructor failure');}
      return f.adapterFactory(input,options);
    }});
  t.after(()=>service.stop());await service.connect(auth);
  await assert.rejects(service.execute({grantId:f.store.identity.student_id,prompt:'Synthetic',authorize:()=>true}),/Synthetic constructor failure/);
  assert.equal(released,true);assert.equal(existsSync(project),false);
});

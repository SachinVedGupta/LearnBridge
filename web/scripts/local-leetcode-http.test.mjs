import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { leetcodeFixtureClient } from './fixtures/leetcode-test-support.mjs';
const user='FixtureStudent', secret='SYNTHETIC_LOCAL_BROWSER_SESSION_123';
const sha=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t, { nativeBrowser = false } = {}) {
  const parent=mkdtempSync(join(tmpdir(),'learnbridge-leetcode-http-')), dataRoot=join(parent,'private'), clients=leetcodeFixtureClient({count:5}); let browserOpen=false, retained=false, cookie=secret, starts=0, reads=0, forgets=0, modelCalls=0;
  let browserInstances=0, activeNative=null; const startedInstances=[];
  const browserFactory=()=>{
    if (!nativeBrowser) return { status:()=>({state:browserOpen?'open':'closed',profile_retained:retained,capability:{state:'available'}}), async start(){browserOpen=true;retained=true;starts++;return this.status();},async session(){if(!browserOpen){const error=new Error('browser closed');error.code='AUTH_REQUIRED';throw error;}reads++;return cookie;},async close({forget=false}={}){browserOpen=false;if(forget){retained=false;forgets++;}} };
    const id=++browserInstances; let state='not_started', terminal=false, epoch=0;
    const adapter={
      status:()=>({state,profile_retained:retained,capability:{state:'available'}}),
      authorityEpoch:()=>epoch,
      async start(){if(terminal){const error=new Error('Adapter is terminal');error.code='OFFLINE';throw error;}state='awaiting_sign_in';browserOpen=true;retained=true;starts++;startedInstances.push(id);return this.status();},
      async session(){if(terminal||!browserOpen){const error=new Error('Sign in first');error.code='AUTH_REQUIRED';throw error;}reads++;state='account_session_available';return cookie;},
      async close({forget=false}={}){terminal=true;epoch++;state=forget?'forgotten':'closed';browserOpen=false;if(forget){retained=false;forgets++;}},
    };
    activeNative={navigate:()=>{epoch++;state='awaiting_account_check';}};
    return adapter;
  };
  const runtime=await startRuntime({dataRoot,port:0,leetcodeClientFactory:clients.clientFactory,leetcodeBrowserFactory:browserFactory,hostAdapter:{enabled:true,execute:async input=>{modelCalls++; assert.equal(input.toolPolicy,'read_only'); input.onProgress({phase:'tool',tool:'learnbridge_context',state:'finished'}); const match=/source_refs only.*?([a-f0-9-]{36})/.exec(input.prompt); const ids=input.prompt.match(/[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}/g); const problemId=match?.[1]||ids?.at(-1); const payload={kind:'question',message:'Explain your approach before coding.',follow_up:'Which edge case would you test first?',source_refs:[problemId]}; const text=`BEGIN_LEARNBRIDGE_CODING\n${JSON.stringify(payload)}\nEND_LEARNBRIDGE_CODING`; return {state:'completed',complete:true,text,output_sha256:sha(text),host_version:'fixture',error_code:null,tool_receipts:[{tool:'learnbridge_context',status:'completed',failed:false,result_hash:sha('fixture-selection'),origin:'model'}]};}}});
  t.after(async()=>{await runtime.close();rmSync(parent,{recursive:true,force:true});});
  async function pair(){const response=await fetch(runtime.origin+'/api/local/v1/pair',{method:'POST',headers:{Origin:runtime.origin,'Content-Type':'application/json'},body:JSON.stringify({code:runtime.createPairingCode()})});const data=await response.json();assert.equal(response.status,200);return {nonce:data.nonce,cookie:response.headers.get('set-cookie').split(';')[0]};}
  const session=await pair();
  async function call(path,body,opts={}){ const method=opts.method||(body===undefined?'GET':'POST'), chosen=opts.session||session; const response=await fetch(runtime.origin+'/api/local/v1'+path,{method,headers:{Cookie:chosen.cookie,'X-LearnBridge-Nonce':chosen.nonce,...(method==='GET'?{}:{Origin:runtime.origin,'Content-Type':'application/json'}),...opts.headers,...(opts.idempotencyKey?{'Idempotency-Key':opts.idempotencyKey}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}); return {status:response.status,data:await response.json()}; }
  return {runtime,dataRoot,clients,call,pair,session,rotation:()=>{cookie='SYNTHETIC_LOCAL_BROWSER_ROTATED_456';},navigate:()=>activeNative.navigate(),get stats(){return {browserOpen,retained,starts,reads,forgets,modelCalls,browserInstances,startedInstances:[...startedInstances]};}};
}
async function signin(f){assert.equal((await f.call('/leetcode/browser/start',{confirmed:true})).status,201); const result=await f.call('/leetcode/browser/check',{confirmed:true}); assert.equal(result.status,200); assert.equal(result.data.connection.username,user); return result;}

test('actual HTTP gate rejects unpaired/cross-origin/nonce bodies before any provider or browser action',async t=>{const f=await fixture(t); const anonymous=await fetch(f.runtime.origin+'/api/local/v1/leetcode/state');assert.equal(anonymous.status,401); const origin=await f.call('/leetcode/browser/start',{confirmed:true},{headers:{Origin:'https://other.test'}});assert.equal(origin.status,403);const nonce=await f.call('/leetcode/connect',{username:user,session:secret,confirmed:true},{headers:{'X-LearnBridge-Nonce':'wrong'}});assert.equal(nonce.status,403); const extra=await f.call('/leetcode/browser/start',{confirmed:true,url:'https://other.test'});assert.equal(extra.status,400);assert.equal(f.stats.starts,0);assert.equal(f.clients.calls.length,0);});

test('normal local sign-in discovers exact account, sends no browser cookie to UI, and rotations need no pasted value',async t=>{const f=await fixture(t);const result=await signin(f);assert(!JSON.stringify(result.data).includes(secret));const state=await f.call('/leetcode/state');assert.equal(state.data.browser.owner,true);assert.equal(state.data.browser.profile_retained,true);f.rotation();const history=await f.call('/leetcode/sync',{confirmed:true,limit:20,include_contest:false});assert.equal(history.status,201);assert.equal(history.data.item.data.attempts.length,5);assert.equal(f.stats.reads,2);assert(f.clients.closed.length>=2);assert(!JSON.stringify(history.data).includes('SYNTHETIC_LOCAL_BROWSER'));const second=await f.pair();assert.equal((await f.call('/leetcode/state',undefined,{session:second})).data.connection.owned_by_other_browser,true);assert.equal((await f.call('/leetcode/sync',{confirmed:true,limit:20,include_contest:false},{session:second})).status,403);});

test('account mismatch cannot connect and actor-controlled usernames/urls do not select alternate authority',async t=>{const f=await fixture(t);await f.call('/leetcode/browser/start',{confirmed:true});assert.equal((await f.call('/leetcode/browser/check',{username:'OtherStudent',confirmed:true})).status,403);assert.equal((await f.call('/leetcode/browser/check',{username:[],confirmed:true})).status,400);assert.equal((await f.call('/leetcode/browser/check',{username:'https://other.test',confirmed:true})).status,400);assert.equal((await f.call('/leetcode/state')).data.connection.state,'disconnected');assert.equal(f.stats.modelCalls,0);});

test('logout stops transient client/browser; a new pair can reopen retained login or explicitly forget it',async t=>{const f=await fixture(t);await signin(f);assert.equal((await f.call('/logout',{})).status,200);assert.equal(f.stats.browserOpen,false);assert.equal(f.stats.retained,true);assert.equal((await f.call('/leetcode/state')).status,401);const second=await f.pair();assert.equal((await f.call('/leetcode/browser/start',{confirmed:true},{session:second})).status,201);assert.equal((await f.call('/leetcode/browser/check',{confirmed:true},{session:second})).status,200);assert.equal((await f.call('/leetcode/browser/forget',{confirmed:false},{session:second})).status,403);assert.equal((await f.call('/leetcode/browser/forget',{confirmed:true},{session:second})).status,200);assert.equal(f.stats.retained,false);assert.equal(f.stats.forgets,1);});

test('native local-browser stages remain visible while open state is normalized for the sign-in UI',async t=>{
  const f=await fixture(t,{nativeBrowser:true});
  const initial=(await f.call('/leetcode/state')).data.browser;
  assert.equal(initial.state,'closed');assert.equal(initial.sign_in_stage,'not_started');
  const started=await f.call('/leetcode/browser/start',{confirmed:true});
  assert.equal(started.status,201);assert.equal(started.data.browser.state,'open');assert.equal(started.data.browser.sign_in_stage,'awaiting_sign_in');
  const checked=await f.call('/leetcode/browser/check',{confirmed:true});
  assert.equal(checked.status,200);assert.equal(checked.data.browser.state,'open');assert.equal(checked.data.browser.sign_in_stage,'account_session_available');
  const state=(await f.call('/leetcode/state')).data;
  assert.equal(state.browser.state,'open');assert.equal(state.browser.sign_in_stage,'account_session_available');assert.equal(state.connection.username,user);
  assert.equal(f.stats.browserInstances,1);assert.deepEqual(f.stats.startedInstances,[1]);assert(!JSON.stringify(state).includes(secret));
});

test('logout and explicit forget replace terminal native adapters before reopening a retained or fresh sign-in',async t=>{
  const f=await fixture(t,{nativeBrowser:true});await signin(f);
  assert.equal((await f.call('/logout',{})).status,200);assert.equal(f.stats.retained,true);assert.equal(f.stats.browserOpen,false);
  const next=await f.pair();
  const closed=(await f.call('/leetcode/state',undefined,{session:next})).data.browser;
  assert.equal(closed.state,'closed');assert.equal(closed.sign_in_stage,'closed');assert.equal(closed.profile_retained,true);
  assert.equal((await f.call('/leetcode/browser/start',{confirmed:true},{session:next})).status,201);
  assert.equal((await f.call('/leetcode/browser/check',{confirmed:true},{session:next})).status,200);
  assert.equal(f.stats.browserInstances,2);assert.deepEqual(f.stats.startedInstances,[1,2]);
  assert.equal((await f.call('/leetcode/browser/forget',{confirmed:true},{session:next})).status,200);
  const forgotten=(await f.call('/leetcode/state',undefined,{session:next})).data;
  assert.equal(forgotten.browser.state,'closed');assert.equal(forgotten.browser.sign_in_stage,'forgotten');assert.equal(forgotten.browser.profile_retained,false);assert.equal(forgotten.connection.state,'disconnected');
  assert.equal((await f.call('/leetcode/browser/start',{confirmed:true},{session:next})).status,201);
  assert.equal((await f.call('/leetcode/browser/check',{confirmed:true},{session:next})).status,200);
  assert.equal(f.stats.browserInstances,3);assert.deepEqual(f.stats.startedInstances,[1,2,3]);assert.equal(f.stats.forgets,1);
});

test('native top-frame navigation revokes a pending private history read before any snapshot commit',async t=>{
  const f=await fixture(t,{nativeBrowser:true});await signin(f);
  let pageEntered,releasePage;
  const entered=new Promise(resolve=>{pageEntered=resolve;});
  const blockedPage=new Promise(resolve=>{releasePage=resolve;});
  f.clients.handle(async name=>{if(name==='get_all_submissions'){pageEntered();await blockedPage;}});
  const pending=f.call('/leetcode/sync',{confirmed:true,limit:20,include_contest:false});
  try { await Promise.race([entered,delay(2000).then(()=>{throw new Error('Private history page was not requested');})]);f.navigate(); } finally { releasePage(); }
  const denied=await pending;
  assert.equal(denied.status,403);assert.equal(denied.data.error.code,'CONSENT_REQUIRED');assert(!JSON.stringify(denied.data).includes(secret));
  const after=(await f.call('/leetcode/state')).data;
  assert.equal(after.snapshots.length,0);assert.equal(after.browser.sign_in_stage,'awaiting_account_check');assert.equal(after.browser.state,'open');
  assert.equal(f.clients.calls.filter(row=>row.name==='get_all_submissions').length,1);assert.equal(f.stats.modelCalls,0);
  f.clients.handle(null);
  assert.equal((await f.call('/leetcode/browser/check',{confirmed:true})).status,200);
  const retry=await f.call('/leetcode/sync',{confirmed:true,limit:20,include_contest:false});
  assert.equal(retry.status,201);assert.equal(retry.data.item.data.attempts.length,5);assert.equal((await f.call('/leetcode/state')).data.snapshots.length,1);
});

test('real HTTP private history -> selected answer -> pinned interview checkpoint -> exact-note read-only coaching',async t=>{
 const f=await fixture(t);await signin(f);const snapshot=(await f.call('/leetcode/sync',{confirmed:true,limit:20,include_contest:false},{idempotencyKey:randomUUID()})).data.item;
 const report=(await f.call('/leetcode/submissions/10001',{snapshot_id:snapshot.id,confirmed:true})).data.item;assert.equal(report.data.slug,'two-sum');
 const metadata=(await f.call('/leetcode/state')).data.saved_submissions;assert.equal(metadata.length,1);assert.equal(metadata[0].sha256,report.sha256);assert(!JSON.stringify(metadata).includes(report.data.code));const retained=(await f.call('/leetcode/saved-submissions/'+report.id)).data.item;assert.equal(retained.data.code,report.data.code);
 const problem=(await f.call('/leetcode/problems',{slug:'two-sum',confirmed:true})).data.item;
 let session=(await f.call('/coding-practice/sessions',{problem_ref:{id:problem.id,revision:problem.revision,sha256:problem.sha256},language:'python3',mode:'mock_interview'},{idempotencyKey:randomUUID()})).data.item;
 const review=()=>({expected_revision:session.revision,context_hash:session.data.context_hash});
 const imported=await f.call('/coding-practice/sessions/'+session.id+'/import-submission',{...review(),submission_ref:{id:report.id,revision:report.revision,sha256:report.sha256},explanation:'I used indices zero and one. I need to reason about other inputs.',confirmed:true});assert.equal(imported.status,200);session=imported.data.item;assert.equal(session.checkpoints[0].data.code,report.data.code);assert.equal(session.data.context_note,null);
 const savedNote=await f.call('/coding-practice/sessions/'+session.id+'/export-context',review());assert.equal(savedNote.status,200);session=savedNote.data.item;const note=session.data.context_note;
 const grant=(await f.call('/agent-grants',{destination:'codex',task_ids:[],document_ids:[note.id],source_entry_ids:[],expected_records:{tasks:[],documents:[{id:note.id,revision:note.revision}],source_entries:[]},max_bytes:256000,expires_in_minutes:30})).data.grant;
 const preview=await f.call('/coding-practice/sessions/'+session.id+'/preview-run',{...review(),kind:'question'});assert.equal(preview.status,200);
 const run=await f.call('/coding-practice/sessions/'+session.id+'/run',{...review(),kind:'question',grant_id:grant.id,prompt_sha256:preview.data.item.prompt_sha256,confirmed:true},{idempotencyKey:randomUUID()});assert.equal(run.status,202);
 for(let i=0;i<20;i++){const status=await f.call('/coding-practice/sessions/'+session.id);session=status.data.item;if(session.data.pending?.state!=='running')break;await delay(20);}
 assert.equal(session.data.pending.state,'completed');assert.equal(session.data.coaching.length,1);assert.equal(session.data.coaching[0].payload.follow_up,'Which edge case would you test first?');assert.equal(session.code_execution_verified,false);assert.equal(f.stats.modelCalls,1);
 for(const path of ['/leetcode/submit','/leetcode/run_code','/coding-practice/sessions/'+session.id+'/execute'])assert((await f.call(path,{confirmed:true})).status>=400);
 assert(!f.clients.calls.some(row=>['submit_solution','run_code','create_note'].includes(row.name)));assert(!readFileSync(join(f.dataRoot,'learnbridge.sqlite')).includes(Buffer.from(secret)));
});

test('history coaching export requires exact observation and creates no model sharing or execution',async t=>{const f=await fixture(t);await signin(f);const snapshot=(await f.call('/leetcode/sync',{confirmed:true,limit:20,include_contest:false})).data.item;const path='/leetcode/snapshots/'+snapshot.id+'/export-context';assert.equal((await f.call(path,{expected_revision:snapshot.revision,sha256:'0'.repeat(64),confirmed:true})).status,409);const note=await f.call(path,{expected_revision:snapshot.revision,sha256:snapshot.sha256,confirmed:true});assert.equal(note.status,201);assert.equal(note.data.item.sharing,'not_granted');assert(note.data.item.content.includes('Wrong Answer'));assert(!note.data.item.content.includes(secret));assert.equal((await f.call('/agent-grants')).data.items.length,0);assert.equal(f.stats.modelCalls,0);});

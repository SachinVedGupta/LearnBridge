import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {LocalStore} from '../packages/local-storage/src/index.mjs';
import {startRuntime} from '../apps/local-runtime/src/server.mjs';
import {requestAgentControl} from '../apps/local-runtime/src/ipc.mjs';
import {createRemoteRoutes} from '../apps/local-runtime/src/remote-routes.mjs';
import {createRemoteResults,createRemoteResultTransport} from '../apps/local-runtime/src/remote-results.mjs';
import {openRemoteInstance} from '../apps/local-runtime/src/remote-companion.mjs';
import {createWritingService} from '../apps/local-runtime/src/writing-service.mjs';
import {REMOTE_ORIGIN,remoteHash} from '../packages/core/src/remote-companion.mjs';
import {parseRemoteResultUpload,boundedRemoteResultBody} from '../packages/core/src/remote-results.mjs';
import {phoneStudyRequest,verifyPhoneResult} from '../apps/web/src/app/remote/remote-phone-client.mjs';
import {relayFixture} from './fixtures/remote-result-fixture.mjs';
const selected='SELECTED_SOURCE_CANARY: The base case terminates recursion.',unselected='UNSELECTED_SOURCE_CANARY HOST_AUTH_CANARY UNIVERSITY_AUTH_CANARY';
const hostResult=text=>({state:'completed',complete:true,text,output_sha256:remoteHash(text),tool_receipts:[{tool:'learnbridge_context',status:'completed',failed:false,result_hash:remoteHash('synthetic context')}],host_version:'synthetic-only',error_code:null});
const review=row=>({expected_revision:row.revision,payload_hash:row.data.payload_hash});
async function browser(runtime){const response=await fetch(`${runtime.origin}/api/local/v1/pair`,{method:'POST',headers:{Origin:runtime.origin,'Content-Type':'application/json'},body:JSON.stringify({code:runtime.createPairingCode()})});
 const nonce=(await response.json()).nonce,cookie=response.headers.get('set-cookie').split(';')[0];return {nonce,cookie,async call(path,body,extra={}){const {method,...headers}=extra;const response=await fetch(`${runtime.origin}/api/local/v1${path}`,{method:method||(body===undefined?'GET':'POST'),headers:{Origin:runtime.origin,Cookie:cookie,'Content-Type':'application/json','X-LearnBridge-Nonce':nonce,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,data:await response.json()};}};}
async function fixture(t,{native=true,execute}={}){
 const base=mkdtempSync(join(tmpdir(),'learnbridge-remote-result-')),relay=await relayFixture();let calls=0,sourceId;const nativeTexts=[];
 const runtime=await startRuntime({dataRoot:join(base,'private'),port:0,hostAdapter:{enabled:true,execute:execute|| (async input=>{calls++;const context=await requestAgentControl(input.dataRoot,'codex','context',{grant_id:input.grantId,task_ids:[],document_ids:[sourceId],source_entry_ids:[],max_bytes:12000});nativeTexts.push(context.documents[0].text);return hostResult('SYNTHETIC_HOST_RESPONSE: A base case stops recursion.');})},remoteOptions:{enabled:true,nativeEnabled:native,transportFactory:relay.factory}});
 t.after(async()=>{await runtime.close();await relay.close();rmSync(base,{recursive:true,force:true});});const owner=await browser(runtime);
 const chosen=await owner.call('/documents',{title:'Selected synthetic lecture',content:selected,kind:'study'});assert.equal(chosen.status,201);sourceId=chosen.data.document.id;
 await owner.call('/documents',{title:'Excluded fixture',content:unselected,kind:'note'});
 const grant=await owner.call('/agent-grants',{destination:'codex',task_ids:[],document_ids:[chosen.data.document.id],source_entry_ids:[],expected_records:{tasks:[],documents:[{id:chosen.data.document.id,revision:1}],source_entries:[]},max_bytes:64000,expires_in_minutes:60});assert.equal(grant.status,201);
 async function pair(who=owner){const pending=await relay.phone('pair');const paired=await who.call('/remote/pair',{...pending.data,confirmed:true,host_grant_id:grant.data.grant.id,expires_in_minutes:30,max_requests:3,max_request_bytes:16384,native_execution_confirmed:native});assert.equal(paired.status,201,JSON.stringify(paired.data));return paired;}
 async function enqueue(){const queued=await relay.phone('submit',phoneStudyRequest(relay.state.binding.id,'Explain one step of recursion from my selected note.'));assert.equal(queued.status,200);return queued.data.id;}
 async function draft(){await owner.call('/remote/poll',{});for(let n=0;n<50;n++){const polled=await owner.call('/remote/poll',{});assert.equal(polled.status,200,JSON.stringify(polled.data));const writing=await owner.call('/writing/items');if(writing.data.items.length){const row=writing.data.items[0],full=await owner.call(`/writing/items/${row.id}`);return full.data.item;}await delay(5);}assert.fail(`Synthetic host writing proposal did not finish: ${JSON.stringify((await owner.call('/host-turns')).data)}`);}
 async function approve(jobId,item){const accepted=await owner.call(`/writing/items/${item.id}/accept`,review(item));assert.equal(accepted.status,200);const row=accepted.data.item;
  const preview=await owner.call('/remote/results/preview',{job_id:jobId,writing_record_id:row.id,...review(row),expires_in_minutes:15});assert.equal(preview.status,200,JSON.stringify(preview.data));
  const result=await owner.call('/remote/results',{preview_id:preview.data.preview_id,review_hash:preview.data.preview.review_hash,confirmed:true});assert.equal(result.status,201,JSON.stringify(result.data));return {preview:preview.data.preview,row:result.data.item,writing:row};}
 return {base,runtime,relay,owner,chosen:chosen.data,grant:grant.data.grant,pair,enqueue,draft,approve,calls:()=>calls,nativeTexts};
}

test('disabled routes are lazy and touch no device marker, private body, storage, auth credential or network',async()=>{
 let bodyReads=0,instances=0;const routes=createRemoteRoutes({enabled:false,store:new Proxy({},{get(){throw Error('store touched');}}),instanceFactory(){instances++;throw Error('instance touched');}});
 const session={nonce:'owner',expires_at:new Date(Date.now()+60000).toISOString()},stillAuthorized=()=>{};
 assert.equal((await routes.handle({route:'/remote/status',method:'GET',session,stillAuthorized})).data.paired,false);
 const denied=await routes.handle({route:'/remote/pair',method:'POST',session,stillAuthorized,privateBody:async()=>{bodyReads++;return {};}});assert.equal(denied.status,503);assert.equal(bodyReads,0);assert.equal(instances,0);assert.equal(routes.controller,null);
 const disabled=createRemoteResults({store:new Proxy({},{get(){throw Error('store touched');}})});assert.equal(disabled.status().enabled,false);await assert.rejects(disabled.pollOnce(),{code:'REMOTE_DISABLED'});
});

test('trusted native availability is resolved on explicit enrollment and unavailable host consent fails before device creation',async()=>{
 let ready=false,created=0;const routes=createRemoteRoutes({enabled:true,nativeEnabled:()=>ready,instanceFactory:()=>{created++;throw Error('instance must not be created');},store:new Proxy({},{get(){throw Error('store must not be touched');}})});
 const session={nonce:'native-owner',expires_at:new Date(Date.now()+60000).toISOString()},stillAuthorized=()=>{};
 assert.equal((await routes.handle({route:'/remote/status',method:'GET',session,stillAuthorized})).data.native_available,false);
 const result=await routes.handle({route:'/remote/pair',method:'POST',session,stillAuthorized,privateBody:async()=>({pending_id:randomUUID(),challenge:'a'.repeat(32),confirmed:true,host_grant_id:randomUUID(),expires_in_minutes:30,max_requests:3,max_request_bytes:16384,native_execution_confirmed:true})});
 assert.equal(result.status,503);assert.equal(result.data.error.code,'REMOTE_NATIVE_UNAVAILABLE');assert.match(result.data.error.message,/Codex profile/);assert.equal(created,0);ready=true;
 assert.equal((await routes.handle({route:'/remote/status',method:'GET',session,stillAuthorized})).data.native_available,true);
});

test('delayed failed enrollment from logged-out A cannot stop or clear B; concurrent enrollment acquires no second body',async t=>{
 const base=mkdtempSync(join(tmpdir(),'learnbridge-phone-pair-race-')),repository=join(base,'repo');mkdirSync(repository);const store=LocalStore.open({root:join(base,'workspace')}),instance=openRemoteInstance({root:join(base,'instance'),workspaceRoot:store.root,repositoryRoot:repository}),relay=await relayFixture();
 t.after(async()=>{await routes.clear();store.close();await relay.close();rmSync(base,{recursive:true,force:true});});const selected=store.createDocument({title:'Synthetic scope',text:'Synthetic scope'}),grant=store.createAgentGrant({destination:'codex',task_ids:[],document_ids:[selected.document.id],source_entry_ids:[],max_bytes:64000,expires_in_minutes:60});
 const routes=createRemoteRoutes({enabled:true,store,instance,transportFactory:relay.factory}),sessionA={nonce:'browser-A',expires_at:new Date(Date.now()+60000).toISOString()},sessionB={nonce:'browser-B',expires_at:new Date(Date.now()+60000).toISOString()};let allowA=true,release,entered;const waiting=new Promise(resolve=>{entered=resolve;}),blocked=new Promise(resolve=>{release=resolve;});let confirms=0;
 relay.state.hook=async operation=>{if(operation==='confirm'&&++confirms===1){entered();await blocked;}};
 const fields=pending=>({...pending,confirmed:true,host_grant_id:grant.id,expires_in_minutes:30,max_requests:3,max_request_bytes:16384,native_execution_confirmed:false}),pendingA=(await relay.phone('pair')).data;
 const first=routes.handle({route:'/remote/pair',method:'POST',session:sessionA,stillAuthorized:()=>allowA,privateBody:async()=>fields(pendingA)});await waiting;
 let secondBodies=0;assert.equal((await routes.handle({route:'/remote/pair',method:'POST',session:sessionA,stillAuthorized:()=>allowA,privateBody:async()=>{secondBodies++;return fields(pendingA);}})).status,409);assert.equal(secondBodies,0);
 allowA=false;await routes.clear({nonce:sessionA.nonce});const pendingB=(await relay.phone('pair')).data;assert.equal((await routes.handle({route:'/remote/pair',method:'POST',session:sessionB,stillAuthorized:()=>true,privateBody:async()=>fields(pendingB)})).status,201);
 const actualB=routes.controller,status=await routes.handle({route:'/remote/status',method:'GET',session:sessionB,stillAuthorized:()=>true});assert.equal(status.data.paired,true);
 release();await first.catch(()=>{});assert.equal(routes.controller,actualB);assert.equal((await routes.handle({route:'/remote/status',method:'GET',session:sessionB,stillAuthorized:()=>true})).data.paired,true);
});

test('actual phone HTTP → paired runtime → durable injected host → local writing review → exact consent → relay → fresh one-use phone read',async t=>{
 const f=await fixture(t);assert.equal(existsSync(join(f.base,'private-remote-device')),false);await f.pair();assert.equal(existsSync(join(f.base,'private-remote-device','remote-instance.json')),true);const job=await f.enqueue(),draft=await f.draft();
 assert.equal(draft.data.state,'awaiting_review');assert.equal(f.calls(),1);assert.deepEqual(f.nativeTexts,[selected]);assert.equal(f.relay.state.results.length,0);
 assert(!JSON.stringify(f.relay.state.ledger).includes('SELECTED_SOURCE_CANARY'));assert(!JSON.stringify(f.relay.state.ledger).includes('UNSELECTED_SOURCE_CANARY'));
 const {row,preview}=await f.approve(job,draft);assert.equal(row.state,'reviewed');assert.equal(f.relay.state.results.length,0);assert.equal(preview.policy.source_documents[0].id,f.chosen.document.id);
 assert.equal((await f.owner.call(`/remote/results/${row.id}/send`,{expected_revision:row.revision,review_hash:row.review_hash})).status,200);assert.equal(f.relay.state.results.length,1);assert.equal(f.relay.state.results[0].text,preview.text);
 const result=f.relay.state.results[0],ticket=await f.relay.phone('begin_delivery',{result_id:result.id},true);assert.equal((await f.relay.phone('read',{delivery_id:ticket.data.id},true)).status,409);
 assert.equal((await f.owner.call('/remote/delivery/poll',{})).data.fresh_local_check,true);const delivered=await f.relay.phone('read',{delivery_id:ticket.data.id},true);assert.equal(delivered.status,200);
 const verified=await verifyPhoneResult(delivered.data,{bindingId:f.relay.state.binding.id,resultId:result.id,deliveryId:ticket.data.id});assert.equal(verified.text,preview.text);assert.equal(verified.sha256,remoteHash(preview.text));
 assert.equal((await f.relay.phone('read',{delivery_id:ticket.data.id},true)).status,409);assert.equal((await f.owner.call('/tasks')).data.items.length,0);assert(!JSON.stringify(f.relay.state.ledger).includes('UNSELECTED_SOURCE_CANARY'));
});

test('a second paired browser cannot inspect or control the first browser enrollment; logout stops work and a fresh explicit pairing can reconnect',async t=>{
 const f=await fixture(t,{native:false});await f.pair();await f.enqueue();await f.owner.call('/remote/poll',{});const other=await browser(f.runtime);
 assert.equal((await other.call('/remote/status')).data.paired,false);for(const route of ['/remote/jobs','/remote/results'])assert.equal((await other.call(route)).status,403);
 assert.equal((await other.call('/remote/poll',{})).status,403);const pending=await f.relay.phone('pair');assert.equal((await other.call('/remote/pair',{...pending.data,confirmed:true,host_grant_id:f.grant.id,expires_in_minutes:30,max_requests:3,max_request_bytes:16384,native_execution_confirmed:false})).status,403);
 assert.equal((await f.owner.call('/logout',{})).status,200);assert.equal((await other.call('/remote/status')).data.paired,false);assert.equal((await other.call('/remote/poll',{})).status,403);
 await f.relay.phone('revoke_all');await f.pair(other);assert.equal((await other.call('/remote/status')).data.permission_current,true);assert.equal((await other.call('/remote/unpair',{confirmed:true})).status,200);
 await f.pair(other);assert.equal((await other.call('/remote/status')).data.paired,true);assert.equal(f.calls(),0);
});

test('source edits after preview invalidate approval and source/grant changes prevent unreviewed/private result transmission',async t=>{
 const f=await fixture(t);await f.pair();const job=await f.enqueue(),draft=await f.draft();const accepted=await f.owner.call(`/writing/items/${draft.id}/accept`,review(draft)),row=accepted.data.item;
 const preview=await f.owner.call('/remote/results/preview',{job_id:job,writing_record_id:row.id,...review(row),expires_in_minutes:15});assert.equal(preview.status,200);
 const edited=await f.owner.call(`/documents/${f.chosen.document.id}`,{expected_revision:1,content:'Changed selected source'},{method:'PATCH'});assert.equal(edited.status,200,JSON.stringify(edited.data));
 assert.equal((await f.owner.call('/remote/results',{preview_id:preview.data.preview_id,review_hash:preview.data.preview.review_hash,confirmed:true})).status,409);assert.equal(f.relay.state.results.length,0);
 assert.equal((await f.owner.call('/remote/status')).data.permission_current,false);assert(!JSON.stringify(f.relay.state.ledger).includes('Changed selected source'));
});

test('changed accepted writing after upload withholds fresh delivery and a separate revoke erases active relay body',async t=>{
 const f=await fixture(t);await f.pair();const job=await f.enqueue(),draft=await f.draft(),approved=await f.approve(job,draft);let sent=await f.owner.call(`/remote/results/${approved.row.id}/send`,{expected_revision:approved.row.revision,review_hash:approved.row.review_hash});assert.equal(sent.status,200);
 const ticket=await f.relay.phone('begin_delivery',{result_id:sent.data.item.relay_result_id},true),note=approved.writing.data.accepted_note;
 const edited=await f.owner.call(`/documents/${note.id}`,{expected_revision:note.revision,content:'Changed accepted writing copy'},{method:'PATCH'});assert.equal(edited.status,200);
 assert.equal((await f.owner.call('/remote/delivery/poll',{})).status,409);assert.equal((await f.relay.phone('read',{delivery_id:ticket.data.id},true)).status,409);
 const revoked=await f.owner.call(`/remote/results/${approved.row.id}/revoke`,{expected_revision:sent.data.item.revision,review_hash:sent.data.item.review_hash});assert.equal(revoked.status,200);assert.equal(revoked.data.item.relay_revocation_acknowledged,true);assert.equal(f.relay.state.results[0].text,'');assert.equal(f.relay.state.results[0].state,'revoked');
});

test('dropped upload acknowledgment creates a durable uncertain receipt; retry checks metadata and uploads once; restart/backup never copies credential or automatically dispatches',async t=>{
 const f=await fixture(t);await f.pair();const job=await f.enqueue(),draft=await f.draft(),approved=await f.approve(job,draft);f.relay.state.dropUpload=true;
 assert.equal((await f.owner.call(`/remote/results/${approved.row.id}/send`,{expected_revision:approved.row.revision,review_hash:approved.row.review_hash})).status,503);
 const unknown=(await f.owner.call('/remote/results')).data.items[0];assert.equal(unknown.state,'unknown_upload');assert.equal(f.relay.state.results.length,1);
 assert.equal((await f.owner.call(`/remote/results/${unknown.id}/send`,{expected_revision:unknown.revision,review_hash:unknown.review_hash})).status,200);assert.equal(f.relay.state.ledger.filter(row=>row.operation==='upload').length,1);
 await f.runtime.close();const store=LocalStore.open({root:join(f.base,'private')});try{const rows=store.listWorkspaceRecords({kind:'artifact'}),outbox=rows.find(row=>row.data.format==='learnbridge_remote_reviewed_result.v1');assert.equal(outbox.data.state,'sent');assert.equal(outbox.data.text,approved.preview.text);
  const before=f.relay.state.ledger.length,instance=openRemoteInstance({root:join(f.base,'private-remote-device'),workspaceRoot:store.root,repositoryRoot:process.cwd()}),recovered=createRemoteResults({store,instance,enabled:true,authorize:()=>true,transportFactory:f.relay.factory});
  assert.equal(recovered.status().paired,false);await assert.rejects(recovered.sendResult(outbox.id),{code:'REMOTE_PAIRING_REQUIRED'});assert.equal(f.relay.state.ledger.length,before);assert(!JSON.stringify(rows).includes(f.relay.state.token));
  await store.backup(join(f.base,'backup'));assert(!readFileSync(join(f.base,'private-remote-device','remote-instance.json'),'utf8').includes(f.relay.state.token));assert.equal(store.integrity().integrity,'ok');
  const restoredRoot=join(f.base,'restored');await LocalStore.restore({backupRoot:join(f.base,'backup'),root:restoredRoot});const restored=LocalStore.open({root:restoredRoot});try{
   const copy=restored.getWorkspaceRecord(outbox.id),accepted=restored.getWorkspaceRecord(approved.writing.id);assert.equal(copy.data.text,approved.preview.text);assert.equal(restored.getDocument(accepted.data.accepted_note.id).text,approved.preview.text);
   const restoredInstance=openRemoteInstance({root:join(f.base,'restored-device'),workspaceRoot:restoredRoot,repositoryRoot:process.cwd()}),networkBefore=f.relay.state.ledger.length,restoredController=createRemoteResults({store:restored,instance:restoredInstance,enabled:true,authorize:()=>true,transportFactory:f.relay.factory});
   assert.notEqual(restoredInstance.installation_instance_id,instance.installation_instance_id);assert.notEqual(restoredInstance.workspace_ref,instance.workspace_ref);assert.equal(restoredController.status().paired,false);assert.equal(f.relay.state.ledger.length,networkBefore);
   await f.relay.phone('revoke_all');const pending=(await f.relay.phone('pair')).data;await restoredController.pair({...pending,confirmed:true,host_grant_id:f.grant.id,expires_in_minutes:30,max_requests:3,max_request_bytes:16384,native_execution_confirmed:false});
   await assert.rejects(restoredController.sendResult(outbox.id),{code:'REMOTE_RESULT_JOB_DENIED'});assert.equal(f.relay.state.ledger.filter(row=>row.operation==='upload').length,1);assert.equal(f.calls(),1);assert.equal(restored.integrity().integrity,'ok');
  }finally{restored.close();}
 }finally{store.close();}
});

test('phone cancellation while a durable host turn runs cancels it and never accepts or transmits its late text',async t=>{
 let release,seen;const f=await fixture(t,{execute:input=>{seen=input;return new Promise(resolve=>{release=resolve;});}});await f.pair();const job=await f.enqueue();assert.equal((await f.owner.call('/remote/poll',{})).status,200);await delay(5);
 await f.relay.phone('cancel',{job_id:job});assert.equal((await f.owner.call('/remote/poll',{})).status,403);assert.equal(seen.signal.aborted,true);release(hostResult('LATE_PRIVATE_NATIVE_CANARY'));await delay(5);
 assert.equal((await f.owner.call('/writing/items')).data.items.length,0);assert.equal(f.relay.state.results.length,0);assert(!JSON.stringify(f.relay.state.ledger).includes('LATE_PRIVATE_NATIVE_CANARY'));
});

test('explicit result consent rejects unseen source provenance outside the selected study grant',async t=>{
 const f=await fixture(t,{native:false});await f.pair();const job=await f.enqueue();await f.owner.call('/remote/poll',{});
 const docs=(await f.owner.call('/writing/documents')).data.items,excluded=docs.find(row=>row.id!==f.chosen.document.id&&!row.title.startsWith('Remote study'));
 const proposal=await f.owner.call('/writing/proposals',{title:'Wrong selected source',kind:'study_guide',draft_text:'Unrelated result',source_documents:[{id:excluded.id,revision:excluded.revision,sha256:excluded.sha256}],academic_policy:'learning_support',origin:'student'}),item=proposal.data.item;
 const accepted=await f.owner.call(`/writing/items/${item.id}/accept`,review(item));const preview=await f.owner.call('/remote/results/preview',{job_id:job,writing_record_id:item.id,...review(accepted.data.item),expires_in_minutes:15});assert.equal(preview.status,403);
});

test('result parser and browser verification reject changed bytes, identity/policy fields, getters, cycles, sparse arrays and malformed Unicode',async t=>{
 const f=await fixture(t);await f.pair();const job=await f.enqueue(),draft=await f.draft(),approved=await f.approve(job,draft);
 const input={schema_version:1,local_result_id:approved.row.id,policy:approved.preview.policy,review_hash:approved.preview.review_hash,text:approved.preview.text};assert.equal(parseRemoteResultUpload(input).text,input.text);
 let invoked=0;const bad={...input,policy:{...input.policy}};Object.defineProperty(bad.policy,'source_documents',{enumerable:true,get(){invoked++;return [];}});assert.throws(()=>parseRemoteResultUpload(bad));assert.equal(invoked,0);
 const cycle={...input};cycle.policy=cycle;assert.throws(()=>parseRemoteResultUpload(cycle));const sparse={...input,policy:{...input.policy,source_documents:new Array(1)}};assert.throws(()=>parseRemoteResultUpload(sparse));
 for(const value of [{...input,text:input.text+'changed'},{...input,text:'\ud800'},{...input,text:'bad\u0000text'},{...input,policy:{...input.policy,retention_hours:48}},{...input,policy:{...input.policy,token:'synthetic-secret'}},{...input,policy:{...input.policy,academic_policy:null}}])assert.throws(()=>parseRemoteResultUpload(value));
 const resultId=randomUUID(),deliveryId=randomUUID(),delivered={id:resultId,local_result_id:input.local_result_id,text:input.text,result_sha256:input.policy.result_sha256,review_hash:input.review_hash,policy:input.policy,delivery_id:deliveryId,fresh_local_check:true};
 assert.equal((await verifyPhoneResult(delivered,{bindingId:input.policy.binding_id,resultId,deliveryId})).text,input.text);
 for(const value of [{...delivered,text:'changed'},{...delivered,delivery_id:randomUUID()},{...delivered,fresh_local_check:false},{...delivered,policy:{...input.policy,expires_at:new Date(Date.now()-1).toISOString()}},{...delivered,policy:{...input.policy,content_status:'auto_verified'}}])await assert.rejects(verifyPhoneResult(value,{bindingId:input.policy.binding_id,resultId,deliveryId}));
});

test('bounded result transport forbids arbitrary operations and URLs, omits cookies, and rejects hanging/capped/invalid UTF-8 bodies',async()=>{
 const calls=[],transport=createRemoteResultTransport({token:'a'.repeat(43),installation_instance_id:randomUUID(),binding_id:randomUUID(),fetchImpl:async(url,options)=>{calls.push({url,options});return new Response('true',{headers:{'Content-Type':'application/json'}});}});
 assert.equal(await transport.send('preflight',{}),true);assert.equal(calls[0].url,`${REMOTE_ORIGIN}/api/remote/v1/results/device`);assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.credentials,'omit');await assert.rejects(transport.send('execute_shell',{}));assert.equal(calls.length,1);
 let cancelled=0;const hanging=new Request('https://fixture.invalid',{method:'POST',headers:{'Content-Type':'application/json'},duplex:'half',body:new ReadableStream({cancel(){cancelled++;return new Promise(()=>{});}})});
 await assert.rejects(boundedRemoteResultBody(hanging,4096,20),{code:'REMOTE_BODY_TIMEOUT'});assert.equal(cancelled,1);
 await assert.rejects(boundedRemoteResultBody(new Response('x'.repeat(4097),{headers:{'Content-Type':'application/json'}}),4096),{code:'REMOTE_TOO_LARGE'});
 await assert.rejects(boundedRemoteResultBody(new Response(new Uint8Array([0xff]),{headers:{'Content-Type':'application/json'}})),{code:'INVALID_REMOTE_INPUT'});
});

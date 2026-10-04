import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import ts from 'typescript';
import * as protocol from '../packages/core/src/remote-companion.mjs';
import * as results from '../packages/core/src/remote-results.mjs';
import {createRemoteResultTransport} from '../apps/local-runtime/src/remote-results.mjs';
const require=createRequire(import.meta.url),a=randomUUID(),b=randomUUID(),sa=randomUUID(),sb=randomUUID(),binding=randomUUID(),instance=randomUUID(),job=randomUUID(),delivery=randomUUID();
function fixture(t){
 const names=['REMOTE_COMPANION_ENABLED','REMOTE_COMPANION_RELEASE_GATE','REMOTE_COMPANION_RESULT_RELEASE_GATE','NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'],previous=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 for(const name of names)delete process.env[name];t.after(()=>{for(const name of names)if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];});
 const text='SYNTHETIC_PRIVATE_REVIEWED_RESULT 🧠\nLiteral <script> is never HTML.';
 const policy={version:results.REMOTE_RESULT_VERSION,binding_id:binding,account_id:a,installation_instance_id:instance,workspace_ref:'a'.repeat(64),phone_session_ref:sa,binding_revision:1,binding_policy_hash:'b'.repeat(64),job_id:job,input_hash:'c'.repeat(64),host_grant_id:randomUUID(),selection_hash:'d'.repeat(64),
  writing_record:{id:randomUUID(),revision:2,payload_hash:'e'.repeat(64)},document:{id:randomUUID(),revision:1,sha256:protocol.remoteHash(text)},source_documents:[],academic_policy:'learning_support',content_status:'student_reviewed_model_output_facts_unverified',result_sha256:protocol.remoteHash(text),result_bytes:Buffer.byteLength(text),expires_at:new Date(Date.now()+600000).toISOString(),relay_processing_confirmed:true,plaintext_notice_confirmed:true,retention_hours:24};
 const upload=results.parseRemoteResultUpload({schema_version:1,local_result_id:randomUUID(),policy,review_hash:protocol.remoteHash(policy),text});
 const state={owner:a,session:sa,authenticated:true,active:true,liveSession:true,authCalls:0,rpcCalls:[],uploads:[],result:null,ready:false,consumed:false,afterRpc:null,corrupt:null};
 const db={auth:{getClaims:async()=>({data:{claims:{sub:state.owner,session_id:state.session}},error:null})},rpc:async(name,args)=>{
  state.rpcCalls.push({name,args});let data,error=null;const owned=state.owner===a&&args.p_phone_session===sa&&args.p_binding===binding;
  if(name==='remote_phone_preflight')data=owned&&state.active;
  else if(name==='remote_result_device'){
   if(args.p_token!=='a'.repeat(43)||args.p_instance!==instance||args.p_binding!==binding)error={message:'REMOTE_DEVICE_DENIED'};
   else if(args.p_operation!=='revoke'&&(!state.active||!state.liveSession))error={message:!state.liveSession?'REMOTE_AUTH_REQUIRED':'REMOTE_CONSENT_REQUIRED'};
   else if(args.p_operation==='preflight')data=true;
   else if(args.p_operation==='upload'){state.uploads.push(args.p_payload);state.result={...args.p_payload,id:randomUUID(),state:'available'};data={id:state.result.id,local_result_id:upload.local_result_id,state:'available',review_hash:upload.review_hash,result_sha256:policy.result_sha256};}
   else if(args.p_operation==='revoke'){state.result=null;data={state:'revoked'};}else data=null;
  }else if(name==='remote_result_phone'){
   if(args.p_operation==='recover'){
    if(state.owner!==a||args.p_phone_session!==state.session||args.p_binding!==null||!state.liveSession)error={message:'REMOTE_AUTH_REQUIRED'};
    else{state.result=null;state.active=false;data={state:'revoked_all_own_bindings',text_erased:true};}
   }
   else if(!owned||!state.liveSession)error={message:'REMOTE_AUTH_REQUIRED'};
   else if(!state.active&&args.p_operation!=='delete')error={message:'REMOTE_CONSENT_REQUIRED'};
   else if(args.p_operation==='list')data={items:state.result?[{id:state.result.id,job_id:job,state:'available',result_sha256:policy.result_sha256,result_bytes:policy.result_bytes}]:[]};
   else if(args.p_operation==='begin_delivery')data={id:delivery,state:'waiting_local',expires_at:new Date(Date.now()+60000).toISOString()};
   else if(args.p_operation==='read'){
    if(!state.ready||state.consumed)error={message:'REMOTE_DELIVERY_WAITING'};
    else{state.consumed=true;data={id:state.result?.id||randomUUID(),local_result_id:upload.local_result_id,text,policy,review_hash:upload.review_hash,result_sha256:policy.result_sha256,delivery_id:delivery,fresh_local_check:true,...state.corrupt};}
   }else if(args.p_operation==='delete'){state.result=null;data={state:'revoked',text_erased:true};}
  }else error={message:'UNEXPECTED_RPC'};
  if(state.afterRpc)state.afterRpc(name,args);return {data,error};
 }};
 const modules=new Map();function load(file){if(modules.has(file))return modules.get(file);const source=readFileSync(new URL(`../apps/web/src/${file}`,import.meta.url),'utf8'),code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,module={exports:{}};
  new Function('require','module','exports',code)(id=>{if(id.endsWith('packages/core/src/remote-companion.mjs'))return protocol;if(id.endsWith('packages/core/src/remote-results.mjs'))return results;
   if(id==='@/lib/server/remote-companion'||id==='./remote-companion')return load('lib/server/remote-companion.ts');if(id==='@/lib/server/remote-results')return load('lib/server/remote-results.ts');
   if(id==='./auth')return {requireUser:async()=>{state.authCalls++;if(!state.authenticated)protocol.remoteFail('REMOTE_AUTH_REQUIRED',401);return {db,user:{id:state.owner}};}};
   if(id==='@supabase/supabase-js')return {createClient:()=>db};if(id==='@/lib/server/access')return {sameOrigin:request=>request.headers.get('origin')===protocol.REMOTE_ORIGIN?null:require('next/server').NextResponse.json({error:'ORIGIN_DENIED'},{status:403})};return require(id);},module,module.exports);modules.set(file,module.exports);return module.exports;
 }
 return {state,upload,phone:load('app/api/remote/v1/results/route.ts'),device:load('app/api/remote/v1/results/device/route.ts'),enable(){process.env.REMOTE_COMPANION_ENABLED='true';process.env.REMOTE_COMPANION_RELEASE_GATE='status_only_verified_policy';process.env.REMOTE_COMPANION_RESULT_RELEASE_GATE='reviewed_text_verified_policy';process.env.NEXT_PUBLIC_SUPABASE_URL='https://fixture.supabase.co';process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY='fixture-public';}};
}
function request({operation='read',body={delivery_id:delivery},method='POST',device=false,onBody,origin=protocol.REMOTE_ORIGIN,query='',token='a'.repeat(43)}={}){
 const req=new Request(`${protocol.REMOTE_ORIGIN}/api/remote/v1/results${device?'/device':''}${query}`,{method,headers:{Origin:origin,'Content-Type':'application/json','X-LearnBridge-Operation':operation,'X-LearnBridge-Binding':binding,...(device?{Authorization:`Bearer ${token}`,'X-LearnBridge-Instance':instance}:{})},...(method==='GET'?{}:{body:JSON.stringify(body)})});
 if(onBody){const original=req.body.getReader.bind(req.body);req.body.getReader=()=>{onBody();return original();};}return req;
}
test('actual reviewed-result handlers remain disabled before auth, body or RPC unless all three gates match',async t=>{
 const f=fixture(t);let bodies=0;for(const route of [f.phone,f.device]){const response=await route.POST(request({onBody:()=>bodies++}));assert.equal(response.status,503);}assert.equal(f.state.authCalls,0);assert.equal(bodies,0);assert.equal(f.state.rpcCalls.length,0);
 process.env.REMOTE_COMPANION_ENABLED='true';process.env.REMOTE_COMPANION_RELEASE_GATE='status_only_verified_policy';assert.equal((await f.phone.GET(request({method:'GET'}))).status,503);assert.equal(f.state.authCalls,0);
});
test('device verifies its actual result/session preflight before acquiring private result text and SQL checks permission again after body',async t=>{
 const f=fixture(t);f.enable();let bodies=0,preflight=false;f.state.liveSession=false;assert.equal((await f.device.POST(request({device:true,operation:'upload',body:f.upload,onBody:()=>bodies++}))).status,403);assert.equal(bodies,0);
 f.state.liveSession=true;const reply=await f.device.POST(request({device:true,operation:'upload',body:f.upload,onBody:()=>{bodies++;preflight=f.state.rpcCalls.at(-1)?.args.p_operation==='preflight';}}));assert.equal(reply.status,201);assert.equal(preflight,true);assert.equal(f.state.uploads.length,1);assert.equal(f.state.uploads[0].text,f.upload.text);
 f.state.uploads=[];assert.equal((await f.device.POST(request({device:true,operation:'upload',body:f.upload,onBody:()=>{f.state.active=false;}}))).status,403);assert.equal(f.state.uploads.length,0);
});
test('phone requires current ownership, origin/session before body; a changed owner during body cannot invoke result RPC',async t=>{
 const f=fixture(t);f.enable();let bodies=0;f.state.owner=b;f.state.session=sb;assert.equal((await f.phone.POST(request({onBody:()=>bodies++}))).status,403);assert.equal(bodies,0);
 f.state.owner=a;f.state.session=sa;assert.equal((await f.phone.POST(request({origin:'https://hostile.invalid'}))).status,403);assert.equal((await f.phone.POST(request({query:'?token=synthetic'}))).status,400);
 assert.equal((await f.phone.POST(request({onBody:()=>{f.state.owner=b;f.state.session=sb;}}))).status,401);assert.equal(f.state.rpcCalls.filter(call=>call.name==='remote_result_phone').length,0);
});
test('verified one-use result body has exact account/session/binding and original text/review hashes; forged or cached text fails',async t=>{
 const f=fixture(t);f.enable();f.state.result={id:randomUUID()};f.state.ready=true;const response=await f.phone.POST(request());assert.equal(response.status,200);assert.equal((await response.json()).text,f.upload.text);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal((await f.phone.POST(request())).status,409);
 for(const corrupt of [{text:'Changed private bytes'},{result_sha256:'f'.repeat(64)},{fresh_local_check:false},{delivery_id:randomUUID()},{policy:{...f.upload.policy,account_id:b}},{policy:{...f.upload.policy,binding_id:randomUUID()}}]){
  f.state.consumed=false;f.state.corrupt=corrupt;const denied=await f.phone.POST(request());assert.equal(denied.status,409);assert(!JSON.stringify(await denied.json()).includes('SYNTHETIC_PRIVATE_REVIEWED_RESULT'));}
});
test('late sign-out after SQL consumption withholds the HTTP body and owner metadata never includes private text',async t=>{
 const f=fixture(t);f.enable();f.state.result={id:randomUUID()};let listed=await f.phone.GET(request({method:'GET'}));assert.equal(listed.status,200);assert(!JSON.stringify(await listed.json()).includes(f.upload.text));
 f.state.ready=true;f.state.afterRpc=(name,args)=>{if(name==='remote_result_phone'&&args.p_operation==='read')f.state.authenticated=false;};const response=await f.phone.POST(request());assert.equal(response.status,401);assert(!JSON.stringify(await response.json()).includes(f.upload.text));
});
test('strict upload schema and bodies reject scope expansion, hidden identity, commands, changed bytes or oversized data',async t=>{
 const f=fixture(t);f.enable();for(const body of [{...f.upload,command:'arbitrary'},{...f.upload,text:f.upload.text+'changed'},{...f.upload,account_id:b},{...f.upload,text:'x'.repeat(128001)}]){const response=await f.device.POST(request({device:true,operation:'upload',body}));assert([400,409,413].includes(response.status));}assert.equal(f.state.uploads.length,0);
 for(const operation of ['execute_shell','native_turn','complete','human_review'])assert.equal((await f.device.POST(request({device:true,operation,body:{}}))).status,400);
});
test('content-free device erasure remains allowed after study grant expiry, verified only by the SQL device credential',async t=>{
 const f=fixture(t);f.enable();f.state.active=false;const response=await f.device.POST(request({device:true,operation:'revoke',body:{local_result_id:f.upload.local_result_id}}));assert.equal(response.status,200);assert.equal(f.state.rpcCalls.filter(row=>row.args.p_operation==='preflight').length,0);
 assert.equal((await f.device.POST(request({device:true,operation:'revoke',body:{local_result_id:f.upload.local_result_id},token:'z'.repeat(43)}))).status,403);
});
test('actual fixed transport preflight is accepted by the shipped result-device handler and requires an exact empty body',async t=>{
 const f=fixture(t);f.enable();const transport=createRemoteResultTransport({token:'a'.repeat(43),installation_instance_id:instance,binding_id:binding,fetchImpl:(url,options)=>f.device.POST(new Request(url,options))});
 assert.equal(await transport.send('preflight',{}),true);assert.equal(f.state.rpcCalls.filter(row=>row.name==='remote_result_device'&&row.args.p_operation==='preflight').length,2);
 await assert.rejects(transport.send('preflight',{command:'arbitrary'}),{code:'REMOTE_RESULT_RELAY_DENIED'});f.state.liveSession=false;
 await assert.rejects(transport.send('preflight',{}),{code:'REMOTE_RESULT_RELAY_DENIED'});assert.equal(f.state.uploads.length,0);
});
test('fresh verified owner recovery needs no old phone binding, acquires no result body, and forwards only exact empty consent data',async t=>{
 const f=fixture(t);f.enable();f.state.session=sb;f.state.active=false;f.state.result={id:randomUUID(),text:f.upload.text};
 const response=await f.phone.POST(request({operation:'recover',body:{}}));assert.equal(response.status,200);assert.deepEqual(await response.json(),{state:'revoked_all_own_bindings',text_erased:true});assert.equal(f.state.result,null);
 assert.equal(f.state.rpcCalls.some(row=>row.name==='remote_phone_preflight'),false);assert.deepEqual(f.state.rpcCalls.at(-1).args,{p_phone_session:sb,p_binding:null,p_operation:'recover',p_payload:{}});
 const calls=f.state.rpcCalls.length;assert.equal((await f.phone.POST(request({operation:'recover',body:{account_id:a}}))).status,400);assert.equal(f.state.rpcCalls.length,calls);
 f.state.liveSession=false;assert.equal((await f.phone.POST(request({operation:'recover',body:{}}))).status,403);
});

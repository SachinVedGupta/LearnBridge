import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createCodexAdapter, CODEX_DIRECT_FUNCTION_MODELS, CODEX_PROTOCOL_PIN } from '../apps/local-runtime/src/codex-adapter.mjs';

// Real bounded stdio subprocess, synthetic account/catalog only. No credentials,
// model network call, native model configuration or remote writes are involved.
const source = String.raw`
import readline from 'node:readline';
const [mode,raw]=process.argv.slice(2),config=JSON.parse(raw);let accounts=0;
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
const model=slug=>({id:slug,model:slug,hidden:false,isDefault:slug==='gpt-6-astra',description:'Synthetic catalog',displayName:slug,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'Synthetic'}]});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize'){send({id:m.id,result:{userAgent:'codex/0.154.0',platformFamily:'unix'}});return}
 if(m.method==='config/read'){send({id:m.id,result:{config,layers:null}});return}
 if(m.method==='account/read'){accounts++;send({id:m.id,result:{account:accounts>1&&mode==='accountMissing'?null:accounts>1&&mode==='accountApiKey'?{type:'apiKey'}:{type:'chatgpt',email:'PRIVATE_ACCOUNT_CANARY'}}});return}
 if(m.method==='model/list'){
  if(mode==='authError'){send({id:m.id,error:{code:-32000,message:'PRIVATE_AUTH_CANARY',data:{codexErrorInfo:'Unauthorized'}}});return}
  if(mode==='unsupportedRpc'){send({id:m.id,error:{code:-32601,message:'PRIVATE_VERSION_CANARY'}});return}
  if(mode==='tokenRefresh'){send({id:'token-request',method:'account/chatgptAuthTokens/refresh',params:{reason:'unauthorized'}});setTimeout(()=>send({id:m.id,result:{data:[model('gpt-5.5')],nextCursor:null}}),100);return}
  let data=['gpt-6-astra','gpt-5.2','gpt-5.5'].map(model),nextCursor=null;
  if(mode==='fallback')data=data.filter(m=>m.model!=='gpt-5.5');
  if(mode==='noDirect')data=[model('gpt-6-astra')];
  if(mode==='hidden')data=data.map(m=>({...m,hidden:m.model!=='gpt-6-astra'}));
  if(mode==='malformed')delete data[2].hidden;
  if(mode==='alias')data[2].id='unsafe-alias';
  if(mode==='duplicate')data.push(model('gpt-5.5'));
  if(mode==='paginated')nextCursor='PRIVATE_OPAQUE_CURSOR_CANARY';
  if(mode==='badCursor')nextCursor=123;
  if(mode==='oversized')data=Array.from({length:101},(_,i)=>model('synthetic-'+i));
  const respond=()=>send({id:m.id,result:{data,nextCursor}});
  if(mode==='delayed')setTimeout(respond,150);else respond();return;
 }
 if(m.method==='thread/start'){send({id:m.id,result:{thread:{id:'catalog-thread'},model:mode==='wrongSelected'?'gpt-6-astra':m.params.model,modelProvider:'openai',approvalPolicy:'on-request',approvalsReviewer:'user',cwd:process.cwd(),sandbox:{type:'readOnly',networkAccess:false}}});return}
 if(m.method==='mcpServerStatus/list'){send({id:m.id,result:{data:[{name:'learnbridge',tools:Object.fromEntries(['learnbridge_status','learnbridge_context','learnbridge_propose_task','learnbridge_propose_document'].map(name=>[name,{name}])),resources:[],resourceTemplates:[],runtimeStatus:'connected'}],nextCursor:null}});return}
});
`;
function fixture(t, mode='normal', extra={}) {
 const base=mkdtempSync(join(tmpdir(),'learnbridge-model-catalog-')),project=join(base,'project'),data=join(base,'data'),script=join(base,'host.mjs');mkdirSync(project);mkdirSync(data);writeFileSync(script,source);
 const traffic=[],launched=[];let allowed=true,adapter;
 t.after(async()=>{await adapter?.close();rmSync(base,{recursive:true,force:true})});
 const factory=(binary,args,options)=>{
  const inline=args.at(-1),mcp={command:'/usr/bin/env',args:JSON.parse(inline.match(/args = (\[.*?\])/)[1]),enabled_tools:['learnbridge_context','learnbridge_propose_document','learnbridge_propose_task','learnbridge_status'],startup_timeout_sec:15,tool_timeout_sec:20,required:true};
  const config={forced_login_method:'chatgpt',model_provider:'openai',sandbox_mode:'read-only',approval_policy:'on-request',approvals_reviewer:'user',project_doc_max_bytes:0,web_search:'disabled',analytics:{enabled:false},features:Object.fromEntries(['shell_tool','shell_snapshot','memories','plugins','hooks','multi_agent','apps','browser_use','computer_use','js_repl'].map(k=>[k,false])),agents:{enabled:false},apps:{_default:{enabled:false}},mcp_servers:{learnbridge:mcp}};
  const child=spawn(process.execPath,[script,mode,JSON.stringify(config)],options);launched.push(child);const write=child.stdin.write.bind(child.stdin);child.stdin.write=(line,...rest)=>{traffic.push(JSON.parse(line));return write(line,...rest)};return child;
 };
 adapter=createCodexAdapter({projectRoot:project,dataRoot:data,grantId:randomUUID(),authorize:()=>allowed,modelTools:true,...extra.input},{factory,protocolProbe:async()=>({version:'0.154.0',protocol_verified:true,experimental_protocol_verified:true}),requestTimeoutMs:1000,...extra.options});
 return {adapter,traffic,launched,revoke:()=>{allowed=false}};
}
async function begin(f) {await f.adapter.initialize();return f.adapter.startThread()}
async function pendingCatalog(f) {for(let i=0;i<100&&!f.traffic.some(m=>m.method==='model/list');i++)await new Promise(r=>setTimeout(r,5));assert(f.traffic.some(m=>m.method==='model/list'))}

test('CMC01 current visible catalog selects direct functions in audited preference order, never its code-mode default',async t=>{
 for(const [mode,selected]of [['normal','gpt-5.5'],['fallback','gpt-5.2']]){
  const f=fixture(t,mode),thread=await begin(f);assert.equal(thread.model,selected);assert.deepEqual(f.traffic.find(m=>m.method==='model/list').params,{includeHidden:false,limit:100});
  assert.equal(f.traffic.filter(m=>m.method==='account/read').length,2);assert.equal(f.traffic.find(m=>m.method==='thread/start').params.model,selected);assert.equal(f.adapter.capabilities().model_entitlement_verified,false);
  assert.equal(JSON.stringify(f.adapter.events()).includes('PRIVATE_'),false);
 }
 assert.deepEqual(CODEX_DIRECT_FUNCTION_MODELS,['gpt-5.5','gpt-5.2']);
});
test('CMC02 trusted overrides require the same direct allowlist and current visible catalog',async t=>{
 const selected=fixture(t,'normal',{input:{model:'gpt-5.2'}});assert.equal((await begin(selected)).model,'gpt-5.2');
 for(const mode of ['hidden','noDirect','fallback']){const f=fixture(t,mode,{input:{model:'gpt-5.5'}});await assert.rejects(begin(f),{code:'UNSUPPORTED'});assert.equal(f.traffic.some(m=>m.method==='thread/start'),false)}
 assert.throws(()=>fixture(t,'normal',{input:{model:'gpt-6-astra'}}),{code:'UNSUPPORTED'});
});
test('CMC03 malformed, duplicate, aliased and oversized catalogs reject before thread creation',async t=>{
 for(const mode of ['malformed','duplicate','alias','oversized','badCursor']){const f=fixture(t,mode);await assert.rejects(begin(f),{code:'VERSION_MISMATCH'});assert.equal(f.traffic.some(m=>m.method==='thread/start'),false)}
 const f=fixture(t,'paginated');await assert.rejects(begin(f),{code:'BUDGET_EXCEEDED'});assert.equal(f.traffic.filter(m=>m.method==='model/list').length,1);assert.equal(f.traffic.some(m=>m.method==='thread/start'),false);
});
test('CMC04 current account loss, unsupported auth refresh and catalog RPC errors cannot fall back to another provider',async t=>{
 for(const [mode,code]of [['accountMissing','AUTH_REQUIRED'],['accountApiKey','UNSUPPORTED'],['authError','AUTH_REQUIRED'],['unsupportedRpc','UNSUPPORTED'],['tokenRefresh','UNSUPPORTED']]){
  const f=fixture(t,mode);await assert.rejects(begin(f),{code});assert.equal(f.launched.length,1);assert.equal(f.traffic.some(m=>m.method==='thread/start'),false);assert.equal(f.traffic.some(m=>m.method==='account/login/start'),false);
  assert.equal(f.traffic.some(m=>m.method==='account/chatgptAuthTokens/refresh'),false);
 }
});
test('CMC05 cancellation or consent revocation during catalog await prevents later thread creation',async t=>{
 const cancelled=fixture(t,'delayed');await cancelled.adapter.initialize();const pending=cancelled.adapter.startThread(),rejected=assert.rejects(pending,{code:'OFFLINE'});await pendingCatalog(cancelled);await cancelled.adapter.close();await rejected;assert.equal(cancelled.traffic.some(m=>m.method==='thread/start'),false);
 const revoked=fixture(t,'delayed');await revoked.adapter.initialize();const next=revoked.adapter.startThread(),denied=assert.rejects(next,{code:'CONSENT_REQUIRED'});await pendingCatalog(revoked);revoked.revoke();await denied;assert.equal(revoked.traffic.some(m=>m.method==='thread/start'),false);
});
test('CMC06 experimental thread schema must be verified independently before model-mode launch',async t=>{
 const f=fixture(t,'normal',{options:{protocolProbe:async()=>({version:'0.154.0',protocol_verified:true})}});await assert.rejects(f.adapter.initialize(),{code:'VERSION_MISMATCH'});assert.equal(f.launched.length,0);
 assert.equal(CODEX_PROTOCOL_PIN.schemas['v2/ThreadStartParams.json'],'792e2f32e37cece971bd616664ea2053741acbed4e9c92e9d1766427718f2ecd');
 assert.equal(CODEX_PROTOCOL_PIN.experimentalSchemas['v2/ThreadStartParams.json'],'25f490368ec6df52a2a3b82a5469d2413307eb93439121b309f415b5648eee7a');
});
test('CMC07 native thread substitution is rejected before MCP catalog or any model turn',async t=>{
 const f=fixture(t,'wrongSelected');await assert.rejects(begin(f),{code:'VERSION_MISMATCH'});assert.equal(f.traffic.filter(m=>m.method==='thread/start').length,1);assert.equal(f.traffic.some(m=>m.method==='mcpServerStatus/list'||m.method==='turn/start'),false);
});

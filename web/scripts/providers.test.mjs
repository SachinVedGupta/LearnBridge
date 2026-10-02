import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
function load(name,overrides={}){const source=readFileSync(new URL(`../apps/web/src/lib/server/${name}.ts`,import.meta.url),'utf8');const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;const module={exports:{}};new Function('require','module','exports',code)((id)=>overrides[id]??require(id),module,module.exports);return module.exports;}
const {generate}=load('openai');const {courses}=load('brightspace');
test('disabled AI never calls the provider',async()=>{const original=global.fetch;global.fetch=()=>{throw Error('Network should not be called');};delete process.env.OPENAI_REQUESTS_ENABLED;try{await assert.rejects(generate('test'),/disabled/);}finally{global.fetch=original;}});
test('OpenAI sends bounded requests without response storage and parses output',async()=>{process.env.OPENAI_REQUESTS_ENABLED='true';process.env.OPENAI_API_KEY='synthetic-test-value';const original=global.fetch;global.fetch=async(url,options)=>{assert.equal(url,'https://api.openai.com/v1/responses');const body=JSON.parse(options.body);assert.equal(body.store,false);assert.equal(body.max_output_tokens,1600);return {ok:true,json:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'A useful hint'}]}]})};};try{assert.equal(await generate('synthetic'), 'A useful hint');}finally{global.fetch=original;delete process.env.OPENAI_API_KEY;delete process.env.OPENAI_REQUESTS_ENABLED;}});
test('OpenAI tool loop replays stateless response and only executes scoped read tools',async()=>{process.env.OPENAI_REQUESTS_ENABLED='true';process.env.OPENAI_API_KEY='synthetic';const original=global.fetch;const requestBodies=[];let handled=0;global.fetch=async(_url,options)=>{const body=JSON.parse(options.body);requestBodies.push(body);assert.equal(body.store,false);if(requestBodies.length===1)return {ok:true,json:async()=>({status:'completed',output:[{type:'reasoning',id:'r1',summary:[]},{type:'function_call',name:'GMAIL_FETCH_EMAILS',call_id:'call1',arguments:'{}'}]})};return {ok:true,json:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'I found a message in Gmail.'}]}]})};};const provider={handleToolCalls:async(_session,output)=>{handled++;assert.equal(output.some(x=>x.type==='function_call'),true);return [{type:'function_call_output',call_id:'call1',output:'synthetic mail result'}];}};try{const answer=await generate('Use selected Gmail',undefined,{provider,session:{},tools:[{type:'function',name:'GMAIL_FETCH_EMAILS',parameters:{type:'object',properties:{}}}]});assert.match(answer,/Gmail/);assert.equal(handled,1);assert.equal(requestBodies[1].input.length,4);assert.equal(requestBodies[1].input[0].role,'user');assert.equal(requestBodies[1].input[1].type,'reasoning');assert.equal(requestBodies[1].input[3].type,'function_call_output');}finally{global.fetch=original;delete process.env.OPENAI_API_KEY;delete process.env.OPENAI_REQUESTS_ENABLED;}});
test('provider errors do not echo upstream secrets or request content',async()=>{process.env.OPENAI_REQUESTS_ENABLED='true';process.env.OPENAI_API_KEY='synthetic';const original=global.fetch;global.fetch=async()=>({ok:false,status:401,text:async()=> 'private provider error'});try{await assert.rejects(generate('private input'),e=>e.message.includes('(401)')&&!e.message.includes('private'));}finally{global.fetch=original;delete process.env.OPENAI_API_KEY;delete process.env.OPENAI_REQUESTS_ENABLED;}});
test('tutor response carries reviewed task proposals and only a minimal student name',async()=>{
 let captured;
 const {handleAI}=load('ai-handler',{'./auth':{requireUser:async()=>({db:{},user:{id:'student-1',user_metadata:{full_name:'A Student'},email:'private@example.test'}}),useQuota:async()=>{}},'./openai':{generate:async(input,schema,agent,name)=>{captured={input,schema,agent,name};return JSON.stringify({answer:'Review normalization, then test yourself.',suggested_tasks:[{title:'Review normalization rules',course:'Databases',due:''}]});}},'./connectors':{createTutorTools:async()=>{throw Error('No accounts were selected');}},'./access':{sameOrigin:()=>null,failure:e=>({body:{error:e.message},status:e.status||500})},'next/server':{NextResponse:{json:(body,options)=>({body,...options})}}});
 const result=await handleAI({json:async()=>({docSlice:'',instructions:'Help me plan',courseCtx:'Database normalization'})},'ask');
 assert.equal(result.body.assistant_text,'Review normalization, then test yourself.');assert.equal(result.body.suggested_tasks.length,1);assert.equal(captured.name,'tutor_response');assert.equal(captured.agent,undefined);assert.equal(captured.schema.properties.suggested_tasks.maxItems,3);const prompt=JSON.parse(captured.input.at(-1).content);assert.deepEqual(prompt.student,{displayName:'A Student'});assert.equal(JSON.stringify(prompt).includes('private@example.test'),false);
});
test('Brightspace refuses missing configuration',()=>{delete process.env.BRIGHTSPACE_MCP_ENTRY;assert.throws(()=>courses(),/not configured/);});
test('MCP bridge initializes and only requests read-only active courses',async()=>{const dir=mkdtempSync(join(tmpdir(),'learnbridge-mcp-'));const entry=join(dir,'mock.cjs');writeFileSync(entry,`const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{}}));if(m.method==='tools/call'){if(m.params.name!=='get_my_courses'||m.params.arguments.activeOnly!==true)process.exit(2);console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'synthetic course'}]}}));}});`);process.env.BRIGHTSPACE_MCP_ENTRY=entry;try{const result=await courses();assert.equal(result.content[0].text,'synthetic course');}finally{delete process.env.BRIGHTSPACE_MCP_ENTRY;rmSync(dir,{recursive:true});}});

class AppError extends Error {constructor(message,status=400){super(message);this.status=status;}}
const authStub={AppError,appOrigin:()=> 'https://learnbridge.example'};
test('connector session binds verified user and selected account, with only allowlisted read tools',async()=>{
 const calls=[];
 class Composio {
  connectedAccounts={list:async q=>{calls.push(q);return {items:[{id:'alice-notion',toolkit:{slug:'notion'},status:'ACTIVE',wordId:'alice',experimental:{accountType:'PRIVATE'}},{id:'shared',toolkit:{slug:'notion'},status:'ACTIVE',experimental:{accountType:'SHARED'}}]};}};
  async create(user,options){calls.push({user,options});return {execute:async (tool,args,opts)=>{calls.push({tool,args,opts});return {data:{results:[]},error:null};},delete:async()=>calls.push('deleted')};}
 }
  const {readConnection,connections}=load('connectors',{'@composio/core':{Composio},'@composio/openai':{OpenAIResponsesProvider:class{}},'./auth':authStub});
 process.env.COMPOSIO_API_KEY='synthetic';process.env.COMPOSIO_AUTH_NOTION='ac_synthetic';
 try{
  await assert.rejects(readConnection('alice','notion','bob-notion'),e=>e.status===403);
  assert.equal(calls.some(c=>c.user),false);
  const status=await connections('alice');assert.equal(status.find(c=>c.id==='notion').accounts.length,1);
  const result=await readConnection('alice','notion','alice-notion');assert.deepEqual(result.data,{results:[]});
  const created=calls.find(c=>c.user);assert.equal(created.user,'alice');assert.deepEqual(created.options.connectedAccounts,{notion:['alice-notion']});assert.deepEqual(created.options.tools,{notion:{enable:['NOTION_SEARCH_NOTION_PAGE','NOTION_GET_PAGE_MARKDOWN']}});assert.equal(created.options.sessionPreset,'direct_tools');assert.equal(created.options.sandbox.enable,false);assert.equal(created.options.instant,false);assert.equal(calls.at(-1),'deleted');assert.equal(calls.find(c=>c.tool)?.opts,undefined);
  assert(calls.filter(c=>c.userIds).every(c=>c.userIds[0]==='alice'));
 }finally{delete process.env.COMPOSIO_API_KEY;delete process.env.COMPOSIO_AUTH_NOTION;}
});
test('tutor tools are scoped to selected active accounts and fixed read-only allowlists',async()=>{
 const calls=[];const provider={handleToolCalls:async()=>[]};
 class Composio {
  constructor(options){this.provider=options?.provider||null;}
  connectedAccounts={list:async q=>{calls.push(q);assert.deepEqual(q.userIds,['alice']);return {items:[{id:'alice-gmail',toolkit:{slug:'gmail'},status:'ACTIVE',alias:'School mail',experimental:{accountType:'PRIVATE'}}]};}};
  async create(user,options){calls.push({user,options});return {tools:async()=>[{type:'function',name:'GMAIL_FETCH_EMAILS'}],delete:async()=>calls.push('deleted')};}
 }
 const {createTutorTools}=load('connectors',{'@composio/core':{Composio},'@composio/openai':{OpenAIResponsesProvider:class{}},'./auth':authStub});
 process.env.COMPOSIO_API_KEY='synthetic';process.env.COMPOSIO_AUTH_GMAIL='ac_synthetic';
 try{
  await assert.rejects(createTutorTools('alice',[{provider:'gmail',accountId:'bob-gmail'}]),e=>e.status===403);
  assert.equal(calls.some(c=>c.user),false);
  const agent=await createTutorTools('alice',[{provider:'gmail',accountId:'alice-gmail'}]);
  const created=calls.find(c=>c.user);assert.equal(created.user,'alice');assert.deepEqual(created.options.connectedAccounts,{gmail:['alice-gmail']});assert.deepEqual(created.options.tools,{gmail:{enable:['GMAIL_FETCH_EMAILS']}});assert.deepEqual(created.options.toolkits,['gmail']);assert.equal(created.options.sessionPreset,'direct_tools');assert.deepEqual(agent.tools,[{type:'function',name:'GMAIL_FETCH_EMAILS'}]);
 }finally{delete process.env.COMPOSIO_API_KEY;delete process.env.COMPOSIO_AUTH_GMAIL;}
});
test('linking cannot start without callback identity verification',async()=>{
 const {linkConnection}=load('connectors',{'@composio/core':{Composio:class{}},'./auth':authStub});
 process.env.COMPOSIO_AUTH_NOTION='ac_synthetic';delete process.env.COMPOSIO_CALLBACK_VERIFIER_ENABLED;
 try{await assert.rejects(linkConnection('alice','notion'),/identity verification/);}finally{delete process.env.COMPOSIO_AUTH_NOTION;}
});
test('authentication verifies the user remotely rather than trusting a cookie user id',async()=>{
 let calls=0;process.env.APP_URL='https://learnbridge.example';process.env.NEXT_PUBLIC_SUPABASE_URL='https://synthetic.supabase.co';process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY='synthetic';
 const {requireUser}=load('auth',{'@supabase/ssr':{createServerClient:()=>({auth:{getUser:async()=>{calls++;return {data:{user:null},error:Error('invalid')};}}})},'next/headers':{cookies:async()=>({getAll:()=>[],set:()=>{}})}});
 try{await assert.rejects(requireUser(),e=>e.status===401);assert.equal(calls,1);}finally{delete process.env.APP_URL;delete process.env.NEXT_PUBLIC_SUPABASE_URL;delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;}
});

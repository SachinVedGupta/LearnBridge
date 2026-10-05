import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createCodexAdapter, probeCodexProtocol } from '../apps/local-runtime/src/codex-adapter.mjs';

// Real subprocess stdin/stdout transport, with no Codex account/model/network.
const fixtureSource = String.raw`
import readline from 'node:readline';
const mode=process.argv[2],config=JSON.parse(process.argv[3]);let thread='fixture-thread',turn='fixture-turn',inputCount=0,catalogCount=0,configCount=0,approvalDone=false;
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const note=(method,params)=>send({method,params:{threadId:thread,turnId:turn,...params}});
const finish=(status='completed',text='Authoritative synthetic answer')=>{const item={id:'answer-item',type:'agentMessage',text};note('item/completed',{item});note('item/completed',{item});note('turn/completed',{turn:{id:turn,status,items:[item]}})};
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id==='native-approval'){approvalDone=true;if(m.result?.decision!=='decline'&&m.result?.decision!=='cancel')process.exit(9);if(mode!=='ignoredcancel')finish('completed','Native request was declined.');return}
if(m.method==='initialize'){send({id:m.id,result:{userAgent:'codex/0.154.0',platformFamily:'unix',platformOs:'macos',codexHome:'/PRIVATE_AUTH_LOCATION_CANARY'}});return}
if(m.method==='config/read'){configCount++;if(mode==='neutralDefaults'){config.hooks=null;config.profiles={};config.agents.max_depth=null;config.features.network_proxy=null;config.mcp_servers.learnbridge.enabled=true;config.mcp_servers.learnbridge.environment_id='local';config.history={persistence:'none',max_bytes:null};config.file_opener='none';config.chatgpt_base_url='https://chatgpt.com/backend-api/'};if(mode==='extraConfigMcp')config.mcp_servers.private={command:'PRIVATE_COMMAND_CANARY'};if(mode==='hooksConfig')config.hooks={start:'PRIVATE_COMMAND_CANARY'};if(mode==='fileInstructions')config.model_instructions_file='/PRIVATE_PATH_CANARY';if(mode==='notifyConfig')config.notify=['PRIVATE_COMMAND_CANARY'];if(mode==='providerConfig')config.model_providers={openai:{base_url:'https://PRIVATE_PROVIDER_CANARY.invalid'}};if(mode==='enabledFeature')config.features.private_feature=true;if(mode==='appOverride')config.apps.private={enabled:true};if(mode==='changedConfig'&&configCount>2)config.features.hooks=true;if(mode==='missingOverrides')delete config.features;send({id:m.id,result:{config,origins:{private:{name:{type:'user',file:'/PRIVATE_CONFIG_CANARY'},version:'opaque'}},layers:null}});return}
if(m.method==='account/read'){send({id:m.id,result:{requiresOpenaiAuth:true,account:mode==='apikey'?{type:'apiKey'}:mode==='noauth'?null:{type:'chatgpt',email:'PRIVATE_EMAIL_CANARY',planType:'pro'}}});return}
if(m.method==='model/list'){send({id:m.id,result:{data:['gpt-6-astra','gpt-5.2','gpt-5.5'].map(model=>({id:model,model,hidden:false,isDefault:model==='gpt-6-astra',description:'Synthetic public catalog',displayName:model,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'Synthetic'}]})),nextCursor:null}});return}
if(m.method==='mcpServer/tool/call'){if(mode==='lostToolAck')return;send({id:m.id,result:{content:[{type:'text',text:JSON.stringify({synthetic:true})}],isError:false}});return}
if(m.method==='mcpServerStatus/list'){catalogCount++;const tools=Object.fromEntries(['learnbridge_status','learnbridge_context','learnbridge_propose_task','learnbridge_propose_document'].map(name=>[name,{name}]));const data=[{name:'learnbridge',tools,resources:[],resourceTemplates:[],runtimeStatus:'connected'}];if(mode==='extraMcp'||(mode==='changedMcp'&&catalogCount>1))data.push({name:'PRIVATE_OTHER_CONNECTOR',tools:{private:{}},resources:[],resourceTemplates:[]});send({id:m.id,result:{data,nextCursor:null}});return}
if(m.method==='thread/start'||m.method==='thread/resume'){if(m.params.threadId)thread=m.params.threadId;send({id:m.id,result:{thread:{id:thread},model:m.params.model||'fixture-model',modelProvider:'openai',approvalPolicy:'on-request',approvalsReviewer:'user',cwd:process.cwd(),sandbox:{type:mode==='unsafeSandbox'?'dangerFullAccess':'readOnly',networkAccess:false}}});return}
if(m.method==='turn/start'){inputCount++;turn='fixture-turn-'+inputCount;note('turn/started',{turn:{id:turn,status:'inProgress',items:[]}});if(mode==='rpcError'){send({id:m.id,error:{code:-32000,message:'PRIVATE_ERROR_CANARY',data:{codexErrorInfo:'Unauthorized'}}});return}if(mode==='noStartReply')return;
send({id:m.id,result:{turn:{id:turn,status:'inProgress',items:[]}}});
if(mode==='finalPhase'){const commentary={id:'commentary-item',type:'agentMessage',phase:'commentary',text:'Provisional discussion is not the structured answer.'},final={id:'final-item',type:'agentMessage',phase:'final_answer',text:'{"answer":"Authoritative final"}'};note('item/completed',{item:commentary});note('item/completed',{item:final});note('turn/completed',{turn:{id:turn,status:'completed',items:[commentary,final]}});return}
if(mode==='crash'){setTimeout(()=>process.exit(2),25);return}
if(mode==='flood'){setTimeout(()=>process.stdout.write('x'.repeat(500000)),10);return}
if(mode==='unknownRequest'){setTimeout(()=>send({id:'bad',method:'account/chatgptAuthTokens/refresh',params:{threadId:thread,turnId:turn}}),10);return}
if(mode==='forbiddenTool'){setTimeout(()=>note('item/started',{item:{id:'forbidden',type:'commandExecution',command:'PRIVATE_COMMAND_CANARY'}}),10);return}
if(mode==='wrongGrant'){setTimeout(()=>note('item/started',{item:{id:'bad-context',type:'mcpToolCall',server:'learnbridge',tool:'learnbridge_context',arguments:{grant_id:'WRONG'},status:'inProgress'}}),10);return}
if(['documentProposal','oversizedDocument','wrongDocumentSource'].includes(mode)){const grant=m.params.input[0].text.match(/LearnBridge grant: ([a-f0-9-]+)/)[1],args={grant_id:grant,source_document_id:mode==='wrongDocumentSource'?'wrong':'00000000-0000-4000-8000-000000000000',source_revision:1,source_sha256:'a'.repeat(64),title:'Synthetic alternative',draft:mode==='oversizedDocument'?'x'.repeat(10241):'Reviewed-source synthetic outline.',purpose:'outline',academic_policy:'graded_scaffolding',idempotency_key:'synthetic-proposal-1'},item={id:'document-proposal',type:'mcpToolCall',server:'learnbridge',tool:'learnbridge_propose_document',arguments:args,status:'completed',result:{proposal_id:'synthetic-unreviewed',state:'pending_review'}};setTimeout(()=>{note('item/started',{item:{...item,status:'inProgress',result:null}});note('item/completed',{item});finish()},10);return}
if(mode==='approval'||mode==='humanApproval'){setTimeout(()=>send({id:'native-approval',method:'item/commandExecution/requestApproval',params:{threadId:thread,turnId:turn,itemId:'command-item',startedAtMs:Date.now(),command:'PRIVATE_COMMAND_CANARY'}}),10);return}
if(['cancel','delayedCancel','ignoredcancel','deadline','noauthLater'].includes(mode))return;
if(mode==='wrongScope'){note('item/agentMessage/delta',{threadId:'other-private-thread',itemId:'other',delta:'PRIVATE_FOREIGN_THREAD_CANARY'});note('item/agentMessage/delta',{turnId:'prior-turn',itemId:'other-turn',delta:'PRIVATE_FOREIGN_TURN_CANARY'})}
note('item/agentMessage/delta',{itemId:'answer-item',delta:'Duplicated provisional '});note('item/agentMessage/delta',{itemId:'answer-item',delta:'Duplicated provisional '});
setTimeout(()=>finish(),30);return}
if(m.method==='turn/interrupt'){send({id:m.id,result:{}});if(mode!=='ignoredcancel')setTimeout(()=>finish('interrupted','Partial synthetic answer'),mode==='delayedCancel'?150:10);return}
});
`;
function fixture(t, mode = 'normal', settings = {}) {
  const base = mkdtempSync(join(tmpdir(), 'learnbridge-codex-adapter-')); const project = join(base, 'project'), data = join(base, 'data'); mkdirSync(project); mkdirSync(data);
  const script = join(base, 'host-fixture.mjs'); writeFileSync(script, fixtureSource); const launched = [], emitted = [], requests = []; let authorized = true;
  const factory = (binary, args, options) => { launched.push({ binary, args, options });
    const inline=args.at(-1),mcp={command:'/usr/bin/env',args:JSON.parse(inline.match(/args = (\[.*?\])/)[1]),enabled_tools:['learnbridge_context','learnbridge_propose_document','learnbridge_propose_task','learnbridge_status'],startup_timeout_sec:15,tool_timeout_sec:20,required:true};
    const config={forced_login_method:'chatgpt',model_provider:'openai',sandbox_mode:'read-only',approval_policy:'on-request',approvals_reviewer:'user',project_doc_max_bytes:0,web_search:'disabled',analytics:{enabled:false},features:Object.fromEntries(['shell_tool','shell_snapshot','memories','plugins','hooks','multi_agent','apps','browser_use','computer_use','js_repl'].map(key=>[key,false])),agents:{enabled:false},apps:{_default:{enabled:false}},mcp_servers:{learnbridge:mcp}};
    const child=spawn(process.execPath, [script, mode, JSON.stringify(config)], options); const original=child.stdin.write.bind(child.stdin); child.stdin.write=(line,...rest)=>{requests.push(JSON.parse(line));return original(line,...rest)};return child; };
  const adapter = createCodexAdapter({ projectRoot: project, dataRoot: data, grantId: randomUUID(), authorize: () => authorized,
    onEvent: e => emitted.push(e), ...settings.input }, { factory, protocolProbe: async () => ({ version: '0.154.0', protocol_verified: true, experimental_protocol_verified: true }), requestTimeoutMs: 2000, ...settings.options });
  t.after(async () => { await adapter.close(); rmSync(base, { recursive: true, force: true }); }); return { adapter, launched, emitted, requests, setAuthorized: value => { authorized = value; } };
}
async function start(adapter) { await adapter.initialize(); return adapter.startThread(); }

test('CA01 typed stdio handshake and completed authoritative text deduplicate item completion', async t => {
  const { adapter, emitted } = fixture(t); const thread = await start(adapter); const handle = await adapter.startTurn({ prompt: 'Explain this synthetic note.' }); const result = await handle.completion;
  assert.equal(thread.thread_id, 'fixture-thread'); assert.equal(result.status, 'completed'); assert.equal(result.text, 'Authoritative synthetic answer'); assert.equal(result.output_complete, true);
  assert.equal(emitted.filter(e => e.type === 'message_completed').length, 1); assert.equal(emitted.filter(e => e.type === 'text_delta').length, 2); assert.deepEqual(emitted.map(e => e.sequence), emitted.map((_, index) => index + 1));
  assert.equal(adapter.capabilities().model_entitlement_verified, false); assert.equal(JSON.stringify(emitted).includes('PRIVATE_EMAIL_CANARY'), false); assert.equal(JSON.stringify(emitted).includes('PRIVATE_AUTH_LOCATION_CANARY'), false);
});

test('CA02 fixed launch excludes API keys, injection, apps and generic execution control', async t => {
  const saved = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'PRIVATE_KEY_CANARY'; t.after(() => { if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved; });
  const { adapter, launched } = fixture(t); await start(adapter); const call = launched[0]; assert.equal(call.args[0], 'app-server'); assert.equal(call.options.env.OPENAI_API_KEY, undefined); assert.equal(call.options.env.NODE_OPTIONS, undefined);
  assert(call.args.includes('features.shell_tool=false')); assert(call.args.includes('features.plugins=false')); assert(call.args.includes('apps._default.enabled=false')); assert(call.args.includes('forced_login_method="chatgpt"'));
  assert.equal(call.args.includes('--analytics-default-enabled'), false); assert.equal(Object.hasOwn(adapter, 'request'), false); assert.equal(Object.hasOwn(adapter, 'exec'), false); assert.equal(Object.hasOwn(adapter, 'login'), false);
});

test('CA03 non-ChatGPT and missing normal authentication fail without API fallback', async t => {
  for (const [mode, code] of [['apikey', 'UNSUPPORTED'], ['noauth', 'AUTH_REQUIRED']]) { const { adapter, launched } = fixture(t, mode); await assert.rejects(adapter.initialize(), { code }); assert.equal(launched.length, 1); }
});

test('CA04 extra connector or widened native sandbox fails before any turn', async t => {
  for (const mode of ['extraMcp', 'unsafeSandbox']) { const { adapter } = fixture(t, mode); await adapter.initialize(); await assert.rejects(adapter.startThread(), { code: 'SCOPE_DENIED' }); assert.equal(adapter.capabilities().state, 'unsupported'); }
});

test('CA05 current MCP catalog is rechecked on every turn', async t => {
  const { adapter } = fixture(t, 'changedMcp'); await start(adapter); await assert.rejects(adapter.startTurn({ prompt: 'Synthetic' }), { code: 'SCOPE_DENIED' });
});

test('CA06 official interrupt records incomplete output and never starts another turn', async t => {
  const { adapter, emitted } = fixture(t, 'cancel'); await start(adapter); const handle = await adapter.startTurn({ prompt: 'Synthetic cancel fixture' }); await handle.interrupt(); const result = await handle.completion;
  assert.equal(result.status, 'interrupted'); assert.equal(result.native_status, 'interrupted'); assert.equal(result.output_complete, false); assert(emitted.some(e => e.type === 'cancel_requested'));
});

test('CA07 native approval defaults to decline, with no leaked command or accepting method', async t => {
  const { adapter, emitted } = fixture(t, 'approval'); await start(adapter); const handle = await adapter.startTurn({ prompt: 'Synthetic approval' }); const result = await handle.completion; assert.equal(result.status, 'completed'); assert.equal(result.text, 'Native request was declined.');
  const required = emitted.find(e => e.type === 'approval_required'); assert.deepEqual(required.allowed_decisions, ['reject', 'cancel']); assert.equal(JSON.stringify(emitted).includes('PRIVATE_COMMAND_CANARY'), false);
});

test('CA08 human native decision binds pending request fingerprint, thread and turn', async t => {
  let resolve; const shown = new Promise(done => { resolve = done; }); const { adapter } = fixture(t, 'humanApproval', { input: { onApproval: resolve } }); await start(adapter); const handle = await adapter.startTurn({ prompt: 'Synthetic human review' }); const pending = await shown;
  assert.throws(() => adapter.decideApproval({ request_id: pending.request_id, fingerprint: 'wrong', decision: 'reject' }), { code: 'REVISION_CONFLICT' });
  assert.throws(() => adapter.decideApproval({ request_id: pending.request_id, fingerprint: pending.fingerprint, decision: 'accept' }), { code: 'UNSUPPORTED' });
  assert.equal(adapter.decideApproval({ request_id: pending.request_id, fingerprint: pending.fingerprint, decision: 'reject' }), true); assert.equal((await handle.completion).status, 'completed');
  assert.throws(() => adapter.decideApproval({ request_id: pending.request_id, fingerprint: pending.fingerprint, decision: 'reject' }), { code: 'REVISION_CONFLICT' });
});

test('CA09 unknown token request and forbidden tool/foreign grant fail closed', async t => {
  for (const [mode, code] of [['unknownRequest', 'UNSUPPORTED'], ['forbiddenTool', 'SCOPE_DENIED'], ['wrongGrant', 'SCOPE_DENIED']]) { const { adapter, emitted } = fixture(t, mode); await start(adapter); const handle = await adapter.startTurn({ prompt: 'Synthetic policy test' }); const result = await handle.completion; assert.equal(result.status, 'failed'); assert.equal(result.error.code, code); assert.equal(JSON.stringify(emitted).includes('PRIVATE_COMMAND_CANARY'), false); }
});

test('CA10 process loss or unacknowledged turn start remains unknown instead of a retry', async t => {
  const crashed = fixture(t, 'crash'); await start(crashed.adapter); const handle = await crashed.adapter.startTurn({ prompt: 'Synthetic crash' }); assert.equal((await handle.completion).status, 'unknown_outcome'); assert.equal(crashed.launched.length, 1);
  const timeout = fixture(t, 'noStartReply', { options: { requestTimeoutMs: 100 } }); await start(timeout.adapter); await assert.rejects(timeout.adapter.startTurn({ prompt: 'Synthetic uncertain start' }), { code: 'UNKNOWN_OUTCOME' }); assert.equal(timeout.launched.length, 1);
});

test('CA11 grant revocation after start withholds output and cached event reads', async t => {
  const { adapter, setAuthorized } = fixture(t, 'noauthLater'); await start(adapter); const handle = await adapter.startTurn({ prompt: 'Synthetic revoke' }); setAuthorized(false); await adapter.close(); const result = await handle.completion;
  assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'CONSENT_REQUIRED'); assert.equal(result.text, ''); assert.deepEqual(result.tool_receipts, []); assert.throws(() => adapter.events(), { code: 'CONSENT_REQUIRED' });
});

test('CA12 unrelated native thread/turn content never enters normalized output', async t => {
  const { adapter, emitted } = fixture(t, 'wrongScope'); await start(adapter); const handle = await adapter.startTurn({ prompt: 'Synthetic scopes' }); assert.equal((await handle.completion).text, 'Authoritative synthetic answer'); assert.equal(JSON.stringify(emitted).includes('PRIVATE_FOREIGN'), false);
});

test('CA13 input/turn budgets are cumulative and conflicting concurrent starts are denied', async t => {
  const { adapter } = fixture(t, 'normal', { options: { limits: { maxTurns: 1 } } }); await start(adapter);
  const pending = adapter.startTurn({ prompt: 'Synthetic first' }); await assert.rejects(adapter.startTurn({ prompt: 'Concurrent second' }), { code: 'REVISION_CONFLICT' }); const handle = await pending; await handle.completion;
  await assert.rejects(adapter.startTurn({ prompt: 'Over the cumulative limit' }), { code: 'BUDGET_EXCEEDED' });
});

test('CA14 raw output flood stops the child at its bounded stream budget', async t => {
  const { adapter } = fixture(t, 'flood', { options: { limits: { maxOutputBytes: 20000 } } }); await start(adapter); const handle = await adapter.startTurn({ prompt: 'Synthetic flood' }); const result = await handle.completion; assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'BUDGET_EXCEEDED');
});

test('CA15 persisted native resume binds the same selected grant/project; ephemeral resume rejects', async t => {
  const persisted = fixture(t, 'cancel', { input: { persistSessions: true } }); const thread = await start(persisted.adapter); const handle = await persisted.adapter.startTurn({ prompt: 'Synthetic interrupted durable turn' }); await handle.interrupt(); await handle.completion;
  const resumed = await persisted.adapter.resumeThread(thread.checkpoint); assert.equal(resumed.thread_id, thread.thread_id); assert.equal(resumed.checkpoint.persisted, true);
  await assert.rejects(persisted.adapter.resumeThread({ ...thread.checkpoint, scope_hash: 'wrong-scope' }), { code: 'SCOPE_DENIED' });
  const ephemeral = fixture(t); const temporary = await start(ephemeral.adapter); await assert.rejects(ephemeral.adapter.resumeThread(temporary.checkpoint), { code: 'SCOPE_DENIED' });
});

test('CA16 RPC provider error is sanitized and never triggers another authentication mode', async t => {
  const { adapter, launched, emitted } = fixture(t, 'rpcError'); await start(adapter); await assert.rejects(adapter.startTurn({ prompt: 'Synthetic error' }), { code: 'AUTH_REQUIRED' }); assert.equal(launched.length, 1); assert.equal(JSON.stringify(emitted).includes('PRIVATE_ERROR_CANARY'), false);
});

test('CA17 protocol version changes require an explicit reviewed repin before launch', async t => {
  const { adapter, launched } = fixture(t, 'normal', { options: { protocolProbe: async () => ({ version: '9.0.0', protocol_verified: true }) } }); await assert.rejects(adapter.initialize(), { code: 'VERSION_MISMATCH' }); assert.equal(launched.length, 0);
  await assert.rejects(probeCodexProtocol({ binary: 'relative/unsafe' }), { code: 'INVALID_INPUT' });
});

test('CA18 effective configuration rejects inherited execution/providers/context before any thread start', async t => {
  for (const mode of ['extraConfigMcp','hooksConfig','fileInstructions','notifyConfig','providerConfig','enabledFeature','appOverride','missingOverrides']) {
    const {adapter,requests,emitted}=fixture(t,mode);await assert.rejects(adapter.initialize(),{code:'SCOPE_DENIED'});assert.equal(requests.some(r=>r.method==='thread/start'||r.method==='account/read'),false);assert.equal(adapter.capabilities().state,'unsupported');assert.equal(JSON.stringify(emitted).includes('PRIVATE_'),false);
  }
});

test('CA19 effective config is rechecked before each turn and changed flags stop dispatch', async t => {
  const {adapter,requests}=fixture(t,'changedConfig');await start(adapter);await assert.rejects(adapter.startTurn({prompt:'Synthetic changed configuration'}),{code:'SCOPE_DENIED'});assert.equal(requests.some(r=>r.method==='turn/start'),false);assert.equal(adapter.capabilities().state,'unsupported');
  for(const request of requests.filter(r=>r.method==='config/read'))assert.deepEqual(request.params,{includeLayers:false,cwd:requests.find(r=>r.method==='thread/start').params.cwd});
});

test('CA20 acknowledged interrupt clears its grace timer after native completion', async t => {
  const {adapter}=fixture(t,'delayedCancel');await start(adapter);const turn=await adapter.startTurn({prompt:'Synthetic timer cleanup'});await turn.interrupt();assert.equal((await turn.completion).status,'interrupted');await new Promise(resolve=>setTimeout(resolve,1100));assert.equal(adapter.capabilities().state,'available');const continuation=await adapter.startTurn({prompt:'Synthetic second interrupt'});await continuation.interrupt();assert.equal((await continuation.completion).status,'interrupted');
});

test('CA21 the fourth tool allows only a bounded source-bound unreviewed document proposal', async t => {
  const valid=fixture(t,'documentProposal');await start(valid.adapter);const turn=await valid.adapter.startTurn({prompt:'Synthetic source-bound proposal'}),result=await turn.completion;assert.equal(result.status,'completed');assert.equal(result.tool_receipts.length,1);assert.equal(result.tool_receipts[0].tool,'learnbridge_propose_document');assert.equal(JSON.stringify(valid.emitted).includes('Reviewed-source synthetic outline'),false);
  for(const [mode,code] of [['oversizedDocument','INVALID_INPUT'],['wrongDocumentSource','SCOPE_DENIED']]){const {adapter}=fixture(t,mode);await start(adapter);const handle=await adapter.startTurn({prompt:'Synthetic invalid proposal'});const outcome=await handle.completion;assert.equal(outcome.status,'failed');assert.equal(outcome.error.code,code);}
});


test('CA22 serialized neutral native defaults pass without accepting active unknown authority', async t => {
  const {adapter}=fixture(t,'neutralDefaults'); await start(adapter);
  assert.equal(adapter.capabilities().state,'available');
});


test('CA23 stable client MCP calls use only the fixed server and validate the current grant', async t => {
  const {adapter,requests}=fixture(t);await start(adapter);
  const result=await adapter.callLearnBridgeTool('learnbridge_status',{});assert.equal(result.value.synthetic,true);assert.equal(result.receipt.status,'completed');
  await assert.rejects(adapter.callLearnBridgeTool('private_arbitrary_tool',{}),{code:'SCOPE_DENIED'});
  await assert.rejects(adapter.callLearnBridgeTool('learnbridge_context',{grant_id:'another-grant'}),{code:'SCOPE_DENIED'});
  const calls=requests.filter(item=>item.method==='mcpServer/tool/call');assert.equal(calls.length,1);assert.deepEqual(calls[0].params,{threadId:'fixture-thread',server:'learnbridge',tool:'learnbridge_status',arguments:{}});
});

test('CA24 an unacknowledged stable MCP call closes the process with unknown outcome and never retries', async t => {
  const {adapter,requests}=fixture(t,'lostToolAck',{options:{requestTimeoutMs:150}});await start(adapter);
  await assert.rejects(adapter.callLearnBridgeTool('learnbridge_status',{}),{code:'UNKNOWN_OUTCOME'});
  assert.equal(requests.filter(value=>value.method==='mcpServer/tool/call').length,1);
  await assert.rejects(adapter.callLearnBridgeTool('learnbridge_status',{}));
  assert.equal(requests.filter(value=>value.method==='mcpServer/tool/call').length,1);
});

test('CA25 authoritative final phase excludes preceding commentary from structured output', async t => {
  const {adapter}=fixture(t,'finalPhase');await start(adapter);const turn=await adapter.startTurn({prompt:'Synthetic JSON output'});
  const result=await turn.completion;assert.equal(result.status,'completed');assert.deepEqual(JSON.parse(result.text),{answer:'Authoritative final'});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalStore } from '@learnbridge/local-storage';
import { createHostTurns } from '../apps/local-runtime/src/host-turns.mjs';
import { createCodexProfile } from '../apps/local-runtime/src/codex-profile.mjs';
import { createCodexAdapter } from '../apps/local-runtime/src/codex-adapter.mjs';
import { learnBridgeDynamicTools, learnBridgeToolNames } from '../apps/local-runtime/src/codex-tools.mjs';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const receipt = tool => ({ tool, status: 'completed', failed: false, result_hash: sha(tool), origin: 'model' });
const sourced = text => ({ state: 'completed', complete: true, text, output_sha256: sha(text), tool_receipts: [receipt('learnbridge_context')], host_version: 'synthetic-policy' });
function storeFixture(t) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'learnbridge-tool-policy-unit-'))), root = join(parent, 'private'), store = LocalStore.open({ root });
  const source = store.createDocument({ title: 'Selected source', text: 'Please review your timetable by 2026-10-09.', academic_policy: 'graded_restricted' });
  const grant = store.createAgentGrant({ destination: 'codex', document_ids: [source.document.id], max_bytes: 96000, expires_in_minutes: 5 });
  t.after(() => { store.close(); rmSync(parent, { recursive: true, force: true }); });
  return { store, parent, root, source, grant };
}
async function finished(service, id) { for (let index = 0; index < 100; index++) { const item = service.get(id); if (!['queued', 'running'].includes(item.data.state)) return item; await delay(5); } assert.fail('Synthetic policy turn did not settle'); }

test('CTP01 trusted read-only policy advertises exactly two eager tools and invalid policies cannot expand it', () => {
  const grant = randomUUID();
  assert.deepEqual(learnBridgeDynamicTools(grant, 'read_only').map(tool => tool.name), ['learnbridge_status', 'learnbridge_context']);
  assert.equal(learnBridgeDynamicTools(grant).length, 4);
  assert(learnBridgeDynamicTools(grant, 'read_only').every(tool => tool.deferLoading === false));
  assert(Object.isFrozen(learnBridgeToolNames('read_only')));
  for (const policy of [null, 'full_access', {}, ['read_only']]) assert.throws(() => learnBridgeDynamicTools(grant, policy), { code: 'INVALID_INPUT' });
});

test('CTP02 trusted policy is persisted, propagated, retry-bound in both directions and retained after restart without replay', async t => {
  const f = storeFixture(t), calls = [], input = { grant_id: f.grant.id, prompt: 'Read the selected source.', confirmed: true };
  const service = createHostTurns({ store: f.store, enabled: true, execute: async value => { calls.push(value.toolPolicy); return sourced('Synthetic sourced answer.'); } });
  const start = (key, policy) => service.start(input, { idempotencyKey: key, authorize: () => true, ...(policy ? { toolPolicy: policy } : {}) });
  const first = await start('read-policy-idempotent-001', 'read_only'); await finished(service, first.id);
  assert.equal(first.data.tool_policy, 'read_only'); assert.equal((await start('read-policy-idempotent-001', 'read_only')).id, first.id);
  await assert.rejects(start('read-policy-idempotent-001'), { code: 'REVISION_CONFLICT' });
  const second = await start('review-policy-idempotent-002'); await finished(service, second.id);
  assert.equal(second.data.tool_policy, 'reviewed_proposals'); await assert.rejects(start('review-policy-idempotent-002', 'read_only'), { code: 'REVISION_CONFLICT' });
  assert.deepEqual(calls, ['read_only', 'reviewed_proposals']);
  await service.drain(); f.store.close(); const reopened = LocalStore.open({ root: f.root }); t.after(() => reopened.close());
  const restarted = createHostTurns({ store: reopened, enabled: true, execute: async () => { assert.fail('No policy turn may replay'); } });
  assert.equal(restarted.get(first.id).data.tool_policy, 'read_only');
  assert.equal((await restarted.start(input, { idempotencyKey: 'read-policy-idempotent-001', authorize: () => true, toolPolicy: 'read_only' })).id, first.id);
  await assert.rejects(restarted.start(input, { idempotencyKey: 'read-policy-idempotent-001', authorize: () => true }), { code: 'REVISION_CONFLICT' });
});

test('CTP03 public-shaped input cannot choose policy, fallback fails closed and read-only controller rejects hidden proposal progress or receipts', async t => {
  const f = storeFixture(t), input = { grant_id: f.grant.id, prompt: 'Read selected context.', confirmed: true };
  const fallback = createHostTurns({ store: f.store, enabled: true });
  await assert.rejects(fallback.start(input, { idempotencyKey: 'fallback-read-policy-01', authorize: () => true, toolPolicy: 'read_only' }), { code: 'UNSUPPORTED' });
  assert.equal(f.store.listWorkspaceRecords().length, 0);
  for (const mode of ['progress', 'receipt']) {
    const service = createHostTurns({ store: f.store, enabled: true, execute: async value => {
      if (mode === 'progress') value.onProgress({ phase: 'tool', tool: 'learnbridge_propose_task', state: 'running' });
      return { ...sourced('WITHHELD_POLICY_CANARY'), ...(mode === 'receipt' ? { tool_receipts: [receipt('learnbridge_context'), receipt('learnbridge_propose_task')] } : {}) };
    } });
    await assert.rejects(service.start({ ...input, toolPolicy: 'reviewed_proposals' }, { idempotencyKey: 'public-policy-reject-01', authorize: () => true }), { code: 'INVALID_INPUT' });
    const item = await service.start(input, { idempotencyKey: `hidden-policy-${mode}`, authorize: () => true, toolPolicy: 'read_only' }), final = await finished(service, item.id);
    assert.equal(final.data.state, 'withheld'); assert.equal(final.data.error_code, 'SCOPE_DENIED'); assert.equal(final.data.text, ''); assert.equal(final.data.progress.length, 0);
    assert.equal(f.store.listTaskProposals().length, 0); await service.drain();
  }
});

test('CTP04 profile denies proposal permits before delegation and structured read-only output has no generic proposal path', async t => {
  for (const mode of ['hiddenPermit', 'genericOutput', 'valid']) {
    const f = storeFixture(t); let delegated = 0, adapterPolicy, turnInput; const calls = [];
    const profile = createCodexProfile({ store: f.store, profileRoot: join(f.parent, 'codex-profile'), executionMode: 'structured',
      leaseFactory: (grant, allowed, policy) => { assert.equal(grant, f.grant.id); assert.equal(allowed(), true); assert.equal(policy, 'read_only'); return { id: randomUUID(), release() {}, permitTool() { delegated++; return () => {}; } }; },
      adapterFactory: input => { adapterPolicy = input.toolPolicy; return {
        async initialize() { return { state: 'available' }; }, async startThread() {}, async close() {},
        async callLearnBridgeTool(tool, args) { calls.push(tool); const value = tool === 'learnbridge_context' ? f.store.agentContext({ destination: 'codex', ...args }) : { healthy: true }; return { value, receipt: { ...receipt(tool), origin: 'runtime' } }; },
        async startTurn(value) {
          turnInput = value;
          if (mode === 'hiddenPermit') input.toolPermit('learnbridge_propose_task', { grant_id: f.grant.id, title: 'Forbidden generic action', idempotency_key: 'forbidden-readonly-proposal' });
          const output = { answer: 'Synthetic read-only answer.', ...(mode === 'genericOutput' ? { task_proposals: [{ title: 'Forbidden generic task', reason: 'Unquoted' }], document_proposals: [] } : {}) };
          return { completion: Promise.resolve({ status: 'completed', turn_id: 'synthetic-policy-turn', text: JSON.stringify(output) }) };
        },
      }; } });
    t.after(() => profile.stop()); await profile.connect({ sessionId: 'synthetic-policy-browser', authorize: () => true });
    const execute = () => profile.execute({ grantId: f.grant.id, prompt: 'Return the bounded workflow answer.', authorize: () => true, toolPolicy: 'read_only' });
    if (mode === 'valid') assert.equal((await execute()).text, 'Synthetic read-only answer.');
    else await assert.rejects(execute(), { code: mode === 'hiddenPermit' ? 'SCOPE_DENIED' : 'VERSION_MISMATCH' });
    assert.equal(adapterPolicy, 'read_only'); assert.deepEqual(turnInput.outputSchema.required, ['answer']);
    assert.match(turnInput.prompt, /workflow is read-only/); assert.doesNotMatch(turnInput.prompt, /include task\/document proposals only/);
    assert.equal(delegated, 0); assert.deepEqual(calls, ['learnbridge_status', 'learnbridge_context']); assert.equal(f.store.listTaskProposals().length, 0);
    assert.equal(f.store.listWorkspaceRecords().length, 0); assert.equal(f.store.listDocuments().length, 1); await profile.stop();
  }
});

// Native account/model responses below are synthetic. The actual SDK MCP
// stdio transport, paired runtime IPC lease and private SQLite are exercised.
// No account credential, model network call or provider write occurs.
const fixtureSource = String.raw`
import readline from 'node:readline';
const [mode,configText,clientUrl,transportUrl]=process.argv.slice(2),config=JSON.parse(configText);
const {Client}=await import(clientUrl),{StdioClientTransport}=await import(transportUrl);
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
let client,context,step=0,pending,items=[],thread='policy-thread',turn='policy-turn';
const grant=config.mcp_servers.learnbridge.args[config.mcp_servers.learnbridge.args.indexOf('--grant-id')+1];
const note=(method,params)=>send({method,params:{threadId:thread,turnId:turn,...params}});
const finish=()=>{const payload='BEGIN_LEARNBRIDGE_TASKS_V1\n'+JSON.stringify({tasks:[{title:'Review timetable',quote:'Please review your timetable by 2026-10-09.',deadline:'2026-10-09'}]})+'\nEND_LEARNBRIDGE_TASKS_V1',item={id:'answer',type:'agentMessage',phase:'final_answer',text:JSON.stringify({answer:payload})};note('item/completed',{item});note('turn/completed',{turn:{id:turn,status:'completed',items:[...items,item]}})};
const ask=async()=>{
 if(step===2&&mode==='nativeBypass'){
  for(const tool of ['learnbridge_propose_task','learnbridge_propose_document']){const doc=context.documents[0],args=tool.endsWith('task')?{grant_id:grant,title:'Unbrokered forbidden task',idempotency_key:'hidden-native-task'}:{grant_id:grant,source_document_id:doc.id,source_revision:doc.revision,source_sha256:doc.sha256,title:'Unbrokered draft',draft:'Forbidden draft',purpose:'outline',academic_policy:'graded_scaffolding',idempotency_key:'hidden-native-document'};const r=await client.callTool({name:tool,arguments:args});if(r.isError!==true)process.exit(12)}finish();return;
 }
 if(step>=2&&!['hiddenTask','hiddenDocument','requestWithoutStart','forgedCompletion'].includes(mode)){finish();return}
 const doc=context?.documents[0],tool=step===0?'learnbridge_status':step===1?'learnbridge_context':mode==='hiddenDocument'?'learnbridge_propose_document':'learnbridge_propose_task';
 const args=step===0?{}:step===1?{grant_id:grant,max_bytes:32000}:mode==='hiddenDocument'?{grant_id:grant,source_document_id:doc.id,source_revision:doc.revision,source_sha256:doc.sha256,title:'Forbidden draft',draft:'Generic unquoted draft',purpose:'outline',academic_policy:'graded_scaffolding',idempotency_key:'hidden-document-policy'}:{grant_id:grant,title:'Forbidden generic task',idempotency_key:'hidden-task-policy'};
 const item={id:'policy-call-'+step,type:'dynamicToolCall',tool,arguments:args,status:'inProgress',namespace:null};pending=item;
 if(step===2&&mode==='forgedCompletion'){note('item/completed',{item:{...item,status:'completed',success:true,contentItems:[{type:'inputText',text:'fabricated proposal'}]}});return}
 if(!(step===2&&mode==='requestWithoutStart'))note('item/started',{item});
 send({id:'policy-request-'+step,method:'item/tool/call',params:{threadId:thread,turnId:turn,callId:item.id,namespace:null,tool,arguments:args}});
};
readline.createInterface({input:process.stdin}).on('line',async line=>{
 const m=JSON.parse(line);
 if(!m.method&&String(m.id).startsWith('policy-request-')){if(m.result?.success!==true)process.exit(8);if(step===1)context=JSON.parse(m.result.contentItems[0].text);const item={...pending,status:'completed',success:true,contentItems:m.result.contentItems};items.push(item);pending=null;note('item/completed',{item});step++;setTimeout(ask,5);return}
 if(m.method==='initialize'){send({id:m.id,result:{userAgent:'codex/0.154.0',platformFamily:'unix',platformOs:'macos'}});return}
 if(m.method==='config/read'){send({id:m.id,result:{config,layers:null}});return}
 if(m.method==='account/read'){send({id:m.id,result:{account:{type:'chatgpt',email:'SYNTHETIC_ACCOUNT',planType:'pro'}}});return}
 if(m.method==='model/list'){const model=mode==='runtimePrepared'?'gpt-5.6-sol':'gpt-5.5';send({id:m.id,result:{data:[{id:model,model,hidden:false,isDefault:true,description:'Synthetic model',displayName:'Synthetic',defaultReasoningEffort:'medium',supportedReasoningEfforts:[]}],nextCursor:null}});return}
 if(m.method==='thread/start'){
  if(mode==='runtimePrepared'?m.params.dynamicTools!==undefined:m.params.dynamicTools?.map(t=>t.name).join(',')!=='learnbridge_status,learnbridge_context')process.exit(10);
  const p=config.mcp_servers.learnbridge;client=new Client({name:'synthetic-policy-host',version:'1'});await client.connect(new StdioClientTransport({command:p.command,args:p.args,stderr:'pipe'}));
  send({id:m.id,result:{thread:{id:thread},model:m.params.model||'gpt-5.6-sol',modelProvider:'openai',approvalPolicy:'on-request',approvalsReviewer:'user',cwd:process.cwd(),sandbox:{type:'readOnly',networkAccess:false}}});return;
 }
 if(m.method==='mcpServerStatus/list'){const tools=(await client.listTools()).tools;send({id:m.id,result:{data:[{name:'learnbridge',tools:Object.fromEntries(tools.map(t=>[t.name,t])),resources:[],resourceTemplates:[],runtimeStatus:'connected'}],nextCursor:null}});return}
 if(m.method==='mcpServer/tool/call'){const result=await client.callTool({name:m.params.tool,arguments:m.params.arguments});if(m.params.tool==='learnbridge_context')context=JSON.parse(result.content[0].text);send({id:m.id,result});return}
 if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:turn,status:'inProgress',items:[]}}});note('turn/started',{turn:{id:turn}});setTimeout(mode==='runtimePrepared'?finish:ask,5);return}
 if(m.method==='turn/interrupt'){send({id:m.id,result:{}});return}
});
`;

async function transportFixture(t, mode) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'learnbridge-readonly-mcp-'))), script = join(parent, 'synthetic-native-host.mjs'), traffic = [], launches = [];
  writeFileSync(script, fixtureSource);
  const factory = (_binary, args, options) => {
    const inline = args.at(-1), mcp = { command: '/usr/bin/env', args: JSON.parse(inline.match(/args = (\[.*?\])/)[1]), enabled_tools: JSON.parse(inline.match(/enabled_tools = (\[.*?\])/)[1]), startup_timeout_sec: 15, tool_timeout_sec: 20, required: true };
    const config = { forced_login_method: 'chatgpt', model_provider: 'openai', sandbox_mode: 'read-only', approval_policy: 'on-request', approvals_reviewer: 'user', project_doc_max_bytes: 0, web_search: 'disabled', analytics: { enabled: false }, features: Object.fromEntries(['shell_tool','shell_snapshot','memories','plugins','hooks','multi_agent','apps','browser_use','computer_use','js_repl'].map(key => [key, false])), agents: { enabled: false }, apps: { _default: { enabled: false } }, mcp_servers: { learnbridge: mcp } };
    const child = spawn(process.execPath, [script, mode, JSON.stringify(config), import.meta.resolve('@modelcontextprotocol/client'), import.meta.resolve('@modelcontextprotocol/client/stdio')], options);
    launches.push(mcp); const write = child.stdin.write.bind(child.stdin); child.stdin.write = (line, ...rest) => { traffic.push(JSON.parse(line)); return write(line, ...rest); }; return child;
  };
  const runtime = await startRuntime({ dataRoot: join(parent, 'private'), port: 0, codexProfileOptions: { adapterFactory: createCodexAdapter, adapterOptions: { factory, protocolProbe: async () => ({ version: '0.154.0', protocol_verified: true, experimental_protocol_verified: true }), requestTimeoutMs: 1000 } } });
  t.after(async () => { await runtime.close(); rmSync(parent, { recursive: true, force: true }); });
  const pair = await fetch(runtime.origin + '/api/local/v1/pair', { method: 'POST', headers: { Origin: runtime.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: runtime.createPairingCode() }) });
  const auth = { Origin: runtime.origin, Cookie: pair.headers.get('set-cookie').split(';')[0], 'X-LearnBridge-Nonce': (await pair.json()).nonce, 'Content-Type': 'application/json' };
  const call = async (path, body) => { const response = await fetch(runtime.origin + '/api/local/v1' + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...auth, 'Idempotency-Key': 'policy-http-' + sha(JSON.stringify({ path, body })).slice(0, 40) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const data = await response.json(); return { status: response.status, data }; };
  assert.equal((await call('/ai/connect', { confirmed: true })).status, 200);
  const imported = await call('/productivity/updates', { provider: 'gmail', account: 'synthetic@example.test', source_id: 'policy-source', subject: 'Timetable', body: 'Please review your timetable by 2026-10-09.', section: 'communications', observed_at: new Date(Date.now() - 60000).toISOString() }); assert.equal(imported.status, 201);
  assert.equal((await call('/dynamic-tasks/config', { expected_revision: 0, selections: [{ kind: 'update', id: imported.data.item.id, course_ids: [] }], enabled: true, auto_create: true, auto_complete: true, confirmed: true })).status, 200);
  const source = (await call('/dynamic-task-ai/context')).data.sources[0], pin = { source_id: source.id, source_revision: source.revision, source_hash: source.source_hash }, preview = (await call('/dynamic-task-ai/preview', pin)).data;
  const started = await call('/dynamic-task-ai/extractions', { ...pin, review_hash: preview.review_hash, confirmed: true }); assert.equal(started.status, 202);
  let turn; for (let index = 0; index < 200; index++) { turn = (await call('/host-turns')).data.items[0]; if (!['queued','running'].includes(turn.data.state)) break; await delay(10); }
  return { runtime, traffic, launches, call, turn, extraction: started.data.item };
}

test('CTP05 paired source extraction uses actual MCP/IPC read tools only, preserves strict pending review and rejects a public policy field', async t => {
  const f = await transportFixture(t, 'normal'); assert.equal(f.turn.data.state, 'completed', f.turn.data.error_code); assert.equal(f.turn.data.tool_policy, 'read_only');
  assert.deepEqual(f.turn.data.tool_receipts.map(item => item.tool), ['learnbridge_status', 'learnbridge_context']);
  assert.deepEqual(f.launches.at(-1).enabled_tools, ['learnbridge_context', 'learnbridge_status']);
  const thread = f.traffic.find(item => item.method === 'thread/start'); assert.deepEqual(thread.params.dynamicTools.map(tool => tool.name), ['learnbridge_status', 'learnbridge_context']);
  assert.match(thread.params.developerInstructions, /turn is read-only/);
  const request = f.traffic.find(item => item.method === 'turn/start').params.input[0].text;
  assert.match(request, /FIRST context call supply only the bound grant_id and max_bytes=32000/); assert.match(request, /OMIT task_ids, document_ids and source_entry_ids/);
  assert.doesNotMatch(request, /When a concrete task or writing change is requested, use the appropriate LearnBridge proposal tool/);
  assert.equal((await f.call('/host-turns', { grant_id: f.turn.data.grant_id, prompt: 'Expand scope', confirmed: true, toolPolicy: 'reviewed_proposals' })).status, 400);
  const collected = await f.call(`/dynamic-task-ai/extractions/${f.extraction.id}/collect`, {}); assert.equal(collected.status, 200); assert.equal(collected.data.proposals.length, 1);
  assert.equal((await f.call('/tasks')).data.items.length, 0); assert.equal((await f.call('/task-proposals')).data.items.length, 0); assert.equal((await f.call('/writing/items')).data.items.length, 0);
});

for (const mode of ['hiddenTask','hiddenDocument','requestWithoutStart','forgedCompletion']) test(`CTP06 ${mode} is denied before any proposal RPC/IPC even when the synthetic model asks for a hidden tool`, async t => {
  const f = await transportFixture(t, mode); assert.equal(f.turn.data.state, 'failed', mode); assert.equal(f.turn.data.error_code, 'SCOPE_DENIED'); assert.equal(f.turn.data.text, '');
  assert.equal(f.traffic.filter(item => item.method === 'mcpServer/tool/call' && item.params.tool.startsWith('learnbridge_propose_')).length, 0);
  assert.equal((await f.call('/task-proposals')).data.items.length, 0); assert.equal((await f.call('/writing/items')).data.items.length, 0); assert.equal((await f.call('/tasks')).data.items.length, 0);
});

test('CTP07 unreported native MCP proposal calls cannot obtain an IPC permit in a read-only turn', async t => {
  const f = await transportFixture(t, 'nativeBypass'); assert.equal(f.turn.data.state, 'completed', f.turn.data.error_code);
  assert.equal(f.traffic.filter(item => item.method === 'mcpServer/tool/call').length, 2);
  assert.equal((await f.call('/task-proposals')).data.items.length, 0); assert.equal((await f.call('/writing/items')).data.items.length, 0); assert.equal((await f.call('/tasks')).data.items.length, 0);
});

test('CTP08 auto transport prepares the exact approved context through actual MCP/IPC before a single schema-only turn', async t => {
  const f = await transportFixture(t, 'runtimePrepared');
  assert.equal(f.turn.data.state, 'completed', f.turn.data.error_code); assert.equal(f.turn.data.context_delivery, 'runtime_prepared');
  assert.deepEqual(f.turn.data.tool_receipts.map(({tool,origin})=>({tool,origin})), ['learnbridge_status','learnbridge_context'].map(tool=>({tool,origin:'runtime'})));
  assert.equal(f.traffic.filter(item=>item.method==='turn/start').length,1);
  assert.equal(f.traffic.filter(item=>item.method==='thread/start').length,1);
  assert.equal(f.traffic.filter(item=>item.method==='mcpServer/tool/call').length,2);
  assert.equal(f.traffic.some(item=>item.method==='item/tool/call'),false);
  assert.equal(f.launches.length,3); // explicit login, catalogue-only probe, fresh schema-only adapter
  const thread=f.traffic.find(item=>item.method==='thread/start').params;
  assert.equal(thread.dynamicTools,undefined); assert.match(thread.developerInstructions,/runtime prepares approved status\/context/);
  assert.doesNotMatch(thread.developerInstructions,/Call learnbridge_status, then/);
  const turn=f.traffic.find(item=>item.method==='turn/start').params;
  assert.deepEqual(turn.outputSchema.required,['answer']); assert.match(turn.input[0].text,/Selected approved context/);
  assert.match(turn.input[0].text,/Please review your timetable by 2026-10-09/);
  assert.equal((await f.call('/ai/status')).data.tool_execution,'runtime_prepared');
  assert.equal((await f.call('/tasks')).data.items.length,0); assert.equal((await f.call('/task-proposals')).data.items.length,0);
  assert.equal((await f.call('/writing/items')).data.items.length,0);
});

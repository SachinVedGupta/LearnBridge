import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { executeCodexTurn } from '../apps/local-runtime/src/codex-exec.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const tools = ['learnbridge_status', 'learnbridge_context', 'learnbridge_propose_task', 'learnbridge_propose_document'];
const fixtureSource = [
  "import { spawn } from 'node:child_process';",
  "import { writeFileSync } from 'node:fs';",
  "const [stage, raw, marker] = process.argv.slice(2), s = JSON.parse(raw);",
  "if ((s.hangStage || '') === stage) {",
  "  process.on('SIGTERM', () => {});",
  "  const child = s.descendant ? spawn(process.execPath, ['-e', \"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"], {stdio:'inherit'}) : null;",
  "  writeFileSync(marker, JSON.stringify({pid:process.pid, descendant:child?.pid})); setInterval(()=>{},1000);",
  "} else if (stage === 'version') { process.stdout.write(s.version ?? 'codex-cli 0.154.0\\n'); }",
  "else if (stage === 'auth') { process.stderr.write(s.auth ?? 'Logged in using ChatGPT\\n'); if(s.authStdout)process.stdout.write(s.authStdout); process.exitCode=s.authCode || 0; }",
  "else {",
  "  let prompt=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', part => prompt += part);",
  "  process.stdin.on('end', () => {",
  "    if (s.stderrBytes) process.stderr.write('x'.repeat(s.stderrBytes));",
  "    const output = s.raw ?? s.events.map(event=>JSON.stringify(event)).join('\\n')+'\\n';",
  "    const bytes=Buffer.from(output);",
  "    if (s.fragmented) { for(let i=0;i<bytes.length;i+=3) process.stdout.write(bytes.subarray(i,i+3)); } else process.stdout.write(bytes);",
  "    if (s.holdMs) setTimeout(()=>{process.exitCode=s.exitCode || 0;},s.holdMs); else process.exitCode=s.exitCode || 0;",
  "  });",
  "}",
].join('\n');
function pair(id, tool, args, value) {
  const item = { id, type: 'mcp_tool_call', server: 'learnbridge', tool, arguments: args, status: 'in_progress' };
  return [{ type: 'item.started', item }, { type: 'item.completed', item: { ...item, status: 'completed', result: { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false }, error: null } }];
}
function success(grant) {
  return [{ type: 'thread.started', thread_id: randomUUID() }, { type: 'turn.started' },
    ...pair('item_1', 'learnbridge_status', {}, { healthy: true, destination: 'codex', grants: [{ id: grant }] }),
    ...pair('item_2', 'learnbridge_context', { grant_id: grant }, { grant_id: grant, documents: [{ id: randomUUID(), text: 'SYNTHETIC_SELECTED_CANARY' }], tasks: [], source_entries: [] }),
    { type: 'item.completed', item: { id: 'item_3', type: 'reasoning', text: 'Synthetic reasoning' } },
    { type: 'item.completed', item: { id: 'item_4', type: 'agent_message', text: 'A synthetic base case ends recursion. 😀 Awaiting student review.' } },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 10 } }];
}
function fixture(t, extra = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-codex-exec-test-')), dataRoot = join(parent, 'data'), script = join(parent, 'child.mjs'), marker = join(parent, 'child-pids.json'); mkdirSync(dataRoot, { mode: 0o700 }); writeFileSync(script, fixtureSource, { mode: 0o600 });
  const grant = randomUUID(), scenario = { events: success(grant), ...extra }, calls = [];
  t.after(() => { for (const call of calls) { if (call.child.exitCode === null && call.child.signalCode === null) { try { process.kill(-call.child.pid, 'SIGKILL'); } catch { call.child.kill('SIGKILL'); } } } rmSync(parent, { recursive: true, force: true }); });
  const factory = (binary, args, options) => {
    const stage = args[0] === '--version' ? 'version' : args[0] === 'login' ? 'auth' : 'main';
    const child = spawn(process.execPath, [script, stage, JSON.stringify(scenario), marker], options); const call = { binary, args, options, stage, child, closed: false }; calls.push(call); child.once('close', () => { call.closed = true; }); return child;
  };
  return { parent, dataRoot, marker, grant, scenario, calls, factory, input: { dataRoot, grantId: grant, prompt: 'Explain the synthetic selected note; do not perform external actions.', authorize: () => true } };
}
function withheld(result, code) { assert.equal(result.complete, false); assert.equal(result.text, ''); assert.equal(result.output_sha256, sha('')); if (code) assert.equal(result.error_code, code); }
function running(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function gone(pid) { for (let i = 0; i < 100; i++) { if (!running(pid)) return true; await new Promise(resolve => setTimeout(resolve, 20)); } return false; }

test('real child protocol completes exact chronological context; fixed isolated flags and scrubbed environment', async t => {
  const f = fixture(t, { fragmented: true }); const prior = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'SYNTHETIC_ENV_SECRET_CANARY'; t.after(() => prior === undefined ? delete process.env.OPENAI_API_KEY : process.env.OPENAI_API_KEY = prior);
  const progress = [], result = await executeCodexTurn({ ...f.input, onProgress: value => progress.push(value) }, { factory: f.factory, timeoutMs: 5000 });
  assert.equal(result.state, 'completed'); assert.equal(result.complete, true); assert.match(result.text, /😀/); assert.equal(result.output_sha256, sha(result.text)); assert.equal(result.tool_receipts.length, 2); assert.equal(result.native_resume_available, false); assert.equal(result.account_mode, 'official_chatgpt_managed'); assert.equal(JSON.stringify(result.tool_receipts).includes('SYNTHETIC_SELECTED_CANARY'), false); assert.ok(progress.every(value => !('arguments' in value) && !('text' in value)));
  assert.deepEqual(f.calls.map(call => call.stage), ['version', 'auth', 'main']); assert.ok(f.calls.every(call => call.closed)); const { args, options } = f.calls[2];
  for (const flag of ['--ignore-user-config', '--ignore-rules', '--ephemeral', '--strict-config', '--json']) assert.ok(args.includes(flag));
  for (const entry of ['features.shell_tool=false', 'features.browser_use=false', 'features.computer_use=false', 'features.view_image=false', 'features.image_generation=false', 'features.skip_host_skill_discovery=true', 'project_doc_max_bytes=0', 'forced_login_method="chatgpt"', 'web_search="disabled"']) assert.ok(args.includes(entry), entry);
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only'); assert.equal(args.at(-1), '-'); assert.equal(args.some(value => /SYNTHETIC|Explain the/.test(value)), false); const mcp = args.find(value => value.startsWith('mcp_servers='));
  assert.ok(mcp.includes('enabled_tools = ' + JSON.stringify(tools))); assert.ok(mcp.includes('required = true')); assert.ok(mcp.includes('"-i"')); assert.equal(options.cwd, args[args.indexOf('-C') + 1]); assert.equal(existsSync(options.cwd), false); assert.equal(options.env.OPENAI_API_KEY, undefined); assert.equal(options.env.NODE_OPTIONS, undefined); assert.equal(options.env.BASH_ENV, undefined); assert.equal(JSON.stringify(options.env).includes('SYNTHETIC_ENV_SECRET_CANARY'), false);
});

test('invalid/accessor inputs, unsafe data root, and unsupported options fail before children or getter execution', async t => {
  const f = fixture(t); let invoked = false; const input = {}; Object.defineProperty(input, 'authorize', { enumerable: true, get() { invoked = true; return () => true; } });
  await assert.rejects(executeCodexTurn(input), { code: 'INVALID_INPUT' }); assert.equal(invoked, false);
  for (const override of [{ grantId: 'x'.repeat(36) }, { prompt: '\0' }, { onProgress: {} }, { signal: {} }]) await assert.rejects(executeCodexTurn({ ...f.input, ...override }, { factory: f.factory }), { code: 'INVALID_INPUT' });
  await assert.rejects(executeCodexTurn(f.input, { factory: f.factory, shell: true }), { code: 'INVALID_INPUT' }); chmodSync(f.dataRoot, 0o755); await assert.rejects(executeCodexTurn(f.input, { factory: f.factory }), { code: 'SCOPE_DENIED' }); chmodSync(f.dataRoot, 0o700);
  const link = join(f.parent, 'symlink-data'); symlinkSync(f.dataRoot, link); await assert.rejects(executeCodexTurn({ ...f.input, dataRoot: link }, { factory: f.factory }), { code: 'SCOPE_DENIED' }); assert.equal(f.calls.length, 0);
});

test('version/login preflights are pinned and never return raw authentication output', async t => {
  const wrong = fixture(t, { version: 'codex-cli 99.0.0\n' }); await assert.rejects(executeCodexTurn(wrong.input, { factory: wrong.factory }), { code: 'VERSION_MISMATCH' }); assert.equal(wrong.calls.length, 1);
  const api = fixture(t, { auth: 'Logged in using API key: SYNTHETIC_SECRET_CANARY\n' }); await assert.rejects(executeCodexTurn(api.input, { factory: api.factory }), error => error.code === 'AUTH_REQUIRED' && !error.message.includes('CANARY')); assert.equal(api.calls.length, 2);
  const excessive = fixture(t, { auth: 'Logged in using ChatGPT\n' + ' '.repeat(5000), authStdout: ' '.repeat(6000) }); await assert.rejects(executeCodexTurn(excessive.input, { factory: excessive.factory }), { code: 'BUDGET_EXCEEDED' }); assert.equal(excessive.calls.length, 2); assert.ok(excessive.calls.every(call => call.closed));
});

test('orphan/duplicate/mutated/out-of-order events and missing final newline cannot fabricate completion', async t => {
  const cases = [
    events => [{ type: 'turn.completed' }, ...events],
    events => [...events, events.at(-1)],
    events => { events[5].item.arguments.grant_id = randomUUID(); return events; },
    events => { events.splice(4, 1); return events; },
    events => { events.splice(2, 1); return events; },
    events => { events[6].item.id = 'item_2'; return events; },
  ];
  for (const change of cases) { const f = fixture(t); f.scenario.events = change(structuredClone(f.scenario.events)); const result = await executeCodexTurn(f.input, { factory: f.factory, timeoutMs: 5000 }); withheld(result); assert.ok(['VERSION_MISMATCH', 'SCOPE_DENIED'].includes(result.error_code)); }
  const tail = fixture(t); tail.scenario.raw = tail.scenario.events.map(event => JSON.stringify(event)).join('\n'); withheld(await executeCodexTurn(tail.input, { factory: tail.factory }), 'VERSION_MISMATCH');
  const malformed = fixture(t, { raw: '{"type":' }); withheld(await executeCodexTurn(malformed.input, { factory: malformed.factory }), 'VERSION_MISMATCH');
});

test('failed tool, forbidden native tool, wrong grant, and proposals before context withhold output', async t => {
  const bad = fixture(t); bad.scenario.events[5].item.result.isError = true; withheld(await executeCodexTurn(bad.input, { factory: bad.factory }), 'PROVIDER_FAILURE');
  const native = fixture(t); native.scenario.events.splice(4, 0, { type: 'item.started', item: { id: 'native_1', type: 'command_execution', command: 'SYNTHETIC_FORBIDDEN_COMMAND' } }); withheld(await executeCodexTurn(native.input, { factory: native.factory }), 'SCOPE_DENIED');
  const denied = fixture(t); denied.scenario.events[4].item.arguments.grant_id = randomUUID(); withheld(await executeCodexTurn(denied.input, { factory: denied.factory }), 'SCOPE_DENIED');
  const before = fixture(t); before.scenario.events.splice(4, 0, ...pair('early_proposal', 'learnbridge_propose_task', { grant_id: before.grant }, { id: randomUUID(), state: 'awaiting_review', payload_hash: 'a'.repeat(64) })); withheld(await executeCodexTurn(before.input, { factory: before.factory }), 'SCOPE_DENIED');
});

test('actual CLI pre-turn error item is safely classified without retaining its private message', async t => {
  const f = fixture(t); f.scenario.events.splice(1, 0, { type: 'item.completed', item: { id: 'host_error', type: 'error', message: 'MCP handshake startup failed. SYNTHETIC_PRIVATE_MESSAGE_CANARY' } }); const result = await executeCodexTurn(f.input, { factory: f.factory }); withheld(result, 'PROVIDER_FAILURE'); assert.equal(result.state, 'failed'); assert.deepEqual(result.host_notices, [{ stage: 'before_turn', categories: ['mcp_startup'], kind: 'unspecified', fixed_settings: [] }]); assert.equal(JSON.stringify(result).includes('CANARY'), false);
});

test('revocation and cancellation after real MCP progress withhold text and receipts', async t => {
  const revoked = fixture(t, { holdMs: 100 }); let allowed = true; const result = await executeCodexTurn({ ...revoked.input, authorize: () => allowed, onProgress: event => { if (event.tool === 'learnbridge_context' && event.state === 'finished') allowed = false; } }, { factory: revoked.factory });
  withheld(result, 'CONSENT_REQUIRED'); assert.equal(result.state, 'withheld'); assert.deepEqual(result.tool_receipts, []);
  const cancelled = fixture(t, { holdMs: 100 }), controller = new AbortController(); const interrupted = await executeCodexTurn({ ...cancelled.input, signal: controller.signal, onProgress: event => { if (event.tool === 'learnbridge_context') controller.abort(); } }, { factory: cancelled.factory });
  withheld(interrupted, 'CANCELLED'); assert.equal(interrupted.state, 'interrupted'); assert.deepEqual(interrupted.tool_receipts, []); assert.ok(cancelled.calls.every(call => call.closed));
});

test('timeout kills real SIGTERM-resistant turn and descendants before returning', async t => {
  const f = fixture(t, { hangStage: 'main', descendant: true }), result = await executeCodexTurn(f.input, { factory: f.factory, timeoutMs: 700 }); withheld(result, 'BUDGET_EXCEEDED'); assert.ok(f.calls.every(call => call.closed)); assert.equal(f.calls.at(-1).child.signalCode, 'SIGKILL');
  const pids = JSON.parse(readFileSync(f.marker, 'utf8')); assert.equal(await gone(pids.pid), true); if (process.platform !== 'win32') assert.equal(await gone(pids.descendant), true);
});

test('preflight timeout and cancellation stop actual children before launch can continue', async t => {
  const f = fixture(t, { hangStage: 'version', descendant: true }); await assert.rejects(executeCodexTurn(f.input, { factory: f.factory, timeoutMs: 200 }), { code: 'BUDGET_EXCEEDED' }); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].closed, true); const pids = JSON.parse(readFileSync(f.marker, 'utf8')); assert.equal(await gone(pids.pid), true); if (process.platform !== 'win32') assert.equal(await gone(pids.descendant), true);
  const cancelled = fixture(t, { hangStage: 'auth' }), controller = new AbortController(); const pending = executeCodexTurn({ ...cancelled.input, signal: controller.signal }, { factory: cancelled.factory }); setTimeout(() => controller.abort(), 100); await assert.rejects(pending, { code: 'CANCELLED' }); assert.ok(cancelled.calls.every(call => call.closed)); assert.equal(cancelled.calls.length, 2);
});

test('output/event/tool budgets and nonzero or incomplete exit never expose an answer', async t => {
  const output = fixture(t, { raw: 'x'.repeat(1_000_001) }); withheld(await executeCodexTurn(output.input, { factory: output.factory }), 'BUDGET_EXCEEDED');
  const stderr = fixture(t, { stderrBytes: 64001 }); withheld(await executeCodexTurn(stderr.input, { factory: stderr.factory }), 'BUDGET_EXCEEDED');
  const excessive = fixture(t); const first = excessive.scenario.events.slice(0, 6); excessive.scenario.events = [...first, ...Array.from({ length: 21 }, (_, index) => pair('repeated_' + index, 'learnbridge_context', { grant_id: excessive.grant }, { grant_id: excessive.grant, documents: [], tasks: [], source_entries: [] })).flat(), ...excessive.scenario.events.slice(6)]; withheld(await executeCodexTurn(excessive.input, { factory: excessive.factory }), 'BUDGET_EXCEEDED');
  const events = fixture(t); events.scenario.events.splice(6, 0, ...Array.from({ length: 1000 }, (_, index) => ({ type: 'item.completed', item: { id: 'reason_' + index, type: 'reasoning', text: 'Synthetic' } }))); withheld(await executeCodexTurn(events.input, { factory: events.factory }), 'BUDGET_EXCEEDED');
  const answer = fixture(t); answer.scenario.events[7].item.text = '😀'.repeat(16001); withheld(await executeCodexTurn(answer.input, { factory: answer.factory }), 'BUDGET_EXCEEDED');
  const fail = fixture(t, { exitCode: 1 }); withheld(await executeCodexTurn(fail.input, { factory: fail.factory })); const incomplete = fixture(t); incomplete.scenario.events.pop(); const result = await executeCodexTurn(incomplete.input, { factory: incomplete.factory }); withheld(result); assert.equal(result.state, 'unknown_outcome');
});

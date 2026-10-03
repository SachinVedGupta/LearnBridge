#!/usr/bin/env node
/** Live opt-in subscription gate. Only a newly created synthetic workspace is
 * disclosed. No auth file/global agent configuration is read or copied here. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, lstatSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { startRuntime, LOCAL_VERSION } from '../apps/local-runtime/src/server.mjs';

const API = '/api/local/v1';
const REPORT = fileURLToPath(new URL('../../docs/design/implementation/CODEX_HOST_VERIFICATION.json', import.meta.url));
const BRIDGE = fileURLToPath(new URL('../apps/local-runtime/src/mcp.mjs', import.meta.url));
const TOOLS = ['learnbridge_status', 'learnbridge_context', 'learnbridge_propose_task'];
const sha = value => createHash('sha256').update(value).digest('hex');
const noteText = 'SYNTHETIC ONLY: Recursion stops when its base case is reached. Explain the base case in your own words before practicing.';
const taskTitle = 'Explain the synthetic recursion base case';
const taskReason = 'Practice explaining the reviewed synthetic note in your own words.';

function hostEnvironment() {
  // Preserve the official host's normal authentication location without reading
  // it. No inherited API key, bearer token, Node injection or shell init flag.
  return Object.fromEntries(['HOME', 'PATH', 'TMPDIR', 'TEMP', 'TMP', 'CODEX_HOME', 'LANG', 'LC_ALL']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
}
function failureCategory(output) {
  if (/log.?in|not authenticated|unauthorized|authentication|401/i.test(output)) return 'host_authentication_required';
  if (/usage limit|rate limit|quota|entitlement|not supported.*account|model.*not available|429/i.test(output)) return 'host_entitlement_or_limit';
  if (/trust|approval required|requires approval|approval.*denied|not approved|permission denied/i.test(output)) return 'host_trust_or_approval_required';
  if (/MCP.*(failed|error|not available|unavailable|not exposed)|startup.*(failed|timeout)|tool.*(unavailable|not found|not available|not exposed|lack access)/i.test(output)) return 'host_mcp_startup_or_tool_failure';
  if (/MCP|tools/i.test(output) && /not.*(access|available|exposed|enabled)|aren.t|can.t|cannot|no.*access|unavailable/i.test(output)) return 'host_mcp_tools_unavailable';
  if (/unexpected argument|unknown.*(config|field)|invalid.*config|error parsing.*config/i.test(output)) return 'host_configuration_unsupported';
  return 'host_run_incomplete';
}
/** Raw host output stays bounded in memory; no transcript is written/logged. */
function runHost(args, { input, cwd, timeoutMs = 10000, onEvent } = {}) {
  return new Promise(resolve => {
    const child = spawn('codex', args, { cwd, env: hostEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const stdout = [], stderr = [], decoder = new StringDecoder('utf8'); let bytes = 0, pending = '', stopped = null, spawnError = false, malformed = false;
    const terminate = reason => {
      if (stopped) return;
      stopped = reason;
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1000);
      killTimer.unref();
    };
    let killTimer;
    const timer = setTimeout(() => terminate('host_timeout'), timeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 1_000_000) return terminate('host_output_limit');
      stdout.push(chunk); pending += decoder.write(chunk);
      if (onEvent) {
        for (;;) {
          const end = pending.indexOf('\n'); if (end === -1) break;
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          if (!line.trim()) continue;
          try { if (onEvent(JSON.parse(line)) === false) terminate('host_used_non_mcp_tool'); }
          catch { malformed = true; terminate('host_invalid_event_stream'); }
        }
      }
    });
    child.stderr.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 1_000_000) return terminate('host_output_limit');
      stderr.push(chunk);
    });
    child.on('error', () => { spawnError = true; });
    child.on('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(killTimer);
      resolve({ code, signal, stopped, spawnError, malformed,
        stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
function toolResult(item) {
  const result = item.result;
  if (!result || result.isError || item.error || item.status !== 'completed' || !Array.isArray(result.content)) return null;
  const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  try { return { value: JSON.parse(text), hash: sha(text) }; } catch { return null; }
}
function progress(phase) { process.stderr.write(JSON.stringify({ verification: 'codex_host', phase }) + '\n'); }

export async function verifyCodexHost({ timeoutMs = 120000 } = {}) {
  assert(Number.isInteger(timeoutMs) && timeoutMs >= 30000 && timeoutMs <= 180000);
  const report = { format: 'learnbridge-codex-host-verification', version: 1, checked_at: new Date().toISOString(),
    state: 'blocked', gate: 'not_run', platform: process.platform, runtime_version: LOCAL_VERSION,
    host: { version: null, authentication_mode: 'unverified', exit_code: null },
    controls: { synthetic_only: true, api_key_fallback: false, inherited_api_keys: false,
      global_config_read_by_verifier: false, auth_files_read_or_copied_by_verifier: false,
      ephemeral: true, sandbox: 'read-only', permission_bypass: false, shell_tool: false,
      memories: false, project_instructions: false, plugins: false, other_apps: false,
      registration: 'per_invocation', raw_transcript_saved: false, timeout_ms: timeoutMs, output_limit_bytes: 1000000 },
    tools: [], counts: { completed_mcp_calls: 0, successful_context_calls: 0, pending_before_review: null,
      tasks_before_review: null, tasks_after_review: null, tasks_after_repeated_review: null },
    checks: { actual_mcp_calls: false, exact_selected_note: false, unrelated_note_excluded: false,
      proposal_payload_matches: false, no_task_before_human_review: false, human_acceptance_exactly_once: false,
      restart_persistence: false, cleanup: false },
    limitations: ['One controlled synthetic Codex session on this platform; other host versions, account policies and models need their own checks.',
      'This does not verify Claude, live academic authorization, connected accounts or real student data.'],
    references: ['https://learn.chatgpt.com/docs/extend/mcp?surface=cli',
      'https://learn.chatgpt.com/docs/non-interactive-mode', 'https://learn.chatgpt.com/docs/config-file/config-reference'] };
  let parent, parentIdentity, cleanupMarker, runtime;
  try {
    const version = await runHost(['--version']);
    const match = /^codex-cli ([0-9]+\.[0-9]+\.[0-9]+)\s*$/m.exec(version.stdout);
    if (version.spawnError || !match) { report.gate = 'host_not_installed'; return report; }
    report.host.version = match[1];
    const auth = await runHost(['login', 'status']);
    if (auth.code !== 0 || !/Logged in using ChatGPT/i.test(auth.stdout + auth.stderr)) {
      report.gate = 'host_chatgpt_authentication_required'; return report;
    }
    report.host.authentication_mode = 'chatgpt_host_managed';
    parent = realpathSync(mkdtempSync(join(tmpdir(), 'learnbridge-codex-host-')));
    parentIdentity = lstatSync(parent); cleanupMarker = randomUUID();
    writeFileSync(join(parent, '.synthetic-verifier-marker'), cleanupMarker, { mode: 0o600 });
    const project = join(parent, 'project'), root = join(parent, 'data'); mkdirSync(project, { mode: 0o700 });
    runtime = await startRuntime({ dataRoot: root, port: 0 });
    const pair = await fetch(runtime.origin + API + '/pair', { method: 'POST', headers: { origin: runtime.origin, 'content-type': 'application/json' }, body: JSON.stringify({ code: runtime.createPairingCode() }) });
    assert.equal(pair.status, 200);
    const cookie = pair.headers.get('set-cookie').split(';')[0], nonce = (await pair.json()).nonce;
    const request = async (path, method = 'GET', body) => {
      const response = await fetch(runtime.origin + API + path, { method, headers: { cookie, 'x-learnbridge-nonce': nonce,
        ...(method === 'GET' ? {} : { origin: runtime.origin, 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      assert(response.ok, 'Synthetic paired HTTP operation failed.'); return response.json();
    };
    const note = await request('/documents', 'POST', { title: 'Reviewed synthetic recursion note', content: noteText });
    await request('/documents', 'POST', { title: 'UNSELECTED_SYNTHETIC_NOTE', content: 'UNSELECTED_SYNTHETIC_BODY_CANARY' });
    const granted = await request('/agent-grants', 'POST', { destination: 'codex', task_ids: [], document_ids: [note.document.id], source_entry_ids: [],
      expected_records: { tasks: [], documents: [{ id: note.document.id, revision: note.document.revision }], source_entries: [] }, max_bytes: 12000, expires_in_minutes: 10 });
    const grantId = granted.grant.id, key = randomUUID();
    const config = { command: '/usr/bin/env', args: ['-i', 'PATH=/usr/bin:/bin', process.execPath, BRIDGE,
      '--data-root', root, '--destination', 'codex'], enabled_tools: TOOLS, startup_timeout_sec: 15, tool_timeout_sec: 20 };
    const inline = `{ command = ${JSON.stringify(config.command)}, args = ${JSON.stringify(config.args)}, enabled_tools = ${JSON.stringify(TOOLS)}, startup_timeout_sec = 15, tool_timeout_sec = 20, required = true }`;
    const args = ['exec', '--ignore-user-config', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check', '--json', '--color', 'never', '-C', project,
      '-c', 'forced_login_method="chatgpt"', '-c', 'features.shell_tool=false', '-c', 'features.shell_snapshot=false', '-c', 'features.memories=false',
      '-c', 'features.plugins=false', '-c', 'features.hooks=false', '-c', 'features.multi_agent=false', '-c', 'agents.enabled=false',
      '-c', 'apps._default.enabled=false', '-c', 'project_doc_max_bytes=0', '-c', 'history.persistence="none"', '-c', 'web_search="disabled"',
      '-c', `mcp_servers.learnbridge=${inline}`, '-'];
    const prompt = `This is a disposable synthetic LearnBridge interoperability check. Use only the three LearnBridge MCP tools. If those tools are deferred, you may use built-in tool search/discovery solely to load the LearnBridge tools' schemas; discovery itself is not proof of performing the check. Do not use shell, execution, filesystem, browser, other apps, or any alternative data route. Do not read host memories/configuration/credentials. If the MCP tools are unavailable or require approval, report that and stop.\n1. Call learnbridge_status.\n2. Call learnbridge_context with grant_id ${grantId}, document_ids ["${note.document.id}"], task_ids [], source_entry_ids [], max_bytes 12000.\n3. Only if that returns the approved synthetic note, call learnbridge_propose_task with grant_id ${grantId}, title ${JSON.stringify(taskTitle)}, reason ${JSON.stringify(taskReason)}, idempotency_key ${JSON.stringify(key)}. Omit deadline and course_label.\nDo not accept the proposal or create a task. End with a short confirmation that it is awaiting human review. All content is synthetic; no external actions are authorized.\n`;
    const completed = new Map(), eventTypes = new Map(); let forbidden = false, invalidTools = false, turnCompleted = false;
    progress('starting_subscription_host');
    const run = await runHost(args, { cwd: project, input: prompt, timeoutMs, onEvent(event) {
      if (typeof event.type === 'string' && /^[a-z._]{1,60}$/.test(event.type)) eventTypes.set(event.type, (eventTypes.get(event.type) || 0) + 1);
      if (event.type === 'turn.completed') turnCompleted = true;
      const item = event.item;
      if (!item) return true;
      if (item.type === 'mcp_tool_call') {
        if (item.server !== 'learnbridge' || !TOOLS.includes(item.tool)) { invalidTools = true; return false; }
        if (event.type === 'item.completed') completed.set(item.id, item);
        return true;
      }
      if (!['agent_message', 'reasoning', 'plan', 'todo_list', 'tool_search_call', 'tool_search'].includes(item.type)) { forbidden = true; return false; }
      return true;
    } });
    report.host.exit_code = Number.isSafeInteger(run.code) ? run.code : null;
    // Event kinds contain no transcript, identities, paths or tool arguments.
    report.host.event_counts = Object.fromEntries(eventTypes);
    report.host.diagnostics = { mcp_mentioned_by_host: /learnbridge|mcp/i.test(run.stderr),
      startup_ready_mentioned: /learnbridge.*ready|ready.*learnbridge/i.test(run.stderr),
      host_warning_mentioned: /error|warning|failed/i.test(run.stderr),
      deferred_discovery_mentioned: /deferred|tool search|discover/i.test(run.stdout + run.stderr) };
    report.counts.completed_mcp_calls = completed.size;
    const calls = [...completed.values()];
    report.tools = calls.map(item => { const result = toolResult(item); return { tool: item.tool, status: result ? 'completed' : 'failed', result_sha256: result?.hash ?? null }; });
    const contexts = calls.filter(item => item.tool === 'learnbridge_context').map(toolResult).filter(Boolean);
    report.counts.successful_context_calls = contexts.length;
    const successful = TOOLS.every(tool => calls.some(item => item.tool === tool && toolResult(item)));
    if (forbidden || invalidTools || run.stopped === 'host_used_non_mcp_tool') { report.state = 'fail'; report.gate = 'host_used_non_mcp_tool'; return report; }
    if (run.stopped || run.code !== 0 || !turnCompleted || !successful) {
      report.gate = run.stopped || failureCategory(run.stdout + run.stderr); return report;
    }
    report.checks.actual_mcp_calls = true;
    const statuses = calls.filter(item => item.tool === 'learnbridge_status').map(toolResult).filter(Boolean);
    assert.equal(statuses.length, 1); assert.equal(statuses[0].value.destination, 'codex'); assert.equal(statuses[0].value.healthy, true);
    assert(statuses[0].value.grants.some(value => value.id === grantId));
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].value.grant_id, grantId);
    assert.equal(contexts[0].value.documents.length, 1);
    assert.equal(contexts[0].value.documents[0].id, note.document.id);
    assert.equal(contexts[0].value.documents[0].text, noteText);
    assert.deepEqual(contexts[0].value.tasks, []); assert.deepEqual(contexts[0].value.source_entries, []);
    report.checks.exact_selected_note = true;
    assert(!JSON.stringify(contexts[0].value).includes('UNSELECTED_SYNTHETIC'));
    report.checks.unrelated_note_excluded = true;
    const proposals = (await request('/task-proposals')).items;
    report.counts.pending_before_review = proposals.filter(value => value.state === 'awaiting_review').length;
    const before = (await request('/tasks')).items; report.counts.tasks_before_review = before.length;
    assert.equal(proposals.length, 1); assert.equal(proposals[0].state, 'awaiting_review'); assert.equal(before.length, 0);
    const proposal = proposals[0];
    const hostProposals = calls.filter(item => item.tool === 'learnbridge_propose_task').map(toolResult).filter(Boolean);
    assert.equal(hostProposals.length, 1); assert.equal(hostProposals[0].value.id, proposal.id); assert.equal(hostProposals[0].value.payload_hash, proposal.payload_hash);
    assert.equal(proposal.destination, 'codex'); assert.equal(proposal.grant_id, grantId);
    assert.equal(proposal.payload.title, taskTitle); assert.equal(proposal.payload.reason, taskReason);
    report.checks.proposal_payload_matches = true; report.checks.no_task_before_human_review = true;
    progress('independently_reviewing_synthetic_proposal');
    const review = { expected_revision: proposal.revision, payload_hash: proposal.payload_hash };
    const accepted = await request(`/task-proposals/${proposal.id}/accept`, 'POST', review);
    const after = (await request('/tasks')).items; report.counts.tasks_after_review = after.length;
    const retry = await request(`/task-proposals/${proposal.id}/accept`, 'POST', review);
    const repeated = (await request('/tasks')).items; report.counts.tasks_after_repeated_review = repeated.length;
    assert.equal(after.length, 1); assert.equal(repeated.length, 1); assert.equal(accepted.task.id, retry.task.id);
    assert.equal(after[0].id, accepted.task.id); assert.equal(after[0].origin, 'agent_reviewed'); assert.equal(after[0].title, taskTitle);
    report.checks.human_acceptance_exactly_once = true;
    await runtime.close(); runtime = await startRuntime({ dataRoot: root, port: 0 });
    const newPair = await fetch(runtime.origin + API + '/pair', { method: 'POST', headers: { origin: runtime.origin, 'content-type': 'application/json' }, body: JSON.stringify({ code: runtime.createPairingCode() }) });
    assert.equal(newPair.status, 200);
    const restartedSession = await newPair.json();
    const restarted = await fetch(runtime.origin + API + '/tasks', { headers: { cookie: newPair.headers.get('set-cookie').split(';')[0], 'x-learnbridge-nonce': restartedSession.nonce } });
    assert.equal(restarted.status, 200); const restoredTasks = (await restarted.json()).items;
    assert.equal(restoredTasks.length, 1); assert.equal(restoredTasks[0].id, accepted.task.id);
    report.checks.restart_persistence = true; report.state = 'pass'; report.gate = 'verified';
  } catch {
    report.state = 'fail'; report.gate = 'independent_assertion_or_harness_failure';
  } finally {
    try { await runtime?.close(); } catch { report.state = 'fail'; report.gate = 'runtime_cleanup_failure'; }
    if (parent) {
      try {
        const current = lstatSync(parent);
        assert.equal(current.dev, parentIdentity.dev); assert.equal(current.ino, parentIdentity.ino);
        assert.equal(readFileSync(join(parent, '.synthetic-verifier-marker'), 'utf8'), cleanupMarker);
        rmSync(parent, { recursive: true, force: true }); report.checks.cleanup = true;
      } catch { report.state = 'fail'; report.gate = 'synthetic_cleanup_failure'; }
    } else report.checks.cleanup = true;
  }
  return report;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--timeout-ms')) throw new Error('Use --timeout-ms with a bounded duration.');
  const report = await verifyCodexHost({ timeoutMs: args.length ? Number(args[1]) : 120000 });
  writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ state: report.state, gate: report.gate, host_version: report.host.version,
    completed_mcp_calls: report.counts.completed_mcp_calls, checks: report.checks }) + '\n');
  process.exitCode = report.state === 'pass' ? 0 : report.state === 'blocked' ? 2 : 1;
}

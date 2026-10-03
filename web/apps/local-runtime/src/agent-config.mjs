import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, lstatSync, realpathSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const START = '# BEGIN LearnBridge managed MCP';
const END = '# END LearnBridge managed MCP';
const digest = value => createHash('sha256').update(value).digest('hex');
const entry = fileURLToPath(new URL('./mcp.mjs', import.meta.url));
function fail(message) { throw new Error(message); }
function assertFile(path) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256000) fail('Agent configuration is unsafe or too large.');
}
function hostConfig(dataRoot, destination) {
  if (!['darwin', 'linux'].includes(process.platform)) fail('Project MCP registration is unavailable on this platform.');
  // Clear inherited API credentials and Node injection flags. No host auth is copied.
  return { command: '/usr/bin/env', args: ['-i', 'PATH=/usr/bin:/bin', process.execPath, entry,
    '--data-root', resolve(dataRoot), '--destination', destination] };
}
/** Preview only. Never updates user-global Codex or Claude settings. */
export function previewAgentConfig({ projectRoot, dataRoot, destination }) {
  if (!['codex', 'claude'].includes(destination) || typeof dataRoot !== 'string') fail('Choose an agent and a local workspace.');
  projectRoot = realpathSync(resolve(projectRoot));
  const config = hostConfig(dataRoot, destination);
  const parent = destination === 'codex' ? join(projectRoot, '.codex') : projectRoot;
  if (existsSync(parent) && (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink())) fail('Project configuration directory is unsafe.');
  const path = join(parent, destination === 'codex' ? 'config.toml' : '.mcp.json');
  assertFile(path);
  const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
  let content, managedContent;
  if (destination === 'codex') {
    let rest = before;
    if (before.includes('"""') || before.includes("'''")) fail('Multiline TOML strings need a manual reviewed MCP merge.');
    const start = before.indexOf(START), end = before.indexOf(END);
    if ((start === -1) !== (end === -1) || (start !== -1 && (end < start || before.indexOf(START, start + 1) !== -1 || before.indexOf(END, end + 1) !== -1))) fail('Ambiguous managed Codex configuration.');
    if (start !== -1) {
      if ((start !== 0 && before[start - 1] !== '\n') || before[start + START.length] !== '\n'
        || (end !== 0 && before[end - 1] !== '\n') || !['', '\n', '\r'].includes(before[end + END.length] || '')) fail('Managed markers must occupy whole lines.');
      rest = before.slice(0, start) + before.slice(end + END.length).replace(/^\r?\n/, '');
    }
    if (/^\s*\[\[?\s*(?:["']?mcp_servers["']?)\s*\.\s*["']?learnbridge["']?\s*(?:\.|\])/m.test(rest)
      || /^\s*(?:mcp_servers|"mcp_servers"|'mcp_servers'|learnbridge|"learnbridge"|'learnbridge')\s*=/m.test(rest)) fail('An unmanaged LearnBridge or inline MCP configuration already exists. Review it manually.');
    const block = `${START}\n[mcp_servers.learnbridge]\ncommand = ${JSON.stringify(config.command)}\nargs = ${JSON.stringify(config.args)}\nenabled_tools = ["learnbridge_status", "learnbridge_context", "learnbridge_propose_task", "learnbridge_propose_document"]\nstartup_timeout_sec = 15\ntool_timeout_sec = 20\n${END}\n`;
    managedContent = block;
    content = rest + (rest && !rest.endsWith('\n') ? '\n' : '') + block;
  } else {
    let json;
    try { json = before ? JSON.parse(before) : {}; } catch { fail('Claude project configuration must be valid JSON.'); }
    if (!json || Array.isArray(json) || typeof json !== 'object' || (json.mcpServers && (typeof json.mcpServers !== 'object' || Array.isArray(json.mcpServers)))) fail('Invalid Claude project configuration shape.');
    const existing = json.mcpServers?.learnbridge;
    // Ownership requires the exact fixed launcher and bridge entry, not a spoofable custom flag.
    if (existing && !(existing.command === '/usr/bin/env' && Array.isArray(existing.args)
      && existing.args[0] === '-i' && existing.args[3] === entry && existing.type === 'stdio')) fail('An unmanaged Claude LearnBridge configuration already exists. Review it manually.');
    json.mcpServers = { ...json.mcpServers, learnbridge: { type: 'stdio', ...config } };
    managedContent = JSON.stringify({ mcpServers: { learnbridge: json.mcpServers.learnbridge } }, null, 2);
    content = JSON.stringify(json, null, 2) + '\n';
  }
  return { destination, project_root: projectRoot, path, expected_sha256: digest(before), content_sha256: digest(content), content, managed_content: managedContent,
    notice: 'This starts a local stdio bridge. The host still requires its normal project trust and MCP approval. Only dashboard-approved selections can be read.' };
}
/** Explicit human launcher commit with optimistic concurrency and atomic replacement. */
export function applyAgentConfig(preview) {
  const parent = dirname(preview.path);
  if (!existsSync(parent)) mkdirSync(parent, { mode: 0o700 });
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) fail('Project configuration directory is unsafe.');
  assertFile(preview.path);
  const before = existsSync(preview.path) ? readFileSync(preview.path, 'utf8') : '';
  if (digest(before) !== preview.expected_sha256 || digest(preview.content) !== preview.content_sha256) fail('Agent configuration changed since preview. Preview again.');
  const temporary = join(parent, '.learnbridge-config-' + randomUUID());
  try {
    writeFileSync(temporary, preview.content, { mode: 0o600, flag: 'wx' });
    const current = lstatSync(parent);
    assertFile(preview.path);
    if (current.dev !== parentStat.dev || current.ino !== parentStat.ino
      || digest(existsSync(preview.path) ? readFileSync(preview.path, 'utf8') : '') !== preview.expected_sha256) fail('Agent configuration changed before saving.');
    renameSync(temporary, preview.path);
    if (digest(readFileSync(preview.path)) !== preview.content_sha256) fail('Saved configuration could not be verified.');
  } finally { try { unlinkSync(temporary); } catch {} }
  return { destination: preview.destination, saved: true, verified: true, content_sha256: preview.content_sha256 };
}

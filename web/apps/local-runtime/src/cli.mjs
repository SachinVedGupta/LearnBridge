#!/usr/bin/env node
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, realpathSync, lstatSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalStore } from '@learnbridge/local-storage';
import { LearnBridgeError } from '@learnbridge/core';
import { startRuntime, LOCAL_VERSION } from './server.mjs';
import { readControl, requestControl } from './ipc.mjs';
import { previewAgentConfig, applyAgentConfig } from './agent-config.mjs';
import { probeSourceCapability } from '../../../packages/local-sources/src/index.mjs';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const print = value => process.stdout.write(JSON.stringify(value) + '\n');
function defaultRoot() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'LearnBridge');
  if (process.platform === 'linux') return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'learnbridge');
  throw new Error('Private local storage is not supported on this platform yet.');
}
function options(args) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--json') continue;
    if (!['--data-root', '--port', '--output', '--backup-root', '--destination', '--project-root', '--expected-sha256'].includes(key)
      || Object.hasOwn(result, key) || !args[index + 1] || args[index + 1].startsWith('--')) {
      throw new Error('Invalid local launcher arguments.');
    }
    result[key] = args[++index];
  }
  return result;
}
function assertOptions(config, allowed) {
  if (Object.keys(config).some(key => !allowed.includes(key))) throw new Error('Unsupported local launcher option.');
}
const rootPath = config => resolve(config['--data-root'] || defaultRoot());
const initializedRoot = root => existsSync(root) && existsSync(join(root, '.learnbridge-local-root'));
function activeControl(root) {
  const control = readControl(root);
  if (!control) return null;
  try { process.kill(control.pid, 0); return control; }
  catch (error) {
    // Only a definitively dead owner permits offline storage access. A reused
    // live PID, EPERM, malformed metadata or other uncertainty fails closed.
    if (error.code === 'ESRCH') return null;
    throw error;
  }
}
function offlineStatus(root, { initialize = false } = {}) {
  if (!initialize && !initializedRoot(root)) return { edition: 'local', version: LOCAL_VERSION, initialized: false, integrity: false, state: 'requires_setup' };
  const store = LocalStore.open({ root, repositoryRoot, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
  try {
    const checked = store.integrity();
    return { edition: 'local', version: LOCAL_VERSION, initialized: true, integrity: checked.integrity === 'ok', student_id: store.identity.student_id,
      capabilities: { tasks: 'available', notes: 'available', mcp: 'requires_runtime_and_host', sources: 'requires_selected_source', cloud: 'requires_reviewed_consent' } };
  } finally { store.close(); }
}
async function stop(root) {
  if (!initializedRoot(root)) return { stopped: true, was_running: false };
  const control = activeControl(root);
  if (!control) return { stopped: true, was_running: false };
  await requestControl(root, 'stop');
  for (let attempt = 0; attempt < 100; attempt++) {
    await delay(50);
    if (!readControl(root)) return { stopped: true, was_running: true };
  }
  throw new Error('The local runtime did not finish stopping.');
}
async function serve(root, port, { syntheticDemo = false } = {}) {
  if (syntheticDemo) {
    const store = LocalStore.open({ root, repositoryRoot, timezone: 'America/Toronto' });
    try {
      store.createTask({ title: 'Review the sample recursion note', deadline: { precision: 'date', date: '2026-10-15', timezone: 'America/Toronto' } });
      store.createTask({ title: 'Plan the next study block' });
      store.createDocument({ title: 'Sample study note', text: '# Recursion\n\nA recursive solution reduces a problem to a smaller instance.\n\nTry explaining the base case in your own words.\n', kind: 'study' });
    } finally { store.close(); }
  }
  const runtime = await startRuntime({ dataRoot: root, port });
  const shutdown = () => { void runtime.close().catch(() => { process.exitCode = 1; }); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Only an explicit human launcher prints the temporary pairing code. The
  // library, diagnostics, errors, metadata files and HTTP health never do.
  print({ event: 'ready', edition: 'local', origin: runtime.origin, pairing_code: runtime.createPairingCode(), data_root: runtime.dataRoot, synthetic_demo: syntheticDemo });
  try { await runtime.closed; }
  finally { process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown); }
  print({ event: 'stopped', edition: 'local' });
}

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (!['darwin', 'linux'].includes(process.platform) && command !== 'help') throw new Error('Private local storage is unavailable on this platform.');
  const config = options(args);
  if (command === 'help' || command === '--help') {
    assertOptions(config, []);
    return print({ product: 'LearnBridge local', commands: ['setup', 'start', 'doctor', 'stop', 'backup', 'restore', 'uninstall', 'demo', 'agent-config'],
      usage: 'node web/apps/local-runtime/src/cli.mjs <command> [--data-root <absolute path>] [--json]',
      backup: 'backup --output <new directory>', restore: 'restore --backup-root <backup directory> --data-root <new workspace>',
      support: 'Verified macOS arm64; Linux experimental; Windows private ACLs unavailable. MCP requires host trust and selected sharing; local sources require .venv Python with directory-FD support.' });
  }
  if (command === 'agent-config') {
    assertOptions(config, ['--data-root', '--destination', '--project-root', '--expected-sha256']);
    const preview = previewAgentConfig({ projectRoot: config['--project-root'] || repositoryRoot, dataRoot: rootPath(config), destination: config['--destination'] });
    if (!config['--expected-sha256']) {
      // Existing unrelated server settings can contain secrets. Print only our
      // newly generated entry and hashes; the complete merge stays in memory.
      const { content, ...safePreview } = preview;
      return print(safePreview);
    }
    if (config['--expected-sha256'] !== preview.expected_sha256) throw new Error('Configuration changed since preview.');
    return print(applyAgentConfig(preview));
  }
  if (command === 'demo') {
    assertOptions(config, ['--port']);
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'learnbridge-dashboard-demo-')));
    const marker = randomUUID();
    const identity = lstatSync(parent);
    writeFileSync(join(parent, '.synthetic-demo-marker'), marker, { mode: 0o600, flag: 'wx' });
    try { await serve(join(parent, 'workspace'), Number(config['--port'] || 3210), { syntheticDemo: true }); }
    finally {
      const current = lstatSync(parent);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino
        || readFileSync(join(parent, '.synthetic-demo-marker'), 'utf8') !== marker) throw new Error('Synthetic demo cleanup requires inspection.');
      rmSync(parent, { recursive: true });
    }
    return;
  }
  if (!['setup', 'start', 'doctor', 'stop', 'backup', 'restore', 'uninstall'].includes(command)) throw new Error('Unknown local launcher command.');
  const root = rootPath(config);
  if (command === 'setup') { assertOptions(config, ['--data-root']); return print(offlineStatus(root, { initialize: true })); }
  if (command === 'start') { assertOptions(config, ['--data-root', '--port']); return serve(root, Number(config['--port'] || 3210)); }
  if (command === 'doctor') {
    assertOptions(config, ['--data-root']);
    let report;
    if (initializedRoot(root) && activeControl(root)) report = await requestControl(root, 'status');
    else report = offlineStatus(root);
    print({ ...report, source_runtime: await probeSourceCapability() });
    if (!report.integrity) process.exitCode = 1;
    return;
  }
  if (command === 'stop' || command === 'uninstall') {
    assertOptions(config, ['--data-root']);
    const result = await stop(root);
    return print({ ...result, ...(command === 'uninstall' ? { data_retained: true, note: 'Private data and unrelated files are retained. This command stops the local installation; it does not remove the repository.' } : {}) });
  }
  if (command === 'backup') {
    assertOptions(config, ['--data-root', '--output']);
    if (!config['--output'] || !initializedRoot(root)) throw new Error('Backup needs an initialized workspace and a new output directory.');
    const output = resolve(config['--output']);
    let manifest;
    if (activeControl(root)) manifest = await requestControl(root, 'backup', { output });
    else {
      const store = LocalStore.open({ root, repositoryRoot });
      try { manifest = await store.backup(output); } finally { store.close(); }
    }
    return print({ status: 'backed_up', verified: true, database_sha256: manifest.database.sha256 });
  }
  if (command === 'restore') {
    assertOptions(config, ['--data-root', '--backup-root']);
    if (!config['--data-root'] || !config['--backup-root']) throw new Error('Restore needs a selected backup and a new workspace directory.');
    const result = await LocalStore.restore({ backupRoot: resolve(config['--backup-root']), root, repositoryRoot });
    return print({ ...result, verified: result.integrity === 'ok' });
  }
}

try { await main(); }
catch (error) {
  print({ status: 'FAIL', code: error instanceof LearnBridgeError ? error.code : 'LOCAL_OPERATION_FAILED',
    message: error instanceof LearnBridgeError ? error.message : 'The local operation could not be completed. Check command options, workspace ownership and whether another runtime is active.' });
  process.exitCode = 1;
}

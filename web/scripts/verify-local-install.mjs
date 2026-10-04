import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Clean-copy install proof, not a real-machine installer. Only these reviewed
// manifests/source files are copied; no directory recursion, Git metadata,
// environment file, previous node_modules or student data is copied.
const ALLOWLIST = Object.freeze([
  'package.json', 'web/package.json', 'web/package-lock.json',
  'web/apps/api/package.json', 'web/apps/web/package.json', 'web/packages/shared/package.json',
  'web/packages/core/package.json', 'web/packages/local-storage/package.json',
  'web/packages/local-sources/package.json', 'web/packages/local-academic/package.json',
  'web/apps/local-runtime/package.json', 'web/apps/local/package.json',
  'web/packages/core/src/index.mjs', 'web/packages/core/src/contracts.mjs',
  'web/packages/core/src/errors.mjs', 'web/packages/core/src/legacy-state.mjs',
  'web/packages/core/src/ports.mjs', 'web/packages/core/src/ports.d.mts',
  'web/packages/local-storage/src/index.mjs',
  'web/packages/local-storage/src/pdf-provenance.mjs',
  'web/packages/local-storage/src/office-provenance.mjs',
  'web/apps/local-runtime/src/server.mjs', 'web/apps/local-runtime/src/cli.mjs',
  'web/apps/local-runtime/src/policy.mjs', 'web/apps/local-runtime/src/ipc.mjs',
  'web/apps/local-runtime/src/agent-config.mjs', 'web/apps/local-runtime/src/mcp.mjs',
  'web/apps/local-runtime/src/profile.mjs', 'web/apps/local-runtime/src/workflows.mjs',
  'web/apps/local-runtime/src/student-workspace.mjs', 'web/apps/local-runtime/src/host-turns.mjs',
  'web/apps/local-runtime/src/codex-exec.mjs', 'web/apps/local-runtime/src/learning-service.mjs',
  'web/apps/local-runtime/src/learning-routes.mjs', 'web/apps/local-runtime/src/career.mjs',
  'web/apps/local-runtime/src/career-service.mjs', 'web/apps/local-runtime/src/career-routes.mjs',
  'web/apps/local-runtime/src/life.mjs', 'web/apps/local-runtime/src/life-service.mjs',
  'web/apps/local-runtime/src/life-routes.mjs', 'web/apps/local-runtime/src/writing-service.mjs',
  'web/apps/local-runtime/src/writing-routes.mjs', 'web/apps/local-runtime/src/research-service.mjs',
  'web/apps/local-runtime/src/research-routes.mjs', 'web/apps/local-runtime/src/productivity-service.mjs',
  'web/apps/local-runtime/src/productivity-routes.mjs',
  'web/apps/local-runtime/src/onboarding.mjs', 'web/apps/local-runtime/src/onboarding-routes.mjs',
  'web/packages/local-sources/src/index.mjs',
  'web/packages/local-sources/src/pdf-native.mjs', 'web/packages/local-sources/src/pdf-text.swift',
  'web/packages/local-sources/src/office-native.mjs', 'web/packages/local-sources/src/office-text.py',
  'web/packages/local-academic/src/index.mjs',
  'web/packages/local-academic/src/library.mjs', 'web/packages/local-academic/src/refresh.mjs', 'web/packages/local-academic/src/planning.mjs',
  'web/packages/local-academic/src/tutoring.mjs',
  'web/apps/local/build.mjs', 'web/apps/local/public/index.html',
  'web/apps/local/public/app.js', 'web/apps/local/public/styles.css',
  'web/apps/local/public/career.js', 'web/apps/local/public/learning.js',
  'web/apps/local/public/life.js', 'web/apps/local/public/writing.js',
  'web/apps/local/public/research.js', 'web/apps/local/public/productivity.js',
  'web/apps/local/public/onboarding.js',
]);
const PREFIX = 'learnbridge-clean-install-fixture-';
const SOURCE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const CHILD_ENV = Object.freeze({ TZ: 'UTC', ...(process.env.PATH ? { PATH: process.env.PATH } : {}) });
const phases = [];
const report = {
  schema_version: 1,
  suite: 'local-clean-copy-offline-install-v1',
  evidence_type: 'synthetic_fixture',
  status: 'FAIL',
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  scope: {
    copied_previous_node_modules: false, copied_environment_files: false,
    copied_personal_data: false, cloud_configuration_supplied: false,
    offline_cache_used: true, package_lifecycle_hooks_disabled: true,
  },
  phases,
  limitations: [
    'A clean disposable source copy installed from the existing offline npm cache; not a new computer or an online-download test.',
    'Only this recorded OS, architecture and Node runtime were exercised.',
    'Task/note persistence, static build, CLI lifecycle and actual SDK stdio discovery; real hosts, provider OAuth and personal onboarding are separate gates.',
    'No fresh Python environment is copied or installed; selected-file acquisition requires a suitable project .venv and is verified separately.',
  ],
};
let parent;
let parentIdentity;
let marker;

class VerificationFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new VerificationFailure(code); };

async function phase(id, action) {
  const started = Date.now();
  const item = { id, status: 'FAIL' };
  phases.push(item);
  try {
    const result = await action();
    item.status = 'PASS';
    item.duration_ms = Date.now() - started;
    return result;
  } catch (error) {
    item.code = error instanceof VerificationFailure ? error.code : 'VERIFICATION_ASSERTION_FAILED';
    item.duration_ms = Date.now() - started;
    throw error;
  }
}

function child(command, args, { cwd, env = CHILD_ENV, timeoutMs = 15_000, maxBytes = 2_000_000, kind = 'node' } = {}) {
  return new Promise((resolveChild, rejectChild) => {
    const processChild = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let killedFor = null;
    const timer = setTimeout(() => { killedFor = 'CHILD_TIMEOUT'; processChild.kill('SIGKILL'); }, timeoutMs);
    const collect = (which, chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) { killedFor = 'CHILD_OUTPUT_LIMIT'; processChild.kill('SIGKILL'); return; }
      if (which === 'stdout') stdout += chunk.toString();
      else stderr += chunk.toString();
    };
    processChild.stdout.on('data', chunk => collect('stdout', chunk));
    processChild.stderr.on('data', chunk => collect('stderr', chunk));
    processChild.on('error', () => { clearTimeout(timer); rejectChild(new VerificationFailure('CHILD_START_FAILED')); });
    processChild.on('close', code => {
      clearTimeout(timer);
      if (killedFor) return rejectChild(new VerificationFailure(killedFor));
      if (code !== 0) {
        // Do not forward npm errors, child stacks or raw fixture paths. Missing
        // cache is an explicit blocker; no network fallback is attempted.
        const reason = kind === 'npm' && /\bENOTCACHED\b|cache mode is ['"]only-if-cached['"]/i.test(stdout + stderr)
          ? 'OFFLINE_CACHE_UNAVAILABLE' : kind === 'npm' ? 'OFFLINE_INSTALL_FAILED' : 'CHILD_VERIFICATION_FAILED';
        return rejectChild(new VerificationFailure(reason));
      }
      resolveChild({ stdout, stderr });
    });
  });
}

async function jsonChild(command, args, options) {
  const result = await child(command, args, options);
  try { return JSON.parse(result.stdout.trim()); } catch { fail('INVALID_CHILD_REPORT'); }
}

async function inventory(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const ref = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isSymbolicLink()) fail('UNEXPECTED_COPY_SYMLINK');
    if (entry.isDirectory()) result.push(...await inventory(join(root, entry.name), ref));
    else if (entry.isFile()) result.push(ref);
    else fail('UNEXPECTED_COPY_TYPE');
  }
  return result.sort();
}

async function main() {
  if (process.argv.length !== 2) fail('ARGUMENTS_NOT_SUPPORTED');
  if (!['darwin', 'linux'].includes(process.platform)) fail('UNSUPPORTED_PERMISSION_PLATFORM');
  parent = await realpath(await mkdtemp(join(tmpdir(), PREFIX)));
  await chmod(parent, 0o700);
  parentIdentity = await lstat(parent);
  marker = randomUUID();
  await writeFile(join(parent, '.clean-install-fixture'), marker, { mode: 0o600, flag: 'wx' });
  const checkout = join(parent, 'checkout');
  const copiedWeb = join(checkout, 'web');
  const dataRoot = join(parent, 'workspace');
  const backupRoot = join(parent, 'backup');
  const restoreRoot = join(parent, 'restored');

  await phase('FI01_EXPLICIT_CLEAN_SOURCE_COPY', async () => {
    const hashes = [];
    for (const ref of ALLOWLIST) {
      assert(!ref.includes('..') && !ref.includes('.env') && !ref.includes('node_modules'));
      const source = join(SOURCE_ROOT, ref);
      const stat = await lstat(source);
      assert(stat.isFile() && !stat.isSymbolicLink());
      assert(stat.size <= 2_000_000);
      const bytes = await readFile(source);
      hashes.push(ref + '\0' + digest(bytes));
      const target = join(checkout, ref);
      await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 });
      await copyFile(source, target);
      await chmod(target, 0o600);
      assert.equal(digest(await readFile(target)), digest(bytes));
    }
    assert.deepEqual(await inventory(checkout), [...ALLOWLIST].sort());
    const lock = JSON.parse(await readFile(join(copiedWeb, 'package-lock.json'), 'utf8'));
    const workspaceRefs = Object.keys(lock.packages).filter(ref => /^(apps|packages)\/[^/]+$/.test(ref)).sort();
    const manifestRefs = ALLOWLIST.filter(ref => /^web\/(apps|packages)\/[^/]+\/package\.json$/.test(ref)).map(ref => ref.slice(4, -13)).sort();
    assert.deepEqual(manifestRefs, workspaceRefs, 'New workspaces need an explicit reviewed allowlist update.');
    report.source = { file_count: ALLOWLIST.length, source_digest: digest(hashes.join('\n')), lock_sha256: digest(await readFile(join(copiedWeb, 'package-lock.json'))) };
  });

  await phase('FI02_FRESH_LOCKED_OFFLINE_INSTALL', async () => {
    const userConfig = join(parent, 'user.npmrc');
    const globalConfig = join(parent, 'global.npmrc');
    await writeFile(userConfig, '', { mode: 0o600, flag: 'wx' });
    await writeFile(globalConfig, '', { mode: 0o600, flag: 'wx' });
    const npmEnv = { ...CHILD_ENV,
      npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig,
      npm_config_cache: resolve(process.env.npm_config_cache || process.env.NPM_CONFIG_CACHE || join(homedir(), '.npm')),
      npm_config_logs_dir: join(parent, 'npm-logs'),
      npm_config_offline: 'true', npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false',
    };
    await child('npm', ['ci', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], { cwd: copiedWeb, env: npmEnv, timeoutMs: 45_000, kind: 'npm' });
    assert((await lstat(join(copiedWeb, 'node_modules'))).isDirectory());
    assert.equal(digest(await readFile(join(copiedWeb, 'package-lock.json'))), report.source.lock_sha256);
    const runtime = await jsonChild(process.execPath, ['--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      import Database from 'better-sqlite3';
      import {realpathSync,readFileSync} from 'node:fs';
      import {fileURLToPath} from 'node:url';
      const installed = realpathSync(fileURLToPath(import.meta.resolve('better-sqlite3')));
      assert(installed.startsWith(${JSON.stringify(join(copiedWeb, 'node_modules') + '/')}));
      const pkg = JSON.parse(readFileSync(new URL('./node_modules/better-sqlite3/package.json', import.meta.url),'utf8'));
      assert.equal(pkg.version,'13.0.3');
      const db=new Database(':memory:');
      try { process.stdout.write(JSON.stringify({node:process.version,driver:pkg.version,sqlite:db.prepare('SELECT sqlite_version() AS version').get().version})); }
      finally { db.close(); }
    `], { cwd: copiedWeb });
    report.environment = { ...report.environment, installed_driver: runtime.driver, sqlite: runtime.sqlite, child_node: runtime.node };
  });

  await phase('FI03_BUILD_STATIC_DASHBOARD', async () => {
    await child(process.execPath, [join(copiedWeb, 'apps/local/build.mjs')], { cwd: checkout });
    for (const name of ['index.html', 'app.js', 'styles.css', 'career.js', 'learning.js', 'life.js', 'writing.js', 'research.js', 'productivity.js', 'onboarding.js']) {
      assert.equal(digest(await readFile(join(copiedWeb, 'apps/local/dist', name))), digest(await readFile(join(copiedWeb, 'apps/local/public', name))));
    }
    assert.deepEqual(await inventory(join(copiedWeb, 'apps/local/dist')), ['app.js', 'career.js', 'index.html', 'learning.js', 'life.js', 'onboarding.js', 'productivity.js', 'research.js', 'styles.css', 'writing.js']);
  });

  const cli = join(copiedWeb, 'apps/local-runtime/src/cli.mjs');
  const cliJson = args => jsonChild(process.execPath, [cli, ...args, '--json'], { cwd: checkout });
  await phase('FI04_CLOUD_FREE_SETUP_AND_DOCTOR', async () => {
    const setup = await cliJson(['setup', '--data-root', dataRoot]);
    const doctor = await cliJson(['doctor', '--data-root', dataRoot]);
    assert.equal(setup.edition, 'local');
    assert.equal(setup.integrity, true);
    assert.equal(doctor.integrity, true);
    assert.equal(doctor.student_id, setup.student_id);
    assert.equal((await lstat(dataRoot)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(dataRoot, 'learnbridge.sqlite'))).mode & 0o777, 0o600);
    assert.equal(Object.keys(CHILD_ENV).some(key => /token|secret|password|api_key/i.test(key)), false);
  });

  const storageUrl = pathToFileURL(join(copiedWeb, 'packages/local-storage/src/index.mjs')).href;
  const content = '# Clean install fixture\n\nExact Unicode: λ, résumé and 🧠.\n';
  const expected = await phase('FI05_NEW_PROCESS_CREATES_SYNTHETIC_RECORDS', async () => jsonChild(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import {createHash} from 'node:crypto';
    import {LocalStore} from ${JSON.stringify(storageUrl)};
    const store=LocalStore.open({root:${JSON.stringify(dataRoot)},repositoryRoot:${JSON.stringify(checkout)}});
    try {
      assert.deepEqual(store.listTasks(),[]); assert.deepEqual(store.listDocuments(),[]);
      const task=store.createTask({title:'Synthetic clean-install task',deadline:{precision:'date',date:'2026-10-20',timezone:'America/Toronto'}});
      const note=store.createDocument({title:'Synthetic clean-install note',text:${JSON.stringify(content)},kind:'study'});
      assert.equal(note.sha256,createHash('sha256').update(note.text).digest('hex'));
      assert.equal(store.integrity().integrity,'ok');
      process.stdout.write(JSON.stringify({task,note,student_id:store.identity.student_id}));
    } finally {store.close();}
  `], { cwd: copiedWeb }));

  const readBack = async root => jsonChild(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import {createHash} from 'node:crypto';
    import {LocalStore} from ${JSON.stringify(storageUrl)};
    const expected=${JSON.stringify(expected)};
    const store=LocalStore.open({root:${JSON.stringify(root)},repositoryRoot:${JSON.stringify(checkout)}});
    try {
      assert.deepEqual(store.listTasks(),[expected.task]);
      assert.deepEqual(store.getTask(expected.task.id),expected.task);
      assert.deepEqual(store.listDocuments(),[expected.note.document]);
      assert.deepEqual(store.getDocument(expected.note.document.id),expected.note);
      assert.equal(store.identity.student_id,expected.student_id);
      assert.equal(createHash('sha256').update(expected.note.text).digest('hex'),expected.note.sha256);
      assert.equal(store.integrity().integrity,'ok');
      process.stdout.write(JSON.stringify({verified:true,tasks:1,documents:1,content_sha256:expected.note.sha256}));
    } finally {store.close();}
  `], { cwd: copiedWeb });

  const saved = await phase('FI06_FRESH_PROCESS_READS_EXACT_SAVED_RECORDS', async () => readBack(dataRoot));
  assert.equal(saved.verified, true);
  await phase('FI07_CLI_BACKUP_AND_FRESH_ROOT_RESTORE', async () => {
    const backup = await cliJson(['backup', '--data-root', dataRoot, '--output', backupRoot]);
    assert.equal(backup.verified, true);
    assert.equal(backup.status, 'backed_up');
    const restored = await cliJson(['restore', '--backup-root', backupRoot, '--data-root', restoreRoot]);
    assert.equal(restored.verified, true);
    assert.equal(restored.integrity, 'ok');
  });
  const restored = await phase('FI08_INDEPENDENT_PROCESS_VERIFIES_RESTORED_RECORDS', async () => readBack(restoreRoot));
  assert.deepEqual(restored, saved);
  await phase('FI09_FRESH_OFFICIAL_SDK_STDIO_DISCOVERY', async () => {
    const result = await jsonChild(process.execPath, ['--input-type=module', '--eval', `
      import {Client} from '@modelcontextprotocol/client';
      import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
      const client=new Client({name:'clean-install-synthetic-verifier',version:'1'});
      const transport=new StdioClientTransport({command:'/usr/bin/env',args:['-i','PATH=/usr/bin:/bin',process.execPath,${JSON.stringify(join(copiedWeb, 'apps/local-runtime/src/mcp.mjs'))},'--data-root',${JSON.stringify(dataRoot)},'--destination','codex'],stderr:'pipe'});
      try { await client.connect(transport); process.stdout.write(JSON.stringify({tools:(await client.listTools()).tools.map(value=>value.name).sort()})); }
      finally { await client.close(); }
    `], { cwd: copiedWeb });
    assert.deepEqual(result.tools, ['learnbridge_context', 'learnbridge_propose_document', 'learnbridge_propose_task', 'learnbridge_status']);
  });
  report.observed = { tasks: 1, documents: 1, document_content_sha256: saved.content_sha256,
    exact_records_survive_new_process: true, exact_records_survive_fresh_root_restore: true,
    static_assets_built_and_hash_matched: 10 };
  report.status = 'PASS';
}

try { await main(); }
catch (error) {
  report.status = 'FAIL';
  report.code = error instanceof VerificationFailure ? error.code : 'VERIFICATION_ASSERTION_FAILED';
  if (report.code === 'OFFLINE_CACHE_UNAVAILABLE') report.limitations.push('Required package tarballs were unavailable in the offline cache; no online fallback was attempted.');
} finally {
  if (parent) {
    try {
      assert.equal(basename(parent).startsWith(PREFIX), true);
      assert.equal(await realpath(parent), parent);
      const current = await lstat(parent);
      assert(current.isDirectory() && !current.isSymbolicLink());
      assert.equal(current.dev, parentIdentity.dev); assert.equal(current.ino, parentIdentity.ino);
      assert.equal(await readFile(join(parent, '.clean-install-fixture'), 'utf8'), marker);
      await rm(parent, { recursive: true });
      report.fixture_cleanup = true;
    } catch {
      report.fixture_cleanup = false;
      report.status = 'FAIL';
      report.code = 'FIXTURE_CLEANUP_FAILED';
    }
  } else report.fixture_cleanup = true;
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
if (report.status !== 'PASS') process.exitCode = 1;

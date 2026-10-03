import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { createServer, request } from 'node:http';
import { mkdtemp, realpath, lstat, readFile, writeFile, rm, cp, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';

const PREFIX = 'learnbridge-lifecycle-fixture-';
const CLI = fileURLToPath(new URL('../apps/local-runtime/src/cli.mjs', import.meta.url));
const STORAGE_URL = new URL('../packages/local-storage/src/index.mjs', import.meta.url).href;
const REPO = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const CHILD_ENV = { TZ: 'UTC', ...(process.env.PATH ? { PATH: process.env.PATH } : {}) };

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), PREFIX)));
  const identity = await lstat(root);
  const marker = randomUUID();
  await writeFile(join(root, '.fixture-marker'), marker, { mode: 0o600, flag: 'wx' });
  const children = [];
  const closers = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    for (const child of children.reverse()) await terminate(child);
    const current = await lstat(root);
    assert.equal(basename(root).startsWith(PREFIX), true);
    assert.equal(current.isDirectory() && !current.isSymbolicLink(), true);
    assert.equal(current.dev, identity.dev);
    assert.equal(current.ino, identity.ino);
    assert.equal(await readFile(join(root, '.fixture-marker'), 'utf8'), marker);
    await rm(root, { recursive: true });
  });
  return { root, dataRoot: join(root, 'workspace'), children, closers };
}

function launch(fx, args, env = CHILD_ENV) {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.output = '';
  child.errors = '';
  child.stdout.on('data', chunk => { child.output += chunk.toString(); });
  child.stderr.on('data', chunk => { child.errors += chunk.toString(); });
  child.completion = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout: child.output, stderr: child.errors }));
  });
  fx.children.push(child);
  return child;
}

async function bounded(promise, timeout = 5000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture operation timed out.')), timeout); })]);
  } finally { clearTimeout(timer); }
}

async function terminate(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  try { await bounded(child.completion, 2000); } catch {
    child.kill('SIGKILL');
    await bounded(child.completion, 2000);
  }
}

async function run(fx, args, { success = true, env = CHILD_ENV } = {}) {
  const child = launch(fx, args, env);
  const result = await bounded(child.completion);
  assert(result.stdout.length < 100_000 && result.stderr.length < 100_000);
  if (success) assert.equal(result.code, 0, `CLI command failed: ${args[0]}, ${result.stderr}`);
  return result;
}

async function start(fx, { port = 0, env = CHILD_ENV } = {}) {
  const child = launch(fx, ['start', '--data-root', fx.dataRoot, '--port', String(port), '--json'], env);
  let partial = '';
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      partial += chunk.toString();
      const lines = partial.split('\n');
      partial = lines.pop();
      for (const line of lines) {
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.event === 'ready') resolve(message);
      }
    });
    child.completion.then(result => reject(new Error(`CLI exited before ready with code ${result.code}.`)), reject);
  });
  const info = await bounded(ready);
  const url = new URL(info.origin);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
  assert(Number(url.port) > 0);
  assert.equal(typeof info.pairing_code, 'string');
  assert(info.pairing_code.length >= 16);
  return { child, ...info };
}

function records(root) {
  const store = LocalStore.open({ root, repositoryRoot: REPO });
  try {
    const task = store.createTask({ title: 'Synthetic lifecycle task', deadline: { precision: 'date', date: '2026-10-20', timezone: 'America/Toronto' } });
    const document = store.createDocument({ title: 'Synthetic lifecycle note', text: '# Exact synthetic text\n\nλ and 🧠 survive backup.\n', kind: 'study' });
    return { task, document: store.getDocument(document.document?.id ?? document.id), identity: store.identity };
  } finally { store.close(); }
}

function http(info, path, { method = 'GET', headers = {}, body } = {}) {
  const url = new URL(info.origin);
  const raw = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: url.hostname, port: url.port, path, method, headers: {
      ...(raw === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) }), ...headers,
    } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = JSON.parse(text); } catch { data = null; }
        resolve({ status: res.statusCode, data, headers: res.headers, text });
      });
      res.on('error', reject);
    });
    req.setTimeout(3000, () => req.destroy(new Error('Fixture HTTP timeout.')));
    req.on('error', reject);
    req.end(raw);
  });
}

async function pair(info) {
  const result = await http(info, '/api/local/v1/pair', { method: 'POST', headers: { origin: info.origin }, body: { code: info.pairing_code } });
  assert.equal(result.status, 200);
  return { cookie: result.headers['set-cookie'][0].split(';')[0], 'x-learnbridge-nonce': result.data.nonce };
}

test('LF10: an actual second CLI process cannot start a writer in the live workspace', async t => {
  const fx = await fixture(t);
  const first = await start(fx);
  const second = await run(fx, ['start', '--data-root', fx.dataRoot, '--port', '0', '--json'], { success: false });
  assert.notEqual(second.code, 0);
  assert.equal(second.stdout.includes('"event":"ready"'), false);
  assert.equal(second.stdout.includes(first.pairing_code), false);
  assert.equal(second.stderr.includes(first.pairing_code), false);
  assert.equal((await http(first, '/health')).status, 200);
  const session = await pair(first);
  assert.equal((await http(first, '/api/local/v1/status', { headers: session })).status, 200);
});

test('LF11: an occupied port falls back to another exact loopback origin', async t => {
  const fx = await fixture(t);
  const occupied = createServer((_, response) => response.end('Unrelated fixture listener'));
  await new Promise((resolve, reject) => { occupied.once('error', reject); occupied.listen(0, '127.0.0.1', resolve); });
  fx.closers.push(() => new Promise(resolve => occupied.close(resolve)));
  const port = occupied.address().port;
  const runtime = await startRuntime({ dataRoot: fx.dataRoot, port });
  fx.closers.push(() => runtime.close());
  const chosen = new URL(runtime.origin);
  assert.equal(chosen.hostname, '127.0.0.1');
  assert.notEqual(Number(chosen.port), port);
  assert.equal((await http(runtime, '/health')).status, 200);
  const response = await http({ origin: `http://127.0.0.1:${port}` }, '/health');
  assert.equal(response.text, 'Unrelated fixture listener');
});

test('LF12/LF15: setup and doctor work without cloud configuration and report no synthetic secret', async t => {
  const fx = await fixture(t);
  const secret = `FIXTURE_ENV_SECRET_${randomUUID()}`;
  const env = { ...CHILD_ENV, OPENAI_API_KEY: secret, COMPOSIO_API_KEY: secret, SUPABASE_SERVICE_ROLE_KEY: secret };
  const setup = await run(fx, ['setup', '--data-root', fx.dataRoot, '--json'], { env });
  assert.doesNotThrow(() => JSON.parse(setup.stdout.trim()));
  assert.equal(setup.stdout.includes(secret) || setup.stderr.includes(secret), false);
  const before = createHash('sha256').update(await readFile(join(fx.dataRoot, 'learnbridge.sqlite'))).digest('hex');
  const doctor = await run(fx, ['doctor', '--data-root', fx.dataRoot, '--json']);
  const report = JSON.parse(doctor.stdout.trim());
  assert.equal(report.edition, 'local');
  assert.equal(report.integrity, true);
  const after = createHash('sha256').update(await readFile(join(fx.dataRoot, 'learnbridge.sqlite'))).digest('hex');
  assert.equal(after, before, 'Read-only doctor must not migrate or rewrite stored student data.');
  assert.equal(doctor.stdout.includes(secret) || doctor.stderr.includes(secret), false);
  assert.equal(doctor.stdout.includes('pairing_code') || doctor.stdout.includes('nonce'), false);
  const duplicateSetup = await run(fx, ['setup', '--data-root', fx.dataRoot, '--json']);
  assert.equal(JSON.parse(duplicateSetup.stdout.trim()).student_id, JSON.parse(setup.stdout.trim()).student_id);
});

test('LF12: actual installation and database files have private POSIX permissions', async t => {
  const fx = await fixture(t);
  const active = await start(fx);
  assert.equal((await lstat(fx.dataRoot)).mode & 0o777, 0o700);
  for (const name of ['learnbridge.sqlite', 'writer.lock']) {
    const stat = await lstat(join(fx.dataRoot, name));
    assert.equal(stat.isFile() && !stat.isSymbolicLink(), true);
    assert.equal(stat.mode & 0o777, 0o600);
    if (typeof process.getuid === 'function') assert.equal(stat.uid, process.getuid());
  }
  assert.equal((await http(active, '/health')).status, 200);
});

test('LF12: doctor inspects a missing installation without creating a data root', async t => {
  const fx = await fixture(t);
  const result = await run(fx, ['doctor', '--data-root', fx.dataRoot, '--json'], { success: false });
  assert(result.stdout.length < 10_000 && result.stderr.length < 10_000);
  await assert.rejects(access(fx.dataRoot), 'A diagnostic command must not implicitly set up student storage.');
  assert.equal(result.stdout.includes('pairing_code') || result.stdout.includes('nonce'), false);
});

test('LF16: the private control socket refuses a forged token without stopping the runtime', async t => {
  const fx = await fixture(t);
  const active = await start(fx);
  const metadata = JSON.parse(await readFile(join(fx.dataRoot, '.control.json'), 'utf8'));
  const stat = await lstat(join(fx.dataRoot, '.control.json'));
  assert.equal(stat.mode & 0o777, 0o600);
  const reply = await bounded(new Promise((resolve, reject) => {
    const socket = createConnection(metadata.socket);
    let raw = '';
    socket.setTimeout(2000, () => socket.destroy(new Error('Fixture socket timeout.')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify({ token: 'forged-fixture-token', command: 'stop' }) + '\n'));
    socket.on('data', chunk => { raw += chunk.toString(); });
    socket.on('end', () => { socket.destroy(); resolve(raw); });
  }));
  assert.equal(JSON.parse(reply.trim()).ok, false);
  assert.equal(reply.includes(metadata.token), false);
  assert.equal((await http(active, '/health')).status, 200);
});

test('LF13: CLI backup and fresh-root restore retain exact task/document state verified in a fresh process', async t => {
  const fx = await fixture(t);
  const expected = records(fx.dataRoot);
  const live = await start(fx);
  const backupRoot = join(fx.root, 'backup');
  await run(fx, ['backup', '--data-root', fx.dataRoot, '--output', backupRoot, '--json']);
  const originalHash = createHash('sha256').update(await readFile(join(backupRoot, 'learnbridge.sqlite'))).digest('hex');
  const restoreRoot = join(fx.root, 'restored');
  await run(fx, ['restore', '--backup-root', backupRoot, '--data-root', restoreRoot, '--json']);
  const code = `
    import assert from 'node:assert/strict';
    import { LocalStore } from ${JSON.stringify(STORAGE_URL)};
    const expected = ${JSON.stringify(expected)};
    const store = LocalStore.open({root:${JSON.stringify(restoreRoot)},repositoryRoot:${JSON.stringify(REPO)}});
    try {
      assert.deepEqual(store.listTasks(), [expected.task]);
      assert.deepEqual(store.getDocument(expected.document.document.id), expected.document);
      assert.equal(store.identity.student_id, expected.identity.student_id);
      assert.equal(store.integrity().integrity, 'ok');
      process.stdout.write(JSON.stringify({verified:true,tasks:1,documents:1}));
    } finally { store.close(); }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', code], { cwd: fx.root, env: CHILD_ENV, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.output = ''; child.errors = '';
  child.stdout.on('data', chunk => { child.output += chunk.toString(); });
  child.stderr.on('data', chunk => { child.errors += chunk.toString(); });
  child.completion = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({code,signal})); });
  fx.children.push(child);
  assert.equal((await bounded(child.completion)).code, 0, child.errors);
  assert.deepEqual(JSON.parse(child.output), { verified: true, tasks: 1, documents: 1 });
  assert.equal(createHash('sha256').update(await readFile(join(backupRoot, 'learnbridge.sqlite'))).digest('hex'), originalHash);
  assert.equal((await http(live, '/health')).status, 200);
  const overwrite = await run(fx, ['restore', '--backup-root', backupRoot, '--data-root', restoreRoot, '--json'], { success: false });
  assert.notEqual(overwrite.code, 0, 'Restore must not overwrite an existing student data root.');
});

test('LF13: a corrupt backup cannot activate a restored workspace or alter the source', async t => {
  const fx = await fixture(t);
  const expected = records(fx.dataRoot);
  const store = LocalStore.open({ root: fx.dataRoot, repositoryRoot: REPO });
  const backupRoot = join(fx.root, 'backup');
  try { await store.backup(backupRoot); } finally { store.close(); }
  const badRoot = join(fx.root, 'corrupt');
  await cp(backupRoot, badRoot, { recursive: true, errorOnExist: true, force: false });
  await writeFile(join(badRoot, 'learnbridge.sqlite'), 'Deliberately invalid synthetic SQLite file');
  const destination = join(fx.root, 'refused-restore');
  const result = await run(fx, ['restore', '--backup-root', badRoot, '--data-root', destination, '--json'], { success: false });
  assert.notEqual(result.code, 0);
  const original = LocalStore.open({ root: fx.dataRoot, repositoryRoot: REPO });
  try {
    assert.deepEqual(original.listTasks(), [expected.task]);
    assert.deepEqual(original.getDocument(expected.document.document.id), expected.document);
  } finally { original.close(); }
  await assert.rejects(access(destination), 'Failed restore must not leave an active destination.');
});

test('LF14: a killed CLI runtime releases stale ownership on restart and retains committed records', async t => {
  const fx = await fixture(t);
  const expected = records(fx.dataRoot);
  const first = await start(fx);
  first.child.kill('SIGKILL');
  assert.equal((await bounded(first.child.completion)).signal, 'SIGKILL');
  const next = await start(fx);
  const session = await pair(next);
  const tasks = await http(next, '/api/local/v1/tasks', { headers: session });
  assert.equal(tasks.status, 200);
  assert.deepEqual(tasks.data.items, [expected.task]);
  const doc = await http(next, `/api/local/v1/documents/${expected.document.document.id}`, { headers: session });
  assert.equal(doc.status, 200);
  assert.equal(doc.data.content, expected.document.text);
  assert.equal(doc.data.sha256, expected.document.sha256);
  await run(fx, ['stop', '--data-root', fx.dataRoot, '--json']);
  assert.equal((await bounded(next.child.completion)).code, 0);
  const reopened = LocalStore.open({ root: fx.dataRoot, repositoryRoot: REPO });
  try { assert.deepEqual(reopened.listTasks(), [expected.task]); } finally { reopened.close(); }
});

test('LF14: uninstall stops the fixture runtime while retaining student-authored task/document data', async t => {
  const fx = await fixture(t);
  const expected = records(fx.dataRoot);
  const active = await start(fx);
  const result = await run(fx, ['uninstall', '--data-root', fx.dataRoot, '--json']);
  assert.equal((await bounded(active.child.completion)).code, 0);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.data_retained, true);
  const reopened = LocalStore.open({ root: fx.dataRoot, repositoryRoot: REPO });
  try {
    assert.deepEqual(reopened.listTasks(), [expected.task]);
    assert.deepEqual(reopened.getDocument(expected.document.document.id), expected.document);
  } finally { reopened.close(); }
});

test('LF17: graceful stop is bounded while an authenticated HTTP body remains incomplete', async t => {
  const fx = await fixture(t);
  const expected = records(fx.dataRoot);
  const active = await start(fx);
  const session = await pair(active);
  const origin = new URL(active.origin);
  const held = request({ hostname: origin.hostname, port: origin.port,
    path: '/api/local/v1/documents', method: 'POST', headers: {
      ...session, origin: active.origin, 'content-type': 'application/json', 'content-length': '1000',
    } });
  const ended = new Promise(resolve => { held.on('error', () => {}); held.on('close', resolve); });
  fx.closers.push(async () => { held.destroy(); await ended; });
  held.flushHeaders();
  held.write('{"title":"Incomplete fixture note","content":"');
  await delay(50);
  const startedAt = Date.now();
  await run(fx, ['stop', '--data-root', fx.dataRoot, '--json']);
  assert.equal((await bounded(active.child.completion, 4000)).code, 0);
  assert(Date.now() - startedAt < 4000, 'An incomplete request must not hold the local shutdown open indefinitely.');
  await bounded(ended, 1000);
  const reopened = LocalStore.open({ root: fx.dataRoot, repositoryRoot: REPO });
  try {
    assert.deepEqual(reopened.listTasks(), [expected.task]);
    assert.equal(reopened.listDocuments().length, 1);
    assert.deepEqual(reopened.getDocument(expected.document.document.id), expected.document);
  } finally { reopened.close(); }
});

test('LF18: simultaneous backup and graceful shutdown preserve a complete verifiable snapshot', async t => {
  const fx = await fixture(t);
  const text = 'Synthetic backup fixture words. '.repeat(16_000);
  const expectedHash = createHash('sha256').update(text).digest('hex');
  const store = LocalStore.open({ root: fx.dataRoot, repositoryRoot: REPO });
  const documentIds = [];
  try {
    for (let index = 0; index < 32; index++) documentIds.push(store.createDocument({ title: `Synthetic backup note ${index}`, text }).document.id);
  } finally { store.close(); }
  const liveBytes = (await lstat(join(fx.dataRoot, 'learnbridge.sqlite'))).size;
  const active = await start(fx);
  const backupRoot = join(fx.root, 'shutdown-backup');
  const backup = launch(fx, ['backup', '--data-root', fx.dataRoot, '--output', backupRoot, '--json']);
  let observedPartialSnapshot = false;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && backup.exitCode === null && backup.signalCode === null) {
    try {
      const bytes = (await lstat(join(backupRoot, 'learnbridge.sqlite'))).size;
      if (bytes < liveBytes) { observedPartialSnapshot = true; break; }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(1);
  }
  assert.equal(observedPartialSnapshot, true, 'The fixture must observe a backup in progress before requesting shutdown.');
  active.child.kill('SIGTERM');
  const backupResult = await bounded(backup.completion, 8000);
  assert.equal(backupResult.code, 0, backupResult.stderr);
  assert.equal((await bounded(active.child.completion, 8000)).code, 0);
  const restoredRoot = join(fx.root, 'shutdown-restored');
  await run(fx, ['restore', '--backup-root', backupRoot, '--data-root', restoredRoot, '--json']);
  const restored = LocalStore.open({ root: restoredRoot, repositoryRoot: REPO });
  try {
    assert.equal(restored.integrity().integrity, 'ok');
    assert.equal(restored.listDocuments().length, documentIds.length);
    for (const id of documentIds) {
      const saved = restored.getDocument(id);
      assert.equal(saved.text, text);
      assert.equal(saved.sha256, expectedHash);
    }
  } finally { restored.close(); }
});

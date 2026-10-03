import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, rmSync, chmodSync, unlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { startControl, controlSocketPath, requestControl, readControl } from '../apps/local-runtime/src/ipc.mjs';
import { opaqueToken } from '../apps/local-runtime/src/policy.mjs';

const CLI = fileURLToPath(new URL('../apps/local-runtime/src/cli.mjs', import.meta.url));
const env = Object.fromEntries(['PATH', 'TMPDIR', 'TEMP', 'TMP'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'learnbridge-diagnostics-test-'))); const root = join(base, 'workspace');
  t.after(() => rmSync(base, { recursive: true, force: true })); return { base, root };
}
function command(args) {
  const result = spawnSync(process.execPath, [CLI, ...args, '--json'], { env, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
  assert.ifError(result.error); return { status: result.status, value: JSON.parse(result.stdout.trim()) };
}
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic diagnostic timeout.')), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function startChild(t, root) {
  const child = spawn(process.execPath, [CLI, 'start', '--data-root', root, '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  const ended = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (status, signal) => resolve({ status, signal })); });
  let raw = '';
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { raw += chunk.toString(); if (!raw.includes('\n')) return; const message = JSON.parse(raw.split('\n')[0]); if (message.event === 'ready') resolve(); else reject(new Error('Synthetic runtime failed to start.')); });
    ended.then(() => reject(new Error('Synthetic runtime ended before startup.')), reject);
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await bounded(ended); });
  await bounded(ready); return { child, ended };
}

test('LD01 doctor preserves pre-existing empty and unrelated unmarked folders', t => {
  const { base } = fixture(t);
  for (const [name, mode, text] of [['empty', 0o755, null], ['unrelated', 0o700, 'Synthetic unrelated text.']]) {
    const root = join(base, name); mkdirSync(root, { mode });
    if (text) writeFileSync(join(root, 'unrelated.txt'), text, { mode: 0o600 });
    const before = { mode: statSync(root).mode, names: readdirSync(root) };
    const result = command(['doctor', '--data-root', root]);
    assert.equal(result.status, 1); assert.equal(result.value.state, 'requires_setup'); assert.equal(result.value.initialized, false);
    assert.equal(statSync(root).mode, before.mode); assert.deepEqual(readdirSync(root), before.names);
    if (text) assert.equal(readFileSync(join(root, 'unrelated.txt'), 'utf8'), text);
  }
});

test('LD02 dead control owner permits offline doctor, backup, stop and uninstall', async t => {
  const { base, root } = fixture(t); const store = LocalStore.open({ root }); const task = store.createTask({ title: 'Synthetic committed diagnostic task' }); store.close();
  const runtime = await startChild(t, root); runtime.child.kill('SIGKILL'); assert.equal((await bounded(runtime.ended)).signal, 'SIGKILL');
  const staleControl = readFileSync(join(root, '.control.json'));
  const doctor = command(['doctor', '--data-root', root]); assert.equal(doctor.status, 0); assert.equal(doctor.value.integrity, true);
  const backupRoot = join(base, 'offline-backup'); const backup = command(['backup', '--data-root', root, '--output', backupRoot]); assert.equal(backup.status, 0); assert.equal(backup.value.verified, true);
  assert.equal(command(['stop', '--data-root', root]).value.was_running, false);
  assert.equal(command(['uninstall', '--data-root', root]).value.data_retained, true);
  assert.deepEqual(readFileSync(join(root, '.control.json')), staleControl);
  const reopened = LocalStore.open({ root }); try { assert.deepEqual(reopened.getTask(task.id), task); } finally { reopened.close(); }
  const restoredRoot = join(base, 'offline-restored'); await LocalStore.restore({ root: restoredRoot, backupRoot });
  const copy = LocalStore.open({ root: restoredRoot }); try { assert.deepEqual(copy.getTask(task.id), task); } finally { copy.close(); }
  const staleSocket = readControl(root).socket;
  assert.equal(statSync(staleSocket).isSocket(), true); assert.equal(statSync(staleSocket).uid, process.getuid()); unlinkSync(staleSocket);
});

test('LD03 live or reused metadata PID fails closed rather than falling back to offline writes', t => {
  const { root } = fixture(t); const store = LocalStore.open({ root }); store.createTask({ title: 'Preserve live-uncertain workspace' }); store.close();
  const socket = controlSocketPath(root, { create: true });
  writeFileSync(join(root, '.control.json'), JSON.stringify({ version: 1, pid: process.pid, socket, origin: 'http://127.0.0.1:3210', token: opaqueToken(), instance: opaqueToken() }), { mode: 0o600 });
  assert.equal(readControl(root).pid, process.pid);
  const path = join(root, 'learnbridge.sqlite'); const before = digest(readFileSync(path));
  const result = command(['doctor', '--data-root', root]); assert.equal(result.status, 1); assert.equal(result.value.status, 'FAIL');
  assert.equal(digest(readFileSync(path)), before); assert.equal(readdirSync(root).includes('writer.lock'), false);
});

test('LD04 control server preserves a Unicode path split inside a UTF-8 character', async t => {
  const { root } = fixture(t); const store = LocalStore.open({ root }); store.close();
  const path = '/tmp/synthetic-学-🧠-é'; let received;
  const control = await startControl({ root, origin: 'http://127.0.0.1:3210', onCommand: async (_command, data) => { received = data.output; return { accepted: true }; } });
  try {
    const metadata = readControl(root); const bytes = Buffer.from(JSON.stringify({ token: metadata.token, command: 'backup', data: { output: path } }) + '\n');
    const split = bytes.indexOf(Buffer.from('🧠')) + 1;
    const reply = await bounded(new Promise((resolve, reject) => {
      const socket = createConnection(metadata.socket); const chunks = [];
      socket.on('error', reject); socket.on('data', chunk => chunks.push(chunk));
      socket.on('end', () => { socket.destroy(); resolve(JSON.parse(Buffer.concat(chunks).toString().trim())); });
      socket.on('connect', async () => { socket.write(bytes.subarray(0, split)); await delay(30); socket.end(bytes.subarray(split)); });
    }));
    assert.equal(reply.ok, true); assert.equal(received, path);
  } finally { await control.close(); }
});

test('LD05 control client preserves a Unicode reply split inside a UTF-8 character', async t => {
  const { root } = fixture(t); const store = LocalStore.open({ root }); store.close();
  const socketPath = controlSocketPath(root, { create: true }); const text = 'Synthetic Unicode 学 🧠 é reply';
  const server = createServer(socket => {
    socket.on('error', () => {});
    socket.once('data', async () => {
      const bytes = Buffer.from(JSON.stringify({ ok: true, result: { text } }) + '\n'); const split = bytes.indexOf(Buffer.from('🧠')) + 2;
      socket.write(bytes.subarray(0, split)); await delay(30); socket.end(bytes.subarray(split));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); }); chmodSync(socketPath, 0o600);
  writeFileSync(join(root, '.control.json'), JSON.stringify({ version: 1, pid: process.pid, socket: socketPath, origin: 'http://127.0.0.1:3210', token: opaqueToken(), instance: opaqueToken() }), { mode: 0o600 });
  try { assert.deepEqual(await requestControl(root, 'status'), { text }); }
  finally { await new Promise(resolve => server.close(resolve)); try { unlinkSync(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
});

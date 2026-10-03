import { createHash } from 'node:crypto';
import { createServer, createConnection } from 'node:net';
import { constants, mkdirSync, lstatSync, realpathSync, openSync, fstatSync, readFileSync, closeSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { opaqueToken, secretEqual } from './policy.mjs';

const uid = () => process.getuid?.();
const fail = () => { throw new Error('Local control channel is unavailable or unsafe.'); };
function privateDirectory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid() || (stat.mode & 0o077) !== 0) fail();
  return realpathSync(path);
}
export function controlSocketPath(root, { create = false } = {}) {
  if (!['darwin', 'linux'].includes(process.platform) || uid() === undefined) fail();
  // Short path avoids Unix socket path limits even when the data root is long.
  const base = join(realpathSync('/tmp'), 'learnbridge-ipc-' + uid());
  if (create) { try { mkdirSync(base, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
  const directory = privateDirectory(base);
  const key = createHash('sha256').update(root).digest('hex').slice(0, 24);
  return join(directory, key + '.sock');
}
const metadataPath = root => join(root, '.control.json');
function privateJsonFile(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== uid() || (stat.mode & 0o077) !== 0 || stat.size > 8192) fail();
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}
export function readControl(root) {
  root = privateDirectory(resolve(root));
  let value;
  try { value = privateJsonFile(metadataPath(root)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid < 1
    || !/^[A-Za-z0-9_-]{43}$/.test(value.token) || !/^[A-Za-z0-9_-]{43}$/.test(value.instance)
    || !/^http:\/\/127\.0\.0\.1:\d+$/.test(value.origin)
    || value.socket !== controlSocketPath(root)) fail();
  return value;
}
function removeSocket(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isSocket() || stat.uid !== uid() || stat.isSymbolicLink()) fail();
    unlinkSync(path);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function startControl({ root, origin, onCommand }) {
  root = privateDirectory(root);
  const path = controlSocketPath(root, { create: true });
  removeSocket(path); // Storage root lock is already held by this runtime.
  const token = opaqueToken();
  const instance = opaqueToken();
  const clients = new Set();
  const server = createServer(socket => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(15_000, () => socket.destroy());
    let bytes = 0;
    let chunks = [];
    let handled = false;
    socket.on('data', async chunk => {
      if (handled) return;
      bytes += chunk.length;
      if (bytes > 4096) { handled = true; socket.end(JSON.stringify({ ok: false, code: 'INVALID_INPUT' }) + '\n'); return; }
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      handled = true;
      try {
        // Decode exactly once: a multibyte UTF-8 path can span socket chunks.
        const lines = Buffer.concat(chunks, bytes).toString('utf8').split('\n');
        chunks = [];
        if (lines.length !== 2 || lines[1] !== '') fail();
        const input = JSON.parse(lines[0]);
        if (!input || Array.isArray(input) || Object.keys(input).some(key => !['token', 'command', 'data'].includes(key))
          || !secretEqual(input.token, token) || !['status', 'stop', 'backup'].includes(input.command)) fail();
        const result = await onCommand(input.command, input.data);
        socket.end(JSON.stringify({ ok: true, result }) + '\n');
      } catch {
        socket.end(JSON.stringify({ ok: false, code: 'CONTROL_REJECTED' }) + '\n');
      }
    });
  });
  await new Promise((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(path, () => { server.off('error', reject); resolveReady(); });
  });
  // Unix socket mode comes from restrictive process umask, asserted explicitly.
  const { chmodSync } = await import('node:fs');
  chmodSync(path, 0o600);
  const temporary = join(root, '.control-' + instance + '.tmp');
  try {
    writeFileSync(temporary, JSON.stringify({ version: 1, pid: process.pid, origin, socket: path, token, instance }), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, metadataPath(root));
  } catch (error) {
    for (const socket of clients) socket.destroy();
    await new Promise(done => server.close(done));
    removeSocket(path);
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
  let closed = false;
  return {
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of clients) socket.destroy();
      await new Promise(done => server.close(done));
      try {
        const current = privateJsonFile(metadataPath(root));
        if (current.instance === instance) unlinkSync(metadataPath(root));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      removeSocket(path);
    },
  };
}

export async function requestControl(root, command, data, { timeoutMs = 15_000 } = {}) {
  const metadata = readControl(root);
  if (!metadata) throw new Error('The local runtime is not running.');
  return new Promise((resolveReply, reject) => {
    const socket = createConnection(metadata.socket);
    let reply = [];
    let bytes = 0;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      error ? reject(new Error('Local control channel is unavailable or rejected the request.')) : resolveReply(result);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error('Timeout')));
    socket.on('error', () => finish(new Error('Connection failed')));
    socket.on('connect', () => socket.write(JSON.stringify({ token: metadata.token, command, data }) + '\n'));
    socket.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 65536) return finish(new Error('Reply too large'));
      reply.push(chunk);
      if (!chunk.includes(10)) return;
      try {
        const decoded = JSON.parse(Buffer.concat(reply, bytes).toString('utf8').split('\n')[0]);
        if (!decoded.ok) finish(new Error('Rejected'));
        else finish(null, decoded.result);
      } catch { finish(new Error('Invalid reply')); }
    });
    socket.on('end', () => { if (!settled) finish(new Error('No reply')); });
  });
}

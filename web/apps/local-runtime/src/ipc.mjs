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
const agentPath = (root, destination) => join(root, '.agent-' + destination + '.json');
const destinations = ['codex', 'claude'];
function privateJsonFile(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== uid() || (stat.mode & 0o077) !== 0 || stat.size > 8192) fail();
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}
function readMetadata(root, destination) {
  if (destination !== undefined && !destinations.includes(destination)) fail();
  root = privateDirectory(resolve(root));
  let value;
  try { value = privateJsonFile(destination === undefined ? metadataPath(root) : agentPath(root, destination)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid < 1
    || !/^[A-Za-z0-9_-]{43}$/.test(value.token) || !/^[A-Za-z0-9_-]{43}$/.test(value.instance)
    || !/^http:\/\/127\.0\.0\.1:\d+$/.test(value.origin)
    || value.socket !== controlSocketPath(root) || (destination !== undefined && value.destination !== destination)) fail();
  return value;
}
export const readControl = root => readMetadata(root);
export const readAgentControl = (root, destination) => readMetadata(root, destination);
function removeSocket(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isSocket() || stat.uid !== uid() || stat.isSymbolicLink()) fail();
    unlinkSync(path);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function startControl({ root, origin, onCommand, onAgentCommand }) {
  root = privateDirectory(root);
  const path = controlSocketPath(root, { create: true });
  removeSocket(path); // Storage root lock is already held by this runtime.
  const token = opaqueToken();
  const instance = opaqueToken();
  const agentTokens = new Map(destinations.map(destination => [destination, opaqueToken()]));
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
      if (bytes > 16384) { handled = true; socket.end(JSON.stringify({ ok: false, code: 'INVALID_INPUT' }) + '\n'); return; }
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      handled = true;
      try {
        // Decode exactly once: a multibyte UTF-8 path can span socket chunks.
        const lines = Buffer.concat(chunks, bytes).toString('utf8').split('\n');
        chunks = [];
        if (lines.length !== 2 || lines[1] !== '') fail();
        const input = JSON.parse(lines[0]);
        if (!input || Array.isArray(input) || Object.keys(input).some(key => !['token', 'command', 'data'].includes(key))) fail();
        let result;
        if (secretEqual(input.token, token)) {
          if (!['status', 'stop', 'backup'].includes(input.command)) fail();
          result = await onCommand(input.command, input.data);
        } else {
          const destination = destinations.find(value => secretEqual(input.token, agentTokens.get(value)));
          if (!destination || !onAgentCommand || !['status', 'context', 'propose_task', 'propose_document'].includes(input.command)) fail();
          result = await onAgentCommand(destination, input.command, input.data);
        }
        socket.end(JSON.stringify({ ok: true, result }) + '\n');
      } catch (error) {
        const codes = ['AUTH_REQUIRED', 'CONSENT_REQUIRED', 'SCOPE_DENIED', 'REVISION_CONFLICT', 'VERSION_MISMATCH', 'INVALID_INPUT', 'BUDGET_EXCEEDED', 'UNSUPPORTED'];
        socket.end(JSON.stringify({ ok: false, code: codes.includes(error.code) ? error.code : 'CONTROL_REJECTED' }) + '\n');
      }
    });
  });
  await new Promise((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(path, () => { server.off('error', reject); resolveReady(); });
  });
  // Unix socket mode comes from restrictive process umask, asserted explicitly.
  const temporary = join(root, '.control-' + instance + '.tmp');
  try {
    const { chmodSync } = await import('node:fs');
    chmodSync(path, 0o600);
    writeFileSync(temporary, JSON.stringify({ version: 1, pid: process.pid, origin, socket: path, token, instance }), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, metadataPath(root));
    if (onAgentCommand) for (const destination of destinations) {
      const staging = temporary + '-' + destination;
      try {
        writeFileSync(staging, JSON.stringify({ version: 1, pid: process.pid, origin, socket: path, token: agentTokens.get(destination), instance, destination }), { mode: 0o600, flag: 'wx' });
        renameSync(staging, agentPath(root, destination));
      } finally { try { unlinkSync(staging); } catch {} }
    }
  } catch (error) {
    for (const socket of clients) socket.destroy();
    await new Promise(done => server.close(done));
    removeSocket(path);
    try { unlinkSync(temporary); } catch {}
    for (const target of [metadataPath(root), ...destinations.map(destination => agentPath(root, destination))]) {
      try { if (privateJsonFile(target).instance === instance) unlinkSync(target); } catch {}
    }
    throw error;
  }
  let closed = false;
  return {
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of clients) socket.destroy();
      await new Promise(done => server.close(done));
      for (const target of [metadataPath(root), ...destinations.map(destination => agentPath(root, destination))]) {
        try {
          const current = privateJsonFile(target);
          if (current.instance === instance) unlinkSync(target);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      removeSocket(path);
    },
  };
}

async function requestMetadata(metadata, command, data, { timeoutMs = 15_000 } = {}) {
  if (!metadata) throw new Error('The local runtime is not running.');
  const frame = JSON.stringify({ token: metadata.token, command, data }) + '\n';
  if (Buffer.byteLength(frame) > 16384) throw new Error('Local control request is too large.');
  return new Promise((resolveReply, reject) => {
    const socket = createConnection(metadata.socket);
    let reply = [];
    let bytes = 0;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) { const safe = new Error('Local control channel is unavailable or rejected the request.'); safe.code = error.code || 'OFFLINE'; reject(safe); }
      else resolveReply(result);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error('Timeout')));
    socket.on('error', () => finish(new Error('Connection failed')));
    socket.on('connect', () => socket.write(frame));
    socket.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 65536) return finish(new Error('Reply too large'));
      reply.push(chunk);
      if (!chunk.includes(10)) return;
      try {
        const decoded = JSON.parse(Buffer.concat(reply, bytes).toString('utf8').split('\n')[0]);
        if (!decoded.ok) { const error = new Error('Rejected'); error.code = decoded.code; finish(error); }
        else finish(null, decoded.result);
      } catch { finish(new Error('Invalid reply')); }
    });
    socket.on('end', () => { if (!settled) finish(new Error('No reply')); });
  });
}
export const requestControl = (root, command, data, options) => requestMetadata(readControl(root), command, data, options);
export const requestAgentControl = (root, destination, command, data, options) => requestMetadata(readAgentControl(root, destination), command, data, options);

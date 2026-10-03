import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, lstat, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';
import { describeRoot, inventorySource, readSelectedEntry, probeSourceCapability } from '../packages/local-sources/src/index.mjs';

const PREFIX = 'learnbridge-source-http-fixture-';
const BASE = '/api/local/v1';
const hash = text => createHash('sha256').update(text).digest('hex');
const production = { describeRoot, inventorySource, readSelectedEntry, probeSourceCapability };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

/** Hold only a completed real acquisition result. No contents, metadata,
 * filesystem operations, authentication or storage methods are mocked. */
function heldAcquisition(method) {
  const entered = deferred();
  const resumed = deferred();
  let acquisitionSignal;
  const adapter = { ...production, [method]: async (...args) => {
    acquisitionSignal = args.at(-1)?.signal;
    const result = await production[method](...args);
    entered.resolve(result);
    await resumed.promise;
    return result;
  } };
  return { adapter, entered: entered.promise, signal: () => acquisitionSignal, release: () => resumed.resolve() };
}

async function bounded(promise, milliseconds = 5000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('The real acquisition did not reach its return barrier.')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture(t, { hold, sessionTtlMs = 30_000 } = {}) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), PREFIX)));
  const identity = await lstat(parent);
  const marker = randomUUID();
  await writeFile(join(parent, '.fixture-marker'), marker, { flag: 'wx', mode: 0o600 });
  const selectedRoot = join(parent, 'selected');
  const dataRoot = join(parent, 'workspace');
  await mkdir(selectedRoot, { mode: 0o700 });
  const text = `LB_SYNTHETIC_SOURCE_BODY_${randomUUID()}\nOnly this fixture owns this text. Résumé, λ and 🧠.\n`;
  await writeFile(join(selectedRoot, 'study.md'), text, { flag: 'wx', mode: 0o600 });
  const barrier = heldAcquisition(hold);
  let runtime;
  t.after(async () => {
    barrier.release();
    await runtime?.close();
    const current = await lstat(parent);
    assert(basename(parent).startsWith(PREFIX));
    assert(current.isDirectory() && !current.isSymbolicLink());
    assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino);
    assert.equal(await readFile(join(parent, '.fixture-marker'), 'utf8'), marker);
    await rm(parent, { recursive: true });
  });
  runtime = await startRuntime({ dataRoot, port: 0, sessionTtlMs, sourceAdapter: barrier.adapter });
  const status = await probeSourceCapability();
  assert.equal(status.state, 'available', 'These tests require the real isolated native acquisition worker.');
  return { runtime, barrier, selectedRoot, dataRoot, text };
}

function call(runtime, path, { method = 'GET', headers = {}, body, signal } = {}) {
  const origin = new URL(runtime.origin);
  const raw = body === undefined ? undefined : JSON.stringify(body);
  const result = new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: origin.port, path: `${BASE}${path}`, method, signal, headers: {
      ...(raw === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) }), ...headers,
    } }, res => {
      const chunks = [];
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 200_000) req.destroy(new Error('Fixture response exceeded its explicit bound.'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, headers: res.headers, text, data: JSON.parse(text) }); }
        catch { reject(new Error('Fixture response was not JSON.')); }
      });
    });
    req.setTimeout(6000, () => req.destroy(new Error('Fixture request timed out.')));
    req.on('error', reject);
    req.end(raw);
  });
  // A held operation can fail before its barrier is entered. Keep that failure
  // handled while the caller is waiting for the independent worker evidence.
  result.catch(() => {});
  return result;
}

async function pair(runtime) {
  const response = await call(runtime, '/pair', { method: 'POST', headers: { origin: runtime.origin }, body: { code: runtime.createPairingCode() } });
  assert.equal(response.status, 200);
  assert(Array.isArray(response.headers['set-cookie']));
  assert(Number.isFinite(Date.parse(response.data.expires_at)));
  return { nonce: response.data.nonce, cookie: response.headers['set-cookie'][0].split(';')[0], expiresAt: Date.parse(response.data.expires_at) };
}

function authenticated(runtime, session) {
  return { origin: runtime.origin, cookie: session.cookie, 'x-learnbridge-nonce': session.nonce };
}

async function source(fx, session) {
  const response = await call(fx.runtime, '/sources', { method: 'POST', headers: authenticated(fx.runtime, session), body: { path: fx.selectedRoot, label: 'Synthetic study folder' } });
  assert.equal(response.status, 201);
  assert.equal(response.data.source.state, 'active');
  return response.data.source;
}

async function savedInventory(fx, session, selectedSource) {
  const response = await call(fx.runtime, `/sources/${selectedSource.id}/inventory`, { method: 'POST', headers: authenticated(fx.runtime, session), body: {} });
  assert.equal(response.status, 200);
  const saved = response.data.inventory;
  assert.equal(saved.source_id, selectedSource.id);
  assert.equal(saved.inventory.coverage.state, 'complete');
  assert.equal(saved.inventory.entries.length, 1);
  assert.equal(saved.inventory.entries[0].relativePath, 'study.md');
  assert.equal(response.text.includes(fx.text), false);
  return saved;
}

function importSelected(fx, session, selectedSource, saved, { signal } = {}) {
  return call(fx.runtime, `/sources/${selectedSource.id}/import`, { method: 'POST', headers: authenticated(fx.runtime, session), signal, body: {
    inventory_id: saved.id, entry_id: saved.inventory.entries[0].id,
  } });
}

function discarded(response, status, code, text) {
  assert.equal(response.status, status);
  assert.equal(response.data.error?.code, code);
  assert.deepEqual(Object.keys(response.data), ['error']);
  assert.equal(response.text.includes(text), false);
  assert.equal(response.text.includes(hash(text)), false);
  assert.match(response.headers['cache-control'], /no-store/);
}

/** A separate newly opened native SQLite connection inspects persisted state
 * after the writer has shut down; it does not trust an HTTP list filter. */
async function persisted(fx) {
  await fx.runtime.close();
  const db = new Database(join(fx.dataRoot, 'learnbridge.sqlite'), { readonly: true, fileMustExist: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    return {
      sources: db.prepare('SELECT id,state,revision FROM sources ORDER BY id').all(),
      inventories: db.prepare('SELECT id,source_id FROM source_inventories ORDER BY id').all(),
      entries: db.prepare('SELECT id,source_id,inventory_id,entry_id,text,sha256,version FROM source_entries ORDER BY id').all(),
    };
  } finally { db.close(); }
}

test('SR01: logout after real inventory acquisition discards the result and persists no inventory', async t => {
  const fx = await fixture(t, { hold: 'inventorySource' });
  const session = await pair(fx.runtime);
  const selectedSource = await source(fx, session);
  const pending = call(fx.runtime, `/sources/${selectedSource.id}/inventory`, { method: 'POST', headers: authenticated(fx.runtime, session), body: {} });
  const acquired = await bounded(fx.barrier.entered);
  assert.equal(acquired.entries.length, 1);
  assert.equal(acquired.entries[0].relativePath, 'study.md');
  assert.equal(JSON.stringify(acquired).includes(fx.text), false);
  const logout = await call(fx.runtime, '/logout', { method: 'POST', headers: authenticated(fx.runtime, session), body: {} });
  assert.equal(logout.status, 200);
  fx.barrier.release();
  discarded(await pending, 401, 'AUTH_REQUIRED', fx.text);
  const saved = await persisted(fx);
  assert.deepEqual(saved.sources, [{ id: selectedSource.id, state: 'active', revision: 1 }]);
  assert.deepEqual(saved.inventories, []);
  assert.deepEqual(saved.entries, []);
});

test('SR02: real session expiry after exact selected-file read discards text and persists no import', async t => {
  const fx = await fixture(t, { hold: 'readSelectedEntry', sessionTtlMs: 1500 });
  const setupSession = await pair(fx.runtime);
  const selectedSource = await source(fx, setupSession);
  const inventory = await savedInventory(fx, setupSession, selectedSource);
  // Renew before the held import so setup timing cannot substitute for late
  // authorization loss. The native read must succeed during a valid session.
  const session = await pair(fx.runtime);
  const pending = importSelected(fx, session, selectedSource, inventory);
  const acquired = await bounded(fx.barrier.entered);
  assert.equal(acquired.text, fx.text);
  assert.equal(acquired.sha256, hash(fx.text));
  assert.equal(acquired.version, inventory.inventory.entries[0].snapshot.version);
  assert(Date.now() < session.expiresAt, 'The real read must complete before this session expires.');
  await delay(Math.max(1, session.expiresAt - Date.now() + 30));
  fx.barrier.release();
  discarded(await pending, 401, 'AUTH_REQUIRED', fx.text);
  const saved = await persisted(fx);
  assert.deepEqual(saved.sources, [{ id: selectedSource.id, state: 'active', revision: 1 }]);
  assert.deepEqual(saved.inventories, [{ id: inventory.id, source_id: selectedSource.id }]);
  assert.deepEqual(saved.entries, []);
});

test('SR03: human source revocation after real selected-file read discards text and persists no import', async t => {
  const fx = await fixture(t, { hold: 'readSelectedEntry' });
  const session = await pair(fx.runtime);
  const selectedSource = await source(fx, session);
  const inventory = await savedInventory(fx, session, selectedSource);
  const pending = importSelected(fx, session, selectedSource, inventory);
  const acquired = await bounded(fx.barrier.entered);
  assert.equal(acquired.text, fx.text);
  assert.equal(acquired.sha256, hash(fx.text));
  const revoke = await call(fx.runtime, `/sources/${selectedSource.id}/revoke`, { method: 'POST', headers: authenticated(fx.runtime, session), body: { expected_revision: selectedSource.revision } });
  assert.equal(revoke.status, 200);
  assert.equal(revoke.data.source.state, 'revoked');
  fx.barrier.release();
  discarded(await pending, 403, 'CONSENT_REQUIRED', fx.text);
  const saved = await persisted(fx);
  assert.deepEqual(saved.sources, [{ id: selectedSource.id, state: 'revoked', revision: 2 }]);
  assert.deepEqual(saved.inventories, [{ id: inventory.id, source_id: selectedSource.id }]);
  assert.deepEqual(saved.entries, []);
});

test('SR04: the same real acquisition barrier commits exact text when authorization remains valid', async t => {
  const fx = await fixture(t, { hold: 'readSelectedEntry' });
  const session = await pair(fx.runtime);
  const selectedSource = await source(fx, session);
  const inventory = await savedInventory(fx, session, selectedSource);
  const pending = importSelected(fx, session, selectedSource, inventory);
  const acquired = await bounded(fx.barrier.entered);
  assert.equal(acquired.text, fx.text);
  fx.barrier.release();
  const response = await pending;
  assert.equal(response.status, 201);
  assert.equal(response.data.entry.text, fx.text);
  assert.equal(response.data.entry.sha256, hash(fx.text));
  const saved = await persisted(fx);
  assert.deepEqual(saved.inventories, [{ id: inventory.id, source_id: selectedSource.id }]);
  assert.equal(saved.entries.length, 1);
  assert.deepEqual(saved.entries[0], {
    id: response.data.entry.id, source_id: selectedSource.id, inventory_id: inventory.id,
    entry_id: inventory.inventory.entries[0].id, text: fx.text, sha256: hash(fx.text),
    version: inventory.inventory.entries[0].snapshot.version,
  });
});

test('SR05: cancelling HTTP after a real selected-file read discards its completed result', async t => {
  const fx = await fixture(t, { hold: 'readSelectedEntry' });
  const session = await pair(fx.runtime);
  const selectedSource = await source(fx, session);
  const inventory = await savedInventory(fx, session, selectedSource);
  const controller = new AbortController();
  const pending = importSelected(fx, session, selectedSource, inventory, { signal: controller.signal });
  const acquired = await bounded(fx.barrier.entered);
  assert.equal(acquired.text, fx.text);
  assert.equal(acquired.sha256, hash(fx.text));
  const nativeSignal = fx.barrier.signal();
  assert(nativeSignal instanceof AbortSignal);
  controller.abort();
  await assert.rejects(pending, { code: 'ABORT_ERR' });
  // Wait for the actual server response-close cancellation, not a guessed
  // delay. The completed native result is still held while this fires.
  if (!nativeSignal.aborted) await bounded(new Promise(resolve => nativeSignal.addEventListener('abort', resolve, { once: true })));
  assert.equal(nativeSignal.aborted, true);
  fx.barrier.release();
  const current = await call(fx.runtime, '/sources', { headers: authenticated(fx.runtime, session) });
  assert.equal(current.status, 200);
  assert.deepEqual(current.data.entries, []);
  const saved = await persisted(fx);
  assert.deepEqual(saved.inventories, [{ id: inventory.id, source_id: selectedSource.id }]);
  assert.deepEqual(saved.entries, []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, lstat, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';

// Every test creates a new fixture parent. No default data root, cloud key,
// user folder, browser cookie jar or existing running app is touched.
const PREFIX = 'learnbridge-http-fixture-';
const BASE = '/api/local/v1';

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), PREFIX)));
  const identity = await lstat(root);
  const marker = randomUUID();
  await writeFile(join(root, '.fixture-marker'), marker, { mode: 0o600, flag: 'wx' });
  const dataRoot = join(root, 'workspace');
  const runtimes = [];
  t.after(async () => {
    for (const runtime of runtimes.reverse()) await runtime.close();
    const current = await lstat(root);
    assert.equal(basename(root).startsWith(PREFIX), true);
    assert.equal(current.isDirectory() && !current.isSymbolicLink(), true);
    assert.equal(current.dev, identity.dev);
    assert.equal(current.ino, identity.ino);
    assert.equal(await readFile(join(root, '.fixture-marker'), 'utf8'), marker);
    await rm(root, { recursive: true });
  });
  const start = async (override = {}) => {
    const runtime = await startRuntime({ dataRoot, port: 0, ...options, ...override });
    runtimes.push(runtime);
    return runtime;
  };
  return { root, dataRoot, start, runtime: await start() };
}

function call(runtime, path, { method = 'GET', headers = {}, body, rawBody } = {}) {
  const origin = new URL(runtime.origin);
  const text = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: origin.port, path, method,
      headers: { ...(text === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }), ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = JSON.parse(text); } catch { data = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, data });
      });
    });
    req.setTimeout(3000, () => req.destroy(new Error('Fixture request timed out.')));
    req.on('error', reject);
    req.end(text);
  });
}

async function pair(runtime) {
  const code = runtime.createPairingCode();
  assert.equal(typeof code, 'string');
  assert(code.length >= 16);
  const result = await call(runtime, `${BASE}/pair`, { method: 'POST', headers: { origin: runtime.origin }, body: { code } });
  assert.equal(result.status, 200);
  assert.equal(typeof result.data.nonce, 'string');
  assert(result.data.nonce.length >= 16);
  const setCookie = result.headers['set-cookie'];
  assert(Array.isArray(setCookie) && setCookie.length === 1);
  assert.match(setCookie[0], /;\s*HttpOnly/i);
  assert.match(setCookie[0], /;\s*SameSite=Strict/i);
  assert.match(setCookie[0], /;\s*Path=\//i);
  assert.match(result.headers['cache-control'], /no-store/);
  return { code, nonce: result.data.nonce, cookie: setCookie[0].split(';')[0] };
}

function authenticated(session, runtime, mutation = false) {
  return { cookie: session.cookie, 'x-learnbridge-nonce': session.nonce,
    ...(mutation ? { origin: runtime.origin } : {}) };
}

function denied(result) {
  assert(result.status >= 400 && result.status <= 499, `Expected refusal, observed HTTP ${result.status}.`);
}

function heldPost(runtime, path, headers, body) {
  const origin = new URL(runtime.origin);
  const raw = JSON.stringify(body);
  const split = Math.max(1, Math.floor(raw.length / 2));
  let req;
  const response = new Promise((resolve, reject) => {
    req = request({ hostname: '127.0.0.1', port: origin.port, path, method: 'POST', headers: {
      ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw),
    } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = JSON.parse(text); } catch { data = null; }
        resolve({ status: res.statusCode, data, text });
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('Held fixture request timed out.')));
    req.flushHeaders();
    req.write(raw.slice(0, split));
  });
  // Attach a rejection handler immediately, even before the fixture resumes
  // the body, so a deliberately closed socket cannot become unhandled.
  response.catch(() => {});
  return { response, finish: () => req.end(raw.slice(split)), destroy: () => req.destroy() };
}

async function tasks(runtime, session) {
  const result = await call(runtime, `${BASE}/tasks`, { headers: authenticated(session, runtime) });
  assert.equal(result.status, 200);
  assert(Array.isArray(result.data.items));
  return result.data.items;
}

async function createTask(runtime, session, title) {
  const result = await call(runtime, `${BASE}/tasks`, { method: 'POST', headers: authenticated(session, runtime, true), body: { title } });
  assert.equal(result.status, 201);
  const matches = (await tasks(runtime, session)).filter(item => item.title === title);
  assert.equal(matches.length, 1);
  return matches[0];
}

test('LF01: a pairing code issues one private session and cannot be replayed', async t => {
  const { runtime } = await fixture(t);
  const session = await pair(runtime);
  const replay = await call(runtime, `${BASE}/pair`, { method: 'POST', headers: { origin: runtime.origin }, body: { code: session.code } });
  denied(replay);
  assert.equal(replay.headers['set-cookie'], undefined);
  const privateRead = await call(runtime, `${BASE}/status`, { headers: authenticated(session, runtime) });
  assert.equal(privateRead.status, 200);
  assert.equal(privateRead.data.edition, 'local');
  assert.match(privateRead.headers['cache-control'], /no-store/);
  assert.equal(privateRead.text.includes(session.code), false);
  assert.equal(privateRead.text.includes(session.cookie), false);
});

test('LF02: expired pairing codes and query-only codes issue no session', async t => {
  const { runtime } = await fixture(t, { pairingTtlMs: 60 });
  const code = runtime.createPairingCode();
  await delay(100);
  const expired = await call(runtime, `${BASE}/pair`, { method: 'POST', headers: { origin: runtime.origin }, body: { code } });
  denied(expired);
  assert.equal(expired.headers['set-cookie'], undefined);
  const queryOnly = await call(runtime, `${BASE}/pair?code=${encodeURIComponent(runtime.createPairingCode())}`, { method: 'POST', headers: { origin: runtime.origin }, body: {} });
  denied(queryOnly);
  assert.equal(queryOnly.headers['set-cookie'], undefined);
});

test('LF01: bounded pairing attempts fail closed even when the next code is correct', async t => {
  const { runtime } = await fixture(t);
  const code = runtime.createPairingCode();
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await call(runtime, `${BASE}/pair`, { method: 'POST', headers: { origin: runtime.origin }, body: { code: `wrong-fixture-${attempt}` } });
    denied(result);
    assert.equal(result.headers['set-cookie'], undefined);
  }
  const limited = await call(runtime, `${BASE}/pair`, { method: 'POST', headers: { origin: runtime.origin }, body: { code } });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['set-cookie'], undefined);
});

test('LF03: every implemented private resource rejects an unpaired request', async t => {
  const { runtime } = await fixture(t);
  const id = randomUUID();
  const health = await call(runtime, '/health');
  assert.equal(health.status, 200);
  assert.deepEqual(Object.keys(health.data).sort(), ['alive', 'edition', 'version']);
  assert.equal(health.data.alive, true);
  for (const [method, path, body] of [
    ['GET', '/session'], ['GET', '/status'], ['GET', '/tasks'], ['GET', '/documents'],
    ['GET', `/tasks/${id}`], ['GET', `/documents/${id}`], ['GET', `/documents/${id}/revisions`],
    ['GET', '/documents/search?q=private'],
    ['POST', '/tasks', { title: 'Must never be saved' }],
    ['PATCH', `/tasks/${id}`, { expected_revision: 1, title: 'Must never update' }],
    ['DELETE', `/tasks/${id}`, { expected_revision: 1 }],
    ['POST', '/documents', { title: 'Private', content: 'Must never be saved' }],
    ['PATCH', `/documents/${id}`, { expected_revision: 1, content: 'Must never update' }],
    ['DELETE', `/documents/${id}`, { expected_revision: 1 }], ['POST', '/logout', {}],
  ]) {
    const result = await call(runtime, `${BASE}${path}`, { method, headers: { origin: runtime.origin,
      'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }, body });
    assert.equal(result.status, 401, `${method} ${path} must authenticate before reading/mutating.`);
  }
  const session = await pair(runtime);
  assert.deepEqual(await tasks(runtime, session), []);
  const documents = await call(runtime, `${BASE}/documents`, { headers: authenticated(session, runtime) });
  assert.deepEqual(documents.data.items, []);
});

test('LF04/LF05: Host, Origin, Fetch Metadata and nonce checks reject forgeries while valid reads may omit Origin', async t => {
  const { runtime } = await fixture(t);
  const session = await pair(runtime);
  const before = await createTask(runtime, session, 'Synthetic task survives forged requests');
  const legitimate = await call(runtime, `${BASE}/tasks`, { headers: authenticated(session, runtime) });
  assert.equal(legitimate.status, 200);
  const port = new URL(runtime.origin).port;
  for (const attack of [
    { host: `evil.invalid:${port}` }, { host: '127.0.0.1:1' }, { host: `localhost:${port}` },
    { origin: 'https://attacker.invalid' }, { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' }, { 'x-learnbridge-nonce': 'wrong-nonce' },
  ]) {
    denied(await call(runtime, `${BASE}/tasks`, { headers: { ...authenticated(session, runtime), ...attack } }));
  }
  denied(await call(runtime, `${BASE}/tasks`, { headers: { cookie: session.cookie } }));
  assert.equal((await call(runtime, `${BASE}/tasks`, { headers: { ...authenticated(session, runtime),
    cookie: 'lb_local_session=' + 'A'.repeat(43) } })).status, 401);
  assert.equal((await call(runtime, `${BASE}/tasks`, { headers: { ...authenticated(session, runtime),
    cookie: `${session.cookie}; ${session.cookie}` } })).status, 401);
  for (const attack of [
    { origin: 'https://attacker.invalid' }, { origin: undefined },
    { 'sec-fetch-site': 'cross-site' }, { 'x-learnbridge-nonce': 'wrong-nonce' },
  ]) {
    const headers = { ...authenticated(session, runtime, true), ...attack };
    for (const key of Object.keys(headers)) if (headers[key] === undefined) delete headers[key];
    denied(await call(runtime, `${BASE}/tasks/${before.id}`, { method: 'PATCH', headers,
      body: { expected_revision: before.revision, title: 'Forged edit' } }));
  }
  assert.deepEqual(await tasks(runtime, session), [before]);
});

test('LF04: session bootstrap only discloses its nonce to a same-origin browser request', async t => {
  const { runtime } = await fixture(t);
  const session = await pair(runtime);
  const valid = await call(runtime, `${BASE}/session`, { headers: { cookie: session.cookie,
    'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' } });
  assert.equal(valid.status, 200);
  assert.equal(valid.data.nonce, session.nonce);
  for (const headers of [
    { cookie: session.cookie },
    { cookie: session.cookie, origin: 'https://attacker.invalid', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' },
    { cookie: session.cookie, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' },
    { cookie: session.cookie, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' },
  ]) denied(await call(runtime, `${BASE}/session`, { headers }));
});

test('LF06: logout invalidates the cookie and nonce rather than only clearing the UI', async t => {
  const { runtime } = await fixture(t);
  const session = await pair(runtime);
  const result = await call(runtime, `${BASE}/logout`, { method: 'POST', headers: authenticated(session, runtime, true), body: {} });
  assert.equal(result.status, 200);
  assert.match(result.headers['set-cookie'][0], /Max-Age=0/i);
  assert.equal((await call(runtime, `${BASE}/tasks`, { headers: authenticated(session, runtime) })).status, 401);
  assert.equal((await call(runtime, `${BASE}/session`, { headers: { cookie: session.cookie,
    'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' } })).status, 401);
});

test('LF06: server-side session expiry refuses a still-present cookie', async t => {
  const { runtime } = await fixture(t, { sessionTtlMs: 500 });
  const session = await pair(runtime);
  assert.equal((await call(runtime, `${BASE}/status`, { headers: authenticated(session, runtime) })).status, 200);
  await delay(600);
  assert.equal((await call(runtime, `${BASE}/status`, { headers: authenticated(session, runtime) })).status, 401);
});

for (const [name, route, body] of [
  ['task', '/tasks', { title: 'Held task must not save after logout' }],
  ['document', '/documents', { title: 'Held note', content: 'Held document must not save after logout' }],
]) {
  test(`LF19: a partial ${name} request cannot commit after its session logs out`, async t => {
    const { runtime } = await fixture(t);
    const session = await pair(runtime);
    const held = heldPost(runtime, `${BASE}${route}`, authenticated(session, runtime, true), body);
    try {
      await delay(30);
      const logout = await call(runtime, `${BASE}/logout`, { method: 'POST', headers: authenticated(session, runtime, true), body: {} });
      assert.equal(logout.status, 200);
      held.finish();
      assert.equal((await held.response).status, 401);
      const next = await pair(runtime);
      assert.deepEqual(await tasks(runtime, next), []);
      const documents = await call(runtime, `${BASE}/documents`, { headers: authenticated(next, runtime) });
      assert.deepEqual(documents.data.items, []);
    } finally { held.destroy(); }
  });
}

test('LF19: a partial document request cannot commit after server-side session expiry', async t => {
  const { runtime } = await fixture(t, { sessionTtlMs: 500 });
  const session = await pair(runtime);
  assert.equal((await call(runtime, `${BASE}/status`, { headers: authenticated(session, runtime) })).status, 200);
  const held = heldPost(runtime, `${BASE}/documents`, authenticated(session, runtime, true),
    { title: 'Expired request', content: 'Must remain unsaved after its session expires' });
  try {
    await delay(600);
    held.finish();
    assert.equal((await held.response).status, 401);
    const next = await pair(runtime);
    const documents = await call(runtime, `${BASE}/documents`, { headers: authenticated(next, runtime) });
    assert.deepEqual(documents.data.items, []);
  } finally { held.destroy(); }
});

test('LF07: task and immutable document content survive reopening the actual runtime', async t => {
  const fx = await fixture(t);
  const session = await pair(fx.runtime);
  const task = await createTask(fx.runtime, session, 'Synthetic restart persistence');
  const content = '# Synthetic note\n\nExact Unicode: λ, résumé, 🧠.\n';
  const created = await call(fx.runtime, `${BASE}/documents`, { method: 'POST',
    headers: authenticated(session, fx.runtime, true), body: { title: 'Synthetic note', content, kind: 'study' } });
  assert.equal(created.status, 201);
  const list = await call(fx.runtime, `${BASE}/documents`, { headers: authenticated(session, fx.runtime) });
  assert.equal(list.data.items.length, 1);
  const document = list.data.items[0];
  const read = await call(fx.runtime, `${BASE}/documents/${document.id}`, { headers: authenticated(session, fx.runtime) });
  assert.equal(read.status, 200);
  assert.equal(read.data.content, content);
  assert.equal(read.data.sha256, createHash('sha256').update(content).digest('hex'));
  await fx.runtime.close();
  const restarted = await fx.start();
  const next = await pair(restarted);
  assert.deepEqual(await tasks(restarted, next), [task]);
  const reopened = await call(restarted, `${BASE}/documents/${document.id}`, { headers: authenticated(next, restarted) });
  assert.equal(reopened.status, 200);
  assert.deepEqual(reopened.data, read.data);
  assert.equal((await call(restarted, `${BASE}/tasks`, { headers: authenticated(session, restarted) })).status, 401);
});

test('LF08/LF09: concurrent task edits cannot overwrite, and caller ownership cannot be injected', async t => {
  const { runtime } = await fixture(t);
  const session = await pair(runtime);
  const task = await createTask(runtime, session, 'Synthetic revision fixture');
  const updates = await Promise.all(['First competing edit', 'Second competing edit'].map(title =>
    call(runtime, `${BASE}/tasks/${task.id}`, { method: 'PATCH', headers: authenticated(session, runtime, true),
      body: { expected_revision: task.revision, title } })));
  assert.deepEqual(updates.map(item => item.status).sort(), [200, 409]);
  const [stored] = await tasks(runtime, session);
  assert.equal(stored.revision, task.revision + 1);
  assert(['First competing edit', 'Second competing edit'].includes(stored.title));
  assert.equal(stored.student_id, task.student_id);
  denied(await call(runtime, `${BASE}/tasks`, { method: 'POST', headers: authenticated(session, runtime, true),
    body: { title: 'Wrong owner', student_id: randomUUID() } }));
  denied(await call(runtime, `${BASE}/tasks/${task.id}`, { method: 'PATCH', headers: authenticated(session, runtime, true),
    body: { expected_revision: stored.revision, student_id: randomUUID() } }));
  assert.deepEqual(await tasks(runtime, session), [stored]);
});

test('LF08: retrying a task creation with one idempotency key returns one durable task', async t => {
  const { runtime } = await fixture(t);
  const session = await pair(runtime);
  const headers = { ...authenticated(session, runtime, true), 'idempotency-key': randomUUID() };
  const first = await call(runtime, `${BASE}/tasks`, { method: 'POST', headers, body: { title: 'Single synthetic task' } });
  const repeated = await call(runtime, `${BASE}/tasks`, { method: 'POST', headers, body: { title: 'Single synthetic task' } });
  assert.equal(first.status, 201);
  assert.equal(repeated.status, 201);
  assert.deepEqual(repeated.data, first.data);
  const changed = await call(runtime, `${BASE}/tasks`, { method: 'POST', headers, body: { title: 'Changed payload must not reuse the key' } });
  assert.equal(changed.status, 409);
  assert.deepEqual(await tasks(runtime, session), [first.data.task]);
});

test('LF08: document revisions preserve prior content and refuse a stale edit or deletion', async t => {
  const { runtime } = await fixture(t);
  const session = await pair(runtime);
  assert.equal((await call(runtime, `${BASE}/documents`, { method: 'POST', headers: authenticated(session, runtime, true),
    body: { title: 'Revision note', content: 'Original synthetic text' } })).status, 201);
  const list = await call(runtime, `${BASE}/documents`, { headers: authenticated(session, runtime) });
  const document = list.data.items[0];
  const updated = await call(runtime, `${BASE}/documents/${document.id}`, { method: 'PATCH', headers: authenticated(session, runtime, true),
    body: { expected_revision: document.revision, content: 'Reviewed synthetic text' } });
  assert.equal(updated.status, 200);
  const stale = await call(runtime, `${BASE}/documents/${document.id}`, { method: 'PATCH', headers: authenticated(session, runtime, true),
    body: { expected_revision: document.revision, content: 'Stale text must not overwrite' } });
  assert.equal(stale.status, 409);
  const staleDelete = await call(runtime, `${BASE}/documents/${document.id}`, { method: 'DELETE', headers: authenticated(session, runtime, true),
    body: { expected_revision: document.revision } });
  assert.equal(staleDelete.status, 409);
  const read = await call(runtime, `${BASE}/documents/${document.id}`, { headers: authenticated(session, runtime) });
  assert.equal(read.data.content, 'Reviewed synthetic text');
  const revisions = await call(runtime, `${BASE}/documents/${document.id}/revisions`, { headers: authenticated(session, runtime) });
  assert.equal(revisions.status, 200);
  assert.equal(revisions.data.items.length, 2);
  assert.equal(revisions.data.items[0].sha256, createHash('sha256').update('Original synthetic text').digest('hex'));
  assert.equal(revisions.data.items[1].sha256, createHash('sha256').update('Reviewed synthetic text').digest('hex'));
});

test('LF15: malformed, oversized and prototype-shaped requests return bounded errors without private content', async t => {
  const { runtime } = await fixture(t);
  const session = await pair(runtime);
  const canary = `FIXTURE_PRIVATE_CANARY_${randomUUID()}`;
  for (const rawBody of [
    `${canary}{invalid-json`,
    JSON.stringify({ title: canary, __proto__: null, unexpected: canary }),
    `{"title":"${canary}","__proto__":{"student_id":"${randomUUID()}"}}`,
    JSON.stringify({ title: canary, content: 'x'.repeat(2_000_000) }),
  ]) {
    const result = await call(runtime, `${BASE}/tasks`, { method: 'POST', headers: authenticated(session, runtime, true), rawBody });
    denied(result);
    assert.equal(result.text.includes(canary), false);
    assert.equal(result.text.includes(session.nonce), false);
    assert.equal(result.text.includes(session.cookie), false);
    assert(result.text.length < 2000);
  }
  assert.deepEqual(await tasks(runtime, session), []);
});

test('LF03: static public paths cannot expose the database or a private document', async t => {
  const { runtime } = await fixture(t);
  const session = await pair(runtime);
  const content = `FIXTURE_DOCUMENT_CONTENT_${randomUUID()}`;
  assert.equal((await call(runtime, `${BASE}/documents`, { method: 'POST', headers: authenticated(session, runtime, true),
    body: { title: 'Private fixture', content } })).status, 201);
  for (const path of ['/learnbridge.sqlite', '/writer.lock', '/runtime.json', '/manifest.json',
    '/../learnbridge.sqlite', '/%2e%2e/learnbridge.sqlite', '/api/local/v1/../learnbridge.sqlite']) {
    const result = await call(runtime, path);
    denied(result);
    assert.equal(result.text.includes(content), false);
    assert.equal(result.text.startsWith('SQLite format 3'), false);
    assert.equal(result.text.includes(session.nonce), false);
  }
});

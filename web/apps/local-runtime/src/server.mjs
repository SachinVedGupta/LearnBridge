import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LocalStore } from '@learnbridge/local-storage';
import { LearnBridgeError } from '@learnbridge/core';
import { assertLocalRequest, createSessionPolicy, HttpError, plainBody, readJson } from './policy.mjs';
import { startControl } from './ipc.mjs';

export const LOCAL_VERSION = '0.1.0';
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const publicRoot = new URL('../../local/public/', import.meta.url);
const builtRoot = new URL('../../local/dist/', import.meta.url);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
const base = '/api/local/v1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const notFound = () => { throw new HttpError(404, 'INVALID_INPUT', 'The local record or route is unavailable.'); };
const methodError = () => { throw new HttpError(405, 'UNSUPPORTED', 'This operation is unavailable.'); };
function id(value) { if (!uuid.test(value)) notFound(); return value; }
function noQuery(url) { if (url.search) throw new HttpError(400, 'INVALID_INPUT', 'This route does not accept query parameters.'); }
function found(value) { if (!value) notFound(); return value; }
function idempotency(request) {
  const key = request.headers['idempotency-key'];
  if (key !== undefined && (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(key))) {
    throw new HttpError(400, 'INVALID_INPUT', 'Invalid idempotency key.');
  }
  return key === undefined ? {} : { idempotencyKey: key };
}
function documentResult(value) {
  return { document: value.document, content: value.text, sha256: value.sha256, revision: value.document.current_revision };
}
function setHeaders(response) {
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'");
}
function json(response, status, value) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(value));
}
function failure(response, error) {
  if (response.headersSent || response.destroyed) return;
  if (error instanceof HttpError) return json(response, error.status, { error: { code: error.code, message: error.message } });
  if (error instanceof LearnBridgeError) {
    const statuses = { AUTH_REQUIRED: 401, CONSENT_REQUIRED: 403, SCOPE_DENIED: 403, REVISION_CONFLICT: 409,
      VERSION_MISMATCH: 409, RATE_LIMITED: 429, INVALID_INPUT: 400, UNSUPPORTED: 501, BUDGET_EXCEEDED: 413 };
    return json(response, statuses[error.code] || 500, { error: error.toJSON() });
  }
  json(response, 500, { error: { code: 'PROVIDER_FAILURE', message: 'The local operation could not be completed.' } });
}

/** Independent local edition. Never trusts a request student ID or hosted cookie. */
export async function startRuntime({ dataRoot, port = 3210, sessionTtlMs, pairingTtlMs } = {}) {
  if (typeof dataRoot !== 'string' || !Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid local runtime options.');
  const store = LocalStore.open({ root: dataRoot, repositoryRoot, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
  let policy;
  let control;
  let closing = false;
  let closePromise;
  const activeBackups = new Set();
  let resolveClosed;
  const closed = new Promise(resolveDone => { resolveClosed = resolveDone; });
  let origin;
  const status = () => {
    const integrity = store.integrity();
    return {
      edition: 'local', version: LOCAL_VERSION, student_id: store.identity.student_id,
      student: { id: store.identity.student_id }, integrity: integrity.integrity === 'ok',
      storage: { healthy: integrity.integrity === 'ok', schema_version: integrity.schema_version },
      privacy: { local_only: true, source_discovery_enabled: false, cloud_processing_enabled: false },
      capabilities: [
        { id: 'tasks', label: 'Tasks', state: 'available', detail: 'Manual tasks with revision checks and private local saves.' },
        { id: 'notes', label: 'Notes', state: 'available', detail: 'Multiple text notes with immutable revisions and verified hashes.' },
        { id: 'backup', label: 'Backup and restore', state: 'available', detail: 'Use the local launcher commands to make a snapshot or restore into a fresh workspace.' },
        { id: 'mcp', label: 'Agent MCP bridge', state: 'unsupported', detail: 'Official-agent integration is the next slice. No model is called by this foundation.' },
        { id: 'sources', label: 'Connected sources and Avenue', state: 'unsupported', detail: 'Source onboarding and connector reads are not installed. No private folders are scanned.' },
        { id: 'profile', label: 'Student profile', state: 'unsupported', detail: 'Reviewed profile onboarding will follow the private foundation.' },
      ],
    };
  };
  const server = createServer(async (request, response) => {
    setHeaders(response);
    try {
      if (closing) throw new HttpError(503, 'OFFLINE', 'The local runtime is stopping.');
      assertLocalRequest(request, origin);
      const url = new URL(request.url, origin);
      if (url.pathname === '/health') {
        noQuery(url);
        if (request.method !== 'GET' && request.method !== 'HEAD') methodError();
        return json(response, 200, { alive: true, edition: 'local', version: LOCAL_VERSION });
      }
      if (!url.pathname.startsWith(base + '/')) {
        noQuery(url);
        const asset = assets.get(url.pathname);
        if (!asset) notFound();
        if (request.method !== 'GET' && request.method !== 'HEAD') methodError();
        const root = existsSync(new URL('index.html', builtRoot)) ? builtRoot : publicRoot;
        const bytes = readFileSync(new URL(asset[0], root));
        response.statusCode = 200;
        response.setHeader('Content-Type', asset[1]);
        return response.end(request.method === 'HEAD' ? undefined : bytes);
      }
      const route = url.pathname.slice(base.length);
      const mutation = ['POST', 'PATCH', 'DELETE', 'PUT'].includes(request.method);
      if (route === '/pair') {
        noQuery(url);
        if (request.method !== 'POST') methodError();
        assertLocalRequest(request, origin, { mutation: true });
        const body = plainBody(await readJson(request, 4096), ['code'], ['code']);
        const session = policy.pair(request, body.code);
        response.setHeader('Set-Cookie', session.cookie);
        return json(response, 200, { nonce: session.nonce, expires_at: session.expires_at });
      }
      const session = policy.authenticate(request, { mutation, bootstrap: route === '/session' && request.method === 'GET' });
      const privateBody = async (allowed, required = [], maxBytes = 300_000) => {
        const value = await readJson(request, maxBytes);
        // A slow body must not preserve access after expiry/logout/shutdown.
        if (closing) throw new HttpError(503, 'OFFLINE', 'The local runtime is stopping.');
        policy.authenticate(request, { mutation: true });
        return plainBody(value, allowed, required);
      };
      if (route === '/session') {
        noQuery(url);
        if (request.method !== 'GET') methodError();
        return json(response, 200, session);
      }
      if (route === '/logout') {
        noQuery(url);
        if (request.method !== 'POST') methodError();
        await privateBody([], [], 4096);
        response.setHeader('Set-Cookie', policy.logout(request));
        return json(response, 200, { logged_out: true });
      }
      if (route === '/status') {
        noQuery(url);
        if (request.method !== 'GET') methodError();
        return json(response, 200, status());
      }
      if (route === '/tasks') {
        noQuery(url);
        if (request.method === 'GET') return json(response, 200, { items: store.listTasks() });
        if (request.method === 'POST') {
          const body = await privateBody(['title', 'deadline', 'course_label', 'effort_minutes'], ['title'], 16_384);
          return json(response, 201, { task: store.createTask(body, idempotency(request)) });
        }
        methodError();
      }
      const taskRoute = /^\/tasks\/([^/]+)$/.exec(route);
      if (taskRoute) {
        noQuery(url);
        const taskId = id(taskRoute[1]);
        if (request.method === 'GET') return json(response, 200, { task: found(store.getTask(taskId)) });
        if (request.method === 'PATCH') {
          const body = await privateBody(['expected_revision', 'title', 'status', 'deadline', 'course_label', 'effort_minutes'], ['expected_revision'], 16_384);
          const { expected_revision, ...patch } = body;
          if (!Object.keys(patch).length) throw new HttpError(400, 'INVALID_INPUT', 'Provide at least one changed task field.');
          return json(response, 200, { task: store.updateTask(taskId, patch, expected_revision) });
        }
        if (request.method === 'DELETE') {
          const body = await privateBody(['expected_revision'], ['expected_revision'], 4096);
          store.deleteTask(taskId, body.expected_revision);
          return json(response, 200, { deleted: true });
        }
        methodError();
      }
      if (route === '/documents') {
        noQuery(url);
        if (request.method === 'GET') return json(response, 200, { items: store.listDocuments() });
        if (request.method === 'POST') {
          const body = await privateBody(['title', 'content', 'kind', 'academic_policy'], ['title', 'content']);
          const { content, ...input } = body;
          return json(response, 201, documentResult(store.createDocument({ ...input, text: content }, idempotency(request))));
        }
        methodError();
      }
      if (route === '/documents/search') {
        if (request.method !== 'GET') methodError();
        if ([...url.searchParams.keys()].some(key => key !== 'q') || url.searchParams.getAll('q').length !== 1) {
          throw new HttpError(400, 'INVALID_INPUT', 'Provide one note search query.');
        }
        return json(response, 200, { items: store.searchDocuments(url.searchParams.get('q')) });
      }
      const docRoute = /^\/documents\/([^/]+)(\/revisions)?$/.exec(route);
      if (docRoute) {
        noQuery(url);
        const docId = id(docRoute[1]);
        if (docRoute[2]) {
          if (request.method !== 'GET') methodError();
          return json(response, 200, { items: store.listDocumentRevisions(docId).map(item => item.revision) });
        }
        if (request.method === 'GET') return json(response, 200, documentResult(found(store.getDocument(docId))));
        if (request.method === 'PATCH') {
          const body = await privateBody(['expected_revision', 'title', 'content', 'kind', 'academic_policy'], ['expected_revision']);
          const { expected_revision, content, ...patch } = body;
          if (content !== undefined) patch.text = content;
          if (!Object.keys(patch).length) throw new HttpError(400, 'INVALID_INPUT', 'Provide at least one changed note field.');
          return json(response, 200, documentResult(store.updateDocument(docId, patch, expected_revision)));
        }
        if (request.method === 'DELETE') {
          const body = await privateBody(['expected_revision'], ['expected_revision'], 4096);
          store.deleteDocument(docId, body.expected_revision);
          return json(response, 200, { deleted: true });
        }
        methodError();
      }
      notFound();
    } catch (error) { failure(response, error); }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1000;
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    policy?.clear();
    closePromise = (async () => {
      try {
        if (server.listening) {
          const stopped = new Promise(done => server.close(done));
          const drainTimeout = setTimeout(() => server.closeAllConnections(), 1500);
          server.closeIdleConnections();
          try { await stopped; } finally { clearTimeout(drainTimeout); }
        }
        await Promise.allSettled([...activeBackups]);
        await control?.close();
      } finally { try { store.close(); } finally { resolveClosed(); } }
    })();
    return closePromise;
  };
  try {
    async function listen(candidate) {
      return new Promise((ready, reject) => {
        server.once('error', reject);
        server.listen(candidate, '127.0.0.1', () => { server.off('error', reject); ready(); });
      });
    }
    try { await listen(port); }
    catch (error) { if (error.code !== 'EADDRINUSE' || port === 0) throw error; await listen(0); }
    origin = 'http://127.0.0.1:' + server.address().port;
    policy = createSessionPolicy({ origin, sessionTtlMs, pairingTtlMs });
    control = await startControl({ root: store.root, origin, onCommand: async (command, data) => {
      if (command === 'status') { if (data !== undefined) throw new Error('Invalid control request'); return status(); }
      if (command === 'stop') {
        if (data !== undefined) throw new Error('Invalid control request');
        closing = true;
        setTimeout(() => { void close().catch(() => {}); }, 100);
        return { stopping: true };
      }
      if (command === 'backup') {
        if (closing) throw new Error('The local runtime is stopping.');
        plainBody(data, ['output'], ['output']);
        if (typeof data.output !== 'string' || data.output.length > 2000) throw new Error('Invalid control request');
        const operation = store.backup(data.output);
        activeBackups.add(operation);
        try { return await operation; } finally { activeBackups.delete(operation); }
      }
      throw new Error('Unsupported control request');
    } });
    return { origin, address: server.address(), dataRoot: store.root, createPairingCode: () => policy.createPairingCode(), close, closed };
  } catch (error) { await close(); throw error; }
}

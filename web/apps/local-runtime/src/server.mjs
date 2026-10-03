import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LocalStore } from '@learnbridge/local-storage';
import { LearnBridgeError } from '@learnbridge/core';
import { assertLocalRequest, createSessionPolicy, HttpError, plainBody, readJson } from './policy.mjs';
import { startControl } from './ipc.mjs';
import { describeRoot, inventorySource, readSelectedEntry, probeSourceCapability } from '../../../packages/local-sources/src/index.mjs';
import { normalizeAcademicExport, AcademicError } from '../../../packages/local-academic/src/index.mjs';
import { randomUUID } from 'node:crypto';

export const LOCAL_VERSION = '0.2.0';
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
  if (error instanceof AcademicError) {
    const statuses = { INVALID_INPUT: 400, SCOPE_DENIED: 403, AUTH_REQUIRED: 401, AUTH_EXPIRED: 401, UNSUPPORTED: 501, BUDGET_EXCEEDED: 413, CANCELLED: 409, TIMEOUT: 504 };
    return json(response, statuses[error.code] || 502, { error: error.toJSON() });
  }
  json(response, 500, { error: { code: 'PROVIDER_FAILURE', message: 'The local operation could not be completed.' } });
}

/** Independent local edition. Never trusts a request student ID or hosted cookie. */
export async function startRuntime({ dataRoot, port = 3210, sessionTtlMs, pairingTtlMs,
  // Trusted programmatic dependency injection for native acquisition barriers.
  // The launcher/HTTP/MCP surfaces never accept an adapter or executable.
  sourceAdapter = { describeRoot, inventorySource, readSelectedEntry, probeSourceCapability } } = {}) {
  if (typeof dataRoot !== 'string' || !Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid local runtime options.');
  const store = LocalStore.open({ root: dataRoot, repositoryRoot, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
  let policy;
  let control;
  let closing = false;
  let closePromise;
  const activeBackups = new Set();
  const sourceOperations = new Set();
  const academicPreviews = new Map();
  const sourceCapability = await sourceAdapter.probeSourceCapability();
  let resolveClosed;
  const closed = new Promise(resolveDone => { resolveClosed = resolveDone; });
  let origin;
  const status = () => {
    const integrity = store.integrity();
    return {
      edition: 'local', version: LOCAL_VERSION, student_id: store.identity.student_id,
      student: { id: store.identity.student_id }, integrity: integrity.integrity === 'ok',
      storage: { healthy: integrity.integrity === 'ok', schema_version: integrity.schema_version },
      privacy: { local_only: true, source_discovery_enabled: false, cloud_processing_enabled: store.listAgentGrants().some(item => item.state === 'active' && Date.parse(item.expires_at) > Date.now()) },
      capabilities: [
        { id: 'tasks', label: 'Tasks', state: 'available', detail: 'Manual tasks with revision checks and private local saves.' },
        { id: 'notes', label: 'Notes', state: 'available', detail: 'Multiple text notes with immutable revisions and verified hashes.' },
        { id: 'backup', label: 'Backup and restore', state: 'available', detail: 'Use the local launcher commands to make a snapshot or restore into a fresh workspace.' },
        { id: 'mcp', label: 'Agent MCP bridge', state: 'available', detail: 'Project-scoped stdio bridge for Codex/Claude. Sharing requires a destination-specific selection; proposed tasks wait for human review. Host installation and project trust are separate.' },
        { id: 'sources', label: 'Selected local sources', state: sourceCapability.state === 'available' ? 'available' : 'unsupported', detail: 'Explicit text/Markdown folder inventory and selected imports. Requires the verified private Python runtime; no automatic laptop scan.' },
        { id: 'academic', label: 'Avenue / D2L', state: 'requires_auth', detail: 'Reviewed academic exports are supported. Live reads need a supported institution and a separately verified local student session. No university password or token is accepted here.' },
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
      const stillAuthorized = () => {
        if (closing) throw new HttpError(503, 'OFFLINE', 'The local runtime is stopping.');
        policy.authenticate(request, { mutation: true });
      };
      const sourceOperation = async callback => {
        const controller = new AbortController();
        sourceOperations.add(controller);
        const cancel = () => { if (!response.writableEnded) controller.abort(); };
        response.once('close', cancel);
        try {
          const result = await callback(controller.signal);
          if (controller.signal.aborted || response.destroyed) throw new HttpError(409, 'CANCELLED', 'The source acquisition was cancelled.');
          stillAuthorized(); return result;
        }
        finally { sourceOperations.delete(controller); response.off('close', cancel); }
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
      if (route === '/agent-grants') {
        noQuery(url);
        if (request.method === 'GET') return json(response, 200, { items: store.listAgentGrants() });
        if (request.method === 'POST') {
          const body = await privateBody(['destination', 'task_ids', 'document_ids', 'source_entry_ids', 'max_bytes', 'expires_in_minutes', 'expected_records'], ['destination', 'max_bytes', 'expires_in_minutes', 'expected_records'], 16384);
          const { expected_records, ...input } = body;
          plainBody(expected_records, ['tasks', 'documents', 'source_entries'], ['tasks', 'documents', 'source_entries']);
          for (const [kind, field] of [['tasks', 'task_ids'], ['documents', 'document_ids'], ['source_entries', 'source_entry_ids']]) {
            if (!Array.isArray(expected_records[kind]) || expected_records[kind].length > 32 || !Array.isArray(input[field]) || input[field].length !== expected_records[kind].length) throw new HttpError(400, 'INVALID_INPUT', 'Review the exact selected records.');
            const seen = new Set();
            for (const pin of expected_records[kind]) {
              plainBody(pin, ['id', 'revision'], ['id', 'revision']);
              if (!input[field].includes(pin.id) || seen.has(pin.id)) throw new HttpError(400, 'INVALID_INPUT', 'Invalid reviewed selection.');
              seen.add(pin.id);
              const value = kind === 'tasks' ? store.getTask(id(pin.id)) : kind === 'documents' ? store.getDocument(id(pin.id))?.document : store.getSourceEntry(id(pin.id));
              if (!value || value.revision !== pin.revision) throw new HttpError(409, 'REVISION_CONFLICT', 'Selection changed. Review it again.');
            }
          }
          return json(response, 201, { grant: store.createAgentGrant(input) });
        }
        methodError();
      }
      const grantRoute = /^\/agent-grants\/([^/]+)\/revoke$/.exec(route);
      if (grantRoute) {
        noQuery(url); if (request.method !== 'POST') methodError();
        const body = await privateBody(['expected_revision'], ['expected_revision'], 4096);
        return json(response, 200, { grant: store.revokeAgentGrant(id(grantRoute[1]), body.expected_revision) });
      }
      if (route === '/task-proposals') {
        noQuery(url); if (request.method !== 'GET') methodError();
        return json(response, 200, { items: store.listTaskProposals() });
      }
      const proposalRoute = /^\/task-proposals\/([^/]+)\/(accept|reject)$/.exec(route);
      if (proposalRoute) {
        noQuery(url); if (request.method !== 'POST') methodError();
        const body = await privateBody(['expected_revision', 'payload_hash'], ['expected_revision', 'payload_hash'], 4096);
        return json(response, 200, proposalRoute[2] === 'accept' ? store.acceptTaskProposal(id(proposalRoute[1]), body)
          : { proposal: store.rejectTaskProposal(id(proposalRoute[1]), body) });
      }
      if (route === '/sources') {
        noQuery(url);
        if (request.method === 'GET') return json(response, 200, { items: store.listSources(), entries: store.listSourceEntries(), capability: sourceCapability });
        if (request.method === 'POST') {
          const body = await privateBody(['path', 'label'], ['path', 'label'], 4096);
          const descriptor = await sourceOperation(() => sourceAdapter.describeRoot(body.path, { label: body.label }));
          return json(response, 201, { source: store.createSource({ label: body.label, descriptor }) });
        }
        methodError();
      }
      const entryRoute = /^\/source-entries\/([^/]+)$/.exec(route);
      if (entryRoute) {
        noQuery(url); if (request.method !== 'GET') methodError();
        return json(response, 200, { entry: found(store.getSourceEntry(id(entryRoute[1]))) });
      }
      const sourceRoute = /^\/sources\/([^/]+)\/(inventory|import|revoke)$/.exec(route);
      if (sourceRoute) {
        noQuery(url); if (request.method !== 'POST') methodError();
        const sourceId = id(sourceRoute[1]);
        if (sourceRoute[2] === 'revoke') {
          const body = await privateBody(['expected_revision'], ['expected_revision'], 4096);
          return json(response, 200, { source: store.revokeSource(sourceId, body.expected_revision) });
        }
        const body = await privateBody(sourceRoute[2] === 'inventory' ? [] : ['inventory_id', 'entry_id'], sourceRoute[2] === 'inventory' ? [] : ['inventory_id', 'entry_id'], 4096);
        const source = found(store.getSource(sourceId));
        if (source.state !== 'active') throw new HttpError(403, 'CONSENT_REQUIRED', 'This source was revoked.');
        if (sourceRoute[2] === 'inventory') {
          const inventory = await sourceOperation(signal => sourceAdapter.inventorySource(source.descriptor, { signal }));
          return json(response, 200, { inventory: store.saveSourceInventory(sourceId, inventory) });
        }
        const saved = found(store.getSourceInventory(id(body.inventory_id)));
        if (saved.source_id !== sourceId) notFound();
        const value = await sourceOperation(signal => sourceAdapter.readSelectedEntry(source.descriptor, saved.inventory, id(body.entry_id), { signal, maxBytes: 48000 }));
        // Recheck source revocation after the acquisition worker yields.
        if (store.getSource(sourceId)?.state !== 'active') throw new HttpError(403, 'CONSENT_REQUIRED', 'This source was revoked.');
        return json(response, 201, { entry: store.importSourceEntry({ source_id: sourceId, inventory_id: saved.id, entry_id: body.entry_id, ...value }) });
      }
      if (route === '/academic/preview') {
        noQuery(url); if (request.method !== 'POST') methodError();
        const body = await privateBody(['export', 'selected_course_ids'], ['export', 'selected_course_ids'], 256000);
        const snapshot = normalizeAcademicExport(body.export, { selectedCourseIds: body.selected_course_ids });
        for (const [key, value] of academicPreviews) if (value.expires < Date.now()) academicPreviews.delete(key);
        if (academicPreviews.size >= 10) throw new HttpError(429, 'RATE_LIMITED', 'Review or discard an academic preview first.');
        const previewId = randomUUID();
        academicPreviews.set(previewId, { snapshot, nonce: session.nonce, expires: Date.now() + 300000 });
        return json(response, 200, { preview_id: previewId, snapshot, notice: 'Review these imported facts and unknown deadlines. No live university access was used.' });
      }
      if (route === '/academic/import') {
        noQuery(url); if (request.method !== 'POST') methodError();
        const body = await privateBody(['preview_id'], ['preview_id'], 4096);
        const preview = academicPreviews.get(id(body.preview_id));
        if (!preview || preview.nonce !== session.nonce || preview.expires < Date.now()) throw new HttpError(403, 'CONSENT_REQUIRED', 'Preview expired. Review the export again.');
        const content = JSON.stringify(preview.snapshot, null, 2);
        if (Buffer.byteLength(content) > 48000) throw new HttpError(413, 'BUDGET_EXCEEDED', 'Select fewer courses for this import.');
        const value = store.createDocument({ title: 'Reviewed academic snapshot', text: content, kind: 'study', academic_policy: 'learning_support' }, { idempotencyKey: body.preview_id });
        return json(response, 201, documentResult(value));
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
    academicPreviews.clear();
    for (const operation of sourceOperations) operation.abort();
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
    control = await startControl({ root: store.root, origin, onAgentCommand: async (destination, command, data) => {
      if (closing) throw new HttpError(503, 'OFFLINE', 'The local runtime is stopping.');
      if (command === 'status') {
        if (data !== undefined) plainBody(data, []);
        return { edition: 'local', version: LOCAL_VERSION, destination, healthy: store.integrity().integrity === 'ok',
          grants: store.listAgentGrants().filter(grant => grant.destination === destination && grant.state === 'active' && Date.parse(grant.expires_at) > Date.now())
            .map(grant => ({ id: grant.id, expires_at: grant.expires_at, max_bytes: grant.max_bytes, remaining_bytes: grant.max_bytes - grant.used_bytes })),
          next_step: 'Review selected context and task proposals in the paired LearnBridge dashboard. Granting or accepting is not an MCP tool.' };
      }
      if (command === 'context') {
        plainBody(data, ['grant_id', 'task_ids', 'document_ids', 'source_entry_ids', 'max_bytes'], ['grant_id']);
        if (data.max_bytes !== undefined && (!Number.isInteger(data.max_bytes) || data.max_bytes < 1 || data.max_bytes > 48000)) throw new HttpError(400, 'INVALID_INPUT', 'Invalid context budget.');
        return store.agentContext({ ...data, max_bytes: data.max_bytes ?? 48000, destination });
      }
      if (command === 'propose_task') {
        plainBody(data, ['grant_id', 'title', 'deadline', 'course_label', 'reason', 'idempotency_key'], ['grant_id', 'title', 'idempotency_key']);
        return store.proposeTask({ ...data, destination });
      }
      throw new HttpError(403, 'SCOPE_DENIED', 'This operation is unavailable to an agent.');
    }, onCommand: async (command, data) => {
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

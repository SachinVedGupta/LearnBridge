import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LocalStore } from '@learnbridge/local-storage';
import { LearnBridgeError } from '@learnbridge/core';
import { assertLocalRequest, createSessionPolicy, HttpError, plainBody, readJson } from './policy.mjs';
import { startControl } from './ipc.mjs';
import { describeRoot, inventorySource, readSelectedEntry, readSelectedPdf, probeSourceCapability, probePdfCapability } from '../../../packages/local-sources/src/index.mjs';
import { normalizeAcademicExport, AcademicError } from '../../../packages/local-academic/src/index.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { createStudentWorkspace } from './student-workspace.mjs';
import { workflowHash } from './workflows.mjs';
import { handleCareerRoute } from './career-routes.mjs';
import { handleLearningRoute } from './learning-routes.mjs';
import { handleLifeRoute } from './life-routes.mjs';
import { createWritingService } from './writing-service.mjs';
import { handleWritingRoute } from './writing-routes.mjs';
import { handleResearchRoute } from './research-routes.mjs';
import { handleProductivityRoute } from './productivity-routes.mjs';
import { createHostTurns } from './host-turns.mjs';
import { TutoringError } from '../../../packages/local-academic/src/tutoring.mjs';

export const LOCAL_VERSION = '0.3.0';
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const publicRoot = new URL('../../local/public/', import.meta.url);
const builtRoot = new URL('../../local/dist/', import.meta.url);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/career.js', ['career.js', 'text/javascript; charset=utf-8']],
  ['/learning.js', ['learning.js', 'text/javascript; charset=utf-8']],
  ['/life.js', ['life.js', 'text/javascript; charset=utf-8']],
  ['/writing.js', ['writing.js', 'text/javascript; charset=utf-8']],
  ['/research.js', ['research.js', 'text/javascript; charset=utf-8']],
  ['/productivity.js', ['productivity.js', 'text/javascript; charset=utf-8']],
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
      VERSION_MISMATCH: 409, CANCELLED: 409, RATE_LIMITED: 429, INVALID_INPUT: 400, UNSUPPORTED: 501, BUDGET_EXCEEDED: 413 };
    return json(response, statuses[error.code] || 500, { error: error.toJSON() });
  }
  if (error instanceof AcademicError) {
    const statuses = { INVALID_INPUT: 400, SCOPE_DENIED: 403, AUTH_REQUIRED: 401, AUTH_EXPIRED: 401, UNSUPPORTED: 501, BUDGET_EXCEEDED: 413, CANCELLED: 409, TIMEOUT: 504 };
    return json(response, statuses[error.code] || 502, { error: error.toJSON() });
  }
  if (error instanceof TutoringError) {
    const statuses = { INVALID_INPUT: 400, BUDGET_EXCEEDED: 413, STALE_EVIDENCE: 409, POLICY_BLOCKED: 403, CONSENT_REQUIRED: 403 };
    return json(response, statuses[error.code] || 400, { error: { code: error.code, message: error.message } });
  }
  json(response, 500, { error: { code: 'PROVIDER_FAILURE', message: 'The local operation could not be completed.' } });
}

/** Independent local edition. Never trusts a request student ID or hosted cookie. */
export async function startRuntime({ dataRoot, port = 3210, sessionTtlMs, pairingTtlMs,
  // Trusted programmatic dependency injection for native acquisition barriers.
  // The launcher/HTTP/MCP surfaces never accept an adapter or executable.
  sourceAdapter = { describeRoot, inventorySource, readSelectedEntry, readSelectedPdf, probeSourceCapability, probePdfCapability },
  // Trusted fixture seam only; the CLI/HTTP/MCP never accepts execution configuration.
  hostAdapter = { enabled: false } } = {}) {
  if (typeof dataRoot !== 'string' || !Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid local runtime options.');
  const store = LocalStore.open({ root: dataRoot, repositoryRoot, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
  let studentWorkspace;
  let hostTurns;
  try { store.recoverInterruptedRuns(); studentWorkspace = createStudentWorkspace(store); hostTurns = createHostTurns({ store, ...hostAdapter }); }
  catch (error) { store.close(); throw error; }
  let policy;
  let control;
  let closing = false;
  let closePromise;
  const activeBackups = new Set();
  const sourceOperations = new Set();
  const academicPreviews = new Map();
  let sourceCapability, pdfCapability;
  try {
    sourceCapability = await sourceAdapter.probeSourceCapability();
    pdfCapability = sourceAdapter.probePdfCapability ? await sourceAdapter.probePdfCapability()
      : { state: 'unsupported', reason: 'native_pdf_runtime_unavailable' };
  }
  catch (error) { store.close(); throw error; }
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
        hostTurns.capability(),
        { id: 'tasks', label: 'Tasks', state: 'available', detail: 'Manual tasks with revision checks and private local saves.' },
        { id: 'notes', label: 'Notes', state: 'available', detail: 'Multiple text notes with immutable revisions and verified hashes.' },
        { id: 'planning', label: 'Study planning', state: 'available', detail: 'Deterministic local study-plan previews with capacity deficits, task revision checks and saved review. No external calendar writes.' },
        { id: 'profile', label: 'Reviewed profile', state: 'available', detail: 'Student-entered facts with exact review, conflicts, purpose filters and stale source checks. No automatic identity or mastery inference.' },
        { id: 'library', label: 'Course library', state: 'available', detail: 'Reviewed academic snapshots with course-filtered search and exact version citations. Live university authentication remains a separate gate.' },
        { id: 'workflows', label: 'Durable local workflows', state: 'available', detail: 'Saved step journal, cumulative budgets, cancellation and restart recovery for registered local recipes. Unverified model turns remain disabled.' },
        { id: 'learning', label: 'Learning and catch-up', state: 'available', detail: 'Selected-course cited host recipes, your actual attempts and reviewed feedback, capacity-aware catch-up plans. A recorded check does not establish mastery.' },
        { id: 'writing', label: 'Writing review', state: 'available', detail: 'Source-pinned drafts, private alternatives and exact revisions with preserved originals and verified Markdown exports. PDF and Office conversion are unavailable.' },
        { id: 'research', label: 'Evidence research', state: 'available', detail: 'Selected local passages or student-pasted excerpts, exact quotes, conflicts and reviewed cited reports. No website freshness or factual accuracy is inferred.' },
        { id: 'career', label: 'Career preparation', state: 'available', detail: 'Selected postings, factual application drafts, interview attempts and local follow-up tasks. Live role availability and application submission are separate.' },
        { id: 'life', label: 'Daily life', state: 'available', detail: 'Pantry and grocery quantities, self-reported routines, confirmed currency-specific expenses and manual travel checklists.' },
        { id: 'productivity', label: 'Updates and projects', state: 'available', detail: 'Account-qualified pasted updates, coverage-aware briefings, reviewed tasks, ordered project checklists and paused manual reminders. Live refresh is not enabled here.' },
        { id: 'backup', label: 'Backup and restore', state: 'available', detail: 'Use the local launcher commands to make a snapshot or restore into a fresh workspace.' },
        { id: 'mcp', label: 'Agent MCP bridge', state: 'available', detail: 'Four project-scoped tools: status, selected context, pending tasks and pending writing. Sharing requires a destination-specific selection; task and writing acceptance belongs to the student.' },
        { id: 'sources', label: 'Selected local sources', state: sourceCapability.state === 'available' ? 'available' : 'unsupported', detail: 'Explicit text/Markdown folder inventory and selected imports. Requires the verified private Python runtime; no automatic laptop scan.' },
        { id: 'pdf', label: 'Selected PDF handouts', state: sourceCapability.state === 'available' && pdfCapability.state === 'available' ? 'available' : 'unsupported', detail: 'macOS PDF text imports preserve physical page citations and partial coverage. Native prerequisites are checked; each selected import verifies extraction. Scans require a separate text export; no OCR or password collection.' },
        { id: 'academic', label: 'Avenue / D2L', state: 'requires_auth', detail: 'Reviewed academic exports are supported. Live reads need a supported institution and a separately verified local student session. No university password or token is accepted here.' },
        { id: 'remote', label: 'Phone companion', state: 'unavailable', detail: 'The optional relay protocol is under development. This loopback dashboard does not expose the laptop or launch remote agent work.' },
        { id: 'telemetry', label: 'Local usage reporting', state: 'unavailable', detail: 'Off by default. Setup, doctor, tasks and agent sharing do not report local activity or enroll measurement.' },
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
      if (route.startsWith('/career/')) {
        noQuery(url);
        const result = await handleCareerRoute({ route, method: request.method, privateBody, store, session,
          idempotencyKey: idempotency(request).idempotencyKey });
        if (result) return json(response, result.status, result.data);
      }
      if (route.startsWith('/learning/')) {
        noQuery(url);
        const result = await handleLearningRoute({ route, method: request.method, privateBody, store, session,
          getLibrary: studentWorkspace.library, idempotencyKey: idempotency(request).idempotencyKey });
        if (result) return json(response, result.status, result.data);
      }
      if (route.startsWith('/life/')) {
        noQuery(url);
        const result = await handleLifeRoute({ route, method: request.method, privateBody, store, session,
          idempotencyKey: idempotency(request).idempotencyKey });
        if (result) return json(response, result.status, result.data);
      }
      if (route.startsWith('/writing/')) {
        noQuery(url);
        const result = await handleWritingRoute({ route, method: request.method, privateBody, store, session,
          idempotencyKey: idempotency(request).idempotencyKey });
        if (result) return json(response, result.status, result.data);
      }
      if (route.startsWith('/research/') || route.startsWith('/productivity/')) {
        noQuery(url);
        const handler = route.startsWith('/research/') ? handleResearchRoute : handleProductivityRoute;
        const result = await handler({ route, method: request.method, privateBody, store, session,
          idempotencyKey: idempotency(request).idempotencyKey });
        if (result) return json(response, result.status, result.data);
      }
      if (route === '/host-turns') {
        noQuery(url);
        if (request.method === 'GET') return json(response, 200, { items: hostTurns.list(), capability: hostTurns.capability() });
        if (request.method !== 'POST') methodError();
        const body = await privateBody(['grant_id', 'prompt', 'confirmed'], ['grant_id', 'prompt', 'confirmed'], 18000);
        const item = await hostTurns.start(body, { idempotencyKey: idempotency(request).idempotencyKey,
          authorize: () => { stillAuthorized(); return true; } });
        return json(response, 202, { item });
      }
      const hostTurnRoute = /^\/host-turns\/([^/]+)(?:\/(cancel))?$/.exec(route);
      if (hostTurnRoute) {
        noQuery(url); const recordId = id(hostTurnRoute[1]);
        if (!hostTurnRoute[2] && request.method === 'GET') return json(response, 200, { item: hostTurns.get(recordId) });
        if (hostTurnRoute[2] !== 'cancel' || request.method !== 'POST') methodError();
        const body = await privateBody(['expected_revision'], ['expected_revision'], 4096);
        return json(response, 200, { item: hostTurns.cancel(recordId, body) });
      }
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
      if (route === '/today') {
        noQuery(url); if (request.method !== 'GET') methodError();
        return json(response, 200, studentWorkspace.today());
      }
      if (route === '/profile') {
        noQuery(url);
        if (request.method === 'GET') return json(response, 200, { items: studentWorkspace.listProfiles() });
        if (request.method !== 'POST') methodError();
        const body = await privateBody(['field', 'value', 'purposes', 'expires_at', 'evidence'], ['field', 'value'], 8192);
        return json(response, 201, { fact: studentWorkspace.createProfile(body, idempotency(request)) });
      }
      if (route === '/profile/context') {
        noQuery(url); if (request.method !== 'POST') methodError();
        const body = await privateBody(['purpose', 'allowed_ids'], ['purpose', 'allowed_ids'], 8192);
        const context = { purpose: body.purpose, items: studentWorkspace.profileContext(body) };
        return json(response, 200, { ...context, context_hash: workflowHash(context), processing: 'local_preview_only' });
      }
      if (route === '/profile/export') {
        noQuery(url); if (request.method !== 'POST') methodError();
        const body = await privateBody(['purpose', 'allowed_ids', 'context_hash'], ['purpose', 'allowed_ids', 'context_hash'], 8192);
        return json(response, 201, studentWorkspace.exportProfile(body));
      }
      const profileRoute = /^\/profile\/([^/]+)(\/review)?$/.exec(route);
      if (profileRoute) {
        noQuery(url); const recordId = id(profileRoute[1]);
        if (profileRoute[2] && request.method === 'POST') {
          const body = await privateBody(['expected_revision', 'decision', 'fingerprint', 'value'], ['expected_revision', 'decision', 'fingerprint'], 8192);
          return json(response, 200, { fact: studentWorkspace.reviewProfile(recordId, body) });
        }
        if (!profileRoute[2] && request.method === 'DELETE') {
          const body = await privateBody(['expected_revision'], ['expected_revision'], 4096);
          studentWorkspace.forgetProfile(recordId, body.expected_revision); return json(response, 200, { deleted: true, retention: 'Historical local revisions and backups may retain this fact.' });
        }
        methodError();
      }
      if (route === '/courses') {
        noQuery(url); if (request.method !== 'GET') methodError();
        return json(response, 200, { items: studentWorkspace.listSnapshots() });
      }
      if (route === '/courses/search' || route === '/courses/citation') {
        noQuery(url); if (request.method !== 'POST') methodError();
        const body = await privateBody(route.endsWith('search') ? ['snapshot_ids', 'course_ids', 'query', 'limit'] : ['snapshot_ids', 'course_ids', 'source_id', 'version_hash', 'chunk_id'], ['snapshot_ids', 'course_ids'], 16384);
        return json(response, 200, route.endsWith('search') ? studentWorkspace.search(body) : studentWorkspace.citation(body));
      }
      const courseRoute = /^\/courses\/([^/]+)$/.exec(route);
      if (courseRoute) {
        noQuery(url); if (request.method !== 'DELETE') methodError();
        const body = await privateBody(['expected_revision'], ['expected_revision'], 4096);
        studentWorkspace.forgetSnapshot(id(courseRoute[1]), body.expected_revision); return json(response, 200, { deleted: true, retention: 'Active course retrieval stops. Historical local revisions and backups may retain this snapshot.' });
      }
      if (route === '/plans') {
        noQuery(url); if (request.method !== 'GET') methodError();
        return json(response, 200, { items: studentWorkspace.listPlans() });
      }
      const planRoute = /^\/plans\/([^/]+)\/accept$/.exec(route);
      if (planRoute) {
        noQuery(url); if (request.method !== 'POST') methodError();
        const body = await privateBody(['expected_revision', 'plan_hash'], ['expected_revision', 'plan_hash'], 4096);
        return json(response, 200, { plan: studentWorkspace.acceptPlan(id(planRoute[1]), body) });
      }
      if (route === '/workflows') {
        noQuery(url);
        if (request.method === 'GET') return json(response, 200, { items: store.listRuns() });
        if (request.method !== 'POST') methodError();
        const body = await privateBody(['recipe_id', 'input'], ['recipe_id', 'input'], 32768);
        if (body.recipe_id !== 'plan.today') throw new HttpError(501, 'UNSUPPORTED', 'Choose an available local workflow.');
        const input = plainBody(body.input, ['availability', 'busy', 'pinnedBlocks', 'timezone', 'horizonEnd', 'maxDailyMinutes', 'bufferMinutes', 'minBlockMinutes'], ['availability', 'timezone', 'horizonEnd']);
        return json(response, 201, { run: studentWorkspace.runner.prepare(body.recipe_id, { ...input, now: new Date().toISOString() }, idempotency(request)) });
      }
      const workflowRoute = /^\/workflows\/([^/]+)(\/(execute|cancel))?$/.exec(route);
      if (workflowRoute) {
        noQuery(url); const runId = id(workflowRoute[1]);
        if (!workflowRoute[3] && request.method === 'GET') return json(response, 200, { run: found(store.getRun(runId)), steps: store.listRunSteps(runId), events: store.listRunEvents(runId) });
        if (request.method !== 'POST') methodError();
        const body = await privateBody(workflowRoute[3] === 'cancel' ? ['expected_revision'] : [], workflowRoute[3] === 'cancel' ? ['expected_revision'] : [], 4096);
        if (workflowRoute[3] === 'cancel') return json(response, 200, { run: studentWorkspace.runner.cancel(runId, body.expected_revision) });
        if (workflowRoute[3] !== 'execute') methodError();
        return json(response, 200, { run: await sourceOperation(signal => studentWorkspace.runner.execute(runId, { signal, authorize: stillAuthorized })) });
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
        if (request.method === 'GET') return json(response, 200, { items: store.listSources(), entries: store.listSourceEntries(), capability: sourceCapability, pdf_capability: pdfCapability });
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
        const entryId = id(body.entry_id);
        const selected = found(saved.inventory.entries.find(item => item.id === entryId));
        if (selected.kind === 'pdf' && (pdfCapability.state !== 'available' || typeof sourceAdapter.readSelectedPdf !== 'function')) throw new LearnBridgeError('UNSUPPORTED');
        const reader = selected.kind === 'pdf' ? sourceAdapter.readSelectedPdf : sourceAdapter.readSelectedEntry;
        const value = await sourceOperation(signal => reader(source.descriptor, saved.inventory, entryId, { signal, maxBytes: 48000 }));
        // Recheck source revocation after the acquisition worker yields.
        if (store.getSource(sourceId)?.state !== 'active') throw new HttpError(403, 'CONSENT_REQUIRED', 'This source was revoked.');
        if (selected.kind === 'pdf' && value.pdf?.extraction_status !== 'available') {
          return json(response, 200, { imported: false, extraction_status: value.pdf?.extraction_status || 'text_unavailable', coverage: value.pdf?.coverage || { state: 'unavailable', reasons: ['no_extractable_text'] } });
        }
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
      if (route === '/academic/import' || route === '/academic/library-import') {
        noQuery(url); if (request.method !== 'POST') methodError();
        const body = await privateBody(['preview_id'], ['preview_id'], 4096);
        const preview = academicPreviews.get(id(body.preview_id));
        if (!preview || preview.nonce !== session.nonce || preview.expires < Date.now()) throw new HttpError(403, 'CONSENT_REQUIRED', 'Preview expired. Review the export again.');
        if (route === '/academic/library-import') return json(response, 201, { snapshot: studentWorkspace.saveSnapshot(preview.snapshot, body.preview_id) });
        const content = JSON.stringify(preview.snapshot, null, 2);
        if (Buffer.byteLength(content) > 48000) throw new HttpError(413, 'BUDGET_EXCEEDED', 'Select fewer courses for this import.');
        const value = store.createDocument({ title: 'Reviewed academic snapshot', text: content, kind: 'study', academic_policy: 'learning_support' }, { idempotencyKey: body.preview_id });
        return json(response, 201, documentResult(value));
      }
      if (route === '/tasks') {
        noQuery(url);
        if (request.method === 'GET') return json(response, 200, { items: store.listTasks() });
        if (request.method === 'POST') {
          const body = await privateBody(['title', 'deadline', 'course_label', 'effort_minutes', 'dependency_ids', 'parent_id'], ['title'], 16_384);
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
          const body = await privateBody(['expected_revision', 'title', 'status', 'deadline', 'course_label', 'effort_minutes', 'dependency_ids', 'parent_id'], ['expected_revision'], 16_384);
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
        await studentWorkspace.runner.drain();
        await hostTurns.drain();
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
      if (command === 'propose_document') {
        plainBody(data, ['grant_id', 'source_document_id', 'source_revision', 'source_sha256', 'title', 'draft', 'purpose', 'academic_policy', 'idempotency_key'],
          ['grant_id', 'source_document_id', 'source_revision', 'source_sha256', 'title', 'draft', 'purpose', 'academic_policy', 'idempotency_key']);
        if (typeof data.draft !== 'string' || Buffer.byteLength(data.draft) > 10000 || typeof data.idempotency_key !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(data.idempotency_key)) throw new HttpError(400, 'INVALID_INPUT', 'Invalid writing proposal.');
        const source = store.assertAgentDocumentSelection({ destination, grant_id: data.grant_id,
          document_id: data.source_document_id, revision: data.source_revision, sha256: data.source_sha256 });
        const kinds = { study_note: 'study_guide', outline: 'outline', revision: 'revision', general: 'markdown_artifact' };
        const policies = { learning_support: 'learning_support', graded_scaffolding: 'graded_restricted', not_applicable: 'unrestricted' };
        if (!Object.hasOwn(kinds, data.purpose) || !Object.hasOwn(policies, data.academic_policy)) throw new HttpError(400, 'INVALID_INPUT', 'Invalid writing policy.');
        const proposal = createWritingService({ store }).createProposal({ title: data.title, kind: kinds[data.purpose], draft_text: data.draft,
          source_documents: [{ id: source.document_id, revision: source.revision, sha256: source.sha256 }],
          academic_policy: policies[data.academic_policy], origin: 'agent_paste' },
          { idempotencyKey: `${destination}-${createHash('sha256').update(data.idempotency_key).digest('hex')}`, agentOrigin: destination, grantId: data.grant_id });
        return { id: proposal.id, revision: proposal.revision, state: proposal.data.state, payload_hash: proposal.data.payload_hash,
          source_document_id: source.document_id, accepted_document: null, next_step: 'Review the exact alternative in Writing. The original is unchanged.' };
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

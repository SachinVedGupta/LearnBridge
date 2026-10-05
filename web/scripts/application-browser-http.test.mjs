import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';

// Actual paired HTTP/router/storage boundaries. No browser is opened and no
// account, model, private file or external provider request is used by this suite.
const selection = { provider: 'greenhouse', board_slug: 'httpfixture' };
const posting = { id: 123, title: 'Synthetic HTTP Internship', location: { name: 'Toronto' }, content: '<p>A synthetic role, not a live employer application.</p>' };
async function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-application-http-')), dataRoot = join(parent, 'private'), publicCalls = [];
  const unsupported = async () => ({ state: 'unsupported', verification: 'synthetic_application_http' });
  const runtime = await startRuntime({ dataRoot, port: 0, sourceAdapter: { probeSourceCapability: unsupported, probePdfCapability: unsupported, probeOfficeCapability: unsupported },
    hostAdapter: { enabled: false, execute: async () => { throw Error('No model execution in application HTTP boundaries'); } },
    publicJobFetch: async (url, options) => { publicCalls.push({ url, method: options.method }); if (url === 'https://boards-api.greenhouse.io/v1/boards/httpfixture/jobs') return new Response(JSON.stringify({ jobs: [posting] }), { headers: { 'Content-Type': 'application/json' } }); if (url === 'https://boards-api.greenhouse.io/v1/boards/httpfixture/jobs/123') return new Response(JSON.stringify(posting), { headers: { 'Content-Type': 'application/json' } }); throw Error('Unexpected synthetic provider endpoint'); } });
  t.after(async () => { await runtime.close(); rmSync(parent, { recursive: true, force: true }); });
  async function raw(route, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(`${runtime.origin}/api/local/v1${route}`, { method, headers: { Origin: runtime.origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json() };
  }
  // Obtain the actual HTTP-only cookie in the same manner as a browser.
  const response = await fetch(`${runtime.origin}/api/local/v1/pair`, { method: 'POST', headers: { Origin: runtime.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: runtime.createPairingCode() }) }); assert.equal(response.status, 200);
  const session = await response.json(), credentials = { Cookie: response.headers.get('set-cookie').split(';')[0], 'X-LearnBridge-Nonce': session.nonce };
  const call = (route, options = {}) => raw(route, { ...options, headers: { ...credentials, ...options.headers } });
  async function selectedRole() { assert.equal((await call('/public-jobs/search', { method: 'POST', body: selection })).status, 200); const result = await call('/public-jobs/read', { method: 'POST', body: { ...selection, job_id: '123' } }); assert.equal(result.status, 200); const role = result.data.role; return { id: role.id, revision: role.revision, source_sha256: role.data.snapshot.source_sha256 }; }
  return { runtime, raw, call, credentials, selectedRole, publicCalls };
}
const bodyFor = role_ref => ({ role_ref, task_session_id: null, confirmed: true });
const headers = () => ({ 'Idempotency-Key': randomUUID() });

test('ABH01 application HTTP denies unpaired, forged nonce, cross-Origin and query requests without opening a session', async t => {
  const f = await fixture(t), state = '/application-browser/state', open = '/application-browser/open';
  assert.equal((await f.raw(state)).status, 401);
  assert.equal((await f.raw(open, { method: 'POST', body: {} })).status, 401);
  for (const overrides of [{ 'X-LearnBridge-Nonce': 'forged' }, { 'X-LearnBridge-Nonce': '' }, { Origin: 'https://outside.example' }]) {
    assert.equal((await f.call(state, { headers: overrides })).status, 403);
    assert.equal((await f.call(open, { method: 'POST', body: {}, headers: { ...headers(), ...overrides } })).status, 403);
  }
  assert.equal((await f.call(state + '?token=PRIVATE_APPLICATION_QUERY_CANARY')).status, 400);
  assert.equal((await f.call(open + '?url=https://outside.example', { method: 'POST', body: {}, headers: headers() })).status, 400);
  const current = await f.call(state);assert.equal(current.status, 200);assert.deepEqual(current.data.sessions, []);assert.equal(f.publicCalls.length, 0);
  assert.equal(JSON.stringify(current.data).includes('PRIVATE_APPLICATION_QUERY_CANARY'), false);
});

test('ABH02 application HTTP rejects URLs/executables/browser profiles/scripts and synthetic fixture seams as public inputs', async t => {
  const f = await fixture(t), role = await f.selectedRole(), body = bodyFor(role), before = (await f.call('/documents')).data;
  for (const injection of [
    { url: 'https://outside.example' }, { url: 'javascript:alert(1)' }, { testPageUrl: 'http://127.0.0.1:123/fixture/application' },
    { binary: '/bin/sh' }, { command: 'execute private shell command' }, { args: ['--no-sandbox'] }, { factory: 'browser factory' },
    { profilePath: '/PRIVATE_BROWSER_PROFILE_CANARY' }, { executable: '/PRIVATE_EXECUTABLE_CANARY' }, { script: 'alert(1)' },
  ]) assert.equal((await f.call('/application-browser/open', { method: 'POST', body: { ...body, ...injection }, headers: headers() })).status, 400);
  assert.equal((await f.call('/application-browser/open', { method: 'POST', body: { ...body, role_ref: { ...role, url: 'https://outside.example' } }, headers: headers() })).status, 400);
  assert.equal((await f.call('/application-browser/open', { method: 'POST', body: { ...body, confirmed: false }, headers: headers() })).status, 403);
  assert.deepEqual((await f.call('/application-browser/state')).data.sessions, []);
  assert.equal((await f.call('/tasks')).data.items.length, 0);assert.equal((await f.call('/agent-grants')).data.items.length, 0);assert.deepEqual((await f.call('/documents')).data, before);assert.equal(f.publicCalls.length, 2);
});

test('ABH03 application HTTP refuses foreign workspace cookies, unknown session actions and method escalation', async t => {
  const f = await fixture(t), other = await fixture(t), id = randomUUID(), state = '/application-browser/state';
  assert.equal((await f.raw(state, { headers: other.credentials })).status, 401);
  assert.equal((await f.call('/application-browser/open')).status, 400);
  assert.equal((await f.call(state, { method: 'POST', body: {}, headers: headers() })).status, 400);
  assert.equal((await f.call(`/application-browser/sessions/${id}`)).status, 403);
  for (const action of ['submit', 'upload', 'click', 'execute', 'evaluate', 'navigate']) assert.equal((await f.call(`/application-browser/sessions/${id}/${action}`, { method: 'POST', body: {}, headers: headers() })).status, 404);
  assert.deepEqual((await f.call(state)).data.sessions, []);assert.equal(f.publicCalls.length, 0);assert.equal(other.publicCalls.length, 0);
});

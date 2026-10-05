import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { mountPublicJobsUI } from '../apps/local/public/public-jobs.js';

const API = '/api/local/v1', choice = { provider: 'greenhouse', board_slug: 'fixturecompany' }, selected = { ...choice, job_id: '123' };
const posting = { id: 123, title: 'Synthetic Student Internship', location: { name: 'Toronto' }, content: '<p>Learn and build useful tools.</p>' };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-public-job-http-')), root = join(parent, 'workspace'), calls = []; let runtime, intercept;
  const unsupported = async () => ({ state: 'unsupported', verification: 'synthetic_public_job_no_native_parser' });
  const sourceAdapter = { probeSourceCapability: unsupported, probePdfCapability: unsupported, probeOfficeCapability: unsupported,
    describeRoot: async () => { throw new Error('No private discovery'); }, inventorySource: async () => { throw new Error('No private inventory'); }, readSelectedEntry: async () => { throw new Error('No private read'); } };
  const publicJobFetch = async (url, options) => { calls.push({ url, method: options.method, headers: options.headers }); const custom = intercept?.(url, options); if (custom !== undefined) return await custom;
    if (url === 'https://boards-api.greenhouse.io/v1/boards/fixturecompany/jobs') return response({ jobs: [posting] });
    if (url === 'https://boards-api.greenhouse.io/v1/boards/fixturecompany/jobs/123') return response(posting); throw new Error('Unexpected fixed public API fetch'); };
  t.after(async () => { await runtime?.close(); rmSync(parent, { recursive: true, force: true }); });
  async function raw(route, body, method = body === undefined ? 'GET' : 'POST', headers = {}) {
    const result = await fetch(runtime.origin + API + route, { method, headers: { Origin: runtime.origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: result.status, data: await result.json() };
  }
  async function pair() {
    const paired = await fetch(runtime.origin + API + '/pair', { method: 'POST', headers: { Origin: runtime.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: runtime.createPairingCode() }) }); assert.equal(paired.status, 200);
    const session = await paired.json(), credentials = { Cookie: paired.headers.get('set-cookie').split(';')[0], 'X-LearnBridge-Nonce': session.nonce };
    return { credentials, call: (route, body, method, headers = {}) => raw(route, body, method, { ...credentials, ...headers }) };
  }
  async function restart() { await runtime?.close(); runtime = await startRuntime({ dataRoot: root, port: 0, publicJobFetch, sourceAdapter, hostAdapter: { enabled: false, execute: async () => { throw new Error('No inference'); } } }); return pair(); }
  const auth = await restart(); return { parent, root, calls, raw, restart, pair, ...auth, intercept: callback => { intercept = callback; }, close: () => runtime.close() };
}
async function seed(f) { assert.equal((await f.call('/public-jobs/search', choice)).status, 200); const read = await f.call('/public-jobs/read', selected); assert.equal(read.status, 200); return read.data.role; }

test('PJH01: actual HTTP requires explicit board search/selected body and leaves private sources, tasks and grants untouched', async t => {
  const f = await fixture(t); await f.call('/documents', { title: 'Unrelated private note', content: 'PRIVATE_HTTP_JOB_CANARY' });
  const before = { documents: (await f.call('/documents')).data.items, tasks: (await f.call('/tasks')).data.items, grants: (await f.call('/agent-grants')).data.items };
  const initial = await f.call('/public-jobs/state'); assert.equal(initial.status, 200); assert.deepEqual(initial.data.roles, []); assert.equal(f.calls.length, 0);
  assert.equal((await f.call('/public-jobs/read', selected)).status, 403); assert.equal(f.calls.length, 0);
  const role = await seed(f); assert.equal(role.verified_opening, true); assert.equal(role.data.snapshot.display_text, 'Learn and build useful tools.'); assert.equal(f.calls.length, 2);
  assert.equal(JSON.stringify((await f.call('/public-jobs/state')).data).includes('Learn and build useful'), false); const local = await f.call(`/public-jobs/roles/${role.id}`); assert.equal(local.status, 200); assert.equal(local.data.role.data.snapshot.source_sha256, role.data.snapshot.source_sha256); assert.equal(f.calls.length, 2);
  assert.deepEqual({ documents: (await f.call('/documents')).data.items, tasks: (await f.call('/tasks')).data.items, grants: (await f.call('/agent-grants')).data.items }, before);
});

test('PJH02: paired cookie/nonce/Origin, strict input/method/query and cross-workspace authority gate actual HTTP before provider calls', async t => {
  const f = await fixture(t), other = await fixture(t); assert.equal((await f.raw('/public-jobs/search', choice)).status, 401);
  for (const headers of [{ 'X-LearnBridge-Nonce': '' }, { 'X-LearnBridge-Nonce': 'wrong' }, { Origin: 'https://outside.example' }]) assert.equal((await f.call('/public-jobs/search', choice, 'POST', headers)).status, 403);
  for (const body of [{ ...choice, url: 'http://127.0.0.1/private' }, { ...choice, board_slug: '../secret' }, { ...choice, authorization: 'private' }, {}]) assert.equal((await f.call('/public-jobs/search', body)).status, 400);
  assert.equal((await f.call('/public-jobs/search?all=true', choice)).status, 400); assert.equal((await f.call('/public-jobs/search', undefined, 'GET')).status, 400); assert.equal(f.calls.length, 0);
  const role = await seed(f); assert.equal((await other.call(`/public-jobs/roles/${role.id}`)).status, 403); assert.equal((await other.call(`/public-jobs/roles/${role.id}/shortlist`, { expected_revision: role.revision, state: 'saved' })).status, 403); assert.equal(other.calls.length, 0);
});

test('PJH03: real HTTP shortlist CAS survives recheck, provider failure, restart and old-session invalidation without creating applications', async t => {
  const f = await fixture(t), role = await seed(f); const saved = await f.call(`/public-jobs/roles/${role.id}/shortlist`, { expected_revision: role.revision, state: 'saved', note: 'My reviewed decision' }); assert.equal(saved.status, 200);
  assert.equal((await f.call(`/public-jobs/roles/${role.id}/shortlist`, { expected_revision: role.revision, state: 'dismissed' })).status, 409);
  f.intercept(url => url.endsWith('/jobs/123') ? response({}, 503) : undefined); const failed = await f.call('/public-jobs/read', selected); assert.equal(failed.status, 200); assert.equal(failed.data.role.availability, 'stale'); assert.deepEqual(failed.data.role.data.snapshot, role.data.snapshot); assert.deepEqual(failed.data.role.data.shortlist, saved.data.role.data.shortlist);
  const old = f.credentials, before = (await f.call('/public-jobs/state')).data; f.call = (await f.restart()).call;
  assert.equal((await f.raw('/public-jobs/state', undefined, 'GET', old)).status, 401); assert.deepEqual((await f.call('/public-jobs/state')).data, before); assert.equal((await f.call('/career/applications')).data.items.length, 0);
});

test('PJH04: actual logout during a provider await prevents observation persistence and returns no source body', async t => {
  const f = await fixture(t), started = deferred(), released = deferred(); f.intercept(() => { started.resolve(); return released.promise; });
  const pending = f.call('/public-jobs/search', choice); await started.promise; assert.equal((await f.call('/logout', {})).status, 200); released.resolve(response({ jobs: [posting] })); const denied = await pending; assert.ok([401, 403].includes(denied.status));
  f.call = (await f.pair()).call; const current = await f.call('/public-jobs/state'); assert.equal(current.data.boards.length, 0); assert.equal(current.data.roles.length, 0);
});

test('PJH05: runtime shutdown aborts its public request and reopen finds no fabricated source observation', async t => {
  const f = await fixture(t), started = deferred(); let aborted = false;
  f.intercept((_url, options) => new Promise((_resolve, reject) => { started.resolve(); options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('closed')); }); }));
  const pending = f.call('/public-jobs/search', choice); await started.promise; await f.close(); await pending.catch(() => {}); assert.equal(aborted, true);
  const store = LocalStore.open({ root: f.root }); try { assert.equal(store.listWorkspaceRecords({ kind: 'career_item' }).length, 0); } finally { store.close(); }
});

class Node {
  constructor(tag, cls = '', text = '') { this.tagName = tag; this.className = cls; this.text = text; this.children = []; this.parent = null; this.listeners = new Map(); this.value = ''; this.disabled = false; this.hidden = false; this.classList = { toggle() {} }; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } if (this.tagName === 'select' && this.children.length === 1) this.value = this.children[0].value; }
  replaceChildren(...children) { this.children = []; this.text = ''; this.append(...children); }
  setAttribute() {}
  addEventListener(event, listener) { this.listeners.set(event, [...(this.listeners.get(event) || []), listener]); }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this.text = String(value); }
  reset() { for (const node of walk(this)) { node.value = ''; } }
}
const walk = node => [node, ...node.children.flatMap(walk)];
const fire = (node, event = 'click') => { for (const listener of node.listeners.get(event) || []) listener({ preventDefault() {} }); };
async function harness(f, { intercept } = {}) {
  const root = new Node('main'), jobs = [], requests = [];
  const request = async (route, options = {}) => { requests.push({ route, ...options }); const custom = intercept?.(route, options); if (custom !== undefined) return await custom; const response = await f.call(route, options.body, options.method); if (response.status >= 400) throw new Error('Selected source operation failed.'); return response.data; };
  const ui = mountPublicJobsUI({ root, request, element: (tag, cls, text) => new Node(tag, cls, text), busy(control, callback) { const promise = Promise.resolve().then(callback); jobs.push(promise); return promise; } });
  const settle = async () => { for (let index = 0; index < 5; index++) { await Promise.resolve(); await Promise.all(jobs.map(job => job.catch(() => {}))); } };
  const find = text => { const node = walk(root).find(node => node.tagName === 'button' && node.textContent === text); assert.ok(node, text); return node; };
  await ui.refresh(); return { root, ui, requests, settle, async click(text) { fire(find(text)); await settle(); }, find,
    async search() { walk(root).find(node => node.id === 'public-job-provider').value = 'greenhouse'; walk(root).find(node => node.id === 'public-job-slug').value = 'fixturecompany'; fire(walk(root).find(node => node.tagName === 'form'), 'submit'); await settle(); } };
}

test('PJH06: actual shipped UI + HTTP performs no search on refresh, then explicit metadata/read and exact reviewed shortlist with saved source detail', async t => {
  const f = await fixture(t), h = await harness(f); assert.equal(f.calls.length, 0); await h.search(); assert.equal(f.calls.length, 1); assert.equal(h.root.textContent.includes('Learn and build useful'), false);
  await h.click('Read this selected posting'); assert.equal(f.calls.length, 2); assert.ok(h.root.textContent.includes('Learn and build useful tools.')); assert.ok(h.root.textContent.includes('Source SHA-256'));
  const forms = walk(h.root).filter(node => node.tagName === 'form'), shortlist = forms.at(-1); fire(shortlist, 'submit'); await h.settle();
  const saved = (await f.call('/public-jobs/state')).data.roles[0]; assert.equal(saved.data.shortlist.state, 'saved'); assert.equal(saved.data.shortlist.reviewer.length, 36); assert.equal(f.calls.length, 2);
  await h.click('Open saved posting'); assert.equal(f.calls.length, 2); assert.ok(h.root.textContent.includes('Learn and build useful tools.')); assert.equal((await f.call('/career/applications')).data.items.length, 0);
});

test('PJH07: UI reset suppresses late selected public response; failed source checks are visible without an empty-success claim', async t => {
  const f = await fixture(t), role = await seed(f), started = deferred(), released = deferred();
  const h = await harness(f, { intercept: route => route === '/public-jobs/read' ? (started.resolve(), released.promise) : undefined }); await h.click('Open saved posting');
  fire(h.find('Check this official source again')); await started.promise; h.ui.reset(); released.resolve({ role }); await h.settle(); assert.equal(h.root.textContent.includes('Learn and build useful tools.'), false);
  const second = await harness(f); f.intercept(() => response({}, 503)); await second.search(); assert.ok(second.root.textContent.includes('Coverage is incomplete or unavailable')); assert.ok(second.root.textContent.includes('failed')); assert.ok(second.root.textContent.includes('not a claim that there are no openings')); assert.equal(second.root.textContent.includes('No openings found'), false);
});

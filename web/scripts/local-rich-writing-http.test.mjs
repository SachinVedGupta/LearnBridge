import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';
import { verifyRichWritingDownload } from '../apps/local/public/rich-writing.js';
import { mountWritingUI } from '../apps/local/public/writing.js';

const API = '/api/local/v1', FORMATS = ['docx', 'tex'];
const review = record => ({ expected_revision: record.revision, payload_hash: record.data.payload_hash });
const path = (record, format) => `/writing/items/${record.id}/${format === 'docx' ? 'export-formatted-docx' : 'export-tex'}`;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-rich-http-')), root = join(parent, 'workspace'); let runtime;
  const unsupported = async () => ({ state: 'unsupported', verification: 'synthetic_http_fixture_no_native_parser' });
  const sourceAdapter = { probeSourceCapability: unsupported, probePdfCapability: unsupported, probeOfficeCapability: unsupported,
    describeRoot: async () => { throw new Error('Export cannot discover sources'); }, inventorySource: async () => { throw new Error('Export cannot inventory sources'); }, readSelectedEntry: async () => { throw new Error('Export cannot acquire sources'); } };
  t.after(async () => { await runtime?.close(); rmSync(parent, { recursive: true, force: true }); });
  async function raw(route, body, method = body === undefined ? 'GET' : 'POST', headers = {}) {
    const response = await fetch(runtime.origin + API + route, { method, headers: { Origin: runtime.origin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }
  async function restart() {
    await runtime?.close(); runtime = await startRuntime({ dataRoot: root, port: 0, sourceAdapter,
      hostAdapter: { enabled: false, execute: async () => { throw new Error('Export cannot contact models'); } } });
    const paired = await fetch(runtime.origin + API + '/pair', { method: 'POST', headers: { Origin: runtime.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: runtime.createPairingCode() }) });
    assert.equal(paired.status, 200); const session = await paired.json(), credentials = { Cookie: paired.headers.get('set-cookie').split(';')[0], 'X-LearnBridge-Nonce': session.nonce };
    return { credentials, call: (route, body, method, headers = {}) => raw(route, body, method, { ...credentials, ...headers }) };
  }
  return { parent, root, raw, restart, ...await restart() };
}
async function seed(f, { applied = false, policy = 'learning_support', kind = 'revision' } = {}) {
  const source = await f.call('/documents', { title: 'Selected rich fixture', content: 'Original source text.', academic_policy: policy }); assert.equal(source.status, 201);
  await f.call('/documents', { title: 'Unselected rich fixture', content: 'SYNTHETIC_RICH_UNSELECTED_CANARY' });
  const created = await f.call('/writing/proposals', { title: 'Reviewed student report', kind, draft_text: '# Student report\nA **bold** and *italic* résumé line.\n- Review facts\n2. Study topic\n\\input{PRINT_THIS_LITERAL}',
    source_documents: [{ id: source.data.document.id, revision: source.data.document.revision, sha256: source.data.sha256 }], academic_policy: policy, origin: 'student' }); assert.equal(created.status, 201);
  const accepted = await f.call(`/writing/items/${created.data.item.id}/${applied ? 'apply-revision' : 'accept'}`, review(created.data.item)); assert.equal(accepted.status, 200);
  return { source: source.data, pending: created.data.item, record: accepted.data.item };
}
async function state(f) {
  const docs = (await f.call('/documents')).data.items;
  return { documents: await Promise.all(docs.map(async document => ({ current: (await f.call(`/documents/${document.id}`)).data, history: (await f.call(`/documents/${document.id}/revisions`)).data.items }))),
    writing: (await f.call('/writing/items')).data.items, tasks: (await f.call('/tasks')).data.items, grants: (await f.call('/agent-grants')).data.items, sources: (await f.call('/sources')).data.items };
}
async function result(f, record, format) {
  const response = await f.call(path(record, format), review(record)); assert.equal(response.status, 200, JSON.stringify(response.data));
  const bytes = await verifyRichWritingDownload(response.data, record, format); assert.equal(sha(bytes), response.data.sha256);
  assert.equal(JSON.stringify(response.data).includes('SYNTHETIC_RICH_UNSELECTED_CANARY'), false); return response.data;
}

test('RWH01: real paired HTTP exports both rich formats from an accepted current note without source/provider/database writes', async t => {
  const f = await fixture(t), { record } = await seed(f), before = await state(f);
  for (const format of FORMATS) { const first = await result(f, record, format), second = await result(f, record, format); assert.deepEqual(first, second); }
  assert.deepEqual(await state(f), before);
});

test('RWH02: real HTTP enforces cookie, nonce, Origin, strict body, method and no query expansion for both exporters', async t => {
  const f = await fixture(t), { record } = await seed(f), before = await state(f);
  for (const format of FORMATS) {
    const route = path(record, format), body = review(record);
    assert.equal((await f.raw(route, body)).status, 401);
    for (const headers of [{ 'X-LearnBridge-Nonce': '' }, { 'X-LearnBridge-Nonce': 'wrong' }, { Origin: 'https://outside.example' }]) assert.equal((await f.call(route, body, 'POST', headers)).status, 403);
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) assert.equal((await f.call(route, method === 'GET' ? undefined : body, method)).status, 400);
    assert.equal((await f.call(route + '?destination=cloud', body)).status, 400); assert.equal((await f.call(route, { ...body, path: '/PRIVATE_RICH_CANARY' })).status, 400);
    assert.equal((await f.call(route, body, 'POST', { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await f.call(route, { ...body, payload_hash: 'f'.repeat(64) })).status, 409);
  }
  assert.deepEqual(await state(f), before);
});

test('RWH03: applied current revisions and allowed graded scaffolding preserve policy and reviewed pins through HTTP', async t => {
  for (const options of [{ applied: true }, { policy: 'graded_restricted', kind: 'outline' }]) {
    const f = await fixture(t), { record } = await seed(f, options), before = await state(f);
    for (const format of FORMATS) { const artifact = await result(f, record, format); assert.equal(artifact.manifest.provenance.writing_record.state, options.applied ? 'applied_revision' : 'accepted'); assert.equal(artifact.manifest.provenance.academic_policy, options.policy || 'learning_support'); }
    assert.deepEqual(await state(f), before);
  }
});

test('RWH04: changing the accepted copy or source denies real HTTP export and restart invalidates the old paired session', async t => {
  const f = await fixture(t), { record, source } = await seed(f), original = await Promise.all(FORMATS.map(format => result(f, record, format))), old = f.credentials;
  const restarted = await f.restart(); f.call = restarted.call; assert.equal((await f.raw(path(record, 'docx'), review(record), 'POST', old)).status, 401);
  assert.deepEqual(await Promise.all(FORMATS.map(format => result(f, record, format))), original);
  assert.equal((await f.call(`/documents/${source.document.id}`, { expected_revision: source.document.revision, content: 'Independent later student change' }, 'PATCH')).status, 200);
  const before = await state(f); for (const format of FORMATS) assert.equal((await f.call(path(record, format), review(record))).status, 409); assert.deepEqual(await state(f), before);
});

// Real shipped writing controller + real HTTP/runtime/SQLite/artifact generation.
// DOM, Blob-click observation and cleanup clock are synthetic. This does not
// claim a browser actually saved a file or that its visual layout was reviewed.
class Node {
  constructor(tag, className = '', text = '', clicked = () => {}) { this.tagName = tag; this.className = className; this.text = text; this.children = []; this.parent = null; this.listeners = new Map(); this.hidden = false; this.disabled = false; this.value = ''; this.checked = false; this.clicked = clicked; this.classList = { toggle() {} }; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } if (this.tagName === 'select' && this.children.length === 1) this.value = this.children[0].value; }
  replaceChildren(...children) { for (const child of this.children) child.parent = null; this.children = []; this.text = ''; this.append(...children); }
  setAttribute() {}
  addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this.text = String(value); }
  click() { this.clicked(this); fire(this); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; } }
  reset() { for (const node of walk(this)) { node.value = ''; node.checked = false; } }
}
const walk = node => [node, ...node.children.flatMap(walk)];
const fire = node => { for (const listener of node.listeners.get('click') || []) listener({ preventDefault() {} }); };
const find = (root, label) => { const node = walk(root).find(node => node.tagName === 'button' && node.textContent === label); assert.ok(node, label); return node; };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function uiFixture(t, f, { intercept } = {}) {
  const root = new Node('main'), downloads = [], created = [], revoked = [], requests = [], timers = new Map(), jobs = []; let timerIndex = 0;
  const restore = [];
  function replace(target, key, value) { const old = Object.getOwnPropertyDescriptor(target, key); restore.push(() => Object.defineProperty(target, key, old)); Object.defineProperty(target, key, { configurable: true, writable: true, value }); }
  replace(URL, 'createObjectURL', blob => { const url = `blob:synthetic-rich-${created.length}`; created.push({ blob, url }); return url; });
  replace(URL, 'revokeObjectURL', url => revoked.push(url));
  replace(globalThis, 'setTimeout', (callback, ms) => { const id = ++timerIndex; timers.set(id, { callback, ms }); return id; }); replace(globalThis, 'clearTimeout', id => timers.delete(id));
  const request = async (route, options = {}) => { requests.push({ route, ...options }); const custom = intercept?.(route, options); if (custom !== undefined) return await custom; const response = await f.call(route, options.body, options.method); if (response.status >= 400) throw new Error('The exact source or review is unavailable.'); return response.data; };
  const ui = mountWritingUI({ root, request, element: (tag, cls, text) => new Node(tag, cls, text, node => { if (node.tagName === 'a') downloads.push(node); }),
    busy(control, action) { control.disabled = true; const promise = Promise.resolve().then(action).finally(() => { control.disabled = false; }); jobs.push(promise); return promise; },
    confirmAction: async () => { throw new Error('Downloads cannot implicitly approve another write'); } });
  t.after(() => { ui.reset(); for (const undo of restore.reverse()) undo(); });
  async function settle() { for (let count = 0; count < 10; count++) { await Promise.resolve(); await Promise.all(jobs.map(job => job.catch(() => {}))); } }
  async function click(label) { fire(find(root, label)); await settle(); }
  await ui.refresh(); await click('Open writing item');
  return { root, ui, downloads, created, revoked, requests, timers, click, settle, fire: label => fire(find(root, label)) };
}
const docxButton = 'Download formatted Word (.docx)', texButton = 'Download printable LaTeX source (.tex)';

test('RWH05: actual shipped writing controller calls both paired HTTP routes and prepares exact verified Blob downloads with cleanup', async t => {
  const f = await fixture(t), { record } = await seed(f), before = await state(f), h = await uiFixture(t, f);
  for (const [format, label] of [['docx', docxButton], ['tex', texButton]]) {
    const receipt = await result(f, record, format); await h.click(label); const prepared = h.created.at(-1), link = h.downloads.at(-1);
    assert.equal(prepared.blob.type, receipt.mime); assert.equal(sha(Buffer.from(await prepared.blob.arrayBuffer())), receipt.sha256); assert.equal(link.download, receipt.filename);
    assert.equal(link.href, prepared.url); assert.ok(walk(h.root).includes(link)); assert.ok(h.root.textContent.includes('download prepared'));
    assert.deepEqual(h.requests.filter(call => call.method).at(-1), { route: path(record, format), method: 'POST', body: review(record) });
  }
  assert.equal(h.created.length, 2); assert.equal(h.downloads.length, 2); assert.equal(h.timers.size, 2); assert.deepEqual(await state(f), before);
  h.ui.reset(); assert.equal(h.timers.size, 0); assert.equal(walk(h.root).some(node => node.tagName === 'a'), false); assert.deepEqual(h.revoked, h.created.map(item => item.url));
});

test('RWH06: actual controller suppresses a late rich response after paired workspace reset, and duplicate clicks cannot duplicate exports', async t => {
  const f = await fixture(t), { record } = await seed(f), started = deferred(), released = deferred();
  const h = await uiFixture(t, f, { intercept: route => route === path(record, 'docx') ? (started.resolve(), released.promise) : undefined });
  h.fire(docxButton); h.fire(docxButton); await started.promise; h.ui.reset(); released.resolve(await result(f, record, 'docx')); await h.settle();
  assert.equal(h.requests.filter(call => call.route === path(record, 'docx')).length, 1); assert.equal(h.created.length, 0); assert.equal(h.downloads.length, 0);
  assert.equal(h.timers.size, 0); assert.equal(walk(h.root).some(node => node.tagName === 'a'), false);
});

test('RWH07: controller source change/refresh invalidates current rich controls and rejects an in-flight response', async t => {
  const f = await fixture(t), { record, source } = await seed(f), receipt = await result(f, record, 'tex'), started = deferred(), released = deferred();
  const h = await uiFixture(t, f, { intercept: route => route === path(record, 'tex') ? (started.resolve(), released.promise) : undefined });
  h.fire(texButton); await started.promise;
  await f.call(`/documents/${source.document.id}`, { expected_revision: source.document.revision, content: 'A new independent source revision' }, 'PATCH'); await h.ui.refresh();
  released.resolve(receipt); await h.settle(); assert.equal(h.created.length, 0); assert.equal(h.downloads.length, 0); assert.ok(h.root.textContent.includes('Cached draft text was cleared'));
  assert.equal(walk(h.root).some(node => node.tagName === 'button' && node.textContent === texButton), false);
});

test('RWH08: denied HTTP rich export reaches the actual controller error status without creating a Blob or claiming a saved file', async t => {
  const f = await fixture(t), { source } = await seed(f), h = await uiFixture(t, f);
  await f.call(`/documents/${source.document.id}`, { expected_revision: source.document.revision, content: 'Changed source after view' }, 'PATCH'); await h.click(docxButton);
  assert.equal(h.created.length, 0); assert.equal(h.downloads.length, 0); assert.ok(h.root.textContent.includes('exact source or review is unavailable')); assert.equal(h.root.textContent.includes('download prepared'), false);
});

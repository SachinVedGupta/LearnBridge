import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { createCloudBundle, validateCloudBundle, CLOUD_LIMITS } from '../apps/local-runtime/src/cloud-onboarding.mjs';
import { createCloudOnboardingRoutes } from '../apps/local-runtime/src/cloud-onboarding-routes.mjs';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { mountCloudOnboardingUI } from '../apps/local/public/cloud-onboarding.js';

// Run the actual TSX component's event closures with a small React boundary.
// This proves download sequencing and byte integrity, not a browser file save.
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
function bundle() {
  const text = 'Literal synthetic selected source. Café λ';
  return createCloudBundle({ format: 'learnbridge-selected-cloud-export', schema_version: 1, origin: 'https://learnbridge.example', owner: { student_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', verification: 'supabase_session_at_fetch' },
    provider: 'googledocs', account_id: 'ca_synthetic_student', academic_policy: 'learning_support', retrieved_at: new Date().toISOString(), records: [{ id: 'synthetic_doc_1', title: 'Synthetic note', url: 'https://docs.google.com/document/d/synthetic_doc_1/edit', modified_at: null, text,
      sha256: createHash('sha256').update(text).digest('hex'), coverage: 'partial_text', limitations: ['Partial source text only.'] }], limitations: ['No model access.'] });
}
const walk = value => !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(walk) : [value, ...walk(value.props?.children)];
function harness(t, mode = 'normal', selected = bundle()) {
  const preview = { bundle: selected, review_hash: selected.bundle_hash, preview_token: 'synthetic_opaque_token', expires_at: new Date(Date.now() + 300000).toISOString() };
  const values = [[], '', '', 'learning_support', [], new Set(), preview, true, '', '', ''], hooks = [], calls = [], downloads = [], blobs = [], fetchStarted = deferred(), releaseFetch = deferred(), hashStarted = deferred(), releaseHash = deferred(); let index = 0, digests = 0;
  const react = { useState(initial) { const own = index++; if (!(own in values)) values[own] = initial; return [values[own], value => { values[own] = typeof value === 'function' ? value(values[own]) : value; }]; }, useRef(initial) { const ref = { current: initial }; hooks.push(ref); return ref; }, useEffect() {} };
  const source = readFileSync(new URL('../apps/web/src/app/onboarding/cloud/cloud-onboarding-client.tsx', import.meta.url), 'utf8'), code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} }, jsx = (type, props) => ({ type, props });
  new Function('require', 'module', 'exports', code)(name => { if (name === 'react') return react; if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }; throw Error(`Unexpected component dependency ${name}`); }, module, module.exports);
  const originals = Object.fromEntries(['window', 'document', 'fetch', 'crypto', 'setTimeout', 'clearTimeout'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const createURL = URL.createObjectURL, revokeURL = URL.revokeObjectURL;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { confirm: () => true } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement(tag) { assert.equal(tag, 'a'); const link = { click() { downloads.push({ href: link.href, filename: link.download }); } }; return link; } } });
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async (path, options) => { calls.push({ path, ...options }); fetchStarted.resolve(); if (mode === 'network') await releaseFetch.promise; const result = { bundle: structuredClone(selected), sharing: 'not_granted', filename: 'LearnBridge-selected-googledocs.json' }; if (mode === 'corrupted') result.bundle.records[0].text += ' changed'; return { ok: true, json: async () => result }; } });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: { async digest(algorithm, input) { assert.equal(algorithm, 'SHA-256'); const bytes = createHash('sha256').update(input).digest(); if (++digests === 1 && mode === 'hash') { hashStarted.resolve(); await releaseHash.promise; } return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } } } });
  Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: () => 1 }); Object.defineProperty(globalThis, 'clearTimeout', { configurable: true, value: () => {} });
  URL.createObjectURL = value => { blobs.push(value); return 'blob:synthetic-verified-transfer'; }; URL.revokeObjectURL = () => {};
  t.after(() => { URL.createObjectURL = createURL; URL.revokeObjectURL = revokeURL; for (const [name, descriptor] of Object.entries(originals)) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
  const tree = module.exports.default(), nodes = walk(tree), review = nodes.find(node => node.type === 'input' && node.props.type === 'checkbox' && node.props.checked === true), download = nodes.find(node => node.type === 'button' && node.props.children === 'Download reviewed selected-source bundle');
  assert.ok(review); assert.ok(download); return { selected, values, hooks, calls, downloads, blobs, fetchStarted, releaseFetch, hashStarted, releaseHash, start: () => download.props.onClick(), uncheck: () => review.props.onChange({ target: { checked: false } }) };
}

test('CHUI01: actual hosted handler checks exact hashes and prepares only the reviewed JSON bytes with an honest prepared notice', async t => {
  const h = harness(t); h.start(); await settle(); assert.deepEqual(h.downloads, [{ href: 'blob:synthetic-verified-transfer', filename: 'LearnBridge-selected-googledocs.json' }]);
  assert.deepEqual(JSON.parse(await h.blobs[0].text()), h.selected); assert.equal(h.blobs[0].type, 'application/json'); assert.match(h.values[9], /download prepared/); assert.doesNotMatch(h.values[9], /download saved|imported successfully/);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].path, '/api/cloud-onboarding/export'); assert.deepEqual(JSON.parse(h.calls[0].body), { preview_token: 'synthetic_opaque_token', review_hash: h.selected.bundle_hash, confirm: true });
});
test('CHUI02: unchecking review while export is pending aborts it and a late response cannot prepare a download', async t => {
  const h = harness(t, 'network'); h.start(); await h.fetchStarted.promise; h.uncheck(); assert.equal(h.calls[0].signal.aborted, true); h.releaseFetch.resolve(); await settle();
  assert.equal(h.values[7], false); assert.equal(h.downloads.length, 0); assert.equal(h.blobs.length, 0); assert.equal(h.hooks[0].current.generation, 1);
});
test('CHUI03: unchecking review during asynchronous byte verification prevents a later file preparation', async t => {
  const h = harness(t, 'hash'); h.start(); await h.hashStarted.promise; h.uncheck(); h.releaseHash.resolve(); await settle();
  assert.equal(h.downloads.length, 0); assert.equal(h.blobs.length, 0); assert.equal(h.values[7], false);
});
test('CHUI04: a changed returned selected body fails integrity verification before Blob or download creation', async t => {
  const h = harness(t, 'corrupted'); h.start(); await settle(); assert.equal(h.downloads.length, 0); assert.equal(h.blobs.length, 0); assert.match(h.values[10], /did not match this exact review/);
});
test('CHUI05: near-limit actual TSX Blob stays within the final wire budget and passes the shipped local file preview/import', async t => {
  const { bundle_hash, ...base } = bundle(), blank = '';
  base.records = Array.from({ length: 3 }, (_, index) => ({ ...base.records[0], id: `synthetic_doc_${index}`, url: `https://docs.google.com/document/d/synthetic_doc_${index}/edit`, text: blank, sha256: createHash('sha256').update(blank).digest('hex') }));
  const baseline = createCloudBundle(base), count = Math.floor((CLOUD_LIMITS.bundleBytes - Buffer.byteLength(JSON.stringify(baseline))) / 6), text = '\n'.repeat(count);
  const selected = createCloudBundle({ ...base, records: base.records.map(record => ({ ...record, text, sha256: createHash('sha256').update(text).digest('hex') })) });
  assert.ok(Buffer.byteLength(JSON.stringify(selected)) >= CLOUD_LIMITS.bundleBytes - 5); assert.ok(Buffer.byteLength(JSON.stringify(selected, null, 2) + '\n') > CLOUD_LIMITS.bundleBytes);
  const h = harness(t, 'normal', selected); h.start(); await settle(); assert.equal(h.blobs.length, 1);
  const blob = h.blobs[0], wire = await blob.text(); assert.equal(wire, JSON.stringify(selected)); assert.equal(blob.size, Buffer.byteLength(wire)); assert.ok(blob.size <= CLOUD_LIMITS.bundleBytes); assert.deepEqual(validateCloudBundle(JSON.parse(wire)), selected);

  class Node {
    constructor(tag, cls = '', value = '') { this.tagName = tag; this.className = cls; this.text = value; this.children = []; this.hidden = false; this.checked = false; this.disabled = false; this.value = ''; this.listeners = new Map(); this.classList = { toggle() {} }; }
    append(...nodes) { this.children.push(...nodes); if (this.tagName === 'select' && this.children.length === 1) this.value = this.children[0].value; }
    replaceChildren(...nodes) { this.children = []; this.text = ''; this.append(...nodes); }
    setAttribute() {} addEventListener(event, callback) { this.listeners.set(event, callback); }
    get textContent() { return this.text + this.children.map(node => node.textContent).join(''); }
    set textContent(value) { this.text = value; this.children = []; }
  }
  const directory = mkdtempSync(join(tmpdir(), 'learnbridge-cloud-wire-boundary-')), store = LocalStore.open({ root: join(directory, 'workspace') }), routes = createCloudOnboardingRoutes({ store }), localRoot = new Node('main'), jobs = [];
  const local = mountCloudOnboardingUI({ root: localRoot, element: (tag, cls, value) => new Node(tag, cls, value), request: async (route, options = {}) => (await routes.handle({ route, method: options.method || 'GET', session: { nonce: 'synthetic-file-review' }, privateBody: async () => options.body })).data,
    busy(control, action) { const job = Promise.resolve().then(action); jobs.push(job); return job; }, confirmAction: async () => true });
  t.after(() => { local.reset(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const nodes = node => [node, ...node.children.flatMap(nodes)], file = nodes(localRoot).find(node => node.tagName === 'input' && node.type === 'file');
  file.files = [{ size: blob.size, text: async () => wire }]; file.listeners.get('change')(); await settle();
  const prepare = nodes(localRoot).find(node => node.tagName === 'button' && node.textContent === 'Preview exact selected cloud import'); assert.equal(prepare.disabled, false); prepare.listeners.get('click')(); await jobs.at(-1);
  const passages = nodes(localRoot).filter(node => node.tagName === 'pre'); assert.equal(passages.length, 3); assert.ok(passages.every(node => node.textContent === text)); assert.equal(store.listDocuments().length, 0);
  nodes(localRoot).find(node => node.tagName === 'input' && node.type === 'checkbox').checked = true;
  nodes(localRoot).find(node => node.tagName === 'button' && node.textContent === 'Save reviewed private source copies').listeners.get('click')(); await jobs.at(-1);
  assert.equal(store.listDocuments().length, 3); assert.ok(store.listDocuments().every(note => store.getDocument(note.id).text.startsWith(text))); assert.equal(store.listAgentGrants().length, 0); assert.equal(store.listTasks().length, 0);
});

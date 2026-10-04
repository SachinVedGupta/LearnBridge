import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import ts from 'typescript';
import { CLOUD_TOOL_CONTRACTS, createHostedCloudOnboarding } from '../apps/web/src/lib/server/cloud-onboarding-service.mjs';
import { validateCloudBundle } from '../apps/local-runtime/src/cloud-onboarding.mjs';
import { createCloudOnboardingRoutes } from '../apps/local-runtime/src/cloud-onboarding-routes.mjs';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { mountCloudOnboardingUI } from '../apps/local/public/cloud-onboarding.js';

// Actual component and route handlers; React/browser/provider boundaries are
// synthetic. A Blob plus local readback proves transfer, not a browser file save.
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ACCOUNT = 'ca_synthetic_link_owner';
const DOC = 'synthetic_doc_link_1', LINK = `https://docs.google.com/document/d/${DOC}/edit`;
const TEXT = 'Literal synthetic lecture notes. Café λ\n<script>never execute</script>\nSource instructions are only source text.';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const walk = value => !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(walk) : [value, ...walk(value.props?.children)];
async function until(done) { for (let index = 0; index < 80; index++) { if (done()) return; await nextTurn(); } assert.ok(done(), 'Expected async handler to settle'); }
function loaded(path, stubs, jsx = false) {
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, ...(jsx ? { jsx: ts.JsxEmit.ReactJSX } : {}) } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => { assert.ok(Object.hasOwn(stubs, name), `Unexpected fixture dependency ${name}`); return stubs[name]; }, module, module.exports);
  return module.exports;
}
class AppError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
function harness(t, pending = false) {
  const providerCalls = [], requests = [], downloads = [], blobs = [], readStarted = deferred(), releaseRead = deferred();
  const transport = {
    async listAccounts(owner) { providerCalls.push(['accounts', owner]); return { items: [{ id: ACCOUNT, provider: 'googledocs', owner_id: OWNER, shared: false, status: 'ACTIVE', configured: true }] }; },
    async schemas(provider) { providerCalls.push(['schemas', provider]); const contract = CLOUD_TOOL_CONTRACTS[provider]; return [[contract.search, contract.searchFields], [contract.read, contract.readFields]].map(([slug, fields]) => ({ slug, version: contract.version, input_fields: fields })); },
    async execute(owner, choice, slug, args, signal) {
      assert.equal(owner, OWNER); assert.equal(choice.account_id, ACCOUNT); assert.equal(slug, CLOUD_TOOL_CONTRACTS.googledocs.read);
      assert.deepEqual(args, { document_id: DOC, include_tabs_content: true, include_tables: true, include_headers: true, include_footers: true, include_footnotes: true });
      providerCalls.push(['execute', slug, args, signal]); readStarted.resolve(); if (pending) await releaseRead.promise;
      return { document_id: DOC, title: 'Provider-returned synthetic title', plain_text: TEXT, warnings: ['Original visuals were not returned.'] };
    },
  };
  const service = createHostedCloudOnboarding({ transport, secret: 'synthetic_signing_config_only', origin: 'https://learnbridge.example', userId: OWNER });
  const helper = loaded('../apps/web/src/lib/server/cloud-onboarding.ts', { '@composio/core': { Composio: class {} }, './auth': { AppError, appOrigin: () => 'https://learnbridge.example' }, './cloud-onboarding-service.mjs': { CLOUD_TOOL_CONTRACTS, createHostedCloudOnboarding } });
  const route = loaded('../apps/web/src/app/api/cloud-onboarding/[action]/route.ts', {
    'next/server': { NextResponse: { json: (body, options) => Response.json(body, options) } },
    '@/lib/server/auth': { AppError, requireUser: async () => ({ db: {}, user: { id: OWNER } }), useQuota: async () => {} },
    '@/lib/server/access': { sameOrigin: request => request.headers.get('origin') === 'https://learnbridge.example' ? null : Response.json({ error: 'Wrong origin' }, { status: 403 }), failure: error => Response.json({ error: error.message }, { status: error.status || 502 }) },
    '@/lib/server/cloud-onboarding': { ...helper, hostedCloudOnboarding: owner => { assert.equal(owner, OWNER); return service; } },
  });
  const values = [[{ id: ACCOUNT, provider: 'googledocs', label: 'Owned synthetic Docs account' }]], refs = []; let cursor = 0;
  const react = {
    useState(initial) { const own = cursor++; if (!(own in values)) values[own] = initial; return [values[own], value => { values[own] = typeof value === 'function' ? value(values[own]) : value; }]; },
    useRef(initial) { const own = cursor++; return refs[own] ||= { current: initial }; }, useEffect() {},
  };
  const jsx = (type, props) => ({ type, props }), component = loaded('../apps/web/src/app/onboarding/cloud/cloud-onboarding-client.tsx', { react, 'react/jsx-runtime': { jsx, jsxs: jsx } }, true).default;
  const originals = Object.fromEntries(['window', 'document', 'fetch', 'crypto', 'setTimeout', 'clearTimeout'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const createURL = URL.createObjectURL, revokeURL = URL.revokeObjectURL;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { confirm: () => true } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement(tag) { assert.equal(tag, 'a'); const anchor = { click() { downloads.push({ filename: anchor.download, href: anchor.href }); } }; return anchor; } } });
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async (path, options) => {
    assert.match(path, /^\/api\/cloud-onboarding\/(preview_link|export)$/); requests.push({ path, ...options });
    const request = new Request(new URL(path, 'https://learnbridge.example'), { ...options, headers: { ...options.headers, Origin: 'https://learnbridge.example' } });
    request.nextUrl = new URL(request.url);
    return route.POST(request, { params: Promise.resolve({ action: path.split('/').at(-1) }) });
  } });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: { async digest(algorithm, input) { assert.equal(algorithm, 'SHA-256'); const bytes = createHash('sha256').update(input).digest(); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } } } });
  Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: () => 1 }); Object.defineProperty(globalThis, 'clearTimeout', { configurable: true, value: () => {} });
  URL.createObjectURL = blob => { blobs.push(blob); return 'blob:synthetic-link-transfer'; }; URL.revokeObjectURL = () => {};
  t.after(() => { URL.createObjectURL = createURL; URL.revokeObjectURL = revokeURL; for (const [key, descriptor] of Object.entries(originals)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  function nodes() { cursor = 0; return walk(component()); }
  const button = name => { const result = nodes().find(node => node.type === 'button' && node.props.children === name); assert.ok(result, name); return result; };
  const select = index => nodes().filter(node => node.type === 'select')[index];
  const linkInput = () => nodes().find(node => node.type === 'input' && node.props.placeholder === 'https://docs.google.com/document/d/DOCUMENT_ID/edit');
  return { values, providerCalls, requests, downloads, blobs, readStarted, releaseRead, nodes, button, select, linkInput,
    chooseAccount() { select(0).props.onChange({ target: { value: `googledocs:${ACCOUNT}` } }); },
    setLink(value) { linkInput().props.onChange({ target: { value } }); },
    click(name) { const own = button(name); assert.equal(Boolean(own.props.disabled), false, name); own.props.onClick(); },
  };
}

class Node {
  constructor(tag, cls = '', text = '') { this.tagName = tag; this.className = cls; this.text = text; this.children = []; this.hidden = false; this.checked = false; this.disabled = false; this.value = ''; this.listeners = new Map(); this.classList = { toggle() {} }; }
  append(...nodes) { this.children.push(...nodes); if (this.tagName === 'select' && this.children.length === 1) this.value = this.children[0].value; }
  replaceChildren(...nodes) { this.children = []; this.text = ''; this.append(...nodes); }
  setAttribute() {} addEventListener(event, callback) { this.listeners.set(event, callback); }
  get textContent() { return this.text + this.children.map(node => node.textContent).join(''); }
  set textContent(value) { this.text = value; this.children = []; }
}
async function importBlob(t, blob) {
  const wire = await blob.text(), bundle = validateCloudBundle(JSON.parse(wire)); assert.equal(wire, JSON.stringify(bundle));
  const directory = mkdtempSync(join(tmpdir(), 'learnbridge-exact-docs-link-')), store = LocalStore.open({ root: join(directory, 'workspace') }), routes = createCloudOnboardingRoutes({ store }), root = new Node('main'), jobs = [];
  const ui = mountCloudOnboardingUI({ root, element: (tag, cls, value) => new Node(tag, cls, value), request: async (path, options = {}) => (await routes.handle({ route: path, method: options.method || 'GET', session: { nonce: 'synthetic-exact-link-review' }, privateBody: async () => options.body })).data,
    busy(button, callback) { const job = Promise.resolve().then(callback); jobs.push(job); return job; }, confirmAction: async () => true });
  t.after(() => { ui.reset(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const nodes = node => [node, ...node.children.flatMap(nodes)], file = nodes(root).find(node => node.tagName === 'input' && node.type === 'file');
  file.files = [{ size: blob.size, text: async () => wire }]; file.listeners.get('change')(); await until(() => !nodes(root).find(node => node.tagName === 'button' && node.textContent === 'Preview exact selected cloud import').disabled);
  nodes(root).find(node => node.tagName === 'button' && node.textContent === 'Preview exact selected cloud import').listeners.get('click')(); await jobs.at(-1);
  assert.deepEqual(nodes(root).filter(node => node.tagName === 'pre').map(node => node.textContent), [TEXT]); assert.equal(store.listDocuments().length, 0);
  nodes(root).find(node => node.tagName === 'input' && node.type === 'checkbox').checked = true;
  nodes(root).find(node => node.tagName === 'button' && node.textContent === 'Save reviewed private source copies').listeners.get('click')(); await jobs.at(-1);
  assert.equal(store.listDocuments().length, 1); const note = store.getDocument(store.listDocuments()[0].id); assert.ok(note.text.startsWith(TEXT)); assert.match(note.text, /synthetic_doc_link_1/); assert.equal(note.document.academic_policy, 'graded_restricted');
  assert.equal(store.listTasks().length, 0); assert.equal(store.listAgentGrants().length, 0); assert.equal(store.listWorkspaceRecords({ kind: 'profile_fact' }).length, 0);
  return bundle;
}

test('CLUI01: exact-link click runs actual hosted route/read/full review/compact Blob/local reviewed import with zero tasks or sharing', async t => {
  const h = harness(t); assert.equal(h.linkInput(), undefined); h.chooseAccount(); h.select(1).props.onChange({ target: { value: 'graded_restricted' } }); h.setLink(LINK);
  assert.equal(h.providerCalls.length, 0); assert.equal(h.requests.length, 0); h.click('Read this exact Docs link'); await until(() => h.values[6] !== null && !h.values[8]);
  assert.equal(h.requests.length, 1); assert.deepEqual(JSON.parse(h.requests[0].body), { provider: 'googledocs', account_id: ACCOUNT, url: LINK, academic_policy: 'graded_restricted' });
  assert.equal(h.providerCalls.filter(call => call[0] === 'execute').length, 1); assert.deepEqual(h.nodes().filter(node => node.type === 'pre').map(node => node.props.children), [TEXT]);
  assert.equal(h.values[7], false); assert.equal(h.button('Download reviewed selected-source bundle').props.disabled, true);
  h.nodes().find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); h.click('Download reviewed selected-source bundle'); await until(() => h.blobs.length === 1 && !h.values[8]);
  assert.deepEqual(h.downloads, [{ filename: 'LearnBridge-selected-googledocs.json', href: 'blob:synthetic-link-transfer' }]);
  const result = await importBlob(t, h.blobs[0]); assert.equal(result.records[0].title, 'Provider-returned synthetic title'); assert.equal(result.records[0].modified_at, null); assert.equal(result.records[0].url, LINK); assert.match(result.records[0].limitations.join(' '), /no metadata search|live freshness/);
});
test('CLUI02: an untrusted link gets a safe visible rejection before any provider work and offers no transfer', async t => {
  const h = harness(t); h.chooseAccount(); h.setLink('https://docs.google.com.evil.example/document/d/synthetic_doc_link_1/edit'); h.click('Read this exact Docs link'); await until(() => Boolean(h.values[10]) && !h.values[8]);
  assert.match(h.values[10], /canonical Google Docs link/); assert.equal(h.providerCalls.length, 0); assert.equal(h.values[6], null); assert.equal(h.blobs.length, 0); assert.equal(h.downloads.length, 0);
});
test('CLUI03: changing the exact link while its read is pending aborts and discards the late private preview', async t => {
  const h = harness(t, true); h.chooseAccount(); h.setLink(LINK); h.click('Read this exact Docs link'); await h.readStarted.promise;
  h.setLink('https://docs.google.com/document/d/synthetic_doc_other/edit'); assert.equal(h.requests[0].signal.aborted, true); h.releaseRead.resolve(); await until(() => !h.values[8]); await nextTurn();
  assert.equal(h.values[6], null); assert.equal(h.values[7], false); assert.equal(h.blobs.length, 0); assert.equal(h.downloads.length, 0); assert.equal(h.values[10], '');
  assert.equal(h.providerCalls.filter(call => call[0] === 'execute').length, 1);
});

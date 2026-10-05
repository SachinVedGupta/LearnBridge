import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import { createWordTextArtifact, WORD_TEXT_MIME } from '../apps/local-runtime/src/word-text-artifact.mjs';
import { mountWritingUI } from '../apps/local/public/writing.js';

// The real shipped handlers receive real formatter bytes. Only the DOM, request
// boundary, download click and cleanup clock are synthetic. These checks do not
// claim browser layout, native Office rendering, HTTP or provider verification.
class Node {
  constructor(tag, className = '', text = '', clicked = () => {}) {
    this.tagName = tag; this.className = className; this.text = text; this.children = []; this.parent = null;
    this.listeners = new Map(); this.attributes = new Map(); this.dataset = {}; this.hidden = false; this.disabled = false;
    this.checked = false; this.value = ''; this.clicked = clicked; const classes = new Set();
    this.classList = { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } };
  }
  append(...children) {
    for (const child of children) { child.parent = this; this.children.push(child); }
    if (this.tagName === 'select' && this.children.length === 1) this.value = this.children[0].value;
  }
  replaceChildren(...children) { for (const child of this.children) child.parent = null; this.children = []; this.text = ''; this.append(...children); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  addEventListener(type, callback) { this.listeners.set(type, [...(this.listeners.get(type) || []), callback]); }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this.text = String(value); }
  get options() { return this.children; }
  get selectedIndex() { return this.children.findIndex(option => option.value === this.value); }
  click() { this.clicked(this); fire(this); }
  remove() { if (!this.parent) return; const parent = this.parent; parent.children = parent.children.filter(child => child !== this); this.parent = null; }
  reset() { for (const node of walk(this)) if (['input', 'textarea', 'select'].includes(node.tagName)) { node.value = node.tagName === 'select' ? node.children[0]?.value || '' : ''; node.checked = false; } }
}
const walk = node => [node, ...node.children.flatMap(walk)];
const fire = (node, type = 'click') => { for (const callback of node.listeners.get(type) || []) callback({ preventDefault() {}, currentTarget: node }); };
const byButton = (root, text, index = 0) => { const found = walk(root).filter(node => node.tagName === 'button' && node.textContent === text)[index]; assert.ok(found, text); return found; };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const clone = value => structuredClone(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const ids = { writing: '11111111-1111-4111-8111-111111111111', document: '22222222-2222-4222-8222-222222222222',
  source: '33333333-3333-4333-8333-333333333333', other: '44444444-4444-4444-8444-444444444444' };

function fixture({ state = 'accepted', modelOutput = false } = {}) {
  const text = 'Reviewed synthetic writing. 🧠\r\nKeep <tags>, & punctuation literal.\n\nFinal line.\tTab.';
  const document = { id: ids.document, revision: state === 'applied_revision' ? 3 : 1, sha256: sha(text) };
  const source = { id: state === 'applied_revision' ? ids.document : ids.source, revision: state === 'applied_revision' ? 2 : 1,
    sha256: sha('Original synthetic source'), title: 'Synthetic source', academic_policy: 'learning_support' };
  const payload = { title: 'Reviewed writing fixture', kind: state === 'applied_revision' ? 'revision' : 'markdown_artifact',
    origin: modelOutput ? 'agent_paste' : 'student', draft_text: text, draft_sha256: sha(text), academic_policy: 'learning_support', source_documents: [source] };
  const record = { id: ids.writing, revision: 2, title: payload.title, data: { format: 'writing_proposal', state,
    payload, payload_hash: sha(canonical(payload)), source_documents: [source], academic_policy: 'learning_support',
    content_status: modelOutput ? 'student_reviewed_model_output_facts_unverified' : 'student_reviewed_content',
    [state === 'applied_revision' ? 'applied_note' : 'accepted_note']: document } };
  const generated = createWordTextArtifact({ text, provenance: {
    writing_record: { id: record.id, revision: record.revision, payload_hash: record.data.payload_hash, state }, document,
    source_documents: [{ id: source.id, revision: source.revision, sha256: source.sha256 }],
    academic_policy: record.data.academic_policy, content_status: record.data.content_status,
  } });
  return { record, bytes: generated.bytes, receipt: { filename: 'Synthetic-reviewed-writing.docx', mime: WORD_TEXT_MIME, encoding: 'base64',
    base64: generated.bytes.toString('base64'), byte_length: generated.bytes.length, sha256: sha(generated.bytes), manifest: generated.manifest,
    document: { ...document, title: record.title }, source_documents: [source], validation: 'fixed_ooxml_structure_and_exact_text_hash',
    sharing: 'not_granted', content_status: record.data.content_status, visual_review: 'pending',
    warning: 'Synthetic Word text; visual review remains pending.' } };
}

function harness(t, value = fixture(), { intercept, digest, confirm } = {}) {
  const calls = [], downloads = [], created = [], revoked = [], timers = new Map(), jobs = []; let timerIndex = 0;
  const root = new Node('main'), records = [clone(value.record)], rows = () => records.map(record => ({
    id: record.id, title: record.title, revision: record.revision, state: record.data.state, source_count: record.data.source_documents.length, stale: false,
  }));
  const restore = [];
  function replace(target, name, replacement) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name); restore.push(() => descriptor ? Object.defineProperty(target, name, descriptor) : delete target[name]);
    Object.defineProperty(target, name, { configurable: true, writable: true, value: replacement });
  }
  replace(URL, 'createObjectURL', blob => { assert.ok(blob instanceof Blob); const url = `blob:synthetic-word-${created.length + 1}`; created.push({ url, blob }); return url; });
  replace(URL, 'revokeObjectURL', url => revoked.push(url));
  replace(globalThis, 'crypto', { randomUUID, subtle: { digest: digest || webcrypto.subtle.digest.bind(webcrypto.subtle) } });
  replace(globalThis, 'setTimeout', (callback, milliseconds) => { const id = ++timerIndex; timers.set(id, { callback, milliseconds }); return id; });
  replace(globalThis, 'clearTimeout', id => timers.delete(id));
  const request = async (path, options = {}) => {
    calls.push({ path, ...clone(options) }); const intercepted = intercept?.(path, options);
    if (intercepted !== undefined) return await intercepted;
    if (path === '/writing/documents') return { items: [] };
    if (path === '/writing/items') return { items: rows() };
    const record = records.find(record => path === `/writing/items/${record.id}`);
    if (record && !options.method) return { item: clone(record) };
    if (path === `/writing/items/${value.record.id}/export-docx`) return clone(value.receipt);
    throw new Error(`Unexpected UI request: ${path}`);
  };
  const ui = mountWritingUI({ root, request,
    element: (tag, className, text) => new Node(tag, className, text, node => { if (node.tagName === 'a') downloads.push(node); }),
    busy(button, action) {
      button.disabled = true; const job = Promise.resolve().then(action).finally(() => { button.disabled = false; }); jobs.push(job); return job;
    }, confirmAction: confirm || (async () => { throw new Error('Word download must not trigger an unrelated confirmation or write'); }) });
  t.after(() => { ui.reset(); for (const undo of restore.reverse()) undo(); });
  const startClick = (text, index = 0) => { const button = byButton(root, text, index); assert.equal(button.disabled, false); fire(button); return jobs.at(-1).catch(() => {}); };
  return { root, ui, records, calls, downloads, created, revoked, timers, startClick,
    async click(text, index = 0) { await startClick(text, index); },
    async open() { await ui.refresh(); await startClick('Open writing item'); },
    get status() { return walk(root).find(node => node.id === 'writing-status'); },
    cleanup() { const pending = [...timers.values()]; timers.clear(); for (const timer of pending) { assert.equal(timer.milliseconds, 30000); timer.callback(); } },
  };
}
const wordButton = 'Download Word text (.docx)';
const assertNoDownload = h => {
  assert.equal(h.created.length, 0); assert.equal(h.downloads.length, 0); assert.equal(h.timers.size, 0);
  assert.equal(walk(h.root).some(node => node.tagName === 'a' && node.download), false);
};

test('WORD-UI01: exact reviewed POST prepares real formatter bytes in a Word Blob and clicks only the verified link', async t => {
  const value = fixture(), before = { record: clone(value.record), receipt: clone(value.receipt), bytes: Buffer.from(value.bytes) }, h = harness(t, value); await h.open(); await h.click(wordButton);
  const mutations = h.calls.filter(call => call.method);
  assert.deepEqual(mutations, [{ path: `/writing/items/${value.record.id}/export-docx`, method: 'POST',
    body: { expected_revision: value.record.revision, payload_hash: value.record.data.payload_hash } }]);
  assert.equal(h.created.length, 1); assert.equal(h.created[0].blob.type, WORD_TEXT_MIME);
  assert.deepEqual(Buffer.from(await h.created[0].blob.arrayBuffer()), value.bytes);
  assert.equal(h.downloads.length, 1); const link = h.downloads[0];
  assert.equal(link.href, h.created[0].url); assert.equal(link.download, value.receipt.filename);
  assert.equal(link.textContent, 'Download verified Word text'); assert.ok(walk(h.root).includes(link));
  assert.match(h.status.textContent, /Verified Word text download prepared/); assert.match(h.status.textContent, /visual review remains pending/);
  assert.equal(h.timers.size, 1); assert.deepEqual(value, before, 'Neither reviewed data nor receipt was mutated');
  h.cleanup(); assert.deepEqual(h.revoked, [link.href]); assert.equal(walk(h.root).includes(link), false);
  h.ui.reset(); assert.equal(h.revoked.length, 1, 'A timer-cleaned URL is no longer retained by the UI');
});

test('WORD-UI02: applied revisions download the applied copy while factual and visual review limits remain visible', async t => {
  const value = fixture({ state: 'applied_revision', modelOutput: true }), h = harness(t, value);
  await h.open(); await h.click(wordButton);
  assert.equal(h.downloads.length, 1); assert.deepEqual(Buffer.from(await h.created[0].blob.arrayBuffer()), value.bytes);
  assert.match(h.root.textContent, /Model output is unverified/); assert.match(h.root.textContent, /Exact reviewed revision saved to the source/);
  assert.equal(value.receipt.manifest.provenance.document.revision, 3);
  assert.equal(h.calls.at(-1).body.expected_revision, 2); assert.equal(h.calls.at(-1).body.payload_hash, value.record.data.payload_hash);
});

test('WORD-UI03: an invalid reviewed receipt shows its error without making a Blob URL or download click', async t => {
  const value = fixture(); value.receipt = clone(value.receipt); value.receipt.manifest.provenance.writing_record.revision++;
  const h = harness(t, value); await h.open(); await h.click(wordButton);
  assertNoDownload(h); assert.equal(h.status.hidden, false); assert.match(h.status.textContent, /did not match this exact reviewed item/);
  assert.equal(byButton(h.root, wordButton).disabled, false);
});

test('WORD-UI04: real package bytes with a false binary hash cannot reach the download click', async t => {
  const value = fixture(); value.receipt = clone(value.receipt); value.receipt.sha256 = sha('Not the Word package');
  const h = harness(t, value); await h.open(); await h.click(wordButton);
  assertNoDownload(h); assert.match(h.status.textContent, /Word file hash did not match/);
});

test('WORD-UI05: a denied export request cannot prepare a file or imply success', async t => {
  const h = harness(t, fixture(), { intercept: path => path.endsWith('/export-docx') ? Promise.reject(new Error('Exact source revision is unavailable.')) : undefined });
  await h.open(); await h.click(wordButton); assertNoDownload(h);
  assert.match(h.status.textContent, /Exact source revision is unavailable/); assert.doesNotMatch(h.status.textContent, /download prepared/);
});

test('WORD-UI06: resetting the session while the export request is pending discards the late receipt before hashing', async t => {
  const value = fixture(), started = deferred(), release = deferred(); let digests = 0;
  const h = harness(t, value, { intercept: path => path.endsWith('/export-docx') ? (started.resolve(), release.promise) : undefined,
    digest: (...args) => { digests++; return webcrypto.subtle.digest(...args); } });
  await h.open(); const pending = h.startClick(wordButton); await started.promise; h.ui.reset();
  release.resolve(clone(value.receipt)); await pending;
  assertNoDownload(h); assert.equal(digests, 0); assert.equal(h.status.textContent, '');
  assert.equal(walk(h.root).some(node => node.tagName === 'pre' && node.textContent.includes(value.record.data.payload.draft_text)), false);
});

test('WORD-UI07: resetting the session during binary hash verification discards the verified bytes', async t => {
  const started = deferred(), release = deferred(), value = fixture();
  const h = harness(t, value, { digest: async (...args) => { started.resolve(); await release.promise; return webcrypto.subtle.digest(...args); } });
  await h.open(); const pending = h.startClick(wordButton); await started.promise; h.ui.reset(); release.resolve(); await pending;
  assertNoDownload(h); assert.equal(h.status.textContent, '');
});

for (const stage of ['request', 'crypto']) {
  test(`WORD-UI${stage === 'request' ? '08' : '09'}: opening another item while ${stage} is pending cannot download the earlier item`, async t => {
    const value = fixture(), started = deferred(), release = deferred(); let digests = 0;
    const h = harness(t, value, {
      intercept: path => stage === 'request' && path.endsWith('/export-docx') ? (started.resolve(), release.promise) : undefined,
      digest: async (...args) => { digests++; if (stage === 'crypto') { started.resolve(); await release.promise; } return webcrypto.subtle.digest(...args); },
    });
    const other = clone(value.record); other.id = ids.other; other.title = 'Different reviewed item'; h.records.push(other);
    await h.open(); const pending = h.startClick(wordButton); await started.promise;
    await h.click('Open writing item', 1); assert.match(h.root.textContent, /Different reviewed item/);
    release.resolve(stage === 'request' ? clone(value.receipt) : undefined); await pending;
    assertNoDownload(h); assert.equal(digests, stage === 'request' ? 0 : 1); assert.doesNotMatch(h.status.textContent, /download prepared/);
  });
}

test('WORD-UI10: refreshing a changed current revision during hash verification clears the cached view and suppresses download', async t => {
  const started = deferred(), release = deferred(), h = harness(t, fixture(), {
    digest: async (...args) => { started.resolve(); await release.promise; return webcrypto.subtle.digest(...args); },
  });
  await h.open(); const pending = h.startClick(wordButton); await started.promise; h.records[0].revision++;
  await h.ui.refresh(); assert.match(h.status.textContent, /writing item changed/); release.resolve(); await pending;
  assertNoDownload(h); assert.match(h.status.textContent, /Cached draft text was cleared/);
  assert.equal(walk(h.root).some(node => node.tagName === 'button' && node.textContent === wordButton), false);
});

test('WORD-UI11: session reset immediately revokes every retained Word URL and later cleanup cannot recreate a link', async t => {
  const h = harness(t); await h.open(); await h.click(wordButton); await h.click(wordButton);
  assert.equal(h.created.length, 2); assert.equal(h.downloads.length, 2); assert.equal(h.timers.size, 2);
  const urls = h.created.map(value => value.url); h.ui.reset(); assert.deepEqual(h.revoked, urls);
  assert.equal(walk(h.root).some(node => node.tagName === 'a'), false); assert.equal(h.status.textContent, '');
  h.cleanup(); assert.deepEqual(h.revoked, [...urls, ...urls]);
  assert.equal(h.created.length, 2); assert.equal(h.downloads.length, 2); assert.equal(walk(h.root).some(node => node.tagName === 'a'), false);
  h.ui.reset(); assert.equal(h.revoked.length, 4, 'Reset does not retain already revoked URLs');
});


test('WRITING-UI12: accepting an exact proposal shows current export controls without a false stale warning', async t => {
  const accepted = fixture(), pending = clone(accepted); pending.record.revision = 1; pending.record.data.state = 'awaiting_review'; delete pending.record.data.accepted_note;
  let h; h = harness(t, pending, { confirm: async () => true, intercept: (path, options) => {
    if (path.endsWith('/accept')) {
      assert.deepEqual(options.body, { expected_revision: 1, payload_hash: pending.record.data.payload_hash });
      h.records[0] = clone(accepted.record); return { item: clone(accepted.record) };
    }
    if (path.endsWith('/export-docx')) return clone(accepted.receipt);
  } });
  await h.open(); const ack = walk(h.root).find(n => n.tagName === 'input' && n.type === 'checkbox' && n.parent?.textContent.includes('I reviewed the entire exact draft')); assert.ok(ack); ack.checked = true;
  await h.click('Keep as a private alternative');
  assert.equal(byButton(h.root, 'Download formatted Word (.docx)').disabled, false);
  assert.equal(byButton(h.root, 'Download printable LaTeX source (.tex)').disabled, false);
  assert.doesNotMatch(h.status.textContent, /writing item changed|Cached draft text was cleared/);
  await h.click(wordButton); assert.equal(h.downloads.length, 1);
  assert.deepEqual(Buffer.from(await h.created[0].blob.arrayBuffer()), accepted.bytes);
});

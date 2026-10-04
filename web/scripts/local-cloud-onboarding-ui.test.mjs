import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { createCloudBundle } from '../apps/local-runtime/src/cloud-onboarding.mjs';
import { createCloudOnboardingRoutes } from '../apps/local-runtime/src/cloud-onboarding-routes.mjs';
import { mountCloudOnboardingUI } from '../apps/local/public/cloud-onboarding.js';

// Executes shipped DOM event handlers with the real local review/import service.
// This stand-in proves state transitions, not browser layout or file download.
class Node {
  constructor(tag, className = '', text = '') {
    this.tagName = tag; this.className = className; this.text = text; this.children = []; this.parent = null;
    this.listeners = new Map(); this.attributes = new Map(); this.hidden = false; this.disabled = false; this.checked = false; this.value = '';
    const classes = new Set(); this.classList = { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } };
  }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } if (this.tagName === 'select' && this.children.length === 1) this.value = this.children[0].value; }
  replaceChildren(...children) { for (const child of this.children) child.parent = null; this.children = []; this.text = ''; this.append(...children); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  addEventListener(type, callback) { this.listeners.set(type, [...(this.listeners.get(type) || []), callback]); }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.text = value; this.children = []; }
}
const walk = node => [node, ...node.children.flatMap(walk)];
const visibleText = node => node.hidden ? '' : node.text + node.children.map(visibleText).join('\n');
const fire = (node, type = 'click') => { for (const callback of node.listeners.get(type) || []) callback({ preventDefault() {} }); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function selectedBundle() {
  const text = '<script>literal synthetic text</script>\nCafé λ\nDo not automatically share this note.';
  return createCloudBundle({ format: 'learnbridge-selected-cloud-export', schema_version: 1, origin: 'https://learnbridge.example',
    owner: { student_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', verification: 'supabase_session_at_fetch' }, provider: 'googledocs', account_id: 'ca_synthetic_student', academic_policy: 'learning_support', retrieved_at: '2026-10-04T12:00:00.000Z',
    records: [{ id: 'synthetic_selected_doc', title: 'Synthetic selected note', url: 'https://docs.google.com/document/d/synthetic_selected_doc/edit', modified_at: null, text,
      sha256: createHash('sha256').update(text).digest('hex'), coverage: 'partial_text', limitations: ['Original visual layout not checked.'] }], limitations: ['Only this selected text is included.'] });
}
function harness(t, { intercept, confirm = async () => true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'learnbridge-cloud-ui-')), store = LocalStore.open({ root: join(directory, 'workspace') });
  const routes = createCloudOnboardingRoutes({ store, clock: () => '2026-10-04T12:01:00.000Z' }), root = new Node('main'), jobs = [], calls = [], confirmations = [], timers = new Map();
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout; let nextTimer = 0;
  globalThis.setTimeout = callback => { const id = ++nextTimer; timers.set(id, callback); return id; }; globalThis.clearTimeout = id => timers.delete(id);
  const request = async (path, options = {}) => {
    const call = { path, ...options }; calls.push(call); const alternative = intercept?.(call, store);
    if (alternative !== undefined) return await alternative;
    return (await routes.handle({ route: path, method: options.method || 'GET', session: { nonce: 'synthetic-paired-student' }, privateBody: async () => options.body })).data;
  };
  const ui = mountCloudOnboardingUI({ root, request, element: (tag, cls, text) => new Node(tag, cls, text), busy(control, callback) {
    control.disabled = true; const job = Promise.resolve().then(callback).finally(() => { control.disabled = false; }); jobs.push(job); return job;
  }, confirmAction: async (...args) => { confirmations.push(args); return confirm(...args); }, navigate: page => calls.push({ navigation: page }) });
  t.after(() => { ui.reset(); globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; store.close(); rmSync(directory, { recursive: true, force: true }); });
  const button = label => { const node = walk(root).find(node => node.tagName === 'button' && node.textContent === label); assert.ok(node, label); return node; };
  return { root, ui, store, routes, calls, confirmations, timers, button,
    get file() { return walk(root).find(node => node.tagName === 'input' && node.type === 'file'); },
    get policy() { return walk(root).find(node => node.tagName === 'select'); },
    get owner() { return walk(root).find(node => node.tagName === 'input' && node.type === 'checkbox'); },
    get status() { return walk(root).find(node => node.id === 'cloud-onboarding-status'); },
    get review() { return root.children[4]; },
    startClick(label) { fire(button(label)); return jobs.at(-1); },
    async click(label) { fire(button(label)); await jobs.at(-1).catch(() => {}); await settle(); },
    async choose(value = selectedBundle()) { const text = JSON.stringify(value); this.file.files = [{ size: Buffer.byteLength(text), text: async () => text }]; fire(this.file, 'change'); await settle(); },
    async prepare() { await this.choose(); await this.click('Preview exact selected cloud import'); },
  };
}

test('CUI01: actual UI reviews literal complete text and requires unchecked owner confirmation before exact private import', async t => {
  const h = harness(t); await h.ui.refresh(); await h.prepare();
  assert.equal(h.owner.checked, false); assert.equal(h.review.hidden, false); assert.match(visibleText(h.review), /bundle reported/); assert.match(visibleText(h.review), /Live freshness: not checked/); assert.match(visibleText(h.review), /AI sharing: not granted/);
  assert.equal(walk(h.review).find(node => node.tagName === 'pre').textContent, selectedBundle().records[0].text);
  await h.click('Save reviewed private source copies'); assert.equal(h.store.listDocuments().length, 0); assert.match(h.status.textContent, /confirm the exported account is yours/); assert.equal(h.confirmations.length, 0);
  h.owner.checked = true; await h.click('Save reviewed private source copies');
  assert.equal(h.store.listDocuments().length, 1); assert.ok(h.store.getDocument(h.store.listDocuments()[0].id).text.startsWith(selectedBundle().records[0].text));
  assert.equal(h.store.listAgentGrants().length, 0); assert.equal(h.store.listTasks().length, 0); assert.match(h.status.textContent, /private import read back: 1 note/); assert.match(h.confirmations[0][0], /does not authenticate the cloud account locally or grant AI sharing/);
  await h.click('Open private notes'); await h.click('Review AI sharing separately'); assert.deepEqual(h.calls.filter(call => call.navigation).map(call => call.navigation), ['notes', 'agents']);
});
test('CUI02: policy editing while a preview is pending discards the late text and prevents import', async t => {
  const started = deferred(), release = deferred(); let original;
  const h = harness(t, { intercept(call) { if (call.path === '/cloud-onboarding/preview') { original = call; started.resolve(); return release.promise; } } });
  await h.choose(); const pending = h.startClick('Preview exact selected cloud import'); await started.promise; h.policy.value = 'graded_restricted'; fire(h.policy, 'change');
  const result = await h.routes.handle({ route: original.path, method: 'POST', session: { nonce: 'synthetic-paired-student' }, privateBody: async () => original.body }); release.resolve(result.data); await pending;
  assert.equal(h.review.hidden, true); assert.equal(h.store.listDocuments().length, 0); assert.equal(walk(h.root).some(node => node.textContent === 'Save reviewed private source copies'), false);
});
test('CUI03: reset during file read and metadata read cannot repopulate the cleared view', async t => {
  const fileRead = deferred(), metadata = deferred(), started = deferred();
  const h = harness(t, { intercept(call) { if (call.path === '/cloud-onboarding/imports' && !call.method) { started.resolve(); return metadata.promise; } } });
  h.file.files = [{ size: 10, text: () => fileRead.promise }]; fire(h.file, 'change'); const pending = h.ui.refresh(); await started.promise; h.ui.reset();
  fileRead.resolve(JSON.stringify(selectedBundle())); metadata.resolve({ items: [] }); assert.equal(await pending, false); await settle();
  assert.equal(h.button('Preview exact selected cloud import').disabled, true); assert.equal(h.review.hidden, true); assert.equal(h.store.listDocuments().length, 0); assert.equal(h.status.textContent, '');
});
for (const change of ['edited_note', 'removed_receipt']) test(`CUI04-${change}: post-save refresh uses current metadata instead of a healthy earlier save response`, async t => {
  let changed = false;
  const h = harness(t, { intercept(call, store) { if (call.path === '/cloud-onboarding/imports' && !call.method && store.listDocuments().length && !changed) {
    changed = true; const note = store.listDocuments()[0]; if (change === 'edited_note') store.updateDocument(note.id, { text: 'Student edits preserved.' }, note.revision);
    else { const record = store.listWorkspaceRecords({ kind: 'artifact' }).find(record => record.data?.format === 'cloud_import'); store.updateWorkspaceRecord(record.id, { data: { ...record.data, state: 'forgotten' }, expected_revision: record.revision }); }
  } } });
  await h.prepare(); h.owner.checked = true; await h.click('Save reviewed private source copies'); assert.match(h.status.textContent, /receipt changed during refresh/); assert.doesNotMatch(h.status.textContent, /import read back/); assert.equal(h.store.listDocuments().length, 1);
  if (change === 'edited_note') assert.equal(h.store.getDocument(h.store.listDocuments()[0].id).text, 'Student edits preserved.');
});
test('CUI05: changing the selection while confirmation is open prevents the import request', async t => {
  const prompted = deferred(), answer = deferred(), h = harness(t, { confirm: () => { prompted.resolve(); return answer.promise; } });
  await h.prepare(); h.owner.checked = true; const pending = h.startClick('Save reviewed private source copies'); await prompted.promise;
  h.policy.value = 'graded_restricted'; fire(h.policy, 'change'); answer.resolve(true); await pending;
  assert.equal(h.calls.some(call => call.path === '/cloud-onboarding/imports' && call.method === 'POST'), false); assert.equal(h.store.listDocuments().length, 0);
});
test('CUI06: exact review expires visibly and the same loaded file requires a new unchecked review', async t => {
  const h = harness(t); await h.prepare(); assert.equal(h.timers.size, 1); h.owner.checked = true; [...h.timers.values()][0]();
  assert.equal(h.review.hidden, true); assert.match(h.status.textContent, /exact review expired/); assert.equal(h.store.listDocuments().length, 0);
  await h.click('Preview exact selected cloud import'); assert.equal(h.review.hidden, false); assert.equal(h.owner.checked, false); assert.equal(h.calls.filter(call => call.path === '/cloud-onboarding/preview').length, 2);
});
test('CUI07: oversized and malformed transfer files never send a preview or create notes', async t => {
  const h = harness(t); let fileRead = 0; h.file.files = [{ size: 110001, text: async () => { fileRead++; return '{}'; } }]; fire(h.file, 'change'); await settle();
  assert.equal(fileRead, 0); assert.equal(h.button('Preview exact selected cloud import').disabled, true); assert.match(h.status.textContent, /smaller than 110,000/);
  h.file.files = [{ size: 1, text: async () => '{' }]; fire(h.file, 'change'); await settle(); assert.match(h.status.textContent, /not valid JSON/);
  assert.equal(h.calls.length, 0); assert.equal(h.store.listDocuments().length, 0);
});
test('CUI08: source receipt removal confirms exact revision and preserves separate notes and sharing choices', async t => {
  const h = harness(t); await h.prepare(); h.owner.checked = true; await h.click('Save reviewed private source copies'); await h.click('Remove active source receipt');
  const remove = h.calls.find(call => call.method === 'DELETE'); assert.ok(remove.body.expected_revision >= 1); assert.equal(h.store.listDocuments().length, 1); assert.equal(h.store.listAgentGrants().length, 0);
  assert.match(h.confirmations.at(-1)[0], /notes, existing note-sharing choices, downloaded files, history and backups retain/); assert.match(h.status.textContent, /receipt removed/);
});

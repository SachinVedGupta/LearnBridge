import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountOnboardingUI } from '../apps/local/public/onboarding.js';

// A small DOM stand-in exercises the shipped event handlers and async ordering.
// It does not claim browser layout, accessibility or real HTTP verification.
class Node {
  constructor(tag, className = '', text = '') {
    this.tagName = tag; this.className = className; this.text = text; this.children = []; this.parent = null;
    this.listeners = new Map(); this.attributes = new Map(); this.dataset = {}; this.hidden = false; this.disabled = false;
    this.checked = false; this.value = ''; const classes = new Set();
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
  set textContent(value) { this.text = value; this.children = []; }
  get options() { return this.children; }
  get selectedIndex() { return this.children.findIndex(option => option.value === this.value); }
}
const walk = node => [node, ...node.children.flatMap(walk)];
const visibleText = node => node.hidden ? '' : node.text + node.children.map(visibleText).join('\n');
const byButton = (root, text) => { const found = walk(root).find(node => node.tagName === 'button' && node.textContent === text); assert.ok(found, text); return found; };
const fire = (node, type = 'click') => { for (const callback of node.listeners.get(type) || []) callback({ preventDefault() {} }); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const catalogue = () => ({ schema_version: 1, profile: [], source_entries: [], snapshots: [], documents: [], grants: [],
  catalogue_coverage: { state: 'complete', reasons: [] }, limitations: [] });
function preview(selection) {
  return { format: 'learnbridge-onboarding-preview', schema_version: 1, selection, observed_at: '2026-10-03T12:00:00.000Z',
    pins: [], coverage: ['profile', 'local_files', 'academic_exports', 'agent_bridge'].map(category => ({ category, state: 'not_requested', checked_count: 0, items: [], limitations: [], next_step: null })),
    overall: 'awaiting_student', review_hash: 'a'.repeat(64) };
}
function report(value, overrides = {}) {
  return { id: '85c54917-6b35-42fa-a0e8-680bac78e177', revision: 1, title: 'Reviewed local setup coverage', kind: 'artifact',
    data: { ...value, format: 'onboarding_report', review: { reviewed_at: '2026-10-03T12:00:00.000Z' } }, needs_refresh: false, refresh_reasons: [], ...overrides };
}
function harness(t, handle) {
  const root = new Node('main'), jobs = [], calls = []; let saved;
  const request = async (path, options = {}) => {
    calls.push({ path, ...options }); const intercepted = handle?.(path, options, saved);
    if (intercepted !== undefined) return await intercepted;
    if (path === '/onboarding/catalog') return catalogue();
    if (path === '/onboarding/reports' && !options.method) return { items: saved ? [saved] : [] };
    if (path === '/onboarding/preview') return { preview_id: '1446d432-29c3-4ee5-8319-120f72cc5a73', preview: preview(options.body) };
    if (path === '/onboarding/reports' && options.method === 'POST') { saved = report(preview(lastSelection())); return { item: saved }; }
    throw new Error(`Unexpected harness request: ${path}`);
  };
  const lastSelection = () => calls.findLast(call => call.path === '/onboarding/preview').body;
  const ui = mountOnboardingUI({ root, request, element: (tag, cls, text) => new Node(tag, cls, text),
    busy(button, action) {
      button.disabled = true; const job = Promise.resolve().then(action).finally(() => { button.disabled = false; }); jobs.push(job); return job;
    }, confirmAction: async () => true });
  t.after(() => ui.reset());
  return { root, ui, calls, async click(text) { fire(byButton(root, text)); await jobs.at(-1); },
    startClick(text) { fire(byButton(root, text)); return jobs.at(-1); },
    get status() { return walk(root).find(node => node.id === 'onboarding-status'); },
    get savedPanel() { return root.children.at(-1); },
  };
}

test('ONUI01: saving displays freshly recomputed drift instead of the earlier healthy POST response', async t => {
  const h = harness(t, (path, options, saved) => path === '/onboarding/reports' && !options.method && saved
    ? { items: [{ ...saved, needs_refresh: true, refresh_reasons: ['selected_record_or_permission_changed'] }] } : undefined);
  await h.ui.refresh(); await h.click('Preview my setup coverage'); await h.click('Save this reviewed setup report');
  assert.equal(h.savedPanel.hidden, false); assert.match(visibleText(h.savedPanel), /Needs a fresh check/);
  assert.match(visibleText(h.savedPanel), /sharing permission changed, expired or was revoked/);
  assert.equal(h.calls.filter(call => call.path === '/onboarding/reports' && call.method === 'POST').length, 1);
});

test('ONUI02: a report removed after commit is not reopened from the stale save response', async t => {
  const h = harness(t, (path, options, saved) => path === '/onboarding/reports' && !options.method && saved ? { items: [] } : undefined);
  await h.ui.refresh(); await h.click('Preview my setup coverage'); await h.click('Save this reviewed setup report');
  assert.equal(h.savedPanel.hidden, true); assert.match(h.status.textContent, /no longer active/);
  assert.doesNotMatch(visibleText(h.root), /Reviewed local setup coverage/);
});

test('ONUI03: a superseded save refresh cannot publish an older healthy report or replace the newer view', async t => {
  const firstRefreshStarted = deferred(), releaseOldRefresh = deferred(); let pendingRefreshes = 0;
  const h = harness(t, (path, options, saved) => {
    if (saved && path === `/onboarding/reports/${saved.id}`) return { item: { ...saved, needs_refresh: true, refresh_reasons: ['selected_record_or_permission_changed'] } };
    if (path === '/onboarding/reports' && !options.method && saved) {
      if (++pendingRefreshes === 1) { firstRefreshStarted.resolve(); return releaseOldRefresh.promise; }
      return { items: [{ ...saved, needs_refresh: true, refresh_reasons: ['selected_record_or_permission_changed'] }] };
    }
    return undefined;
  });
  await h.ui.refresh(); await h.click('Preview my setup coverage');
  const saving = h.startClick('Save this reviewed setup report'); await firstRefreshStarted.promise;
  assert.equal(await h.ui.refresh(), true);
  await h.click('Review saved report'); assert.match(visibleText(h.savedPanel), /Needs a fresh check/);
  releaseOldRefresh.resolve({ items: [] }); await saving;
  assert.equal(h.savedPanel.hidden, false); assert.match(visibleText(h.savedPanel), /Needs a fresh check/);
  assert.equal(walk(h.root).filter(node => node.tagName === 'button' && node.textContent === 'Review saved report').length, 1);
  assert.match(visibleText(h.root), /Needs a fresh check: selected records or sharing changed/);
  assert.doesNotMatch(h.status.textContent, /Reviewed setup report saved locally/);
});

test('ONUI04: selection changes while preview is pending discard the late response', async t => {
  const started = deferred(), release = deferred(); let pendingSelection;
  const h = harness(t, (path, options) => {
    if (path === '/onboarding/preview') { pendingSelection = options.body; started.resolve(); return release.promise; } return undefined;
  });
  await h.ui.refresh(); const awaiting = h.startClick('Preview my setup coverage'); await started.promise;
  const purpose = walk(h.root).find(node => node.tagName === 'select'); purpose.value = 'learning'; fire(purpose, 'change');
  release.resolve({ preview_id: '1446d432-29c3-4ee5-8319-120f72cc5a73', preview: preview(pendingSelection) }); await awaiting;
  const review = h.root.children.find(node => node.tagName === 'section' && node.children[0]?.textContent === '3. Review this coverage check');
  assert.equal(review.hidden, true); assert.equal(h.calls.some(call => call.path === '/onboarding/reports' && call.method === 'POST'), false);
});

test('ONUI05: reset during a pending read prevents late metadata from repopulating the cleared workspace', async t => {
  const started = deferred(), release = deferred();
  const h = harness(t, path => path === '/onboarding/catalog' ? (started.resolve(), release.promise) : undefined);
  const pending = h.ui.refresh(); await started.promise; h.ui.reset(); release.resolve(catalogue()); assert.equal(await pending, false);
  assert.equal(byButton(h.root, 'Preview my setup coverage').disabled, true); assert.equal(h.savedPanel.hidden, true);
  assert.match(visibleText(h.root), /No records selected/);
});

function lazyLoader() {
  // Execute the real loadExtension function with only its browser module-loader
  // boundary replaced by a deterministic promise. All mount/race logic is kept.
  const app = readFileSync(new URL('../apps/local/public/app.js', import.meta.url), 'utf8');
  const start = app.indexOf('async function loadExtension(page) {'), end = app.indexOf('\nclass ApiError', start);
  assert.ok(start >= 0 && end > start); const body = app.slice(start, end);
  assert.equal((body.match(/await import\(/g) || []).length, 1);
  return new Function('state', 'extensionUIs', 'loadModule', '$', 'request', 'element', 'busy', 'confirmAction', 'message', 'navigate',
    `${body.replace('await import(', 'await loadModule(')}\nreturn loadExtension;`);
}
test('ONUI06: racing lazy imports mount one resettable extension instance', async () => {
  const release = deferred(), extensions = new Map(), state = { nonce: 'paired-nonce', sessionReady: true }; let mounts = 0, refreshes = 0, resets = 0;
  const load = lazyLoader()(state, extensions, () => release.promise, () => ({}), () => {}, () => {}, () => {}, () => {}, () => {}, () => {});
  const first = load('onboarding'), second = load('onboarding');
  release.resolve({ mountOnboardingUI() { mounts++; return { refresh: async () => { refreshes++; }, reset() { resets++; } }; } });
  await Promise.all([first, second]); assert.equal(mounts, 1); assert.equal(extensions.size, 1); assert.equal(refreshes, 2);
  for (const extension of extensions.values()) extension.reset(); assert.equal(resets, 1);
});
test('ONUI07: a lazy import finishing after session reset never mounts private UI', async () => {
  const release = deferred(), extensions = new Map(), state = { nonce: 'old-nonce', sessionReady: true }; let mounts = 0;
  const load = lazyLoader()(state, extensions, () => release.promise, () => ({}), () => {}, () => {}, () => {}, () => {}, () => {}, () => {});
  const pending = load('onboarding'); state.sessionReady = false; state.nonce = null;
  release.resolve({ mountOnboardingUI() { mounts++; return { refresh: async () => {} }; } }); await pending;
  assert.equal(mounts, 0); assert.equal(extensions.size, 0);
});

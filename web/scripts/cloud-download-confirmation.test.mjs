import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createCloudBundle } from '../apps/local-runtime/src/cloud-onboarding.mjs';

// Exercise the shipped TSX event handlers with persistent React refs, effect
// cleanup, browser API boundaries and controllable async work. This proves file
// preparation and consent sequencing, not that a browser saved a file to disk.
const STUDENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT = 'ca_synthetic_student';
const DOC = 'synthetic_doc_1';
const LINK = `https://docs.google.com/document/d/${DOC}/edit`;
const NOW = Date.parse('2026-10-04T15:00:00.000Z');
const ARM = 'Download reviewed selected-source bundle';
const CONFIRM = 'Confirm private download';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
const walk = value => !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(walk) : [value, ...walk(value.props?.children)];
const text = value => value === null || value === undefined || value === false ? '' : Array.isArray(value) ? value.map(text).join('') : typeof value === 'object' ? text(value.props?.children) : String(value);
function bundle(body = 'Literal reviewed synthetic cloud note. Café λ') {
  return createCloudBundle({ format: 'learnbridge-selected-cloud-export', schema_version: 1, origin: 'https://learnbridge.example', owner: { student_id: STUDENT, verification: 'supabase_session_at_fetch' },
    provider: 'googledocs', account_id: ACCOUNT, academic_policy: 'learning_support', retrieved_at: new Date(NOW).toISOString(),
    records: [{ id: DOC, title: 'Synthetic selected note', url: LINK, modified_at: null, text: body, sha256: createHash('sha256').update(body).digest('hex'), coverage: 'partial_text', limitations: ['Partial synthetic text only.'] }],
    limitations: ['No model access or source write.'] });
}
const makePreview = (selected, token = 'synthetic_opaque_review_token') => ({ bundle: selected, review_hash: selected.bundle_hash, preview_token: token, expires_at: new Date(NOW + 300000).toISOString() });

async function harness(t, mode = 'normal') {
  const selected = bundle(), preview = makePreview(selected), replacement = makePreview(bundle('A separately fetched synthetic preview.'), 'synthetic_replacement_token');
  const accounts = [{ id: ACCOUNT, provider: 'googledocs', label: 'Selected synthetic Google Docs account' }, { id: 'ca_synthetic_other', provider: 'googledocs', label: 'Other synthetic owned account' }];
  const row = { id: DOC, title: 'Synthetic selected note', url: LINK, modified_at: null, selection_token: 'synthetic_selection_token' };
  // Existing component hook positions are preserved; the last state is the new
  // confirmation panel. Startup account hydration is fulfilled synthetically.
  const values = [accounts, `googledocs:${ACCOUNT}`, 'my notes', 'learning_support', [row], new Set([DOC]), preview, true, '', '', '', true, LINK, null];
  const refs = [], effects = [], pendingEffects = [], calls = [], blobs = [], downloads = [], revoked = [], timers = new Map();
  const exportStarted = deferred(), releaseExport = deferred(), hashStarted = deferred(), releaseHash = deferred();
  let stateIndex = 0, refIndex = 0, effectIndex = 0, timerId = 0, now = NOW, hashes = 0, nativeConfirms = 0, mounted = true, disposed = false, writesAfterUnmount = 0, tree;
  const react = {
    useState(initial) {
      const own = stateIndex++;
      if (!(own in values)) values[own] = typeof initial === 'function' ? initial() : initial;
      return [values[own], value => { if (!mounted) writesAfterUnmount++; values[own] = typeof value === 'function' ? value(values[own]) : value; }];
    },
    useRef(initial) { const own = refIndex++; if (!(own in refs)) refs[own] = { current: initial }; return refs[own]; },
    useEffect(callback, dependencies) {
      const own = effectIndex++, previous = effects[own];
      if (!previous || !dependencies || dependencies.length !== previous.dependencies?.length || dependencies.some((value, index) => !Object.is(value, previous.dependencies[index]))) {
        pendingEffects.push({ own, callback, dependencies });
      }
    },
  };
  const source = readFileSync(new URL('../apps/web/src/app/onboarding/cloud/cloud-onboarding-client.tsx', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} }, jsx = (type, props) => ({ type, props });
  new Function('require', 'module', 'exports', code)(name => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    throw Error(`Unexpected confirmation component dependency: ${name}`);
  }, module, module.exports);
  const original = Object.fromEntries(['window', 'document', 'fetch', 'crypto', 'setTimeout', 'clearTimeout'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL, originalNow = Date.now;
  const define = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, value });
  define('window', { confirm() { nativeConfirms++; throw Error('Native confirmation must never be used.'); } });
  define('document', { createElement(tag) { assert.equal(tag, 'a'); const anchor = { click() { downloads.push({ href: anchor.href, filename: anchor.download }); } }; return anchor; } });
  define('fetch', async (path, options) => {
    assert.ok(path.startsWith('/api/cloud-onboarding/'), 'The component may call only its synthetic same-origin source API.');
    const action = path.slice('/api/cloud-onboarding/'.length); calls.push({ action, path, ...options });
    let result;
    if (action === 'accounts') result = { items: accounts, coverage: 'account_metadata_only' };
    else if (action === 'export') {
      exportStarted.resolve(); if (mode === 'network') await releaseExport.promise;
      const input = JSON.parse(options.body), source = input.preview_token === replacement.preview_token ? replacement.bundle : selected;
      result = { bundle: structuredClone(source), sharing: 'not_granted', filename: 'LearnBridge-selected-googledocs.json' };
    } else if (action === 'preview' || action === 'preview_link') result = replacement;
    else if (action === 'search') result = { items: [row], coverage: 'partial' };
    else assert.fail(`No synthetic API action is allowed for this test: ${action}`);
    return { ok: true, json: async () => result };
  });
  define('crypto', { subtle: { async digest(algorithm, input) {
    assert.equal(algorithm, 'SHA-256'); const bytes = createHash('sha256').update(input).digest();
    if (++hashes === 1 && mode === 'hash') { hashStarted.resolve(); await releaseHash.promise; }
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  } } });
  define('setTimeout', (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; });
  define('clearTimeout', id => { timers.delete(id); });
  URL.createObjectURL = blob => { assert.ok(blob instanceof Blob); blobs.push(blob); return `blob:synthetic-reviewed-download-${blobs.length}`; };
  URL.revokeObjectURL = url => revoked.push(url);
  Date.now = () => now;

  function render() {
    assert.equal(mounted, true, 'An unmounted component may not be rendered again.');
    stateIndex = 0; refIndex = 0; effectIndex = 0; tree = module.exports.default();
    for (const effect of pendingEffects.splice(0)) {
      effects[effect.own]?.cleanup?.();
      effects[effect.own] = { dependencies: effect.dependencies, cleanup: effect.callback() };
    }
    return tree;
  }
  function unmount() {
    if (!mounted) return;
    mounted = false;
    for (const effect of effects.toReversed()) effect?.cleanup?.();
  }
  function dispose() {
    if (disposed) return;
    unmount(); releaseExport.resolve(); releaseHash.resolve(); disposed = true;
    URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; Date.now = originalNow;
    for (const [name, descriptor] of Object.entries(original)) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  }
  t.after(dispose);
  function button(label) { const found = walk(tree).find(node => node.type === 'button' && text(node) === label); assert.ok(found, `Expected visible button: ${label}`); return found; }
  function field(label, tag = 'input') { const parent = walk(tree).find(node => node.type === 'label' && text(node).startsWith(label)); const found = parent && walk(parent).find(node => node.type === tag); assert.ok(found, `Expected field: ${label}`); return found; }
  const review = () => field(' I reviewed all selected text');
  function setReview(checked) { review().props.onChange({ target: { checked } }); }
  function dialog() { return walk(tree).find(node => node.props?.role === 'dialog'); }
  function arm() { const control = button(ARM); assert.equal(Boolean(control.props.disabled), false); control.props.onClick(); render(); assert.ok(dialog(), 'The first click must arm the in-app review panel.'); return button(CONFIRM).props.onClick; }
  async function flush() { await settle(); if (mounted) render(); await settle(); if (mounted) render(); }
  render(); await flush(); calls.length = 0;
  return {
    selected, preview, replacement, values, refs, calls, blobs, downloads, revoked, timers, exportStarted, releaseExport, hashStarted, releaseHash,
    render, flush, dispose, unmount, button, field, review, setReview, arm, dialog,
    exports: () => calls.filter(call => call.action === 'export'),
    get hashes() { return hashes; }, get nativeConfirms() { return nativeConfirms; }, get writesAfterUnmount() { return writesAfterUnmount; },
    advance(ms) { now += ms; },
    fireExpiry() { const found = [...timers].find(([, timer]) => timer.delay >= 300000); assert.ok(found, 'The actual preview expiry effect must register a timer.'); timers.delete(found[0]); found[1].callback(); },
  };
}

function noDownload(h) { assert.equal(h.blobs.length, 0); assert.equal(h.downloads.length, 0); assert.equal(h.nativeConfirms, 0); }

test('CDCONF01: first click only arms a labelled nonmodal panel with exact private-download details and no export or byte verification', async t => {
  const h = await harness(t); h.arm();
  assert.equal(h.calls.length, 0); assert.equal(h.hashes, 0); noDownload(h);
  const panel = h.dialog(), nodes = walk(panel), details = text(panel);
  assert.equal(panel.props['aria-modal'], false);
  const title = nodes.find(node => node.props?.id === panel.props['aria-labelledby']);
  const description = nodes.find(node => node.props?.id === panel.props['aria-describedby']);
  assert.ok(title); assert.ok(description); assert.match(text(title), /confirm.*private download/i);
  for (const value of ['1 reviewed item', 'googledocs', ACCOUNT, STUDENT, 'learning_support', 'LearnBridge-selected-googledocs.json']) assert.ok(details.includes(value), `The panel must identify ${value}.`);
  assert.match(details, /browser.*download location.*device/i); assert.match(details, /does not import notes or grant model access/i);
  assert.ok(h.button('Cancel')); assert.ok(h.button(CONFIRM));
});

test('CDCONF02: Cancel or Escape disarms consent, preserves the reviewed preview and rejects an old Confirm even after a fresh panel is armed', async t => {
  const h = await harness(t), stale = h.arm();
  h.button('Cancel').props.onClick(); h.render(); stale(); await h.flush();
  assert.equal(h.dialog(), undefined); assert.equal(h.values[6], h.preview); assert.equal(h.values[7], true); assert.equal(h.exports().length, 0);
  const fresh = h.arm(); stale(); await h.flush();
  assert.ok(h.dialog(), 'A stale confirmation must not consume the new panel.'); assert.equal(h.exports().length, 0);
  let prevented = false; h.dialog().props.onKeyDown({ key: 'Escape', preventDefault() { prevented = true; } }); h.render(); fresh(); await h.flush();
  assert.equal(prevented, true); assert.equal(h.dialog(), undefined); assert.equal(h.exports().length, 0); assert.equal(h.hashes, 0); noDownload(h);
});

test('CDCONF03: withdrawing and restoring the full-text review cannot revive a retained Confirm closure', async t => {
  const h = await harness(t), stale = h.arm(); h.setReview(false);
  stale(); h.render(); assert.equal(h.dialog(), undefined); assert.equal(h.values[7], false);
  h.setReview(true); h.render(); stale(); await h.flush();
  assert.equal(h.exports().length, 0); assert.equal(h.hashes, 0); noDownload(h);
});

test('CDCONF04: account, query, policy, exact link and selected-item changes invalidate confirmation before any stale handler can export', async t => {
  const changes = [
    h => h.field('Connected account', 'select').props.onChange({ target: { value: 'googledocs:ca_synthetic_other' } }),
    h => h.field('Search phrase').props.onChange({ target: { value: 'changed query' } }),
    h => h.field('Academic policy', 'select').props.onChange({ target: { value: 'graded_restricted' } }),
    h => h.field('Exact Google Docs link').props.onChange({ target: { value: 'https://docs.google.com/document/d/synthetic_doc_2/edit' } }),
    h => h.field(' Synthetic selected note').props.onChange({ target: { checked: false } }),
  ];
  for (const change of changes) {
    const h = await harness(t); try { const stale = h.arm(); change(h); stale(); await h.flush(); assert.equal(h.dialog(), undefined); assert.equal(h.values[6], null); assert.equal(h.exports().length, 0); assert.equal(h.hashes, 0); noDownload(h); } finally { h.dispose(); }
  }
});

test('CDCONF05: searching again or fetching a new selected/link preview cancels old consent and requires a separate review of the new result', async t => {
  for (const label of ['Search item metadata', 'Read only checked items and prepare review', 'Read this exact Docs link']) {
    const h = await harness(t); try {
      const stale = h.arm(); h.button(label).props.onClick(); stale(); await h.flush();
      assert.equal(h.dialog(), undefined); assert.equal(h.values[7], false); assert.equal(h.exports().length, 0); noDownload(h);
      if (label !== 'Search item metadata') {
        assert.equal(h.values[6], h.replacement); h.setReview(true); h.render(); h.arm(); stale(); await h.flush();
        assert.ok(h.dialog()); assert.equal(h.exports().length, 0); assert.equal(h.refs[0].current.preview, h.replacement);
      } else assert.equal(h.values[6], null);
    } finally { h.dispose(); }
  }
});

test('CDCONF06: expiry is checked at Confirm time even when the scheduled expiry callback has not fired', async t => {
  const h = await harness(t), confirm = h.arm(); h.advance(300000); confirm(); await h.flush();
  assert.equal(h.exports().length, 0); assert.equal(h.dialog(), undefined); assert.match(h.values[10], /changed or expired/i); assert.equal(h.hashes, 0); noDownload(h);
});

test('CDCONF07: the actual preview expiry effect removes pending confirmation, invalidates the preview and rejects retained event handlers', async t => {
  const h = await harness(t), confirm = h.arm(); h.advance(300001); h.fireExpiry(); confirm(); await h.flush();
  assert.equal(h.dialog(), undefined); assert.equal(h.values[6], null); assert.equal(h.values[7], false); assert.match(h.values[9], /preview expired/i);
  assert.equal(h.exports().length, 0); assert.equal(h.hashes, 0); noDownload(h);
});

test('CDCONF08: actual unmount cleanup retires armed consent and aborts a pending export without later downloads or state writes', async t => {
  for (const mode of ['normal', 'network']) {
    const h = await harness(t, mode); try {
      const confirm = h.arm(); if (mode === 'network') { confirm(); await h.exportStarted.promise; }
      h.unmount(); confirm();
      if (mode === 'network') { assert.equal(h.exports()[0].signal.aborted, true); h.releaseExport.resolve(); }
      await settle();
      assert.equal(h.exports().length, mode === 'network' ? 1 : 0); assert.equal(h.refs[0].current.confirmation, null); assert.equal(h.refs[0].current.preview, null);
      assert.equal(h.writesAfterUnmount, 0); assert.equal(h.timers.size, 0); noDownload(h);
    } finally { h.dispose(); }
  }
});

test('CDCONF09: synchronous repeated Confirm clicks produce one export and one exact verified compact JSON download', async t => {
  const h = await harness(t, 'network'), confirm = h.arm();
  confirm(); confirm(); confirm(); await h.exportStarted.promise; h.render();
  assert.equal(h.dialog(), undefined); assert.equal(h.exports().length, 1); assert.equal(h.hashes, 0); noDownload(h);
  assert.deepEqual(JSON.parse(h.exports()[0].body), { preview_token: h.preview.preview_token, review_hash: h.preview.review_hash, confirm: true });
  h.releaseExport.resolve(); await h.flush(); confirm(); await h.flush();
  assert.equal(h.exports().length, 1); assert.equal(h.blobs.length, 1); assert.equal(h.downloads.length, 1); assert.equal(h.nativeConfirms, 0);
  assert.equal(await h.blobs[0].text(), JSON.stringify(h.selected)); assert.equal(h.blobs[0].type, 'application/json');
  assert.deepEqual(h.downloads[0], { href: 'blob:synthetic-reviewed-download-1', filename: 'LearnBridge-selected-googledocs.json' });
  assert.match(h.values[9], /download prepared/i); assert.doesNotMatch(h.values[9], /download saved|imported successfully/i);
});

test('CDCONF10: unchecking the visible review checkbox during export aborts the request and denies late response bytes', async t => {
  const h = await harness(t, 'network'); h.arm()(); await h.exportStarted.promise; h.render(); h.setReview(false);
  assert.equal(h.exports()[0].signal.aborted, true); h.releaseExport.resolve(); await h.flush();
  assert.equal(h.values[7], false); assert.equal(h.exports().length, 1); assert.equal(h.hashes, 0); noDownload(h);
});

test('CDCONF11: review withdrawal or account changes during asynchronous hash verification prevents a later Blob or download', async t => {
  for (const change of [h => h.setReview(false), h => h.field('Connected account', 'select').props.onChange({ target: { value: 'googledocs:ca_synthetic_other' } })]) {
    const h = await harness(t, 'hash'); try {
      h.arm()(); await h.hashStarted.promise; h.render(); change(h); h.releaseHash.resolve(); await h.flush();
      assert.equal(h.exports().length, 1); noDownload(h);
    } finally { h.dispose(); }
  }
});

test('CDCONF12: a preview expiring during network response or byte verification cannot prepare download bytes even without a fired timer', async t => {
  for (const mode of ['network', 'hash']) {
    const h = await harness(t, mode); try {
      h.arm()(); await (mode === 'network' ? h.exportStarted.promise : h.hashStarted.promise); h.advance(300000);
      if (mode === 'network') h.releaseExport.resolve(); else h.releaseHash.resolve();
      await h.flush(); assert.equal(h.exports().length, 1); noDownload(h);
    } finally { h.dispose(); }
  }
});

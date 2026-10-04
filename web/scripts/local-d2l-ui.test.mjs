import test from 'node:test';
import assert from 'node:assert/strict';
import { mountD2lUI } from '../apps/local/public/d2l.js';

// Dependency-free stand-in executes shipped handlers and async ordering. It
// proves neither real DOM rendering nor live institution compatibility.
class Node {
  constructor(tag, cls = '', text = '') { this.tagName = tag; this.className = cls; this.text = text; this.children = []; this.listeners = new Map(); this.hidden = false; this.checked = false; this.disabled = false; this.value = ''; this.classList = { toggle() {} }; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.text = ''; }
  setAttribute() {}
  addEventListener(type, callback) { this.listeners.set(type, [...(this.listeners.get(type) || []), callback]); }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.children = []; }
}
const walk = node => [node, ...node.children.flatMap(walk)];
const fire = (node, type = 'click') => { for (const callback of node.listeners.get(type) || []) callback({ preventDefault() {} }); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const connection = { id: 'd759a1e8-3d9d-4b18-a356-c0958ca0b378', state: 'ready', account: { display_name: 'Synthetic Student' }, proof: 'fixture' };
const status = current => ({ capability: { state: 'available' }, connection: current });
const reviewed = () => ({ preview_id: '9889c0e3-d54e-4a7e-a8e4-bf83dadcb391', proof: 'fixture', snapshot: {
  courses: [{ title: 'Synthetic course' }], assignments: [], announcements: [], materials: [{ body: '<script>SOURCE_LITERAL_CANARY</script>' }],
  coverage: Object.fromEntries(['courses','assignments','announcements','materials'].map(name => [name, { state: name === 'materials' ? 'partial' : 'unknown' }])) },
  refresh: { review_hash: 'a'.repeat(64), facts: '<script>SOURCE_LITERAL_CANARY</script>' }, limitations: ['Linked files have not been opened.'] });
function harness(t, handle, confirm = async () => true, initial = connection) {
  const root = new Node('main'), calls = [], jobs = []; let current = initial;
  const ui = mountD2lUI({ root, element: (tag, cls, text) => new Node(tag, cls, text),
    request: async (path, options = {}) => { calls.push({ path, ...options }); const value = handle?.(path, options); if (value !== undefined) return await value;
      if (path === '/d2l/status') return status(current);
      if (path === '/d2l/start') { current = { ...connection, state: 'awaiting_sign_in', account: null }; return status(current); }
      if (path === '/d2l/verify') { current = connection; return status(current); }
      if (path === '/d2l/preview') return reviewed();
      if (path === '/d2l/import') return { status: 'imported' };
      if (path === '/d2l/disconnect') { current = null; return { retention: 'Temporary profile removed; reviewed course history retained.' }; }
      throw new Error('Unexpected D2L harness request'); },
    busy(button, action) { button.disabled = true; const job = Promise.resolve().then(action).finally(() => { button.disabled = false; }); jobs.push(job); return job; },
    confirmAction: confirm });
  t.after(() => ui.reset());
  const button = text => { const value = walk(root).find(node => node.tagName === 'button' && node.textContent === text); assert.ok(value, text); return value; };
  const input = id => { const value = walk(root).find(node => node.id === id); assert.ok(value, id); return value; };
  return { root, ui, calls, button, input, get notice() { return input('d2l-status').textContent; },
    choose() { input('d2l-course-ids').value = '781264'; fire(input('d2l-course-ids'), 'input'); input('d2l-materials').checked = true; fire(input('d2l-materials'), 'change'); },
    startClick(text) { fire(button(text)); return jobs.at(-1); }, async click(text) { fire(button(text)); await jobs.at(-1)?.catch(() => {}); await Promise.resolve(); },
  };
}

test('D2LUI01: opening setup reads status only, categories remain unchecked, and busy cleanup cannot reenable duplicate browser launch', async t => {
  const h = harness(t, undefined, undefined, null); await h.ui.refresh(); assert.deepEqual(h.calls.map(call => call.path), ['/d2l/status']);
  for (const id of ['d2l-assignments','d2l-announcements','d2l-materials']) assert.equal(h.input(id).checked, false);
  assert.equal(h.button('Read only my selected courses').disabled, true); await h.click('Open official Avenue sign-in');
  assert.deepEqual(h.calls.at(-1), { path: '/d2l/start', method: 'POST', body: { institution_id: 'mcmaster-avenue' } }); assert.equal(h.button('Open official Avenue sign-in').disabled, true);
  await h.click('Check my school sign-in'); assert.deepEqual(h.calls.at(-1).body, { connection_id: connection.id }); assert.equal(h.button('Read only my selected courses').disabled, false);
});

test('D2LUI02: invalid scope and unchecked exact-review box never issue preview or import; source HTML is literal text', async t => {
  const h = harness(t); await h.ui.refresh(); await h.click('Read only my selected courses'); assert.equal(h.calls.some(call => call.path === '/d2l/preview'), false);
  h.choose(); await h.click('Read only my selected courses'); assert.deepEqual(h.calls.at(-1).body, { connection_id: connection.id, selected_course_ids: ['781264'], categories: ['materials'] });
  assert.ok(walk(h.root).find(node => node.tagName === 'pre').textContent.includes('<script>SOURCE_LITERAL_CANARY</script>')); assert.match(h.notice, /Synthetic test transport only/);
  assert.equal(walk(h.root).some(node => node.tagName === 'script'), false); assert.equal(h.input('d2l-reviewed').checked, false);
  await h.click('Save reviewed course changes'); assert.equal(h.calls.some(call => call.path === '/d2l/import'), false); assert.match(h.notice, /check the review box/);
});

test('D2LUI03: explicit exact review and confirmation send only retained preview ID/hash, then disconnect clears school access while history stays', async t => {
  const confirmations = []; const h = harness(t, undefined, async (...args) => { confirmations.push(args); return true; }); await h.ui.refresh(); h.choose(); await h.click('Read only my selected courses');
  h.input('d2l-reviewed').checked = true; await h.click('Save reviewed course changes'); assert.equal(confirmations.length, 1);
  assert.deepEqual(h.calls.find(call => call.path === '/d2l/import'), { path: '/d2l/import', method: 'POST', body: { preview_id: reviewed().preview_id, review_hash: reviewed().refresh.review_hash } }); assert.match(h.notice, /saved locally/);
  await h.click('Disconnect school browser'); assert.equal(h.button('Read only my selected courses').disabled, true); assert.equal(h.button('Check my school sign-in').disabled, true); assert.equal(h.button('Open official Avenue sign-in').disabled, false); assert.match(h.notice, /history retained/);
});

test('D2LUI04: changing selected scope while preview is pending discards late facts and the save control', async t => {
  const entered = deferred(), release = deferred(); const h = harness(t, path => path === '/d2l/preview' ? (entered.resolve(), release.promise) : undefined);
  await h.ui.refresh(); h.choose(); const pending = h.startClick('Read only my selected courses'); await entered.promise; h.input('d2l-course-ids').value = '123456'; fire(h.input('d2l-course-ids'), 'input');
  release.resolve(reviewed()); await pending; assert.equal(walk(h.root).some(node => node.id === 'd2l-reviewed'), false); assert.equal(h.calls.some(call => call.path === '/d2l/import'), false);
});

test('D2LUI05: selection change while confirmation is pending cancels the exact-preview import', async t => {
  const entered = deferred(), release = deferred(); const h = harness(t, undefined, () => { entered.resolve(); return release.promise; }); await h.ui.refresh(); h.choose(); await h.click('Read only my selected courses');
  h.input('d2l-reviewed').checked = true; const pending = h.startClick('Save reviewed course changes'); await entered.promise; h.input('d2l-materials').checked = false; fire(h.input('d2l-materials'), 'change');
  release.resolve(true); await pending; assert.equal(h.calls.some(call => call.path === '/d2l/import'), false);
});

test('D2LUI06: reset during browser start prevents late identity/status and busy cleanup from reviving controls', async t => {
  const entered = deferred(), release = deferred(); const h = harness(t, path => path === '/d2l/start' ? (entered.resolve(), release.promise) : undefined, undefined, null); await h.ui.refresh();
  const pending = h.startClick('Open official Avenue sign-in'); await entered.promise; h.ui.reset(); release.resolve(status(connection)); await pending; await Promise.resolve();
  for (const text of ['Open official Avenue sign-in','Check my school sign-in','Disconnect school browser','Read only my selected courses']) assert.equal(h.button(text).disabled, true);
  assert.equal(h.notice, ''); assert.equal(h.root.textContent.includes('School account: Synthetic Student'), false);
});

test('D2LUI07: reset during save cannot show a late success or recreate the reviewed source body', async t => {
  const entered = deferred(), release = deferred(); const h = harness(t, path => path === '/d2l/import' ? (entered.resolve(), release.promise) : undefined); await h.ui.refresh(); h.choose(); await h.click('Read only my selected courses');
  h.input('d2l-reviewed').checked = true; const pending = h.startClick('Save reviewed course changes'); await entered.promise; h.ui.reset(); release.resolve({ status: 'imported' }); await pending; await Promise.resolve();
  assert.equal(h.notice, ''); assert.equal(h.root.textContent.includes('SOURCE_LITERAL_CANARY'), false); assert.equal(h.button('Read only my selected courses').disabled, true);
});

test('D2LUI08: a status read superseded by disconnect cannot restore old school access or account metadata', async t => {
  const entered = deferred(), release = deferred(); let delayed = false; const h = harness(t, path => path === '/d2l/status' && delayed ? (delayed = false, entered.resolve(), release.promise) : undefined); await h.ui.refresh();
  delayed = true; const oldRefresh = h.ui.refresh(); await entered.promise; await h.click('Disconnect school browser'); release.resolve(status(connection)); await oldRefresh;
  assert.equal(h.button('Read only my selected courses').disabled, true); assert.equal(h.root.textContent.includes('School account: Synthetic Student'), false);
});

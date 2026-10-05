import test from 'node:test';
import assert from 'node:assert/strict';
import { mountAcademicTasksUI } from '../apps/local/public/academic-tasks.js';
// Stand-in executes shipped UI handlers and ordering; no real-browser rendering claim.
class Node {
  constructor(tag, cls = '', text = '') { this.tagName = tag; this.className = cls; this.text = text; this.children = []; this.listeners = new Map(); this.checked = false; this.disabled = false; this.hidden = false; this.value = ''; this.classList = { toggle() {} }; }
  append(...values) { this.children.push(...values); }
  replaceChildren(...values) { this.children = values; this.text = ''; }
  addEventListener(name, callback) { this.listeners.set(name, [...(this.listeners.get(name) || []), callback]); }
  setAttribute() {}
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.children = []; }
}
const walk = node => [node, ...node.children.flatMap(walk)], fire = (node, type = 'click') => { for (const callback of node.listeners.get(type) || []) callback({ preventDefault() {} }); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const snapshotId = 'c3f8b58b-d22d-4f45-a652-9928b2e9c322', itemId = '68349d26-6562-42b6-87c8-e798275b224d', unknownId = 'a933f1b0-c6ed-4b41-a4d5-868f8d2bd293', previewId = '43b2c1ed-c3f0-49be-8d71-50909b0b6f11', proposalId = 'dfdd68a2-e526-4c68-972e-aa6fe5fb4da7';
const source = { item_id: itemId, source_id: 'a', source_hash: 'a'.repeat(64), course_id: 'A', title: '<script>ACADEMIC_TITLE_CANARY</script>', deadline: { precision: 'date', date: '2026-10-10', timezone: 'America/Toronto', original: '2026-10-10' } };
const item = { source, course_label: 'SYN101', state: 'new_proposal', task: { title: `Prepare: ${source.title}`, deadline: source.deadline, course_label: 'SYN101' } };
const unknown = { ...item, source: { ...source, item_id: unknownId, title: 'Unknown deadline exercise', deadline: { precision: 'unknown', reason: 'source_precision_unknown', original: 'next week' } }, state: 'unknown_deadline' };
const preview = (revision = 1, state = 'preview') => ({ id: previewId, revision, title: 'Review selected academic tasks', expired: false, needs_refresh: false, data: { state, expires_at: '2026-10-04T16:10:00.000Z', items: [item], source_pins: [{ snapshot_id: snapshotId }], review_hash: 'b'.repeat(64), proposal_ids: [] } });
const proposal = (revision = 1, state = 'awaiting_review') => ({ id: proposalId, revision, review_revision: 1, needs_refresh: false, accepted_task: null, data: { state, task: item.task, source, source_pins: [{ snapshot_id: snapshotId }], payload_hash: 'c'.repeat(64), task_id: null } });
function harness(t, options = {}) {
  const root = new Node('main'), calls = [], jobs = [], confirmations = []; let previews = options.previews ?? [], proposals = options.proposals ?? [];
  const ui = mountAcademicTasksUI({ root, element: (tag, cls, text) => new Node(tag, cls, text), request: async (path, extras = {}) => {
    calls.push({ path, ...extras }); const override = options.handle?.(path, extras); if (override !== undefined) return await override;
    if (path === '/academic-tasks/context') return { snapshots: [{ id: snapshotId, institution: 'Synthetic University', retrieved_at: '2026-10-04T10:00:00.000Z', courses: [{ id: 'A', title: 'Selected algorithms', code: 'SYN101' }] }] };
    if (path === '/academic-tasks/previews' && !extras.method) return { items: previews };
    if (path === '/academic-tasks/proposals') return { items: proposals };
    if (path === '/academic-tasks/inspect') return { items: [item, unknown], total_items: 2, truncated: false };
    if (path === '/academic-tasks/previews' && extras.method === 'POST') { previews = [preview()]; return { item: previews[0] }; }
    if (path.endsWith('/save')) { previews = [preview(2, 'saved')]; proposals = [proposal()]; return { proposals, tasks_created: 0 }; }
    if (path.endsWith('/accept')) { proposals = [{ ...proposal(3, 'accepted'), accepted_task: { id: itemId, changed: false }, data: { ...proposal().data, state: 'accepted', task_id: itemId } }]; return { item: proposals[0] }; }
    if (path.endsWith('/reject')) { proposals = [proposal(2, 'rejected')]; return { item: proposals[0] }; }
    throw new Error(`Unexpected academic-task UI request ${path}`);
  }, busy(target, action) { target.disabled = true; const job = Promise.resolve().then(action).finally(() => { target.disabled = false; }); jobs.push(job); return job; },
  confirmAction: async (...args) => { confirmations.push(args); return options.confirm ? await options.confirm(...args) : true; } });
  t.after(() => ui.reset()); const find = predicate => { const node = walk(root).find(predicate); assert(node); return node; }, button = text => find(node => node.tagName === 'button' && node.textContent === text), input = id => find(node => node.id === id);
  return { root, ui, calls, jobs, confirmations, button, input, get notice() { return input('academic-tasks-status').textContent; },
    chooseCourse() { input('academic-tasks-snapshot').value = snapshotId; fire(input('academic-tasks-snapshot'), 'change'); input('academic-tasks-course-A').checked = true; fire(input('academic-tasks-course-A'), 'change'); },
    chooseItem() { input(`academic-tasks-item-${itemId}`).checked = true; fire(input(`academic-tasks-item-${itemId}`), 'change'); },
    setProposals(value) { proposals = value; }, setPreviews(value) { previews = value; },
    start(caption) { fire(button(caption)); return jobs.at(-1); }, async click(caption) { fire(button(caption)); await jobs.at(-1)?.catch(() => {}); },
  };
}

test('ATUI01: opening reads saved metadata only, no snapshot/course default selection and no automatic inspect/model/provider request', async t => {
  const h = harness(t); await h.ui.refresh(); assert.deepEqual(h.calls.map(call => call.path).sort(), ['/academic-tasks/context', '/academic-tasks/previews', '/academic-tasks/proposals']); assert.equal(h.input('academic-tasks-snapshot').value, '');
  await h.click('Inspect selected course deadlines'); assert.equal(h.calls.some(call => call.method === 'POST'), false); h.chooseCourse(); assert.equal(h.input('academic-tasks-course-A').checked, true);
  assert.match(h.root.textContent, /does not refresh D2L/);
});

test('ATUI02: selected inspect displays source titles literally and keeps unknown dates visible/disabled without guessing', async t => {
  const h = harness(t); await h.ui.refresh(); h.chooseCourse(); await h.click('Inspect selected course deadlines'); assert.deepEqual(h.calls.find(call => call.path.endsWith('/inspect')).body, { snapshot_ids: [snapshotId], course_ids: ['A'] });
  assert.equal(h.input(`academic-tasks-item-${itemId}`).checked, false); assert.equal(h.input(`academic-tasks-item-${unknownId}`).disabled, true); assert.match(h.root.textContent, /Unknown date: next week/);
  assert.equal(walk(h.root).some(node => node.tagName === 'script'), false); assert.match(h.root.textContent, /<script>ACADEMIC_TITLE_CANARY<\/script>/);
  h.input(`academic-tasks-item-${unknownId}`).checked = true; await h.click('Prepare exact task preview'); assert.equal(h.calls.some(call => call.path === '/academic-tasks/previews' && call.method === 'POST'), false);
});

test('ATUI03: exact preview/save creates pending review, then a separate confirmation accepts only the displayed local task', async t => {
  const h = harness(t); await h.ui.refresh(); h.chooseCourse(); await h.click('Inspect selected course deadlines'); h.chooseItem(); await h.click('Prepare exact task preview');
  const prepared = h.calls.find(call => call.path === '/academic-tasks/previews' && call.method === 'POST'); assert.deepEqual(prepared.body, { snapshot_ids: [snapshotId], course_ids: ['A'], assignment_ids: [itemId] });
  await h.click('Save pending academic task proposals'); assert.equal(h.calls.some(call => call.path.endsWith('/accept')), false); assert.match(h.notice, /Accept each exact task separately/);
  assert.deepEqual(h.calls.find(call => call.path.endsWith('/save')).body, { expected_revision: 1, review_hash: 'b'.repeat(64) }); await h.click('Accept this academic task');
  assert.deepEqual(h.calls.find(call => call.path.endsWith('/accept')).body, { expected_revision: 1, payload_hash: 'c'.repeat(64), confirmed: true }); assert.equal(h.confirmations.length, 2); assert.match(h.confirmations[0][0], /pending local reviews only/);
});

test('ATUI04: refused pending save or acceptance confirmation never mutates the review', async t => {
  const h = harness(t, { previews: [preview()], proposals: [proposal()], confirm: async () => false }); await h.ui.refresh(); await h.click('Save pending academic task proposals'); await h.click('Accept this academic task');
  assert.equal(h.calls.some(call => call.method === 'POST'), false);
});

test('ATUI05: scope change while inspect waits discards late rows; changed selection during pending-save consent discards the old action', async t => {
  const entered = deferred(), released = deferred(); const h = harness(t, { handle: path => path.endsWith('/inspect') ? (entered.resolve(), released.promise) : undefined }); await h.ui.refresh(); h.chooseCourse();
  const pending = h.start('Inspect selected course deadlines'); await entered.promise; h.input('academic-tasks-course-A').checked = false; fire(h.input('academic-tasks-course-A'), 'change'); released.resolve({ items: [item], total_items: 1 }); await pending;
  assert.equal(h.root.textContent.includes('ACADEMIC_TITLE_CANARY'), false);
  const consent = deferred(), finished = deferred(), other = harness(t, { previews: [preview()], confirm: () => { consent.resolve(); return finished.promise; } }); await other.ui.refresh(); other.chooseCourse();
  const saving = other.start('Save pending academic task proposals'); await consent.promise; other.input('academic-tasks-course-A').checked = false; fire(other.input('academic-tasks-course-A'), 'change'); finished.resolve(true); await saving;
  assert.equal(other.calls.some(call => call.path.endsWith('/save')), false);
});

test('ATUI06: refreshed proposal revision during confirmation blocks stale acceptance; source-changed awaiting proposal disables the acceptance control', async t => {
  const entered = deferred(), released = deferred(); const h = harness(t, { proposals: [proposal()], confirm: () => { entered.resolve(); return released.promise; } }); await h.ui.refresh(); const pending = h.start('Accept this academic task'); await entered.promise;
  h.setProposals([{ ...proposal(2), needs_refresh: true }]); await h.ui.refresh(); released.resolve(true); await pending; assert.equal(h.calls.some(call => call.path.endsWith('/accept')), false); assert.equal(h.button('Accept this academic task').disabled, true);
});

test('ATUI07: reset during acceptance and late read prevents private metadata/control revival', async t => {
  const entered = deferred(), released = deferred(); const h = harness(t, { proposals: [proposal()], confirm: () => { entered.resolve(); return released.promise; } }); await h.ui.refresh(); const pending = h.start('Accept this academic task'); await entered.promise; h.ui.reset(); released.resolve(true); await pending;
  assert.equal(h.calls.some(call => call.path.endsWith('/accept')), false); assert.equal(h.root.textContent.includes('ACADEMIC_TITLE_CANARY'), false); assert.equal(h.notice, ''); assert.equal(h.button('Inspect selected course deadlines').disabled, true);
});

test('ATUI08: duplicate handlers coalesce; interrupted acceptance is explicit and exact rejection uses only the current review payload', async t => {
  const entered = deferred(), released = deferred(); const h = harness(t, { proposals: [{ ...proposal(2, 'accepting'), needs_refresh: true }], confirm: () => { entered.resolve(); return released.promise; } }); await h.ui.refresh();
  const pending = h.start('Finish reviewed academic task'); h.start('Finish reviewed academic task'); await entered.promise; released.resolve(true); await pending; assert.equal(h.calls.filter(call => call.path.endsWith('/accept')).length, 1);
  const rejected = harness(t, { proposals: [proposal()] }); await rejected.ui.refresh(); await rejected.click('Reject this academic task'); assert.deepEqual(rejected.calls.find(call => call.path.endsWith('/reject')).body, { expected_revision: 1, payload_hash: 'c'.repeat(64), confirmed: true });
});

test('ATUI09: older async refresh cannot replace a newer accepted record, and changed/unavailable task receipts are displayed honestly', async t => {
  const entered = deferred(), released = deferred(); let delay = false; const h = harness(t, { proposals: [proposal()], handle: path => path === '/academic-tasks/proposals' && delay ? (delay = false, entered.resolve(), released.promise) : undefined }); await h.ui.refresh();
  delay = true; const older = h.ui.refresh(); await entered.promise; h.setProposals([{ ...proposal(3, 'accepted'), accepted_task: { id: itemId, changed: true } }]); await h.ui.refresh(); released.resolve({ items: [proposal()] }); await older;
  assert.equal(walk(h.root).some(node => node.tagName === 'button' && node.textContent === 'Accept this academic task'), false); assert.match(h.root.textContent, /Your edits are preserved/);
  h.setProposals([{ ...proposal(3, 'accepted'), accepted_task: { id: itemId, unavailable: true } }]); await h.ui.refresh(); assert.match(h.root.textContent, /not recreated/);
});

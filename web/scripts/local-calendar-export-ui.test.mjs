import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mountCalendarExportUI } from '../apps/local/public/calendar-export.js';
class Node {
  constructor(tag, cls = '', text = '') { this.tagName = tag; this.className = cls; this.text = text; this.children = []; this.listeners = new Map(); this.checked = false; this.disabled = false; this.value = ''; this.classList = { toggle() {} }; }
  append(...values) { this.children.push(...values); } replaceChildren(...values) { this.children = values; this.text = ''; } addEventListener(name, callback) { this.listeners.set(name, [...(this.listeners.get(name) || []), callback]); } setAttribute() {}
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); } set textContent(value) { this.text = String(value); this.children = []; }
}
const walk = node => [node, ...node.children.flatMap(walk)], fire = (node, type = 'click') => { for (const callback of node.listeners.get(type) || []) callback({ preventDefault() {} }); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const taskId = 'ba0ee40c-2449-4f83-9494-4d5b86b144aa', previewId = 'd0b613ae-3aeb-4538-9bdb-0e0a09bb5e84', planId = '07e2135f-5d3f-4d2b-b8b7-5ff9e6f00afd', content = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n', hash = createHash('sha256').update(content).digest('hex');
const task = { id: taskId, revision: 1, title: '<script>CALENDAR_TITLE_CANARY</script>', status: 'pending', deadline: { precision: 'date', date: '2026-11-01' } };
const savedPlan = { id: planId, revision: 2, title: 'Known saved study plan', state: 'accepted', plan_hash: 'c'.repeat(64), timezone: 'America/Toronto', block_count: 1, eligible: true };
const preview = (revision = 1, extras = {}) => ({ id: previewId, revision, title: 'Reviewed local calendar', expired: false, needs_refresh: false, data: { events: [{ title: `Due: ${task.title}`, kind: 'date_deadline', deadline: task.deadline, timezone: null }], omitted: [{ title: 'Ambiguous task', deadline: { precision: 'unknown', original: 'next week' }, reason: 'unknown_deadline' }], warnings: {}, pins: [], bytes: Buffer.byteLength(content), content, sha256: hash, review_hash: 'b'.repeat(64), expires_at: '2026-10-04T16:10:00.000Z' }, ...extras });
const payload = () => ({ filename: `learnbridge-${previewId}.ics`, mime: 'text/calendar;charset=utf-8', bytes: Buffer.byteLength(content), sha256: hash, content, item: preview(2), provider_writes: 0 });
function harness(t, options = {}) {
  const root = new Node('main'), calls = [], jobs = [], files = [], confirmations = []; let previews = options.previews ?? [];
  const ui = mountCalendarExportUI({ root, element: (tag, cls, text) => new Node(tag, cls, text), request: async (path, extras = {}) => {
    calls.push({ path, ...extras }); const override = options.handle?.(path, extras); if (override !== undefined) return await override;
    if (path === '/calendar-export/context') return { tasks: [task], plans: [savedPlan] };
    if (path === '/calendar-export/previews' && !extras.method) return { items: previews };
    if (path === '/calendar-export/previews') { previews = [preview()]; return { item: previews[0] }; }
    if (path.endsWith('/download')) { previews = [preview(2)]; return payload(); }
    throw new Error(`Unexpected calendar-export UI path ${path}`);
  }, busy(target, action) { target.disabled = true; const job = Promise.resolve().then(action).finally(() => { target.disabled = false; }); jobs.push(job); return job; },
  confirmAction: async (...args) => { confirmations.push(args); return options.confirm ? await options.confirm(...args) : true; }, downloadFile: async file => files.push(file) });
  t.after(() => ui.reset());
  const find = predicate => { const node = walk(root).find(predicate); assert(node); return node; }, button = text => find(node => node.tagName === 'button' && node.textContent === text), input = id => find(node => node.id === id);
  return { root, ui, calls, jobs, files, confirmations, button, input, get notice() { return input('calendar-export-status').textContent; }, chooseTask() { input(`calendar-export-task-${taskId}`).checked = true; fire(input(`calendar-export-task-${taskId}`), 'change'); },
    setPreviews(value) { previews = value; }, start(caption) { fire(button(caption)); return jobs.at(-1); }, async click(caption) { fire(button(caption)); await jobs.at(-1)?.catch(() => {}); } };
}

test('CEUI01: opening selects no task/plan and only reads local metadata; titles rendered literally', async t => {
  const h = harness(t); await h.ui.refresh(); assert.deepEqual(h.calls.map(call => call.path).sort(), ['/calendar-export/context', '/calendar-export/previews']); assert.equal(h.input(`calendar-export-task-${taskId}`).checked, false); assert.equal(h.input('calendar-export-plan').value, '');
  await h.click('Prepare exact calendar preview'); assert.equal(h.calls.some(call => call.method === 'POST'), false); assert.match(h.root.textContent, /<script>CALENDAR_TITLE_CANARY<\/script>/); assert.equal(walk(h.root).some(node => node.tagName === 'script'), false);
});
test('CEUI02: selected task preview is separate from exact confirmed hash-checked download; unknown precision visible', async t => {
  const h = harness(t); await h.ui.refresh(); h.chooseTask(); await h.click('Prepare exact calendar preview'); assert.deepEqual(h.calls.find(call => call.method === 'POST').body, { mode: 'tasks', task_ids: [taskId] }); assert.equal(h.files.length, 0); assert.equal(h.calls.some(call => call.path.endsWith('/download')), false); assert.match(h.root.textContent, /Omitted: Ambiguous task · unknown date · next week/);
  await h.click('Review and download this calendar'); assert.deepEqual(h.calls.find(call => call.path.endsWith('/download')).body, { expected_revision: 1, review_hash: 'b'.repeat(64), confirmed: true }); assert.equal(h.files.length, 1); assert.equal(h.files[0].content, content); assert.equal(h.confirmations.length, 1); assert.match(h.notice, /External import is not verified/);
});
test('CEUI03: accepted plan selection forwards exact current revision/hash, never recomputes study hours in UI', async t => {
  const h = harness(t); await h.ui.refresh(); h.input('calendar-export-mode').value = 'study_plan'; fire(h.input('calendar-export-mode'), 'change'); h.input('calendar-export-plan').value = planId; fire(h.input('calendar-export-plan'), 'change'); await h.click('Prepare exact calendar preview');
  assert.deepEqual(h.calls.find(call => call.method === 'POST').body, { mode: 'study_plan', plan_id: planId, expected_revision: 2, plan_hash: 'c'.repeat(64) }); assert.equal(h.files.length, 0);
});
test('CEUI04: refused review, expired preview and changed source never request or start a file download', async t => {
  for (const options of [{ confirm: async () => false }, { previews: [preview(1, { expired: true })] }, { previews: [preview(1, { needs_refresh: true })] }]) {
    const h = harness(t, { previews: [preview()], ...options }); await h.ui.refresh(); await h.click('Review and download this calendar'); assert.equal(h.calls.some(call => call.method === 'POST'), false); assert.equal(h.files.length, 0);
  }
});
test('CEUI05: selection change or refreshed revision while review waits prevents stale confirmation', async t => {
  for (const change of ['selection', 'revision']) {
    const entered = deferred(), released = deferred(), h = harness(t, { previews: [preview()], confirm: () => { entered.resolve(); return released.promise; } }); await h.ui.refresh(); const pending = h.start('Review and download this calendar'); await entered.promise;
    if (change === 'selection') h.chooseTask(); else { h.setPreviews([preview(2)]); await h.ui.refresh(); } released.resolve(true); await pending;
    assert.equal(h.calls.some(call => call.path.endsWith('/download')), false); assert.equal(h.files.length, 0);
  }
});
test('CEUI06: reset/logout during confirmation or payload await prevents private file/control revival', async t => {
  for (const stage of ['review', 'payload']) {
    const entered = deferred(), released = deferred(), h = harness(t, { previews: [preview()], ...(stage === 'review' ? { confirm: () => { entered.resolve(); return released.promise; } } : { handle: path => path.endsWith('/download') ? (entered.resolve(), released.promise) : undefined }) }); await h.ui.refresh(); const pending = h.start('Review and download this calendar'); await entered.promise; h.ui.reset(); released.resolve(stage === 'review' ? true : payload()); await pending;
    assert.equal(h.files.length, 0); assert.equal(h.root.textContent.includes('CALENDAR_TITLE_CANARY'), false); assert.equal(h.button('Prepare exact calendar preview').disabled, true); assert.equal(h.notice, '');
  }
});
test('CEUI07: mismatched reviewed content/hash/byte count cannot reach file sink', async t => {
  for (const corrupt of [{ content: 'changed private file' }, { sha256: 'a'.repeat(64) }, { bytes: 999 }]) {
    const h = harness(t, { previews: [preview()], handle: path => path.endsWith('/download') ? { ...payload(), ...corrupt } : undefined }); await h.ui.refresh(); await h.click('Review and download this calendar'); assert.equal(h.files.length, 0); assert.match(h.notice, /Reviewed calendar content changed/);
  }
});
test('CEUI08: double click while exact review is pending produces one confirmation/download only', async t => {
  const entered = deferred(), released = deferred(), h = harness(t, { previews: [preview()], confirm: () => { entered.resolve(); return released.promise; } }); await h.ui.refresh(); const pending = h.start('Review and download this calendar'); await entered.promise; fire(h.button('Review and download this calendar')); released.resolve(true); await pending; assert.equal(h.confirmations.length, 1); assert.equal(h.files.length, 1); assert.equal(h.calls.filter(call => call.path.endsWith('/download')).length, 1);
});

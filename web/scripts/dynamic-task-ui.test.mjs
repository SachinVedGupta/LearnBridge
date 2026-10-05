import test from 'node:test';
import assert from 'node:assert/strict';
import { mountDynamicTasksUI } from '../apps/local/public/dynamic-tasks.js';
// Executes the shipped UI handlers with a small DOM stand-in. Browser layout and
// real provider/model success require separate end-to-end evidence.
class Node {
  constructor(tag, cls = '', text = '') { this.tagName = tag; this.className = cls; this.text = text; this.children = []; this.listeners = new Map(); this.checked = false; this.disabled = false; this.hidden = false; this.value = ''; this.dataset = {}; this.classList = { toggle() {} }; }
  append(...values) { this.children.push(...values); }
  replaceChildren(...values) { this.children = values; this.text = ''; }
  addEventListener(name, fn) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]); }
  setAttribute() {}
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.children = []; }
}
const walk = node => [node, ...node.children.flatMap(walk)], fire = (node, type = 'click') => { for (const listener of node.listeners.get(type) ?? []) listener({ preventDefault() {} }); };
const deferred = () => { let resolve; const promise = new Promise(fn => { resolve = fn; }); return { promise, resolve }; };
const id = 'aad398f4-b8c2-487a-a555-2dabf8ee8dc7', taskId = 'f7946548-1539-4a6a-aecc-4dbd94ad79a5', sourceHash = 'a'.repeat(64);
const source = { kind: 'update', id, revision: 1, title: 'Selected advising message', account: 'gmail/selected@example.com', freshness: 'student_pasted_not_live_synced', source_hash: sourceHash };
const config = () => ({ revision: 0, data: { selections: [], enabled: false, auto_create: false, auto_complete: false } });
const task = { id: taskId, revision: 1, title: '<script>LITERAL_TASK_TITLE</script>', status: 'pending', deadline: { precision: 'unknown' }, course_label: null };
const taskRow = { task, group: 'needs_date', blocked_by: [], observations: [], ranking_reason: 'No definite deadline was supplied.' };
function harness(t, options = {}) {
  const root = new Node('main'), calls = [], jobs = [], confirmations = []; let saved = config(), rows = options.taskRows ?? [taskRow], sessions = options.sessions ?? [];
  const preview = { source_pin: { id, revision: 1, hash: sourceHash }, review_hash: 'b'.repeat(64), provider: 'gmail', account: 'selected@example.com', context_text: 'Provider/account: gmail/selected@example.com\nPlease book advising by 2026-10-09.\nEnd selected body.' };
  const ui = mountDynamicTasksUI({ root, element: (tag, cls, text) => new Node(tag, cls, text), request: async (path, extras = {}) => {
    calls.push({ path, ...extras }); const override = options.handle?.(path, extras); if (override !== undefined) return await override;
    if (path === '/dynamic-tasks/context') return { sources: [source] };
    if (path === '/dynamic-tasks/list') return { config: saved, tasks: rows, observations: [], groups: ['needs_date'] };
    if (path === '/task-sessions') return { items: sessions };
    if (path === '/dynamic-task-ai/context') return { sources: [source], capability: { state: 'available' }, limits: { body_bytes: 16000 } };
    if (path === '/dynamic-task-ai/extractions' && !extras.method) return { items: [] };
    if (path === '/dynamic-tasks/config') { saved = { revision: 1, data: { ...extras.body } }; return { item: saved }; }
    if (path === '/dynamic-tasks/refresh') return { created_observations: 0, changed_observations: 0, tasks_created: 0, source_failures: [] };
    if (path === '/dynamic-task-ai/preview') return preview;
    if (path === '/dynamic-task-ai/extractions' && extras.method === 'POST') return { item: { id, data: { state: 'queued' } } };
    throw new Error(`Unexpected dynamic UI request: ${path}`);
  }, busy(control, fn) { control.disabled = true; const job = Promise.resolve().then(fn).finally(() => { control.disabled = false; }); jobs.push(job); return job; },
  confirmAction: async (...args) => { confirmations.push(args); return options.confirm ? await options.confirm(...args) : true; }, onGetStarted: options.onGetStarted, onOpenSession: options.onOpenSession });
  t.after(() => ui.reset()); const find = predicate => { const node = walk(root).find(predicate); assert(node); return node; };
  return { root, ui, calls, confirmations, find, field: id => find(node => node.id === id), button: text => find(node => node.tagName === 'button' && node.textContent === text),
    async click(text) { fire(this.button(text)); await jobs.at(-1)?.catch(() => {}); }, start(text) { fire(this.button(text)); return jobs.at(-1); }, setSessions(value) { sessions = value; }, setRows(value) { rows = value; } };
}
test('DTUI01: initial load shows unchecked sources and off automation, saved task titles literally, and no source body/model read or write', async t => {
  const h = harness(t); await h.ui.refresh(); assert.equal(h.field(`dynamic-source-update-${id}`).checked, false); for (const name of ['enabled', 'auto_create', 'auto_complete']) assert.equal(h.field(`dynamic-tasks-${name}`).checked, false);
  assert.equal(h.calls.some(call => call.method === 'POST'), false); assert.match(h.root.textContent, /LITERAL_TASK_TITLE/); assert.equal(walk(h.root).some(node => node.tagName === 'script'), false);
});
test('DTUI02: selected exact source policy has one confirmation and does not substitute another selected account', async t => {
  const h = harness(t); await h.ui.refresh(); h.field(`dynamic-source-update-${id}`).checked = true; h.field('dynamic-tasks-enabled').checked = true;
  await h.click('Review and save source policy'); const input = h.calls.find(call => call.path === '/dynamic-tasks/config').body;
  assert.deepEqual(input.selections, [{ kind: 'update', id, course_ids: [] }]); assert.equal(input.auto_create, false); assert.equal(input.auto_complete, false); assert.equal(input.confirmed, true); assert.equal(h.confirmations.length, 1);
});
test('DTUI03: policy changes while consent waits are discarded before mutation', async t => {
  const entered = deferred(), release = deferred(), h = harness(t, { confirm: () => { entered.resolve(); return release.promise; } }); await h.ui.refresh(); h.field(`dynamic-source-update-${id}`).checked = true;
  const running = h.start('Review and save source policy'); await entered.promise; h.field('dynamic-tasks-auto_create').checked = true; release.resolve(true); await running;
  assert.equal(h.calls.some(call => call.path === '/dynamic-tasks/config'), false);
});
test('DTUI04: exact message preview displays all selected context before a separate AI start confirmation, with stable explicit source pins', async t => {
  const h = harness(t); await h.ui.refresh(); h.field('dynamic-tasks-ai-source').value = id; fire(h.field('dynamic-tasks-ai-source'), 'change'); await h.click('Preview exact message for AI');
  assert.match(h.root.textContent, /Please book advising by 2026-10-09/); assert.equal(h.calls.some(call => call.path === '/dynamic-task-ai/extractions' && call.method === 'POST'), false);
  await h.click('Review and find actions with Codex'); const sent = h.calls.find(call => call.path === '/dynamic-task-ai/extractions' && call.method === 'POST');
  assert.deepEqual(sent.body, { source_id: id, source_revision: 1, source_hash: sourceHash, review_hash: 'b'.repeat(64), confirmed: true }); assert(sent.idempotencyKey); assert.match(h.confirmations[0][0], /selected@example.com/); assert.match(h.confirmations[0][0], /60-minute/);
});
test('DTUI05: source picker change or reset during AI consent stops the old start request and private context revival', async t => {
  const entered = deferred(), release = deferred(), h = harness(t, { confirm: () => { entered.resolve(); return release.promise; } }); await h.ui.refresh(); h.field('dynamic-tasks-ai-source').value = id; fire(h.field('dynamic-tasks-ai-source'), 'change'); await h.click('Preview exact message for AI');
  const running = h.start('Review and find actions with Codex'); await entered.promise; h.ui.reset(); release.resolve(true); await running;
  assert.equal(h.calls.some(call => call.path === '/dynamic-task-ai/extractions' && call.method === 'POST'), false); assert.equal(h.root.textContent.includes('Please book advising'), false); assert.equal(h.button('Preview exact message for AI').disabled, true);
});
test('DTUI06: linked task session visibly shows actual tool progress/result and open session; get started receives exact current task', async t => {
  const started = [], opened = [], session = { id, data: { task_pin: { id: taskId }, state: 'ready_for_review', progress: [{ tool: 'learnbridge_context', state: 'finished' }], result: 'Prepared a source-backed outline for your review.' } };
  const h = harness(t, { sessions: [session], onGetStarted: value => started.push(value), onOpenSession: (value, run) => opened.push({ value, run }) }); await h.ui.refresh();
  assert.match(h.root.textContent, /Agent: ready for review/); assert.match(h.root.textContent, /context finished/); assert.match(h.root.textContent, /source-backed outline/);
  await h.click('Get started'); assert.deepEqual(started, [task]); await h.click('Open agent session'); assert.equal(opened[0].run.id, session.id); assert.equal(opened[0].value.id, taskId);
  h.setRows([{ ...taskRow, task: { ...task, status: 'completed' }, group: 'done' }]); await h.ui.refresh(); assert.match(h.root.textContent, /Done list/); assert.equal(walk(h.root).some(node => node.tagName === 'button' && node.textContent === 'Get started'), false); assert(h.button('Open agent session'));
});
test('DTUI07: pause during a selected-source preview discards late private data, stops old authority, and a fresh visible refresh can start again', async t => {
  const entered = deferred(), release = deferred(); let hold = true;
  const h = harness(t, { handle: path => path === '/dynamic-task-ai/preview' && hold ? (entered.resolve(), release.promise) : undefined }); await h.ui.refresh();
  h.field('dynamic-tasks-ai-source').value = id; fire(h.field('dynamic-tasks-ai-source'), 'change'); const waiting = h.start('Preview exact message for AI'); await entered.promise; h.ui.pause();
  release.resolve({ source_pin: { id, revision: 1, hash: sourceHash }, context_text: 'LATE_PAUSED_PRIVATE_CANARY' }); await waiting; assert.equal(h.root.textContent.includes('LATE_PAUSED_PRIVATE_CANARY'), false);
  hold = false; await h.ui.refresh(); h.field('dynamic-tasks-ai-source').value = id; fire(h.field('dynamic-tasks-ai-source'), 'change'); await h.click('Preview exact message for AI'); assert.match(h.root.textContent, /Please book advising/);
});

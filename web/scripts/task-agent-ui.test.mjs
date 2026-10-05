import test from 'node:test';
import assert from 'node:assert/strict';
import { mountTaskAgentsUI } from '../apps/local/public/task-agents.js';

// Executes real UI handlers; fixture session states are not claims of live AI,
// provider writes, submissions, or automatic task completion.
class Node {
  constructor(tag, cls = '', text = '') { this.tagName = tag; this.className = cls; this.text = text; this.children = []; this.listeners = new Map(); this._value = ''; this.checked = false; this.disabled = false; this.dataset = {}; this.attributes = new Map(); this.classList = { toggle() {} }; }
  append(...values) { this.children.push(...values); }
  replaceChildren(...values) { this.children = values; this.text = ''; this._value = ''; }
  addEventListener(name, callback) { this.listeners.set(name, [...(this.listeners.get(name) || []), callback]); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.children = []; }
  get options() { return this.children; }
  get value() { return this._value || (this.tagName === 'select' ? this.children[0]?.value || '' : ''); }
  set value(value) { this._value = String(value); }
  querySelectorAll(selector) { assert.equal(selector, 'input:checked'); return walk(this).filter(node => node.tagName === 'input' && node.checked); }
  focus() { this.focused = true; }
}
const walk = root => [root, ...root.children.flatMap(walk)], fire = (node, type = 'click', extras = {}) => { for (const handler of node.listeners.get(type) || []) handler({ preventDefault() {}, ...extras }); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const task1 = { id: 'task-1', revision: 2, title: '<script>Prepare application draft</script>', status: 'pending' }, task2 = { id: 'task-2', revision: 1, title: 'Study one concept', status: 'pending' };
const ready = () => ({ id: 'session-1', revision: 4, created_at: '2026-10-05T12:00:00Z', data: { state: 'ready_for_review', task_pin: { ...task1 }, instructions: 'Prepare a truthful draft.', progress: [{ tool: 'learnbridge_context', state: 'finished' }], result: 'LOCAL REVIEW DRAFT ONLY. Nothing submitted.', turn_revision: 3, source_current: true } });
const working = () => ({ id: 'session-2', revision: 2, created_at: '2026-10-05T12:01:00Z', data: { state: 'working', task_pin: { ...task2 }, progress: [{ tool: 'learnbridge_context', state: 'running' }], result: '', turn_revision: 2 } });
function harness(t, options = {}) {
  const root = new Node('main'), calls = [], confirmations = [], jobs = [], timers = new Map(); let rows = options.sessions || [ready()], timerIndex = 0, documents = [{ id: 'note-1', revision: 3, sha256: 'a'.repeat(64), title: 'Reviewed experience' }];
  t.mock.method(globalThis, 'setTimeout', callback => { timers.set(++timerIndex, callback); return timerIndex; }); t.mock.method(globalThis, 'clearTimeout', id => { timers.delete(id); });
  const ui = mountTaskAgentsUI({ root, element: (tag, cls, text) => new Node(tag, cls, text), request: async (path, extra = {}) => {
    calls.push({ path, ...extra }); const override = options.handle?.(path, extra); if (override !== undefined) return await override;
    if (path === '/task-sessions/context') return { tasks: [task1, task2], documents, capability: { state: 'available' } };
    if (path === '/task-sessions' && !extra.method) return { items: structuredClone(rows) };
    if (path === '/task-sessions' && extra.method === 'POST') return { item: { data: { state: 'queued' } } };
    if (path === '/task-sessions/session-1/complete') { rows = [{ ...ready(), data: { ...ready().data, state: 'done', completion: { evidence_note: extra.body.evidence_note, retained_result_basis: 'explicit_student_completion_review_local_history' } } }]; return { item: rows[0] }; }
    if (path.endsWith('/cancel')) return { item: {} };
    throw new Error(`Unexpected task agent route ${path}`);
  }, busy(node, task) { node.disabled = true; const job = Promise.resolve().then(task).finally(() => { node.disabled = false; }); jobs.push(job); return job; }, confirmAction: async (...args) => { confirmations.push(args); return options.confirm ? await options.confirm(...args) : true; }, navigate() {} });
  t.after(() => ui.reset()); const find = predicate => { const node = walk(root).find(predicate); assert(node); return node; };
  return { root, ui, calls, confirmations, timers, get documents() { return documents; }, setDocuments(value) { documents = value; }, setSessions(value) { rows = value; }, field: id => find(node => node.id === id), button: text => find(node => node.tagName === 'button' && node.textContent === text), evidence: () => find(node => node.tagName === 'input' && node.type === 'text'),
    start(text) { const node = this.button(text); assert.equal(node.disabled, false); fire(node); return jobs.at(-1); }, async click(text) { await this.start(text)?.catch(() => {}); }, async poll() { const callback = [...timers.values()][0]; assert(callback); callback(); await new Promise(resolve => setImmediate(resolve)); } };
}

test('TAUI01: working-session polling preserves another ready session completion evidence and never marks done automatically', async t => {
  const h = harness(t, { sessions: [ready(), working()] }); await h.ui.refresh(); const input = h.evidence(); input.value = 'Reviewed local draft against current sources'; fire(input, 'input'); await h.poll(); assert.equal(h.evidence().value, 'Reviewed local draft against current sources'); assert.equal(h.calls.some(row => row.method === 'POST'), false); assert.match(h.root.textContent, /Agent is working/); assert.match(h.root.textContent, /LOCAL REVIEW DRAFT ONLY/); assert.equal(walk(h.root).some(node => node.tagName === 'script'), false);
});
test('TAUI02: changing tasks clears a previously selected follow-up session; only the new exact task is sent', async t => {
  const h = harness(t); await h.ui.refresh(); await h.click('Continue this session'); const picker = h.field('task-agent-task'); picker.value = task2.id; fire(picker, 'change'); h.field('task-agent-instructions').value = 'Teach one concept.'; await h.click('Get started with agent'); const sent = h.calls.find(row => row.path === '/task-sessions' && row.method === 'POST'); assert.equal(sent.body.task_id, task2.id); assert.equal('previous_session_id' in sent.body, false); assert.deepEqual(sent.body.documents, []);
});
test('TAUI03: reset while start or completion review is pending discards late approval before every mutation', async t => {
  for (const kind of ['start', 'complete']) {
    const entered = deferred(), release = deferred(), h = harness(t, { confirm: () => { entered.resolve(); return release.promise; } }); await h.ui.refresh(); if (kind === 'complete') { h.evidence().value = 'I checked the draft'; fire(h.evidence(), 'input'); }
    const job = h.start(kind === 'start' ? 'Get started with agent' : 'Mark task done after review'); await entered.promise; h.ui.reset(); release.resolve(true); await job; assert.equal(h.calls.some(row => row.method === 'POST'), false); assert.equal(h.root.textContent.includes('LOCAL REVIEW DRAFT ONLY'), false);
  }
});
test('TAUI04: exact optional note version changes become unchecked, and page pause cancels working polling', async t => {
  const h = harness(t, { sessions: [working()] }); await h.ui.refresh(); const checkbox = walk(h.root).find(node => node.type === 'checkbox'); checkbox.checked = true; await h.ui.refresh(); assert.equal(walk(h.root).find(node => node.type === 'checkbox').checked, true); h.setDocuments([{ ...h.documents[0], revision: 4 }]); await h.ui.refresh(); assert.equal(walk(h.root).find(node => node.type === 'checkbox').checked, false); assert.equal(h.timers.size, 1); h.ui.pause(); assert.equal(h.timers.size, 0); assert.equal(h.calls.some(row => row.method === 'POST'), false);
});
test('TAUI05: completion approval binds the exact evidence displayed in its review instead of reading later edits', async t => {
  const entered = deferred(), release = deferred(), h = harness(t, { confirm: () => { entered.resolve(); return release.promise; } }); await h.ui.refresh(); const evidence = h.evidence(); evidence.value = 'EXACT REVIEWED EVIDENCE'; fire(evidence, 'input'); const job = h.start('Mark task done after review'); await entered.promise; evidence.value = 'UNREVIEWED LATER EDIT'; fire(evidence, 'input'); release.resolve(true); await job;
  const sent = h.calls.find(row => row.path.endsWith('/complete')); assert(!sent || sent.body.evidence_note === 'EXACT REVIEWED EVIDENCE', 'Only reviewed evidence may be saved'); assert.match(h.confirmations[0][0], /EXACT REVIEWED EVIDENCE/);
});
test('TAUI06: a start response after reset does not refresh and revive saved private sessions', async t => {
  const entered = deferred(), response = deferred(), h = harness(t, { handle: (path, extra) => path === '/task-sessions' && extra.method === 'POST' ? (entered.resolve(), response.promise) : undefined }); await h.ui.refresh(); const job = h.start('Get started with agent'); await entered.promise; h.ui.reset(); const reads = h.calls.filter(row => !row.method).length; response.resolve({ item: { data: { state: 'queued' } } }); await job; assert.equal(h.calls.filter(row => !row.method).length, reads); assert.equal(h.root.textContent.includes('LOCAL REVIEW DRAFT ONLY'), false);
});
test('TAUI07: completion requires student evidence and sends pinned task/turn/session revisions; done is a reviewed local receipt', async t => {
  const h = harness(t); await h.ui.refresh(); await h.click('Mark task done after review'); assert.equal(h.confirmations.length, 0); assert.equal(h.calls.some(row => row.path.endsWith('/complete')), false); h.evidence().value = 'Checked the finished local draft against my notes'; fire(h.evidence(), 'input'); await h.click('Mark task done after review'); const sent = h.calls.find(row => row.path.endsWith('/complete')); assert.equal(sent.body.expected_revision, 4); assert.equal(sent.body.turn_revision, 3); assert.equal(sent.body.task_revision, 2); assert.equal(sent.body.confirmed, true); assert.match(h.confirmations[0][0], /does not confirm a submission or external change/); assert.match(h.root.textContent, /Done — you reviewed the result/); assert.match(h.root.textContent, /reviewed copy of the result remains in local session history/);
});
test('TAUI08: completion response after reset cannot reload old private results or restore its draft', async t => {
  const entered = deferred(), response = deferred(), h = harness(t, { handle: path => path.endsWith('/complete') ? (entered.resolve(), response.promise) : undefined }); await h.ui.refresh(); h.evidence().value = 'Reviewed exact local result'; fire(h.evidence(), 'input'); const job = h.start('Mark task done after review'); await entered.promise; h.ui.reset(); const reads = h.calls.filter(row => !row.method).length; response.resolve({ item: ready() }); await job; assert.equal(h.calls.filter(row => !row.method).length, reads); assert.equal(h.root.textContent.includes('LOCAL REVIEW DRAFT ONLY'), false);
});
test('TAUI09: withheld answers have no completion controls while a saved reviewed done receipt stays visibly student-reviewed', async t => {
  const hidden = ready(); hidden.id = 'withheld-session'; hidden.data.state = 'withheld'; hidden.data.result = ''; hidden.data.source_current = false; const done = ready(); done.data.state = 'done'; done.data.source_current = false; done.data.completion = { retained_result_basis: 'explicit_student_completion_review_local_history', evidence_note: 'Checked the local draft' };
  const h = harness(t, { sessions: [hidden, done] }); await h.ui.refresh(); assert.match(h.root.textContent, /Permission ended/); assert.match(h.root.textContent, /Done — you reviewed the result/); assert.equal(walk(h.root).some(node => node.tagName === 'button' && node.textContent === 'Mark task done after review'), false); assert.equal(walk(h.root).some(node => node.tagName === 'input' && node.type === 'text'), false); assert.equal(h.root.textContent.split('LOCAL REVIEW DRAFT ONLY').length - 1, 1); assert.equal(h.calls.some(row => row.method === 'POST'), false);
});
test('TAUI10: reset removes follow-up pointers so the next selected task begins a fresh exact session', async t => {
  const h = harness(t); await h.ui.refresh(); await h.click('Continue this session'); h.ui.reset(); await h.ui.refresh(); h.ui.selectTask(task2.id); h.field('task-agent-instructions').value = 'Explain the next concrete step.'; await h.click('Get started with agent'); const sent = h.calls.find(row => row.path === '/task-sessions' && row.method === 'POST'); assert.equal(sent.body.task_id, task2.id); assert.equal('previous_session_id' in sent.body, false);
});

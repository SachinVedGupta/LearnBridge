import test from 'node:test';
import assert from 'node:assert/strict';
import { mountRemindersUI } from '../apps/local/public/reminders.js';

// Dependency-free stand-in executes the shipped handlers, not a browser/DOM rendering claim.
class Node {
  constructor(tag, cls = '', text = '') { this.tagName = tag; this.className = cls; this.text = text; this.children = []; this.listeners = new Map(); this.value = ''; this.checked = false; this.disabled = false; this.hidden = false; this.classList = { toggle() {} }; }
  append(...values) { this.children.push(...values); }
  replaceChildren(...values) { this.children = values; this.text = ''; }
  addEventListener(name, callback) { this.listeners.set(name, [...(this.listeners.get(name) || []), callback]); }
  setAttribute() {}
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.children = []; }
}
const walk = node => [node, ...node.children.flatMap(walk)];
const fire = (node, type = 'click') => { for (const callback of node.listeners.get(type) || []) callback({ preventDefault() {} }); };
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const taskId = '8c230373-e21b-4a88-b7f0-ec138fdfd9a8', scheduleId = '4a85f549-0a63-4f51-b6cb-58b58cac7e1d', eventId = 'd3e44887-58bd-4fe0-b970-73fcf3f63f3a';
const task = { id: taskId, title: '<script>SELECTED_TASK_CANARY</script>', revision: 1, status: 'pending', deadline: { precision: 'date', date: '2026-10-04', timezone: 'America/Toronto' } };
const row = (revision = 1, state = 'paused') => ({ id: scheduleId, revision, title: 'Fixture reminders', selected_tasks: [task], data: { state, task_ids: [taskId], timezone: 'America/Toronto', due_within_minutes: 1440, discarded_inbox_count: 0 } });
const event = { id: eventId, task_title: task.title, deadline: task.deadline, observed_at: '2026-10-04T16:00:00.000Z', acknowledged_at: null,
  schedule_title: 'Fixture reminders', schedule_id: scheduleId, schedule_revision: 2, timezone: 'America/Toronto', stage: 'due_today' };
function harness(t, options = {}) {
  const root = new Node('main'), calls = [], jobs = [], confirmations = []; let schedules = options.schedules ?? [row()], inbox = options.inbox ?? [];
  const ui = mountRemindersUI({ root, element: (tag, cls, text) => new Node(tag, cls, text),
    request: async (path, extras = {}) => {
      calls.push({ path, ...extras }); const result = options.handle?.(path, extras); if (result !== undefined) return await result;
      if (path === '/reminders/context') return { tasks: [task] };
      if (path === '/reminders/status') return { stopped: false, limits: { tick_interval_ms: 30000 }, last_check: null };
      if (path === '/reminders/schedules' && !extras.method) return { items: schedules };
      if (path === '/reminders/inbox') return { items: inbox };
      if (path === '/reminders/schedules' && extras.method === 'POST') { schedules = [row()]; return { item: row() }; }
      if (path === `/reminders/schedules/${scheduleId}/state`) { schedules = [row(schedules[0].revision + 1, extras.body.state)]; return { item: schedules[0] }; }
      if (path === `/reminders/schedules/${scheduleId}/ack`) { inbox = inbox.map(value => ({ ...value, acknowledged_at: '2026-10-04T16:01:00.000Z' })); return { item: row(3, 'active') }; }
      if (path === '/reminders/check') return { notifications: 0 };
      throw new Error(`Unexpected reminder request ${path}`);
    },
    busy(target, action) { target.disabled = true; const job = Promise.resolve().then(action).finally(() => { target.disabled = false; }); jobs.push(job); return job; },
    confirmAction: async (...values) => { confirmations.push(values); return options.confirm ? await options.confirm(...values) : true; },
  });
  t.after(() => ui.reset());
  const find = fn => { const result = walk(root).find(fn); assert(result); return result; };
  const button = caption => find(node => node.tagName === 'button' && node.textContent === caption), input = id => find(node => node.id === id);
  return { root, ui, calls, jobs, confirmations, button, input, get notice() { return input('reminders-status').textContent; },
    choose() { input(`reminders-task-${taskId}`).checked = true; },
    setSchedules(value) { schedules = value; },
    startClick(caption) { fire(button(caption)); return jobs.at(-1); },
    async click(caption) { fire(button(caption)); await jobs.at(-1)?.catch(() => {}); },
    submit() { fire(find(node => node.tagName === 'form'), 'submit'); return jobs.at(-1)?.catch(() => {}); },
  };
}

test('REMUI01: opening reads private views only; every task starts unchecked and source strings render literally', async t => {
  const h = harness(t); await h.ui.refresh(); assert.deepEqual(h.calls.map(value => value.path).sort(), ['/reminders/context', '/reminders/inbox', '/reminders/schedules', '/reminders/status']);
  assert.equal(h.input(`reminders-task-${taskId}`).checked, false); assert.equal(walk(h.root).some(node => node.tagName === 'script'), false);
  assert.match(h.root.textContent, /<script>SELECTED_TASK_CANARY<\/script>/); assert.match(h.root.textContent, /30 seconds/); assert.match(h.root.textContent, /does not send messages/);
});

test('REMUI02: save requires exact chosen tasks, writes paused configuration once and retains a retry key after failure', async t => {
  let failed = true; const h = harness(t, { schedules: [], handle: (path, extras) => { if (path === '/reminders/schedules' && extras.method === 'POST' && failed) { failed = false; return Promise.reject(new Error('fixture interruption')); } } });
  await h.ui.refresh(); await h.submit(); assert.equal(h.calls.some(call => call.method === 'POST'), false); h.choose(); await h.submit(); const first = h.calls.find(call => call.method === 'POST');
  assert.deepEqual(first.body.task_ids, [taskId]); assert.equal(first.body.due_within_minutes, 1440); assert.equal('state' in first.body, false); assert.match(h.notice, /fixture interruption/);
  await h.submit(); const saves = h.calls.filter(call => call.path === '/reminders/schedules' && call.method === 'POST'); assert.equal(saves.length, 2); assert.equal(saves[0].idempotencyKey, saves[1].idempotencyKey);
  assert.match(h.notice, /saved paused/);
});

test('REMUI03: explicit confirmation is required to activate; cancelling consent keeps the schedule paused', async t => {
  const h = harness(t, { confirm: async () => false }); await h.ui.refresh(); await h.click('Activate local reminders'); assert.equal(h.confirmations.length, 1);
  assert.equal(h.calls.some(call => call.path.endsWith('/state')), false); assert.match(h.confirmations[0][0], /No account, model or external service/);
});

test('REMUI04: fresh exact revision activation, pause and permanent cancellation send narrowly scoped payloads', async t => {
  const h = harness(t); await h.ui.refresh(); await h.click('Activate local reminders');
  assert.deepEqual(h.calls.find(call => call.path.endsWith('/state')).body, { expected_revision: 1, state: 'active', confirmed: true });
  await h.click('Pause local reminders'); assert.deepEqual(h.calls.filter(call => call.path.endsWith('/state'))[1].body, { expected_revision: 2, state: 'paused', confirmed: true });
  await h.click('Cancel this schedule'); assert.match(h.confirmations.at(-1)[0], /permanent/); assert.equal(walk(h.root).some(node => node.tagName === 'button' && node.textContent === 'Activate local reminders'), false);
});

test('REMUI05: refresh while consent is pending rejects the stale schedule revision before posting', async t => {
  const entered = deferred(), released = deferred(); const h = harness(t, { confirm: () => { entered.resolve(); return released.promise; } }); await h.ui.refresh();
  const pending = h.startClick('Activate local reminders'); await entered.promise; h.setSchedules([row(2)]); await h.ui.refresh(); released.resolve(true); await pending;
  assert.equal(h.calls.some(call => call.path.endsWith('/state')), false);
});

test('REMUI06: logout/reset during consent rejects late activation and clears all private task/inbox text', async t => {
  const entered = deferred(), released = deferred(); const h = harness(t, { inbox: [event], confirm: () => { entered.resolve(); return released.promise; } }); await h.ui.refresh();
  const pending = h.startClick('Activate local reminders'); await entered.promise; h.ui.reset(); released.resolve(true); await pending;
  assert.equal(h.calls.some(call => call.path.endsWith('/state')), false); assert.equal(h.root.textContent.includes('SELECTED_TASK_CANARY'), false); assert.equal(h.notice, '');
  assert.equal(h.button('Save paused reminder').disabled, true); assert.equal(h.button('Check selected reminders now').disabled, true);
});

test('REMUI07: reset before busy operation starts prevents a stale manual check, and late read cannot restore private facts', async t => {
  const entered = deferred(), released = deferred(); let delay = false; const h = harness(t, { handle: path => path === '/reminders/context' && delay ? (entered.resolve(), released.promise) : undefined }); await h.ui.refresh();
  const pendingCheck = h.startClick('Check selected reminders now'); h.ui.reset(); await pendingCheck; assert.equal(h.calls.some(call => call.path === '/reminders/check'), false);
  delay = true; const pending = h.ui.refresh(); await entered.promise; h.ui.reset(); released.resolve({ tasks: [task] }); await pending;
  assert.equal(h.root.textContent.includes('SELECTED_TASK_CANARY'), false);
});

test('REMUI08: double activation handlers are coalesced; manual check and acknowledgement never send provider/model fields', async t => {
  const entered = deferred(), released = deferred(); const h = harness(t, { inbox: [event], confirm: () => { entered.resolve(); return released.promise; } }); await h.ui.refresh();
  const pending = h.startClick('Activate local reminders'); h.startClick('Activate local reminders'); await entered.promise; released.resolve(true); await pending;
  assert.equal(h.calls.filter(call => call.path.endsWith('/state')).length, 1); await h.click('Check selected reminders now'); await h.click('Acknowledge this reminder');
  assert.deepEqual(h.calls.find(call => call.path === '/reminders/check').body, { confirmed: true }); assert.deepEqual(h.calls.find(call => call.path.endsWith('/ack')).body, { expected_revision: 2, event_id: eventId });
  assert.match(h.root.textContent, /acknowledged/); for (const call of h.calls.filter(call => call.method === 'POST')) assert.doesNotMatch(JSON.stringify(call.body), /provider|account|model|token|prompt/);
});

test('REMUI09: an older async refresh cannot override a newer schedule state', async t => {
  const entered = deferred(), released = deferred(); let delay = false; const h = harness(t, { handle: path => path === '/reminders/schedules' && delay ? (delay = false, entered.resolve(), released.promise) : undefined }); await h.ui.refresh();
  delay = true; const older = h.ui.refresh(); await entered.promise; h.setSchedules([row(3, 'cancelled')]); await h.ui.refresh(); released.resolve({ items: [row(1, 'paused')] }); await older;
  assert.equal(walk(h.root).some(node => node.tagName === 'button' && node.textContent === 'Activate local reminders'), false); assert.match(h.root.textContent, /cancelled.*revision 3/);
});

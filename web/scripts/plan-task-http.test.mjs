import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';
import { mountPlanTasksUI } from '../apps/local/public/plan-tasks.js';

const API = '/api/local/v1', pins = preview => ({ expected_revision: preview.revision, preview_hash: preview.data.preview_hash });
const accept = (preview, topic = 'intro') => ({ ...pins(preview), topic_id: topic, task_hash: preview.rows.find(row => row.topic_id === topic).task_hash, confirmed: true });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-plan-task-http-')), root = join(parent, 'workspace'); let runtime;
  const unsupported = async () => ({ state: 'unsupported', verification: 'synthetic_plan_tasks_no_native_parser' }), sourceAdapter = { probeSourceCapability: unsupported, probePdfCapability: unsupported, probeOfficeCapability: unsupported,
    describeRoot: async () => { throw new Error('No private discovery'); }, inventorySource: async () => { throw new Error('No private inventory'); }, readSelectedEntry: async () => { throw new Error('No private file read'); } };
  t.after(async () => { await runtime?.close(); rmSync(parent, { recursive: true, force: true }); });
  async function raw(route, body, method = body === undefined ? 'GET' : 'POST', headers = {}) { const response = await fetch(runtime.origin + API + route, { method, headers: { Origin: runtime.origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, cache: response.headers.get('cache-control'), data: await response.json() }; }
  async function pair() { const response = await fetch(runtime.origin + API + '/pair', { method: 'POST', headers: { Origin: runtime.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: runtime.createPairingCode() }) }); assert.equal(response.status, 200); const data = await response.json(), credentials = { Cookie: response.headers.get('set-cookie').split(';')[0], 'X-LearnBridge-Nonce': data.nonce }; return { credentials, call: (route, body, method, headers = {}) => raw(route, body, method, { ...credentials, ...headers }) }; }
  async function restart() { await runtime?.close(); runtime = await startRuntime({ dataRoot: root, port: 0, sourceAdapter, publicJobFetch: async () => { throw new Error('No public provider read'); } }); return pair(); }
  const authority = await restart(); return { root, raw, restart, ...authority, get runtime() { return runtime; } };
}
async function learningPlan(f, { accepted = true } = {}) {
  const exported = { schema_version: 1, institution: { name: 'Synthetic School', origin: 'https://school.fixture.test', timezone: 'America/Toronto' }, account_ref: 'fixture-student', retrieved_at: '2026-10-04T12:00:00.000Z', courses: [{ source_id: 'A', title: 'Algorithms', code: 'SYN101' }], assignments: [], announcements: [], materials: [{ source_id: 'lesson', course_id: 'A', title: 'Base cases', body: 'PRIVATE_PLAN_SOURCE: recursion stops at a base case.' }] };
  const coursePreview = await f.call('/academic/preview', { export: exported, selected_course_ids: ['A'] }); assert.equal(coursePreview.status, 200, JSON.stringify(coursePreview.data)); const imported = await f.call('/academic/library-import', { preview_id: coursePreview.data.preview_id, review_hash: coursePreview.data.refresh.review_hash }); assert.equal(imported.status, 201, JSON.stringify(imported.data));
  const scope = { snapshot_ids: [imported.data.snapshot.id], course_ids: ['A'] }, searched = await f.call('/courses/search', { ...scope, query: 'base case' }); assert.equal(searched.status, 200); const row = searched.data.results[0], citation = { source_id: row.source_id, version_hash: row.version_hash, chunk_id: row.chunk_id };
  const response = await f.call('/learning/sessions', { scope, citations: [citation], topic: 'Recursion', mode: 'hint', academic_policy: { grading: 'graded', ai_rule: 'scaffolding_only' } }); assert.equal(response.status, 201); const session = response.data.item;
  const start = '2026-10-05T13:00:00.000Z', end = '2026-10-05T16:00:00.000Z', created = await f.call(`/learning/sessions/${session.id}/catch-up`, { expected_revision: session.revision, session_hash: session.data.recipe.session_hash,
    topics: [{ id: 'intro', title: 'Review base cases', effort_minutes: 30, source_citations: [citation] }, { id: 'practice', title: 'Practice recursion', effort_minutes: 45, dependency_ids: ['intro'], source_citations: [citation] }], selected_topic_ids: ['intro', 'practice'], exam: { title: 'Synthetic study goal', deadline: { precision: 'date', date: '2026-10-10', original: 'October 10', timezone: 'America/Toronto' } }, planning_input: { now: start, horizonEnd: end, timezone: 'America/Toronto', availability: [{ start, end }] } }); assert.equal(created.status, 201, JSON.stringify(created.data)); let plan = created.data.item;
  if (accepted) { const reviewed = await f.call(`/learning/plans/${plan.id}/accept`, { expected_revision: plan.revision, plan_hash: plan.data.plan.plan_hash, catch_up_hash: plan.data.catch_up.catch_up_hash }); assert.equal(reviewed.status, 200); plan = reviewed.data.item; }
  return { plan, session, snapshot: imported.data.snapshot };
}
async function preview(f, plan, topic_ids = ['intro', 'practice'], key = 'fixture-http-task-preview') { const result = await f.call('/plan-tasks/previews', { plan_ref: { id: plan.id, revision: plan.revision, plan_hash: plan.data.plan.plan_hash, catch_up_hash: plan.data.catch_up.catch_up_hash }, topic_ids }, 'POST', { 'Idempotency-Key': key }); assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data.preview; }
async function unrelated(f) { return { documents: (await f.call('/documents')).data.items, grants: (await f.call('/agent-grants')).data.items, checkpoints: (await f.call('/learning/checkpoints')).data.items, sources: (await f.call('/sources')).data.items }; }

test('PTH01: actual reviewed course→accepted learning plan→private task preview→one separately accepted task enters Today and preserves source/date precision', async t => {
  const f = await fixture(t); await f.call('/documents', { title: 'Unrelated private note', content: 'PRIVATE_UNRELATED_HANDOFF' }); const { plan } = await learningPlan(f), before = await unrelated(f), item = await preview(f, plan); assert.equal((await f.call('/tasks')).data.items.length, 0);
  assert.equal((await f.call('/plans')).data.items.some(row => row.id === item.id), false); const result = await f.call(`/plan-tasks/previews/${item.id}/accept`, accept(item)); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.task_effects, 1); assert.equal((await f.call('/tasks')).data.items.length, 1);
  const task = result.data.task; assert.deepEqual(task.deadline, { precision: 'date', date: '2026-10-10', original: 'October 10', timezone: 'America/Toronto' }); const today = await f.call('/today'); assert.equal(JSON.stringify(today.data).includes(task.id), true); assert.equal(task.status, 'pending'); assert.equal(task.effort_minutes, 30); assert.deepEqual(await unrelated(f), before);
  const retry = await f.call(`/plan-tasks/previews/${item.id}/accept`, accept(item)); assert.equal(retry.status, 200); assert.equal(retry.data.task_effects, 0); assert.equal(retry.data.task.id, task.id); assert.equal((await f.call('/tasks')).data.items.length, 1); assert.equal((await f.call('/plan-tasks/state')).cache, 'private, no-store');
});

test('PTH02: real cookie/nonce/Origin/query/method/ID/input and explicit confirmation boundaries deny task effects', async t => {
  const f = await fixture(t), { plan } = await learningPlan(f), item = await preview(f, plan);
  assert.equal((await f.raw('/plan-tasks/state')).status, 401); assert.equal((await f.call('/plan-tasks/state', undefined, 'GET', { 'X-LearnBridge-Nonce': 'forged' })).status, 403); assert.equal((await f.call('/plan-tasks/state?token=PRIVATE_QUERY')).status, 400);
  assert.equal((await f.call(`/plan-tasks/previews/${item.id}/accept`, accept(item), 'POST', { Origin: 'https://hostile.invalid' })).status, 403);
  for (const patch of [{ confirmed: false }, { task_hash: 'f'.repeat(64) }, { expected_revision: 999 }, { topic_id: 'missing' }, { automatic_acceptance: true }]) assert.ok((await f.call(`/plan-tasks/previews/${item.id}/accept`, { ...accept(item), ...patch })).status >= 400);
  for (const route of ['/plan-tasks/state', `/plan-tasks/plans/${plan.id}`, `/plan-tasks/previews/${item.id}/accept`]) assert.equal((await f.call(route, {}, 'PUT')).status, 400);
  assert.equal((await f.call('/plan-tasks/plans/zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz')).status, 404); assert.equal((await f.call('/plan-tasks/send', {})).status, 404); assert.equal((await f.call('/plan-tasks/provider-refresh', {})).status, 404); assert.equal((await f.call('/tasks')).data.items.length, 0);
});

test('PTH03: HTTP restart, source forgetting and exact preview deletion keep accepted tasks/receipts without another task', async t => {
  const f = await fixture(t), { plan, session } = await learningPlan(f), item = await preview(f, plan), request = accept(item), result = await f.call(`/plan-tasks/previews/${item.id}/accept`, request), old = f.credentials;
  f.call = (await f.restart()).call; assert.equal((await f.raw('/plan-tasks/state', undefined, 'GET', old)).status, 401); const retry = await f.call(`/plan-tasks/previews/${item.id}/accept`, request); assert.equal(retry.status, 200); assert.equal(retry.data.task.id, result.data.task.id); assert.equal((await f.call('/tasks')).data.items.length, 1);
  const current = retry.data.preview; assert.equal((await f.call(`/learning/sessions/${session.id}`, { expected_revision: session.revision }, 'DELETE')).status, 200); const stale = await f.call(`/plan-tasks/previews/${item.id}`); assert.equal(stale.data.preview.stale, true); assert.ok((await f.call(`/plan-tasks/previews/${item.id}/accept`, accept(current, 'practice'))).status >= 400);
  const forgotten = await f.call(`/plan-tasks/previews/${item.id}`, pins(current), 'DELETE'); assert.equal(forgotten.status, 200); assert.match(forgotten.data.retention, /Created tasks and independent/); assert.equal((await f.call('/tasks')).data.items.length, 1); assert.equal((await f.call(`/plan-tasks/previews/${item.id}`)).status, 403);
});

class Node {
  constructor(tag, cls = '', text = '') { this.tagName = tag; this.className = cls; this.text = text; this.children = []; this.parent = null; this.listeners = new Map(); this.checked = false; this.hidden = false; this.disabled = false; this.classList = { toggle() {} }; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } } replaceChildren(...children) { this.children = []; this.text = ''; this.append(...children); } setAttribute() {}
  addEventListener(type, callback) { this.listeners.set(type, [...(this.listeners.get(type) || []), callback]); }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); } set textContent(value) { this.replaceChildren(); this.text = String(value); }
}
const walk = node => [node, ...node.children.flatMap(walk)], fire = (node, type = 'click') => { for (const callback of node.listeners.get(type) || []) callback({ preventDefault() {} }); };
async function harness(f, t, intercept, confirmation = true) {
  const root = new Node('section'), requests = [], pending = [], confirmations = [], ui = mountPlanTasksUI({ root, element: (tag, cls, text) => new Node(tag, cls, text), busy(node, callback) { const result = Promise.resolve().then(callback); pending.push(result); return result; },
    request: async (route, options = {}) => { requests.push({ route, ...options }); const result = await f.call(route, options.body, options.method, options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}); if (result.status >= 400) throw new Error(result.data.message || 'HTTP denied'); const altered = intercept?.(route, result.data); return altered === undefined ? result.data : await altered; }, confirmAction: async text => { confirmations.push(text); return confirmation; } });
  t.after(() => ui.reset()); const settle = async () => { for (let index = 0; index < 5; index++) { await Promise.resolve(); await Promise.all(pending.map(item => item.catch(() => {}))); } }, find = text => { const found = walk(root).find(node => node.tagName === 'button' && node.textContent === text); assert.ok(found, text); return found; };
  await ui.refresh(); return { root, ui, requests, confirmations, settle, find, click: async text => { fire(find(text)); await settle(); } };
}

test('PTH04: shipped controller against actual HTTP defaults unchecked, previews without task effects, then explicitly confirms only one task and its prerequisites', async t => {
  const f = await fixture(t); await learningPlan(f); const h = await harness(f, t); assert.deepEqual(h.requests.map(item => item.route), ['/plan-tasks/state']); await h.click('Inspect this accepted plan');
  let checks = walk(h.root).filter(node => node.type === 'checkbox'); assert.equal(checks.length, 2); assert.equal(checks.every(node => !node.checked), true); checks.forEach(node => { node.checked = true; }); fire(walk(h.root).find(node => node.tagName === 'form'), 'submit'); await h.settle(); assert.equal((await f.call('/tasks')).data.items.length, 0);
  assert.equal(h.root.textContent.includes('Choose reviewed plan topics'), false, 'Superseded inspection is cleared when the exact saved preview is shown'); assert.ok(h.root.textContent.includes('Date only: 2026-10-10')); assert.ok(h.root.textContent.includes('prerequisite needs separate task acceptance')); const controls = walk(h.root).filter(node => node.tagName === 'form' && node.children.some(child => child.tagName === 'button' && child.textContent === 'Accept this one study task')); assert.equal(controls.length, 1); assert.equal(walk(controls[0]).find(node => node.type === 'checkbox').checked, false);
  fire(controls[0], 'submit'); await h.settle(); assert.equal(h.requests.some(item => item.route.endsWith('/accept')), false); assert.equal(h.confirmations.length, 0);
  walk(controls[0]).find(node => node.type === 'checkbox').checked = true; fire(controls[0], 'submit'); await h.settle(); assert.equal(h.requests.filter(item => item.route.endsWith('/accept')).length, 1); assert.equal(h.confirmations.length, 1); assert.ok(h.confirmations[0].includes('Review base cases')); assert.equal((await f.call('/tasks')).data.items.length, 1);
  assert.equal(h.root.textContent.includes('Choose reviewed plan topics'), false); assert.ok(h.root.textContent.includes('Existing local prerequisites')); assert.ok(h.root.textContent.includes('1 new task effect')); await h.click('Forget this handoff preview'); assert.equal((await f.call('/tasks')).data.items.length, 1); assert.ok(h.root.textContent.includes('Created tasks and independent'));
});

test('PTH05: cancelled final confirmation, old detached controls and late inspection after reset cannot accept or expose a stale plan', async t => {
  const f = await fixture(t); await learningPlan(f); const h = await harness(f, t, undefined, false); await h.click('Inspect this accepted plan'); walk(h.root).filter(node => node.type === 'checkbox').forEach(node => { node.checked = true; }); fire(walk(h.root).find(node => node.tagName === 'form'), 'submit'); await h.settle();
  const old = walk(h.root).find(node => node.tagName === 'form' && node.children.some(child => child.textContent === 'Accept this one study task')); walk(old).find(node => node.type === 'checkbox').checked = true; fire(old, 'submit'); await h.settle(); assert.equal(h.requests.some(item => item.route.endsWith('/accept')), false); assert.equal((await f.call('/tasks')).data.items.length, 0);
  const before = h.requests.length, forget = h.find('Forget this handoff preview'); h.ui.reset(); fire(old, 'submit'); fire(forget); await h.settle(); assert.equal(h.requests.length, before);
  const started = deferred(), released = deferred(), later = await harness(f, t, (route, data) => { if (route.startsWith('/plan-tasks/plans/')) { started.resolve(); return released.promise.then(() => data); } }); fire(later.find('Inspect this accepted plan')); await started.promise; later.ui.reset(); released.resolve(); await later.settle(); assert.equal(later.root.textContent.includes('Review base cases'), false);
});

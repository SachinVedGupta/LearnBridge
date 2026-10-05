import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'learnbridge-calendar-http-')), runtimes = []; t.after(async () => { for (const runtime of runtimes.reverse()) await runtime.close(); await rm(root, { force: true, recursive: true }); });
  async function start() { const runtime = await startRuntime({ dataRoot: root, port: 0 }); runtimes.push(runtime); return runtime; } return { root, start, runtime: await start() };
}
async function pair(runtime) {
  const response = await fetch(`${runtime.origin}/api/local/v1/pair`, { method: 'POST', headers: { Origin: runtime.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: runtime.createPairingCode() }) }); assert.equal(response.status, 200); return { cookie: response.headers.get('set-cookie').split(';')[0], nonce: (await response.json()).nonce };
}
async function call(runtime, session, path, { method = 'GET', body, origin = runtime.origin, headers = {} } = {}) {
  const response = await fetch(`${runtime.origin}/api/local/v1${path}`, { method, headers: { ...(session ? { Cookie: session.cookie, 'X-LearnBridge-Nonce': session.nonce } : {}), ...(method === 'GET' ? {} : { Origin: origin, 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, cache: response.headers.get('cache-control'), data: await response.json() };
}
async function create(runtime, session, title = 'Synthetic deadline') { const result = await call(runtime, session, '/tasks', { method: 'POST', body: { title, deadline: { precision: 'date', date: '2026-11-01', timezone: 'America/Toronto' }, effort_minutes: 90 } }); assert.equal(result.status, 201); return result.data.task; }
async function preview(runtime, session, task) {
  const result = await call(runtime, session, '/calendar-export/previews', { method: 'POST', body: { mode: 'tasks', task_ids: [task.id] }, headers: { 'Idempotency-Key': 'calendar-http-preview-key' } }); assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data.item;
}
const review = row => ({ expected_revision: row.revision, review_hash: row.data.review_hash, confirmed: true });

test('CEHTTP01: actual paired selected-task preview→exact download→concurrent retry→restart returns one unchanged payload/receipt and no task/calendar actions', async t => {
  const f = await fixture(t); let runtime = f.runtime, session = await pair(runtime); const task = await create(runtime, session), row = await preview(runtime, session, task);
  assert.equal(row.data.state, 'preview'); assert.equal(row.data.receipt, null); assert.equal((await call(runtime, session, '/tasks')).data.items.length, 1);
  const responses = await Promise.all([1, 2].map(() => call(runtime, session, `/calendar-export/previews/${row.id}/download`, { method: 'POST', body: review(row) })));
  for (const result of responses) { assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.item.revision, 2); assert.equal(result.data.provider_writes, 0); assert.equal(result.data.task_writes, 0); assert.equal(result.data.content, row.data.content); assert.equal(result.data.outcome, 'download_payload_prepared'); assert.equal(result.cache, 'private, no-store'); }
  await runtime.close(); runtime = await f.start(); session = await pair(runtime); const repeated = await call(runtime, session, `/calendar-export/previews/${row.id}/download`, { method: 'POST', body: review(row) }); assert.equal(repeated.status, 200); assert.equal(repeated.data.sha256, row.data.sha256); assert.equal(repeated.data.item.revision, 2);
  assert.equal((await call(runtime, session, '/calendar-export/previews')).data.items.length, 1); assert.equal((await call(runtime, session, '/tasks')).data.items.length, 1); assert.equal((await call(runtime, session, '/agent-grants')).data.items.length, 0);
});

test('CEHTTP02: actual accepted workflow study plan exports its saved intervals; changed task revision invalidates download', async t => {
  const f = await fixture(t), runtime = f.runtime, session = await pair(runtime); let task = await create(runtime, session);
  const start = Math.ceil((Date.now() + 120000) / 60000) * 60000, end = start + 3600000, horizonEnd = new Date(end + 3600000).toISOString();
  task = (await call(runtime, session, `/tasks/${task.id}`, { method: 'PATCH', body: { expected_revision: task.revision, deadline: { precision: 'instant', instant: horizonEnd, timezone: 'America/Toronto' } } })).data.task;
  const params = { horizonEnd, timezone: 'America/Toronto', availability: [{ start: new Date(start).toISOString(), end: new Date(end).toISOString() }] };
  const prepared = await call(runtime, session, '/workflows', { method: 'POST', body: { recipe_id: 'plan.today', input: params } }); assert.equal(prepared.status, 201, JSON.stringify(prepared.data)); const run = prepared.data.run; assert(run);
  const executed = await call(runtime, session, `/workflows/${run.id}/execute`, { method: 'POST', body: {} }); assert.equal(executed.status, 200); assert.equal(executed.data.run.state, 'completed');
  const plan = (await call(runtime, session, '/plans')).data.items.find(row => row.data.run_id === run.id); assert(plan); const before = await call(runtime, session, '/calendar-export/previews', { method: 'POST', body: { mode: 'study_plan', plan_id: plan.id, expected_revision: plan.revision, plan_hash: plan.data.plan.plan_hash }, headers: { 'Idempotency-Key': 'calendar-http-before-accept' } }); assert.equal(before.status, 409);
  const accepted = (await call(runtime, session, `/plans/${plan.id}/accept`, { method: 'POST', body: { expected_revision: plan.revision, plan_hash: plan.data.plan.plan_hash } })).data.item;
  // The existing /plans accept controller returns its historic plan key.
  const current = accepted || (await call(runtime, session, '/plans')).data.items.find(row => row.id === plan.id); assert.equal(current.data.state, 'accepted');
  const result = await call(runtime, session, '/calendar-export/previews', { method: 'POST', body: { mode: 'study_plan', plan_id: current.id, expected_revision: current.revision, plan_hash: current.data.plan.plan_hash }, headers: { 'Idempotency-Key': 'calendar-http-saved-plan' } }); assert.equal(result.status, 201, JSON.stringify(result.data)); const row = result.data.item;
  assert.equal(row.data.events[0].start, current.data.plan.blocks[0].start); assert.equal(row.data.events[0].end, current.data.plan.blocks[0].end); assert.equal(row.data.warnings.coverage.unscheduled_minutes, 30); assert.equal((await call(runtime, session, `/calendar-export/previews/${row.id}/download`, { method: 'POST', body: review(row) })).status, 200);
  assert.equal((await call(runtime, session, `/tasks/${task.id}`, { method: 'PATCH', body: { expected_revision: task.revision, title: 'Student changed plan context' } })).status, 200);
  assert.equal((await call(runtime, session, `/calendar-export/previews/${row.id}/download`, { method: 'POST', body: review(row) })).status, 409); assert.equal((await call(runtime, session, '/tasks')).data.items.length, 1);
});

function school(minute = 0) { return { schema_version: 1, institution: { name: 'Synthetic University', origin: 'https://synthetic.example.edu', timezone: 'America/Toronto' }, account_ref: 'fixture', retrieved_at: `2026-10-04T10:${String(minute).padStart(2, '0')}:00.000Z`, courses: [{ source_id: 'A', title: 'Synthetic course' }], assignments: [{ source_id: 'a', course_id: 'A', title: 'Synthetic academic task', due: minute ? '2026-11-03' : '2026-11-01', description: 'PRIVATE_HTTP_SOURCE_BODY_CANARY' }], announcements: [], materials: [] }; }
async function importSchool(runtime, session, minute = 0) {
  const p = await call(runtime, session, '/academic/preview', { method: 'POST', body: { export: school(minute), selected_course_ids: ['A'] } }); assert.equal(p.status, 200); const saved = await call(runtime, session, '/academic/library-import', { method: 'POST', body: { preview_id: p.data.preview_id, review_hash: p.data.refresh.review_hash } }); assert.equal(saved.status, 201); return saved.data.snapshot;
}
test('CEHTTP03: actual academic source refresh invalidates selected accepted-task calendar preview and preserves the task', async t => {
  const f = await fixture(t), runtime = f.runtime, session = await pair(runtime), snapshot = await importSchool(runtime, session), scope = { snapshot_ids: [snapshot.id], course_ids: ['A'] }, items = (await call(runtime, session, '/academic-tasks/inspect', { method: 'POST', body: scope })).data.items;
  const prepared = await call(runtime, session, '/academic-tasks/previews', { method: 'POST', body: { ...scope, assignment_ids: [items[0].source.item_id] }, headers: { 'Idempotency-Key': 'academic-calendar-http-key' } }); assert.equal(prepared.status, 201); const p = prepared.data.item;
  const saved = await call(runtime, session, `/academic-tasks/previews/${p.id}/save`, { method: 'POST', body: { expected_revision: p.revision, review_hash: p.data.review_hash } }); const proposal = saved.data.proposals[0]; const accepted = await call(runtime, session, `/academic-tasks/proposals/${proposal.id}/accept`, { method: 'POST', body: { expected_revision: proposal.revision, payload_hash: proposal.data.payload_hash, confirmed: true } }); assert.equal(accepted.status, 200); const task = (await call(runtime, session, `/tasks/${accepted.data.item.data.task_id}`)).data.task;
  const row = await preview(runtime, session, task); assert.doesNotMatch(JSON.stringify(row), /PRIVATE_HTTP_SOURCE_BODY_CANARY/); await importSchool(runtime, session, 1); const result = await call(runtime, session, `/calendar-export/previews/${row.id}/download`, { method: 'POST', body: review(row) }); assert.equal(result.status, 409); assert.deepEqual((await call(runtime, session, `/tasks/${task.id}`)).data.task, task);
});

test('CEHTTP04: actual session/origin/nonce/query/schema/hash/consent gates reject private or unintended calendar effects', async t => {
  const f = await fixture(t), runtime = f.runtime; assert.equal((await call(runtime, null, '/calendar-export/context')).status, 401); const session = await pair(runtime), task = await create(runtime, session), row = await preview(runtime, session, task);
  assert.equal((await call(runtime, { ...session, nonce: 'forged' }, '/calendar-export/previews')).status, 403); assert.equal((await call(runtime, session, '/calendar-export/previews?token=PRIVATE_QUERY_CANARY')).status, 400);
  assert.equal((await call(runtime, session, `/calendar-export/previews/${row.id}/download`, { method: 'POST', body: review(row), origin: 'https://hostile.invalid' })).status, 403);
  for (const body of [{ ...review(row), review_hash: 'a'.repeat(64) }, { ...review(row), confirmed: false }, { ...review(row), calendar_id: 'real-calendar' }]) assert([400, 403, 409].includes((await call(runtime, session, `/calendar-export/previews/${row.id}/download`, { method: 'POST', body })).status));
  for (const path of ['/calendar-export/send', '/calendar-export/calendar-write', '/calendar-export/provider-refresh']) assert.equal((await call(runtime, session, path, { method: 'POST', body: {} })).status, 404);
  assert.equal((await call(runtime, session, `/calendar-export/previews/${row.id}`)).data.item.revision, 1); assert.equal((await call(runtime, session, '/logout', { method: 'POST', body: {} })).status, 200); assert.equal((await call(runtime, session, '/calendar-export/previews')).status, 401);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';
function exported(minute = 0, patch = {}) {
  return { schema_version: 1, institution: { name: 'Synthetic University', origin: 'https://synthetic.example.edu', timezone: 'America/Toronto' }, account_ref: 'fixture-student', retrieved_at: `2026-10-04T10:${String(minute).padStart(2, '0')}:00.000Z`,
    courses: [{ source_id: 'A', title: 'Synthetic course', code: 'SYN101' }], assignments: [{ source_id: 'a', course_id: 'A', title: 'Synthetic exercise', description: 'PRIVATE_HTTP_SOURCE_CANARY', due: '2026-10-10' }], announcements: [], materials: [], ...patch };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'learnbridge-academic-task-http-')), runtimes = [];
  t.after(async () => { for (const runtime of runtimes.reverse()) await runtime.close(); await rm(root, { recursive: true, force: true }); });
  async function start() { const runtime = await startRuntime({ dataRoot: root, port: 0 }); runtimes.push(runtime); return runtime; }
  return { root, start, runtime: await start() };
}
async function pair(runtime) {
  const response = await fetch(`${runtime.origin}/api/local/v1/pair`, { method: 'POST', headers: { Origin: runtime.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: runtime.createPairingCode() }) }); assert.equal(response.status, 200);
  return { cookie: response.headers.get('set-cookie').split(';')[0], nonce: (await response.json()).nonce };
}
async function call(runtime, session, path, { method = 'GET', body, origin = runtime.origin, headers = {} } = {}) {
  const response = await fetch(`${runtime.origin}/api/local/v1${path}`, { method, headers: { ...(session ? { Cookie: session.cookie, 'X-LearnBridge-Nonce': session.nonce } : {}), ...(method === 'GET' ? {} : { Origin: origin, 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, cache: response.headers.get('cache-control'), data: await response.json() };
}
async function importCourse(runtime, session, raw = exported()) {
  const preview = await call(runtime, session, '/academic/preview', { method: 'POST', body: { export: raw, selected_course_ids: ['A'] } }); assert.equal(preview.status, 200);
  const saved = await call(runtime, session, '/academic/library-import', { method: 'POST', body: { preview_id: preview.data.preview_id, review_hash: preview.data.refresh.review_hash } }); assert.equal(saved.status, 201); return { snapshot_ids: [saved.data.snapshot.id], course_ids: ['A'] };
}
async function draft(runtime, session, scope) {
  const inspected = await call(runtime, session, '/academic-tasks/inspect', { method: 'POST', body: scope }); assert.equal(inspected.status, 200, JSON.stringify(inspected.data));
  const body = { ...scope, assignment_ids: [inspected.data.items[0].source.item_id] }, preview = await call(runtime, session, '/academic-tasks/previews', { method: 'POST', body, headers: { 'Idempotency-Key': 'academic-http-preview-1' } }); assert.equal(preview.status, 201); return preview.data.item;
}
const saveInput = preview => ({ expected_revision: preview.revision, review_hash: preview.data.review_hash });
const reviewInput = proposal => ({ expected_revision: proposal.review_revision, payload_hash: proposal.data.payload_hash, confirmed: true });

test('ATHTTP01: actual HTTP selected import→preview→pending review→separate acceptance and restart produces exactly one local task', async t => {
  const f = await fixture(t); let runtime = f.runtime, session = await pair(runtime); const scope = await importCourse(runtime, session), preview = await draft(runtime, session, scope);
  assert.equal((await call(runtime, session, '/plans')).data.items.length, 0, 'Academic previews must not enter the study-plan dashboard');
  assert.equal((await call(runtime, session, `/plans/${preview.id}/accept`, { method: 'POST', body: { expected_revision: preview.revision, plan_hash: preview.data.review_hash } })).status, 409, 'A different plan category cannot be accepted as a study plan');
  assert.equal((await call(runtime, session, '/tasks')).data.items.length, 0); const saved = await call(runtime, session, `/academic-tasks/previews/${preview.id}/save`, { method: 'POST', body: saveInput(preview) }); assert.equal(saved.status, 200); assert.equal(saved.data.tasks_created, 0);
  const pending = saved.data.proposals[0]; assert.equal((await call(runtime, session, '/tasks')).data.items.length, 0); const accepted = await call(runtime, session, `/academic-tasks/proposals/${pending.id}/accept`, { method: 'POST', body: reviewInput(pending) }); assert.equal(accepted.status, 200);
  const taskId = accepted.data.item.data.task_id; assert.equal((await call(runtime, session, '/tasks')).data.items.length, 1); assert.equal((await call(runtime, session, '/agent-grants')).data.items.length, 0);
  await runtime.close(); runtime = await f.start(); session = await pair(runtime); const retry = await call(runtime, session, `/academic-tasks/proposals/${pending.id}/accept`, { method: 'POST', body: reviewInput(pending) }); assert.equal(retry.status, 200); assert.equal(retry.data.item.data.task_id, taskId);
  assert.equal((await call(runtime, session, '/tasks')).data.items.length, 1); assert.equal((await call(runtime, session, '/academic-tasks/proposals')).cache, 'private, no-store');
  for (const path of ['/academic-tasks/context', '/academic-tasks/previews', '/academic-tasks/proposals']) assert.doesNotMatch(JSON.stringify((await call(runtime, session, path)).data), /PRIVATE_HTTP_SOURCE_CANARY/);
});

test('ATHTTP02: actual source refresh/omission blocks stale pending acceptance and preserves student manual tasks', async t => {
  const f = await fixture(t), runtime = f.runtime, session = await pair(runtime), scope = await importCourse(runtime, session), preview = await draft(runtime, session, scope), pending = (await call(runtime, session, `/academic-tasks/previews/${preview.id}/save`, { method: 'POST', body: saveInput(preview) })).data.proposals[0];
  const manual = (await call(runtime, session, '/tasks', { method: 'POST', body: { title: 'Student manual plan', deadline: { precision: 'date', date: '2026-10-20', timezone: 'America/Toronto' } } })).data.task;
  await importCourse(runtime, session, exported(1, { assignments: [] })); const current = await call(runtime, session, `/academic-tasks/proposals/${pending.id}`); assert.equal(current.data.item.needs_refresh, true);
  const refused = await call(runtime, session, `/academic-tasks/proposals/${pending.id}/accept`, { method: 'POST', body: reviewInput(pending) }); assert.equal(refused.status, 409);
  assert.deepEqual((await call(runtime, session, `/tasks/${manual.id}`)).data.task, manual); assert.equal((await call(runtime, session, '/tasks')).data.items.length, 1);
  assert.equal((await call(runtime, session, `/academic-tasks/proposals/${pending.id}/reject`, { method: 'POST', body: reviewInput(pending) })).status, 200);
});

test('ATHTTP03: actual session/origin/nonce/query/schema/review-hash guards deny unintended academic effects', async t => {
  const f = await fixture(t), runtime = f.runtime; assert.equal((await call(runtime, null, '/academic-tasks/context')).status, 401);
  const session = await pair(runtime), scope = await importCourse(runtime, session), preview = await draft(runtime, session, scope);
  assert.equal((await call(runtime, { ...session, nonce: 'forged' }, '/academic-tasks/previews')).status, 403);
  assert.equal((await call(runtime, session, '/academic-tasks/inspect', { method: 'POST', body: scope, origin: 'https://hostile.invalid' })).status, 403);
  assert.equal((await call(runtime, session, '/academic-tasks/proposals?token=PRIVATE_QUERY_CANARY')).status, 400);
  assert.equal((await call(runtime, session, `/academic-tasks/previews/${preview.id}/save`, { method: 'POST', body: { ...saveInput(preview), review_hash: 'a'.repeat(64) } })).status, 409);
  assert.equal((await call(runtime, session, `/academic-tasks/previews/${preview.id}/save`, { method: 'POST', body: { ...saveInput(preview), auto_accept: true } })).status, 400);
  for (const path of ['/academic-tasks/send', '/academic-tasks/provider-refresh', '/academic-tasks/calendar-write']) assert.equal((await call(runtime, session, path, { method: 'POST', body: {} })).status, 404);
  assert.equal((await call(runtime, session, '/academic-tasks/proposals')).data.items.length, 0); assert.equal((await call(runtime, session, '/tasks')).data.items.length, 0);
  const saved = await call(runtime, session, `/academic-tasks/previews/${preview.id}/save`, { method: 'POST', body: saveInput(preview) }), pending = saved.data.proposals[0];
  assert.equal((await call(runtime, session, `/academic-tasks/proposals/${pending.id}/accept`, { method: 'POST', body: { ...reviewInput(pending), confirmed: false } })).status, 403);
  assert.equal((await call(runtime, session, '/logout', { method: 'POST', body: {} })).status, 200); assert.equal((await call(runtime, session, '/academic-tasks/proposals')).status, 401);
});

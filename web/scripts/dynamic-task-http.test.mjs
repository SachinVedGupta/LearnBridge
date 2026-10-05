import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';
const sha = text => createHash('sha256').update(text).digest('hex');
async function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-dynamic-http-')); let runtime, auth, executions = 0;
  const body = 'Please review your timetable by 2026-10-09. It needs a careful source-backed check.', output = `BEGIN_LEARNBRIDGE_TASKS_V1\n${JSON.stringify({ tasks: [{ title: 'Review timetable', quote: 'Please review your timetable by 2026-10-09.', deadline: '2026-10-09' }] })}\nEND_LEARNBRIDGE_TASKS_V1`;
  const hostAdapter = { enabled: true, execute: async input => { executions++; input.onProgress({ phase: 'tool', tool: 'learnbridge_context', state: 'running' }); await delay(5); input.onProgress({ phase: 'tool', tool: 'learnbridge_context', state: 'finished' }); return { state: 'completed', complete: true, text: output, output_sha256: sha(output), tool_receipts: [{ tool: 'learnbridge_context', status: 'completed', failed: false, result_hash: sha('fixture-selected-context'), origin: 'model' }], host_version: 'fixture-host' }; } };
  async function start() {
    runtime = await startRuntime({ dataRoot: join(parent, 'private'), port: 0, hostAdapter });
    const pair = await fetch(`${runtime.origin}/api/local/v1/pair`, { method: 'POST', headers: { Origin: runtime.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: runtime.createPairingCode() }) });
    auth = { cookie: pair.headers.get('set-cookie').split(';')[0], nonce: (await pair.json()).nonce };
  }
  await start(); t.after(async () => { await runtime.close(); rmSync(parent, { recursive: true, force: true }); });
  return { body, get runtime() { return runtime; }, get executions() { return executions; }, async restart() { await runtime.close(); await start(); },
    async call(path, body, extras = {}) { const response = await fetch(`${runtime.origin}/api/local/v1${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: runtime.origin, Cookie: auth.cookie, 'X-LearnBridge-Nonce': auth.nonce, 'Content-Type': 'application/json', 'Idempotency-Key': `dynamic-http-${sha(JSON.stringify({ path, body })).slice(0, 40)}`, ...extras }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json() }; },
    taskRows() { const db = new Database(join(parent, 'private', 'learnbridge.sqlite'), { readonly: true }); try { return db.prepare("SELECT json FROM records WHERE kind='task' AND deleted_at IS NULL").all().map(row => JSON.parse(row.json)); } finally { db.close(); } },
  };
}
test('DTH01: real paired HTTP source policy -> ordinary-message AI extraction -> pending review -> exact accepted task survives restart with independent SQLite readback', async t => {
  const f = await fixture(t), before = await f.call('/dynamic-tasks/list'); assert.equal(before.data.config.data.enabled, false);
  const imported = await f.call('/productivity/updates', { provider: 'gmail', account: 'selected-synthetic@example.com', source_id: 'ordinary-http-message', subject: 'Timetable review', body: f.body, section: 'communications', observed_at: new Date(Date.now() - 60000).toISOString() }); assert.equal(imported.status, 201);
  const source = imported.data.item; const policy = await f.call('/dynamic-tasks/config', { expected_revision: 0, selections: [{ kind: 'update', id: source.id, course_ids: [] }], auto_create: true, auto_complete: true, enabled: true, confirmed: true }); assert.equal(policy.status, 200);
  assert.equal((await f.call('/dynamic-tasks/refresh', {})).data.tasks_created, 0); assert.equal(f.taskRows().length, 0);
  const context = await f.call('/dynamic-task-ai/context'), metadata = context.data.sources[0], input = { source_id: metadata.id, source_revision: metadata.revision, source_hash: metadata.source_hash };
  const preview = await f.call('/dynamic-task-ai/preview', input); assert.equal(preview.status, 200); assert.equal(preview.data.body, f.body); assert.equal((await f.call('/agent-grants')).data.items.length, 0);
  const started = await f.call('/dynamic-task-ai/extractions', { ...input, review_hash: preview.data.review_hash, confirmed: true }); assert.equal(started.status, 202);
  let ready; for (let index = 0; index < 50; index++) { ready = (await f.call(`/dynamic-task-ai/extractions/${started.data.item.id}`)).data.item; if (ready.data.state === 'ready_to_review') break; await delay(5); }
  assert.equal(ready.data.state, 'ready_to_review'); assert.equal(ready.data.progress.length, 2); assert.equal(f.executions, 1);
  const collected = await f.call(`/dynamic-task-ai/extractions/${ready.id}/collect`, {}); assert.equal(collected.status, 200); assert.equal(collected.data.tasks_created, 0); assert.equal(f.taskRows().length, 0);
  const pending = collected.data.proposals[0]; assert.equal(pending.data.observation.evidence, 'Please review your timetable by 2026-10-09.');
  const accepted = await f.call(`/dynamic-tasks/items/${pending.id}/accept`, { expected_revision: pending.revision, review_hash: pending.review_hash, confirmed: true, existing_task_id: null }); assert.equal(accepted.status, 200);
  assert.equal(f.taskRows().length, 1); assert.equal(f.taskRows()[0].id, accepted.data.item.data.task_id); assert.equal(f.taskRows()[0].status, 'pending'); assert.equal(f.taskRows()[0].deadline.date, '2026-10-09');
  await f.restart(); const list = await f.call('/dynamic-tasks/list'); assert.equal(list.data.tasks.length, 1); assert.equal(list.data.observations[0].data.task_id, f.taskRows()[0].id); assert.equal(f.executions, 1);
  const asset = await fetch(`${f.runtime.origin}/dynamic-tasks.js`); assert.equal(asset.status, 200); assert.match(await asset.text(), /mountDynamicTasksUI/);
});
test('DTH02: HTTP pairing, exact origin/nonce/no-query/private-body and provider-command gates block task or grant mutation', async t => {
  const f = await fixture(t); assert.equal((await f.call('/dynamic-tasks/list', undefined, { Cookie: '' })).status, 401); assert.equal((await f.call('/dynamic-task-ai/context', undefined, { 'X-LearnBridge-Nonce': 'wrong' })).status, 403);
  assert.equal((await f.call('/dynamic-tasks/refresh', {}, { Origin: 'https://hostile.invalid' })).status, 403); assert.equal((await f.call('/dynamic-task-ai/context?account=other')).status, 400);
  assert.equal((await f.call('/dynamic-tasks/refresh', { credentials: 'never-accepted' })).status, 400);
  for (const route of ['/dynamic-tasks/send', '/dynamic-task-ai/send', '/dynamic-tasks/provider-refresh', '/dynamic-task-ai/auth']) assert.equal((await f.call(route, {})).status, 404);
  assert.equal(f.taskRows().length, 0); assert.equal((await f.call('/agent-grants')).data.items.length, 0); assert.equal(f.executions, 0);
});

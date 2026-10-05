import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';
const sha = text => createHash('sha256').update(text).digest('hex');

test('paired Get started → background progress → exact reviewed done persists; cross-session, origin and nonce guard every step', async t => {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-task-session-http-')); let runtime;
  let calls = 0;
  const adapter = { enabled: true, execute: async input => { calls++; input.onProgress({ phase: 'tool', tool: 'learnbridge_context', state: 'running' }); await delay(25); input.onProgress({ phase: 'tool', tool: 'learnbridge_context', state: 'finished' }); const text = 'Synthetic ready-to-review draft.'; return { state: 'completed', complete: true, text, output_sha256: sha(text), tool_receipts: [{ tool: 'learnbridge_context', status: 'completed', failed: false, result_hash: sha('fixture') }], host_version: '0.154.0' }; } };
  runtime = await startRuntime({ dataRoot: join(parent, 'private'), port: 0, hostAdapter: adapter });
  t.after(async () => { await runtime.close(); rmSync(parent, { recursive: true, force: true }); });
  async function pair() { const response = await fetch(`${runtime.origin}/api/local/v1/pair`, { method: 'POST', headers: { Origin: runtime.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: runtime.createPairingCode() }) }); return { cookie: response.headers.get('set-cookie').split(';')[0], nonce: (await response.json()).nonce }; }
  let auth = await pair();
  async function call(path, body, extras = {}) { const response = await fetch(`${runtime.origin}/api/local/v1${path}`, { method: body ? 'POST' : 'GET', headers: { Origin: runtime.origin, Cookie: auth.cookie, 'X-LearnBridge-Nonce': auth.nonce, 'Content-Type': 'application/json', 'Idempotency-Key': `http-task-${sha(JSON.stringify(body ?? path)).slice(0,32)}`, ...extras }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, data: await response.json() }; }
  const task = (await call('/tasks', { title: 'Review synthetic draft' })).data.task;
  const input = { task_id: task.id, expected_revision: 1, documents: [], instructions: 'Get started and produce a useful draft.', confirmed: true };
  assert.equal((await call('/task-sessions', input, { Origin: 'https://hostile.invalid' })).status, 403);
  assert.equal((await call('/task-sessions', input, { 'X-LearnBridge-Nonce': 'wrong' })).status, 403);
  assert.equal((await call('/task-sessions', { ...input, credentials: 'never' })).status, 400);
  assert.equal((await call('/task-sessions', input, { Cookie: '' })).status, 401);
  const start = await call('/task-sessions', input); assert.equal(start.status, 202); assert.equal(start.data.item.data.task_pin.id, task.id);
  assert.equal((await call('/task-sessions', input)).data.item.id, start.data.item.id);
  let ready;
  for (let n = 0; n < 100; n++) { ready = (await call(`/task-sessions/${start.data.item.id}`)).data.item; if (ready.data.state === 'ready_for_review') break; await delay(5); }
  assert.equal(ready.data.state, 'ready_for_review'); assert.equal(ready.data.progress.length, 2); assert.equal(calls, 1);
  const completion = { expected_revision: ready.revision, turn_revision: ready.data.turn_revision, task_revision: 1, evidence_note: 'I checked the draft against the requested task.', confirmed: true };
  const done = await call(`/task-sessions/${ready.id}/complete`, completion); assert.equal(done.status, 200); assert.equal(done.data.item.data.state, 'done');
  assert.equal((await call(`/tasks/${task.id}`)).data.task.status, 'completed');
  await runtime.close(); runtime = await startRuntime({ dataRoot: join(parent, 'private'), port: 0, hostAdapter: adapter }); auth = await pair();
  assert.equal((await call(`/task-sessions/${ready.id}`)).data.item.data.completion.evidence_note, completion.evidence_note); assert.equal(calls, 1);
});

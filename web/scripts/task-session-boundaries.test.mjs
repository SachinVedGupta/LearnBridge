import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { createHostTurns } from '../apps/local-runtime/src/host-turns.mjs';
import { createTaskSessionService } from '../apps/local-runtime/src/task-session-service.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const answer = text => ({ state: 'completed', complete: true, text, output_sha256: sha(text), tool_receipts: [{ tool: 'learnbridge_context', status: 'completed', failed: false, result_hash: sha('synthetic_executor_only') }], host_version: 'fixture-only' });
function fixture(t, execute = async () => answer('A draft for review.')) {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-task-session-boundary-')), store = LocalStore.open({ root: join(parent, 'workspace') });
  const task = store.createTask({ title: 'Synthetic reviewed task' }), doc = store.createDocument({ title: 'Synthetic selected note', text: 'Selected facts.', kind: 'study' });
  const host = createHostTurns({ store, enabled: true, execute }), service = createTaskSessionService({ store, hostTurns: host });
  t.after(async () => { await host.drain(); store.close(); rmSync(parent, { recursive: true, force: true }); });
  return { store, task, doc, host, service, input: { task_id: task.id, expected_revision: 1, documents: [{ id: doc.document.id, revision: 1, sha256: doc.sha256 }], instructions: 'Prepare a useful draft.', confirmed: true } };
}
const options = key => ({ idempotencyKey: key, authorize: () => true });
async function ready(f, id) { for (let index = 0; index < 30; index++) { const row = f.service.get(id); if (!['queued', 'working'].includes(row.data.state)) return row; await new Promise(resolve => setImmediate(resolve)); } throw new Error('Synthetic host did not settle'); }

test('task session plain and nested document accessors are refused before invocation or creation', async t => {
  const f = fixture(t); let invoked = 0;
  const input = { ...f.input }; Object.defineProperty(input, 'task_id', { enumerable: true, get() { invoked++; return f.task.id; } });
  await assert.rejects(f.service.start(input, options('boundary-top-getter-1')), { code: 'INVALID_INPUT' }); assert.equal(invoked, 0);
  const pin = { ...f.input.documents[0] }; Object.defineProperty(pin, 'id', { enumerable: true, get() { invoked++; return f.doc.document.id; } });
  await assert.rejects(f.service.start({ ...f.input, documents: [pin] }, options('boundary-nested-getter-1')), { code: 'INVALID_INPUT' }); assert.equal(invoked, 0);
  assert.equal(f.host.list().length, 0); assert.equal(f.store.listAgentGrants().length, 0); assert.equal(f.service.list().length, 0);
});

test('UTF-8 follow-up excerpts stay below actual 16000-byte host boundary and preserve a distinct current task turn', async t => {
  const prompts = [], longAnswer = '学生😀'.repeat(2200), f = fixture(t, async input => { prompts.push(input.prompt); return answer(longAnswer); });
  const first = await f.service.start(f.input, options('boundary-unicode-turn-1')); assert.equal((await ready(f, first.id)).data.state, 'ready_for_review');
  const second = await f.service.start({ ...f.input, instructions: '界'.repeat(1300), previous_session_id: first.id }, options('boundary-unicode-turn-2')); const current = await ready(f, second.id);
  assert.equal(current.data.state, 'ready_for_review'); assert.equal(prompts.length, 2); assert.ok(Buffer.byteLength(prompts[1]) <= 16000); assert.match(prompts[1], /学生/); assert.equal(current.data.previous_session_id, first.id); assert.equal(f.store.getTask(f.task.id).status, 'pending');
});

test('completion replay must match original task/turn/session review and never completes a later changed task', async t => {
  const f = fixture(t), first = await f.service.start(f.input, options('boundary-completion-turn-1')), shown = await ready(f, first.id);
  const review = { expected_revision: shown.revision, turn_revision: shown.data.turn_revision, task_revision: f.task.revision, evidence_note: 'I reviewed this exact result.', confirmed: true };
  const done = f.service.complete(first.id, review); assert.equal(done.data.state, 'done'); assert.equal(f.service.complete(first.id, review).data.state, 'done');
  for (const key of ['expected_revision', 'turn_revision', 'task_revision']) assert.throws(() => f.service.complete(first.id, { ...review, [key]: review[key] + 100 }), { code: 'REVISION_CONFLICT' });
  const changed = f.store.updateTask(f.task.id, { status: 'pending', title: 'More work was added after the original review' }, f.store.getTask(f.task.id).revision);
  const repeat = f.service.complete(first.id, review); assert.equal(repeat.data.state, 'needs_refresh'); assert.equal(f.store.getTask(f.task.id).status, 'pending'); assert.equal(f.store.getTask(f.task.id).revision, changed.revision);
  assert.throws(() => f.service.complete(first.id, { ...review, task_revision: changed.revision }), { code: 'REVISION_CONFLICT' });
  let invoked = 0; const forged = { ...review }; Object.defineProperty(forged, 'evidence_note', { enumerable: true, get() { invoked++; return review.evidence_note; } }); assert.throws(() => f.service.complete(first.id, forged), { code: 'INVALID_INPUT' }); assert.equal(invoked, 0);
});

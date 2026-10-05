import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { createStudentWorkspace } from '../apps/local-runtime/src/student-workspace.mjs';
import { createProductivityWorkspace } from '../apps/local-runtime/src/productivity-service.mjs';
import { createHostTurns } from '../apps/local-runtime/src/host-turns.mjs';
import { createDynamicTaskService } from '../apps/local-runtime/src/dynamic-task-service.mjs';
import { createDynamicTaskAIService, parseDynamicTaskCandidates } from '../apps/local-runtime/src/dynamic-task-ai-service.mjs';
import { lifeHash } from '../apps/local-runtime/src/life.mjs';
const sha = text => createHash('sha256').update(text).digest('hex');
const body = 'Please book your advising appointment by 2026-10-09. We also need you to review your timetable. There is no form submission here.';
const candidate = { title: 'Book advising appointment', quote: 'Please book your advising appointment by 2026-10-09.', deadline: '2026-10-09' };
const block = tasks => `BEGIN_LEARNBRIDGE_TASKS_V1\n${JSON.stringify({ tasks })}\nEND_LEARNBRIDGE_TASKS_V1`;
const result = text => ({ state: 'completed', complete: true, text, output_sha256: sha(text), tool_receipts: [{ tool: 'learnbridge_context', status: 'completed', failed: false, result_hash: 'a'.repeat(64), origin: 'model' }], host_version: 'fixture-host' });
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'learnbridge-dynamic-ai-')), store = LocalStore.open({ root, timezone: 'UTC' }), productivity = createProductivityWorkspace(store), seen = []; let executions = 0;
  const update = productivity.importUpdate({ provider: 'gmail', account: 'selected-fixture@example.com', source_id: 'ordinary-message-1', subject: 'Advising', body: options.body ?? body, section: 'communications', observed_at: '2026-10-05T10:00:00.000Z' }, { idempotencyKey: randomUUID() });
  productivity.importUpdate({ provider: 'gmail', account: 'not-selected@example.com', source_id: 'ordinary-message-2', subject: 'Unselected', body: 'PRIVATE_UNSELECTED_AI_CANARY', section: 'communications', observed_at: '2026-10-05T10:00:00.000Z' }, { idempotencyKey: randomUUID() });
  const dynamicTasks = createDynamicTaskService({ store, studentWorkspace: createStudentWorkspace(store), clock: () => '2026-10-05T16:00:00.000Z' });
  dynamicTasks.configure({ expected_revision: 0, selections: [{ kind: 'update', id: update.id, course_ids: [] }], auto_create: options.auto_create ?? false, auto_complete: true, enabled: true, confirmed: true });
  const hostTurns = createHostTurns({ store, enabled: true, execute: async args => { executions++; const context = store.agentContext({ destination: 'codex', grant_id: args.grantId, max_bytes: 32000 }); seen.push(context); if (options.execute) return options.execute(args, { store, context, productivity, update }); return result(options.output ?? block([candidate])); } });
  const service = createDynamicTaskAIService({ store, dynamicTasks, hostTurns });
  t.after(async () => { await hostTurns.drain(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, productivity, update, dynamicTasks, hostTurns, service, seen, get executions() { return executions; },
    preview() { return service.preview({ source_id: update.id, source_revision: update.revision, source_hash: lifeHash(update.data.update) }); },
    async start(preview = this.preview(), inputPatch = {}, key = randomUUID()) { return service.start({ source_id: preview.source_pin.id, source_revision: preview.source_pin.revision, source_hash: preview.source_pin.hash, review_hash: preview.review_hash, confirmed: true, ...inputPatch }, { idempotencyKey: key, authorize: () => true }); },
    async settle() { for (let attempt = 0; attempt < 100 && hostTurns.list().some(turn => ['queued', 'running'].includes(turn.data.state)); attempt++) await new Promise(resolve => setImmediate(resolve)); },
    changeBody(text) { const { acquisition, ...raw } = update.data.update; return productivity.importUpdate({ ...raw, body: text, expected_revision: store.getWorkspaceRecord(update.id).revision }, { idempotencyKey: randomUUID() }); },
  };
}

test('DTAI01: selected exact source preview has complete body/account/version but no sharing grant, note or model call until exact confirmation', async t => {
  const f = fixture(t), before = f.store.listDocuments().length, preview = f.preview(); assert.equal(preview.body, body); assert.equal(preview.account, 'selected-fixture@example.com'); assert.equal(preview.source_pin.revision, f.update.revision);
  assert.doesNotMatch(JSON.stringify(preview), /PRIVATE_UNSELECTED_AI_CANARY/); assert.equal(f.store.listDocuments().length, before); assert.equal(f.store.listAgentGrants().length, 0); assert.equal(f.executions, 0);
  await assert.rejects(f.start(preview, { confirmed: false }), { code: 'CONSENT_REQUIRED' }); assert.equal(f.store.listDocuments().length, before); assert.equal(f.store.listAgentGrants().length, 0);
});
test('DTAI02: actual host orchestration sees only the exact selected source copy and parsed suggestions stay pending even when deterministic auto-add is enabled', async t => {
  const f = fixture(t, { auto_create: true }), preview = f.preview(), started = await f.start(preview); await f.settle(); assert.equal(f.executions, 1);
  assert.equal(f.seen[0].documents.length, 1); assert.equal(f.seen[0].documents[0].text, preview.context_text); assert.equal(f.seen[0].tasks.length, 0); assert.doesNotMatch(JSON.stringify(f.seen), /PRIVATE_UNSELECTED_AI_CANARY/);
  const collected = f.service.collect(started.id); assert.equal(collected.proposals.length, 1); assert.equal(collected.tasks_created, 0); assert.equal(f.store.listTasks().length, 0); f.dynamicTasks.refresh(); assert.equal(f.store.listTasks().length, 0);
  const pending = collected.proposals[0]; assert.equal(pending.source_current, true); assert.equal(pending.data.observation.task.deadline.date, '2026-10-09'); assert.equal(pending.data.observation.evidence, candidate.quote);
  const accepted = f.dynamicTasks.accept(pending.id, { expected_revision: pending.revision, review_hash: pending.review_hash, confirmed: true, existing_task_id: null }); assert.equal(f.store.listTasks().length, 1); assert.equal(accepted.task.status, 'pending');
  assert.equal(f.service.collect(started.id).proposals[0].id, pending.id); assert.equal(f.store.getWorkspaceRecord(f.update.id).revision, 1);
});
test('DTAI03: duplicate exact start reuses one extraction/note/grant/model turn, while changed payload under the same key fails', async t => {
  const f = fixture(t), preview = f.preview(), key = randomUUID(), first = await f.start(preview, {}, key), second = await f.start(preview, {}, key); await f.settle();
  assert.equal(first.id, second.id); assert.equal(f.executions, 1); assert.equal(f.store.listDocuments().length, 1); assert.equal(f.store.listAgentGrants().length, 1);
  await assert.rejects(f.start(preview, { review_hash: 'a'.repeat(64) }, key), { code: 'REVISION_CONFLICT' });
});
test('DTAI04: invented evidence or date, duplicate quote, extra completion field, more than 3 tasks and malformed/duplicate blocks never publish candidates', async t => {
  const outputs = [block([{ ...candidate, quote: 'UNSUPPORTED invented quote' }]), block([{ ...candidate, deadline: '2026-10-10' }]), block([candidate, candidate]),
    block([{ ...candidate, completed: true }]), block(Array(4).fill(candidate)), 'No supported output', `${block([candidate])}\n${block([candidate])}`];
  for (const output of outputs) { const f = fixture(t, { output }), started = await f.start(); await f.settle(); assert.throws(() => f.service.collect(started.id)); assert.equal(f.dynamicTasks.list().observations.length, 0); assert.equal(f.store.listTasks().length, 0); }
});
test('DTAI05: dates from relative phrases remain unknown; empty extraction is a valid observation and creates nothing', async t => {
  const quote = 'Review your timetable next week.'; assert.deepEqual(parseDynamicTaskCandidates(block([{ title: 'Review timetable', quote, deadline: null }]), quote), [{ title: 'Review timetable', quote, deadline: null }]);
  assert.throws(() => parseDynamicTaskCandidates(block([{ title: 'Review timetable', quote, deadline: '2026-10-12' }]), quote), { code: 'SCOPE_DENIED' });
  const f = fixture(t, { output: block([]) }), started = await f.start(); await f.settle(); assert.equal(f.service.collect(started.id).proposals.length, 0); assert.equal(f.store.listTasks().length, 0);
});
test('DTAI06: source mutation before completed answer is authorized withholds result and blocks task creation', async t => {
  const f = fixture(t, { execute: async (args, value) => { const { acquisition, ...raw } = value.update.data.update; value.productivity.importUpdate({ ...raw, body: 'Different current source', expected_revision: 1 }, { idempotencyKey: randomUUID() }); return result(block([candidate])); } });
  const started = await f.start(); await f.settle(); assert.equal(f.hostTurns.list()[0].data.state, 'withheld'); assert.equal(f.service.get(started.id).data.state, 'needs_refresh'); assert.equal(f.service.get(started.id).data.result, ''); assert.throws(() => f.service.collect(started.id), { code: 'REVISION_CONFLICT' }); assert.equal(f.dynamicTasks.list().observations.length, 0);
});
test('DTAI07: changed source after parsing invalidates pending AI acceptance and preserves an accepted task without source completion inference', async t => {
  const f = fixture(t), started = await f.start(); await f.settle(); const pending = f.service.collect(started.id).proposals[0];
  f.changeBody('The current message has different wording and [x] completed marks.'); assert.equal(f.dynamicTasks.getItem(pending.id).source_current, false);
  assert.throws(() => f.dynamicTasks.accept(pending.id, { expected_revision: pending.revision, review_hash: pending.review_hash, confirmed: true, existing_task_id: null }), { code: 'REVISION_CONFLICT' }); f.dynamicTasks.refresh(); assert.equal(f.store.listTasks().length, 0);
});
test('DTAI08: unknown host outcome is explicit and no model output fallback, task acceptance or replay is inferred', async t => {
  const f = fixture(t, { execute: async () => { throw new Error('fixture host unavailable'); } }), started = await f.start(); await f.settle();
  assert.equal(f.service.get(started.id).data.state, 'failed'); assert.throws(() => f.service.collect(started.id), { code: 'CONSENT_REQUIRED' }); assert.equal(f.store.listTasks().length, 0); assert.equal(f.executions, 1);
});
test('DTAI09: source preview is never silently truncated; selected body >16KB fails before note/grant creation', async t => {
  const f = fixture(t, { body: 'a'.repeat(17000) }); assert.throws(() => f.preview(), { code: 'BUDGET_EXCEEDED' }); assert.equal(f.store.listDocuments().length, 0); assert.equal(f.store.listAgentGrants().length, 0); assert.equal(f.executions, 0);
});
test('DTAI10: exact source-note mutation or deselection invalidates extraction before collecting private model output', async t => {
  const f = fixture(t), started = await f.start(); await f.settle(); const doc = f.store.getDocument(started.data.document_pin.id); f.store.updateDocument(doc.document.id, { text: 'Student changed this private context copy' }, doc.document.revision);
  assert.equal(f.service.get(started.id).data.result, ''); assert.throws(() => f.service.collect(started.id), { code: 'REVISION_CONFLICT' }); assert.equal(f.store.listTasks().length, 0);
});
test('DTAI11: automatic extraction collection adds only source-pinned pending rows; it never duplicates on another check', async t => {
  const f = fixture(t), started = await f.start(); await f.settle(); assert.deepEqual(f.service.refresh(), { collected: 1, failed: 0 }); assert.equal(f.service.get(started.id).data.state, 'pending_tasks_ready');
  assert.deepEqual(f.service.refresh(), { collected: 0, failed: 0 }); assert.equal(f.dynamicTasks.list().observations.length, 1); assert.equal(f.store.listTasks().length, 0);
});
test('DTAI12: pending candidate publication uses real atomic SQLite batch and recovery never duplicates its first candidate', async t => {
  const other = { title: 'Review timetable', quote: 'We also need you to review your timetable.', deadline: null }, f = fixture(t, { output: block([candidate, other]) }), started = await f.start(); await f.settle();
  const db = new Database(join(f.root, 'learnbridge.sqlite')); db.exec("CREATE TRIGGER dynamic_ai_reject_second BEFORE INSERT ON workspace_records WHEN json_extract(new.json,'$.data.format')='dynamic_task_item_v1' AND json_extract(new.json,'$.data.observation.task.title')='Review timetable' BEGIN SELECT RAISE(ABORT,'fixture atomic failure'); END;"); db.close();
  assert.throws(() => f.service.collect(started.id), { code: 'PROVIDER_FAILURE' }); assert.equal(f.dynamicTasks.list().observations.length, 0);
  const cleanup = new Database(join(f.root, 'learnbridge.sqlite')); cleanup.exec('DROP TRIGGER dynamic_ai_reject_second'); cleanup.close(); assert.equal(f.service.collect(started.id).proposals.length, 2); assert.equal(f.dynamicTasks.list().observations.length, 2); assert.equal(f.store.listTasks().length, 0);
});

test('DTAI13: exact cancellation interrupts the selected extraction and its late answer cannot publish or complete work', async t => {
  let release; const held = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { execute: async () => { await held; return result(block([candidate])); } }), started = await f.start(), running = f.service.get(started.id);
  assert.equal(running.data.state, 'running'); const cancelled = f.service.cancel(started.id, { expected_revision: running.revision, turn_revision: running.data.turn_revision }); assert.equal(cancelled.data.state, 'interrupted');
  release(); await f.settle(); assert.equal(f.service.get(started.id).data.result, ''); assert.throws(() => f.service.collect(started.id), { code: 'CONSENT_REQUIRED' }); assert.equal(f.store.listTasks().length, 0); assert.equal(f.dynamicTasks.list().observations.length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalStore } from '@learnbridge/local-storage';
import { createHostTurns } from '../apps/local-runtime/src/host-turns.mjs';
import { createTaskSessionService } from '../apps/local-runtime/src/task-session-service.mjs';
import { workflowHash } from '../apps/local-runtime/src/workflows.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const output = (text = 'A source-backed draft is ready for review.') => ({ state: 'completed', complete: true, text, output_sha256: sha(text), tool_receipts: [{ tool: 'learnbridge_context', status: 'completed', failed: false, result_hash: sha('fixture') }], host_version: '0.154.0' });
function fixture(t, execute = async () => output()) {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-task-session-')); const root = join(parent, 'private'), store = LocalStore.open({ root });
  const task = store.createTask({ title: 'Prepare synthetic application draft' }), note = store.createDocument({ title: 'Selected facts', text: 'Synthetic confirmed profile facts.', kind: 'study' });
  const host = createHostTurns({ store, enabled: true, execute }), service = createTaskSessionService({ store, hostTurns: host });
  t.after(async () => { await host.drain(); store.close(); rmSync(parent, { recursive: true, force: true }); }); return { root, store, task, note, host, service };
}
const body = f => ({ task_id: f.task.id, expected_revision: f.task.revision, documents: [{ id: f.note.document.id, revision: f.note.document.revision, sha256: f.note.sha256 }], instructions: 'Prepare a factual application draft from my selected note.', confirmed: true });
const options = (key = 'synthetic-task-session-01') => ({ idempotencyKey: key, authorize: () => true });
async function finished(service, id) { for (let n = 0; n < 100; n++) { const row = service.get(id); if (!['queued', 'working'].includes(row.data.state)) return row; await delay(5); } throw Error('host did not finish'); }

test('Get started creates one exact task-linked conversation and repeat click never repeats inference', async t => {
  let calls = 0, captured; const f = fixture(t, async input => { calls++; captured = input; input.onProgress({ phase: 'tool', tool: 'learnbridge_context', state: 'finished' }); return output(); });
  const started = await f.service.start(body(f), options()), ready = await finished(f.service, started.id);
  assert.equal(ready.data.state, 'ready_for_review'); assert.equal(ready.data.progress.length, 1);
  assert.equal(f.store.getTask(f.task.id).status, 'pending'); assert.equal(ready.data.task_pin.id, f.task.id);
  const grant = f.store.getAgentGrant(captured.grantId); assert.deepEqual(grant.pins.tasks.map(pin => pin.id), [f.task.id]); assert.deepEqual(grant.pins.documents.map(pin => pin.id), [f.note.document.id]); assert.deepEqual(grant.pins.source_entries, []);
  assert.match(captured.prompt, /do not invent facts, send, upload or submit/); assert.match(captured.prompt, /never produce a final graded submission/);
  assert.equal((await f.service.start(body(f), options())).id, started.id); assert.equal(calls, 1);
  await assert.rejects(f.service.start({ ...body(f), instructions: 'Changed retry' }, options()), { code: 'REVISION_CONFLICT' });
});

test('stale task and note pins, revoked browser permission and extra execution fields deny starts', async t => {
  const f = fixture(t); const original = body(f);
  await assert.rejects(f.service.start({ ...original, confirmed: false }, options()), { code: 'CONSENT_REQUIRED' });
  await assert.rejects(f.service.start(original, { ...options(), authorize: () => false }), { code: 'CONSENT_REQUIRED' });
  await assert.rejects(f.service.start({ ...original, binary: '/fake' }, options()), { code: 'INVALID_INPUT' });
  await assert.rejects(f.service.start({ ...original, documents: [{ ...original.documents[0], sha256: sha('wrong') }] }, options()), { code: 'REVISION_CONFLICT' });
  f.store.updateTask(f.task.id, { title: 'Changed task' }, f.task.revision);
  await assert.rejects(f.service.start(original, options()), { code: 'REVISION_CONFLICT' }); assert.equal(f.host.list().length, 0);
});

test('a changed task/provenance during execution aborts authority and withholds cached result', async t => {
  let release, sourceVersion = 1;
  const f = fixture(t, () => new Promise(resolve => { release = resolve; }));
  const service = createTaskSessionService({ store: f.store, hostTurns: f.host, provenance: () => ({ sourceVersion }) });
  const row = await service.start(body(f), options()); await delay(5); sourceVersion++;
  release(output('PRIVATE_STALE_RESULT')); const saved = await finished(service, row.id);
  assert.equal(saved.data.state, 'needs_refresh'); assert.equal(saved.data.result, ''); assert.equal(JSON.stringify(service.list()).includes('PRIVATE_STALE_RESULT'), false);
});

test('stop preserves task and withholds a late successful answer', async t => {
  let release, captured; const f = fixture(t, input => { captured = input; return new Promise(resolve => { release = resolve; }); });
  const row = await f.service.start(body(f), options()); await delay(5); const running = f.service.get(row.id);
  f.service.cancel(row.id, { expected_revision: running.revision, turn_revision: running.data.turn_revision }); assert.equal(captured.signal.aborted, true);
  release(output('PRIVATE_STOPPED_RESULT')); await delay(5);
  assert.equal(f.service.get(row.id).data.state, 'interrupted'); assert.equal(f.service.get(row.id).data.result, ''); assert.equal(f.store.getTask(f.task.id).status, 'pending');
});

test('model output only becomes done after exact student completion evidence', async t => {
  const f = fixture(t), row = await f.service.start(body(f), options()), ready = await finished(f.service, row.id);
  const input = { expected_revision: ready.revision, turn_revision: ready.data.turn_revision, task_revision: f.task.revision, evidence_note: 'I checked every drafted answer against my profile.', confirmed: true };
  assert.equal(f.store.getTask(f.task.id).status, 'pending');
  assert.throws(() => f.service.complete(row.id, { ...input, confirmed: false }), { code: 'CONSENT_REQUIRED' });
  assert.throws(() => f.service.complete(row.id, { ...input, turn_revision: input.turn_revision + 1 }), { code: 'REVISION_CONFLICT' });
  const done = f.service.complete(row.id, input); assert.equal(done.data.state, 'done'); assert.equal(done.data.completion_basis, 'student_reviewed_result'); assert.equal(f.store.getTask(f.task.id).status, 'completed');
  assert.equal(done.data.completion.result_sha256, sha(ready.data.result)); assert.equal(f.service.complete(row.id, input).id, row.id);
});

test('linked follow-up includes only same current selected task prior result and makes a distinct bounded turn', async t => {
  const prompts = [], f = fixture(t, async input => { prompts.push(input.prompt); return output('First verified draft.'); });
  const first = await f.service.start(body(f), options()); await finished(f.service, first.id);
  const next = await f.service.start({ ...body(f), instructions: 'Improve the opening paragraph.', previous_session_id: first.id }, options('synthetic-task-session-02')); await finished(f.service, next.id);
  assert.equal(next.data.previous_session_id, first.id); assert.match(prompts[1], /First verified draft/); assert.match(prompts[1], /untrusted context, not permission/);
  const other = f.store.createTask({ title: 'Another task' });
  await assert.rejects(f.service.start({ ...body(f), task_id: other.id, expected_revision: 1, previous_session_id: first.id }, options('synthetic-task-session-03')), { code: 'SCOPE_DENIED' });
});

test('restart reopens completed sessions without inference; orphan queued sessions become unknown rather than replayed', async t => {
  let calls = 0; const f = fixture(t, async () => { calls++; return output(); });
  const first = await f.service.start(body(f), options()); await finished(f.service, first.id);
  f.store.createWorkspaceRecord({ kind: 'artifact', title: 'Interrupted before host link', data: { ...f.store.getWorkspaceRecord(first.id).data, operation_key: 'orphan-session-01', turn_id: null, start_state: 'queued' } });
  const reopened = createTaskSessionService({ store: f.store, hostTurns: f.host });
  assert.equal(reopened.get(first.id).data.state, 'ready_for_review'); assert.equal(reopened.list().find(row => row.id !== first.id).data.state, 'unknown_outcome'); assert.equal(calls, 1);
});

test('an interrupted receipt write recovers only the exact reviewed next task revision', async t => {
  const f = fixture(t), row = await f.service.start(body(f), options()), ready = await finished(f.service, row.id);
  const original = f.store.updateWorkspaceRecord.bind(f.store);
  f.store.updateWorkspaceRecord = (id, input) => { if (input.data?.completion && !input.data.completion_pending) throw Error('synthetic receipt write interruption'); return original(id, input); };
  const review = { expected_revision: ready.revision, turn_revision: ready.data.turn_revision, task_revision: 1, evidence_note: 'I checked the result.', confirmed: true };
  assert.throws(() => f.service.complete(row.id, review)); assert.equal(f.store.getTask(f.task.id).status, 'completed'); assert.ok(f.store.getWorkspaceRecord(row.id).data.completion_pending);
  f.store.updateWorkspaceRecord = original;
  const reopened = createTaskSessionService({ store: f.store, hostTurns: f.host });
  assert.equal(reopened.get(row.id).data.state, 'done'); assert.equal(reopened.get(row.id).data.completion.evidence_note, review.evidence_note);
  assert.equal(reopened.get(row.id).data.completion_pending, null);
  f.store.updateTask(f.task.id, { status: 'pending' }, f.store.getTask(f.task.id).revision);
  assert.equal(reopened.get(row.id).data.state, 'needs_refresh');
});

test('large escaped or combined selected notes are rejected before grant/session/model with no truncation or charge', async t => {
  for (const mode of ['escaped', 'multiple']) {
    let modelCalls = 0; const f = fixture(t, async () => { modelCalls++; return output(); });
    const notes = mode === 'escaped' ? [f.store.createDocument({ title: 'Exact escaped synthetic note', text: '"'.repeat(13000) })] : [1, 2, 3].map(index => f.store.createDocument({ title: `Exact selected note ${index}`, text: 'A'.repeat(8500) }));
    const input = { ...body(f), documents: notes.map(note => ({ id: note.document.id, revision: note.document.revision, sha256: note.sha256 })) }, before = notes.map(note => f.store.getDocument(note.document.id));
    const preview = f.store.previewAgentSelection({ task_ids: [f.task.id], document_ids: notes.map(note => note.document.id), source_entry_ids: [] });assert(preview.serialized_selection_bytes > 24000);assert.deepEqual(Object.keys(preview), ['serialized_selection_bytes']);
    await assert.rejects(f.service.start(input, options(`oversized-selection-${mode}`)), { code: 'BUDGET_EXCEEDED' });
    assert.equal(f.store.listAgentGrants().length, 0);assert.equal(f.service.list().length, 0);assert.equal(f.host.list().length, 0);assert.equal(modelCalls, 0);assert.deepEqual(notes.map(note => f.store.getDocument(note.document.id)), before);assert.equal(f.store.getTask(f.task.id).status, 'pending');
  }
});

test('pure exact selection preview exposes only byte count and a valid escaped UTF-8 selection fits its real first 32000-byte host context read', async t => {
  let observed, calls = 0, f;f = fixture(t, async input => { calls++; observed = f.store.agentContext({ destination: 'codex', grant_id: input.grantId, max_bytes: 32000 });return output(); });
  const literal = '学生😀"\\\n'.repeat(1000), chosen = f.store.createDocument({ title: 'Exact Unicode coaching note', text: literal }), unselected = f.store.createDocument({ title: 'Private unselected note', text: 'UNSELECTED_CONTEXT_PREVIEW_CANARY' }), selection = { task_ids: [f.task.id], document_ids: [chosen.document.id], source_entry_ids: [] };
  const before = { grants: f.store.listAgentGrants(), records: f.store.listWorkspaceRecords(), tasks: f.store.listTasks(), documents: f.store.listDocuments() }, preview = f.store.previewAgentSelection(selection);
  assert(preview.serialized_selection_bytes <= 24000);assert.deepEqual(Object.keys(preview), ['serialized_selection_bytes']);assert.deepEqual({ grants: f.store.listAgentGrants(), records: f.store.listWorkspaceRecords(), tasks: f.store.listTasks(), documents: f.store.listDocuments() }, before);
  const started = await f.service.start({ ...body(f), documents: [{ id: chosen.document.id, revision: chosen.document.revision, sha256: chosen.sha256 }] }, options('valid-bounded-context-selection')), ready = await finished(f.service, started.id);
  assert.equal(ready.data.state, 'ready_for_review');assert.equal(calls, 1);assert(observed.serialized_bytes <= 32000);assert.equal(observed.documents.length, 1);assert.equal(observed.documents[0].text, literal);assert.equal(observed.tasks[0].id, f.task.id);assert.equal(JSON.stringify(observed).includes('UNSELECTED_CONTEXT_PREVIEW_CANARY'), false);assert.equal(f.store.getDocument(unselected.document.id).text, 'UNSELECTED_CONTEXT_PREVIEW_CANARY');
  assert.equal(preview.serialized_selection_bytes, Buffer.byteLength(JSON.stringify({ tasks: observed.tasks, documents: observed.documents, source_entries: observed.source_entries })));assert.equal(f.store.getAgentGrant(ready.data.grant_id).used_bytes, observed.serialized_bytes);
});

test('pure selection preview rejects malformed arrays, getter inputs and broadened fields before invoking accessors or creating authority', t => {
  const f = fixture(t), base = { task_ids: [f.task.id], document_ids: [f.note.document.id], source_entry_ids: [] };let invoked = 0;
  const outer = { ...base };Object.defineProperty(outer, 'document_ids', { enumerable: true, get() { invoked++;return base.document_ids; } });
  const array = [];Object.defineProperty(array, '0', { enumerable: true, get() { invoked++;return f.note.document.id; } });array.length = 1;
  const symbolArray = [f.note.document.id];symbolArray[Symbol('private')] = 'private';
  const prototypeArray = [f.note.document.id];Object.setPrototypeOf(prototypeArray, {});
  for (const input of [outer, { ...base, document_ids: array }, { ...base, document_ids: new Array(1) }, { ...base, document_ids: symbolArray }, { ...base, document_ids: prototypeArray }, { ...base, document_ids: [f.note.document.id, f.note.document.id] }, { ...base, destination: 'codex' }, { ...base, max_bytes: 128000 }, { ...base, url: 'http://private.invalid' }]) assert.throws(() => f.store.previewAgentSelection(input), { code: 'INVALID_INPUT' });
  assert.equal(invoked, 0);assert.equal(f.store.listAgentGrants().length, 0);assert.equal(f.service.list().length, 0);assert.equal(f.host.list().length, 0);
});

test('selection preflight accounts for independently bound validated task provenance metadata before optional-note sharing', async t => {
  let calls = 0;const f = fixture(t, async () => { calls++;return output(); }), policy = { grading: 'ungraded', ai_rule: 'allowed' };
  const snapshots = Array.from({ length: 100 }, (_, index) => f.store.createWorkspaceRecord({ kind: 'academic_item', title: `Synthetic source ${index}`, data: { format: 'academic_snapshot', body: 'PRIVATE_PROVENANCE_SOURCE_CANARY' } })), snapshotPins = snapshots.map(row => ({ id: row.id, revision: row.revision, hash: workflowHash(row.data) }));
  const tutor = f.store.createWorkspaceRecord({ kind: 'tutoring_session', title: 'Synthetic current tutoring session', data: { format: 'tutoring_session', recipe: { session_hash: sha('synthetic-tutor'), academic_policy: policy }, snapshot_pins: snapshotPins } }), plan = f.store.createWorkspaceRecord({ kind: 'plan', title: 'Synthetic current plan', data: { format: 'learning_catchup', plan: { plan_hash: sha('synthetic-plan') }, catch_up: { catch_up_hash: sha('synthetic-catchup') } } });
  const source = { plan_id: plan.id, plan_revision: plan.revision, plan_data_hash: workflowHash(plan.data), plan_hash: plan.data.plan.plan_hash, catch_up_hash: plan.data.catch_up.catch_up_hash, session_id: tutor.id, session_revision: tutor.revision, session_hash: tutor.data.recipe.session_hash, snapshot_pins: snapshotPins, academic_policy: policy, acceptance: { state: 'accepted' }, coverage_basis: 'selected_topics_only', mastery_claim: false }, reviewedTask = { title: f.task.title, deadline: f.task.deadline, effort_minutes: f.task.effort_minutes, course_label: f.task.course_label ?? null, dependency_ids: f.task.dependency_ids };
  const receipt = f.store.createWorkspaceRecord({ kind: 'inbox_item', title: 'Synthetic accepted task receipt', data: { format: 'learning_plan_task_receipt_v1', state: 'accepted', task_id: f.task.id, payload_hash: sha('synthetic-payload'), task_create_receipt_hash: sha('synthetic-create'), source, task: reviewedTask } }), verified = { receipts: [{ id: receipt.id, revision: receipt.revision, payload_hash: receipt.data.payload_hash, task_id: f.task.id, source, topic_id: 'synthetic-topic', source_citations: [], reviewed_task: reviewedTask, review: { reviewed: true }, dependency_pins: [], completed_prerequisites: [], task_create_receipt_hash: receipt.data.task_create_receipt_hash, local_task_differs: false }], pins: [{ kind: 'learning_plan_task_receipt', id: receipt.id, revision: receipt.revision, hash: workflowHash(receipt.data) }, { kind: 'learning_catchup_plan', id: plan.id, revision: plan.revision, hash: workflowHash(plan.data) }, { kind: 'tutoring_session', id: tutor.id, revision: tutor.revision, hash: workflowHash(tutor.data) }, ...snapshotPins.map(pin => ({ kind: 'learning_academic_snapshot', ...pin }))] };
  f.store.bindAgentTaskProvenance(() => verified);
  const chosen = f.store.createDocument({ title: 'Individually bounded optional note', text: 'A'.repeat(12000) }), input = { ...body(f), documents: [{ id: chosen.document.id, revision: chosen.document.revision, sha256: chosen.sha256 }] }, plain = f.store.previewAgentSelection({ task_ids: [], document_ids: [chosen.document.id], source_entry_ids: [] }), combined = f.store.previewAgentSelection({ task_ids: [f.task.id], document_ids: [chosen.document.id], source_entry_ids: [] });
  assert(plain.serialized_selection_bytes < 24000);assert(combined.serialized_selection_bytes > 24000);assert.equal(JSON.stringify(combined).includes('PRIVATE_PROVENANCE_SOURCE_CANARY'), false);
  await assert.rejects(f.service.start(input, options('oversized-real-provenance-selection')), { code: 'BUDGET_EXCEEDED' });assert.equal(f.store.listAgentGrants().length, 0);assert.equal(f.service.list().length, 0);assert.equal(f.host.list().length, 0);assert.equal(calls, 0);
});

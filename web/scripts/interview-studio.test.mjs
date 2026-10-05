import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { createHostTurns } from '../apps/local-runtime/src/host-turns.mjs';
import { createCareerWorkspace } from '../apps/local-runtime/src/career-service.mjs';
import { profileCandidate, profileHash, reviewProfileFact } from '../apps/local-runtime/src/profile.mjs';
import { createInterviewStudioService, parseInterviewStudioOutput, INTERVIEW_RUBRIC } from '../apps/local-runtime/src/interview-studio-service.mjs';
import { handleInterviewStudioRoute } from '../apps/local-runtime/src/interview-studio-routes.mjs';

const sha = raw => createHash('sha256').update(raw).digest('hex');
const wrapped = payload => `This is coaching only.\nBEGIN_LEARNBRIDGE_INTERVIEW\n${JSON.stringify(payload)}\nEND_LEARNBRIDGE_INTERVIEW`;
const question = roleId => ({ kind: 'question', question: 'Describe one scheduling design tradeoff and explain how you checked it.', focus: 'reasoning', source_refs: [roleId] });
const feedback = (roleId, quote) => ({ kind: 'feedback', summary: 'The answer describes a choice; the measured outcome remains unknown.', strengths: ['You named a concrete tradeoff.'], improvements: ['Add the evidence you used to compare outcomes.'], rubric: INTERVIEW_RUBRIC.map(dimension => ({ dimension, assessment: dimension === 'reasoning' ? 'observed' : 'not_assessed', evidence_quote: dimension === 'reasoning' ? quote : '', reason: dimension === 'reasoning' ? 'The literal response states the design choice.' : 'This response does not establish this dimension.' })), source_refs: [roleId] });
const result = payload => { const text = wrapped(payload); return { state: 'completed', complete: true, text, output_sha256: sha(text), host_version: '0.154.0', error_code: null, tool_receipts: [{ tool: 'learnbridge_context', status: 'completed', failed: false, result_hash: sha('fixture exact context'), origin: 'model' }] }; };
const review = record => ({ expected_revision: record.revision, context_hash: record.data.context_hash });
function fixture(t, { executor, enabled = true } = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-interview-studio-')), root = join(parent, 'private'); let store = LocalStore.open({ root }), count = 0, allowed = true;
  const career = createCareerWorkspace(store), role = career.createRole({ company: 'Fixture Company', provider_job_id: 'fixture-123', title: 'Software Intern', url: 'https://jobs.lever.co/fixture/fixture-123', source_kind: 'official', source_excerpt: 'Build scheduling tools and explain engineering decisions.', availability: 'open' }, { idempotencyKey: 'fixture-interview-role' });
  const unselected = store.createDocument({ title: 'Unrelated', text: 'PRIVATE_UNSELECTED_INTERVIEW_CANARY' });
  function fact(field, value, extra = {}) { let data = profileCandidate({ field, value, ...extra }); data = reviewProfileFact(data, { decision: 'confirm', fingerprint: profileHash(data) }, { reviewer: store.identity.student_id }); return store.createWorkspaceRecord({ kind: 'profile_fact', title: field, data }); }
  const experience = fact('experience', 'Built a synthetic study planner.'), sourceIds = [];
  let hosts = createHostTurns({ store, enabled, execute: async input => {
    assert.equal(input.toolPolicy, 'read_only', 'Question and feedback coaching must never enable proposal writes');
    count++; const context = store.agentContext({ destination: 'codex', grant_id: input.grantId, max_bytes: 64000 }); assert.equal(context.documents.length, 1); assert.deepEqual(context.tasks, []); assert.equal(JSON.stringify(context).includes('PRIVATE_UNSELECTED_INTERVIEW_CANARY'), false);
    sourceIds.push(context.documents[0].id); input.onProgress({ phase: 'tool', tool: 'learnbridge_context', state: 'finished' });
    if (executor) return executor(input, { role, context });
    return result(input.prompt.includes('Review the student\'s EXACT saved answer') ? feedback(role.id, 'I chose a queue.') : question(role.id));
  } });
  let service = createInterviewStudioService({ store, hostTurns: hosts });
  t.after(async () => { await hosts.drain(); store.close(); rmSync(parent, { recursive: true, force: true }); });
  function input() { const state = service.state(), ref = state.roles.find(row => row.id === role.id), currentFact = state.facts.find(row => row.id === experience.id); return { role_ref: { id: ref.id, revision: ref.revision, sha256: ref.sha256 }, profile_refs: currentFact ? [{ id: currentFact.id, revision: currentFact.revision, fingerprint: currentFact.fingerprint }] : [], mode: 'behavioral', round_limit: 2 }; }
  function create(overrides = {}) { return service.create({ ...input(), ...overrides }, { idempotencyKey: randomUUID() }); }
  function exportAndGrant(record) { record = service.exportContext(record.id, review(record)); const note = record.data.context_note, grant = store.createAgentGrant({ destination: 'codex', task_ids: [], document_ids: [note.id], source_entry_ids: [], max_bytes: 256000, expires_in_minutes: 10 }); return { record, grant }; }
  async function run(record, grant, idempotencyKey = randomUUID()) { const preview = service.previewRun(record.id, review(record)); return service.run(record.id, { ...review(record), grant_id: grant.id, prompt_sha256: preview.prompt_sha256, confirmed: true }, { idempotencyKey, authorize: () => allowed }); }
  async function settled(record) { for (let n = 0; n < 100; n++) { const current = service.get(record.id); if (current.data.pending?.state !== 'running') return current; await delay(5); } throw Error('Fixture studio did not settle'); }
  return { parent, root, role, experience, unselected, fact, sourceIds, input, create, exportAndGrant, run, settled, setAllowed: value => { allowed = value; }, get calls() { return count; }, get store() { return store; }, get service() { return service; }, get hosts() { return hosts; },
    async restart() { await hosts.drain(); store.close(); store = LocalStore.open({ root }); hosts = createHostTurns({ store, enabled, execute: async () => { throw Error('Restart must not replay a host turn'); } }); service = createInterviewStudioService({ store, hostTurns: hosts }); },
    async restore() { const backupRoot = join(parent, 'backup'); await store.backup(backupRoot); await hosts.drain(); store.close(); const restoredRoot = join(parent, 'restored'); await LocalStore.restore({ backupRoot, root: restoredRoot }); store = LocalStore.open({ root: restoredRoot }); hosts = createHostTurns({ store, enabled, execute: async () => { throw Error('Restore must not replay'); } }); service = createInterviewStudioService({ store, hostTurns: hosts }); },
  };
}

test('IS01 selected role/profile create a private persistent session, without model calls, grants, tasks or unrelated text', t => {
  const f = fixture(t), before = { tasks: f.store.listTasks(), grants: f.store.listAgentGrants(), documents: f.store.listDocuments() }, body = f.input();
  const record = f.service.create(body, { idempotencyKey: 'fixture-create-interview' }); assert.equal(record.data.rounds.length, 0); assert.equal(record.data.context.profile_facts[0].value, f.experience.data.value); assert.equal(record.data.context.role.source_status, 'student_entered_not_live_verified');
  assert.equal(record.mastery_claim, false); assert.equal(record.code_execution_verified, false); assert.equal(record.hiring_prediction, null); assert.equal(f.calls, 0); assert.equal(JSON.stringify(record).includes('PRIVATE_UNSELECTED_INTERVIEW_CANARY'), false);
  assert.deepEqual({ tasks: f.store.listTasks(), grants: f.store.listAgentGrants(), documents: f.store.listDocuments() }, before);
  assert.equal(f.service.create(body, { idempotencyKey: 'fixture-create-interview' }).id, record.id); assert.throws(() => f.service.create({ ...body, mode: 'coding' }, { idempotencyKey: 'fixture-create-interview' }), { code: 'REVISION_CONFLICT' });
});

test('IS02 context note export is exact and separate from sharing; broad/missing/Claude grants never reach the executor', async t => {
  const f = fixture(t), created = f.create(); assert.throws(() => f.service.previewRun(created.id, review(created)), { code: 'REVISION_CONFLICT' });
  const { record, grant } = f.exportAndGrant(created), note = f.store.getDocument(record.data.context_note.id); assert.deepEqual(JSON.parse(note.text), record.data.context); assert.equal(note.sha256, record.data.context_note.sha256);
  assert.equal(f.service.exportContext(record.id, review(record)).revision, record.revision);
  const broad = f.store.createAgentGrant({ destination: 'codex', task_ids: [], document_ids: [note.document.id, f.unselected.document.id], source_entry_ids: [], max_bytes: 256000, expires_in_minutes: 10 });
  await assert.rejects(f.run(record, broad), { code: 'SCOPE_DENIED' });
  const claude = f.store.createAgentGrant({ destination: 'claude', task_ids: [], document_ids: [note.document.id], source_entry_ids: [], max_bytes: 256000, expires_in_minutes: 10 }); await assert.rejects(f.run(record, claude), { code: 'SCOPE_DENIED' });
  const empty = f.store.createAgentGrant({ destination: 'codex', task_ids: [], document_ids: [], source_entry_ids: [], max_bytes: 256000, expires_in_minutes: 10 }); await assert.rejects(f.run(record, empty), { code: 'SCOPE_DENIED' }); assert.equal(f.calls, 0); assert.equal(grant.pins.documents.length, 1);
});

test('IS03 question → exact saved answer → actual host feedback → next question is one at a time and fully linked', async t => {
  const f = fixture(t), { record: prepared, grant } = f.exportAndGrant(f.create());
  let record = await f.settled(await f.run(prepared, grant)); assert.equal(record.data.rounds.length, 1); assert.equal(record.data.rounds[0].question.question, question(f.role.id).question); assert.ok(record.data.rounds[0].question_origin.turn_id); assert.equal(f.calls, 1);
  assert.throws(() => f.service.previewRun(record.id, review(record)), { code: 'REVISION_CONFLICT' });
  const answerText = '  I chose a queue.\nI compared FIFO to a stack.  '; record = f.service.answer(record.id, { ...review(record), round_id: 'round-1', student_answer: answerText });
  assert.equal(record.data.rounds[0].answer.text, answerText); assert.equal(record.data.rounds[0].answer.sha256, sha(answerText)); assert.equal(record.data.rounds[0].answer.assessment, 'unassessed'); assert.equal(f.calls, 1);
  record = await f.settled(await f.run(record, grant)); assert.equal(record.data.rounds[0].feedback.rubric.find(row => row.dimension === 'reasoning').evidence_quote, 'I chose a queue.'); assert.equal(f.calls, 2);
  const turn = f.hosts.get(record.data.rounds[0].feedback_origin.turn_id); assert.ok(turn.data.prompt.includes(JSON.stringify(answerText))); assert.equal(turn.data.tool_receipts[0].origin, 'model');
  record = await f.settled(await f.run(record, grant)); assert.equal(record.data.rounds.length, 2); assert.equal(record.data.rounds[1].answer, null); assert.equal(f.calls, 3); assert.equal(f.store.listTasks().length, 0);
});

test('IS04 one-round feedback completes only this mock; code execution and hiring outcomes remain unverified', async t => {
  const f = fixture(t), { record: prepared, grant } = f.exportAndGrant(f.create({ mode: 'coding', round_limit: 1 })); let record = await f.settled(await f.run(prepared, grant));
  record = f.service.answer(record.id, { ...review(record), round_id: 'round-1', student_answer: 'I chose a queue.' }); record = await f.settled(await f.run(record, grant)); assert.equal(record.data.state, 'completed'); assert.equal(record.mastery_claim, false); assert.equal(record.code_execution_verified, false);
  assert.throws(() => f.service.previewRun(record.id, review(record)), { code: 'REVISION_CONFLICT' });
});

test('IS05 explicit exact prompt hash confirmation, stale revisions, answer IDs and executable fields are enforced', async t => {
  const f = fixture(t), { record, grant } = f.exportAndGrant(f.create()); const preview = f.service.previewRun(record.id, review(record)), base = { ...review(record), grant_id: grant.id, prompt_sha256: preview.prompt_sha256, confirmed: true }, options = { idempotencyKey: 'fixture-input-review', authorize: () => true };
  await assert.rejects(f.service.run(record.id, { ...base, confirmed: false }, options), { code: 'INVALID_INPUT' }); await assert.rejects(f.service.run(record.id, { ...base, prompt_sha256: sha('wrong') }, options), { code: 'REVISION_CONFLICT' }); await assert.rejects(f.service.run(record.id, { ...base, command: 'fake' }, options), { code: 'INVALID_INPUT' });
  let finished = await f.settled(await f.run(record, grant)); assert.throws(() => f.service.answer(record.id, { ...review(record), round_id: 'round-1', student_answer: 'I chose a queue.' }), { code: 'REVISION_CONFLICT' });
  assert.throws(() => f.service.answer(record.id, { ...review(finished), round_id: 'round-2', student_answer: 'I chose a queue.' }), { code: 'REVISION_CONFLICT' });
  assert.throws(() => f.service.answer(record.id, { ...review(finished), round_id: 'round-1', student_answer: '' }), { code: 'INVALID_INPUT' });
  finished = f.service.answer(record.id, { ...review(finished), round_id: 'round-1', student_answer: 'I chose a queue.' }); assert.throws(() => f.service.answer(record.id, { ...review(finished), round_id: 'round-1', student_answer: 'Replacement' }), { code: 'REVISION_CONFLICT' });
});

test('IS06 retries execute only one host turn; a changed retry cannot relabel it', async t => {
  const f = fixture(t), { record, grant } = f.exportAndGrant(f.create()), preview = f.service.previewRun(record.id, review(record)), body = { ...review(record), grant_id: grant.id, prompt_sha256: preview.prompt_sha256, confirmed: true }, options = { idempotencyKey: 'fixture-one-turn-retry', authorize: () => true };
  const started = await f.service.run(record.id, body, options); await f.settled(started); const retried = await f.service.run(record.id, body, options); assert.equal(retried.data.pending.turn_id, started.data.pending.turn_id); assert.equal(f.calls, 1);
  await assert.rejects(f.service.run(record.id, { ...body, prompt_sha256: sha('changed') }, options), { code: 'REVISION_CONFLICT' });
});

test('IS07 structured feedback cannot claim observed evidence absent from the exact student answer or invent source references', t => {
  const roleId = randomUUID(), valid = feedback(roleId, 'I chose a queue.'); assert.deepEqual(parseInterviewStudioOutput(wrapped(valid), { phase: 'feedback', roleId, studentAnswer: 'I chose a queue.' }), valid);
  const forged = structuredClone(valid); forged.rubric[1].evidence_quote = 'I passed all unit tests.'; assert.throws(() => parseInterviewStudioOutput(wrapped(forged), { phase: 'feedback', roleId, studentAnswer: 'I chose a queue.' }), { code: 'VERSION_MISMATCH' });
  const foreign = { ...question(roleId), source_refs: [randomUUID()] }; assert.throws(() => parseInterviewStudioOutput(wrapped(foreign), { phase: 'question', roleId }), { code: 'VERSION_MISMATCH' });
  const numeric = { ...valid, score: 100 }; assert.throws(() => parseInterviewStudioOutput(wrapped(numeric), { phase: 'feedback', roleId, studentAnswer: 'I chose a queue.' }), { code: 'INVALID_INPUT' });
  assert.throws(() => parseInterviewStudioOutput(`${wrapped(valid)}${wrapped(valid)}`, { phase: 'feedback', roleId, studentAnswer: 'I chose a queue.' }), { code: 'VERSION_MISMATCH' });
  assert.throws(() => parseInterviewStudioOutput('The student has mastered interviews!', { phase: 'question', roleId }), { code: 'VERSION_MISMATCH' });
});

test('IS08 malformed model envelope is a failed linked run and never becomes a question or assessment', async t => {
  const f = fixture(t, { executor: async (_, { role }) => result({ ...question(role.id), source_refs: ['foreign'] }) }), { record, grant } = f.exportAndGrant(f.create()); const finished = await f.settled(await f.run(record, grant));
  assert.equal(finished.data.pending.state, 'failed'); assert.equal(finished.data.pending.error_code, 'VERSION_MISMATCH'); assert.equal(finished.data.rounds.length, 0); assert.ok(finished.data.pending.turn_id);
});

test('IS09 posting edits, profile rejection/conflicts and coaching-note edits invalidate future use and cached model text', async t => {
  for (const mutation of ['role', 'profile', 'conflict', 'note']) {
    const f = fixture(t), { record, grant } = f.exportAndGrant(f.create()); let finished = await f.settled(await f.run(record, grant));
    if (mutation === 'role') f.store.updateWorkspaceRecord(f.role.id, { expected_revision: f.role.revision, data: { ...f.role.data, role: { ...f.role.data.role, source_excerpt: 'Changed posting.' } } });
    else if (mutation === 'profile') f.store.updateWorkspaceRecord(f.experience.id, { expected_revision: f.experience.revision, data: { ...f.experience.data, state: 'rejected' } });
    else if (mutation === 'conflict') f.fact('experience', 'Contradictory experience.');
    else { const note = f.store.getDocument(record.data.context_note.id); f.store.updateDocument(note.document.id, { text: 'Changed coaching note.' }, note.document.revision); }
    finished = f.service.get(finished.id); assert.equal(finished.stale, true); assert.equal(finished.data.context, null); assert.equal(finished.data.rounds[0].question, null); assert.equal(finished.model_output_withheld, true);
    assert.throws(() => f.service.previewRun(finished.id, review(finished)), error => ['REVISION_CONFLICT', 'CONSENT_REQUIRED'].includes(error.code));
  }
});

test('IS10 revoked grant withholds derived question and forbids answering invisible evidence', async t => {
  const f = fixture(t), { record, grant } = f.exportAndGrant(f.create()); const finished = await f.settled(await f.run(record, grant)); const currentGrant = f.store.getAgentGrant(grant.id); f.store.revokeAgentGrant(grant.id, currentGrant.revision);
  const hidden = f.service.get(finished.id); assert.equal(hidden.data.rounds[0].question, null); assert.equal(hidden.model_output_withheld, true); assert.throws(() => f.service.answer(finished.id, { ...review(finished), round_id: 'round-1', student_answer: 'I chose a queue.' }), { code: 'CONSENT_REQUIRED' });
});

test('IS11 pause interrupts a linked host request; late output does not attach and resume preserves the checkpoint', async t => {
  let release; const f = fixture(t, { executor: async (_, { role }) => new Promise(resolve => { release = () => resolve(result(question(role.id))); }) }), { record, grant } = f.exportAndGrant(f.create());
  let running = await f.run(record, grant); await delay(5); running = f.service.get(running.id); const paused = f.service.transition(running.id, { ...review(running), action: 'pause' }); assert.equal(paused.data.state, 'paused'); assert.equal(paused.data.pending.state, 'interrupted'); release(); await delay(10);
  const saved = f.service.get(paused.id); assert.equal(saved.data.rounds.length, 0); assert.equal(f.hosts.get(running.data.pending.turn_id).data.text, '');
  const resumed = f.service.transition(saved.id, { ...review(saved), action: 'resume' }); assert.equal(resumed.data.state, 'ready'); assert.equal(resumed.data.rounds.length, 0); assert.equal(f.calls, 1);
});

test('IS12 revoked browser authorization prevents late model output from becoming feedback', async t => {
  let release; const f = fixture(t, { executor: async (_, { role }) => new Promise(resolve => { release = () => resolve(result(question(role.id))); }) }), { record, grant } = f.exportAndGrant(f.create()); const running = await f.run(record, grant); await delay(5); f.setAllowed(false); release(); const saved = await f.settled(running); assert.equal(saved.data.pending.state, 'withheld'); assert.equal(saved.data.rounds.length, 0);
});

test('IS13 restart and fresh backup restore retain exact completed questions/answers with zero host replays', async t => {
  const f = fixture(t), { record, grant } = f.exportAndGrant(f.create()); let saved = await f.settled(await f.run(record, grant)); saved = f.service.answer(saved.id, { ...review(saved), round_id: 'round-1', student_answer: 'I chose a queue.' }); const snapshot = structuredClone(saved.data);
  await f.restart(); assert.deepEqual(f.service.get(saved.id).data, snapshot); assert.equal(f.calls, 1); await f.restore(); assert.deepEqual(f.service.get(saved.id).data, snapshot); assert.equal(f.calls, 1); assert.equal(f.store.integrity().integrity, 'ok');
});

test('IS14 unavailable official host creates no false question; reviewed request remains visibly failed', async t => {
  const f = fixture(t, { enabled: false }), { record, grant } = f.exportAndGrant(f.create()); await assert.rejects(f.run(record, grant), { code: 'UNSUPPORTED' }); const saved = f.service.get(record.id); assert.equal(saved.data.pending.state, 'failed'); assert.equal(saved.data.pending.error_code, 'UNSUPPORTED'); assert.equal(saved.data.rounds.length, 0); assert.equal(f.calls, 0);
});

test('IS15 route rejects unpaired requests and never accepts configuration or executable fields', async t => {
  const f = fixture(t), route = '/interview-studio/state', session = { nonce: 'fixture-paired-session' }, privateBody = async () => ({});
  assert.equal(await handleInterviewStudioRoute({ route: '/unrelated', method: 'GET' }), null);
  await assert.rejects(handleInterviewStudioRoute({ route, method: 'GET', privateBody, interviewStudioService: f.service }), { code: 'AUTH_REQUIRED' });
  assert.equal((await handleInterviewStudioRoute({ route, method: 'GET', privateBody, session, interviewStudioService: f.service })).status, 200);
  let fields; const data = await handleInterviewStudioRoute({ route: '/interview-studio/sessions', method: 'POST', privateBody: async allowed => { fields = allowed; return f.input(); }, session, interviewStudioService: f.service, idempotencyKey: 'fixture-route-create' }); assert.equal(data.status, 201); assert.deepEqual(fields, ['role_ref', 'profile_refs', 'mode', 'round_limit']);
  await assert.rejects(handleInterviewStudioRoute({ route, method: 'POST', privateBody, session, interviewStudioService: f.service }), { code: 'INVALID_INPUT' });
});

test('IS16 exact JSON-encoded coaching context is bounded before save/sharing and a permitted large note fits one 32000-byte read', async t => {
  const f = fixture(t), career = createCareerWorkspace(f.store), base = { company: 'Fixture Large Company', provider_job_id: 'fixture-large', title: 'Large synthetic posting', url: 'https://jobs.lever.co/fixture/fixture-large', source_kind: 'official', availability: 'open' };
  const createFrom = role => { const selected = f.service.state().roles.find(row => row.id === role.id); return f.service.create({ role_ref: { id: selected.id, revision: selected.revision, sha256: selected.sha256 }, profile_refs: [], mode: 'technical', round_limit: 1 }, { idempotencyKey: 'fixture-size-' + role.id }); };
  const escaped = career.createRole({ ...base, source_excerpt: '"'.repeat(13000) }, { idempotencyKey: 'fixture-escaped-role' }), before = { docs: f.store.listDocuments().length, grants: f.store.listAgentGrants().length, sessions: f.service.state().sessions.length };
  assert.throws(() => createFrom(escaped), { code: 'BUDGET_EXCEEDED' });assert.deepEqual({ docs: f.store.listDocuments().length, grants: f.store.listAgentGrants().length, sessions: f.service.state().sessions.length }, before);assert.equal(f.calls, 0);
  const plain = career.createRole({ ...base, provider_job_id: 'fixture-plain', source_excerpt: 'A'.repeat(20000) }, { idempotencyKey: 'fixture-plain-role' }), { record, grant } = f.exportAndGrant(createFrom(plain));
  assert.equal(f.store.getDocument(record.data.context_note.id).text, JSON.stringify(record.data.context, null, 2));
  const context = f.store.agentContext({ destination: 'codex', grant_id: grant.id, max_bytes: 32000 });assert(context.serialized_bytes < 32000);assert.equal(context.documents.length, 1);assert.equal(context.documents[0].id, record.data.context_note.id);assert.equal(f.calls, 0);
});

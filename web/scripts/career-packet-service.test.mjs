import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { createPublicJobService, PUBLIC_JOB_LIMITS } from '../apps/local-runtime/src/public-job-service.mjs';
import { createCareerPacketService } from '../apps/local-runtime/src/career-packet-service.mjs';
import { createWritingService } from '../apps/local-runtime/src/writing-service.mjs';
import { profileCandidate, profileHash, reviewProfileFact } from '../apps/local-runtime/src/profile.mjs';
import { handleCareerPacketRoute } from '../apps/local-runtime/src/career-packet-routes.mjs';
import { verifyCareerPacketDownload } from '../apps/local/public/career-packets.js';

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const gh = { provider: 'greenhouse', board_slug: 'fixturecompany' }, select = { ...gh, job_id: '123' };
const post = extra => ({ id: 123, title: 'Synthetic Software Internship', location: { name: 'Toronto' }, content: '<p>Learn and build useful tools.</p>', ...extra });
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const pin = record => ({ id: record.id, revision: record.revision, fingerprint: profileHash(record.data) });
const writingPin = (record, slot = 'resume') => ({ slot, id: record.id, revision: record.revision, payload_hash: record.data.payload_hash });
const review = record => ({ expected_revision: record.revision, payload_hash: record.data.payload_hash });
function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-career-packet-')), root = join(parent, 'workspace'); let store = LocalStore.open({ root }), now = Date.now(); const replies = [], calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, method: options.method }); const reply = replies.shift(); if (!reply) throw new Error('Unexpected fetch'); return reply; };
  let jobs = createPublicJobService({ store, fetchImpl, clock: () => now }), service = createCareerPacketService({ store, publicJobService: jobs, clock: () => now });
  const privateDoc = store.createDocument({ title: 'Private unrelated note', text: 'PRIVATE_UNSELECTED_PACKET_CANARY' });
  t.after(() => { jobs.close(); store.close(); rmSync(parent, { recursive: true, force: true }); });
  function fact(field, value, extra = {}) {
    let data = profileCandidate({ field, value, ...extra }, { now: new Date(now).toISOString(), resolveEvidence: id => store.getDocument(id) });
    data = reviewProfileFact(data, { decision: 'confirm', fingerprint: profileHash(data) }, { reviewer: store.identity.student_id, now: new Date(now).toISOString() });
    return store.createWorkspaceRecord({ kind: 'profile_fact', title: field, data });
  }
  function draft(extra = {}) {
    const source = store.createDocument({ title: 'Student resume source', text: 'Built a synthetic scheduling project.', academic_policy: extra.academic_policy || 'unrestricted' });
    const writing = createWritingService({ store }), proposal = writing.createProposal({ title: 'My selected draft', kind: extra.kind || 'markdown_artifact', draft_text: extra.text || '# My résumé\nBuilt a synthetic scheduling project.\nLiteral `command` and <script>inert</script>.', source_documents: [{ id: source.document.id, revision: source.document.revision, sha256: source.sha256 }], academic_policy: extra.academic_policy || 'unrestricted', origin: 'student' });
    const record = extra.pending ? proposal : extra.applied ? writing.acceptRevision(proposal.id, review(proposal)) : writing.accept(proposal.id, review(proposal)); return { record, source };
  }
  async function role(extra = {}) { replies.push(response({ jobs: [post(extra)] }), response(post(extra))); await jobs.search(gh); return (await jobs.read(select)).role; }
  return { parent, root, replies, calls, privateDoc, fact, draft, role, get store() { return store; }, get jobs() { return jobs; }, get service() { return service; }, advance: ms => { now += ms; },
    restart() { jobs.close(); store.close(); store = LocalStore.open({ root }); jobs = createPublicJobService({ store, fetchImpl, clock: () => now }); service = createCareerPacketService({ store, publicJobService: jobs, clock: () => now }); },
    async restore() { const backup = join(parent, 'backup'); await store.backup(backup); jobs.close(); store.close(); const restored = join(parent, 'restored'); await LocalStore.restore({ backupRoot: backup, root: restored }); store = LocalStore.open({ root: restored }); jobs = createPublicJobService({ store, fetchImpl, clock: () => now }); service = createCareerPacketService({ store, publicJobService: jobs, clock: () => now }); } };
}
async function setup(t) {
  const f = fixture(t), role = await f.role(), document = f.store.createDocument({ title: 'Selected experience evidence', text: 'Built a synthetic scheduling project.' }), experience = f.fact('experience', document.text,
    { evidence: { kind: 'document', id: document.document.id, revision: document.document.revision, sha256: document.sha256, excerpt: document.text } }), name = f.fact('name', 'Fixture Student'), university = f.fact('university', 'Fixture University'), resume = f.draft();
  const body = { role_ref: { id: role.id, revision: role.revision, source_sha256: role.data.snapshot.source_sha256 }, profile_refs: [pin(name), pin(university), pin(experience)], writing_refs: [writingPin(resume.record)],
    questions: [{ id: 'experience', prompt: 'Describe relevant experience', required: true, fact_field: 'experience', fact_ids: [experience.id], draft_answer: experience.data.value }] };
  return Object.assign(f, { roleRecord: role, document, experience, name, university, resume, body });
}

test('CPS01: exact public source, selected confirmed experience and saved accepted writing become one durable private preview without new fetches', async t => {
  const f = await setup(t), before = { docs: f.store.listDocuments(), tasks: f.store.listTasks(), grants: f.store.listAgentGrants() }, packet = f.service.prepare(f.body, { idempotencyKey: 'fixture-packet-01' }).packet;
  assert.equal(packet.data.state, 'awaiting_review'); assert.equal(packet.exportable, false); assert.equal(packet.stale, false); assert.equal(packet.submission_supported, false); assert.equal(f.calls.length, 2);
  assert.deepEqual(packet.data.payload.job.snapshot, f.roleRecord.data.snapshot); assert.equal(packet.data.payload.job.source_request.response_sha256, sha(JSON.stringify(post())));
  assert.equal(packet.data.payload.profile_facts.find(fact => fact.id === f.experience.id).evidence.sha256, f.document.sha256);
  const writing = packet.data.payload.writing_drafts[0]; assert.equal(writing.text, f.store.getDocument(f.resume.record.data.accepted_note.id).text); assert.equal(writing.sha256, sha(writing.text)); assert.equal(writing.render_verification, 'not_performed');
  assert.equal(packet.data.payload.questions[0].answer, f.experience.data.value); assert.equal(packet.data.payload.questions[0].status, 'literal_confirmed_fact_draft');
  assert.equal(packet.data.payload_hash, sha(canonical(packet.data.payload))); assert.equal(JSON.stringify(packet).includes('PRIVATE_UNSELECTED_PACKET_CANARY'), false);
  assert.deepEqual({ docs: f.store.listDocuments(), tasks: f.store.listTasks(), grants: f.store.listAgentGrants() }, before);
});

test('CPS02: practical checklist and explicit unsupported GPA/work authorization/disclosures remain missing; generic eligibility never fills them', async t => {
  const f = await setup(t); f.fact('eligibility', 'I might be eligible.');
  const body = { ...f.body, requirements: [{ key: 'email', required: true }, { key: 'gpa', required: true }, { key: 'work_authorization', required: true }, { key: 'demographics', required: false }],
    questions: [{ id: 'authorization', prompt: 'Are you authorized to work?', required: true, fact_field: 'work_authorization', fact_ids: [], draft_answer: null }] };
  const packet = f.service.prepare(body, { idempotencyKey: 'fixture-packet-02' }).packet; assert.equal(packet.checklist_complete, false); assert.equal(packet.data.payload.questions[0].answer, null);
  assert.deepEqual(packet.data.payload.missing.required.map(item => item.key), ['email', 'gpa', 'work_authorization', 'question:authorization']); assert.equal(packet.data.payload.missing.typed_eligibility, 'not_evaluated');
  assert.equal(f.service.state().facts.some(fact => fact.field === 'eligibility'), false);
  assert.throws(() => f.service.prepare({ ...body, questions: [{ ...body.questions[0], draft_answer: 'Yes' }] }, { idempotencyKey: 'fixture-forged-protected' }), { code: 'SCOPE_DENIED' });
  const defaultPacket = f.service.prepare(f.body, { idempotencyKey: 'fixture-default-checklist' }).packet; assert.ok(defaultPacket.data.payload.missing.required.some(item => item.key === 'email')); assert.equal(defaultPacket.data.payload.checklist.origin, 'practical_default_student_checklist_not_employer_form');
});

test('CPS03: only exact current confirmed career-purpose nonconflicting profile facts are selectable', async t => {
  const f = await setup(t), general = f.fact('name', 'Fixture Student', { purposes: ['general'] });
  let candidate = profileCandidate({ field: 'experience', value: 'Unreviewed claim' }, { now: new Date().toISOString() }); const pending = f.store.createWorkspaceRecord({ kind: 'profile_fact', title: 'Unconfirmed', data: candidate });
  for (const value of [general, pending]) assert.throws(() => f.service.prepare({ ...f.body, profile_refs: [pin(value)] }, { idempotencyKey: 'fixture-excluded-fact' }), { code: 'CONSENT_REQUIRED' });
  assert.throws(() => f.service.prepare({ ...f.body, profile_refs: [{ ...pin(f.name), revision: 999 }] }, { idempotencyKey: 'fixture-forged-revision' }), { code: 'REVISION_CONFLICT' });
  f.fact('experience', 'Conflicting experience value'); assert.throws(() => f.service.prepare(f.body, { idempotencyKey: 'fixture-conflicting-fact' }), { code: 'CONSENT_REQUIRED' });
});

test('CPS04: profile source edits, expiry, rejection and new conflicts invalidate exact review/export with the old preview retained', async t => {
  for (const mode of ['source_edit', 'expiry', 'rejection', 'conflict']) {
    const f = await setup(t);
    if (mode === 'expiry') { const current = f.store.getWorkspaceRecord(f.name.id), data = { ...current.data, expires_at: new Date(Date.now() + 1000).toISOString() }; const changed = f.store.updateWorkspaceRecord(current.id, { expected_revision: current.revision, data }); f.body.profile_refs[0] = pin(changed); }
    const packet = f.service.prepare(f.body, { idempotencyKey: `fixture-stale-${mode}` }).packet, reviewed = f.service.review(packet.id, review(packet)).packet;
    if (mode === 'source_edit') f.store.updateDocument(f.document.document.id, { text: 'Changed underlying evidence.' }, f.document.document.revision);
    else if (mode === 'expiry') f.advance(2000);
    else if (mode === 'rejection') { const current = f.store.getWorkspaceRecord(f.experience.id); f.store.updateWorkspaceRecord(current.id, { expected_revision: current.revision, data: { ...current.data, state: 'rejected' } }); }
    else f.fact('experience', 'A new conflicting experience.');
    const stale = f.service.get(packet.id).packet; assert.equal(stale.stale, true); assert.equal(stale.exportable, false); assert.deepEqual(stale.data.payload, packet.data.payload);
    assert.throws(() => f.service.review(packet.id, review(reviewed)), error => ['CONSENT_REQUIRED', 'REVISION_CONFLICT'].includes(error.code));
    for (const format of ['markdown', 'json']) assert.throws(() => f.service.exportArtifact(packet.id, review(reviewed), format), error => ['CONSENT_REQUIRED', 'REVISION_CONFLICT'].includes(error.code));
  }
});

test('CPS05: changed/failed/404/expired selected official source blocks export and recheck cannot silently update a reviewed packet', async t => {
  for (const mode of ['changed', 'same_body_recheck', 'failed', 'missing', 'expired']) {
    const f = await setup(t), packet = f.service.prepare(f.body, { idempotencyKey: `fixture-role-${mode}` }).packet, reviewed = f.service.review(packet.id, review(packet)).packet;
    if (mode === 'expired') f.advance(PUBLIC_JOB_LIMITS.freshnessMs);
    else { f.replies.push(response(mode === 'changed' ? post({ content: '<p>Changed posting.</p>' }) : mode === 'same_body_recheck' ? post() : {}, mode === 'missing' ? 404 : mode === 'failed' ? 503 : 200)); await f.jobs.read(select); }
    assert.equal(f.service.get(reviewed.id).packet.stale, true); assert.throws(() => f.service.exportArtifact(reviewed.id, review(reviewed), 'json'), { code: 'REVISION_CONFLICT' });
  }
});

test('CPS06: pending/academic Writing is excluded; saved copy and original source pins invalidate even already reviewed packet exports', async t => {
  for (const mode of ['pending', 'academic', 'source_edit', 'copy_edit', 'forgotten', 'applied']) {
    const f = await setup(t), draft = mode === 'academic' ? f.draft({ academic_policy: 'learning_support' }) : mode === 'applied' ? f.draft({ applied: true, kind: 'revision' }) : mode === 'pending' ? f.draft({ pending: true }) : f.resume;
    const body = { ...f.body, writing_refs: [writingPin(draft.record)] };
    if (['pending', 'academic'].includes(mode)) { assert.throws(() => f.service.prepare(body, { idempotencyKey: `fixture-writing-${mode}` }), { code: 'CONSENT_REQUIRED' }); continue; }
    const packet = f.service.prepare(body, { idempotencyKey: `fixture-writing-${mode}` }).packet, reviewed = f.service.review(packet.id, review(packet)).packet;
    if (mode === 'applied') { assert.equal(packet.data.payload.writing_drafts[0].writing_record.state, 'applied_revision'); assert.equal(packet.data.payload.writing_drafts[0].document.sha256, draft.record.data.applied_note.sha256); continue; }
    if (mode === 'source_edit') f.store.updateDocument(draft.source.document.id, { text: 'Student changed the source.' }, draft.source.document.revision);
    else if (mode === 'copy_edit') { const copy = draft.record.data.accepted_note; f.store.updateDocument(copy.id, { text: 'Student changed the accepted copy.' }, copy.revision); }
    else f.store.deleteWorkspaceRecord(draft.record.id, draft.record.revision);
    assert.equal(f.service.get(packet.id).packet.stale, true); assert.throws(() => f.service.exportArtifact(packet.id, review(reviewed), 'markdown'), error => ['REVISION_CONFLICT', 'SCOPE_DENIED'].includes(error.code));
  }
});

test('CPS07: manual answers stay drafts; selected fact answers must match literally and unselected or mismatched references cannot manufacture facts', async t => {
  const f = await setup(t), manual = { id: 'motivation', prompt: 'Why this role?', required: false, fact_field: null, fact_ids: [], draft_answer: 'My personal motivation draft.' };
  const packet = f.service.prepare({ ...f.body, questions: [manual] }, { idempotencyKey: 'fixture-manual-answer' }).packet; assert.equal(packet.data.payload.questions[0].status, 'manual_draft_facts_unverified'); assert.equal(packet.data.payload.questions[0].submitted, false);
  for (const patch of [{ draft_answer: 'Invented internship at a new company.' }, { fact_ids: [randomUUID()] }, { fact_field: 'graduation' }]) assert.throws(() => f.service.prepare({ ...f.body, questions: [{ ...f.body.questions[0], ...patch }] }, { idempotencyKey: 'fixture-bad-answer' }), error => ['SCOPE_DENIED', 'CONSENT_REQUIRED', 'INVALID_INPUT'].includes(error.code));
  const noAnswer = f.service.prepare({ ...f.body, questions: [{ ...f.body.questions[0], fact_ids: [], draft_answer: null }] }, { idempotencyKey: 'fixture-missing-answer' }).packet; assert.equal(noAnswer.data.payload.questions[0].answer, null); assert.ok(noAnswer.data.payload.missing.required.some(item => item.key === 'question:experience'));
});

test('CPS08: exact review is durable/idempotent and only its current revision/hash authorizes text export; missing checklist is never treated as submission readiness', async t => {
  const f = await setup(t), packet = f.service.prepare(f.body, { idempotencyKey: 'fixture-review-exact' }).packet;
  assert.throws(() => f.service.exportArtifact(packet.id, review(packet), 'json'), { code: 'CONSENT_REQUIRED' });
  assert.throws(() => f.service.review(packet.id, { ...review(packet), payload_hash: 'f'.repeat(64) }), { code: 'REVISION_CONFLICT' });
  const reviewed = f.service.review(packet.id, review(packet)).packet; assert.equal(reviewed.exportable, true); assert.equal(reviewed.checklist_complete, false); assert.equal(reviewed.data.review.reviewer, f.store.identity.student_id);
  assert.deepEqual(f.service.review(packet.id, review(packet)).packet, reviewed); assert.equal(f.service.state().packets[0].revision, reviewed.revision);
  assert.throws(() => f.service.exportArtifact(packet.id, review(packet), 'json'), { code: 'REVISION_CONFLICT' }); assert.throws(() => f.service.exportArtifact(packet.id, review(reviewed), 'pdf'), { code: 'INVALID_INPUT' });
});

test('CPS09: creation retries preserve one exact packet/review, while changed payload and stale retries are rejected', async t => {
  const f = await setup(t), options = { idempotencyKey: 'fixture-creation-retry' }, packet = f.service.prepare(f.body, options).packet, reviewed = f.service.review(packet.id, review(packet)).packet;
  assert.deepEqual(f.service.prepare(f.body, options).packet, reviewed); assert.equal(f.service.state().packets.length, 1);
  assert.throws(() => f.service.prepare({ ...f.body, questions: [] }, options), { code: 'REVISION_CONFLICT' });
  f.store.updateDocument(f.document.document.id, { text: 'Later source edit.' }, f.document.document.revision); assert.throws(() => f.service.prepare(f.body, options), { code: 'CONSENT_REQUIRED' });
});

test('CPS10: deterministic JSON/Markdown downloads independently recover the exact reviewed payload, original source and accepted text, with escaped renderer syntax', async t => {
  const f = await setup(t), packet = f.service.prepare(f.body, { idempotencyKey: 'fixture-export-readback' }).packet, reviewed = f.service.review(packet.id, review(packet)).packet;
  const json = f.service.exportArtifact(packet.id, review(reviewed), 'json'), markdown = f.service.exportArtifact(packet.id, review(reviewed), 'markdown');
  const actual = JSON.parse(json.text), parsed = JSON.parse(/^````````````json\n([\s\S]*)\n````````````\n$/m.exec(markdown.text)[1]);
  assert.deepEqual(actual, parsed); assert.deepEqual(actual.payload, packet.data.payload); assert.equal(actual.manifest.packet.payload_hash, sha(canonical(actual.payload)));
  assert.equal(markdown.text.includes('<script>'), false); assert.equal(actual.payload.writing_drafts[0].text.includes('<script>inert</script>'), true);
  for (const format of ['markdown', 'json']) { const output = f.service.exportArtifact(packet.id, review(reviewed), format); assert.equal(output.byte_length, Buffer.byteLength(output.text)); assert.equal(output.sha256, sha(output.text)); assert.deepEqual(f.service.exportArtifact(packet.id, review(reviewed), format), output); assert.deepEqual(Buffer.from(await verifyCareerPacketDownload(output, reviewed, format)), Buffer.from(output.text)); }
  assert.equal(f.calls.length, 2); assert.equal(f.store.listTasks().length, 0);
});

test('CPS11: browser verifier denies modified bytes, source/fact/writing/review pins, filename, age and unsupported rendering before any download', async t => {
  const f = await setup(t), packet = f.service.prepare(f.body, { idempotencyKey: 'fixture-client-denial' }).packet, reviewed = f.service.review(packet.id, review(packet)).packet;
  for (const format of ['markdown', 'json']) {
    const output = f.service.exportArtifact(packet.id, review(reviewed), format);
    for (const patch of [{ text: output.text + 'changed' }, { byte_length: output.byte_length + 1 }, { sha256: 'f'.repeat(64) }, { filename: '../leak.json' }, { mime: 'text/html' }, { sharing: 'granted' }, { submission_supported: true },
      { manifest: { ...output.manifest, source_sha256: 'f'.repeat(64) } }, { manifest: { ...output.manifest, selected_fact_ids: [] } }, { manifest: { ...output.manifest, writing_copy_hashes: [] } }, { manifest: { ...output.manifest, rendering: 'pdf_verified' } }]) await assert.rejects(verifyCareerPacketDownload({ ...output, ...patch }, reviewed, format), /No file was prepared/);
    await assert.rejects(verifyCareerPacketDownload(output, { ...reviewed, stale: true }, format), /No file was prepared/);
    const originalNow = Date.now; try { Date.now = () => Date.parse(output.manifest.source_fresh_until); await assert.rejects(verifyCareerPacketDownload(output, reviewed, format), /No file was prepared/); } finally { Date.now = originalNow; }
  }
});

test('CPS12: restart and fresh verified backup restore preserve exact review/export bytes without a source/provider/model read', async t => {
  const f = await setup(t), packet = f.service.prepare(f.body, { idempotencyKey: 'fixture-packet-restart' }).packet, reviewed = f.service.review(packet.id, review(packet)).packet;
  const json = f.service.exportArtifact(packet.id, review(reviewed), 'json'), markdown = f.service.exportArtifact(packet.id, review(reviewed), 'markdown'), before = f.service.get(packet.id);
  f.restart(); assert.deepEqual(f.service.get(packet.id), before); assert.deepEqual(f.service.exportArtifact(packet.id, review(reviewed), 'json'), json); await f.restore(); assert.deepEqual(f.service.get(packet.id), before); assert.deepEqual(f.service.exportArtifact(packet.id, review(reviewed), 'markdown'), markdown); assert.equal(f.calls.length, 2);
});

test('CPS13: cross-workspace IDs, input accessors, duplicate pins/questions and packet budgets fail before a new workspace record is created', async t => {
  const f = await setup(t), other = fixture(t); assert.throws(() => other.service.prepare(f.body, { idempotencyKey: 'fixture-cross-workspace' }), { code: 'SCOPE_DENIED' });
  for (const patch of [{ role_ref: { ...f.body.role_ref, revision: 0 } }, { profile_refs: [pin(f.name), pin(f.name)] }, { questions: [f.body.questions[0], f.body.questions[0]] }, { writing_refs: [writingPin(f.resume.record), writingPin(f.resume.record)] }, { requirements: [{ key: 'invented', required: true }] }, { source_url: 'http://127.0.0.1/private' }]) assert.throws(() => f.service.prepare({ ...f.body, ...patch }, { idempotencyKey: 'fixture-bad-packet' }), { code: 'INVALID_INPUT' });
  let invoked = false; const forged = { ...f.body }; Object.defineProperty(forged, 'profile_refs', { enumerable: true, get() { invoked = true; return []; } }); assert.throws(() => f.service.prepare(forged, { idempotencyKey: 'fixture-accessor-packet' }), { code: 'INVALID_INPUT' }); assert.equal(invoked, false);
  const long = f.draft({ text: 'x'.repeat(50000) }); assert.throws(() => f.service.prepare({ ...f.body, writing_refs: [writingPin(long.record), writingPin(long.record, 'cover_letter')] }, { idempotencyKey: 'fixture-packet-budget' }), { code: 'BUDGET_EXCEEDED' }); assert.equal(f.service.state().packets.length, 0);
});

test('CPS14: paired exact routes preserve private source boundaries and expose no send/submit/upload/provider execution surface', async t => {
  const f = await setup(t); let authorized = true, reads = 0;
  const invoke = (route, method, body = {}, extra = {}) => handleCareerPacketRoute({ route, method, store: f.store, publicJobService: f.jobs, careerPacketService: f.service, session: { nonce: 'fixture-paired-session' }, idempotencyKey: 'fixture-route-packet', stillAuthorized() { if (!authorized) throw new Error('Revoked fixture'); }, privateBody: async (allowed, required, max) => { reads++; assert.ok(max <= 64000); assert.ok(Object.keys(body).every(key => allowed.includes(key))); assert.ok(required.every(key => Object.hasOwn(body, key))); return body; }, ...extra });
  assert.equal(await invoke('/unrelated', 'GET'), null); for (const session of [null, {}, { nonce: '' }]) await assert.rejects(invoke('/career-packets/state', 'GET', {}, { session }), { code: 'AUTH_REQUIRED' });
  const created = await invoke('/career-packets', 'POST', f.body); assert.equal(created.status, 201); const packet = created.data.packet;
  const reviewed = (await invoke(`/career-packets/items/${packet.id}/review`, 'POST', review(packet))).data.packet;
  assert.equal((await invoke(`/career-packets/items/${packet.id}/export-json`, 'POST', review(reviewed))).status, 200);
  for (const action of ['submit', 'upload', 'fill-form', 'send', 'model']) assert.equal(await invoke(`/career-packets/items/${packet.id}/${action}`, 'POST'), null);
  authorized = false; await assert.rejects(invoke(`/career-packets/items/${packet.id}/export-json`, 'POST', review(reviewed)), /Revoked fixture/); assert.equal(f.calls.length, 2); assert.equal(f.store.listTasks().length, 0); assert.ok(reads >= 3);
});

test('CPS15: legacy observed public-role receipt and dismissed shortlist stay source-selectable; state pins exactly authorize preparation', async t => {
  const f = await setup(t), role = f.store.getWorkspaceRecord(f.roleRecord.id), data = { ...role.data }; delete data.source_request;
  f.store.updateWorkspaceRecord(role.id, { expected_revision: role.revision, data }); const current = f.jobs.get(role.id).role;
  f.jobs.shortlist(current.id, { expected_revision: current.revision, state: 'dismissed', note: 'A human decision, not source closure.' });
  const offered = f.service.state().roles[0]; assert.equal(offered.id, role.id);
  const packet = f.service.prepare({ ...f.body, role_ref: { id: offered.id, revision: offered.revision, source_sha256: offered.source_sha256 } }, { idempotencyKey: 'fixture-legacy-receipt' }).packet;
  assert.equal(packet.stale, false); assert.deepEqual(packet.data.payload.job.source_request, role.data.request);
});

test('CPS16: explicit valid confirmed typed email resolves only its exact selected contact field; absent/conflicting/invalid email is never inferred', async t => {
  const f = await setup(t), email = f.fact('email', 'student@example.edu'), question = { id: 'email', prompt: 'Contact email', required: true, fact_field: 'email', fact_ids: [email.id], draft_answer: email.data.value };
  const body = { ...f.body, profile_refs: [...f.body.profile_refs, pin(email)], questions: [question] }, packet = f.service.prepare(body, { idempotencyKey: 'fixture-email-packet' }).packet;
  assert.equal(packet.data.payload.questions[0].answer, 'student@example.edu'); assert.equal(packet.data.payload.missing.required.some(item => item.key === 'email'), false); assert.equal(packet.checklist_complete, true);
  for (const value of ['student@example.edu,other@example.edu', 'student@example.edu\nBcc: x@example.edu', 'student@localhost', 'student..test@example.edu']) assert.throws(() => f.fact('email', value), { code: 'INVALID_INPUT' });
  const absent = f.service.prepare({ ...f.body, questions: [{ ...question, fact_ids: [], draft_answer: null }] }, { idempotencyKey: 'fixture-email-absent' }).packet; assert.ok(absent.data.payload.missing.required.some(item => item.key === 'email')); assert.equal(absent.data.payload.questions[0].answer, null);
  f.fact('email', 'other@example.edu'); assert.equal(f.service.state().facts.some(item => item.field === 'email'), false); assert.throws(() => f.service.review(packet.id, review(packet)), { code: 'CONSENT_REQUIRED' });
  const forged = f.store.createWorkspaceRecord({ kind: 'profile_fact', title: 'malformed stored email', data: { ...email.data, value: 'invalid email' } }); assert.throws(() => f.service.prepare({ ...f.body, profile_refs: [pin(forged)] }, { idempotencyKey: 'fixture-invalid-email' }), { code: 'CONSENT_REQUIRED' });
});

test('CPS17: exact private packet forgetting works after source revocation without deleting selected source/profile/writing or resurrecting an old review', async t => {
  const f = await setup(t), packet = f.service.prepare(f.body, { idempotencyKey: 'fixture-forget-packet' }).packet, reviewed = f.service.review(packet.id, review(packet)).packet, before = { docs: f.store.listDocuments(), profiles: f.store.listWorkspaceRecords({ kind: 'profile_fact' }), writing: f.store.listWorkspaceRecords({ kind: 'artifact' }) };
  f.advance(PUBLIC_JOB_LIMITS.freshnessMs); assert.equal(f.service.get(packet.id).packet.stale, true);
  assert.throws(() => f.service.forget(packet.id, review(packet)), { code: 'REVISION_CONFLICT' }); assert.throws(() => f.service.forget(packet.id, { ...review(reviewed), payload_hash: 'f'.repeat(64) }), { code: 'REVISION_CONFLICT' });
  const result = f.service.forget(packet.id, review(reviewed)); assert.equal(result.deleted, true); assert.match(result.retention, /backups and downloaded copies/);
  assert.throws(() => f.service.get(packet.id), { code: 'SCOPE_DENIED' }); assert.equal(f.service.state().packets.length, 0); assert.deepEqual({ docs: f.store.listDocuments(), profiles: f.store.listWorkspaceRecords({ kind: 'profile_fact' }), writing: f.store.listWorkspaceRecords({ kind: 'artifact' }) }, before);
});

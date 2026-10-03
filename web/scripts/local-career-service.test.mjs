import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { createCareerWorkspace } from '../apps/local-runtime/src/career-service.mjs';
import { handleCareerRoute } from '../apps/local-runtime/src/career-routes.mjs';
import { profileCandidate, profileHash, reviewProfileFact } from '../apps/local-runtime/src/profile.mjs';
import { applicationReviewHash } from '../apps/local-runtime/src/career.mjs';

const now = '2026-10-03T16:00:00.000Z';
const roleInput = { company: 'Fixture Company', provider_job_id: '123', title: 'Software Engineering Intern',
  url: 'https://jobs.lever.co/fixture/123', locations: ['Toronto'], term: 'Summer 2027', source_kind: 'official',
  source_excerpt: 'Official fixture internship posting reviewed by the fixture student.', availability: 'open' };
const question = { id: 'experience', prompt: 'Describe relevant experience', fact_key: 'experience', required: true, max_length: 1000 };

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'learnbridge-career-service-')), root = join(base, 'private');
  const store = LocalStore.open({ root, timezone: 'America/Toronto' });
  const service = createCareerWorkspace(store, { clock: () => now });
  t.after(() => { try { store.close(); } catch {} rmSync(base, { recursive: true, force: true }); });
  return { base, root, store, service };
}
function profile(store, field, value, { confirmed = true, purposes, evidence } = {}) {
  let data = profileCandidate({ field, value, ...(purposes ? { purposes } : {}), ...(evidence ? { evidence } : {}) },
    { now, resolveEvidence: id => store.getDocument(id) });
  if (confirmed) data = reviewProfileFact(data, { decision: 'confirm', fingerprint: profileHash(data) }, { now, reviewer: store.identity.student_id });
  return store.createWorkspaceRecord({ kind: 'profile_fact', title: field, data });
}
function setup(t) {
  const f = fixture(t);
  const experience = profile(f.store, 'experience', 'Built a synthetic scheduling tool using TypeScript.');
  const role = f.service.createRole(roleInput, { idempotencyKey: 'fixture-role-0001' });
  return { ...f, experience, role };
}
const applicationInput = (role, experience) => ({ role_id: role.id, selected_profile_ids: [experience.id], questions: [question] });

test('career service persists manual role/shortlist and retry survives a distinct process without duplicates', t => {
  const { root, store, service } = fixture(t);
  const role = service.createRole(roleInput, { idempotencyKey: 'fixture-role-0001' });
  const shortlisted = service.changeShortlist(role.id, { expected_revision: 1, state: 'preparing' });
  assert.equal(shortlisted.revision, 2);
  assert.equal(service.listRoles()[0].view.verified_opening, false);
  assert.match(service.listRoles()[0].view.verification_notice, /not fetched or verified/);
  store.close();
  const storageURL = new URL('../packages/local-storage/src/index.mjs', import.meta.url).href;
  const serviceURL = new URL('../apps/local-runtime/src/career-service.mjs', import.meta.url).href;
  const source = `import {LocalStore} from ${JSON.stringify(storageURL)}; import {createCareerWorkspace} from ${JSON.stringify(serviceURL)}; const s=LocalStore.open({root:${JSON.stringify(root)}}); const c=createCareerWorkspace(s,{clock:()=>${JSON.stringify(now)}}); const item=c.createRole(${JSON.stringify(roleInput)},{idempotencyKey:'fixture-role-0001'}); console.log(JSON.stringify({item,count:c.listRoles().length,integrity:s.integrity().integrity})); s.close();`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 10000,
    env: { PATH: process.env.PATH, TMPDIR: tmpdir() }, maxBuffer: 256000 });
  assert.equal(result.status, 0, result.stderr); assert.ifError(result.error);
  const saved = JSON.parse(result.stdout); assert.deepEqual(saved.item, shortlisted); assert.equal(saved.count, 1); assert.equal(saved.integrity, 'ok');
});

test('creation idempotency rejects changed payload and same posting identity is never silently overwritten', t => {
  const { service, role } = setup(t);
  assert.equal(service.createRole(roleInput, { idempotencyKey: 'fixture-role-0001' }).id, role.id);
  assert.throws(() => service.createRole({ ...roleInput, title: 'Changed title' }, { idempotencyKey: 'fixture-role-0001' }), { code: 'REVISION_CONFLICT' });
  assert.throws(() => service.createRole({ ...roleInput, title: 'Changed title' }, { idempotencyKey: 'fixture-role-0002' }), { code: 'REVISION_CONFLICT' });
  assert.throws(() => service.createRole(roleInput), { code: 'INVALID_INPUT' });
  assert.equal(service.listRoles().length, 1);
});

test('career facts require reviewed/current/purpose-appropriate profile fields and never infer eligibility', t => {
  const { store, service } = fixture(t);
  const confirmed = profile(store, 'experience', 'Synthetic experience.');
  profile(store, 'experience', 'Unreviewed conflicting candidate.', { confirmed: false });
  profile(store, 'eligibility', 'I have some unspecified work eligibility.');
  profile(store, 'university', 'Fixture University', { purposes: ['learning'] });
  profile(store, 'pronouns', 'Synthetic pronouns');
  assert.deepEqual(service.listFacts().map(f => [f.id, f.key, f.value]), [[confirmed.id, 'experience', confirmed.data.value]]);
  profile(store, 'experience', 'Contradictory reviewed experience.');
  assert.equal(service.listFacts().length, 0);
});

test('reviewed application package persists exact answers and no submissions; repeated review is idempotent', t => {
  const { store, service, role, experience } = setup(t);
  const draft = service.prepareApplication(applicationInput(role, experience), { idempotencyKey: 'fixture-application-0001' });
  assert.equal(draft.data.draft.answers[0].answer, experience.data.value);
  assert.equal(draft.data.draft.state, 'ready_for_review');
  const input = { expected_revision: 1, review_hash: applicationReviewHash(draft.data.draft), decision: 'accept' };
  const accepted = service.reviewApplication(draft.id, input);
  assert.equal(accepted.data.draft.state, 'reviewed_draft');
  assert.equal(accepted.data.draft.submission, 'unsupported');
  assert.deepEqual(service.reviewApplication(draft.id, input), accepted);
  assert.equal(store.getWorkspaceRecord(draft.id).revision, 2);
  assert.equal(store.listTasks().length, 0);
});

test('missing facts remain explicit and profile change/revocation invalidates exact old draft review', t => {
  const { store, service, role, experience } = setup(t);
  const missing = service.prepareApplication({ ...applicationInput(role, experience), questions: [question,
    { id: 'authorization', prompt: 'Work authorization?', fact_key: 'work_authorization', required: true }] }, { idempotencyKey: 'fixture-application-missing' });
  assert.equal(missing.data.draft.state, 'blocked'); assert.equal(missing.data.draft.answers[1].answer, null);
  assert.throws(() => service.reviewApplication(missing.id, { expected_revision: 1, review_hash: applicationReviewHash(missing.data.draft), decision: 'accept' }), { code: 'CONSENT_REQUIRED' });
  const draft = service.prepareApplication(applicationInput(role, experience), { idempotencyKey: 'fixture-application-valid' });
  store.updateWorkspaceRecord(experience.id, { expected_revision: 1, data: { ...experience.data, value: 'Changed factual experience.' } });
  assert.equal(service.listApplications().find(record => record.id === draft.id).needs_refresh, true);
  assert.throws(() => service.reviewApplication(draft.id, { expected_revision: 1, review_hash: applicationReviewHash(draft.data.draft), decision: 'accept' }), { code: 'REVISION_CONFLICT' });
  const latest = store.getWorkspaceRecord(experience.id); store.deleteWorkspaceRecord(experience.id, latest.revision);
  assert.throws(() => service.prepareApplication(applicationInput(role, experience), { idempotencyKey: 'fixture-application-forgotten' }), { code: 'CONSENT_REQUIRED' });
});

test('document-backed career facts become unavailable when the exact source revision changes', t => {
  const { store, service } = fixture(t);
  const saved = store.createDocument({ title: 'Synthetic resume fact', text: 'Built a synthetic project.' });
  const fact = profile(store, 'experience', 'Built a synthetic project.', { evidence: { kind: 'document', id: saved.document.id,
    revision: saved.document.revision, sha256: saved.sha256, excerpt: saved.text } });
  assert.equal(service.listFacts()[0].id, fact.id);
  store.updateDocument(saved.document.id, { text: 'Changed source fact.' }, saved.document.revision);
  assert.equal(service.listFacts().length, 0);
});

test('practice pauses/restarts/restores at the next actual student answer; no fake execution result accepted', async t => {
  const { base, store, service } = fixture(t);
  let saved = service.startPractice({ exercise_id: 'mock', title: 'Fixture interview', mode: 'mock_interview',
    questions: [1, 2, 3].map(index => ({ id: `q${index}`, prompt: `Question ${index}` })) }, { idempotencyKey: 'fixture-practice-0001' });
  assert.throws(() => service.answerPractice(saved.id, { expected_revision: 1, question_id: 'q1', student_answer: 'Fixture answer', execution: { passed: true } }), { code: 'INVALID_INPUT' });
  saved = service.answerPractice(saved.id, { expected_revision: 1, question_id: 'q1', student_answer: 'Student answer one.' });
  saved = service.answerPractice(saved.id, { expected_revision: 2, question_id: 'q2', student_answer: 'Student answer two.', hints_used: 1 });
  saved = service.transitionPractice(saved.id, { expected_revision: 3, action: 'interrupt' });
  await store.backup(join(base, 'backup')); store.close();
  await LocalStore.restore({ backupRoot: join(base, 'backup'), root: join(base, 'restored') });
  const restored = LocalStore.open({ root: join(base, 'restored') });
  try {
    const restoredService = createCareerWorkspace(restored, { clock: () => now });
    const resumed = restoredService.transitionPractice(saved.id, { expected_revision: 4, action: 'resume' });
    assert.equal(resumed.data.practice.attempts.length, 2);
    assert.equal(resumed.data.practice.checkpoint.next_question_id, 'q3');
    assert.equal(resumed.data.practice.attempts[1].outcome, 'not_assessed');
    assert.equal(restored.integrity().integrity, 'ok');
  } finally { restored.close(); }
});

test('follow-up remains unsent; exact review creates one persistent reminder task even on retry', t => {
  const { store, service, role, experience } = setup(t);
  const app = service.prepareApplication(applicationInput(role, experience), { idempotencyKey: 'fixture-application-followup' });
  const body = { application_id: app.id, contact_id: 'fixture-contact', recipient: 'Fixture recruiting contact', channel: 'email',
    selected_profile_ids: [experience.id], remind_at: '2026-10-06T16:00:00.000Z' };
  const followup = service.prepareFollowup(body, { idempotencyKey: 'fixture-followup-0001' });
  assert.equal(store.listTasks().length, 0); assert.equal(followup.data.followup.sending, 'unsupported');
  const latest = service.listFollowups()[0];
  const review = { expected_revision: latest.revision, followup_hash: latest.followup_hash };
  const accepted = service.acceptReminder(latest.id, review);
  assert.deepEqual(service.acceptReminder(latest.id, review), accepted);
  assert.equal(store.listTasks().length, 1);
  const task = store.getTask(accepted.data.reminder_task.id);
  assert.equal(task.title, 'Follow up with Fixture recruiting contact');
  assert.equal(task.deadline.instant, body.remind_at);
  assert.throws(() => service.acceptReminder(latest.id, { expected_revision: accepted.revision, followup_hash: 'a'.repeat(64) }), { code: 'REVISION_CONFLICT' });
});

test('career routes validate their exact method/schema and cannot submit, send, accept host execution or arbitrary workspace records', async t => {
  const { store, service } = fixture(t);
  let bodyReads = 0;
  const invoke = (route, method, body = {}) => handleCareerRoute({ route, method, store, service, idempotencyKey: 'fixture-route-0001', privateBody: async (allowed, required, maxBytes) => {
    bodyReads++; assert(maxBytes <= 64000);
    assert(Object.keys(body).every(key => allowed.includes(key))); assert(required.every(key => Object.hasOwn(body, key)));
    return body;
  } });
  assert.equal(await invoke('/unrelated', 'GET'), null);
  const created = await invoke('/career/roles', 'POST', roleInput); assert.equal(created.status, 201);
  assert.equal((await invoke('/career/roles', 'GET')).data.items.length, 1);
  await assert.rejects(invoke('/career/roles', 'DELETE'), error => error.status === 405);
  await assert.rejects(invoke(`/career/applications/${randomUUID()}/submit`, 'POST'), error => error.status === 404);
  await assert.rejects(invoke(`/career/followups/${randomUUID()}/send`, 'POST'), error => error.status === 404);
  await assert.rejects(invoke(`/career/roles/${randomUUID()}/review`, 'POST'), error => error.status === 404);
  assert.equal(bodyReads, 1);
  assert.equal(store.listTasks().length, 0);
});

test('career UI uses safe text DOM and a logout generation guard, with no external network or submission', () => {
  const source = readFileSync(new URL('../apps/local/public/career.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function|localStorage|sessionStorage|\.style\.|fetch\(/);
  assert.match(source, /generation !== state\.generation/);
  assert.match(source, /state\.generation\+\+/);
  assert.match(source, /source_kind === 'lead'/);
  assert.match(source, /Nothing here submits or sends/);
});

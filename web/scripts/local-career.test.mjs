import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  careerHash, canonicalCareerURL, normalizeCareerRole, careerRoleView, updateCareerAvailability,
  deduplicateCareerRoles, compareCareerEligibility, shortlistCareerRole, prepareCareerApplication,
  applicationReviewHash, reviewCareerApplication, startCareerPractice, recordCareerAnswer,
  transitionCareerPractice, prepareCareerFollowup,
} from '../apps/local-runtime/src/career.mjs';

const now = '2026-10-03T16:00:00.000Z';
const later = '2026-10-04T16:00:00.000Z';
const baseRole = {
  provider: 'greenhouse', company: 'Fixture Company', provider_job_id: '123', title: 'Software Engineering Intern',
  url: 'https://boards.greenhouse.io/fixture/jobs/123?utm_source=fixture', locations: ['Toronto'], term: 'Summer 2027',
  source_kind: 'official', source_excerpt: 'Graduate between 2027-04-01 and 2028-08-31. Authorized to work in Canada. Minimum GPA 3.0/4.0.',
  fetched_at: now, availability: 'open', requirements: [
    { field: 'graduation_date', operator: 'between', value: { from: '2027-04-01', to: '2028-08-31' }, raw_text: 'Graduate between 2027-04-01 and 2028-08-31.' },
    { field: 'work_authorization', operator: 'equals', value: 'Canada', raw_text: 'Authorized to work in Canada.' },
    { field: 'gpa', operator: 'at_least', value: { minimum: 3, scale: 4 }, raw_text: 'Minimum GPA 3.0/4.0.' },
  ],
};
const role = change => normalizeCareerRole({ ...baseRole, ...change }, { now });
const fact = (id, key, value, change = {}) => ({ id, revision: 1, key, value, confirmed: true,
  evidence: { kind: 'student_statement' }, ...change });
const experience = fact('experience-1', 'experience', 'Built a fixture scheduling app using TypeScript.');
const education = fact('education-1', 'education', 'Studying software engineering at Fixture University.');
const questions = [
  { id: 'experience', prompt: 'Describe relevant experience.', fact_key: 'experience', required: true, max_length: 200 },
  { id: 'gpa', prompt: 'What is your GPA?', fact_key: 'gpa', required: false },
  { id: 'authorization', prompt: 'Are you authorized to work here?', fact_key: 'work_authorization', required: true },
];
function readyDraft(extra = {}) {
  const current = role();
  const facts = [experience, education];
  const draft = prepareCareerApplication(current, { questions: questions.slice(0, 1), facts,
    selected_fact_ids: ['experience-1'], ...extra }, { now });
  return { current, facts, draft };
}
function reviewOptions(current, facts, extra = {}) {
  return { now, reviewer: 'paired-human', resolveRole: id => id === current.id ? current : null,
    resolveFact: id => facts.find(fact => fact.id === id), ...extra };
}
const accept = draft => ({ expected_revision: draft.revision, review_hash: applicationReviewHash(draft), decision: 'accept' });

test('role identities preserve same-title different jobs and deduplicate repeated provider identities', () => {
  const first = role();
  const repeated = role({ url: 'https://boards.greenhouse.io/fixture/jobs/123?utm_campaign=other' });
  const different = role({ provider_job_id: '124', url: 'https://boards.greenhouse.io/fixture/jobs/124' });
  const crossPosted = role({ provider: 'manual', provider_job_id: 'public-123', url: first.url });
  const result = deduplicateCareerRoles([first, repeated, different, crossPosted]);
  assert.equal(result.roles.length, 3);
  assert.notEqual(first.id, different.id);
  assert.equal(first.id, repeated.id);
  assert.equal(result.possible_duplicates.length, 1);
  assert.equal(result.possible_duplicates[0].decision, 'needs_review');
});

test('official URL canonicalization strips tracking and rejects credential, private and ambiguous queries', () => {
  assert.equal(canonicalCareerURL('https://jobs.lever.co/fixture/role/?utm_source=board&fbclid=fixture'), 'https://jobs.lever.co/fixture/role');
  assert.equal(canonicalCareerURL('https://example-company.com/jobs?job_id=123&gh_jid=456'), 'https://example-company.com/jobs?gh_jid=456&job_id=123');
  for (const url of [
    'https://user:password@jobs.lever.co/fixture/123', 'http://jobs.lever.co/fixture/123',
    'https://jobs.lever.co/fixture/123?token=private', 'https://jobs.lever.co/fixture/123?email=private',
    'https://jobs.lever.co/fixture/123?state=oauth', 'https://jobs.lever.co/fixture/123?unknown=secret',
    'https://jobs.lever.co/fixture/123?job_id=1&job_id=2', 'https://localhost/jobs/1',
    'https://127.0.0.1/jobs/1', 'https://company.invalid/jobs/1', 'https://jobs.lever.co/fixture/123#token',
    'https://jobs.lever.co/%0Asecret', 'https://jobs.lever.co/%zz',
  ]) assert.throws(() => canonicalCareerURL(url), error => error.code === 'INVALID_INPUT');
});

test('eligibility uses literal confirmed dates, explicit GPA scale and preserves missing authorization', () => {
  const comparisons = compareCareerEligibility(role(), { now,
    facts: [fact('grad', 'graduation_date', '2028-05-01'), fact('gpa', 'gpa', '3.5/4')] });
  assert.deepEqual(comparisons.map(item => item.result), ['known_match', 'needs_confirmation', 'known_match']);
  const mismatch = compareCareerEligibility(role(), { now,
    facts: [fact('grad', 'graduation_date', '2029-05-01'), fact('gpa', 'gpa', '3.5/5')] });
  assert.deepEqual(mismatch.map(item => item.result), ['known_mismatch', 'needs_confirmation', 'needs_confirmation']);
  assert.equal(compareCareerEligibility(role(), { now, facts: [fact('gpa', 'gpa', '3.5')] })[2].result, 'needs_confirmation');
  assert.throws(() => compareCareerEligibility(role(), { now, facts: [fact('grad', 'graduation_date', '2028-05-01', { confirmed: false })] }),
    error => error.code === 'CONSENT_REQUIRED');
  assert.throws(() => role({ requirements: [{ field: 'work_authorization', operator: 'equals', value: 'USA', raw_text: 'Invented visa permission.' }] }),
    error => error.code === 'SCOPE_DENIED');
});

test('unverified leads never get opening badges; stale/expired evidence is accurately labeled', () => {
  const lead = role({ provider: 'lead', source_kind: 'lead', availability: 'unknown', url: 'https://student-jobs.org/123' });
  assert.equal(careerRoleView(lead, { now }).verified_opening, false);
  assert.equal(lead.official_url, null);
  assert.equal(careerRoleView(role(), { now: '2026-10-11T16:00:00.000Z' }).stale, true);
  assert.equal(careerRoleView(role({ deadline_at: now }), { now }).expired, true);
  assert.equal(careerRoleView(role({ deadline_at: now }), { now }).verified_opening, false);
});

test('timeout retains last availability and explicit closure records new authoritative evidence', () => {
  const current = role();
  const timedOut = updateCareerAvailability(current, { result: 'timeout', checked_at: later }, { now: later });
  assert.equal(timedOut.availability, 'open');
  assert.equal(timedOut.fetched_at, now);
  assert.equal(careerRoleView(timedOut, { now: later }).stale, true);
  const closed = updateCareerAvailability(timedOut, { result: 'explicit_close', checked_at: later,
    source_excerpt: 'This official posting has closed.' }, { now: later });
  assert.equal(closed.availability, 'closed');
  assert.equal(closed.fetched_at, later);
  assert.equal(closed.history.length, 2);
  assert.equal(closed.history[0].availability, 'open');
  assert.throws(() => updateCareerAvailability(closed, { result: 'open', checked_at: now, source_excerpt: 'Old page' }, { now: later }),
    error => error.code === 'REVISION_CONFLICT');
});

test('shortlist changes are revisioned decisions and discovery cannot claim applied', () => {
  const saved = shortlistCareerRole(role(), { state: 'saved' }, { now });
  const preparing = shortlistCareerRole(role(), { state: 'preparing', expected_revision: saved.revision }, { now, prior: saved });
  assert.equal(preparing.revision, 2);
  assert.throws(() => shortlistCareerRole(role(), { state: 'dismissed', expected_revision: 1 }, { now, prior: preparing }),
    error => error.code === 'REVISION_CONFLICT');
  assert.throws(() => shortlistCareerRole(role(), { state: 'applied' }, { now }), error => error.code === 'UNSUPPORTED');
});

test('application answers are exact selected confirmed facts; missing GPA and authorization remain explicit', () => {
  const draft = prepareCareerApplication(role(), { questions, facts: [experience, education], selected_fact_ids: ['experience-1'] }, { now });
  assert.equal(draft.answers[0].answer, experience.value);
  assert.equal(draft.answers[1].answer, null);
  assert.equal(draft.answers[2].answer, null);
  assert.equal(draft.state, 'blocked');
  assert.equal(draft.submission, 'unsupported');
  assert.deepEqual(draft.unresolved.map(item => item.fact_key), ['gpa', 'work_authorization']);
  assert.throws(() => reviewCareerApplication(draft, accept(draft), reviewOptions(role(), [experience, education])),
    error => error.code === 'CONSENT_REQUIRED');
  assert.throws(() => prepareCareerApplication(role(), { questions: [questions[0]], facts: [experience], selected_fact_ids: ['unselected-id'] }, { now }),
    error => error.code === 'SCOPE_DENIED');
  assert.throws(() => prepareCareerApplication(role(), { questions: [questions[0]], facts: [experience], selected_fact_ids: ['experience-1'], answer: 'Improved outcomes 99%' }, { now }),
    error => error.code === 'INVALID_INPUT');
});

test('sensitive disclosures require explicit student-stated facts and are never inferred from name or education', () => {
  const disclosure = { id: 'disclosure', prompt: 'Protected veteran status?', fact_key: 'veteran_status', required: false };
  const draft = prepareCareerApplication(role(), { questions: [disclosure], facts: [fact('name', 'full_name', 'Fixture Student'), education],
    selected_fact_ids: ['name', 'education-1'] }, { now });
  assert.equal(draft.answers[0].answer, null);
  const derived = fact('veteran', 'veteran_status', 'Not a protected veteran', { evidence: { kind: 'document', ref: 'resume',
    sha256: 'a'.repeat(64), excerpt: 'Fixture Student' } });
  assert.throws(() => prepareCareerApplication(role(), { questions: [disclosure], facts: [derived], selected_fact_ids: ['veteran'] }, { now }),
    error => error.code === 'CONSENT_REQUIRED');
  const explicit = fact('veteran', 'veteran_status', 'Prefer not to disclose');
  assert.equal(prepareCareerApplication(role(), { questions: [disclosure], facts: [explicit], selected_fact_ids: ['veteran'] }, { now }).answers[0].answer, explicit.value);
});

test('field length/conflicting facts and unsupported roles cannot produce an automatically ready package', () => {
  const tooShort = prepareCareerApplication(role(), { questions: [{ ...questions[0], max_length: 5 }], facts: [experience], selected_fact_ids: [experience.id] }, { now });
  assert.equal(tooShort.answers[0].answer, null);
  assert.equal(tooShort.unresolved[0].reason, 'answer_exceeds_field_limit');
  const conflicting = prepareCareerApplication(role(), { questions: [{ id: 'grad', prompt: 'Graduation date?', fact_key: 'graduation_date', required: true }],
    facts: [fact('grad-1', 'graduation_date', '2027-05-01'), fact('grad-2', 'graduation_date', '2028-05-01')], selected_fact_ids: ['grad-1', 'grad-2'] }, { now });
  assert.equal(conflicting.unresolved[0].reason, 'conflicting_confirmed_facts');
  const closed = role({ availability: 'closed' });
  assert.equal(prepareCareerApplication(closed, { questions: [questions[0]], facts: [experience], selected_fact_ids: [experience.id] }, { now }).state, 'blocked');
});

test('exact review checks current posting/fact pins and refuses unsupported invented text even with its new hash', () => {
  const { current, facts, draft } = readyDraft();
  const accepted = reviewCareerApplication(draft, accept(draft), reviewOptions(current, facts));
  assert.equal(accepted.state, 'reviewed_draft');
  assert.equal(accepted.submission, 'unsupported');
  assert.equal(accepted.revision, 2);
  assert.equal(accepted.review.payload_hash, applicationReviewHash(draft));
  const changed = structuredClone(draft); changed.answers[0].answer = 'Invented revenue increase of 99%.';
  assert.throws(() => reviewCareerApplication(changed, accept(draft), reviewOptions(current, facts)), error => error.code === 'REVISION_CONFLICT');
  assert.throws(() => reviewCareerApplication(changed, accept(changed), reviewOptions(current, facts)), error => error.code === 'SCOPE_DENIED');
  assert.throws(() => reviewCareerApplication(draft, accept(draft), reviewOptions(current, facts.map(f => f.id === experience.id ? { ...f, revision: 2 } : f))),
    error => error.code === 'REVISION_CONFLICT');
  assert.throws(() => reviewCareerApplication(draft, accept(draft), reviewOptions(role({ availability: 'closed' }), facts)), error => error.code === 'REVISION_CONFLICT');
});

test('artifact review pins actual bytes and a new draft revision invalidates previous review', () => {
  const attachment = { id: 'resume-1', filename: 'resume.pdf', mime: 'application/pdf', size: 32, sha256: 'b'.repeat(64) };
  const current = role();
  const draft = prepareCareerApplication(current, { questions: [questions[0]], facts: [experience], selected_fact_ids: [experience.id], artifacts: [attachment] },
    { now, verifyArtifact: () => attachment });
  assert.equal(draft.state, 'ready_for_review');
  assert.throws(() => reviewCareerApplication(draft, accept(draft), reviewOptions(current, [experience], { verifyArtifact: () => ({ ...attachment, sha256: 'c'.repeat(64) }) })),
    error => error.code === 'REVISION_CONFLICT');
  const revised = prepareCareerApplication(current, { questions: [{ ...questions[0], prompt: 'Updated form question' }], facts: [experience], selected_fact_ids: [experience.id],
    expected_revision: draft.revision }, { now, prior: draft });
  assert.equal(revised.revision, 2); assert.equal(revised.review, null);
  assert.throws(() => reviewCareerApplication(revised, accept(draft), reviewOptions(current, [experience])), error => error.code === 'REVISION_CONFLICT');
  const unverified = prepareCareerApplication(current, { questions: [questions[0]], facts: [experience], selected_fact_ids: [experience.id], artifacts: [attachment] }, { now });
  assert.equal(unverified.state, 'blocked');
  assert.equal(unverified.unresolved[0].reason, 'artifact_not_verified');
});

function codeReceipt(studentAnswer) {
  // Actual isolated test-fixture execution, not a model-declared test result.
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', studentAnswer], {
    encoding: 'utf8', timeout: 3000, env: { PATH: '/usr/bin:/bin' }, maxBuffer: 8192,
  });
  assert.equal(result.error, undefined);
  return { state: 'executed', exit_code: result.status,
    tests: [{ name: 'fixture assertion', passed: result.status === 0 }],
    evidence_ref: `fixture:node-exit:${result.status}:output:${careerHash(result.stdout)}`,
    student_answer_hash: careerHash(studentAnswer) };
}
const practiceInput = { exercise_id: 'fixture-addition', title: 'Explain and test addition', mode: 'timed', questions: [{ id: 'q1', prompt: 'Write the fixture addition assertion.' }] };

test('actual passing/failing fixture code receipts preserve independent versus hinted outcomes', () => {
  const passing = 'if (2 + 2 !== 4) process.exit(1);';
  const failing = 'if (2 + 2 !== 5) process.exit(1);';
  const independent = recordCareerAnswer(startCareerPractice(practiceInput, { now }), {
    expected_revision: 1, question_id: 'q1', student_answer: passing }, { now, execution: codeReceipt(passing) });
  assert.equal(independent.attempts[0].outcome, 'independent_pass');
  assert.equal(independent.attempts[0].result.exit_code, 0);
  const hinted = recordCareerAnswer(startCareerPractice(practiceInput, { now }), {
    expected_revision: 1, question_id: 'q1', student_answer: passing, hints_used: 1 }, { now, execution: codeReceipt(passing) });
  assert.equal(hinted.attempts[0].outcome, 'passed_after_hints');
  const failed = recordCareerAnswer(startCareerPractice(practiceInput, { now }), {
    expected_revision: 1, question_id: 'q1', student_answer: failing }, { now, execution: codeReceipt(failing) });
  assert.equal(failed.attempts[0].outcome, 'failed');
  assert.equal(failed.attempts[0].result.exit_code, 1);
  assert.throws(() => recordCareerAnswer(startCareerPractice(practiceInput, { now }), {
    expected_revision: 1, question_id: 'q1', student_answer: failing }, { now, execution: codeReceipt(passing) }),
    error => error.code === 'REVISION_CONFLICT');
});

test('unexecuted answers are not assessed; browsing/activity and forged assessments are not answers', () => {
  const session = startCareerPractice(practiceInput, { now });
  const answered = recordCareerAnswer(session, { expected_revision: 1, question_id: 'q1', student_answer: 'I would test boundary values.' }, { now });
  assert.equal(answered.attempts[0].result.state, 'not_executed');
  assert.equal(answered.attempts[0].outcome, 'not_assessed');
  assert.throws(() => recordCareerAnswer(session, { expected_revision: 1, question_id: 'q1', activity: 'visited problem page' }, { now }),
    error => error.code === 'INVALID_INPUT');
  assert.throws(() => recordCareerAnswer(session, { expected_revision: 1, question_id: 'q1', student_answer: 'Answer', mastery: true }, { now }),
    error => error.code === 'INVALID_INPUT');
});

test('interrupted mock interview preserves two actual answers and resumes at unanswered question three', () => {
  let session = startCareerPractice({ exercise_id: 'mock', title: 'Fixture behavioral interview', mode: 'mock_interview',
    questions: [1, 2, 3].map(n => ({ id: `q${n}`, prompt: `Question ${n}` })) }, { now });
  session = recordCareerAnswer(session, { expected_revision: 1, question_id: 'q1', student_answer: 'First student answer.' }, { now });
  session = recordCareerAnswer(session, { expected_revision: 2, question_id: 'q2', student_answer: 'Second student answer.', hints_used: 2 }, { now });
  session = transitionCareerPractice(session, { expected_revision: 3, action: 'interrupt' }, { now });
  const restored = JSON.parse(JSON.stringify(session));
  session = transitionCareerPractice(restored, { expected_revision: 4, action: 'resume' }, { now: later });
  assert.equal(session.attempts.length, 2);
  assert.equal(session.attempts[1].hints_used, 2);
  assert.equal(session.checkpoint.next_question_id, 'q3');
  assert.deepEqual(session.checkpoint.answered_question_ids, ['q1', 'q2']);
  assert.equal(session.state, 'active');
  assert.throws(() => recordCareerAnswer(session, { expected_revision: 5, question_id: 'q2', student_answer: 'Duplicate answer' }, { now: later }),
    error => error.code === 'REVISION_CONFLICT');
});

test('follow-up is a source-backed unsent draft with chosen date; known retries preserve one logical reminder', () => {
  const input = { operation_id: 'followup_fixture_1', application_id: 'draft-fixture', contact_id: 'contact-fixture',
    recipient: 'Recruiting team', channel: 'email', fact_ids: [experience.id], remind_at: '2026-10-06T16:00:00.000Z' };
  const first = prepareCareerFollowup(input, { now, facts: [experience] });
  assert.equal(first.message, experience.value); assert.equal(first.state, 'draft'); assert.equal(first.sending, 'unsupported');
  assert.equal(first.reminder.origin, 'student_selected');
  assert.deepEqual(prepareCareerFollowup(input, { now: later, facts: [experience], prior: first }), first);
  assert.throws(() => prepareCareerFollowup({ ...input, remind_at: '2026-10-07T16:00:00.000Z' }, { now: later, facts: [experience], prior: first }),
    error => error.code === 'REVISION_CONFLICT');
  assert.throws(() => prepareCareerFollowup({ ...input, send: true }, { now, facts: [experience] }), error => error.code === 'INVALID_INPUT');
  assert.throws(() => prepareCareerFollowup({ ...input, remind_at: now }, { now, facts: [experience] }), error => error.code === 'INVALID_INPUT');
});

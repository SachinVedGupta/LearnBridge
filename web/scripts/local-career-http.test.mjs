import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'learnbridge-career-http-')), dataRoot = join(base, 'private'), runtimes = [];
  t.after(async () => { for (const runtime of runtimes.reverse()) await runtime.close(); await rm(base, { recursive: true, force: true }); });
  async function start() { const runtime = await startRuntime({ dataRoot, port: 0 }); runtimes.push(runtime); return runtime; }
  return { start, runtime: await start() };
}
async function pair(runtime) {
  const response = await fetch(`${runtime.origin}/api/local/v1/pair`, { method: 'POST', headers: { Origin: runtime.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: runtime.createPairingCode() }) });
  assert.equal(response.status, 200);
  return { nonce: (await response.json()).nonce, cookie: response.headers.get('set-cookie').split(';')[0] };
}
async function call(runtime, session, path, { method = 'GET', body, origin = runtime.origin, extraHeaders = {} } = {}) {
  const response = await fetch(`${runtime.origin}/api/local/v1${path}`, { method, headers: {
    ...(session ? { Cookie: session.cookie, 'X-LearnBridge-Nonce': session.nonce } : {}),
    ...(method === 'GET' ? {} : { Origin: origin, 'Content-Type': 'application/json' }), ...extraHeaders,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}
const roleInput = { company: 'Fixture Company', provider_job_id: 'fixture-123', title: 'Intern', url: 'https://jobs.lever.co/fixture/123',
  source_kind: 'official', source_excerpt: 'Student reviewed this synthetic official-source internship posting.', availability: 'open' };
const question = { id: 'experience', prompt: 'Describe relevant experience.', fact_key: 'experience', required: true };

test('paired career HTTP flow saves role/draft/review/practice/reminder and survives restart', async t => {
  const { runtime, start } = await fixture(t); let session = await pair(runtime);
  const createdProfile = await call(runtime, session, '/profile', { method: 'POST', body: { field: 'experience', value: 'Built a fixture TypeScript scheduling app.', purposes: ['career'] } });
  assert.equal(createdProfile.status, 201);
  const profileList = await call(runtime, session, '/profile'); const fact = profileList.data.items[0];
  assert.equal((await call(runtime, session, `/profile/${fact.id}/review`, { method: 'POST', body: { expected_revision: fact.revision, decision: 'confirm', fingerprint: fact.fingerprint } })).status, 200);
  const savedRole = await call(runtime, session, '/career/roles', { method: 'POST', body: roleInput, extraHeaders: { 'Idempotency-Key': 'http-fixture-role-0001' } });
  assert.equal(savedRole.status, 201); const role = savedRole.data.item;
  assert.equal((await call(runtime, session, '/career/roles')).data.items[0].view.verified_opening, false);
  const savedDraft = await call(runtime, session, '/career/applications', { method: 'POST', body: { role_id: role.id, selected_profile_ids: [fact.id], questions: [question] }, extraHeaders: { 'Idempotency-Key': 'http-fixture-application-0001' } });
  assert.equal(savedDraft.status, 201);
  const draft = (await call(runtime, session, '/career/applications')).data.items[0];
  const review = { expected_revision: draft.revision, review_hash: draft.review_hash, decision: 'accept' };
  assert.equal((await call(runtime, session, `/career/applications/${draft.id}/review`, { method: 'POST', body: review })).status, 200);
  assert.equal((await call(runtime, session, `/career/applications/${draft.id}/review`, { method: 'POST', body: review })).status, 200);
  const practice = (await call(runtime, session, '/career/practice', { method: 'POST', body: { exercise_id: 'mock', title: 'Fixture interview', mode: 'mock_interview',
    questions: [{ id: 'q1', prompt: 'First question' }, { id: 'q2', prompt: 'Second question' }] }, extraHeaders: { 'Idempotency-Key': 'http-fixture-practice-0001' } })).data.item;
  assert.equal((await call(runtime, session, `/career/practice/${practice.id}/answer`, { method: 'POST', body: { expected_revision: 1, question_id: 'q1', student_answer: 'My fixture student answer.', hints_used: 1 } })).status, 200);
  assert.equal((await call(runtime, session, `/career/practice/${practice.id}/transition`, { method: 'POST', body: { expected_revision: 2, action: 'interrupt' } })).status, 200);
  const followup = await call(runtime, session, '/career/followups', { method: 'POST', body: { application_id: draft.id, contact_id: 'fixture-contact', recipient: 'Fixture recruiter', channel: 'email',
    selected_profile_ids: [fact.id], remind_at: new Date(Date.now() + 7 * 86400000).toISOString() }, extraHeaders: { 'Idempotency-Key': 'http-fixture-followup-0001' } });
  assert.equal(followup.status, 201);
  assert.equal((await call(runtime, session, '/tasks')).data.items.length, 0);
  const reminder = (await call(runtime, session, '/career/followups')).data.items[0];
  const body = { expected_revision: reminder.revision, followup_hash: reminder.followup_hash };
  assert.equal((await call(runtime, session, `/career/followups/${reminder.id}/reminder`, { method: 'POST', body })).status, 200);
  assert.equal((await call(runtime, session, `/career/followups/${reminder.id}/reminder`, { method: 'POST', body })).status, 200);
  assert.equal((await call(runtime, session, '/tasks')).data.items.length, 1);
  await runtime.close();
  const restarted = await start(); session = await pair(restarted);
  const persisted = (await call(restarted, session, '/career/applications')).data.items[0];
  assert.equal(persisted.data.draft.state, 'reviewed_draft'); assert.equal(persisted.data.draft.submission, 'unsupported');
  const checkpoint = (await call(restarted, session, '/career/practice')).data.items[0];
  assert.equal(checkpoint.data.practice.state, 'interrupted'); assert.equal(checkpoint.data.practice.checkpoint.next_question_id, 'q2');
  assert.equal(checkpoint.data.practice.attempts.length, 1);
  assert.equal((await call(restarted, session, '/tasks')).data.items.length, 1);
});

test('career HTTP remains paired/origin/nonce bound and rejects query leaks, forged facts and send/submit operations', async t => {
  const { runtime } = await fixture(t);
  assert.equal((await call(runtime, null, '/career/roles')).status, 401);
  const session = await pair(runtime);
  assert.equal((await call(runtime, { ...session, nonce: 'forged' }, '/career/roles')).status, 403);
  assert.equal((await call(runtime, session, '/career/roles', { method: 'POST', body: roleInput, origin: 'https://hostile.invalid', extraHeaders: { 'Idempotency-Key': randomUUID() } })).status, 403);
  assert.equal((await call(runtime, session, '/career/roles?token=PRIVATE_QUERY_CANARY')).status, 400);
  assert.equal((await call(runtime, session, '/career/roles', { method: 'POST', body: { ...roleInput, student_id: 'forged-other-user' }, extraHeaders: { 'Idempotency-Key': randomUUID() } })).status, 400);
  assert.equal((await call(runtime, session, `/career/applications/${randomUUID()}/submit`, { method: 'POST', body: {} })).status, 404);
  assert.equal((await call(runtime, session, `/career/followups/${randomUUID()}/send`, { method: 'POST', body: {} })).status, 404);
  assert.equal((await call(runtime, session, '/career/roles')).data.items.length, 0);
  assert.equal((await call(runtime, session, '/logout', { method: 'POST', body: {} })).status, 200);
  assert.equal((await call(runtime, session, '/career/roles')).status, 401);
});

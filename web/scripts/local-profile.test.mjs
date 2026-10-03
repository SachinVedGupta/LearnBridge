import test from 'node:test';
import assert from 'node:assert/strict';
import { profileCandidate, profileContext, profileView, reviewProfileFact, profileHash } from '../apps/local-runtime/src/profile.mjs';
const now = '2026-10-03T12:00:00.000Z';
const make = (id, field, value) => {
  const fact = profileCandidate({ field, value }, { now });
  return { id, revision: 1, kind: 'profile_fact', data: reviewProfileFact(fact, { decision: 'confirm', fingerprint: profileHash(fact) }, { reviewer: 'fixture-student', now }) };
};
test('profile only confirms exact human-reviewed payload and corrections retain student provenance', () => {
  const fact = profileCandidate({ field: 'name', value: 'Student A' }, { now });
  assert.throws(() => reviewProfileFact(fact, { decision: 'confirm', fingerprint: profileHash({ ...fact, value: 'Changed' }) }, { reviewer: 'human', now }), e => e.code === 'REVISION_CONFLICT');
  const corrected = reviewProfileFact(fact, { decision: 'correct', value: 'Student B', fingerprint: profileHash(fact) }, { reviewer: 'human', now });
  assert.equal(corrected.value, 'Student B'); assert.equal(corrected.evidence.kind, 'student_statement');
  assert.equal(reviewProfileFact(fact, { decision: 'reject', fingerprint: profileHash(fact) }, { reviewer: 'human', now }).state, 'rejected');
});
test('conflicting confirmed graduation facts are omitted from career context', () => {
  const records = [make('a', 'graduation', '2027'), make('b', 'graduation', '2028')];
  assert.ok(profileView(records, { now }).every(r => r.conflict));
  assert.deepEqual(profileContext(records, { purpose: 'career', allowedIds: ['a', 'b'], now }), []);
});
test('learning context excludes selected financial, dietary and career eligibility fields', () => {
  const records = [make('a', 'learning_preferences', 'One example at a time'), make('b', 'budget_preferences', 'Private canary'), make('c', 'eligibility', 'Sensitive canary')];
  assert.deepEqual(profileContext(records, { purpose: 'learning', allowedIds: ['a', 'b', 'c'], now }).map(r => r.value), ['One example at a time']);
  assert.deepEqual(profileContext(records, { purpose: 'learning', allowedIds: [], now }), []);
});
test('source version change, deletion and expiry invalidate fact use without erasing history', () => {
  const source = { document: { revision: 2 }, sha256: 'a'.repeat(64), text: 'Graduation 2027 stated in selected document.' };
  const candidate = profileCandidate({ field: 'graduation', value: '2027', expires_at: '2026-10-04T12:00:00.000Z', evidence: { kind: 'document', id: 'document-id', revision: 2, sha256: source.sha256, excerpt: 'Graduation 2027' } }, { now, resolveEvidence: () => source });
  const record = { id: 'a', kind: 'profile_fact', data: reviewProfileFact(candidate, { decision: 'confirm', fingerprint: profileHash(candidate) }, { reviewer: 'human', now }) };
  for (const options of [{ now, resolveEvidence: () => ({ ...source, document: { revision: 3 } }) }, { now, resolveEvidence: () => null }, { now: '2026-10-05T12:00:00.000Z', resolveEvidence: () => source }]) {
    assert.deepEqual(profileContext([record], { ...options, purpose: 'career', allowedIds: ['a'] }), []);
    assert.equal(record.data.value, '2027');
  }
  assert.throws(() => profileCandidate({ field: 'graduation', value: '2027', evidence: { ...candidate.evidence, excerpt: 'Unsupported' } }, { now, resolveEvidence: () => source }), e => e.code === 'SCOPE_DENIED');
});
test('impossible calendar timestamps fail with a stable input error', () => {
  assert.throws(() => profileCandidate({ field: 'goals', value: 'Learn', expires_at: '2026-13-01T00:00:00.000Z' }, { now }), e => e.code === 'INVALID_INPUT');
});

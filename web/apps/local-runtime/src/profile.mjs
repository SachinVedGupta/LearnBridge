import { createHash } from 'node:crypto';
import { LearnBridgeError } from '@learnbridge/core';

const fields = Object.freeze({
  name: ['general', 'career'], email: ['career'], pronouns: ['general'], university: ['learning', 'career'],
  program: ['learning', 'career'], graduation: ['career'], experience: ['career'],
  goals: ['general', 'learning', 'career'], learning_preferences: ['learning'],
  timezone: ['general', 'learning'], availability: ['general', 'learning'],
  dietary_preferences: ['meals'], budget_preferences: ['budget'], eligibility: ['career'],
});
const fail = code => { throw new LearnBridgeError(code || 'INVALID_INPUT'); };
const stamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export const PROFILE_FIELDS = Object.freeze(Object.keys(fields));
export function profileHash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function object(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key => !keys.includes(key))) fail();
}
function text(value, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail();
  return value.trim();
}
function fieldValue(field, raw) {
  const value = text(raw);
  if (field === 'email') {
    // A single common ASCII address, explicitly supplied and reviewed by the student.
    // Validation is syntax only; it does not prove mailbox ownership or deliverability.
    if (value.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(value)
      || value.startsWith('.') || value.includes('..') || value.split('@')[0].endsWith('.')) fail();
  }
  return value;
}
export function profileCandidate(input, { now = new Date().toISOString(), resolveEvidence } = {}) {
  object(input, ['field', 'value', 'purposes', 'expires_at', 'evidence']);
  if (!PROFILE_FIELDS.includes(input.field) || !stamp(now)) fail();
  const value = fieldValue(input.field, input.value);
  const purposes = input.purposes ?? fields[input.field];
  if (!Array.isArray(purposes) || !purposes.length || purposes.length > 5 || new Set(purposes).size !== purposes.length || purposes.some(p => !fields[input.field].includes(p))) fail();
  const expires = input.expires_at ?? null;
  if (expires !== null && (!stamp(expires) || expires <= now)) fail();
  let evidence = { kind: 'student_statement', stated_at: now };
  if (input.evidence) {
    object(input.evidence, ['kind', 'id', 'revision', 'sha256', 'excerpt']);
    if (input.evidence.kind !== 'document' || !Number.isSafeInteger(input.evidence.revision) || input.evidence.revision < 1 || !/^[a-f0-9]{64}$/.test(input.evidence.sha256)) fail();
    const source = resolveEvidence?.(input.evidence.id);
    if (!source || source.document.revision !== input.evidence.revision || source.sha256 !== input.evidence.sha256) fail('REVISION_CONFLICT');
    const excerpt = text(input.evidence.excerpt, 1000);
    if (!source.text.includes(excerpt)) fail('SCOPE_DENIED');
    evidence = { ...input.evidence, excerpt };
  }
  return { schema_version: 1, field: input.field, value, purposes: [...purposes], state: 'candidate',
    evidence, expires_at: expires, review: null };
}
export function reviewProfileFact(fact, input, { reviewer, now = new Date().toISOString() } = {}) {
  object(input, ['decision', 'fingerprint', 'value']);
  if (!['confirm', 'reject', 'correct'].includes(input.decision) || !stamp(now) || typeof reviewer !== 'string') fail();
  if (input.fingerprint !== profileHash(fact)) fail('REVISION_CONFLICT');
  if (fact.state !== 'candidate' && input.decision !== 'correct') fail('REVISION_CONFLICT');
  if ((input.decision === 'correct') !== Object.hasOwn(input, 'value')) fail();
  if (input.decision === 'confirm') fieldValue(fact.field, fact.value);
  const result = { ...fact, state: input.decision === 'reject' ? 'rejected' : 'confirmed' };
  if (input.decision === 'correct') { result.value = fieldValue(fact.field, input.value); result.evidence = { kind: 'student_statement', stated_at: now }; }
  result.review = { reviewer, reviewed_at: now, decision: input.decision, candidate_hash: input.fingerprint };
  return result;
}
export function profileView(records, { now = new Date().toISOString(), resolveEvidence } = {}) {
  if (!stamp(now)) fail();
  const values = records.filter(r => r.kind === 'profile_fact' && !r.deleted_at).map(record => {
    const fact = record.data;
    let stale = fact.expires_at !== null && fact.expires_at <= now;
    if (fact.evidence.kind === 'document') {
      const source = resolveEvidence?.(fact.evidence.id);
      stale ||= !source || source.document.revision !== fact.evidence.revision || source.sha256 !== fact.evidence.sha256;
    }
    return { ...record, fingerprint: profileHash(fact), stale, conflict: false };
  });
  for (const field of PROFILE_FIELDS) {
    const current = values.filter(r => r.data.field === field && r.data.state === 'confirmed' && !r.stale);
    if (new Set(current.map(r => r.data.value)).size > 1) for (const record of current) record.conflict = true;
  }
  return values;
}
export function profileContext(records, { purpose, allowedIds, now, resolveEvidence } = {}) {
  if (!['general', 'learning', 'career', 'meals', 'budget'].includes(purpose) || !Array.isArray(allowedIds) || allowedIds.length > 100) fail();
  const allowed = new Set(allowedIds);
  return profileView(records, { now, resolveEvidence }).filter(r => allowed.has(r.id) && r.data.state === 'confirmed'
    && !r.stale && !r.conflict && r.data.purposes.includes(purpose)).map(r => ({ id: r.id, revision: r.revision,
      field: r.data.field, value: r.data.value, provenance: r.data.evidence }));
}

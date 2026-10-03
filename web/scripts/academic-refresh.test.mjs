import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AcademicError, normalizeAcademicExport } from '../packages/local-academic/src/index.mjs';
import { buildAcademicLibrary, searchAcademicLibrary, resolveAcademicCitation } from '../packages/local-academic/src/library.mjs';
import { TutoringError, prepareTutorSession, validateTutorResult } from '../packages/local-academic/src/tutoring.mjs';
import { academicRefreshScope, academicStreamKey, academicSemanticHash, academicRefreshPreview,
  validateAcademicRefreshPreview } from '../packages/local-academic/src/refresh.mjs';

const categories = ['courses', 'assignments', 'announcements', 'materials'];
const origin = 'https://refresh.fixture.test';
const time = ['2026-10-03T10:00:00Z', '2026-10-03T11:00:00Z', '2026-10-03T12:00:00Z'];
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const fingerprint = value => createHash('sha256').update(canonical(value)).digest('hex');
const copy = value => structuredClone(value);
const expectedError = (action, code = 'INVALID_INPUT') => assert.throws(action,
  error => error instanceof AcademicError && error.code === code);

function rawFixture(changes = {}) {
  return {
    schema_version: 1, institution: { name: 'Synthetic Refresh University', origin, timezone: 'America/Toronto' },
    account_ref: 'synthetic-refresh-student', retrieved_at: time[0],
    courses: [{ source_id: 'A', title: 'Synthetic course A' }, { source_id: 'B', title: 'Unselected course B' }],
    assignments: [{ source_id: 'HW1', course_id: 'A', title: 'Synthetic exercise', description: 'Try the exercise yourself.', due: '2026-10-10' }],
    announcements: [{ source_id: 'NEWS1', course_id: 'A', title: 'Synthetic office hours', body: 'Bring a concrete question.', published_at: time[0] }],
    materials: [{ source_id: 'NOTE1', course_id: 'A', title: 'Synthetic note one', body: 'IMMUTABLE_REFRESH_ALPHA explains a synthetic idea.' },
      { source_id: 'NOTE2', course_id: 'A', title: 'Synthetic note two', body: 'IMMUTABLE_REFRESH_BETA explains another synthetic idea.' }],
    coverage: Object.fromEntries(categories.map(category => [category, { state: 'complete' }])),
    ...changes,
  };
}

function snapshot(changes = {}, selectedCourseIds = ['A']) {
  return normalizeAcademicExport(rawFixture(changes), { selectedCourseIds });
}

function reseal(snapshotValue, { rows = false } = {}) {
  const value = copy(snapshotValue);
  if (rows) for (const category of categories) for (const row of value[category]) {
    if (!row || typeof row !== 'object') continue;
    const { source_hash, ...payload } = row; row.source_hash = fingerprint(payload);
  }
  const { snapshot_hash, changes, ...payload } = value;
  value.snapshot_hash = fingerprint(payload);
  return value;
}

function freeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); for (const item of Object.values(value)) freeze(item); }
  return value;
}

function search(library, query = 'IMMUTABLE_REFRESH_ALPHA') {
  return searchAcademicLibrary(library, { query, courseIds: ['A'], limit: 20 });
}

function baseline(value, changes = {}) {
  return { stream_key: academicStreamKey(value), head_id: '00000000-0000-4000-8000-000000000001', revision: 1,
    current_snapshot_id: '00000000-0000-4000-8000-000000000002', current_snapshot_hash: value.snapshot_hash,
    current_semantic_hash: academicSemanticHash(value), snapshot: value, ...changes };
}

function preview(next, prior = null) {
  return academicRefreshPreview(next, { baseline: prior === null ? null : baseline(prior) });
}

function ids(values) { return values.map(value => value.id).sort(); }

test('REFRESH01: stream identity binds account, institution and exact sorted selected/category scope', () => {
  const first = snapshot(), sorted = snapshot({}, ['B', 'A', 'B']);
  assert.deepEqual(academicRefreshScope(first), { institution_origin: origin, account_ref: 'synthetic-refresh-student',
    selected_course_ids: ['A'], category_scope: categories });
  assert.deepEqual(academicRefreshScope(sorted).selected_course_ids, ['A', 'B']);
  assert.equal(academicStreamKey(sorted), academicStreamKey(snapshot({}, ['A', 'B'])));
  assert.notEqual(academicStreamKey(first), academicStreamKey(sorted));
  assert.notEqual(academicStreamKey(first), academicStreamKey(snapshot({ account_ref: 'another-synthetic-student' })));
  assert.notEqual(academicStreamKey(first), academicStreamKey(snapshot({ institution: { name: 'Other synthetic institution',
    origin: 'https://other.refresh.fixture.test', timezone: 'America/Toronto' } })));
  assert.equal(academicStreamKey(first), academicStreamKey(snapshot({ institution: { ...rawFixture().institution,
    name: 'Renamed synthetic institution' } })), 'An institution display-name edit must not become a new account stream.');
});

test('REFRESH02: later retrieval, source traversal order and exact duplicates preserve semantic idempotency', () => {
  const first = snapshot(), raw = rawFixture({ retrieved_at: time[1] });
  raw.courses.reverse(); raw.materials.reverse(); raw.materials.push(copy(raw.materials[0]));
  const repeated = normalizeAcademicExport(raw, { selectedCourseIds: ['A'] });
  assert.notEqual(first.snapshot_hash, repeated.snapshot_hash);
  assert.equal(academicSemanticHash(first), academicSemanticHash(repeated));
  const result = preview(repeated, first);
  assert.equal(result.content_changed, false);
  assert.equal(result.snapshot.snapshot_hash, repeated.snapshot_hash);
  assert.equal(result.semantic_hash, academicSemanticHash(first));
  assert.equal(result.changes.unchanged.length, 5);
  for (const name of ['added', 'changed', 'not_returned', 'conflicted']) assert.deepEqual(result.changes[name], []);
  assert.equal(result.base.revision, 1); assert.equal(result.base.snapshot_hash, first.snapshot_hash);
  assert.doesNotThrow(() => validateAcademicRefreshPreview(result, { baseline: baseline(first) }));
});

test('REFRESH03: harmless valid unselected rows do not affect selected semantic state', () => {
  const first = snapshot(), raw = rawFixture({ retrieved_at: time[1] });
  raw.assignments.push({ source_id: 'B-HW', course_id: 'B', title: 'Unselected exercise', description: 'UNSELECTED_REFRESH_CANARY' });
  raw.materials.push({ source_id: 'B-NOTE', course_id: 'B', title: 'Unselected note', body: 'UNSELECTED_REFRESH_CANARY' });
  const withOutside = normalizeAcademicExport(raw, { selectedCourseIds: ['A'] });
  assert.equal(academicSemanticHash(first), academicSemanticHash(withOutside));
  const result = preview(withOutside, first); assert.equal(result.content_changed, false);
  assert.equal(JSON.stringify(result).includes('UNSELECTED_REFRESH_CANARY'), false);
  // The normalized safety diagnostics cannot prove a malformed row irrelevant.
  raw.assignments.push({ source_id: 'B-BAD', course_id: 'B' });
  const conservativelyPartial = normalizeAcademicExport(raw, { selectedCourseIds: ['A'] });
  assert.equal(conservativelyPartial.coverage.assignments.state, 'partial');
  assert.notEqual(academicSemanticHash(first), academicSemanticHash(conservativelyPartial));
  assert.equal(preview(conservativelyPartial, first).content_changed, true);
});

test('REFRESH04: first observation and exact deadline/body/addition/absence changes pin before/after evidence', () => {
  const first = snapshot(), initial = preview(first);
  assert.equal(initial.changes.added.length, 5);
  assert(initial.changes.added.every(change => change.before === null && change.after.snapshot_hash === first.snapshot_hash));
  const raw = rawFixture({ retrieved_at: time[1] }); raw.assignments[0].due = '2026-10-12';
  raw.materials = [{ ...raw.materials[0], body: 'A changed synthetic passage.' },
    { source_id: 'NOTE3', course_id: 'A', title: 'New synthetic note', body: 'A newly returned synthetic passage.' }];
  const next = normalizeAcademicExport(raw, { selectedCourseIds: ['A'] }); const result = preview(next, first);
  assert.equal(result.content_changed, true);
  assert.deepEqual(ids(result.changes.changed), [first.assignments[0].id,
    first.materials.find(value => value.source_id === 'NOTE1').id].sort());
  assert.deepEqual(ids(result.changes.added), [next.materials.find(value => value.source_id === 'NOTE3').id]);
  assert.deepEqual(ids(result.changes.not_returned), [first.materials.find(value => value.source_id === 'NOTE2').id]);
  assert.deepEqual(ids(result.changes.unchanged), [first.courses[0].id, first.announcements[0].id].sort());
  assert.deepEqual(result.changes.conflicted, []);
  const deadline = result.changes.changed.find(change => change.category === 'assignments');
  assert.equal(deadline.before.snapshot_hash, first.snapshot_hash); assert.equal(deadline.after.snapshot_hash, next.snapshot_hash);
  assert.equal(deadline.before.source_hash, first.assignments[0].source_hash); assert.equal(deadline.after.source_hash, next.assignments[0].source_hash);
  assert.notEqual(deadline.before.source_hash, deadline.after.source_hash);
  const missing = result.changes.not_returned[0]; assert.equal(missing.after, null);
  assert.equal(missing.before.snapshot_hash, first.snapshot_hash); assert.equal(missing.coverage_state, 'complete');
  assert.deepEqual(Object.keys(result.changes).sort(), ['added', 'changed', 'conflicted', 'not_returned', 'unchanged']);
});

test('REFRESH05: unavailable/unknown/partial categories retain explicit non-deletion absence evidence', () => {
  const first = snapshot();
  const next = snapshot({ retrieved_at: time[1], assignments: [], announcements: [], materials: [],
    coverage: { courses: { state: 'complete' }, assignments: { state: 'partial' },
      announcements: { state: 'unknown' }, materials: { state: 'unavailable' } } });
  const result = preview(next, first); assert.equal(result.content_changed, true);
  assert.equal(result.changes.not_returned.length, 4);
  const states = { assignments: 'partial', announcements: 'unknown', materials: 'unavailable' };
  for (const change of result.changes.not_returned) {
    assert.equal(change.coverage_state, states[change.category]); assert.equal(change.after, null);
    assert.equal(change.before.snapshot_hash, first.snapshot_hash); assert(change.reason);
  }
  assert.deepEqual(result.changes.added, []); assert.deepEqual(result.changes.changed, []);
  assert.equal(Object.hasOwn(result.changes, 'deleted'), false); assert.equal(Object.hasOwn(result, 'task_updates'), false);
});

test('REFRESH06: conflicting current variants remain conflicts instead of additions or not-returned deletion candidates', () => {
  const first = snapshot(), raw = rawFixture({ retrieved_at: time[1] });
  raw.assignments.push({ ...raw.assignments[0], description: 'A conflicting synthetic description.' });
  const next = normalizeAcademicExport(raw, { selectedCourseIds: ['A'] });
  assert.equal(next.assignments.length, 0); assert.equal(next.conflicts.length, 1);
  const result = preview(next, first);
  assert.deepEqual(ids(result.changes.conflicted), [first.assignments[0].id]);
  assert.equal(result.changes.not_returned.some(change => change.id === first.assignments[0].id), false);
  assert.equal(result.changes.added.some(change => change.id === first.assignments[0].id), false);
  const conflict = result.changes.conflicted[0]; assert.equal(conflict.category, 'assignments');
  assert.equal(conflict.before.snapshot_hash, first.snapshot_hash); assert.equal(conflict.variants.length, 2);
  assert.deepEqual(conflict.variants.map(value => value.source_hash).sort(), next.conflicts[0].variants.map(value => value.source_hash).sort());
  assert(conflict.variants.every(value => value.snapshot_hash === next.snapshot_hash));
});

test('REFRESH07: previous account/institution/scope mismatch and incoherent baseline metadata fail closed', () => {
  const first = snapshot(); const variants = [snapshot({ retrieved_at: time[1], account_ref: 'another-synthetic-student' }),
    snapshot({ retrieved_at: time[1], institution: { name: 'Other', origin: 'https://other.refresh.fixture.test' } }),
    snapshot({ retrieved_at: time[1] }, ['A', 'B'])];
  for (const next of variants) expectedError(() => preview(next, first), 'SCOPE_DENIED');
  for (const changes of [{ current_snapshot_hash: 'a'.repeat(64) }, { current_semantic_hash: 'b'.repeat(64) },
    { current_snapshot_id: 'not-a-uuid' }, { revision: -1 }, { head_id: null, revision: 1 }, { unknown: 'unsafe' }]) {
    expectedError(() => academicRefreshPreview(snapshot({ retrieved_at: time[1] }), { baseline: baseline(first, changes) }));
  }
});

test('REFRESH08: equal-time semantic contradictions and older observations cannot move a refresh head', () => {
  const first = snapshot(), altered = rawFixture(); altered.assignments[0].due = '2026-10-11';
  const conflict = normalizeAcademicExport(altered, { selectedCourseIds: ['A'] });
  expectedError(() => preview(conflict, first)); expectedError(() => preview(first, conflict));
  const newer = snapshot({ retrieved_at: time[1] }); expectedError(() => preview(first, newer));
  const same = preview(first, first); assert.equal(same.content_changed, false);
});

test('REFRESH09: rehashed malformed rows, forged identities/deadlines/coverage and unknown fields still reject as AcademicError', () => {
  const first = snapshot(); const variants = [];
  let bad = copy(first); bad.assignments = [null]; variants.push(reseal(bad));
  bad = copy(first); bad.assignments[0].id = '00000000-0000-4000-8000-000000000099'; variants.push(reseal(bad, { rows: true }));
  bad = copy(first); bad.assignments[0].deadline = { precision: 'date', date: '2026-02-30', timezone: 'America/Toronto' }; variants.push(reseal(bad, { rows: true }));
  bad = copy(first); bad.materials[0].url = 'https://outside.refresh.fixture.test/private'; variants.push(reseal(bad, { rows: true }));
  bad = copy(first); bad.coverage.materials.accepted = 0; variants.push(reseal(bad));
  bad = copy(first); bad.coverage.materials.state = 'invented_complete'; variants.push(reseal(bad));
  bad = copy(first); bad.unknown = 'SYNTHETIC_REFRESH_UNKNOWN'; variants.push(reseal(bad));
  bad = copy(first); delete bad.materials; variants.push(reseal(bad));
  bad = copy(first); bad.assignments[0].title = 'Changed without a hash update'; variants.push(bad);
  for (const value of variants) for (const action of [academicRefreshScope, academicStreamKey, academicSemanticHash]) {
    assert.throws(() => action(value), error => error instanceof AcademicError,
      'Malformed self-rehashed snapshots must not escape as a native TypeError.');
  }
});

test('REFRESH10: accessors, cycles, sparse arrays and unknown review options reject without invoking caller code', () => {
  const first = snapshot(); let called = 0;
  const accessor = copy(first); Object.defineProperty(accessor, 'assignments', { enumerable: true,
    get() { called++; throw new Error('SYNTHETIC_GETTER_MUST_NOT_RUN'); } });
  expectedError(() => academicSemanticHash(accessor)); assert.equal(called, 0);
  const options = {}; Object.defineProperty(options, 'baseline', { enumerable: true, get() { called++; return null; } });
  expectedError(() => academicRefreshPreview(first, options)); assert.equal(called, 0);
  const cycle = copy(first); cycle.warnings.push(cycle); expectedError(() => academicSemanticHash(cycle));
  const sparse = copy(first); sparse.materials = new Array(1); expectedError(() => academicSemanticHash(sparse));
  expectedError(() => academicRefreshPreview(first, { baseline: null, execute: true }));
});

test('REFRESH11: review binds exact snapshot, baseline and diff even when a tampered preview is rehashed', () => {
  const first = freeze(snapshot()), next = freeze(snapshot({ retrieved_at: time[1] }));
  const before = JSON.stringify([first, next]); const base = freeze(baseline(first));
  const result = academicRefreshPreview(next, { baseline: base });
  assert.equal(JSON.stringify([first, next]), before);
  assert.doesNotThrow(() => validateAcademicRefreshPreview(result, { baseline: base }));
  expectedError(() => validateAcademicRefreshPreview({ ...result, review_hash: 'f'.repeat(64) }, { baseline: base }));
  const mutations = [value => { value.base.revision += 1; },
    value => { value.snapshot.assignments[0].title = 'Forged reviewed evidence'; },
    value => { value.changes.unchanged[0].after.title = 'Forged reviewed diff'; },
    value => { value.changes.deleted = [value.changes.unchanged[0]]; }, value => { value.execute = true; }];
  for (const mutate of mutations) {
    const value = copy(result); mutate(value);
    const { review_hash, ...payload } = value; value.review_hash = fingerprint(payload);
    assert.throws(() => validateAcademicRefreshPreview(value, { baseline: base }), error => error instanceof AcademicError);
  }
  const options = {}; let invoked = false; Object.defineProperty(options, 'baseline', { enumerable: true,
    get() { invoked = true; return base; } });
  expectedError(() => validateAcademicRefreshPreview(result, options)); assert.equal(invoked, false);
});

test('REFRESH12: self-rehashed coverage cannot claim complete while normalized safety errors/conflicts say partial', () => {
  const duplicate = rawFixture({ retrieved_at: time[1] });
  duplicate.assignments.push({ ...duplicate.assignments[0], description: 'A conflicting synthetic variant.' });
  const conflicted = normalizeAcademicExport(duplicate, { selectedCourseIds: ['A'] });
  const error = snapshot({ retrieved_at: time[1], errors: [{ category: 'materials', code: 'SCOPE_DENIED', course_id: 'A' }] });
  assert.equal(conflicted.coverage.assignments.state, 'partial'); assert.equal(error.coverage.materials.state, 'partial');
  for (const [value, category] of [[conflicted, 'assignments'], [error, 'materials']]) {
    const tampered = copy(value); tampered.coverage[category].state = 'complete';
    assert.throws(() => academicSemanticHash(reseal(tampered)), problem => problem instanceof AcademicError);
  }
});

test('REFRESH-L01: repeated source versions retain one exact immutable observation hash/timestamp pair', () => {
  const first = snapshot(), repeated = snapshot({ retrieved_at: time[1] });
  assert.notEqual(first.snapshot_hash, repeated.snapshot_hash);
  const library = buildAcademicLibrary({ snapshots: [first, repeated], selectedCourseIds: ['A'] });
  const byHash = new Map([first, repeated].map(value => [value.snapshot_hash, value]));
  for (const source of library.sources) {
    assert(byHash.has(source.snapshot_hash));
    assert.equal(source.retrieved_at, byHash.get(source.snapshot_hash).retrieved_at,
      'A source version must not combine an earlier observation hash with a later timestamp.');
  }
  const result = search(library).results[0]; assert(result);
  const citation = resolveAcademicCitation(library, { source_id: result.source_id, version_hash: result.version_hash,
    chunk_id: result.chunk_id, courseIds: ['A'] });
  assert.equal(citation.text, result.excerpt);
});

test('REFRESH-L02: A→B→A preserves exact historical citations and selects the returned source version', () => {
  const first = snapshot();
  const second = snapshot({ retrieved_at: time[1], materials: [{ source_id: 'NOTE1', course_id: 'A', title: 'Synthetic note one',
    body: 'IMMUTABLE_REFRESH_CHANGED is the intermediate synthetic version.' }] });
  const third = snapshot({ retrieved_at: time[2] });
  const original = buildAcademicLibrary({ snapshots: [first], selectedCourseIds: ['A'] });
  const oldResult = search(original).results[0];
  const intermediate = buildAcademicLibrary({ snapshots: [first, second], selectedCourseIds: ['A'] });
  const middleResult = search(intermediate, 'IMMUTABLE_REFRESH_CHANGED').results[0]; assert(middleResult);
  const reverted = buildAcademicLibrary({ snapshots: [third, second, first], selectedCourseIds: ['A'] });
  assert.equal(search(reverted).results.length, 1);
  assert.equal(search(reverted, 'IMMUTABLE_REFRESH_CHANGED').results.length, 0);
  const middleCitation = resolveAcademicCitation(reverted, { source_id: middleResult.source_id,
    version_hash: middleResult.version_hash, chunk_id: middleResult.chunk_id, courseIds: ['A'] });
  assert.equal(middleCitation.status, 'historical'); assert.equal(middleCitation.text, middleResult.excerpt);
  const oldCitation = resolveAcademicCitation(reverted, { source_id: oldResult.source_id,
    version_hash: oldResult.version_hash, chunk_id: oldResult.chunk_id, courseIds: ['A'] });
  assert.equal(oldCitation.text, oldResult.excerpt); assert.equal(oldCitation.status, 'current');
  assert.equal(reverted.sources.filter(source => source.source_id === oldResult.source_id).length, 2);
});

test('REFRESH-L03: same-instant conflicting source versions reject independent of snapshot traversal order', () => {
  const first = snapshot(); const conflicting = snapshot({ materials: [{ source_id: 'NOTE1', course_id: 'A',
    title: 'Synthetic note one', body: 'A contradictory same-instant observation.' }] });
  for (const snapshots of [[first, conflicting], [conflicting, first]]) {
    expectedError(() => buildAcademicLibrary({ snapshots, selectedCourseIds: ['A'] }));
  }
});

test('REFRESH-L04: absent or conflicted latest evidence stays last-known, out of default search, and exactly citable', () => {
  const first = snapshot(), before = buildAcademicLibrary({ snapshots: [first], selectedCourseIds: ['A'] });
  const original = search(before).results[0]; assert(original);
  const unavailable = snapshot({ retrieved_at: time[1], materials: [],
    coverage: { ...rawFixture().coverage, materials: { state: 'unavailable' } } });
  const conflictRaw = rawFixture({ retrieved_at: time[1] });
  conflictRaw.materials.push({ ...conflictRaw.materials[0], body: 'A contradictory synthetic note.' });
  const conflicted = normalizeAcademicExport(conflictRaw, { selectedCourseIds: ['A'] });
  for (const [next, state, coverage] of [[unavailable, 'not_returned', 'unavailable'], [conflicted, 'conflicted', 'partial']]) {
    const library = buildAcademicLibrary({ snapshots: [next, first], selectedCourseIds: ['A'] });
    assert.equal(search(library).results.length, 0);
    const source = library.sources.find(value => value.source_id === original.source_id);
    assert.equal(source.status, 'last_known'); assert.equal(source.snapshot_hash, first.snapshot_hash);
    assert.equal(source.retrieved_at, first.retrieved_at);
    assert.deepEqual(source.freshness, { state, snapshot_hash: next.snapshot_hash,
      retrieved_at: next.retrieved_at, coverage_state: coverage });
    const citation = resolveAcademicCitation(library, { source_id: original.source_id,
      version_hash: original.version_hash, chunk_id: original.chunk_id, courseIds: ['A'] });
    assert.equal(citation.text, original.excerpt); assert.equal(citation.status, 'last_known');
    assert.deepEqual(citation.freshness, source.freshness); assert.equal(citation.snapshot_hash, first.snapshot_hash);
  }
});

test('REFRESH-L05: missing or conflicted latest evidence blocks new sessions and previously prepared tutor results', () => {
  const first = snapshot(), before = buildAcademicLibrary({ snapshots: [first], selectedCourseIds: ['A'] });
  const original = search(before).results[0]; assert(original);
  const reference = { source_id: original.source_id, version_hash: original.version_hash, chunk_id: original.chunk_id };
  const request = { library: before, courseIds: ['A'], citations: [reference], topic: 'Synthetic idea', mode: 'explain',
    academicPolicy: { grading: 'ungraded', ai_rule: 'allowed' }, now: time[0] };
  const session = prepareTutorSession(request); assert.equal(session.state, 'ready');
  const result = { kind: 'explanation', explanation: 'A synthetic explanation.', citations: [reference], support_limits: [] };
  assert.doesNotThrow(() => validateTutorResult({ session, library: before, result, executionStatus: 'completed' }));
  const unavailable = snapshot({ retrieved_at: time[1], materials: [],
    coverage: { ...rawFixture().coverage, materials: { state: 'unavailable' } } });
  const conflictRaw = rawFixture({ retrieved_at: time[1] });
  conflictRaw.materials.push({ ...conflictRaw.materials[0], body: 'A contradictory synthetic note.' });
  const conflicted = normalizeAcademicExport(conflictRaw, { selectedCourseIds: ['A'] });
  for (const next of [unavailable, conflicted]) {
    const library = buildAcademicLibrary({ snapshots: [first, next], selectedCourseIds: ['A'] });
    assert.throws(() => prepareTutorSession({ ...request, library, now: time[1] }),
      error => error instanceof TutoringError && error.code === 'STALE_EVIDENCE');
    assert.throws(() => validateTutorResult({ session, library, result, executionStatus: 'completed' }),
      error => error instanceof TutoringError && error.code === 'STALE_EVIDENCE');
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateHostedTasks, LegacyStateError } from '../packages/core/src/legacy-state.mjs';
import { parseTask } from '../packages/core/src/contracts.mjs';

const STUDENT = 'a3ace0a1-f07c-4d57-b900-16cb3c664171';
const LEGACY_ID = '1433b5c2-2dc7-4d17-ae85-1d67cf5f5e17';
const options = { studentId: STUDENT, importedAt: '2026-10-02T15:00:00.000Z', timezone: 'America/Toronto' };
const task = (changes = {}) => ({ id: LEGACY_ID, title: 'Review recursion', course: 'Algorithms', due: '2026-10-15', done: false, ...changes });
const envelope = (tasks = [task()]) => ({ value: tasks, revision: 3 });
const fails = (input, opts = options) => assert.throws(() => migrateHostedTasks(input, opts), error => error instanceof LegacyStateError && !error.message.includes('synthetic-secret'));

test('legacy migration preserves duplicate titles, completion, exact course and source IDs', () => {
  const input = envelope([task({ title: '  Study  ', course: '  Course A  ' }), task({ title: '  Study  ', done: true })]);
  const result = migrateHostedTasks(input, options);
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].title, '  Study  ');
  assert.equal(result.records[0].course_label, '  Course A  ');
  assert.equal(result.records[0].course_id, null);
  assert.equal(result.records[0].status, 'pending');
  assert.equal(result.records[1].status, 'completed');
  assert.notEqual(result.records[0].id, result.records[1].id);
  assert.equal(result.records[0].origin, 'migration');
  assert.equal(result.mapping[1].legacy_id, LEGACY_ID);
  assert.equal(result.warnings[0].code, 'DUPLICATE_LEGACY_ID');
  for (const record of result.records) assert.deepEqual(parseTask(record), record);
  assert.deepEqual(result.backup.original_input, input);
});

test('date-only deadlines remain dates with no invented midnight or time conversion', () => {
  const result = migrateHostedTasks(envelope([task({ due: '2028-02-29' }), task({ due: '' })]), options);
  assert.deepEqual(result.records[0].deadline, { precision: 'date', date: '2028-02-29', original: '2028-02-29', timezone: 'America/Toronto' });
  assert.equal(Object.hasOwn(result.records[0].deadline, 'instant'), false);
  assert.equal(result.records[1].deadline.precision, 'unknown');
  const noTimezone = migrateHostedTasks([task()], { studentId: STUDENT, importedAt: options.importedAt });
  assert.equal(Object.hasOwn(noTimezone.records[0].deadline, 'timezone'), false);
});

test('legacy UUIDs accepted by the hosted schema remain opaque source identities', () => {
  const nil = '00000000-0000-0000-0000-000000000000';
  const result = migrateHostedTasks(envelope([task({ id: nil })]), options);
  assert.equal(result.mapping[0].legacy_id, nil);
  assert.notEqual(result.records[0].id, nil);
});

test('blank titles accepted by the old website are explicitly deferred with exact source retained', () => {
  const input = envelope([task(), task({ title: '', done: true }), task({ title: '  \t  ' })]);
  const result = migrateHostedTasks(input, options);
  assert.equal(result.status, 'requires_review');
  assert.equal(result.source_count, 3);
  assert.equal(result.pending_count, 1);
  assert.equal(result.deferred_count, 2);
  assert.equal(result.source_count, result.pending_count + result.skipped_count + result.deferred_count);
  assert.deepEqual(result.mapping.map(item => item.disposition), ['pending', 'needs_review', 'needs_review']);
  assert.equal(result.warnings.filter(warning => warning.code === 'EMPTY_TASK_TITLE').length, 2);
  assert.deepEqual(result.backup.original_input, input);
  assert.equal(result.backup.original_input.value[1].done, true);
});

test('legacy text unsafe for the new local contract is retained for review without stripping it', () => {
  const input = envelope([task({ title: 'Title\u0000suffix' }), task({ course: 'Course\u001fsuffix' }), task({ due: 'bad\u0000date' })]);
  const result = migrateHostedTasks(input, options);
  assert.equal(result.status, 'requires_review');
  assert.equal(result.deferred_count, 3);
  assert.equal(result.records.length, 0);
  assert.equal(result.warnings.filter(warning => warning.code === 'LOCAL_CONTRACT_REQUIRES_REVIEW').length, 3);
  assert.deepEqual(result.backup.original_input, input);
});

test('invalid calendar dates and timestamp-like due fields preserve the originals with reconciliation warnings', () => {
  const values = ['2026-02-29', '2026-04-31', '0000-01-01', '2026-13-01', '2026-00-01', '2026-01-00', '10/15/2026', '2026-10-15T23:30:00Z', 'synthetic-secret'];
  const result = migrateHostedTasks(envelope(values.map(due => task({ due }))), options);
  result.records.forEach((record, index) => {
    assert.equal(record.deadline.precision, 'unknown');
    assert.equal(record.deadline.original, values[index]);
  });
  assert.equal(result.warnings.filter(warning => warning.code === 'INVALID_DEADLINE').length, values.length);
  assert.equal(JSON.stringify(result.warnings).includes('synthetic-secret'), false);
});

test('exact backup retains unmapped data and original JSON bytes without mutating caller state', () => {
  const input = envelope([task({ note: { text: 'Keep this', tags: ['one', 'two'] }, priority: 2 })]);
  input.updated_at = '2026-10-01T14:12:00Z';
  const raw = JSON.stringify(input, null, 2) + '\n';
  const before = JSON.stringify(input);
  const result = migrateHostedTasks(raw, options);
  assert.equal(result.backup.original_text, raw);
  assert.deepEqual(result.backup.original_input, input);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(result.warnings.map(warning => warning.code), ['UNMAPPED_ENVELOPE_FIELDS', 'UNMAPPED_TASK_FIELDS']);
  assert.deepEqual(result.warnings[1].fields, ['note', 'priority']);
  result.backup.original_input.value[0].note.text = 'Changed backup';
  assert.equal(input.value[0].note.text, 'Keep this');
});

test('canonical snapshot IDs are stable across object key order and independent import timestamps', () => {
  const first = migrateHostedTasks(envelope(), options);
  const second = migrateHostedTasks({ revision: 3, value: [{ done: false, due: '2026-10-15', course: 'Algorithms', title: 'Review recursion', id: LEGACY_ID }] }, { ...options, importedAt: '2026-10-03T15:00:00Z' });
  assert.equal(first.snapshot_hash, second.snapshot_hash);
  assert.equal(first.records[0].id, second.records[0].id);
  assert.equal(first.records[0].revision, 1);
  assert.equal(first.records[0].created_at, options.importedAt);
  const otherStudent = migrateHostedTasks(envelope(), { ...options, studentId: 'faa40157-1359-4da2-ac39-3f6783479d60' });
  assert.equal(first.snapshot_hash, otherStudent.snapshot_hash);
  assert.notEqual(first.records[0].id, otherStudent.records[0].id);
});

test('committed reimport produces no pending records, while partial replay plans only missing deterministic IDs', () => {
  const input = envelope([task(), task({ done: true })]);
  const original = migrateHostedTasks(input, options);
  const repeated = migrateHostedTasks(input, { ...options, existingSnapshotHashes: [original.snapshot_hash] });
  assert.equal(repeated.status, 'already_imported');
  assert.equal(repeated.pending_count, 0);
  assert.equal(repeated.skipped_count, 2);
  assert.deepEqual(repeated.backup.original_input, input);
  const partial = migrateHostedTasks(input, { ...options, existingTaskIds: [original.records[0].id] });
  assert.deepEqual(partial.records.map(record => record.id), [original.records[1].id]);
  assert.equal(partial.skipped_count, 1);
  assert.equal(partial.warnings.some(warning => warning.code === 'PARTIAL_REIMPORT'), true);
});

test('changed snapshot requires explicit reconciliation and never overwrites old local records', () => {
  const first = migrateHostedTasks(envelope(), options);
  const next = migrateHostedTasks(envelope([task({ done: true })]), { ...options, existingSnapshotHashes: [first.snapshot_hash], existingTaskIds: [first.records[0].id] });
  assert.notEqual(first.snapshot_hash, next.snapshot_hash);
  assert.notEqual(first.records[0].id, next.records[0].id);
  assert.equal(next.warnings.some(warning => warning.code === 'DIFFERENT_SNAPSHOT_REQUIRES_REVIEW'), true);
  assert.equal(first.records[0].status, 'pending');
});

test('empty arrays and initial hosted null state are valid imports with source revision preserved', () => {
  for (const input of [[], { value: [], revision: 0 }, { value: null, revision: 0 }]) {
    const result = migrateHostedTasks(input, options);
    assert.equal(result.source_count, 0);
    assert.deepEqual(result.records, []);
    assert.deepEqual(result.backup.original_input, input);
  }
  fails({ value: null, revision: 2 });
});

test('date compatibility is an explicit schema choice, not silently inferred', () => {
  const { due, ...withoutDue } = task();
  const aliased = { ...withoutDue, date: due };
  fails(envelope([aliased]));
  const result = migrateHostedTasks(envelope([aliased]), { ...options, allowDateAlias: true });
  assert.equal(result.records[0].deadline.date, due);
  assert.equal(result.mapping[0].deadline_field, 'date');
  assert.equal(result.warnings[0].code, 'DATE_ALIAS_USED');
  assert.deepEqual(result.backup.original_input.value[0], aliased);
});

test('shape/type failures reject the entire snapshot rather than partly importing or coercing data', () => {
  for (const bad of [null, {}, { value: [], revision: -1 }, { value: [], revision: 0.5 }, { value: [], revision: Number.MAX_SAFE_INTEGER + 1 }, { value: [], revision: 1, kind: 'draft' }, { value: {}, revision: 1 }, envelope([null]), envelope([task({ done: 'true' })]), envelope([task({ course: null })]), envelope([task({ due: 20261015 })]), envelope([task({ id: 'not-uuid' })]), envelope([task(), task({ title: null })])]) fails(bad);
  fails('{broken json with synthetic-secret');
});

test('payload limits reject large snapshots, field values and nested unknown payloads', () => {
  fails(envelope(Array.from({ length: 1001 }, () => task())));
  fails(envelope([task({ title: 't'.repeat(301) })]));
  fails(envelope([task({ course: 'c'.repeat(301) })]));
  fails(envelope([task({ due: 'd'.repeat(31) })]));
  fails(' '.repeat(1_000_001));
  fails(envelope([task({ note: 'n'.repeat(1_000_001) })]));
  let payload = 'end';
  for (let index = 0; index < 15; index++) payload = { nested: payload };
  fails(envelope([task({ note: payload })]));
});

test('unsafe prototype keys and object payloads never mutate prototypes or invoke getters', () => {
  for (const key of ['__proto__', 'prototype', 'constructor']) {
    const raw = JSON.stringify(envelope()).replace('"done":false', `"done":false,"extra":{"${key}":{"polluted":true}}`);
    fails(raw);
  }
  assert.equal({}.polluted, undefined);
  let calls = 0;
  const accessor = task();
  Object.defineProperty(accessor, 'note', { enumerable: true, get() { calls++; return 'synthetic-secret'; } });
  fails(envelope([accessor]));
  assert.equal(calls, 0);
  fails(envelope([Object.assign(Object.create({ inherited: true }), task())]));
  fails(envelope([task({ note: () => 'code' })]));
  fails(envelope([task({ note: new Date() })]));
  const cyclic = task(); cyclic.note = cyclic; fails(envelope([cyclic]));
  const hidden = task(); Object.defineProperty(hidden, 'note', { value: 'hidden' }); fails(envelope([hidden]));
  const symbol = task(); symbol[Symbol('hidden')] = 'value'; fails(envelope([symbol]));
  const sparse = new Array(1); fails(envelope(sparse));
});

test('identity, timezone, UTC import time and replay journals are validated even for empty imports', () => {
  for (const changes of [{ studentId: 'unsafe' }, { importedAt: '2026-02-29T15:00:00Z' }, { importedAt: '2026-10-02T24:00:00Z' }, { importedAt: '2026-10-02T15:60:00Z' }, { importedAt: '2026-10-02T15:00:60Z' }, { importedAt: '2026-10-02T15:00:00-04:00' }, { importedAt: '2026-10-02T15:00:00.1Z' }, { importedAt: '2026-10-02T15:00:00.12Z' }, { timezone: 'not/a/timezone' }, { timezone: 4 }, { existingTaskIds: ['not-uuid'] }, { existingSnapshotHashes: ['not-hash'] }, { allowDateAlias: 'yes' }]) fails([], { ...options, ...changes });
});

test('diagnostic paths never expose arbitrary private property names', () => {
  const input = envelope([task({ 'synthetic-secret': { bad: () => null } })]);
  assert.throws(() => migrateHostedTasks(input, options), error => error instanceof LegacyStateError && !JSON.stringify({ message: error.message, path: error.path }).includes('synthetic-secret'));
});

test('bounded maximum legitimate hosted state imports with unique deterministic record identities', () => {
  const tasks = Array.from({ length: 1000 }, (_, index) => task({ title: `Task ${index}`, done: index % 2 === 0 }));
  const result = migrateHostedTasks(envelope(tasks), options);
  assert.equal(result.source_count, 1000);
  assert.equal(new Set(result.records.map(record => record.id)).size, 1000);
  assert.equal(result.records.filter(record => record.status === 'completed').length, 500);
});

test('pure migration requires no network or environment values and keeps inputs unchanged', () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Network must not be called.'); };
  const input = envelope();
  const original = JSON.stringify(input);
  try {
    assert.equal(migrateHostedTasks(input, options).pending_count, 1);
    assert.equal(JSON.stringify(input), original);
  } finally { globalThis.fetch = originalFetch; }
});

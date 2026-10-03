import test from 'node:test';
import assert from 'node:assert/strict';
import { rankToday, planStudyWork, nextPracticeReview } from '../packages/local-academic/src/planning.mjs';

const now = '2026-10-03T12:00:00Z'; const timezone = 'America/Toronto';
const base = { now, timezone, horizonEnd: '2026-10-03T20:00:00Z', availability: [{ start: now, end: '2026-10-03T14:00:00Z' }] };
const task = (id, minutes = 30, extra = {}) => ({ id, title: id, status: 'pending', deadline: { precision: 'instant', instant: '2026-10-03T20:00:00Z' }, effort_minutes: minutes, ...extra });
const code = (fn, value) => assert.throws(fn, error => error.code === value);
function assertNoOverlap(plan) { for (let i = 1; i < plan.blocks.length; i++) assert.ok(Date.parse(plan.blocks[i - 1].end) <= Date.parse(plan.blocks[i].start)); }

test('Today follows exact overdue/pinned/today order, stable ties, unknown review and completion exclusion', () => {
  const values = [task('today', 30, { deadline: { precision: 'date', date: '2026-10-03' } }), task('pinned', 30, { pinned: true, deadline: { precision: 'date', date: '2026-10-10' } }), task('overdue', 30, { deadline: { precision: 'date', date: '2026-10-02' } }), task('unknown', null, { origin: 'imported', deadline: { precision: 'unknown', original: 'TBD' } }), task('done', 30, { status: 'completed' }), task('undated', 30, { deadline: { precision: 'unknown' } }), task('same-b'), task('same-a')];
  const first = rankToday({ tasks: values, now, timezone }); const second = rankToday({ tasks: [...values].reverse(), now, timezone });
  assert.deepEqual(first.ordered.map(row => row.id), ['overdue', 'pinned', 'same-a', 'same-b', 'today']); assert.deepEqual(second, first);
  assert.equal(first.review[0].id, 'unknown'); assert.equal(first.undated[0].id, 'undated'); assert.equal(first.ordered.some(row => row.id === 'done'), false); assert.equal(first.review[0].deadline.precision, 'unknown');
});

test('120 minute catch-up fits exact availability and prerequisite order without writing anything', () => {
  const values = [task('A', 30), task('B', 60, { dependency_ids: ['A'] }), task('C', 30, { dependency_ids: ['B'] })]; const original = structuredClone(values);
  const plan = planStudyWork({ ...base, tasks: values }); assert.equal(plan.coverage.proposed_minutes, 120); assert.equal(plan.unscheduled.length, 0); assert.equal(plan.coverage.all_known_work_fits, true); assert.equal(plan.external_writes, 0); assert.deepEqual(values, original);
  assert.deepEqual(plan.blocks.map(block => block.task_id), ['A', 'B', 'C']); assert.equal(plan.blocks.at(-1).end, '2026-10-03T14:00:00.000Z'); assertNoOverlap(plan); assert.deepEqual(planStudyWork({ ...base, tasks: values }), plan);
});

test('90 minute capacity reports 30 unscheduled and never exceeds busy intervals or daily limits', () => {
  const plan = planStudyWork({ ...base, tasks: [task('A', 30), task('B', 60), task('C', 30)], busy: [{ start: '2026-10-03T13:30:00Z', end: '2026-10-03T14:00:00Z' }] });
  assert.equal(plan.coverage.proposed_minutes, 90); assert.equal(plan.coverage.unscheduled_minutes, 30); assert.equal(plan.coverage.all_known_work_fits, false); assertNoOverlap(plan); assert.ok(plan.blocks.every(block => block.end <= '2026-10-03T13:30:00.000Z'));
  const limited = planStudyWork({ ...base, tasks: [task('A', 120)], maxDailyMinutes: 60 }); assert.equal(limited.coverage.proposed_minutes, 60); assert.equal(limited.unscheduled[0].remaining_minutes, 60);
});

test('unknown effort and missing/cancelled prerequisites remain unscheduled with definite reasons', () => {
  const plan = planStudyWork({ ...base, tasks: [task('unknown', null), task('dependent', 30, { dependency_ids: ['unknown'] }), task('missing', 30, { dependency_ids: ['not-present'] }), task('cancelled', 30, { status: 'cancelled' }), task('cancel-dependent', 30, { dependency_ids: ['cancelled'] })] });
  assert.equal(plan.blocks.length, 0); assert.equal(plan.unscheduled.find(row => row.task_id === 'unknown').reason, 'needs_effort'); assert.equal(plan.unscheduled.find(row => row.task_id === 'dependent').reason, 'prerequisite_unscheduled'); assert.equal(plan.unscheduled.find(row => row.task_id === 'missing').reason, 'prerequisite_unscheduled'); assert.equal(plan.coverage.unknown_effort_count, 1);
  code(() => planStudyWork({ ...base, tasks: [task('A', 30, { dependency_ids: ['B'] }), task('B', 30, { dependency_ids: ['A'] })] }), 'INVALID_INPUT');
});

test('completed work is preserved; fixed blocks stay fixed and changed deadlines invalidate plan hash', () => {
  const input = { ...base, tasks: [task('done', 30, { status: 'completed' }), task('pinned', 30), task('next', 30, { dependency_ids: ['done'] })], pinnedBlocks: [{ task_id: 'pinned', start: '2026-10-03T12:30:00Z', end: '2026-10-03T13:00:00Z' }] };
  const plan = planStudyWork(input); assert.deepEqual(plan.completed_task_ids, ['done']); assert.equal(plan.blocks.find(row => row.task_id === 'pinned').start, '2026-10-03T12:30:00.000Z'); assert.equal(plan.blocks.some(row => row.task_id === 'done'), false); assertNoOverlap(plan);
  const changed = structuredClone(input); changed.tasks[1].deadline.instant = '2026-10-03T12:45:00Z'; const replan = planStudyWork(changed); assert.notEqual(replan.plan_hash, plan.plan_hash); assert.equal(replan.blocks.find(row => row.task_id === 'pinned').start, plan.blocks.find(row => row.task_id === 'pinned').start); assert.ok(replan.conflicts.some(row => row.reasons.includes('after_deadline'))); assert.equal(replan.coverage.all_known_work_fits, false);
});

test('incomplete fixed effort and fixed prerequisite conflicts do not falsely complete tasks', () => {
  const plan = planStudyWork({ ...base, tasks: [task('A', 60), task('B', 30, { dependency_ids: ['A'] })], pinnedBlocks: [{ task_id: 'A', start: now, end: '2026-10-03T12:30:00Z' }] });
  assert.equal(plan.unscheduled.find(row => row.task_id === 'A').remaining_minutes, 30); assert.equal(plan.unscheduled.find(row => row.task_id === 'B').reason, 'prerequisite_unscheduled'); assert.equal(plan.coverage.all_known_work_fits, false);
});

test('DST spring and autumn transitions preserve actual instants and local daily capacity', () => {
  const spring = planStudyWork({ tasks: [task('spring', 120, { deadline: { precision: 'unknown' } })], now: '2026-03-08T06:30:00Z', timezone, horizonEnd: '2026-03-08T10:00:00Z', availability: [{ start: '2026-03-08T01:30:00-05:00', end: '2026-03-08T03:30:00-04:00' }] });
  assert.equal(spring.coverage.proposed_minutes, 60); assert.equal(spring.unscheduled[0].remaining_minutes, 60); assert.equal(spring.daily_minutes[0].date, '2026-03-08');
  const fall = planStudyWork({ tasks: [task('fall', 120, { deadline: { precision: 'unknown' } })], now: '2026-11-01T05:30:00Z', timezone, horizonEnd: '2026-11-01T09:00:00Z', availability: [{ start: '2026-11-01T01:30:00-04:00', end: '2026-11-01T02:30:00-05:00' }] });
  assert.equal(fall.coverage.proposed_minutes, 120); assert.equal(fall.unscheduled.length, 0); assert.equal(fall.blocks[0].end, '2026-11-01T07:30:00.000Z');
  const midnight = planStudyWork({ tasks: [task('split', 90, { deadline: { precision: 'unknown' } })], now: '2026-10-04T03:30:00Z', timezone, horizonEnd: '2026-10-04T06:00:00Z', maxDailyMinutes: 60, availability: [{ start: '2026-10-04T03:30:00Z', end: '2026-10-04T06:00:00Z' }] });
  assert.deepEqual(midnight.daily_minutes, [{ date: '2026-10-03', minutes: 30 }, { date: '2026-10-04', minutes: 60 }]); assert.equal(midnight.coverage.proposed_minutes, 90);
});

test('date-only and unknown exam times remain precise; buffers reserve actual free capacity', () => {
  const plan = planStudyWork({ ...base, tasks: [task('A'), task('B'), task('C')], bufferMinutes: 15 }); assert.equal(plan.coverage.proposed_minutes, 90); assert.equal(plan.blocks[1].start, '2026-10-03T12:45:00.000Z'); assertNoOverlap(plan);
  const unknown = task('exam', 30, { deadline: { precision: 'unknown', original: 'Oct 5 evening' } }); const preview = planStudyWork({ ...base, tasks: [unknown] }); assert.equal(preview.task_versions[0].deadline.precision, 'unknown'); assert.equal(preview.blocks[0].needs_review, true);
  const dated = planStudyWork({ tasks: [task('date', 90, { deadline: { precision: 'date', date: '2026-10-03', timezone } })], now: '2026-10-04T03:30:00Z', timezone, horizonEnd: '2026-10-04T06:00:00Z', availability: [{ start: '2026-10-04T03:30:00Z', end: '2026-10-04T06:00:00Z' }] }); assert.equal(dated.coverage.proposed_minutes, 30); assert.equal(dated.unscheduled[0].remaining_minutes, 60); assert.equal(dated.task_versions[0].deadline.precision, 'date');
});

test('practice cadence is versioned, exact, attempt-local and does not claim mastery', () => {
  const first = nextPracticeReview({ attempted_at: now, correct: true }); assert.equal(first.next_review_at, '2026-10-04T12:00:00.000Z'); const second = nextPracticeReview({ attempted_at: first.next_review_at, correct: true, previous_correct_streak: first.correct_streak }); assert.equal(second.interval_days, 3); const wrong = nextPracticeReview({ attempted_at: second.next_review_at, correct: false, previous_correct_streak: second.correct_streak }); assert.equal(wrong.correct_streak, 0); assert.equal(wrong.interval_days, 1); assert.equal(wrong.mastery_claim, false);
});

test('unbounded horizons, invalid dates, getter inputs and unknown options are rejected', () => {
  code(() => planStudyWork({ ...base, tasks: [], horizonEnd: '2027-10-03T20:00:00Z' }), 'BUDGET_EXCEEDED'); code(() => planStudyWork({ ...base, tasks: [], availability: [{ start: '2026-02-30T00:00:00Z', end: '2026-03-03T00:00:00Z' }] }), 'INVALID_INPUT'); code(() => planStudyWork({ ...base, tasks: [], shell: 'anything' }), 'INVALID_INPUT');
  let invoked = false; const dangerous = { ...base }; Object.defineProperty(dangerous, 'tasks', { enumerable: true, get() { invoked = true; return []; } }); code(() => planStudyWork(dangerous), 'INVALID_INPUT'); assert.equal(invoked, false);
});

test('fixed commitments respect busy/study buffers and identify overlapping fixed blocks', () => {
  const plan = planStudyWork({ ...base, tasks: [task('A', 30), task('B', 30)], bufferMinutes: 15, busy: [{ start: '2026-10-03T12:00:00Z', end: '2026-10-03T12:15:00Z' }], pinnedBlocks: [{ task_id: 'A', start: '2026-10-03T12:15:00Z', end: '2026-10-03T12:45:00Z' }, { task_id: 'B', start: '2026-10-03T12:45:00Z', end: '2026-10-03T13:15:00Z' }] });
  assert.ok(plan.conflicts.some(row => row.reasons.includes('busy_buffer_conflict'))); assert.ok(plan.conflicts.some(row => row.reasons.includes('pinned_buffer_conflict'))); assert.equal(plan.coverage.all_known_work_fits, false); assert.equal(plan.coverage.known_required_minutes, 60); assert.equal(plan.coverage.pinned_minutes, 60);
});

test('seeded heterogeneous schedule fixtures never overlap or cross daily, prerequisite, deadline or busy constraints', () => {
  let seed = 713; const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let round = 0; round < 40; round++) {
    const values = Array.from({ length: 8 }, (_, index) => task(`task-${index}`, 10 + Math.floor(random() * 90), { manual_priority: Math.floor(random() * 6), dependency_ids: index && random() < .4 ? [`task-${index - 1}`] : [] }));
    const input = { ...base, tasks: values, maxDailyMinutes: 30 + Math.floor(random() * 110), bufferMinutes: Math.floor(random() * 11), availability: [{ start: now, end: '2026-10-03T18:00:00Z' }], busy: [{ start: '2026-10-03T14:00:00Z', end: '2026-10-03T15:00:00Z' }] };
    const plan = planStudyWork(input); assertNoOverlap(plan); assert.ok(plan.daily_minutes.every(day => day.minutes <= input.maxDailyMinutes));
    for (const block of plan.blocks) {
      assert.ok(Date.parse(block.start) >= Date.parse(now) && Date.parse(block.end) <= Date.parse(input.horizonEnd)); assert.ok(Date.parse(block.end) <= Date.parse(values.find(row => row.id === block.task_id).deadline.instant)); assert.ok(block.end <= '2026-10-03T14:00:00.000Z' || block.start >= '2026-10-03T15:00:00.000Z');
      for (const dependency of values.find(row => row.id === block.task_id).dependency_ids) { const prior = plan.blocks.filter(row => row.task_id === dependency); assert.ok(prior.length); assert.equal(prior.reduce((sum, row) => sum + row.minutes, 0), values.find(row => row.id === dependency).effort_minutes); assert.ok(prior.at(-1).end <= block.start); }
    }
    for (const value of values) { const scheduled = plan.blocks.filter(block => block.task_id === value.id).reduce((sum, block) => sum + block.minutes, 0); const remaining = plan.unscheduled.find(row => row.task_id === value.id)?.remaining_minutes ?? 0; assert.equal(scheduled + remaining, value.effort_minutes); }
  }
});

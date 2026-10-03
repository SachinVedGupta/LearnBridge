import { createHash } from 'node:crypto';
import { AcademicError, normalizeAcademicDeadline } from './index.mjs';

const fail = (code = 'INVALID_INPUT') => { throw new AcademicError(code); };
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const fingerprint = value => createHash('sha256').update(canonical(value)).digest('hex');
const MINUTE = 60_000;
function clone(value) {
  let nodes = 0; const seen = new Set();
  function visit(item, depth) {
    if (++nodes > 50_000 || depth > 16) fail('BUDGET_EXCEEDED');
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return item;
    if (!item || typeof item !== 'object' || seen.has(item)) fail();
    seen.add(item); const props = Object.getOwnPropertyDescriptors(item); let result;
    if (Array.isArray(item)) {
      if (item.length > 10_000 || Reflect.ownKeys(props).some(key => key !== 'length' && (!/^\d+$/.test(String(key)) || !('value' in props[key]) || !props[key].enumerable))) fail();
      result = Array.from({ length: item.length }, (_, i) => { if (!Object.hasOwn(props, String(i))) fail(); return visit(props[i].value, depth + 1); });
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item)) || Reflect.ownKeys(props).some(key => typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key) || !('value' in props[key]) || !props[key].enumerable)) fail();
      result = Object.fromEntries(Object.keys(props).map(key => [key, visit(props[key].value, depth + 1)]));
    }
    seen.delete(item); return result;
  }
  const result = visit(value, 0); if (Buffer.byteLength(JSON.stringify(result)) > 2_000_000) fail('BUDGET_EXCEEDED'); return result;
}
function object(value, keys, required = []) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail(); }
function array(value, max = 2000) { if (!Array.isArray(value) || value.length > max) fail('BUDGET_EXCEEDED'); return value; }
function text(value, max = 500) { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail(); return value; }
function id(value) { text(value, 160); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) fail(); return value; }
function number(value, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) fail(); return value; }
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(Z|[+-]\d\d:\d\d)$/.test(value)) fail();
  const normalized = normalizeAcademicDeadline(value); if (normalized.precision !== 'instant') fail(); return Date.parse(normalized.instant);
}
const iso = value => new Date(value).toISOString();
function zone(value) { text(value, 100); try { new Intl.DateTimeFormat('en', { timeZone: value }); } catch { fail(); } return value; }
function localDate(at, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  return ['year', 'month', 'day'].map(key => parts.find(part => part.type === key).value).join('-');
}
function nextDayBoundary(at, timezone) {
  const date = localDate(at, timezone); let low = at; let high = at + 30 * 60 * MINUTE;
  if (localDate(high, timezone) === date) fail();
  while (high - low > 1) { const middle = Math.floor((low + high) / 2); if (localDate(middle, timezone) === date) low = middle; else high = middle; }
  return high;
}
function task(value, timezone) {
  object(value, ['id', 'title', 'status', 'deadline', 'effort_minutes', 'dependency_ids', 'manual_priority', 'pinned', 'revision', 'source_refs', 'origin', 'course_id', 'course_label', 'student_id', 'schema_version', 'created_at', 'updated_at', 'deleted_at', 'parent_id', 'recurrence', 'student_overrides', 'estimate_confidence'], ['id', 'title']);
  id(value.id); text(value.title); const status = value.status ?? 'pending'; if (!['pending', 'in_progress', 'completed', 'cancelled'].includes(status)) fail();
  const deadline = normalizeAcademicDeadline(value.deadline ?? { precision: 'unknown' }, timezone);
  const effort = value.effort_minutes ?? null; if (effort !== null) number(effort, 0, 144_000);
  const dependencies = [...new Set(array(value.dependency_ids || [], 100).map(id))].sort(); if (dependencies.includes(value.id)) fail();
  const priority = number(value.manual_priority ?? 0, 0, 5); if (value.pinned !== undefined && typeof value.pinned !== 'boolean') fail(); if (value.revision !== undefined) number(value.revision, 1, Number.MAX_SAFE_INTEGER);
  if (value.source_refs !== undefined) array(value.source_refs, 100);
  if (value.origin !== undefined && !['manual', 'imported', 'agent_proposed', 'agent_reviewed', 'migration'].includes(value.origin)) fail();
  if (value.schema_version !== undefined && value.schema_version !== 1) fail();
  for (const field of ['student_id', 'course_id', 'parent_id']) if (value[field] !== undefined && value[field] !== null) id(value[field]);
  if (value.course_label !== undefined && value.course_label !== null) text(value.course_label);
  for (const field of ['created_at', 'updated_at', 'deleted_at']) if (value[field] !== undefined && value[field] !== null) timestamp(value[field]);
  if (value.student_overrides !== undefined) array(value.student_overrides, 20).forEach(item => text(item, 100));
  if (value.recurrence !== undefined && value.recurrence !== null) { object(value.recurrence, ['frequency', 'interval', 'until'], ['frequency', 'interval']); if (!['daily', 'weekly', 'monthly'].includes(value.recurrence.frequency)) fail(); number(value.recurrence.interval, 1, 100); if (value.recurrence.until !== undefined && value.recurrence.until !== null && normalizeAcademicDeadline(value.recurrence.until).precision !== 'date') fail(); }
  if (value.estimate_confidence !== undefined && !['student', 'source', 'agent_estimate', 'unknown'].includes(value.estimate_confidence)) fail();
  return { ...value, status, deadline, effort_minutes: effort, dependency_ids: dependencies, manual_priority: priority, pinned: value.pinned ?? false, source_refs: value.source_refs ?? [], origin: value.origin ?? 'manual' };
}
function tasks(values, timezone) {
  const parsed = array(values).map(value => task(value, timezone)); const byId = new Map(parsed.map(item => [item.id, item])); if (byId.size !== parsed.length) fail();
  // A missing prerequisite is reported as blocked later; cycles are rejected before a proposal is produced.
  const visiting = new Set(); const visited = new Set();
  for (const item of parsed) {
    const stack = [{ id: item.id, exit: false }];
    while (stack.length) {
      const row = stack.pop(); if (row.exit) { visiting.delete(row.id); visited.add(row.id); continue; }
      if (visited.has(row.id) || !byId.has(row.id)) continue; if (visiting.has(row.id)) fail();
      visiting.add(row.id); stack.push({ id: row.id, exit: true }); for (const dependency of byId.get(row.id).dependency_ids) stack.push({ id: dependency, exit: false });
    }
  }
  return parsed;
}
function bucket(item, now, timezone) {
  if (item.deadline.precision === 'unknown') return item.source_refs.length || item.origin !== 'manual' || item.deadline.original ? 4 : 5;
  const date = localDate(now, timezone); const overdue = item.deadline.precision === 'instant' ? Date.parse(item.deadline.instant) < now : item.deadline.date < date;
  if (overdue) return 0; if (item.pinned) return 1;
  const today = item.deadline.precision === 'instant' ? localDate(Date.parse(item.deadline.instant), timezone) === date : item.deadline.date === date;
  return today ? 2 : 3;
}
function compareTasks(a, b, now, timezone) {
  const first = bucket(a, now, timezone) - bucket(b, now, timezone) || b.manual_priority - a.manual_priority;
  if (first) return first;
  const due = item => item.deadline.precision === 'instant' ? item.deadline.instant : item.deadline.precision === 'date' ? `${item.deadline.date}T99` : '\uffff';
  return due(a).localeCompare(due(b)) || a.id.localeCompare(b.id);
}
/** Explainable deterministic Today ordering; no source date is promoted into an invented instant. */
export function rankToday(raw) {
  const input = clone(raw); object(input, ['tasks', 'now', 'timezone'], ['tasks', 'now', 'timezone']); const now = timestamp(input.now); const timezone = zone(input.timezone);
  const pending = tasks(input.tasks, timezone).filter(item => !['completed', 'cancelled'].includes(item.status) && !item.deleted_at).sort((a, b) => compareTasks(a, b, now, timezone));
  const reason = ['overdue', 'manually_pinned', 'due_today', 'dated', 'deadline_needs_review', 'intentionally_undated'];
  const rows = pending.map(item => ({ ...item, ranking_reason: reason[bucket(item, now, timezone)], estimate_status: item.effort_minutes === null ? 'needs_effort' : 'known_estimate' }));
  return { local_date: localDate(now, timezone), timezone, now: iso(now), ordered: rows.filter(item => !['deadline_needs_review', 'intentionally_undated'].includes(item.ranking_reason)), review: rows.filter(item => item.ranking_reason === 'deadline_needs_review'), undated: rows.filter(item => item.ranking_reason === 'intentionally_undated') };
}
function intervals(raw) {
  return array(raw).map(row => { object(row, ['start', 'end', 'id', 'label'], ['start', 'end']); const start = timestamp(row.start); const end = timestamp(row.end); if (start >= end) fail(); if (row.id !== undefined) id(row.id); if (row.label !== undefined) text(row.label); return { start, end }; }).sort((a, b) => a.start - b.start || a.end - b.end);
}
function mergeIntervals(values) { const result = []; for (const interval of values) { const last = result.at(-1); if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end); else result.push({ ...interval }); } return result; }
function subtract(values, cuts) {
  let result = values.map(value => ({ ...value }));
  for (const cut of cuts) result = result.flatMap(value => cut.end <= value.start || cut.start >= value.end ? [value] : [{ start: value.start, end: Math.min(value.end, cut.start) }, { start: Math.max(value.start, cut.end), end: value.end }].filter(item => item.start < item.end));
  return result;
}
function splitDays(interval, timezone) { const result = []; for (let start = interval.start; start < interval.end;) { const end = Math.min(interval.end, nextDayBoundary(start, timezone)); result.push({ start, end, day: localDate(start, timezone) }); start = end; } return result; }
function deadlineAllows(item, end, timezone) {
  if (item.deadline.precision === 'instant') return end <= Date.parse(item.deadline.instant);
  if (item.deadline.precision === 'date') return localDate(end - 1, item.deadline.timezone || timezone) <= item.deadline.date;
  return true;
}
function beforeDeadline(item, start, end, timezone) {
  if (item.deadline.precision === 'instant') return Math.min(end, Date.parse(item.deadline.instant));
  if (item.deadline.precision !== 'date') return end;
  const deadlineZone = item.deadline.timezone || timezone;
  if (localDate(start, deadlineZone) > item.deadline.date) return start;
  if (localDate(end - 1, deadlineZone) <= item.deadline.date) return end;
  let low = start; let high = end;
  while (high - low > 1) { const middle = Math.floor((low + high) / 2); if (localDate(middle, deadlineZone) <= item.deadline.date) low = middle; else high = middle; }
  return high;
}

/** A bounded greedy schedule preview. Unknown effort stays unresolved; no tasks or events are written. */
export function planStudyWork(raw) {
  const input = clone(raw);
  object(input, ['tasks', 'availability', 'busy', 'pinnedBlocks', 'now', 'timezone', 'horizonEnd', 'maxDailyMinutes', 'bufferMinutes', 'minBlockMinutes'], ['tasks', 'availability', 'now', 'timezone', 'horizonEnd']);
  const now = timestamp(input.now); const horizon = timestamp(input.horizonEnd); const timezone = zone(input.timezone);
  if (horizon <= now || horizon - now > 90 * 24 * 60 * MINUTE) fail('BUDGET_EXCEEDED');
  const maximum = number(input.maxDailyMinutes ?? 240, 1, 1440); const buffer = number(input.bufferMinutes ?? 0, 0, 120); const minimum = number(input.minBlockMinutes ?? 1, 1, 180);
  const parsed = tasks(input.tasks, timezone); const byId = new Map(parsed.map(item => [item.id, item]));
  const availability = mergeIntervals(intervals(input.availability).map(row => ({ start: Math.max(now, row.start), end: Math.min(horizon, row.end) })).filter(row => row.start < row.end));
  const busy = mergeIntervals(intervals(input.busy || [])); const bufferedBusy = busy.map(row => ({ start: row.start - buffer * MINUTE, end: row.end + buffer * MINUTE }));
  let free = subtract(availability, bufferedBusy).flatMap(interval => splitDays(interval, timezone).map(({ start, end }) => ({ start, end }))); const blocks = []; const conflicts = []; const unscheduled = []; const usage = new Map(); const completion = new Map(); const pinnedIds = new Set();
  for (const item of parsed) if (item.status === 'completed') completion.set(item.id, now);
  function addUsage(start, end) { for (const part of splitDays({ start, end }, timezone)) usage.set(part.day, (usage.get(part.day) || 0) + (part.end - part.start) / MINUTE); }
  for (const pinned of array(input.pinnedBlocks || [], 2000)) {
    object(pinned, ['task_id', 'start', 'end', 'id'], ['task_id', 'start', 'end']); const item = byId.get(id(pinned.task_id)); if (!item) fail();
    const start = timestamp(pinned.start); const end = timestamp(pinned.end); if (start >= end) fail(); if (pinned.id !== undefined) id(pinned.id);
    pinnedIds.add(item.id); const reasons = [];
    if (start < now || end > horizon) reasons.push('outside_horizon');
    if (!availability.some(row => row.start <= start && row.end >= end)) reasons.push('outside_availability');
    if (busy.some(row => row.start < end && row.end > start)) reasons.push('busy_conflict');
    else if (bufferedBusy.some(row => row.start < end && row.end > start)) reasons.push('busy_buffer_conflict');
    if (blocks.some(row => Date.parse(row.start) < end && Date.parse(row.end) > start)) reasons.push('pinned_overlap');
    else if (blocks.some(row => Date.parse(row.start) - buffer * MINUTE < end && Date.parse(row.end) + buffer * MINUTE > start)) reasons.push('pinned_buffer_conflict');
    if (!deadlineAllows(item, end, timezone)) reasons.push('after_deadline');
    if (['completed', 'cancelled'].includes(item.status)) reasons.push('task_not_pending');
    blocks.push({ task_id: item.id, title: item.title, start: iso(start), end: iso(end), minutes: (end - start) / MINUTE, pinned: true, needs_review: reasons.length > 0 });
    addUsage(start, end); free = subtract(free, [{ start: start - buffer * MINUTE, end: end + buffer * MINUTE }]);
    if (reasons.length) conflicts.push({ task_id: item.id, reasons });
    else completion.set(item.id, Math.max(completion.get(item.id) || now, end));
  }
  for (const taskId of pinnedIds) {
    const item = byId.get(taskId); const minutes = blocks.filter(block => block.task_id === taskId).reduce((sum, block) => sum + block.minutes, 0);
    if (item.effort_minutes === null || item.effort_minutes !== minutes) {
      completion.delete(taskId); conflicts.push({ task_id: taskId, reasons: ['pinned_effort_needs_review'] });
      if (item.effort_minutes === null || item.effort_minutes > minutes) unscheduled.push({ task_id: taskId, title: item.title, remaining_minutes: item.effort_minutes === null ? null : item.effort_minutes - minutes, reason: item.effort_minutes === null ? 'needs_effort' : 'pinned_effort_mismatch' });
    }
  }
  for (const [day, minutes] of usage) if (minutes > maximum) conflicts.push({ day, reasons: ['pinned_daily_limit'], minutes_over: minutes - maximum });
  // Pinned blocks remain fixed; unmet prerequisites are reported rather than silently moved.
  for (const block of blocks) {
    const item = byId.get(block.task_id);
    if (item.dependency_ids.some(dependency => !completion.has(dependency) || completion.get(dependency) > Date.parse(block.start))) { block.needs_review = true; completion.delete(item.id); conflicts.push({ task_id: item.id, reasons: ['pinned_prerequisite_conflict'] }); }
  }
  const pending = parsed.filter(item => !['completed', 'cancelled'].includes(item.status) && !item.deleted_at && !pinnedIds.has(item.id)).sort((a, b) => compareTasks(a, b, now, timezone));
  const processed = new Set(parsed.filter(item => ['completed', 'cancelled'].includes(item.status) || pinnedIds.has(item.id) || item.deleted_at).map(item => item.id));
  while (processed.size < parsed.length) {
    const candidates = pending.filter(item => !processed.has(item.id) && item.dependency_ids.every(dependency => processed.has(dependency) || !byId.has(dependency)));
    if (!candidates.length) break; // Cycles are already rejected; this handles only removed records.
    for (const item of candidates) {
      processed.add(item.id); const blocking = item.dependency_ids.filter(dependency => !completion.has(dependency));
      if (blocking.length) { unscheduled.push({ task_id: item.id, title: item.title, remaining_minutes: item.effort_minutes, reason: 'prerequisite_unscheduled', dependency_ids: blocking }); continue; }
      if (item.effort_minutes === null) { unscheduled.push({ task_id: item.id, title: item.title, remaining_minutes: null, reason: 'needs_effort' }); continue; }
      const earliest = Math.max(now, ...item.dependency_ids.map(dependency => completion.get(dependency))); let remaining = item.effort_minutes;
      if (!remaining) { completion.set(item.id, earliest); continue; }
      for (let index = 0; index < free.length && remaining > 0; index++) {
        const interval = free[index]; const start = Math.max(interval.start, earliest); const deadlineEnd = beforeDeadline(item, start, interval.end, timezone); if (start >= deadlineEnd) continue;
        const part = splitDays({ start, end: deadlineEnd }, timezone)[0]; const capacity = maximum - (usage.get(part.day) || 0); if (capacity < Math.min(minimum, remaining)) continue;
        const minutes = Math.min(remaining, Math.floor((part.end - start) / MINUTE), Math.floor(capacity)); if (minutes < minimum && minutes < remaining) continue;
        if (minutes <= 0) continue; const end = start + minutes * MINUTE;
        blocks.push({ task_id: item.id, title: item.title, start: iso(start), end: iso(end), minutes, pinned: false, needs_review: item.deadline.precision === 'unknown', deadline_policy: item.deadline.precision === 'date' ? 'date_only_local_day_limit' : item.deadline.precision });
        remaining -= minutes; addUsage(start, end); const cutEnd = end + buffer * MINUTE;
        free = subtract(free, [{ start: start - buffer * MINUTE, end: cutEnd }]); index = -1;
        if (!remaining) completion.set(item.id, end);
      }
      if (remaining) unscheduled.push({ task_id: item.id, title: item.title, remaining_minutes: remaining, reason: item.deadline.precision !== 'unknown' && !deadlineAllows(item, now + 1, timezone) ? 'deadline_passed' : 'insufficient_capacity' });
    }
  }
  blocks.sort((a, b) => a.start.localeCompare(b.start) || a.task_id.localeCompare(b.task_id));
  const knownRequired = parsed.filter(item => !['completed', 'cancelled'].includes(item.status) && !item.deleted_at && item.effort_minutes !== null).reduce((sum, item) => sum + item.effort_minutes, 0);
  const proposedMinutes = blocks.filter(block => !block.pinned).reduce((sum, block) => sum + block.minutes, 0);
  const pinnedMinutes = blocks.filter(block => block.pinned && !['completed', 'cancelled'].includes(byId.get(block.task_id).status)).reduce((sum, block) => sum + block.minutes, 0);
  const payload = { format: 'learnbridge-study-plan', schema_version: 1, state: 'proposal', timezone, now: iso(now), horizon_end: iso(horizon), policy: { max_daily_minutes: maximum, buffer_minutes: buffer, min_block_minutes: minimum, algorithm: 'deterministic-greedy/1' }, input_hash: fingerprint(input), task_versions: parsed.map(item => ({ id: item.id, revision: item.revision ?? null, deadline: item.deadline, source_refs: item.source_refs })).sort((a, b) => a.id.localeCompare(b.id)), blocks, unscheduled, conflicts, completed_task_ids: parsed.filter(item => item.status === 'completed').map(item => item.id).sort(), coverage: { known_required_minutes: knownRequired, proposed_minutes: proposedMinutes, pinned_minutes: pinnedMinutes, unscheduled_minutes: unscheduled.reduce((sum, item) => sum + (item.remaining_minutes || 0), 0), unknown_effort_count: unscheduled.filter(item => item.reason === 'needs_effort').length, all_known_work_fits: unscheduled.length === 0 && conflicts.length === 0 }, daily_minutes: [...usage].map(([date, minutes]) => ({ date, minutes })).sort((a, b) => a.date.localeCompare(b.date)), external_writes: 0 };
  return { ...payload, plan_hash: fingerprint(payload) };
}

/** Versioned practice cadence; an attempt is evidence about that exercise, not global mastery. */
export function nextPracticeReview(raw) {
  const input = clone(raw); object(input, ['attempted_at', 'correct', 'previous_correct_streak', 'rule_version'], ['attempted_at', 'correct']); const at = timestamp(input.attempted_at);
  if (typeof input.correct !== 'boolean' || (input.rule_version !== undefined && input.rule_version !== 'practice-cadence/1')) fail();
  const streak = number(input.previous_correct_streak ?? 0, 0, 1000); const nextStreak = input.correct ? streak + 1 : 0; const intervals = [1, 3, 7, 14, 30]; const days = input.correct ? intervals[Math.min(nextStreak - 1, intervals.length - 1)] : 1;
  return { rule_version: 'practice-cadence/1', attempted_at: iso(at), correct: input.correct, correct_streak: nextStreak, interval_days: days, next_review_at: iso(at + days * 24 * 60 * MINUTE), interval_policy: 'elapsed_24_hour_days', mastery_claim: false };
}

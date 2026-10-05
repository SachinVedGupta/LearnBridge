import { randomUUID } from 'node:crypto';
import { LearnBridgeError, parseDeadline } from '@learnbridge/core';
import { lifeObject, lifeText, lifeStamp, lifeTimezone, lifeHash, localDay } from './life.mjs';

const CATEGORY = 'selected_task_reminders_v1';
export const REMINDER_LIMITS = Object.freeze({ schedules: 20, tasks_per_schedule: 50, inbox_per_schedule: 50, due_within_minutes: 10080, tick_interval_ms: 30000 });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fail = (code = 'INVALID_INPUT') => { throw new LearnBridgeError(code); };
const id = value => { if (typeof value !== 'string' || !UUID.test(value)) fail(); return value.toLowerCase(); };
const revision = value => { if (!Number.isSafeInteger(value) || value < 1) fail(); return value; };
const digest = value => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('VERSION_MISMATCH'); return value; };
const states = ['paused', 'active', 'cancelled'];
const stages = ['due_soon', 'due_today', 'overdue'];
const deadlineHash = deadline => lifeHash({ precision: deadline.precision, date: deadline.date ?? null, instant: deadline.instant ?? null, timezone: deadline.timezone ?? null });

/** Date-only deadlines keep calendar-date precision. No UTC midnight or invented due hour. */
export function classifyReminderDeadline(task, now, schedule) {
  if (!task || ['completed', 'cancelled'].includes(task.status) || task.deadline.precision === 'unknown') return null;
  const deadline = task.deadline, timezone = deadline.timezone ?? schedule.timezone;
  if (deadline.precision === 'instant') {
    const delta = Date.parse(deadline.instant) - Date.parse(now);
    return delta <= 0 ? 'overdue' : delta <= schedule.due_within_minutes * 60000 ? 'due_soon' : null;
  }
  const today = localDay(now, timezone), through = localDay(new Date(Date.parse(now) + schedule.due_within_minutes * 60000).toISOString(), timezone);
  return deadline.date < today ? 'overdue' : deadline.date === today ? 'due_today' : deadline.date <= through ? 'due_soon' : null;
}

/** Student-selected task checks only. It creates no task, model request, provider call or OS notification. */
export function createReminderService({ store, clock = Date.now }) {
  let disposed = false, lastCheck = null;
  const stamp = () => {
    const value = clock();
    if (typeof value === 'string') return lifeStamp(value);
    if (!Number.isFinite(value)) fail();
    let result; try { result = new Date(value).toISOString(); } catch { fail(); }
    return lifeStamp(result);
  };
  function validate(row) {
    if (!row || row.kind !== 'routine' || row.data.category !== CATEGORY) fail('SCOPE_DENIED');
    const data = row.data;
    lifeObject(data, ['category', 'format', 'state', 'epoch', 'task_ids', 'timezone', 'due_within_minutes', 'watermarks', 'inbox', 'discarded_inbox_count', 'creation_operation', 'last_published_at'],
      ['category', 'format', 'state', 'epoch', 'task_ids', 'timezone', 'due_within_minutes', 'watermarks', 'inbox', 'discarded_inbox_count', 'creation_operation', 'last_published_at']);
    if (data.format !== 1 || !states.includes(data.state) || !Number.isSafeInteger(data.epoch) || data.epoch < 0
      || !Array.isArray(data.task_ids) || !data.task_ids.length || data.task_ids.length > REMINDER_LIMITS.tasks_per_schedule
      || new Set(data.task_ids.map(id)).size !== data.task_ids.length
      || !Number.isSafeInteger(data.due_within_minutes) || data.due_within_minutes < 15 || data.due_within_minutes > REMINDER_LIMITS.due_within_minutes
      || !Array.isArray(data.inbox) || data.inbox.length > REMINDER_LIMITS.inbox_per_schedule
      || !Number.isSafeInteger(data.discarded_inbox_count) || data.discarded_inbox_count < 0) fail('VERSION_MISMATCH');
    lifeTimezone(data.timezone); if (data.last_published_at !== null) lifeStamp(data.last_published_at);
    lifeObject(data.watermarks, data.task_ids);
    for (const watermark of Object.values(data.watermarks)) {
      lifeObject(watermark, ['deadline_hash', 'stage'], ['deadline_hash', 'stage']); digest(watermark.deadline_hash);
      if (watermark.stage !== null && !stages.includes(watermark.stage)) fail('VERSION_MISMATCH');
    }
    const eventIds = new Set();
    for (const event of data.inbox) {
      lifeObject(event, ['id', 'task_id', 'task_revision', 'task_title', 'deadline', 'deadline_hash', 'stage', 'observed_at', 'acknowledged_at'],
        ['id', 'task_id', 'task_revision', 'task_title', 'deadline', 'deadline_hash', 'stage', 'observed_at', 'acknowledged_at']);
      id(event.id); id(event.task_id); revision(event.task_revision); lifeText(event.task_title, 500); digest(event.deadline_hash); lifeStamp(event.observed_at);
      if (!data.task_ids.includes(event.task_id) || !stages.includes(event.stage) || eventIds.has(event.id)) fail('VERSION_MISMATCH');
      eventIds.add(event.id); if (event.acknowledged_at !== null) lifeStamp(event.acknowledged_at);
      const deadline = parseDeadline(event.deadline);
      if (deadline.precision === 'unknown' || deadlineHash(deadline) !== event.deadline_hash) fail('VERSION_MISMATCH');
    }
    lifeObject(data.creation_operation, ['key', 'request_hash'], ['key', 'request_hash']); digest(data.creation_operation.request_hash);
    if (typeof data.creation_operation.key !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(data.creation_operation.key)) fail('VERSION_MISMATCH');
    return row;
  }
  const schedules = () => {
    const found = store.listWorkspaceRecords({ kind: 'routine' }).filter(row => row.data.category === CATEGORY);
    if (found.length > REMINDER_LIMITS.schedules) fail('BUDGET_EXCEEDED');
    return found.map(validate);
  };
  const get = value => validate(store.getWorkspaceRecord(id(value)));
  const publish = (row, data) => validate(store.commitWorkspaceBatch({ creates: [], updates: [{ id: row.id, expected_revision: row.revision, data }] }).updates[0]);
  const available = () => { if (disposed) fail('CANCELLED'); };
  function status() { return { processing: 'selected_existing_local_tasks', delivery: 'local_in_app_inbox', requires_runtime_running: true,
    sleeping_laptop_execution: false, os_notifications: false, provider_reads: false, external_actions: false,
    default_state: 'paused', stopped: disposed, last_check: lastCheck, limits: REMINDER_LIMITS }; }
  function view(row) {
    return { ...row, selected_tasks: row.data.task_ids.map(taskId => {
      const task = store.getTask(taskId); return task ? { id: task.id, title: task.title, revision: task.revision, deadline: task.deadline, status: task.status } : { id: taskId, unavailable: true };
    }) };
  }
  function drain() {
    if (disposed) return { stopped: true, checked: 0, published: 0, notifications: 0, conflicts: 0 };
    const now = stamp(), result = { stopped: false, checked: 0, published: 0, notifications: 0, conflicts: 0 };
    for (const snapshot of schedules()) {
      if (snapshot.data.state !== 'active') continue;
      const row = get(snapshot.id);
      if (row.revision !== snapshot.revision || row.data.epoch !== snapshot.data.epoch || row.data.state !== 'active') { result.conflicts++; continue; }
      const watermarks = structuredClone(row.data.watermarks), additions = [], pins = [];
      for (const taskId of row.data.task_ids) {
        const task = store.getTask(taskId); result.checked++; pins.push({ id: taskId, revision: task?.revision ?? null });
        if (!task || ['completed', 'cancelled'].includes(task.status) || task.deadline.precision === 'unknown') continue;
        const deadline_hash = deadlineHash(task.deadline), stage = classifyReminderDeadline(task, now, row.data), previous = watermarks[taskId];
        // Returning from overdue to an earlier stage after a backward clock jump must not repeat the same deadline.
        if (previous?.deadline_hash === deadline_hash && (previous.stage === stage || (previous.stage !== null && (stage === null || stages.indexOf(stage) < stages.indexOf(previous.stage))))) continue;
        watermarks[taskId] = { deadline_hash, stage };
        if (stage) additions.push({ id: randomUUID(), task_id: task.id, task_revision: task.revision, task_title: task.title,
          deadline: task.deadline, deadline_hash, stage, observed_at: now, acknowledged_at: null });
      }
      if (lifeHash(watermarks) === lifeHash(row.data.watermarks) && !additions.length) continue;
      if (pins.some(pin => (store.getTask(pin.id)?.revision ?? null) !== pin.revision)) { result.conflicts++; continue; }
      const all = [...row.data.inbox, ...additions], excess = Math.max(0, all.length - REMINDER_LIMITS.inbox_per_schedule);
      const data = { ...row.data, watermarks, inbox: all.slice(-REMINDER_LIMITS.inbox_per_schedule),
        discarded_inbox_count: row.data.discarded_inbox_count + excess, last_published_at: now };
      try {
        publish(row, data); result.published++; result.notifications += additions.length;
      } catch (error) {
        if (error?.code !== 'REVISION_CONFLICT') throw error;
        result.conflicts++;
      }
    }
    lastCheck = { at: now, ...result }; return result;
  }
  return {
    status,
    context() { available(); return { tasks: store.listTasks().map(task => ({ id: task.id, title: task.title, revision: task.revision, deadline: task.deadline, status: task.status })), ...status() }; },
    listSchedules() { available(); return schedules().map(view); },
    listInbox() { available(); return schedules().flatMap(row => row.data.inbox.map(event => ({ ...event, schedule_id: row.id,
      schedule_title: row.title, schedule_revision: row.revision, schedule_state: row.data.state, timezone: row.data.timezone })))
      .sort((a, b) => b.observed_at.localeCompare(a.observed_at) || a.id.localeCompare(b.id)); },
    createSchedule(input, { idempotencyKey } = {}) {
      available(); lifeObject(input, ['title', 'task_ids', 'timezone', 'due_within_minutes'], ['title', 'task_ids', 'timezone', 'due_within_minutes']);
      const title = lifeText(input.title, 300), timezone = lifeTimezone(input.timezone);
      if (!Array.isArray(input.task_ids) || !input.task_ids.length || input.task_ids.length > REMINDER_LIMITS.tasks_per_schedule) fail();
      const task_ids = input.task_ids.map(id); if (new Set(task_ids).size !== task_ids.length) fail();
      if (!Number.isSafeInteger(input.due_within_minutes) || input.due_within_minutes < 15 || input.due_within_minutes > REMINDER_LIMITS.due_within_minutes
        || typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(idempotencyKey)) fail();
      const normalized = { title, task_ids, timezone, due_within_minutes: input.due_within_minutes }, request_hash = lifeHash(normalized);
      const rows = schedules(), existing = rows.find(row => row.data.creation_operation.key === idempotencyKey);
      if (existing) { if (existing.data.creation_operation.request_hash !== request_hash) fail('REVISION_CONFLICT'); return view(existing); }
      if (rows.length >= REMINDER_LIMITS.schedules) fail('BUDGET_EXCEEDED');
      for (const taskId of task_ids) if (!store.getTask(taskId)) fail('SCOPE_DENIED');
      const created = store.commitWorkspaceBatch({ creates: [{ id: randomUUID(), kind: 'routine', title, data: { category: CATEGORY, format: 1,
        state: 'paused', epoch: 0, task_ids, timezone, due_within_minutes: input.due_within_minutes, watermarks: {}, inbox: [],
        discarded_inbox_count: 0, creation_operation: { key: idempotencyKey, request_hash }, last_published_at: null } }], updates: [] }).creates[0];
      return view(validate(created));
    },
    setState(value, input) {
      available(); lifeObject(input, ['expected_revision', 'state', 'confirmed'], ['expected_revision', 'state', 'confirmed']); revision(input.expected_revision);
      if (!states.includes(input.state) || input.confirmed !== true) fail('CONSENT_REQUIRED');
      const row = get(value); if (row.revision !== input.expected_revision) fail('REVISION_CONFLICT');
      if (row.data.state === 'cancelled' && input.state !== 'cancelled') fail('CANCELLED');
      if (row.data.state === input.state) return view(row);
      if (input.state === 'active') for (const taskId of row.data.task_ids) if (!store.getTask(taskId)) fail('SCOPE_DENIED');
      return view(publish(row, { ...row.data, state: input.state, epoch: row.data.epoch + 1 }));
    },
    acknowledge(value, input) {
      available(); lifeObject(input, ['expected_revision', 'event_id'], ['expected_revision', 'event_id']); revision(input.expected_revision); id(input.event_id);
      const row = get(value), event = row.data.inbox.find(item => item.id === input.event_id); if (!event) fail('SCOPE_DENIED');
      if (event.acknowledged_at !== null) return view(row);
      if (row.revision !== input.expected_revision) fail('REVISION_CONFLICT');
      const now = stamp(); return view(publish(row, { ...row.data, inbox: row.data.inbox.map(item => item.id === event.id ? { ...item, acknowledged_at: now } : item) }));
    },
    drain, tick: drain,
    dispose() { disposed = true; },
  };
}

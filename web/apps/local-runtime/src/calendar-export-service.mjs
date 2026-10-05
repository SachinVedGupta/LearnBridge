import { createHash } from 'node:crypto';
import { LearnBridgeError, parseDeadline } from '@learnbridge/core';
import { lifeHash, lifeStamp, lifeDate, lifeTimezone } from './life.mjs';
import { createStudentWorkspace } from './student-workspace.mjs';
import { resolveCalendarBusySource } from './calendar-import-service.mjs';
import { verifyPlanTaskProvenance } from './plan-task-service.mjs';

const FORMAT = 'calendar_export_preview_v1';
export const CALENDAR_EXPORT_LIMITS = Object.freeze({ selected_tasks: 25, events: 50, retained_previews: 100, ttl_ms: 600000, ics_bytes: 48000, record_bytes: 120000 });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fail = (code = 'INVALID_INPUT') => { throw new LearnBridgeError(code); };
const id = value => { if (typeof value !== 'string' || !UUID.test(value)) fail(); return value.toLowerCase(); };
const revision = value => { if (!Number.isSafeInteger(value) || value < 1) fail(); return value; };
const digest = value => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(); return value; };
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
function object(value, allowed, required = allowed) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail(); const props = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(props).some(key => typeof key !== 'string' || !allowed.includes(key) || !('value' in props[key]) || !props[key].enumerable) || required.some(key => !Object.hasOwn(props, key))) fail();
}
function ids(values) {
  if (!Array.isArray(values) || !values.length || values.length > CALENDAR_EXPORT_LIMITS.selected_tasks) fail();
  const props = Object.getOwnPropertyDescriptors(values);
  if (Reflect.ownKeys(props).some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= values.length || !('value' in props[key]) || !props[key].enumerable))) fail();
  const result = Array.from({ length: values.length }, (_, i) => { if (!Object.hasOwn(props, String(i))) fail(); return id(props[i].value); });
  if (new Set(result).size !== result.length) fail(); return result.sort();
}
function request(raw) {
  object(raw, ['mode', 'task_ids', 'plan_id', 'expected_revision', 'plan_hash'], ['mode']);
  if (raw.mode === 'tasks') { object(raw, ['mode', 'task_ids']); return { mode: 'tasks', task_ids: ids(raw.task_ids) }; }
  if (raw.mode === 'study_plan') { object(raw, ['mode', 'plan_id', 'expected_revision', 'plan_hash']); return { mode: raw.mode, plan_id: id(raw.plan_id), expected_revision: revision(raw.expected_revision), plan_hash: digest(raw.plan_hash) }; }
  fail();
}
// Every untrusted string is a TEXT value, never a property name/parameter/URI.
const text = value => String(value).replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
function fold(line) {
  let piece = '', bytes = 0; const lines = [];
  for (const char of line) { const length = Buffer.byteLength(char); if (bytes + length > 75) { lines.push(piece); piece = ' '; bytes = 1; } piece += char; bytes += length; }
  lines.push(piece); return lines.join('\r\n');
}
const wholeSecond = value => (lifeStamp(value), value.endsWith('.000Z'));
const utc = value => lifeStamp(value).replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const dateValue = value => lifeDate(value).replaceAll('-', '');
const nextDate = value => { lifeDate(value); const next = new Date(Date.parse(`${value}T00:00:00.000Z`) + 86400000).toISOString().slice(0, 10); return lifeDate(next); };
function formatCalendar(events) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//LearnBridge//Reviewed local calendar export v1//EN', 'CALSCALE:GREGORIAN'];
  for (const event of events) {
    lines.push('BEGIN:VEVENT', `UID:${event.uid}`, `DTSTAMP:${utc(event.stamp)}`, `SEQUENCE:${event.sequence}`, `SUMMARY:${text(event.title)}`);
    if (event.kind === 'date_deadline') lines.push(`DTSTART;VALUE=DATE:${dateValue(event.deadline.date)}`, `DTEND;VALUE=DATE:${dateValue(nextDate(event.deadline.date))}`);
    else { lines.push(`DTSTART:${utc(event.start)}`); if (event.end) lines.push(`DTEND:${utc(event.end)}`); }
    // Some released calendar parsers ambiguously decode literal backslash+n
    // sequences inside TEXT. Keep canonical JSON lossless in an ASCII X property.
    const description = `${event.provenance.semantics}\nLocal task: ${event.task_id}\nDeadline precision: ${event.deadline.precision}\nOriginal source date: ${event.deadline.original ?? 'not supplied'}`;
    lines.push(`TRANSP:${event.kind === 'study_block' ? 'OPAQUE' : 'TRANSPARENT'}`, `DESCRIPTION:${text(description)}`, `X-LEARNBRIDGE-TASK-ID:${event.task_id}`, `X-LEARNBRIDGE-PROVENANCE:${Buffer.from(JSON.stringify(event.provenance), 'utf8').toString('base64url')}`, `X-LEARNBRIDGE-PROVENANCE-HASH:${lifeHash(event.provenance)}`);
    if (event.timezone) lines.push(`X-LEARNBRIDGE-SOURCE-TIMEZONE:${text(event.timezone)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR'); const content = lines.map(fold).join('\r\n') + '\r\n';
  if (Buffer.byteLength(content) > CALENDAR_EXPORT_LIMITS.ics_bytes) fail('BUDGET_EXCEEDED'); return content;
}

/** Reviewed local file preparation only. No provider, model, scan, task write or remote calendar operation. */
export function createCalendarExportService({ store, studentWorkspace = createStudentWorkspace(store), clock = Date.now }) {
  const stamp = () => { let value; try { value = new Date(clock()).toISOString(); } catch { fail(); } return lifeStamp(value); };
  const records = () => store.listWorkspaceRecords({ kind: 'artifact' }).filter(row => row.data.format === FORMAT);
  const uid = value => `${lifeHash({ student_id: store.identity.student_id, ...value })}@local.learnbridge`;
  const taskPin = task => ({ id: task.id, revision: task.revision, hash: lifeHash(task) });
  const learningSource = task => verifyPlanTaskProvenance({ store, getLibrary: studentWorkspace.library, taskId: task.id });
  function provenance(task, learning = learningSource(task)) {
    const academic = store.listWorkspaceRecords({ kind: 'inbox_item' }).filter(row => row.data.format === 'academic_task_proposal_v1' && row.data.state === 'accepted' && row.data.task_id === task.id);
    if (academic.length > 1) fail('VERSION_MISMATCH');
    const pins = [...learning.pins], sources = [];
    for (const row of academic) {
      const data = row.data; if (data.payload_hash !== lifeHash({ task: data.task, source: data.source, source_pins: data.source_pins })) fail('VERSION_MISMATCH');
      const current = studentWorkspace.getCurrentSnapshot(data.source.snapshot_id);
      pins.push({ kind: 'academic_proposal', id: row.id, revision: row.revision, hash: lifeHash({ task: data.task, source: data.source, source_pins: data.source_pins, task_id: data.task_id }) },
        { kind: 'academic_snapshot', id: current.id, revision: current.revision, hash: current.data.snapshot.snapshot_hash, stream_id: current.stream_id ?? null, stream_revision: current.stream_revision ?? 0 });
      sources.push({ origin: 'accepted_academic_proposal', proposal_id: row.id, source: data.source,
        accepted_source_pins: data.source_pins, local_task_differs: task.title !== data.task.title || lifeHash(task.deadline) !== lifeHash(data.task.deadline) });
    }
    return { pins, data: { local_task_id: task.id, local_task_revision: task.revision, local_task_hash: lifeHash(task), origin: task.origin,
      deadline: parseDeadline(task.deadline), course_label: task.course_label ?? null, source_refs: task.source_refs, accepted_academic_sources: sources,
      ...(learning.receipts.length ? { accepted_learning_plan_sources: learning.receipts } : {}) } };
  }
  function planRecord(value) {
    const row = store.getWorkspaceRecord(value.plan_id), data = row?.data, plan = data?.plan;
    if (!row || row.kind !== 'plan' || ![undefined, 'calendar_study_plan_v1'].includes(data.format) || typeof data.run_id !== 'string' || !plan || plan.format !== 'learnbridge-study-plan') fail('UNSUPPORTED');
    if (row.revision !== value.expected_revision || plan.plan_hash !== value.plan_hash || data.state !== 'accepted' || data.reviewer !== store.identity.student_id) fail('REVISION_CONFLICT');
    const { plan_hash, ...payload } = plan; if (lifeHash(payload) !== plan_hash) fail('VERSION_MISMATCH'); lifeTimezone(plan.timezone);
    const run = store.getRun(id(data.run_id));
    const steps = store.listRunSteps(data.run_id), allocate = steps.find(step => step.key === 'allocate');
    if (!run || !['plan.today', 'plan.with_calendar'].includes(run.recipe_id) || run.state !== 'completed' || !allocate || allocate.state !== 'verified' || lifeHash(allocate.result) !== lifeHash(plan)) fail('VERSION_MISMATCH');
    if (run.recipe_id === 'plan.with_calendar') studentWorkspace.verifyCalendarPlan(row);
    else if (data.format !== undefined) fail('VERSION_MISMATCH');
    const tasks = store.listTasks();
    if (!Array.isArray(plan.task_versions) || plan.task_versions.length !== tasks.length || plan.task_versions.some(pin => tasks.find(task => task.id === pin.id)?.revision !== pin.revision)) fail('REVISION_CONFLICT');
    // Capacity is based on every task, including unscheduled work. A stale
    // learning handoff cannot remain hidden behind a different emitted block.
    for (const task of tasks) learningSource(task);
    if (!Array.isArray(plan.blocks) || !plan.blocks.length || plan.blocks.length > CALENDAR_EXPORT_LIMITS.events) fail('BUDGET_EXCEEDED');
    if (!Array.isArray(plan.conflicts) || plan.conflicts.length || plan.blocks.some(block => block.needs_review)) fail('CONSENT_REQUIRED');
    return row;
  }
  function selected(value) {
    let tasks, plan = null; const pins = [], events = [], omitted = [];
    if (value.mode === 'tasks') tasks = value.task_ids.map(taskId => { const task = store.getTask(taskId); if (!task) fail('SCOPE_DENIED'); return task; });
    else { plan = planRecord(value); tasks = store.listTasks(); pins.push({ kind: 'study_plan', id: plan.id, revision: plan.revision, hash: lifeHash(plan), plan_hash: plan.data.plan.plan_hash });
      if (plan.data.format === 'calendar_study_plan_v1') { const source = resolveCalendarBusySource(store, plan.data.calendar_source); pins.push({ kind: 'calendar_busy_source', id: source.id, revision: source.revision, hash: lifeHash(source) }); }
    }
    const byTask = new Map();
    for (const task of tasks) {
      pins.push({ kind: 'task', ...taskPin(task) });
      const learning = learningSource(task);
      // Plans pin all tasks for capacity validity, but only emitted task metadata enters their file.
      if (plan && !plan.data.plan.blocks.some(block => block.task_id === task.id)) { pins.push(...learning.pins); continue; }
      const source = provenance(task, learning); pins.push(...source.pins); byTask.set(task.id, { task, provenance: source.data });
      if (plan) continue;
      const deadline = parseDeadline(task.deadline);
      let reason = ['completed', 'cancelled'].includes(task.status) ? 'task_not_active' : deadline.precision === 'unknown' ? 'unknown_deadline' : deadline.precision === 'instant' && !wholeSecond(deadline.instant) ? 'subsecond_precision_unsupported' : null;
      if (deadline.precision === 'date' && deadline.date === '9999-12-31') reason = 'date_end_out_of_range';
      if (reason) { omitted.push({ task_id: task.id, title: task.title, deadline, reason }); continue; }
      events.push({ kind: deadline.precision === 'date' ? 'date_deadline' : 'instant_deadline', uid: uid({ kind: 'task_deadline', id: task.id }), sequence: task.revision,
        task_id: task.id, title: `Due: ${task.title}`, deadline, start: deadline.instant ?? null, end: null, timezone: deadline.timezone ?? null,
        stamp: new Date(Math.floor(Date.parse(task.updated_at) / 1000) * 1000).toISOString(), provenance: { ...source.data, semantics: 'deadline_marker_not_study_hours' } });
    }
    if (plan) for (const block of plan.data.plan.blocks) {
      const row = byTask.get(block.task_id); if (!row || ['completed', 'cancelled'].includes(row.task.status)) fail('VERSION_MISMATCH');
      lifeStamp(block.start); lifeStamp(block.end); if (block.start >= block.end) fail('VERSION_MISMATCH');
      if (!wholeSecond(block.start) || !wholeSecond(block.end)) fail('UNSUPPORTED');
      events.push({ kind: 'study_block', uid: uid({ kind: 'study_block', plan_id: plan.id, task_id: block.task_id, start: block.start, end: block.end }), sequence: plan.revision,
        task_id: block.task_id, title: `Study: ${block.title}`, deadline: row.task.deadline, start: block.start, end: block.end, timezone: plan.data.plan.timezone,
        stamp: new Date(Math.floor(Date.parse(plan.updated_at) / 1000) * 1000).toISOString(), provenance: { ...row.provenance, semantics: 'exact_saved_study_block',
          plan_id: plan.id, plan_revision: plan.revision, plan_hash: plan.data.plan.plan_hash, block,
          ...(plan.data.format === 'calendar_study_plan_v1' ? { calendar_availability: (() => { const source = resolveCalendarBusySource(store, plan.data.calendar_source); return { source_pin: plan.data.calendar_source, file_sha256: source.data.file_sha256, scope: source.data.scope, coverage: source.data.coverage, interpretation: 'Only selected reviewed busy times; complete calendar availability remains unknown.' }; })() } : {}) } });
    }
    if (!events.length) fail('UNSUPPORTED');
    if (events.length > CALENDAR_EXPORT_LIMITS.events) fail('BUDGET_EXCEEDED');
    return { pins, events, omitted, warnings: plan ? { unscheduled: plan.data.plan.unscheduled, coverage: plan.data.plan.coverage, source: 'accepted_local_plan_not_live_calendar_availability' } : { source: 'selected_local_tasks_not_live_source_verification' } };
  }
  const reviewHash = data => lifeHash({ request: data.request, pins: data.pins, events: data.events, omitted: data.omitted, warnings: data.warnings, content: data.content, sha256: data.sha256, created_at: data.created_at, expires_at: data.expires_at });
  function checked(row) {
    if (!row || row.kind !== 'artifact' || row.data.format !== FORMAT) fail('SCOPE_DENIED');
    const data = row.data;
    object(data, ['format', 'state', 'request', 'pins', 'events', 'omitted', 'warnings', 'content', 'sha256', 'bytes', 'created_at', 'expires_at', 'review_hash', 'creation_key', 'receipt']);
    request(data.request); lifeStamp(data.created_at); lifeStamp(data.expires_at);
    if (!['preview', 'reviewed_download_payload'].includes(data.state) || data.review_hash !== reviewHash(data) || data.sha256 !== sha(data.content)
      || data.bytes !== Buffer.byteLength(data.content) || data.bytes > CALENDAR_EXPORT_LIMITS.ics_bytes || formatCalendar(data.events) !== data.content) fail('VERSION_MISMATCH');
    if (data.state === 'preview') { if (data.receipt !== null) fail('VERSION_MISMATCH'); }
    else { object(data.receipt, ['reviewed_revision', 'reviewer', 'review_hash', 'prepared_at']); if (data.receipt.reviewer !== store.identity.student_id || data.receipt.review_hash !== data.review_hash) fail('VERSION_MISMATCH'); revision(data.receipt.reviewed_revision); lifeStamp(data.receipt.prepared_at); }
    return row;
  }
  function current(data) { try { const result = selected(data.request); return lifeHash(result.pins) === lifeHash(data.pins) && lifeHash(result.events) === lifeHash(data.events) && lifeHash(result.omitted) === lifeHash(data.omitted); } catch { return false; } }
  const view = row => { checked(row); const now = stamp(); return { ...row, expired: now < row.data.created_at || now >= row.data.expires_at, needs_refresh: !current(row.data) }; };
  return {
    context() {
      return { tasks: store.listTasks().map(task => ({ id: task.id, revision: task.revision, title: task.title, status: task.status, deadline: task.deadline })),
        plans: store.listWorkspaceRecords({ kind: 'plan' }).filter(row => [undefined, 'calendar_study_plan_v1'].includes(row.data.format) && row.data.plan?.format === 'learnbridge-study-plan').map(row => {
          let eligible = true; try { planRecord({ plan_id: row.id, expected_revision: row.revision, plan_hash: row.data.plan.plan_hash }); } catch { eligible = false; }
          return { id: row.id, revision: row.revision, title: row.title, state: row.data.state, plan_hash: row.data.plan.plan_hash, timezone: row.data.plan.timezone, block_count: row.data.plan.blocks.length, eligible };
        }), limits: CALENDAR_EXPORT_LIMITS, provider_writes: 0 };
    },
    preview(input, { idempotencyKey } = {}) {
      const value = request(input); if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(idempotencyKey)) fail();
      const prior = records().find(row => row.data.creation_key === idempotencyKey);
      if (prior) { checked(prior); if (lifeHash(prior.data.request) !== lifeHash(value)) fail('REVISION_CONFLICT'); if (!current(prior.data)) fail('REVISION_CONFLICT'); return view(prior); }
      if (records().length >= CALENDAR_EXPORT_LIMITS.retained_previews) fail('BUDGET_EXCEEDED');
      const result = selected(value), content = formatCalendar(result.events), created_at = stamp();
      const data = { format: FORMAT, state: 'preview', request: value, ...result, content, sha256: sha(content), bytes: Buffer.byteLength(content), created_at,
        expires_at: new Date(Date.parse(created_at) + CALENDAR_EXPORT_LIMITS.ttl_ms).toISOString(), review_hash: '', creation_key: idempotencyKey, receipt: null };
      data.review_hash = reviewHash(data); if (Buffer.byteLength(JSON.stringify(data)) > CALENDAR_EXPORT_LIMITS.record_bytes) fail('BUDGET_EXCEEDED');
      return view(store.createWorkspaceRecord({ kind: 'artifact', title: value.mode === 'tasks' ? 'Reviewed task deadline calendar' : 'Reviewed saved study calendar', data }, { idempotencyKey }));
    },
    listPreviews: () => records().map(view),
    getPreview: value => view(store.getWorkspaceRecord(id(value))),
    download(value, input) {
      object(input, ['expected_revision', 'review_hash', 'confirmed']); revision(input.expected_revision); digest(input.review_hash); if (input.confirmed !== true) fail('CONSENT_REQUIRED');
      let row = checked(store.getWorkspaceRecord(id(value))); const data = row.data;
      if (input.review_hash !== data.review_hash) fail('REVISION_CONFLICT');
      const now = stamp(); if (now < data.created_at || now >= data.expires_at || !current(data)) fail('REVISION_CONFLICT');
      if (data.state === 'preview') {
        if (row.revision !== input.expected_revision) fail('REVISION_CONFLICT');
        row = store.updateWorkspaceRecord(row.id, { expected_revision: row.revision, data: { ...data, state: 'reviewed_download_payload', receipt: { reviewed_revision: row.revision, reviewer: store.identity.student_id, review_hash: data.review_hash, prepared_at: stamp() } } });
      } else if (![row.revision, data.receipt.reviewed_revision].includes(input.expected_revision)) fail('REVISION_CONFLICT');
      return { item: view(row), filename: `learnbridge-${row.id}.ics`, mime: 'text/calendar;charset=utf-8', content: row.data.content, sha256: row.data.sha256, bytes: row.data.bytes,
        outcome: 'download_payload_prepared', provider_writes: 0, task_writes: 0 };
    },
  };
}

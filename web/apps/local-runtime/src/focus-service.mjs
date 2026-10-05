import { performance } from 'node:perf_hooks';
import { LearnBridgeError } from '@learnbridge/core';
import { lifeHash, lifeStamp, lifeTimezone, lifeText } from './life.mjs';
const FORMAT = 'focus_session_v1', OPEN = new Set(['running', 'paused', 'interrupted']);
export const FOCUS_LIMITS = Object.freeze({ tick_interval_ms: 30000, max_observation_gap_ms: 90000, max_active_ms: 86400000, observations: 50, retained_sessions: 200, planned_minutes: 240 });
const fail = (code = 'INVALID_INPUT') => { throw new LearnBridgeError(code); };
const id = value => { if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) fail(); return value.toLowerCase(); };
const rev = value => { if (!Number.isSafeInteger(value) || value < 1) fail(); return value; };
const hash = value => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(); return value; };
function object(value, keys, required = keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail(); const props = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(props).some(key => typeof key !== 'string' || !keys.includes(key) || !('value' in props[key]) || !props[key].enumerable) || required.some(key => !Object.hasOwn(props, key))) fail();
}
const finite = value => { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) fail(); return value; };
const integer = (value, max) => { if (!Number.isSafeInteger(value) || value < 0 || value > max) fail('VERSION_MISMATCH'); return value; };
/** Deliberately running timers measure observed runtime intervals, never attention, mastery or absent time. */
export function createFocusService({ store, clock = Date.now, monotonicClock = () => performance.now() }) {
  let disposed = false; const anchors = new Map();
  const stamp = () => { let value; try { value = new Date(clock()).toISOString(); } catch { fail(); } return lifeStamp(value); };
  const mono = () => finite(monotonicClock());
  const records = () => store.listWorkspaceRecords({ kind: 'routine' }).filter(row => row.data.format === FORMAT);
  const fingerprint = row => lifeHash({ id: row.id, revision: row.revision, data: row.data });
  function checked(row) {
    if (!row || row.kind !== 'routine' || row.data.format !== FORMAT) fail('SCOPE_DENIED'); const data = row.data;
    object(data, ['format', 'state', 'title', 'planned_minutes', 'timezone', 'task_ref', 'started_at', 'ended_at', 'last_observed_at', 'observed_active_ms', 'interval_count', 'observations', 'excluded_gap_count', 'last_gap', 'last_receipt', 'creation_key', 'request_hash']);
    if (!['running', 'paused', 'interrupted', 'completed', 'discarded'].includes(data.state)) fail('VERSION_MISMATCH');
    lifeText(data.title, 300); lifeTimezone(data.timezone); lifeStamp(data.started_at); lifeStamp(data.last_observed_at); hash(data.request_hash);
    if (!Number.isSafeInteger(data.planned_minutes) || data.planned_minutes < 1 || data.planned_minutes > FOCUS_LIMITS.planned_minutes) fail('VERSION_MISMATCH');
    integer(data.observed_active_ms, FOCUS_LIMITS.max_active_ms); integer(data.interval_count, 1000000); integer(data.excluded_gap_count, 1000000);
    if (!Array.isArray(data.observations) || data.observations.length > FOCUS_LIMITS.observations || (OPEN.has(data.state) ? data.ended_at !== null : typeof data.ended_at !== 'string')) fail('VERSION_MISMATCH');
    if (data.ended_at !== null) lifeStamp(data.ended_at);
    if (data.task_ref !== null) { object(data.task_ref, ['id', 'revision', 'title', 'hash']); id(data.task_ref.id); rev(data.task_ref.revision); lifeText(data.task_ref.title, 500); hash(data.task_ref.hash); }
    for (const observation of data.observations) { object(observation, ['from', 'to', 'credited_ms', 'reason']); lifeStamp(observation.from); lifeStamp(observation.to); integer(observation.credited_ms, FOCUS_LIMITS.max_observation_gap_ms); if (!['observed_runtime_interval', 'long_unobserved_gap', 'clock_rollback', 'runtime_restarted', 'runtime_stopped', 'active_limit_reached'].includes(observation.reason)) fail('VERSION_MISMATCH'); }
    if (data.observations.reduce((sum, item) => sum + item.credited_ms, 0) > data.observed_active_ms) fail('VERSION_MISMATCH');
    if (data.last_gap !== null) { object(data.last_gap, ['reason', 'observed_at', 'wall_gap_ms', 'monotonic_gap_ms']); lifeStamp(data.last_gap.observed_at); if (!['long_unobserved_gap', 'clock_rollback', 'runtime_restarted', 'runtime_stopped', 'active_limit_reached'].includes(data.last_gap.reason)) fail('VERSION_MISMATCH'); if (data.last_gap.wall_gap_ms !== null) integer(data.last_gap.wall_gap_ms, Number.MAX_SAFE_INTEGER); if (data.last_gap.monotonic_gap_ms !== null) finite(data.last_gap.monotonic_gap_ms); }
    if (data.last_receipt !== null) { object(data.last_receipt, ['operation', 'reviewed_revision', 'session_hash', 'reviewer', 'decided_at', 'outcome']); rev(data.last_receipt.reviewed_revision); hash(data.last_receipt.session_hash); lifeStamp(data.last_receipt.decided_at); if (!['pause', 'resume', 'end', 'discard'].includes(data.last_receipt.operation) || data.last_receipt.reviewer !== store.identity.student_id || !['saved', 'gap_excluded_requires_review'].includes(data.last_receipt.outcome)) fail('VERSION_MISMATCH'); }
    return row;
  }
  const active = () => { if (disposed) fail('OFFLINE'); };
  const get = value => checked(store.getWorkspaceRecord(id(value)));
  function gap(row, at = stamp(), currentMono = mono()) {
    const anchor = anchors.get(row.id), wall = Date.parse(at) - Date.parse(row.data.last_observed_at), elapsed = anchor === undefined ? null : currentMono - anchor;
    const reason = anchor === undefined ? 'runtime_restarted' : wall < 0 || elapsed < 0 ? 'clock_rollback' : wall > FOCUS_LIMITS.max_observation_gap_ms || elapsed > FOCUS_LIMITS.max_observation_gap_ms ? 'long_unobserved_gap' : row.data.observed_active_ms >= FOCUS_LIMITS.max_active_ms ? 'active_limit_reached' : null;
    return { at, currentMono, reason, wall, elapsed, credited_ms: reason ? 0 : Math.min(Math.floor(wall), Math.floor(elapsed), FOCUS_LIMITS.max_active_ms - row.data.observed_active_ms) };
  }
  function observed(row, reading, forcedReason) {
    const reason = forcedReason || reading.reason, credit = reading.reason ? 0 : reading.credited_ms;
    const observation = { from: row.data.last_observed_at, to: reading.at, credited_ms: credit, reason: reason || 'observed_runtime_interval' };
    return { ...row.data, observed_active_ms: row.data.observed_active_ms + credit, last_observed_at: reading.at, interval_count: row.data.interval_count + 1,
      observations: [...row.data.observations, observation].slice(-FOCUS_LIMITS.observations),
      excluded_gap_count: row.data.excluded_gap_count + (reason ? 1 : 0), last_gap: reason ? { reason, observed_at: reading.at, wall_gap_ms: reading.wall < 0 ? null : Math.floor(reading.wall), monotonic_gap_ms: reading.elapsed === null || reading.elapsed < 0 ? null : reading.elapsed } : row.data.last_gap };
  }
  const save = (row, data) => store.updateWorkspaceRecord(row.id, { expected_revision: row.revision, data });
  function view(row) {
    checked(row); const live = row.data.state === 'running' && !disposed ? gap(row) : null;
    const task = row.data.task_ref ? store.getTask(row.data.task_ref.id) : null;
    return { ...row, session_hash: fingerprint(row), pending_interval_ms: live && !live.reason ? live.credited_ms : 0, needs_recovery: row.data.state === 'interrupted' || Boolean(live?.reason),
      task_changed: row.data.task_ref !== null && (!task || task.revision !== row.data.task_ref.revision || lifeHash(task) !== row.data.task_ref.hash),
      measurement: 'Observed timer runtime, not verified attention, mastery or productivity.', notification_channel: 'in_app_only' };
  }
  const initial = records().map(checked); if (initial.filter(row => OPEN.has(row.data.state)).length > 1) fail('VERSION_MISMATCH');
  for (const row of initial.filter(row => row.data.state === 'running')) {
    const at = stamp(); save(row, { ...observed(row, { at, wall: Math.max(0, Date.parse(at) - Date.parse(row.data.last_observed_at)), elapsed: null, credited_ms: 0, reason: 'runtime_restarted' }), state: 'interrupted' });
  }
  function transition(value, input, operation) {
    active(); object(input, ['expected_revision', 'session_hash', 'confirmed']); rev(input.expected_revision); hash(input.session_hash); if (input.confirmed !== true) fail('CONSENT_REQUIRED');
    let row = get(value); const receipt = row.data.last_receipt;
    if (receipt?.operation === operation && receipt.reviewed_revision === input.expected_revision && receipt.session_hash === input.session_hash) return view(row);
    if (row.revision !== input.expected_revision || fingerprint(row) !== input.session_hash) fail('REVISION_CONFLICT');
    if (!OPEN.has(row.data.state) || (operation === 'pause' && row.data.state !== 'running') || (operation === 'resume' && !['paused', 'interrupted'].includes(row.data.state))) fail('REVISION_CONFLICT');
    const at = stamp(), currentMono = mono(), reading = row.data.state === 'running' ? gap(row, at, currentMono) : null;
    let data = reading ? observed(row, reading) : { ...row.data, last_observed_at: at }, outcome = 'saved';
    if (reading?.reason && operation !== 'discard') { data.state = 'interrupted'; outcome = 'gap_excluded_requires_review'; }
    else { data.state = { pause: 'paused', resume: 'running', end: 'completed', discard: 'discarded' }[operation]; if (!OPEN.has(data.state)) data.ended_at = at; }
    data.last_receipt = { operation, reviewed_revision: row.revision, session_hash: input.session_hash, reviewer: store.identity.student_id, decided_at: at, outcome };
    row = save(row, data); if (data.state === 'running') anchors.set(row.id, currentMono); else anchors.delete(row.id); return view(row);
  }
  return {
    context() { active(); const rows = records().map(view); return { open_session: rows.find(row => OPEN.has(row.data.state)) ?? null, limits: FOCUS_LIMITS, tasks: store.listTasks().filter(task => !['completed', 'cancelled'].includes(task.status)).map(task => ({ id: task.id, revision: task.revision, title: task.title })), notification_channel: 'in_app_only', activity_tracking: false }; },
    list: () => { active(); return records().map(view).sort((a, b) => b.created_at.localeCompare(a.created_at)); },
    get: value => { active(); return view(get(value)); },
    start(input, { idempotencyKey } = {}) {
      active(); object(input, ['title', 'planned_minutes', 'timezone', 'task_id', 'confirmed'], ['title', 'planned_minutes', 'timezone', 'confirmed']); if (input.confirmed !== true) fail('CONSENT_REQUIRED');
      const value = { title: lifeText(input.title, 300), planned_minutes: input.planned_minutes, timezone: lifeTimezone(input.timezone), task_id: input.task_id == null ? null : id(input.task_id), confirmed: true };
      if (!Number.isSafeInteger(value.planned_minutes) || value.planned_minutes < 1 || value.planned_minutes > FOCUS_LIMITS.planned_minutes || typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(idempotencyKey)) fail();
      const existing = records().map(checked), requestHash = lifeHash(value), prior = existing.find(row => row.data.creation_key === idempotencyKey);
      if (prior) { if (prior.data.request_hash !== requestHash) fail('REVISION_CONFLICT'); return view(prior); }
      if (existing.some(row => OPEN.has(row.data.state))) fail('REVISION_CONFLICT'); if (existing.length >= FOCUS_LIMITS.retained_sessions) fail('BUDGET_EXCEEDED');
      const task = value.task_id ? store.getTask(value.task_id) : null; if (value.task_id && (!task || ['completed', 'cancelled'].includes(task.status))) fail('SCOPE_DENIED');
      const at = stamp(), currentMono = mono(), data = { format: FORMAT, state: 'running', title: value.title, planned_minutes: value.planned_minutes, timezone: value.timezone,
        task_ref: task ? { id: task.id, revision: task.revision, title: task.title, hash: lifeHash(task) } : null, started_at: at, ended_at: null, last_observed_at: at, observed_active_ms: 0, interval_count: 0,
        observations: [], excluded_gap_count: 0, last_gap: null, last_receipt: null, creation_key: idempotencyKey, request_hash: requestHash };
      const row = store.createWorkspaceRecord({ kind: 'routine', title: value.title, data }, { idempotencyKey }); anchors.set(row.id, currentMono); return view(row);
    },
    pause: (value, input) => transition(value, input, 'pause'), resume: (value, input) => transition(value, input, 'resume'), end: (value, input) => transition(value, input, 'end'), discard: (value, input) => transition(value, input, 'discard'),
    observe() {
      active(); const running = records().map(checked).filter(row => row.data.state === 'running'); if (running.length > 1) fail('VERSION_MISMATCH'); const at = stamp(), currentMono = mono(); let sampled = 0;
      for (const row of running) {
        const reading = gap(row, at, currentMono); if (!reading.reason && reading.credited_ms < 1000) continue;
        const data = observed(row, reading); if (reading.reason) data.state = 'interrupted'; const saved = save(row, data);
        if (saved.data.state === 'running') anchors.set(row.id, currentMono); else anchors.delete(row.id); sampled++;
      }
      return { sampled, provider_actions: 0, attention_verified: false };
    },
    dispose() {
      if (disposed) return { persisted: true }; let persisted = true;
      try { for (const row of records().map(checked).filter(row => row.data.state === 'running')) { const reading = gap(row); save(row, { ...observed(row, reading, reading.reason || 'runtime_stopped'), state: 'interrupted' }); } }
      catch { persisted = false; } finally { disposed = true; anchors.clear(); }
      return { persisted };
    },
  };
}

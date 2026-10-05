import { randomUUID } from 'node:crypto';
import { LearnBridgeError, parseDeadline } from '@learnbridge/core';
import { lifeHash, lifeStamp, lifeText, localDay } from './life.mjs';
import { resolveCalendarBusySource, calendarSourcePin } from './calendar-import-service.mjs';

const CONFIG = 'dynamic_task_config_v1', ITEM = 'dynamic_task_item_v1';
export const DYNAMIC_TASK_LIMITS = Object.freeze({ selections: 20, courses: 5, observations: 300, source_items: 200, tick_interval_ms: 30000 });
const fail = (code = 'INVALID_INPUT') => { throw new LearnBridgeError(code); };
const uuid = value => { if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) fail(); return value.toLowerCase(); };
const revision = value => { if (!Number.isSafeInteger(value) || value < 1) fail(); return value; };
function object(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail(); const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !keys.includes(key) || !('value' in descriptors[key]) || !descriptors[key].enumerable)
    || keys.some(key => !Object.hasOwn(descriptors, key))) fail();
}
function array(value, max, parse) {
  if (!Array.isArray(value) || value.length > max) fail(); const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length || !('value' in descriptors[key]) || !descriptors[key].enumerable))) fail();
  return Array.from({ length: value.length }, (_, index) => { if (!Object.hasOwn(descriptors, String(index))) fail(); return parse(descriptors[index].value); });
}
const payload = task => ({ title: task.title, deadline: task.deadline, ...(task.course_label == null ? {} : { course_label: task.course_label }) });
const semanticTask = task => ({ title: task.title, course_label: task.course_label ?? null, deadline: { precision: task.deadline.precision,
  date: task.deadline.date ?? null, instant: task.deadline.instant ?? null, timezone: task.deadline.timezone ?? null } });
const equivalent = (task, expected) => lifeHash(semanticTask(task)) === lifeHash(semanticTask(expected));
const selectionKey = value => `${value.kind}:${value.id}`;
const identity = value => lifeHash(value);

/** A bounded, local-source reconciliation worker. Selected imports are observations;
 * it never polls a provider, infers assignment completion or sends context to a model. */
export function createDynamicTaskService({ store, studentWorkspace, clock = Date.now }) {
  const stamp = () => { const now = clock(); return lifeStamp(typeof now === 'string' ? now : new Date(now).toISOString()); };
  const rows = format => store.listWorkspaceRecords({ kind: 'inbox_item' }).filter(row => row.data.format === format);
  const configs = () => store.listWorkspaceRecords({ kind: 'schedule' }).filter(row => row.data.format === CONFIG);
  const currentConfig = () => { const found = configs(); if (found.length > 1) fail('VERSION_MISMATCH'); return found[0] ?? null; };
  const defaults = () => ({ revision: 0, data: { selections: [], auto_create: false, auto_complete: false, enabled: false }, refresh: 'local_selected_imports_only', provider_reads: 0, model_calls: 0 });
  function config() { return currentConfig() ?? defaults(); }
  function snapshotFor(selection) {
    const saved = studentWorkspace.listSnapshots().find(row => (row.stream_id ?? row.id) === selection.id);
    if (!saved) fail('SCOPE_DENIED');
    studentWorkspace.library({ snapshot_ids: [saved.id], course_ids: selection.course_ids });
    return saved;
  }
  function catalog() {
    const academic = studentWorkspace.listSnapshots().map(row => ({ kind: 'academic', id: row.stream_id ?? row.id, title: row.data.snapshot.institution.name,
      account: row.data.snapshot.account_ref, observed_at: row.data.snapshot.retrieved_at,
      courses: row.data.snapshot.courses.map(course => ({ id: course.source_id, title: course.code || course.title })), freshness: 'current_saved_export_not_live' }));
    const workspace = store.listWorkspaceRecords();
    const updates = workspace.filter(row => row.kind === 'inbox_item' && row.data.category === 'update').map(row => ({ kind: 'update', id: row.id, title: row.data.update.subject,
      account: `${row.data.update.provider}/${row.data.update.account}`, revision: row.revision, observed_at: row.data.update.observed_at,
      freshness: row.data.update.acquisition, extraction: 'explicit TODO/Action/checkbox lines only' }));
    const calendar = workspace.filter(row => row.kind === 'artifact' && row.data.format === 'calendar_busy_source_v1').map(row => ({ kind: 'calendar', id: row.id, title: row.title,
      revision: row.revision, observed_at: row.data.accepted_at, freshness: 'reviewed_selected_calendar_file', extraction: 'prepare event at its start; event passing never proves completion' }));
    const projects = workspace.filter(row => row.kind === 'project' && row.data.category === 'project').map(row => ({ kind: 'project', id: row.id, title: row.title,
      revision: row.revision, observed_at: row.updated_at, freshness: 'student_reviewed_local_checklist', extraction: 'ordered checklist; completion is student reported, not external verification' }));
    return [...academic, ...updates, ...calendar, ...projects];
  }
  function parseSelection(value) {
    object(value, ['kind', 'id', 'course_ids']); uuid(value.id); if (!['academic', 'update', 'calendar', 'project'].includes(value.kind)) fail();
    const course_ids = array(value.course_ids, DYNAMIC_TASK_LIMITS.courses, value => { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value)) fail(); return value; }).sort();
    if (new Set(course_ids).size !== course_ids.length || (value.kind === 'academic' ? !course_ids.length : course_ids.length)) fail();
    return { kind: value.kind, id: uuid(value.id), course_ids };
  }
  function sourceObservations(selection) {
    if (selection.kind === 'academic') {
      const row = snapshotFor(selection), snapshot = row.data.snapshot;
      return snapshot.assignments.filter(item => selection.course_ids.includes(item.course_id)).map(item => {
        const course = snapshot.courses.find(course => course.source_id === item.course_id); if (!course) fail('VERSION_MISMATCH');
        const deadline = { ...item.deadline }; if (deadline.timezone == null) delete deadline.timezone;
        const task = { title: `Prepare: ${item.title}`.slice(0, 500), deadline: parseDeadline(deadline), course_label: course.code || course.title };
        return { identity: identity({ kind: 'academic', item_id: item.id }), selection_key: selectionKey(selection), source_kind: 'academic', source_item_id: item.id,
          task, observed_at: snapshot.retrieved_at, source_hash: lifeHash({ task, source_hash: item.source_hash }),
          pin: { kind: 'academic', stream_id: row.stream_id ?? null, stream_revision: row.stream_revision ?? 0, snapshot_id: row.id, revision: row.revision, snapshot_hash: snapshot.snapshot_hash, source_id: item.id, source_hash: item.source_hash, course_id: item.course_id },
          source: { title: item.title, account: `${snapshot.institution.name}/${snapshot.account_ref}`, url: item.url, coverage: snapshot.coverage.assignments.state, deadline: item.deadline },
          evidence: 'Structured assignment title and exact deadline from your current selected saved course export.', suggested_complete: false, completion_basis: null, academic_policy: 'graded_or_unknown_support_learning' };
      });
    }
    const row = store.getWorkspaceRecord(selection.id); if (!row) fail('SCOPE_DENIED');
    if (selection.kind === 'calendar') {
      resolveCalendarBusySource(store, calendarSourcePin(row));
      return row.data.selected_events.map(event => {
        const task = { title: `Prepare for: ${event.title.replace(/[\r\n\t]/g, ' ')}`.slice(0, 500), deadline: { precision: 'instant', instant: event.start, timezone: event.timezone } };
        return { identity: identity({ kind: 'calendar', source_id: row.id, uid: event.uid }), selection_key: selectionKey(selection), source_kind: 'calendar', source_item_id: event.uid,
          task, observed_at: row.data.accepted_at, source_hash: lifeHash({ task, hash: event.source_properties_hash }),
          pin: { kind: 'calendar', id: row.id, revision: row.revision, version_hash: calendarSourcePin(row).version_hash },
          source: { title: event.title, account: 'selected_calendar_file', url: null, coverage: 'partial_selected_file_snapshot', deadline: task.deadline },
          evidence: 'Preparation task using the selected event start. An event is a commitment, not an inferred assignment.', suggested_complete: false, completion_basis: null, academic_policy: 'unknown_support_learning' };
      });
    }
    if (selection.kind === 'project') {
      if (row.kind !== 'project' || row.data.category !== 'project') fail('SCOPE_DENIED');
      return row.data.project.checklist.map(item => {
        const task = { title: item.title, deadline: { precision: 'unknown' } };
        return { identity: identity({ kind: 'project', source_id: row.id, item_id: item.id }), selection_key: selectionKey(selection), source_kind: 'project', source_item_id: item.id,
          task, observed_at: row.updated_at, source_hash: lifeHash({ task, item }),
          pin: { kind: 'project', id: row.id, revision: row.revision, hash: lifeHash({ project: row.data.project, sources: row.data.sources }) },
          source: { title: row.title, account: 'this_workspace', url: null, coverage: 'student_selected_checklist', deadline: task.deadline },
          evidence: `Student-reviewed checklist item ${item.id}; prerequisites: ${item.dependency_ids.join(', ') || 'none'}.`,
          prerequisite_identities: item.dependency_ids.map(id => identity({ kind: 'project', source_id: row.id, item_id: id })),
          suggested_complete: item.completed === true, completion_basis: item.completed && item.observation === 'student_reported' && item.completed_at ? { kind: 'student_reported_project_checkbox', source_revision: row.revision, item_id: item.id, completed_at: item.completed_at } : null,
          academic_policy: 'unknown_support_learning' };
      });
    }
    if (row.kind !== 'inbox_item' || row.data.category !== 'update') fail('SCOPE_DENIED');
    const update = row.data.update, result = [], occurrences = new Map();
    // Conservative action syntax is deliberately local. Natural-language/AI suggestions
    // remain separate reviews; words such as 'done', 'submitted' and 'thanks' are not evidence.
    for (const line of update.body.split(/\r?\n/)) {
      const match = /^\s*(?:[-*]\s*)?(?:(?:TODO|Action):\s*(.+)|\[([ xX])\]\s*(.+))\s*$/.exec(line); if (!match) continue;
      const raw = match[1] ?? match[3], due = /\s*\|\s*due=(\d{4}-\d\d-\d\d)\s*$/.exec(raw), title = (due ? raw.slice(0, due.index) : raw).trim();
      if (!title || title.length > 500 || result.length >= DYNAMIC_TASK_LIMITS.source_items) continue;
      let deadline = { precision: 'unknown' }; if (due) { try { deadline = parseDeadline({ precision: 'date', date: due[1] }); } catch { continue; } }
      const canonical = title.normalize('NFKC').toLowerCase().replace(/\s+/g, ' '), duplicate = occurrences.get(canonical) ?? 0; occurrences.set(canonical, duplicate + 1);
      const task = { title, deadline };
      result.push({ identity: identity({ kind: 'update', source_identity: row.data.source_identity, title: canonical, occurrence: duplicate }), selection_key: selectionKey(selection), source_kind: 'update', source_item_id: `${lifeHash(canonical)}:${duplicate}`,
        task, observed_at: update.observed_at, source_hash: lifeHash({ task, mark: match[2] ?? null }),
        pin: { kind: 'update', id: row.id, revision: row.revision, hash: lifeHash(update) }, source: { title: update.subject, account: `${update.provider}/${update.account}`, url: update.source_url, coverage: update.acquisition, deadline },
        evidence: line.trim().slice(0, 1000), suggested_complete: /[xX]/.test(match[2] ?? ''), completion_basis: null, academic_policy: update.section === 'academic' ? 'graded_or_unknown_support_learning' : 'unknown_support_learning' });
    }
    // AI prose candidates can only come from this separate reviewed source
    // extraction receipt. They remain pending even when deterministic auto-add is on.
    for (const row of itemRows().filter(row => row.data.observation.selection_key === selectionKey(selection) && row.data.observation.extraction_receipt_id)) {
      const observation = row.data.observation, receipt = store.getWorkspaceRecord(observation.extraction_receipt_id);
      const turn = receipt?.data.turn_id ? store.getWorkspaceRecord(receipt.data.turn_id) : null;
      if (!receipt || receipt.data.format !== 'dynamic_task_ai_extraction_v1' || receipt.data.state !== 'parsed' || receipt.data.source_pin.id !== row.data.observation.pin.id
        || receipt.data.source_pin.revision !== row.data.observation.pin.revision || receipt.data.source_pin.hash !== lifeHash(update)
        || receipt.data.candidates_hash !== lifeHash(receipt.data.candidates) || !receipt.data.candidate_observation_hashes.includes(lifeHash(observation))
        || !turn || turn.data.state !== 'completed' || turn.data.output_sha256 !== receipt.data.output_sha256 || turn.data.grant_id !== receipt.data.grant_id) continue;
      if (observation.pin.revision === store.getWorkspaceRecord(selection.id).revision) result.push(observation);
    }
    return result;
  }
  function checked(row) {
    if (!row || row.kind !== 'inbox_item' || row.data.format !== ITEM || !['awaiting_review', 'accepting', 'active', 'dismissed'].includes(row.data.state)) fail('SCOPE_DENIED');
    const data = row.data; if (data.observation_hash !== lifeHash(data.observation) || data.task_payload_hash !== lifeHash(data.task_payload)) fail('VERSION_MISMATCH');
    return row;
  }
  const itemRows = () => rows(ITEM).map(checked);
  function policy() { const row = currentConfig(); return row?.data ?? defaults().data; }
  function selectedNow(observation) { return policy().selections.some(selection => selectionKey(selection) === observation.selection_key); }
  function observationCurrent(observation) {
    const selected = policy().selections.find(selection => selectionKey(selection) === observation.selection_key); if (!selected) return false;
    try {
      if (!sourceObservations(selected).some(item => item.identity === observation.identity && lifeHash(item) === lifeHash(observation))) return false;
      return policy().selections.every(selection => { try { return sourceObservations(selection).filter(item => item.identity === observation.identity).every(item => item.source_hash === observation.source_hash); } catch { return true; } });
    } catch { return false; }
  }
  function linkedSourceTask(observation) {
    if (observation.source_kind === 'academic') {
      const row = store.listWorkspaceRecords({ kind: 'inbox_item' }).find(row => row.data.format === 'academic_task_proposal_v1' && row.data.state === 'accepted' && row.data.source.item_id === observation.source_item_id);
      if (row?.data.task_id) return { id: row.data.task_id, kind: 'already_reviewed_academic_task' };
    }
    if (observation.source_kind === 'update') {
      const row = store.listWorkspaceRecords({ kind: 'inbox_item' }).find(row => row.data.category === 'task_proposal' && row.data.state === 'accepted' && row.data.sources.some(source => source.kind === 'inbox' && source.id === observation.pin.id) && equivalent(row.data.task, observation.task));
      if (row?.data.task_id) return { id: row.data.task_id, kind: 'already_reviewed_productivity_task' };
    }
    return null;
  }
  const matches = observation => { const otherSources = new Set(itemRows().filter(row => row.data.observation.identity !== observation.identity && row.data.task_id).map(row => row.data.task_id));
    return store.listTasks().filter(task => !otherSources.has(task.id) && equivalent(task, observation.task)).map(task => ({ id: task.id, revision: task.revision, title: task.title, status: task.status })); };
  function reviewHash(row) { return lifeHash({ id: row.id, observation_hash: row.data.observation_hash, task_payload_hash: row.data.task_payload_hash, dependencies: dependencies(row.data.observation), state: row.data.state, task_id: row.data.task_id,
    current_task: row.data.task_id ? store.getTask(row.data.task_id) : null, existing_matches: row.data.task_id ? [] : matches(row.data.observation) }); }
  function view(row) {
    row = checked(row); const task = row.data.task_id ? store.getTask(row.data.task_id) : null, source_current = observationCurrent(row.data.observation);
    return { ...row, review_hash: reviewHash(row), source_current, source_selected: selectedNow(row.data.observation),
      needs_review: row.data.state === 'awaiting_review' || row.data.source_conflict || !!(task && !equivalent(task, row.data.observation.task)),
      source_changed_task_preserved: !!(task && !equivalent(task, row.data.observation.task)),
      task: task ?? null, task_unavailable: !!row.data.task_id && !task,
      prerequisites: dependencies(row.data.observation),
      existing_matches: row.data.task_id ? [] : matches(row.data.observation), completion_suggestion_only: row.data.observation.suggested_complete && !row.data.observation.completion_basis };
  }
  function update(row, patch) { return store.updateWorkspaceRecord(row.id, { expected_revision: row.revision, data: { ...row.data, ...patch } }); }
  function finish(row) {
    const key = `dynamic-task-${row.id}`; let task = store.getTaskCreateResult(row.data.task_payload, { idempotencyKey: key });
    if (!task) { if (!observationCurrent(row.data.observation) || !selectedNow(row.data.observation)) fail('REVISION_CONFLICT'); task = store.createTask(row.data.task_payload, { idempotencyKey: key }); }
    return update(row, { state: 'active', task_id: task.id, task_created_revision: task.revision, task_status_revision: task.revision, task_status: task.status });
  }
  function begin(row, receipt) {
    if (row.data.state !== 'awaiting_review' || !observationCurrent(row.data.observation) || !selectedNow(row.data.observation)) fail('REVISION_CONFLICT');
    row = update(row, { state: 'accepting', acceptance: receipt }); return finish(row);
  }
  function dependencies(observation) {
    const pending = (observation.prerequisite_identities ?? []).map(value => itemRows().find(row => row.data.observation.identity === value));
    if (pending.some(row => !row?.data.task_id || !store.getTask(row.data.task_id))) return { ready: false, ids: [] };
    return { ready: true, ids: pending.map(row => row.data.task_id) };
  }
  function autoComplete(row) {
    const d = row.data, p = policy(), task = d.task_id ? store.getTask(d.task_id) : null;
    if (d.pending_completion) {
      const pending = d.pending_completion;
      const matchesCommitted = task && task.revision === pending.task_revision_after && task.status === 'completed'
        && lifeHash({ ...task, status: pending.previous_status, revision: pending.task_revision_before, updated_at: pending.previous_updated_at, student_overrides: pending.previous_overrides }) === pending.task_before_hash;
      if (matchesCommitted) return update(row, { task_status_revision: task.revision, task_status: task.status, pending_completion: null, completion_receipt: pending });
      if (!task || task.revision !== pending.task_revision_before || task.status !== d.task_status || !equivalent(task, d.task_payload)) return row;
      if (!p.enabled || !p.auto_complete || !observationCurrent(d.observation) || d.source_conflict || d.observation_hash !== pending.observation_hash || !d.observation.completion_basis) return row;
      const next = store.updateTask(task.id, { status: 'completed' }, task.revision);
      return update(row, { task_status_revision: next.revision, task_status: next.status, pending_completion: null, completion_receipt: pending });
    }
    if (!p.enabled || !p.auto_complete || d.source_conflict || !selectedNow(d.observation) || !d.observation.completion_basis || !task || task.status === 'completed' || task.status === 'cancelled'
      || task.revision !== d.task_status_revision || task.status !== d.task_status || !equivalent(task, d.task_payload)) return row;
    row = update(row, { pending_completion: { policy_revision: currentConfig().revision,
      task_revision_before: task.revision, task_revision_after: task.revision + 1, observed_at: stamp(), basis: d.observation.completion_basis,
      observation_hash: d.observation_hash, task_before_hash: lifeHash(task), previous_status: task.status, previous_updated_at: task.updated_at, previous_overrides: task.student_overrides } });
    return autoComplete(row);
  }
  function refresh() {
    const p = policy(), report = { refreshed_at: stamp(), enabled: p.enabled, created_observations: 0, changed_observations: 0, tasks_created: 0, source_failures: [], provider_reads: 0, model_calls: 0 };
    if (!p.enabled) return report;
    let all = itemRows(); const seen = new Set(), selectedObservations = [], variants = new Map();
    for (const selection of p.selections) {
      let observations; try { observations = sourceObservations(selection); } catch (error) { report.source_failures.push({ selection_key: selectionKey(selection), code: ['SCOPE_DENIED', 'CONSENT_REQUIRED', 'VERSION_MISMATCH'].includes(error.code) ? error.code : 'SOURCE_UNAVAILABLE' }); continue; }
      if (observations.length > DYNAMIC_TASK_LIMITS.source_items) { report.source_failures.push({ selection_key: selectionKey(selection), code: 'BUDGET_EXCEEDED' }); continue; }
      selectedObservations.push({ selection, observations });
      for (const observation of observations) { const hashes = variants.get(observation.identity) ?? new Set(); hashes.add(observation.source_hash); variants.set(observation.identity, hashes); }
    }
    const conflicting = new Set([...variants].filter(([, hashes]) => hashes.size > 1).map(([key]) => key));
    report.conflicting_sources = conflicting.size;
    for (const { selection, observations } of selectedObservations) {
      for (const observation of observations) {
        seen.add(observation.identity); let row = all.find(row => row.data.observation.identity === observation.identity);
        const source_conflict = conflicting.has(observation.identity);
        if (!row) {
          if (all.length >= DYNAMIC_TASK_LIMITS.observations) { report.source_failures.push({ selection_key: selectionKey(selection), code: 'BUDGET_EXCEEDED' }); break; }
          const linked = linkedSourceTask(observation), task = linked ? store.getTask(linked.id) : null, deps = dependencies(observation), task_payload = { ...payload(observation.task), ...(deps.ids.length ? { dependency_ids: deps.ids } : {}) };
          row = store.createWorkspaceRecord({ kind: 'inbox_item', title: observation.task.title, data: { format: ITEM, state: linked ? 'active' : 'awaiting_review', observation,
            observation_hash: lifeHash(observation), task_payload, task_payload_hash: lifeHash(task_payload), task_id: linked?.id ?? null,
            task_created_revision: task?.revision ?? null, task_status_revision: task?.revision ?? null, task_status: task?.status ?? null,
            acceptance: linked ? { kind: linked.kind, reviewed_at: stamp() } : null, completion_receipt: null, pending_completion: null, source_present: true, source_conflict } });
          all.push(row); report.created_observations++;
        } else if (row.data.state !== 'accepting' && (row.data.observation_hash !== lifeHash(observation) || row.data.source_conflict !== source_conflict)) {
          const task_payload = row.data.state === 'awaiting_review' ? payload(observation.task) : row.data.task_payload;
          row = update(row, { observation, observation_hash: lifeHash(observation), task_payload, task_payload_hash: lifeHash(task_payload), source_present: true, source_conflict });
          report.changed_observations++;
        } else if (!row.data.source_present) row = update(row, { source_present: true });
        if (row.data.state === 'accepting') { try { const count = store.listTasks().length; row = finish(row); report.tasks_created += store.listTasks().length - count; } catch (error) { if (!['REVISION_CONFLICT', 'SCOPE_DENIED'].includes(error.code)) throw error; } }
        if (p.auto_create && !observation.extraction_receipt_id && !source_conflict && row.data.state === 'awaiting_review' && !matches(observation).length) {
          const deps = dependencies(observation);
          if (deps.ready) { const task_payload = { ...payload(observation.task), ...(deps.ids.length ? { dependency_ids: deps.ids } : {}) };
            if (lifeHash(task_payload) !== row.data.task_payload_hash) row = update(row, { task_payload, task_payload_hash: lifeHash(task_payload) });
            row = begin(row, { kind: 'selected_source_auto_create_policy', policy_revision: currentConfig().revision, policy_hash: currentConfig().data.policy_hash, reviewed_at: stamp() }); report.tasks_created++; }
        }
        row = autoComplete(row); const index = all.findIndex(value => value.id === row.id); all[index] = row;
      }
    }
    for (const row of all) if (selectedNow(row.data.observation) && !seen.has(row.data.observation.identity) && row.data.source_present) update(row, { source_present: false });
    return report;
  }
  function ranked(task, now) {
    const dependencies = task.dependency_ids.filter(id => store.getTask(id)?.status !== 'completed'), day = localDay(now, store.identity.timezone), deadline = task.deadline;
    const due = deadline.precision === 'instant' ? localDay(deadline.instant, store.identity.timezone) : deadline.precision === 'date' ? deadline.date : null;
    const overdue = deadline.precision === 'instant' ? deadline.instant < now : due && due < day;
    const group = task.status === 'completed' ? 'done' : task.status === 'cancelled' ? 'cancelled' : dependencies.length ? 'blocked' : overdue ? 'overdue' : due === day ? 'today' : due ? 'upcoming' : 'needs_date';
    const reasons = { done: 'Completed local task; source or student receipt remains available.', cancelled: 'Student cancelled this local task.', blocked: 'A prerequisite is pending or unavailable.', overdue: 'The exact saved deadline has passed.', today: 'The saved deadline falls today.', upcoming: 'Ordered by the saved deadline.', needs_date: 'No definite deadline was supplied; no date has been invented.' };
    const due_sort = deadline.precision === 'instant' ? deadline.instant : deadline.precision === 'date' ? `${deadline.date}T99` : '9999';
    return { group, sort: ['overdue', 'today', 'upcoming', 'needs_date', 'blocked', 'done', 'cancelled'].indexOf(group), due, due_sort, blocked_by: dependencies,
      ranking_reason: `${reasons[group]}${task.manual_priority ? ` Manual priority ${task.manual_priority} is preserved within this group.` : ''}` };
  }
  return {
    context: () => ({ sources: catalog(), limits: DYNAMIC_TASK_LIMITS, refresh: 'selected_local_imports_only', source_scan: false, provider_reads: 0, model_calls: 0,
      extraction: 'structured assignments, explicit message action markers, selected calendar preparation and reviewed project checklists', completion: 'only opted-in student-reported project checkboxes; other suggestions require review' }),
    config,
    configure(input) {
      object(input, ['expected_revision', 'selections', 'auto_create', 'auto_complete', 'enabled', 'confirmed']);
      if (input.confirmed !== true) fail('CONSENT_REQUIRED'); if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0 || [input.auto_create, input.auto_complete, input.enabled].some(value => typeof value !== 'boolean')) fail();
      const selections = array(input.selections, DYNAMIC_TASK_LIMITS.selections, parseSelection).sort((a, b) => selectionKey(a).localeCompare(selectionKey(b)));
      if (new Set(selections.map(selectionKey)).size !== selections.length || (input.enabled && !selections.length)) fail();
      const available = catalog(); for (const selection of selections) { const source = available.find(row => selectionKey(row) === selectionKey(selection)); if (!source) fail('SCOPE_DENIED');
        if (selection.kind === 'academic' && selection.course_ids.some(id => !source.courses.some(course => course.id === id))) fail('SCOPE_DENIED'); }
      const previous = currentConfig(); if ((previous?.revision ?? 0) !== input.expected_revision) fail('REVISION_CONFLICT');
      const values = { selections, auto_create: input.auto_create, auto_complete: input.auto_complete, enabled: input.enabled }, data = { format: CONFIG, ...values, policy_hash: lifeHash(values), reviewed_at: stamp(), reviewer: store.identity.student_id };
      return previous ? store.updateWorkspaceRecord(previous.id, { expected_revision: previous.revision, data }) : store.createWorkspaceRecord({ kind: 'schedule', title: 'Dynamic task source policy', data });
    },
    refresh,
    addAICandidates(receiptId) {
      const receipt = store.getWorkspaceRecord(uuid(receiptId));
      if (!receipt || receipt.kind !== 'artifact' || receipt.data.format !== 'dynamic_task_ai_extraction_v1' || receipt.data.state !== 'parsed'
        || receipt.data.candidates_hash !== lifeHash(receipt.data.candidates)) fail('SCOPE_DENIED');
      const source = store.getWorkspaceRecord(receipt.data.source_pin.id), selected = policy().selections.find(selection => selection.kind === 'update' && selection.id === source?.id);
      if (!selected || source.kind !== 'inbox_item' || source.data.category !== 'update' || source.revision !== receipt.data.source_pin.revision || lifeHash(source.data.update) !== receipt.data.source_pin.hash) fail('REVISION_CONFLICT');
      const updateValue = source.data.update, turn = store.getWorkspaceRecord(receipt.data.turn_id);
      if (!turn || turn.data.state !== 'completed' || turn.data.output_sha256 !== receipt.data.output_sha256 || turn.data.grant_id !== receipt.data.grant_id) fail('VERSION_MISMATCH');
      const observations = receipt.data.candidates.map(candidate => {
        if (!candidate || typeof candidate.quote !== 'string' || !candidate.quote.trim() || !updateValue.body.includes(candidate.quote)) fail('SCOPE_DENIED');
        const title = lifeText(candidate.title, 500), deadline = candidate.deadline === null ? { precision: 'unknown' } : parseDeadline({ precision: 'date', date: candidate.deadline });
        if (candidate.deadline !== null && !candidate.quote.includes(candidate.deadline)) fail('SCOPE_DENIED');
        const task = { title, deadline }, observation = { identity: identity({ kind: 'ai_update', source_identity: source.data.source_identity, quote: candidate.quote }), selection_key: selectionKey(selected), source_kind: 'update', source_item_id: lifeHash(candidate.quote),
          task, observed_at: updateValue.observed_at, source_hash: lifeHash({ task, quote: candidate.quote }), pin: { kind: 'update', id: source.id, revision: source.revision, hash: lifeHash(updateValue) },
          source: { title: updateValue.subject, account: `${updateValue.provider}/${updateValue.account}`, url: updateValue.source_url, coverage: updateValue.acquisition, deadline },
          evidence: candidate.quote, suggested_complete: false, completion_basis: null, academic_policy: updateValue.section === 'academic' ? 'graded_or_unknown_support_learning' : 'unknown_support_learning', extraction_receipt_id: receipt.id };
        return observation;
      });
      if (observations.length > 3 || new Set(observations.map(row => row.identity)).size !== observations.length) fail('BUDGET_EXCEEDED');
      if (lifeHash(observations.map(lifeHash)) !== lifeHash(receipt.data.candidate_observation_hashes)) fail('VERSION_MISMATCH');
      const all = itemRows(), created = [], creates = []; if (all.length + observations.filter(observation => !all.some(row => row.data.observation.identity === observation.identity)).length > DYNAMIC_TASK_LIMITS.observations) fail('BUDGET_EXCEEDED');
      for (const observation of observations) {
        const previous = all.find(row => row.data.observation.identity === observation.identity);
        if (previous) { created.push(view(previous)); continue; }
        const task_payload = payload(observation.task), row = { id: randomUUID(), kind: 'inbox_item', title: observation.task.title, data: { format: ITEM, state: 'awaiting_review', observation,
          observation_hash: lifeHash(observation), task_payload, task_payload_hash: lifeHash(task_payload), task_id: null, task_created_revision: null, task_status_revision: null, task_status: null,
          acceptance: null, completion_receipt: null, pending_completion: null, source_present: true, source_conflict: false } };
        creates.push(row); created.push(row);
      }
      if (creates.length) store.commitWorkspaceBatch({ creates, updates: [] });
      return created.map(row => view(store.getWorkspaceRecord(row.id)));
    },
    aiCandidateObservations({ source, receipt_id, candidates }) {
      const selected = policy().selections.find(selection => selection.kind === 'update' && selection.id === source.id); if (!selected) fail('SCOPE_DENIED');
      const updateValue = source.data.update;
      return candidates.map(candidate => {
        const task = { title: candidate.title, deadline: candidate.deadline === null ? { precision: 'unknown' } : parseDeadline({ precision: 'date', date: candidate.deadline }) };
        return { identity: identity({ kind: 'ai_update', source_identity: source.data.source_identity, quote: candidate.quote }), selection_key: selectionKey(selected), source_kind: 'update', source_item_id: lifeHash(candidate.quote), task, observed_at: updateValue.observed_at,
          source_hash: lifeHash({ task, quote: candidate.quote }), pin: { kind: 'update', id: source.id, revision: source.revision, hash: lifeHash(updateValue) },
          source: { title: updateValue.subject, account: `${updateValue.provider}/${updateValue.account}`, url: updateValue.source_url, coverage: updateValue.acquisition, deadline: task.deadline },
          evidence: candidate.quote, suggested_complete: false, completion_basis: null, academic_policy: updateValue.section === 'academic' ? 'graded_or_unknown_support_learning' : 'unknown_support_learning', extraction_receipt_id: receipt_id };
      });
    },
    list() {
      const now = stamp(), observations = itemRows().map(view), tasks = store.listTasks().map(task => ({ task, ...ranked(task, now), observations: observations.filter(row => row.data.task_id === task.id), progress: task.status === 'completed' ? { state: 'completed', basis: 'local_task_status' } : { state: task.status, basis: 'local_task_status_not_activity_inference' } }));
      tasks.sort((a, b) => a.sort - b.sort || (b.task.manual_priority ?? 0) - (a.task.manual_priority ?? 0) || a.due_sort.localeCompare(b.due_sort) || a.task.title.localeCompare(b.task.title) || a.task.id.localeCompare(b.task.id));
      return { config: config(), tasks, observations, groups: [...new Set(tasks.map(row => row.group))], refreshed_from: 'saved_selected_imports', provider_reads: 0, model_calls: 0 };
    },
    getItem: id => view(store.getWorkspaceRecord(uuid(id))),
    accept(id, input) {
      object(input, ['expected_revision', 'review_hash', 'confirmed', 'existing_task_id']); revision(input.expected_revision); if (input.confirmed !== true) fail('CONSENT_REQUIRED');
      let row = checked(store.getWorkspaceRecord(uuid(id))); if (row.revision !== input.expected_revision || reviewHash(row) !== input.review_hash) fail('REVISION_CONFLICT');
      if (row.data.state === 'accepting') return view(finish(row));
      if (row.data.state !== 'awaiting_review' || row.data.source_conflict || !observationCurrent(row.data.observation)) fail('REVISION_CONFLICT');
      if (input.existing_task_id !== null) {
        const match = matches(row.data.observation).find(task => task.id === uuid(input.existing_task_id)); if (!match) fail('SCOPE_DENIED');
        return view(update(row, { state: 'active', task_id: match.id, task_created_revision: match.revision, task_status_revision: null, task_status: null,
          acceptance: { kind: 'student_reviewed_existing_task_link', reviewed_at: stamp(), reviewer: store.identity.student_id } }));
      }
      if (matches(row.data.observation).length) fail('REVISION_CONFLICT');
      const deps = dependencies(row.data.observation); if (!deps.ready) fail('REVISION_CONFLICT');
      const task_payload = { ...payload(row.data.observation.task), ...(deps.ids.length ? { dependency_ids: deps.ids } : {}) }; if (lifeHash(task_payload) !== row.data.task_payload_hash) row = update(row, { task_payload, task_payload_hash: lifeHash(task_payload) });
      return view(begin(row, { kind: 'student_reviewed_exact_task', reviewed_at: stamp(), reviewer: store.identity.student_id, reviewed_revision: input.expected_revision, review_hash: input.review_hash }));
    },
    reject(id, input) {
      object(input, ['expected_revision', 'review_hash', 'confirmed']); revision(input.expected_revision); if (input.confirmed !== true) fail('CONSENT_REQUIRED');
      const row = checked(store.getWorkspaceRecord(uuid(id))); if (row.revision !== input.expected_revision || reviewHash(row) !== input.review_hash || row.data.state !== 'awaiting_review') fail('REVISION_CONFLICT');
      return view(update(row, { state: 'dismissed', acceptance: { kind: 'student_dismissed_source_item', reviewed_at: stamp(), reviewer: store.identity.student_id } }));
    },
    applySource(id, input) {
      object(input, ['expected_revision', 'review_hash', 'confirmed', 'task_revision']); revision(input.expected_revision); revision(input.task_revision); if (input.confirmed !== true) fail('CONSENT_REQUIRED');
      const row = checked(store.getWorkspaceRecord(uuid(id))), task = row.data.task_id ? store.getTask(row.data.task_id) : null;
      if (row.revision !== input.expected_revision || reviewHash(row) !== input.review_hash || row.data.state !== 'active' || row.data.source_conflict || !observationCurrent(row.data.observation)
        || !task || task.revision !== input.task_revision) fail('REVISION_CONFLICT');
      if (equivalent(task, row.data.observation.task)) return view(row);
      const next = store.updateTask(task.id, payload(row.data.observation.task), task.revision), task_payload = { ...payload(row.data.observation.task), ...(row.data.task_payload.dependency_ids ? { dependency_ids: row.data.task_payload.dependency_ids } : {}) };
      return view(update(row, { task_payload, task_payload_hash: lifeHash(task_payload), task_status_revision: row.data.task_status_revision === null ? null : next.revision,
        task_status: next.status, source_update_receipt: { reviewer: store.identity.student_id, reviewed_at: stamp(), observation_hash: row.data.observation_hash,
          task_revision_before: task.revision, task_revision_after: next.revision } }));
    },
    taskProvenance(taskId) {
      uuid(taskId); return itemRows().filter(row => row.data.task_id === taskId).map(row => ({ receipt_id: row.id, receipt_revision: row.revision,
        source_kind: row.data.observation.source_kind, source_current: observationCurrent(row.data.observation), source_present: row.data.source_present, source_selected: selectedNow(row.data.observation),
        observation_hash: row.data.observation_hash, source_pin: row.data.observation.pin, academic_policy: row.data.observation.academic_policy,
        original_task: row.data.task_payload, source_metadata: row.data.observation.source, acceptance: row.data.acceptance }));
    },
  };
}

import { randomUUID } from 'node:crypto';
import { LearnBridgeError, parseDeadline } from '@learnbridge/core';
import { lifeHash, lifeText, lifeStamp } from './life.mjs';

const PREVIEW = 'academic_task_preview_v1', PROPOSAL = 'academic_task_proposal_v1';
export const ACADEMIC_TASK_LIMITS = Object.freeze({ snapshots: 5, courses: 5, selected_items: 3, inspected_items: 200, retained_previews: 100, retained_proposals: 300, preview_ttl_ms: 600000 });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fail = (code = 'INVALID_INPUT') => { throw new LearnBridgeError(code); };
function object(value, keys, required = keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) || !('value' in descriptors[key]) || !descriptors[key].enumerable)
    || required.some(key => !Object.hasOwn(descriptors, key))) fail();
}
const id = value => { if (typeof value !== 'string' || !UUID.test(value)) fail(); return value.toLowerCase(); };
const rev = value => { if (!Number.isSafeInteger(value) || value < 1) fail(); return value; };
const digest = value => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(); return value; };
const retryKey = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(value)) fail(); return value; };
function unique(values, max, parse) {
  if (!Array.isArray(values) || !values.length || values.length > max) fail();
  const descriptors = Object.getOwnPropertyDescriptors(values);
  if (Reflect.ownKeys(descriptors).some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= values.length || !('value' in descriptors[key]) || !descriptors[key].enumerable))) fail();
  const result = Array.from({ length: values.length }, (_, index) => { if (!Object.hasOwn(descriptors, String(index))) fail(); return parse(descriptors[index].value); });
  if (new Set(result).size !== result.length) fail(); return result.sort();
}
const courseId = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value)) fail(); return value; };
const name = value => value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
const deadlineIdentity = deadline => ({ precision: deadline.precision, date: deadline.date ?? null, instant: deadline.instant ?? null, timezone: deadline.timezone ?? null });
const taskPayload = item => {
  const raw = item.source.deadline, deadline = { ...raw }; if (deadline.timezone == null) delete deadline.timezone;
  return { title: `Prepare: ${item.source.title}`, deadline: parseDeadline(deadline), course_label: item.course_label };
};
const payloadHash = data => lifeHash({ task: data.task, source: data.source, source_pins: data.source_pins });

/** Deterministic current selected-source planning. No provider, model, source discovery or automatic task acceptance. */
export function createAcademicTaskService({ store, studentWorkspace, clock = Date.now }) {
  const stamp = () => { const value = clock(); let result; try { result = typeof value === 'string' ? value : new Date(value).toISOString(); } catch { fail(); } return lifeStamp(result); };
  const records = format => store.listWorkspaceRecords({ kind: 'inbox_item' }).filter(row => row.data.format === format);
  const previews = () => store.listWorkspaceRecords({ kind: 'plan' }).filter(row => row.data.format === PREVIEW);
  function proposal(row) {
    if (!row || row.kind !== 'inbox_item' || row.data.format !== PROPOSAL) fail('SCOPE_DENIED');
    const data = row.data;
    object(data, ['format', 'state', 'task', 'source', 'source_pins', 'payload_hash', 'preview_id', 'creation_hash', 'review_receipt', 'task_id']);
    if (!['awaiting_review', 'accepting', 'accepted', 'rejected'].includes(data.state) || data.payload_hash !== payloadHash(data)) fail('VERSION_MISMATCH');
    id(data.preview_id); digest(data.creation_hash); id(data.source.item_id); parseDeadline(data.task.deadline); lifeText(data.task.title, 500);
    if ((data.state === 'accepted') !== (data.task_id !== null)) fail('VERSION_MISMATCH'); if (data.task_id !== null) id(data.task_id);
    if (data.state === 'awaiting_review') { if (data.review_receipt !== null) fail('VERSION_MISMATCH'); }
    else {
      object(data.review_receipt, ['reviewer', 'reviewed_revision', 'payload_hash', 'decision', 'decided_at']);
      if (data.review_receipt.reviewer !== store.identity.student_id || data.review_receipt.payload_hash !== data.payload_hash || !['accept', 'reject'].includes(data.review_receipt.decision)) fail('VERSION_MISMATCH');
      rev(data.review_receipt.reviewed_revision); lifeStamp(data.review_receipt.decided_at);
    }
    return row;
  }
  function previewRecord(row) {
    if (!row || row.kind !== 'plan' || row.data.format !== PREVIEW) fail('SCOPE_DENIED');
    const data = row.data;
    object(data, ['format', 'state', 'request', 'source_pins', 'items', 'created_at', 'expires_at', 'review_hash', 'creation_operation', 'proposal_ids']);
    if (!['preview', 'saved'].includes(data.state) || !Array.isArray(data.items) || !data.items.length || data.items.length > ACADEMIC_TASK_LIMITS.selected_items
      || !Array.isArray(data.proposal_ids) || data.proposal_ids.length > ACADEMIC_TASK_LIMITS.selected_items) fail('VERSION_MISMATCH');
    lifeStamp(data.created_at); lifeStamp(data.expires_at); if (data.review_hash !== reviewHash(data)) fail('VERSION_MISMATCH');
    return row;
  }
  const reviewHash = data => lifeHash({ request: data.request, source_pins: data.source_pins, items: data.items, created_at: data.created_at, expires_at: data.expires_at });
  function selected(input) {
    object(input, ['snapshot_ids', 'course_ids']);
    const scope = { snapshot_ids: unique(input.snapshot_ids, ACADEMIC_TASK_LIMITS.snapshots, id), course_ids: unique(input.course_ids, ACADEMIC_TASK_LIMITS.courses, courseId) };
    // The existing library gate validates current heads and source hashes; historical/forgotten snapshots cannot enter this flow.
    studentWorkspace.library(scope);
    const snapshots = scope.snapshot_ids.map(value => studentWorkspace.getCurrentSnapshot(value));
    const source_pins = snapshots.map(row => ({ snapshot_id: row.id, snapshot_revision: row.revision, snapshot_hash: row.data.snapshot.snapshot_hash,
      stream_id: row.stream_id ?? null, stream_revision: row.stream_revision ?? 0 }));
    const byItem = new Map();
    for (const row of snapshots) {
      const snapshot = row.data.snapshot;
      for (const assignment of snapshot.assignments.filter(item => scope.course_ids.includes(item.course_id))) {
        const course = snapshot.courses.find(item => item.source_id === assignment.course_id); if (!course) fail('VERSION_MISMATCH');
        const candidate = { source: { item_id: assignment.id, source_id: assignment.source_id, source_hash: assignment.source_hash, course_id: assignment.course_id,
          title: assignment.title, url: assignment.url, deadline: assignment.deadline, snapshot_id: row.id, snapshot_hash: snapshot.snapshot_hash,
          institution: snapshot.institution, account_ref: snapshot.account_ref, retrieved_at: snapshot.retrieved_at, coverage_state: snapshot.coverage.assignments.state },
          course_label: course.code?.trim() || course.title, course_title: course.title, conflicted: false };
        const previous = byItem.get(assignment.id);
        if (previous && previous.source.source_hash !== assignment.source_hash) { previous.conflicted = true; continue; }
        if (!previous || candidate.source.retrieved_at > previous.source.retrieved_at) byItem.set(assignment.id, { ...candidate, conflicted: previous?.conflicted ?? false });
      }
    }
    return { scope, source_pins, items: [...byItem.values()].sort((a, b) => a.source.item_id.localeCompare(b.source.item_id)) };
  }
  function sourcesCurrent(scope, pins) {
    try { return lifeHash(selected(scope).source_pins) === lifeHash(pins); } catch { return false; }
  }
  function matching(item, ignoreProposalId) {
    const allProposals = records(PROPOSAL).map(proposal), otherSourceTasks = new Set(allProposals.filter(row => row.data.task_id && row.data.source.item_id !== item.source.item_id).map(row => row.data.task_id));
    const task = taskPayload(item), titles = new Set([name(task.title), name(item.source.title)]), existing = store.listTasks().filter(row => !otherSourceTasks.has(row.id) && titles.has(name(row.title))
      && (row.course_label == null || name(row.course_label) === name(task.course_label)));
    const old = allProposals.filter(row => row.id !== ignoreProposalId && row.data.source.item_id === item.source.item_id && row.data.state !== 'rejected');
    const metadata = { tasks: existing.map(row => ({ id: row.id, revision: row.revision, title: row.title, course_label: row.course_label ?? null,
      deadline: row.deadline, status: row.status })).sort((a, b) => a.id.localeCompare(b.id)),
      proposals: old.map(row => ({ id: row.id, revision: row.revision, state: row.data.state, source_hash: row.data.source.source_hash, payload_hash: row.data.payload_hash, task_id: row.data.task_id })).sort((a, b) => a.id.localeCompare(b.id)) };
    let state = 'new_proposal';
    if (item.conflicted) state = 'conflicting_current_sources';
    else if (item.source.deadline.precision === 'unknown') state = 'unknown_deadline';
    else if (old.some(row => row.data.state === 'accepted' && row.data.source.source_hash !== item.source.source_hash)) state = 'accepted_source_changed';
    else if (old.some(row => row.data.state === 'accepted')) state = 'already_accepted';
    else if (old.some(row => row.data.state === 'accepting')) state = 'acceptance_pending';
    else if (old.some(row => row.data.source.source_hash !== item.source.source_hash)) state = 'pending_source_changed';
    else if (old.length) state = 'already_pending';
    else if (existing.length) state = existing.some(row => row.course_label == null || lifeHash(deadlineIdentity(row.deadline)) !== lifeHash(deadlineIdentity(task.deadline))) ? 'existing_task_conflict' : 'existing_matching_task';
    return { task, state, matches: metadata, match_hash: lifeHash(metadata) };
  }
  function previewView(row) {
    row = previewRecord(row); const data = row.data;
    return { ...row, expired: Date.parse(stamp()) >= Date.parse(data.expires_at), needs_refresh: !sourcesCurrent({ snapshot_ids: data.request.snapshot_ids, course_ids: data.request.course_ids }, data.source_pins),
      effects: { tasks_created: 0, calendar_writes: 0, model_calls: 0, provider_reads: 0 } };
  }
  function proposalView(row) {
    row = proposal(row); const scope = { snapshot_ids: row.data.source_pins.map(pin => pin.snapshot_id), course_ids: [row.data.source.course_id] };
    const task = row.data.task_id ? store.getTask(row.data.task_id) : null;
    return { ...row, needs_refresh: !sourcesCurrent(scope, row.data.source_pins), review_revision: row.data.review_receipt?.reviewed_revision ?? row.revision,
      accepted_task: task ? { id: task.id, title: task.title, deadline: task.deadline, revision: task.revision, status: task.status,
        changed: lifeHash({ title: task.title, deadline: task.deadline, course_label: task.course_label ?? null }) !== lifeHash(row.data.task) } : row.data.task_id ? { id: row.data.task_id, unavailable: true } : null };
  }
  function refreshItem(row) {
    const scope = { snapshot_ids: row.data.source_pins.map(pin => pin.snapshot_id), course_ids: [row.data.source.course_id] };
    let current; try { current = selected(scope); } catch (error) { if (error?.code === 'SCOPE_DENIED') fail('REVISION_CONFLICT'); throw error; }
    if (lifeHash(current.source_pins) !== lifeHash(row.data.source_pins)) fail('REVISION_CONFLICT');
    const item = current.items.find(item => item.source.item_id === row.data.source.item_id);
    if (!item || item.conflicted || lifeHash(item.source) !== lifeHash(row.data.source)) fail('REVISION_CONFLICT'); return item;
  }
  function finishAcceptance(row) {
    const key = `academic-accept-${row.id}`, saved = store.getTaskCreateResult(row.data.task, { idempotencyKey: key });
    let created = saved;
    if (!saved) {
      const item = refreshItem(row), matches = matching(item, row.id); if (matches.state !== 'new_proposal') fail('REVISION_CONFLICT');
      created = store.createTask(row.data.task, { idempotencyKey: key });
    }
    const actual = store.getTask(created.id);
    const next = store.commitWorkspaceBatch({ creates: [], updates: [{ id: row.id, expected_revision: row.revision, data: { ...row.data, state: 'accepted', task_id: created.id } }] }).updates[0];
    const result = proposalView(next);
    if (actual && actual.id !== result.accepted_task.id) fail('VERSION_MISMATCH');
    return result;
  }
  return {
    context() { return { snapshots: studentWorkspace.listSnapshots().map(row => ({ id: row.id, revision: row.revision, snapshot_hash: row.data.snapshot.snapshot_hash,
      institution: row.data.snapshot.institution.name, retrieved_at: row.data.snapshot.retrieved_at, stream_revision: row.stream_revision ?? 0,
      courses: row.data.snapshot.courses.map(course => ({ id: course.source_id, title: course.title, code: course.code })) })), limits: ACADEMIC_TASK_LIMITS,
      processing: 'selected_current_local_academic_metadata', automatic_task_acceptance: false, source_text_to_model: false, provider_reads: false }; },
    inspect(input) {
      const value = selected(input); return { ...value.scope, source_pins: value.source_pins,
        items: value.items.slice(0, ACADEMIC_TASK_LIMITS.inspected_items).map(item => ({ ...item, ...matching(item) })), total_items: value.items.length,
        truncated: value.items.length > ACADEMIC_TASK_LIMITS.inspected_items, coverage_claim: 'source_reported', limitations: ['Saved course exports are observations, not live refresh.', 'Unknown dates are not invented.', 'Missing or changed sources never delete or edit an existing task.'] };
    },
    preview(input, { idempotencyKey } = {}) {
      object(input, ['snapshot_ids', 'course_ids', 'assignment_ids']); const assignment_ids = unique(input.assignment_ids, ACADEMIC_TASK_LIMITS.selected_items, id), key = retryKey(idempotencyKey);
      const value = selected({ snapshot_ids: input.snapshot_ids, course_ids: input.course_ids }), request = { ...value.scope, assignment_ids };
      const request_hash = lifeHash(request), all = previews(), previous = all.find(row => row.data.creation_operation.key === key);
      if (previous) { previewRecord(previous); if (previous.data.creation_operation.request_hash !== request_hash) fail('REVISION_CONFLICT'); return previewView(previous); }
      if (all.length >= ACADEMIC_TASK_LIMITS.retained_previews) fail('BUDGET_EXCEEDED');
      const items = assignment_ids.map(valueId => { const item = value.items.find(item => item.source.item_id === valueId); if (!item) fail('SCOPE_DENIED'); return { ...item, ...matching(item) }; });
      const created_at = stamp(), data = { format: PREVIEW, state: 'preview', request, source_pins: value.source_pins, items,
        created_at, expires_at: new Date(Date.parse(created_at) + ACADEMIC_TASK_LIMITS.preview_ttl_ms).toISOString(), proposal_ids: [],
        creation_operation: { key, request_hash } }; data.review_hash = reviewHash(data);
      const saved = store.commitWorkspaceBatch({ creates: [{ id: randomUUID(), kind: 'plan', title: 'Review selected academic tasks', data }], updates: [] }).creates[0]; return previewView(saved);
    },
    listPreviews: () => previews().map(previewView),
    getPreview: value => previewView(store.getWorkspaceRecord(id(value))),
    savePending(value, input) {
      object(input, ['expected_revision', 'review_hash']); rev(input.expected_revision); digest(input.review_hash);
      const row = previewRecord(store.getWorkspaceRecord(id(value))), data = row.data;
      if (input.review_hash !== data.review_hash) fail('REVISION_CONFLICT');
      if (data.state === 'saved') { if (![row.revision, row.revision - 1].includes(input.expected_revision)) fail('REVISION_CONFLICT'); return { preview: previewView(row), proposals: data.proposal_ids.map(valueId => proposalView(store.getWorkspaceRecord(valueId))), status: 'replayed', tasks_created: 0 }; }
      if (row.revision !== input.expected_revision) fail('REVISION_CONFLICT'); if (Date.parse(stamp()) >= Date.parse(data.expires_at)) fail('CONSENT_REQUIRED');
      const current = selected({ snapshot_ids: data.request.snapshot_ids, course_ids: data.request.course_ids }); if (lifeHash(current.source_pins) !== lifeHash(data.source_pins)) fail('REVISION_CONFLICT');
      const checked = data.items.map(item => { const now = current.items.find(candidate => candidate.source.item_id === item.source.item_id); if (!now || lifeHash(now) !== lifeHash({ source: item.source, course_label: item.course_label, course_title: item.course_title, conflicted: item.conflicted })) fail('REVISION_CONFLICT');
        const matches = matching(now); if (matches.match_hash !== item.match_hash || matches.state !== item.state || lifeHash(matches.task) !== lifeHash(item.task)) fail('REVISION_CONFLICT'); return item; });
      const ready = checked.filter(item => item.state === 'new_proposal'), count = records(PROPOSAL).length; if (count + ready.length > ACADEMIC_TASK_LIMITS.retained_proposals) fail('BUDGET_EXCEEDED');
      const creates = ready.map(item => { const proposalData = { format: PROPOSAL, state: 'awaiting_review', task: item.task, source: item.source, source_pins: data.source_pins,
        preview_id: row.id, creation_hash: lifeHash({ preview_id: row.id, review_hash: data.review_hash, item_id: item.source.item_id }), review_receipt: null, task_id: null }; proposalData.payload_hash = payloadHash(proposalData);
        return { id: randomUUID(), kind: 'inbox_item', title: item.task.title, data: proposalData }; });
      const batch = store.commitWorkspaceBatch({ creates, updates: [{ id: row.id, expected_revision: row.revision, data: { ...data, state: 'saved', proposal_ids: creates.map(item => item.id) } }] });
      return { preview: previewView(batch.updates[0]), proposals: batch.creates.map(proposalView), status: 'pending_review_saved', tasks_created: 0 };
    },
    listProposals: () => records(PROPOSAL).map(proposalView),
    getProposal: value => proposalView(store.getWorkspaceRecord(id(value))),
    accept(value, input) {
      object(input, ['expected_revision', 'payload_hash', 'confirmed']); rev(input.expected_revision); digest(input.payload_hash); if (input.confirmed !== true) fail('CONSENT_REQUIRED');
      let row = proposal(store.getWorkspaceRecord(id(value))); if (row.data.payload_hash !== input.payload_hash) fail('REVISION_CONFLICT');
      if (row.data.state === 'accepted') { if (![row.revision, row.data.review_receipt.reviewed_revision].includes(input.expected_revision)) fail('REVISION_CONFLICT'); return proposalView(row); }
      if (row.data.state === 'rejected') fail('REVISION_CONFLICT');
      if (row.data.state === 'accepting') { if (![row.revision, row.data.review_receipt.reviewed_revision].includes(input.expected_revision)) fail('REVISION_CONFLICT'); return finishAcceptance(row); }
      if (row.revision !== input.expected_revision) fail('REVISION_CONFLICT'); const item = refreshItem(row), match = matching(item, row.id); if (match.state !== 'new_proposal') fail('REVISION_CONFLICT');
      const receipt = { reviewer: store.identity.student_id, reviewed_revision: row.revision, payload_hash: row.data.payload_hash, decision: 'accept', decided_at: stamp() };
      row = store.commitWorkspaceBatch({ creates: [], updates: [{ id: row.id, expected_revision: row.revision, data: { ...row.data, state: 'accepting', review_receipt: receipt } }] }).updates[0];
      return finishAcceptance(proposal(row));
    },
    reject(value, input) {
      object(input, ['expected_revision', 'payload_hash', 'confirmed']); rev(input.expected_revision); digest(input.payload_hash); if (input.confirmed !== true) fail('CONSENT_REQUIRED');
      const row = proposal(store.getWorkspaceRecord(id(value))); if (row.data.payload_hash !== input.payload_hash) fail('REVISION_CONFLICT');
      if (row.data.state === 'rejected' && [row.revision, row.data.review_receipt.reviewed_revision].includes(input.expected_revision)) return proposalView(row);
      if (row.data.state !== 'awaiting_review' || row.revision !== input.expected_revision) fail('REVISION_CONFLICT');
      const receipt = { reviewer: store.identity.student_id, reviewed_revision: row.revision, payload_hash: row.data.payload_hash, decision: 'reject', decided_at: stamp() };
      return proposalView(store.commitWorkspaceBatch({ creates: [], updates: [{ id: row.id, expected_revision: row.revision, data: { ...row.data, state: 'rejected', review_receipt: receipt } }] }).updates[0]);
    },
  };
}

import { createHash, randomUUID } from 'node:crypto';
import { LearnBridgeError, parseDeadline } from '@learnbridge/core';
import { createLearningService } from './learning-service.mjs';

export const PLAN_TASK_FORMAT = 'learning_plan_task_preview_v1';
export const PLAN_TASK_RECEIPT = 'learning_plan_task_receipt_v1';
export const PLAN_TASK_LIMITS = Object.freeze({ selected_topics: 20, retained_previews: 100, preview_bytes: 100000, record_bytes: 120000, task_effects_per_request: 1 });
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const fail = (code = 'INVALID_INPUT') => { throw new LearnBridgeError(code); };
const id = value => { if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) fail(); return value; };
const revision = value => { if (!Number.isSafeInteger(value) || value < 1) fail(); return value; };
const digest = value => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(); return value; };
const topicId = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) fail(); return value; };
const key = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(value)) fail(); return value; };
function object(value, allowed, required = allowed) { if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail(); const props = Object.getOwnPropertyDescriptors(value); if (Reflect.ownKeys(props).some(field => typeof field !== 'string' || !allowed.includes(field) || !props[field].enumerable || !Object.hasOwn(props[field], 'value')) || required.some(field => !Object.hasOwn(props, field))) fail(); }
function topics(values) {
  if (!Array.isArray(values) || Object.getPrototypeOf(values) !== Array.prototype || !values.length || values.length > PLAN_TASK_LIMITS.selected_topics) fail();
  const props = Object.getOwnPropertyDescriptors(values); if (Reflect.ownKeys(props).length !== values.length + 1) fail();
  const result = Array.from({ length: values.length }, (_, index) => { if (!props[index]?.enumerable || !Object.hasOwn(props[index], 'value')) fail(); return topicId(props[index].value); }); if (new Set(result).size !== result.length) fail(); return result.sort();
}
const receiptId = value => { const hex = hash(value); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`; };
const relevantTask = task => ({ title: task.title, deadline: task.deadline, effort_minutes: task.effort_minutes, course_label: task.course_label ?? null, dependency_ids: task.dependency_ids });
const receiptHash = data => hash({ owner: data.owner, source: data.source, topic_id: data.topic_id, candidate_hash: data.candidate_hash, task_hash: data.task_hash, task: data.task,
  dependency_pins: data.dependency_pins, completed_prerequisites: data.completed_prerequisites, source_citations: data.source_citations, preview_id: data.preview_id, review: data.review });

/** Accepted-only learning plan → exact private preview → one separately reviewed local task. */
export function createPlanTaskService({ store, getLibrary, learningService = createLearningService({ store, getLibrary }), clock = Date.now }) {
  const stamp = () => { const value = clock(); if (!Number.isSafeInteger(value)) fail(); return new Date(value).toISOString(); };
  const previews = () => store.listWorkspaceRecords({ kind: 'plan' }).filter(row => row.data.format === PLAN_TASK_FORMAT);
  const identity = (planId, topic) => ({ student_id: store.identity.student_id, plan_id: planId, topic_id: topic });
  const receipt = (planId, topic) => { const row = store.getWorkspaceRecord(receiptId(identity(planId, topic))); if (!row) return null; const data = row.data;
    if (row.kind !== 'inbox_item' || data.format !== PLAN_TASK_RECEIPT || data.owner !== store.identity.student_id || data.topic_id !== topic || data.source?.plan_id !== planId
      || !['accepting', 'accepted'].includes(data.state) || data.payload_hash !== receiptHash(data) || data.task_hash !== hash({ candidate_hash: data.candidate_hash, task: data.task, dependency_pins: data.dependency_pins, completed_prerequisites: data.completed_prerequisites })
      || data.review?.reviewer !== store.identity.student_id || data.review.task_hash !== data.task_hash || data.review.decision !== 'accept_one_local_task' || data.review.mastery_claim !== false
      || (data.state === 'accepting' ? data.task_id !== null : typeof data.task_id !== 'string')) fail('VERSION_MISMATCH');
    revision(data.review.reviewed_revision); digest(data.review.preview_hash); id(data.preview_id); if (data.task_id !== null) id(data.task_id); parseDeadline(data.task.deadline);
    if (data.state === 'accepted') { const saved = store.getTaskCreateResult(data.task, { idempotencyKey: `plan-task-${hash(identity(planId, topic))}` }); if (!saved || saved.id !== data.task_id || hash(saved) !== data.task_create_receipt_hash) fail('VERSION_MISMATCH'); }
    return row; };
  function source(planId, ref) {
    const row = store.getWorkspaceRecord(id(planId)), data = row?.data;
    if (!row || row.kind !== 'plan' || data.format !== 'learning_catchup') fail('SCOPE_DENIED');
    // This guard MUST precede calling the accepted-only idempotent validator.
    if (data.state !== 'accepted' || data.review_receipt?.reviewer !== store.identity.student_id || data.review_receipt.source !== 'paired_local_ui'
      || data.review_receipt.catch_up_hash !== data.catch_up?.catch_up_hash || data.review_receipt.plan_hash !== data.plan?.plan_hash) fail('CONSENT_REQUIRED');
    const plan_hash = digest(data.plan.plan_hash), catch_up_hash = digest(data.catch_up.catch_up_hash);
    if (ref && (ref.id !== row.id || ref.revision !== row.revision || ref.plan_hash !== plan_hash || ref.catch_up_hash !== catch_up_hash)) fail('REVISION_CONFLICT');
    let verified; try { verified = learningService.acceptCatchUp(row.id, { expected_revision: row.revision, plan_hash, catch_up_hash }); } catch (error) { if (['STALE_EVIDENCE', 'SCOPE_DENIED', 'CONSENT_REQUIRED', 'POLICY_BLOCKED'].includes(error.code)) fail('REVISION_CONFLICT'); throw error; }
    if (verified.revision !== row.revision || hash(verified.data) !== hash(data)) fail('VERSION_MISMATCH');
    const session = learningService.getSession(data.session_id); if (session.revision !== data.session_revision || session.data.recipe.state === 'blocked') fail('REVISION_CONFLICT');
    const pin = { plan_id: row.id, plan_revision: row.revision, plan_data_hash: hash(data), plan_hash, catch_up_hash, session_id: session.id, session_revision: session.revision, session_hash: session.data.recipe.session_hash,
      snapshot_pins: session.data.snapshot_pins, academic_policy: session.data.recipe.academic_policy, acceptance: data.review_receipt, coverage_basis: 'selected_topics_only', mastery_claim: false };
    const candidates = data.catch_up.topics.map(topic => {
      const recipe = data.catch_up.task_recipes.find(item => item.id === topic.id); if (!recipe || recipe.title !== topic.title) fail('VERSION_MISMATCH');
      const base_task = { title: topic.title, status: 'pending', deadline: parseDeadline(recipe.deadline), effort_minutes: topic.effort_minutes,
        course_label: session.data.scope.course_ids.join(', ').slice(0, 500), dependency_ids: [], source_refs: [] };
      const candidate = { topic_id: topic.id, base_task, dependency_topic_ids: topic.dependency_ids, completed: topic.completed, source_citations: topic.source_citations,
        estimate_origin: 'student_reviewed_plan_estimate', schedule_semantics: 'Exam/goal deadline is retained; proposed study blocks are not task deadlines.', manual_priority: topic.manual_priority };
      return { ...candidate, candidate_hash: hash({ source: pin, candidate }) };
    });
    return { row, source: pin, candidates };
  }
  function sourceCurrent(pin) { const actual = source(pin.plan_id); if (hash(actual.source) !== hash(pin)) fail('REVISION_CONFLICT'); return actual; }
  function candidateView(candidate, pin, all) {
    const previous = receipt(pin.plan_id, candidate.topic_id), blockers = [], dependency_pins = [], dependency_ids = [], completed_prerequisites = [];
    for (const dependency of candidate.dependency_topic_ids) {
      const topic = all.find(item => item.topic_id === dependency); if (!topic) { blockers.push({ topic_id: dependency, reason: 'prerequisite_not_in_reviewed_plan' }); continue; }
      if (topic.completed) { completed_prerequisites.push({ topic_id: dependency, claim: 'student_reported_complete_not_mastery' }); continue; }
      const old = receipt(pin.plan_id, dependency), task = old?.data.state === 'accepted' ? store.getTask(old.data.task_id) : null;
      if (!task || old.data.candidate_hash !== topic.candidate_hash || hash(relevantTask(task)) !== hash(relevantTask(old.data.task))) { blockers.push({ topic_id: dependency, reason: old ? 'accepted_prerequisite_changed_or_unavailable' : 'prerequisite_needs_separate_task_acceptance' }); continue; }
      dependency_ids.push(task.id); dependency_pins.push({ topic_id: dependency, task_id: task.id, task_revision: task.revision, task_hash: hash(task) });
    }
    const task = { ...candidate.base_task, dependency_ids }, task_hash = hash({ candidate_hash: candidate.candidate_hash, task, dependency_pins, completed_prerequisites });
    const savedTask = previous?.data.task_id ? store.getTask(previous.data.task_id) : null;
    const state = previous ? previous.data.candidate_hash !== candidate.candidate_hash ? 'previous_handoff_source_changed' : previous.data.state === 'accepting' ? 'acceptance_pending' : 'already_accepted' : candidate.completed ? 'student_reported_complete_no_new_task' : blockers.length ? 'prerequisites_need_review' : 'awaiting_review';
    return { ...candidate, task: state === 'acceptance_pending' ? previous.data.task : task, task_hash: state === 'acceptance_pending' ? previous.data.task_hash : task_hash, current_task_hash: task_hash,
      dependency_pins: state === 'acceptance_pending' ? previous.data.dependency_pins : dependency_pins, completed_prerequisites: state === 'acceptance_pending' ? previous.data.completed_prerequisites : completed_prerequisites,
      blockers, state, selectable: state === 'awaiting_review',
      accepted_task: previous?.data.task_id ? savedTask ? { id: savedTask.id, revision: savedTask.revision, status: savedTask.status, changed: hash(relevantTask(savedTask)) !== hash(relevantTask(previous.data.task)) } : { id: previous.data.task_id, unavailable: true } : null };
  }
  function get(value) { const row = store.getWorkspaceRecord(id(value)); if (!row || row.kind !== 'plan' || row.data.format !== PLAN_TASK_FORMAT) fail('SCOPE_DENIED'); if (hash(row.data.preview) !== row.data.preview_hash) fail('VERSION_MISMATCH'); return row; }
  function view(row, full = true) {
    let selected, stale = false; try { selected = sourceCurrent(row.data.preview.source); } catch (error) { if (!['REVISION_CONFLICT', 'SCOPE_DENIED', 'CONSENT_REQUIRED', 'STALE_EVIDENCE'].includes(error.code)) throw error; stale = true; }
    const rows = row.data.preview.candidates.map(item => ({ ...candidateView(item, row.data.preview.source, selected?.candidates || row.data.preview.all_candidates), ...(stale ? { selectable: false } : {}) }));
    const counts = { topics: rows.length, awaiting_review: rows.filter(item => item.selectable).length, accepted: rows.filter(item => item.state === 'already_accepted').length, pending_recovery: rows.filter(item => item.state === 'acceptance_pending').length };
    return full ? { ...row, rows, counts, stale, effects: { automatic_task_acceptance: false, calendar_writes: 0, model_calls: 0 } } : { id: row.id, revision: row.revision, title: row.title, preview_hash: row.data.preview_hash, counts, stale };
  }
  function exact(row, raw) { if (raw.expected_revision !== row.revision || raw.preview_hash !== row.data.preview_hash) fail('REVISION_CONFLICT'); }
  function finish(row, item) {
    const operation = `plan-task-${hash(identity(item.data.source.plan_id, item.data.topic_id))}`, saved = store.getTaskCreateResult(item.data.task, { idempotencyKey: operation });
    if (!saved) { sourceCurrent(item.data.source); const current = sourceCurrent(row.data.preview.source), candidate = current.candidates.find(candidate => candidate.topic_id === item.data.topic_id), now = candidateView(candidate, current.source, current.candidates);
      if (now.current_task_hash !== item.data.task_hash || now.blockers.length) fail('REVISION_CONFLICT'); }
    const created = saved || store.createTask(item.data.task, { idempotencyKey: operation });
    const data = { ...item.data, state: 'accepted', task_id: created.id, task_create_receipt_hash: hash(created), completed_at: stamp() };
    const result = store.commitWorkspaceBatch({ creates: [], updates: [{ id: item.id, expected_revision: item.revision, data }] }).updates[0];
    return { preview: view(get(row.id)), receipt: result, task: store.getTask(created.id) || { id: created.id, unavailable: true }, replayed: !!saved, task_effects: saved ? 0 : 1 };
  }
  return {
    taskProvenance(value) {
      const task = store.getTask(id(value)); if (!task) fail('SCOPE_DENIED'); const receipts = [], pins = [];
      for (const row of store.listWorkspaceRecords({ kind: 'inbox_item' }).filter(row => row.data.format === PLAN_TASK_RECEIPT)) {
        const data = row.data; let associated = data.task_id === task.id;
        if (['accepting', 'accepted'].includes(data.state) && !associated) { const earlier = store.getTaskCreateResult(data.task, { idempotencyKey: `plan-task-${hash(identity(data.source.plan_id, data.topic_id))}` }); associated = earlier?.id === task.id; }
        if (!associated) continue;
        const checked = receipt(data.source.plan_id, data.topic_id); if (!checked || checked.id !== row.id) fail('VERSION_MISMATCH'); if (data.state !== 'accepted') fail('CONSENT_REQUIRED');
        const actual = sourceCurrent(data.source), session = learningService.getSession(data.source.session_id);
        pins.push({ kind: 'learning_plan_task_receipt', id: row.id, revision: row.revision, hash: hash(row.data) },
          { kind: 'learning_catchup_plan', id: actual.row.id, revision: actual.row.revision, hash: hash(actual.row.data) },
          { kind: 'tutoring_session', id: session.id, revision: session.revision, hash: hash(session.data) },
          ...data.source.snapshot_pins.map(pin => ({ kind: 'learning_academic_snapshot', id: pin.id, revision: pin.revision, hash: pin.hash })));
        receipts.push({ id: row.id, revision: row.revision, payload_hash: data.payload_hash, task_id: task.id, source: data.source, topic_id: data.topic_id, source_citations: data.source_citations,
          reviewed_task: data.task, review: data.review, dependency_pins: data.dependency_pins, completed_prerequisites: data.completed_prerequisites,
          task_create_receipt_hash: data.task_create_receipt_hash, local_task_differs: hash(relevantTask(task)) !== hash(relevantTask(data.task)) });
      }
      if (receipts.length > 1) fail('VERSION_MISMATCH'); return { receipts, pins };
    },
    state() {
      const plans = store.listWorkspaceRecords({ kind: 'plan' }).filter(row => row.data.format === 'learning_catchup' && row.data.state === 'accepted').map(row => { try { const actual = source(row.id); return { id: row.id, revision: row.revision, title: row.title, plan_hash: actual.source.plan_hash, catch_up_hash: actual.source.catch_up_hash, topics: actual.candidates.length, stale: false }; } catch (error) { if (!['REVISION_CONFLICT', 'SCOPE_DENIED', 'CONSENT_REQUIRED', 'STALE_EVIDENCE'].includes(error.code)) throw error; return { id: row.id, revision: row.revision, title: row.title, stale: true, reason: 'Reviewed learning evidence changed or is unavailable.' }; } });
      return { plans, previews: previews().map(row => view(row, false)), limits: PLAN_TASK_LIMITS, provider_reads: false, model_calls: false, automatic_acceptance: false, mastery_claim: false };
    },
    inspect(value) { const actual = source(value); return { plan_ref: { id: actual.row.id, revision: actual.row.revision, plan_hash: actual.source.plan_hash, catch_up_hash: actual.source.catch_up_hash }, source: actual.source,
      topics: actual.candidates.map(candidate => candidateView(candidate, actual.source, actual.candidates)), claim: 'Accepted student plan covers selected topics only; creating tasks does not establish learning or mastery.' }; },
    get: value => ({ preview: view(get(value)) }),
    preview(raw, { idempotencyKey } = {}) {
      object(raw, ['plan_ref', 'topic_ids']); object(raw.plan_ref, ['id', 'revision', 'plan_hash', 'catch_up_hash']); id(raw.plan_ref.id); revision(raw.plan_ref.revision); digest(raw.plan_ref.plan_hash); digest(raw.plan_ref.catch_up_hash); const selected = topics(raw.topic_ids), request_key = key(idempotencyKey), request_hash = hash({ ...raw, topic_ids: selected });
      const actual = source(raw.plan_ref.id, raw.plan_ref), previous = previews().find(row => row.data.creation_operation.key === request_key);
      if (previous) { if (previous.data.creation_operation.request_hash !== request_hash) fail('REVISION_CONFLICT'); sourceCurrent(previous.data.preview.source); return { preview: view(previous) }; }
      if (previews().length >= PLAN_TASK_LIMITS.retained_previews) fail('BUDGET_EXCEEDED');
      const candidates = selected.map(topic => { const item = actual.candidates.find(candidate => candidate.topic_id === topic); if (!item || item.completed) fail('CONSENT_REQUIRED'); return item; });
      const preview = { source: actual.source, candidates, all_candidates: actual.candidates, created_at: stamp(), limitations: ['Task effort is a reviewed estimate.', 'Unknown and date-only deadlines are preserved.', 'Task creation does not establish completion, syllabus coverage or mastery.', 'Prerequisites need separate review; no dependent task is accepted automatically.'] };
      if (Buffer.byteLength(JSON.stringify(preview)) > PLAN_TASK_LIMITS.preview_bytes) fail('BUDGET_EXCEEDED');
      const data = { format: PLAN_TASK_FORMAT, preview, preview_hash: hash(preview), creation_operation: { key: request_key, request_hash }, accepts: [] };
      return { preview: view(store.commitWorkspaceBatch({ creates: [{ id: randomUUID(), kind: 'plan', title: `Tasks from ${actual.row.title}`.slice(0, 480), data }], updates: [] }).creates[0]) };
    },
    accept(value, raw) {
      object(raw, ['expected_revision', 'preview_hash', 'topic_id', 'task_hash', 'confirmed']); revision(raw.expected_revision); digest(raw.preview_hash); topicId(raw.topic_id); digest(raw.task_hash); if (raw.confirmed !== true) fail('CONSENT_REQUIRED');
      let row = get(value); if (raw.preview_hash !== row.data.preview_hash) fail('REVISION_CONFLICT'); const candidate = row.data.preview.candidates.find(item => item.topic_id === raw.topic_id); if (!candidate) fail('SCOPE_DENIED');
      let old = receipt(row.data.preview.source.plan_id, raw.topic_id);
      if (old) {
        if (old.data.preview_id !== row.id || old.data.task_hash !== raw.task_hash || old.data.candidate_hash !== candidate.candidate_hash || ![row.revision, old.data.review.reviewed_revision].includes(raw.expected_revision)) fail('REVISION_CONFLICT');
        if (old.data.state === 'accepting') return finish(row, old);
        sourceCurrent(row.data.preview.source); return { preview: view(row), receipt: old, task: store.getTask(old.data.task_id) || { id: old.data.task_id, unavailable: true }, replayed: true, task_effects: 0 };
      }
      exact(row, raw); const actual = sourceCurrent(row.data.preview.source), current = actual.candidates.find(item => item.topic_id === candidate.topic_id); if (!current || current.candidate_hash !== candidate.candidate_hash) fail('REVISION_CONFLICT');
      const checked = candidateView(current, actual.source, actual.candidates); if (!checked.selectable || checked.task_hash !== raw.task_hash) fail('REVISION_CONFLICT');
      const data = { format: PLAN_TASK_RECEIPT, owner: store.identity.student_id, state: 'accepting', source: actual.source, topic_id: candidate.topic_id, candidate_hash: candidate.candidate_hash, task_hash: checked.task_hash,
        task: checked.task, dependency_pins: checked.dependency_pins, completed_prerequisites: checked.completed_prerequisites, source_citations: candidate.source_citations, preview_id: row.id, task_id: null,
        review: { reviewer: store.identity.student_id, reviewed_revision: row.revision, preview_hash: row.data.preview_hash, task_hash: raw.task_hash, accepted_at: stamp(), decision: 'accept_one_local_task', mastery_claim: false } }; data.payload_hash = receiptHash(data);
      const previewData = { ...row.data, accepts: [...row.data.accepts, { topic_id: candidate.topic_id, receipt_id: receiptId(identity(actual.source.plan_id, candidate.topic_id)) }] };
      if (Buffer.byteLength(JSON.stringify(previewData)) > PLAN_TASK_LIMITS.record_bytes || Buffer.byteLength(JSON.stringify(data)) > PLAN_TASK_LIMITS.record_bytes) fail('BUDGET_EXCEEDED');
      const saved = store.commitWorkspaceBatch({ creates: [{ id: receiptId(identity(actual.source.plan_id, candidate.topic_id)), kind: 'inbox_item', title: `Reviewed catch-up task: ${candidate.base_task.title}`.slice(0, 480), data }], updates: [{ id: row.id, expected_revision: row.revision, data: previewData }] });
      row = saved.updates[0]; old = saved.creates[0]; return finish(row, old);
    },
    forget(value, raw) { object(raw, ['expected_revision', 'preview_hash']); revision(raw.expected_revision); digest(raw.preview_hash); const row = get(value); exact(row, raw); store.deleteWorkspaceRecord(row.id, row.revision); return { deleted: true, retention: 'Created tasks and independent review/dedup receipts remain. Historical local revisions and backups may retain this preview.' }; },
  };
}

/** Downstream exports/context may verify sourced local task provenance without any writes. */
export function verifyPlanTaskProvenance({ store, getLibrary, taskId }) { return createPlanTaskService({ store, getLibrary }).taskProvenance(taskId); }

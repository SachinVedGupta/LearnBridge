import { createHash } from 'node:crypto';
import { LearnBridgeError } from '@learnbridge/core';
import { prepareTutorSession, recordLearningAttempt, buildCatchUpPlan, TutoringError } from '../../../packages/local-academic/src/tutoring.mjs';

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const fail = code => { throw new LearnBridgeError(code); };
const stale = () => { throw new TutoringError('STALE_EVIDENCE'); };
function object(value, keys, required = []) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) || !('value' in Object.getOwnPropertyDescriptor(value, key))) || required.some(key => !Object.hasOwn(value, key))) fail('INVALID_INPUT');
}
function safeJson(value, maximum = 128000) {
  const ancestors = new Set(); let nodes = 0;
  function walk(item, depth) {
    if (++nodes > 30000 || depth > 18) fail('BUDGET_EXCEEDED');
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return item;
    if (!item || typeof item !== 'object' || ancestors.has(item)) fail('INVALID_INPUT');
    ancestors.add(item); const descriptors = Object.getOwnPropertyDescriptors(item); let result;
    if (Array.isArray(item)) {
      if (item.length > 2000 || Reflect.ownKeys(descriptors).some(key => key !== 'length' && (!/^\d+$/.test(String(key)) || !('value' in descriptors[key]) || !descriptors[key].enumerable))) fail('INVALID_INPUT');
      result = Array.from({ length: item.length }, (_, index) => { if (!Object.hasOwn(descriptors, String(index))) fail('INVALID_INPUT'); return walk(descriptors[index].value, depth + 1); });
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype || Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key) || !('value' in descriptors[key]) || !descriptors[key].enumerable)) fail('INVALID_INPUT');
      result = Object.fromEntries(Object.keys(descriptors).map(key => [key, walk(descriptors[key].value, depth + 1)]));
    }
    ancestors.delete(item); return result;
  }
  const result = walk(value, 0); if (Buffer.byteLength(JSON.stringify(result)) > maximum) fail('BUDGET_EXCEEDED'); return result;
}
function id(value) { if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) fail('INVALID_INPUT'); return value.toLowerCase(); }
function revision(value) { if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_INPUT'); return value; }
function key(value, prefix) { if (value === undefined) return null; if (typeof value !== 'string' || value.length < 8 || value.length > 100 || /[^a-zA-Z0-9._:-]/.test(value)) fail('INVALID_INPUT'); return `${prefix}-${hash(value)}`; }
function scope(value) {
  object(value, ['snapshot_ids', 'course_ids'], ['snapshot_ids', 'course_ids']);
  if (!Array.isArray(value.snapshot_ids) || !value.snapshot_ids.length || value.snapshot_ids.length > 100 || !Array.isArray(value.course_ids) || !value.course_ids.length || value.course_ids.length > 100 || value.course_ids.some(course => typeof course !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(course))) fail('INVALID_INPUT');
  const snapshotIds = value.snapshot_ids.map(id); const courses = [...value.course_ids]; if (new Set(snapshotIds).size !== snapshotIds.length || new Set(courses).size !== courses.length) fail('INVALID_INPUT'); return { snapshot_ids: snapshotIds.sort(), course_ids: courses.sort() };
}
function meta(record, state, extra = {}) { return { id: record.id, kind: record.kind, title: record.title, revision: record.revision, created_at: record.created_at, updated_at: record.updated_at, state, ...extra }; }

/** Paired-human learning persistence. The HTTP host owns authentication and sharing consent. */
export function createLearningService({ store, getLibrary }) {
  if (!store || typeof getLibrary !== 'function') fail('INVALID_INPUT');
  function resetIds() { return new Set(store.listWorkspaceRecords({ kind: 'learning_checkpoint' }).filter(record => record.data.format === 'learning_topic_reset').flatMap(record => record.data.checkpoint_ids)); }
  function requireRecord(recordId, kind) { const record = store.getWorkspaceRecord(id(recordId)); if (!record || record.kind !== kind) fail('SCOPE_DENIED'); return record; }
  function pins(selectedScope) {
    return selectedScope.snapshot_ids.map(recordId => { const record = requireRecord(recordId, 'academic_item'); if (record.data.format !== 'academic_snapshot') fail('SCOPE_DENIED'); return { id: record.id, revision: record.revision, hash: hash(record.data), institution_origin: record.data.snapshot.institution.origin, account_ref: record.data.snapshot.account_ref }; });
  }
  function current(record) {
    const data = record.data; if (data.format !== 'tutoring_session') fail('INVALID_INPUT');
    for (const pin of data.snapshot_pins) { const actual = store.getWorkspaceRecord(pin.id); if (!actual || actual.kind !== 'academic_item' || actual.revision !== pin.revision || hash(actual.data) !== pin.hash) stale(); }
    let library; try { library = getLibrary(data.scope); } catch (error) { if (['SCOPE_DENIED', 'REVISION_CONFLICT', 'INVALID_INPUT'].includes(error.code)) stale(); throw error; }
    const selected = new Map(data.recipe.selected_evidence.map(item => [item.source_id, item]));
    // New same-owner snapshots may invalidate the selected version but never widen model context.
    for (const candidate of store.listWorkspaceRecords({ kind: 'academic_item' })) {
      if (candidate.data.format !== 'academic_snapshot') continue; const snapshot = candidate.data.snapshot;
      if (!data.snapshot_pins.some(pin => pin.institution_origin === snapshot.institution?.origin && pin.account_ref === snapshot.account_ref)) continue;
      for (const row of [...snapshot.assignments, ...snapshot.announcements, ...snapshot.materials]) {
        const old = selected.get(row.id); if (old && snapshot.retrieved_at > old.retrieved_at && row.source_hash !== old.version_hash) stale();
      }
      for (const conflict of snapshot.conflicts || []) if (selected.has(conflict.id) && snapshot.retrieved_at > selected.get(conflict.id).retrieved_at) stale();
    }
    const rebuilt = prepareTutorSession({ library, courseIds: data.scope.course_ids, citations: data.request.citations, topic: data.request.topic, mode: data.request.mode, academicPolicy: data.request.academic_policy, ...(data.request.student_attempt === undefined ? {} : { studentAttempt: data.request.student_attempt }), now: data.recipe.created_at });
    if (rebuilt.session_hash !== data.recipe.session_hash) stale();
    return { record, library };
  }
  function session(recordId) { return current(requireRecord(recordId, 'tutoring_session')); }
  function exact(record, input) { revision(input.expected_revision); if (input.expected_revision !== record.revision || input.session_hash !== record.data.recipe.session_hash) fail('REVISION_CONFLICT'); }
  function replay(kind, retry, requestHash) {
    if (!retry) return null;
    const existing = store.listWorkspaceRecords({ kind }).find(record => record.data.client_request_key === retry);
    if (existing && existing.data.request_hash !== requestHash) fail('REVISION_CONFLICT'); return existing || null;
  }
  return {
    listSessions() {
      return store.listWorkspaceRecords({ kind: 'tutoring_session' }).filter(record => record.data.format === 'tutoring_session').map(record => {
        try { current(record); return meta(record, record.data.recipe.state, { stale: false, topic: record.data.recipe.topic, course_ids: record.data.scope.course_ids, evidence_count: record.data.recipe.selected_evidence.length, mode: record.data.recipe.effective_mode, session_hash: record.data.recipe.session_hash }); }
        catch (error) { if (!['STALE_EVIDENCE', 'SCOPE_DENIED', 'REVISION_CONFLICT'].includes(error.code)) throw error; return meta(record, 'stale', { stale: true, reason: 'Selected source evidence changed or is unavailable. Select sources again.' }); }
      });
    },
    createSession(input, options = {}) {
      input = safeJson(input); object(input, ['scope', 'citations', 'topic', 'mode', 'academic_policy', 'student_attempt'], ['scope', 'citations', 'topic', 'mode', 'academic_policy']); object(options, ['idempotencyKey']);
      const selectedScope = scope(input.scope); const request = { ...input, scope: selectedScope }; const retry = key(options.idempotencyKey, 'learning-session'); const requestHash = hash(request);
      const existing = replay('tutoring_session', retry, requestHash); if (existing) return current(existing).record;
      const snapshotPins = pins(selectedScope); const library = getLibrary(selectedScope);
      const recipe = prepareTutorSession({ library, courseIds: selectedScope.course_ids, citations: input.citations, topic: input.topic, mode: input.mode, academicPolicy: input.academic_policy, ...(input.student_attempt === undefined ? {} : { studentAttempt: input.student_attempt }), now: new Date().toISOString() });
      const data = { format: 'tutoring_session', scope: selectedScope, request, snapshot_pins: snapshotPins, recipe, client_request_key: retry, request_hash: requestHash };
      current({ data }); // No source-stale session is written before this final precondition.
      return store.createWorkspaceRecord({ kind: 'tutoring_session', title: recipe.topic, data }, { ...(retry ? { idempotencyKey: retry } : {}) });
    },
    getSession(recordId) { return session(recordId).record; },
    saveAttempt(recordId, input, options = {}) {
      input = safeJson(input); object(input, ['expected_revision', 'session_hash', 'question', 'student_response', 'feedback', 'assessment', 'reviewed_by_student'], ['expected_revision', 'session_hash', 'question', 'student_response']); object(options, ['idempotencyKey']);
      const { record, library } = session(recordId); exact(record, input); const retry = key(options.idempotencyKey, 'learning-attempt'); const requestHash = hash({ session_id: record.id, ...input });
      const existing = replay('learning_checkpoint', retry, requestHash); if (existing) return existing;
      const checkpoint = recordLearningAttempt({ session: record.data.recipe, library, question: input.question, studentResponse: input.student_response, ...(input.feedback === undefined ? {} : { feedback: input.feedback }), ...(input.assessment === undefined ? {} : { assessment: input.assessment }), ...(input.reviewed_by_student === undefined ? {} : { reviewedByStudent: input.reviewed_by_student }), attemptedAt: new Date().toISOString() });
      return store.createWorkspaceRecord({ kind: 'learning_checkpoint', title: record.title, data: { format: 'learning_checkpoint', session_id: record.id, session_revision: record.revision, checkpoint, client_request_key: retry, request_hash: requestHash, review_receipt: input.reviewed_by_student ? { reviewer: store.identity.student_id, reviewed_at: checkpoint.attempted_at, source: 'paired_local_ui' } : null } }, { ...(retry ? { idempotencyKey: retry } : {}) });
    },
    listCheckpoints() {
      const reset = resetIds();
      return store.listWorkspaceRecords({ kind: 'learning_checkpoint' }).filter(record => record.data.format === 'learning_checkpoint' && !reset.has(record.id)).map(record => {
        try { const parent = session(record.data.session_id).record; if (parent.revision !== record.data.session_revision) stale(); return meta(record, 'recorded', { stale: false, topic: record.data.checkpoint.topic, attempted_at: record.data.checkpoint.attempted_at, assessment: record.data.checkpoint.assessment, session_id: record.data.session_id }); }
        catch (error) { if (!['STALE_EVIDENCE', 'SCOPE_DENIED', 'REVISION_CONFLICT'].includes(error.code)) throw error; return meta(record, 'stale', { stale: true, reason: 'Evidence is unavailable; retained history is not current learning evidence.' }); }
      });
    },
    exportRecipe(recordId, input) {
      input = safeJson(input); object(input, ['expected_revision', 'session_hash'], ['expected_revision', 'session_hash']); const { record } = session(recordId); exact(record, input);
      if (record.data.recipe.state === 'blocked') throw new TutoringError('POLICY_BLOCKED');
      const exported = { format: 'learnbridge-tutor-recipe-export', schema_version: 1, session_id: record.id, session_revision: record.revision, session_hash: record.data.recipe.session_hash, recipe: record.data.recipe };
      const text = JSON.stringify(exported, null, 2); if (Buffer.byteLength(text) > 40000) fail('BUDGET_EXCEEDED'); const created = store.createDocument({ title: `Tutor recipe: ${record.title}`.slice(0, 500), text, kind: 'study', academic_policy: 'learning_support' }, { idempotencyKey: `learning-export-${hash(exported)}` });
      const document = created.document; const saved = store.getDocument(document.id); if (!saved || saved.text !== text) fail('VERSION_MISMATCH');
      return { document, session_id: record.id, session_revision: record.revision, session_hash: record.data.recipe.session_hash, text_sha256: createHash('sha256').update(text).digest('hex'), sharing: 'not_granted', retention: 'This explicitly exported note retains a selected source copy until separately removed; local revision history and backups may also retain it.' };
    },
    previewCatchUp(recordId, input, options = {}) {
      input = safeJson(input); object(input, ['expected_revision', 'session_hash', 'topics', 'selected_topic_ids', 'exam', 'planning_input'], ['expected_revision', 'session_hash', 'topics', 'selected_topic_ids', 'exam', 'planning_input']); object(options, ['idempotencyKey']);
      const { record, library } = session(recordId); exact(record, input); const retry = key(options.idempotencyKey, 'learning-catchup'); const requestHash = hash({ session_id: record.id, ...input });
      const existing = replay('plan', retry, requestHash); if (existing) return existing;
      const plan = buildCatchUpPlan({ session: record.data.recipe, library, topics: input.topics, selectedTopicIds: input.selected_topic_ids, exam: input.exam, planningInput: input.planning_input });
      return store.createWorkspaceRecord({ kind: 'plan', title: `Catch-up: ${input.exam.title}`.slice(0, 500), data: { format: 'learning_catchup', state: 'proposal', session_id: record.id, session_revision: record.revision, catch_up: plan, plan: plan.schedule, request: input, client_request_key: retry, request_hash: requestHash } }, { ...(retry ? { idempotencyKey: retry } : {}) });
    },
    acceptCatchUp(recordId, input) {
      input = safeJson(input); object(input, ['expected_revision', 'plan_hash', 'catch_up_hash'], ['expected_revision', 'plan_hash']);
      const record = requireRecord(recordId, 'plan'); if (record.data.format !== 'learning_catchup') fail('SCOPE_DENIED');
      const source = session(record.data.session_id); if (source.record.revision !== record.data.session_revision) stale();
      const plan = record.data.catch_up;
      if (input.plan_hash !== plan.schedule.plan_hash || (input.catch_up_hash !== undefined && input.catch_up_hash !== plan.catch_up_hash) || hash(record.data.plan) !== hash(plan.schedule)) fail('REVISION_CONFLICT');
      const original = record.data.request;
      if (!original) fail('VERSION_MISMATCH');
      const recomputed = buildCatchUpPlan({ session: source.record.data.recipe, library: source.library, topics: original.topics, selectedTopicIds: original.selected_topic_ids, exam: original.exam, planningInput: original.planning_input });
      if (recomputed.catch_up_hash !== plan.catch_up_hash || recomputed.schedule.plan_hash !== input.plan_hash) stale();
      revision(input.expected_revision);
      if (record.data.state === 'accepted' && [record.revision, record.revision - 1].includes(input.expected_revision) && record.data.review_receipt?.catch_up_hash === plan.catch_up_hash) return record;
      if (record.data.state !== 'proposal' || record.revision !== input.expected_revision) fail('REVISION_CONFLICT');
      return store.updateWorkspaceRecord(record.id, { expected_revision: record.revision, data: { ...record.data, state: 'accepted', review_receipt: { reviewer: store.identity.student_id, source: 'paired_local_ui', accepted_at: new Date().toISOString(), catch_up_hash: plan.catch_up_hash, plan_hash: plan.schedule.plan_hash, effects: { task_writes: 0, calendar_writes: 0 } } } });
    },
    forgetSession(recordId, expectedRevision) { requireRecord(recordId, 'tutoring_session'); return store.deleteWorkspaceRecord(recordId, revision(expectedRevision)); },
    resetTopic(topic, input) {
      input = safeJson(input);
      if (typeof topic !== 'string' || !topic.trim() || topic.length > 500) fail('INVALID_INPUT'); object(input, ['expected_revisions'], ['expected_revisions']);
      if (!Array.isArray(input.expected_revisions) || input.expected_revisions.length > 100) fail('INVALID_INPUT');
      const reset = resetIds(); const records = store.listWorkspaceRecords({ kind: 'learning_checkpoint' }).filter(record => record.data.format === 'learning_checkpoint' && record.data.checkpoint.topic === topic && !reset.has(record.id));
      const expected = input.expected_revisions.map(row => { object(row, ['id', 'revision'], ['id', 'revision']); return { id: id(row.id), revision: revision(row.revision) }; });
      if (new Set(expected.map(row => row.id)).size !== expected.length) fail('REVISION_CONFLICT');
      expected.sort((a, b) => a.id.localeCompare(b.id)); const resetHash = hash({ topic, expected_revisions: expected });
      const previous = store.listWorkspaceRecords({ kind: 'learning_checkpoint' }).find(record => record.data.format === 'learning_topic_reset' && record.data.reset_hash === resetHash);
      if (previous) return { deleted_count: previous.data.checkpoint_ids.length, retention: 'Reset removes these checkpoints from active learning views; their private history and backups are retained.' };
      if (expected.length !== records.length || records.some(record => expected.find(row => row.id === record.id)?.revision !== record.revision)) fail('REVISION_CONFLICT');
      // One atomic reset marker avoids a half-reset on a multi-record storage failure.
      if (records.length) store.createWorkspaceRecord({ kind: 'learning_checkpoint', title: `Reset: ${topic}`.slice(0, 500), data: { format: 'learning_topic_reset', topic, checkpoint_ids: expected.map(row => row.id), expected_revisions: expected, reset_hash: resetHash, reviewer: store.identity.student_id, reset_at: new Date().toISOString() } }, { idempotencyKey: `learning-reset-${resetHash}` });
      return { deleted_count: records.length, retention: 'Reset removes these checkpoints from active learning views; their private history and backups are retained. Physical erasure is not implemented.' };
    },
  };
}

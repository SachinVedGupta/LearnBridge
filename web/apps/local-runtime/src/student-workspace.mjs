import { LearnBridgeError } from '@learnbridge/core';
import { buildAcademicLibrary, searchAcademicLibrary, resolveAcademicCitation } from '../../../packages/local-academic/src/library.mjs';
import { planStudyWork, rankToday } from '../../../packages/local-academic/src/planning.mjs';
import { createWorkflowRunner, workflowHash } from './workflows.mjs';
import { profileCandidate, profileView, reviewProfileFact, profileContext } from './profile.mjs';
import { createLearningService } from './learning-service.mjs';

const fail = code => { throw new LearnBridgeError(code); };
function object(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key => !keys.includes(key))) fail('INVALID_INPUT');
}
function selected(values, max = 100) {
  if (!Array.isArray(values) || !values.length || values.length > max || values.some(value => typeof value !== 'string') || new Set(values).size !== values.length) fail('INVALID_INPUT');
  return values;
}
export function createStudentWorkspace(store) {
  const evidence = id => store.getDocument(id);
  const tasks = () => store.listTasks();
  const pin = (kind, record) => ({ kind, id: record.id, revision: record.revision, version_hash: workflowHash(record) });
  const resolvePin = value => {
    const record = value.kind === 'task' ? store.getTask(value.id) : value.kind === 'workspace_record' ? store.getWorkspaceRecord(value.id) : null;
    return record ? { revision: record.revision, version_hash: workflowHash(record) } : null;
  };
  const runner = createWorkflowRunner({ store, resolvePin, recipes: {
    'plan.today': {
      version: '1', budget: { tool_calls: 10, model_calls: 0, bytes: 256000, max_duration_ms: 300000 },
      validate(input) {
        object(input, ['availability', 'busy', 'pinnedBlocks', 'timezone', 'now', 'horizonEnd', 'maxDailyMinutes', 'bufferMinutes', 'minBlockMinutes']);
        // Domain validation occurs before any durable run/effect is created.
        planStudyWork({ ...input, tasks: tasks() }); return structuredClone(input);
      },
      pins: () => tasks().map(task => pin('task', task)),
      steps: [
        { key: 'allocate', kind: 'read', verification_method: 'planner_recomputation.v1',
          execute: ({ input }) => planStudyWork({ ...input, tasks: tasks() }),
          verify: ({ input }) => planStudyWork({ ...input, tasks: tasks() }) },
        { key: 'save_preview', kind: 'local_write', idempotent: true, verification_method: 'sqlite_plan_readback.v1',
          execute: ({ results, run_id }) => store.createWorkspaceRecord({ kind: 'plan', title: 'Study plan preview',
            data: { state: 'proposal', run_id, plan: results.allocate } }, { idempotencyKey: `plan-${run_id}` }),
          verify: ({ result }) => store.getWorkspaceRecord(result.id) },
      ],
    },
  } });
  function snapshotRecords(ids) {
    return selected(ids).map(id => {
      const record = store.getWorkspaceRecord(id);
      if (!record || record.kind !== 'academic_item' || record.data.format !== 'academic_snapshot') fail('SCOPE_DENIED');
      return record;
    });
  }
  function library(input) {
    object(input, ['snapshot_ids', 'course_ids']);
    const snapshots = snapshotRecords(input.snapshot_ids).map(record => record.data.snapshot);
    const courses = selected(input.course_ids);
    if (courses.some(course => !snapshots.some(snapshot => snapshot.selected_course_ids.includes(course)))) fail('SCOPE_DENIED');
    return buildAcademicLibrary({ snapshots, selectedCourseIds: courses });
  }
  return {
    runner,
    library,
    today: () => rankToday({ tasks: tasks(), timezone: store.identity.timezone, now: new Date().toISOString() }),
    listProfiles: () => profileView(store.listWorkspaceRecords({ kind: 'profile_fact' }), { resolveEvidence: evidence }),
    createProfile(input, options) {
      const fact = profileCandidate(input, { resolveEvidence: evidence });
      return store.createWorkspaceRecord({ kind: 'profile_fact', title: fact.field.replaceAll('_', ' '), data: fact }, options);
    },
    reviewProfile(id, input) {
      object(input, ['expected_revision', 'decision', 'fingerprint', 'value']);
      const record = store.getWorkspaceRecord(id); if (!record || record.kind !== 'profile_fact') fail('SCOPE_DENIED');
      const { expected_revision, ...review } = input;
      if (review.decision === 'confirm' && profileView([record], { resolveEvidence: evidence })[0].stale) fail('REVISION_CONFLICT');
      return store.updateWorkspaceRecord(id, { expected_revision, data: reviewProfileFact(record.data, review, { reviewer: store.identity.student_id }) });
    },
    forgetProfile(id, expectedRevision) {
      const record = store.getWorkspaceRecord(id); if (!record || record.kind !== 'profile_fact') fail('SCOPE_DENIED');
      return store.deleteWorkspaceRecord(id, expectedRevision);
    },
    profileContext(input) {
      object(input, ['purpose', 'allowed_ids']);
      return profileContext(store.listWorkspaceRecords({ kind: 'profile_fact' }), { purpose: input.purpose,
        allowedIds: input.allowed_ids, resolveEvidence: evidence });
    },
    exportProfile(input) {
      object(input, ['purpose', 'allowed_ids', 'context_hash']);
      const items = profileContext(store.listWorkspaceRecords({ kind: 'profile_fact' }), { purpose: input.purpose,
        allowedIds: input.allowed_ids, resolveEvidence: evidence });
      const context = { purpose: input.purpose, items };
      if (!items.length || input.context_hash !== workflowHash(context)) fail('REVISION_CONFLICT');
      const text = JSON.stringify({ format: 'learnbridge-reviewed-profile', schema_version: 1, ...context,
        context_hash: input.context_hash, instructions: 'Use only for the stated purpose. These are reviewed student statements at the listed revisions, not independently verified claims. This explicitly saved copy does not update automatically. Follow the selected host and LearnBridge academic and action-review instructions.' }, null, 2);
      const saved = store.createDocument({ title: `Reviewed ${input.purpose} profile`, text, kind: 'note' },
        { idempotencyKey: `profile-${input.context_hash}` });
      const actual = store.getDocument(saved.document.id);
      if (!actual || actual.text !== text || actual.sha256 !== saved.sha256) fail('VERSION_MISMATCH');
      return { document: actual.document, sha256: actual.sha256, context_hash: input.context_hash, sharing: 'not_granted',
        retention: 'This explicitly exported note retains a profile copy until separately removed. Local revisions and backups may retain it.' };
    },
    listSnapshots: () => store.listWorkspaceRecords({ kind: 'academic_item' }).filter(record => record.data.format === 'academic_snapshot'),
    saveSnapshot(snapshot, key) {
      buildAcademicLibrary({ snapshots: [snapshot], selectedCourseIds: snapshot.selected_course_ids });
      if (Buffer.byteLength(JSON.stringify(snapshot)) > 100000) fail('BUDGET_EXCEEDED');
      return store.createWorkspaceRecord({ kind: 'academic_item', title: `${snapshot.institution.name} course snapshot`,
        data: { format: 'academic_snapshot', snapshot } }, { idempotencyKey: key });
    },
    forgetSnapshot(id, expectedRevision) {
      const record = store.getWorkspaceRecord(id); if (!record || record.kind !== 'academic_item') fail('SCOPE_DENIED');
      return store.deleteWorkspaceRecord(id, expectedRevision);
    },
    search(input) {
      object(input, ['snapshot_ids', 'course_ids', 'query', 'limit']);
      const { query, limit, ...scope } = input;
      return searchAcademicLibrary(library(scope), { query, courseIds: scope.course_ids, ...(limit === undefined ? {} : { limit }) });
    },
    citation(input) {
      object(input, ['snapshot_ids', 'course_ids', 'source_id', 'version_hash', 'chunk_id']);
      const { snapshot_ids, course_ids, ...reference } = input;
      return resolveAcademicCitation(library({ snapshot_ids, course_ids }), { ...reference, courseIds: course_ids });
    },
    listPlans: () => store.listWorkspaceRecords({ kind: 'plan' }),
    acceptPlan(id, input) {
      object(input, ['expected_revision', 'plan_hash']);
      if (store.getWorkspaceRecord(id)?.data.format === 'learning_catchup') {
        return createLearningService({ store, getLibrary: library }).acceptCatchUp(id, input);
      }
      const record = store.getWorkspaceRecord(id); if (!record || record.kind !== 'plan' || input.plan_hash !== record.data.plan.plan_hash) fail('REVISION_CONFLICT');
      if (record.data.state === 'accepted' && [record.revision, record.revision - 1].includes(input.expected_revision)) return record;
      const current = tasks();
      if (record.data.plan.task_versions.some(version => current.find(task => task.id === version.id)?.revision !== version.revision)
        || current.some(task => !record.data.plan.task_versions.some(version => version.id === task.id))) fail('REVISION_CONFLICT');
      return store.updateWorkspaceRecord(id, { expected_revision: input.expected_revision,
        data: { ...record.data, state: 'accepted', accepted_at: new Date().toISOString(), reviewer: store.identity.student_id } });
    },
  };
}

import { LearnBridgeError } from '@learnbridge/core';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeAcademicExport } from '../../../packages/local-academic/src/index.mjs';
import { academicRefreshScope, academicStreamKey, academicSemanticHash, academicRefreshPreview, validateAcademicRefreshPreview } from '../../../packages/local-academic/src/refresh.mjs';
import { buildAcademicLibrary, searchAcademicLibrary, resolveAcademicCitation } from '../../../packages/local-academic/src/library.mjs';
import { planStudyWork, rankToday } from '../../../packages/local-academic/src/planning.mjs';
import { createWorkflowRunner, workflowHash } from './workflows.mjs';
import { profileCandidate, profileView, reviewProfileFact, profileContext } from './profile.mjs';
import { createLearningService } from './learning-service.mjs';

const fail = code => { throw new LearnBridgeError(code); };
const ACADEMIC_HISTORY_LIMIT = 128;
const ACADEMIC_RECEIPT_LIMIT = 128;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function academicHeadId(studentId, streamKey) {
  const hex = createHash('sha256').update(`learnbridge.academic.stream.v1\0${studentId}\0${streamKey}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function object(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail('INVALID_INPUT');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key)
    || !('value' in descriptors[key]) || !descriptors[key].enumerable)) fail('INVALID_INPUT');
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
  function academicRecords() { return store.listWorkspaceRecords({ kind: 'academic_item' }); }
  function checkedSnapshot(record) {
    if (!record || record.kind !== 'academic_item' || record.data.format !== 'academic_snapshot' || record.revision !== 1) fail('SCOPE_DENIED');
    const snapshot = record.data.snapshot;
    buildAcademicLibrary({ snapshots: [snapshot], selectedCourseIds: snapshot.selected_course_ids });
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 100000) fail('BUDGET_EXCEEDED');
    const key = academicStreamKey(snapshot); const semantic = academicSemanticHash(snapshot);
    if (record.data.stream_key !== undefined && (record.data.stream_key !== key || record.data.semantic_hash !== semantic)) fail('VERSION_MISMATCH');
    return record;
  }
  function checkedHead(record, key) {
    if (!record || record.kind !== 'academic_item' || record.data.format !== 'academic_stream') fail('VERSION_MISMATCH');
    const data = record.data;
    object(data, ['format', 'schema_version', 'stream_key', 'scope', 'state', 'current_snapshot_id', 'current_snapshot_hash', 'current_semantic_hash', 'history', 'receipts', 'last_observation']);
    if (data.schema_version !== 1 || !digest(data.stream_key) || data.stream_key !== key
      || record.id !== academicHeadId(store.identity.student_id, key) || !['active', 'forgotten'].includes(data.state)
      || !Array.isArray(data.history) || !data.history.length || data.history.length > ACADEMIC_HISTORY_LIMIT
      || !Array.isArray(data.receipts) || !data.receipts.length || data.receipts.length > ACADEMIC_RECEIPT_LIMIT) fail('VERSION_MISMATCH');
    const ids = new Set();
    for (const item of data.history) {
      object(item, ['snapshot_id', 'snapshot_hash', 'semantic_hash', 'accepted_at', 'origin']);
      if (!uuid(item.snapshot_id) || ids.has(item.snapshot_id) || !digest(item.snapshot_hash) || !digest(item.semantic_hash)
        || !instant(item.accepted_at) || !['managed', 'legacy'].includes(item.origin)) fail('VERSION_MISMATCH'); ids.add(item.snapshot_id);
    }
    const current = data.history.find(item => item.snapshot_id === data.current_snapshot_id);
    if (!current || current.snapshot_hash !== data.current_snapshot_hash || current.semantic_hash !== data.current_semantic_hash) fail('VERSION_MISMATCH');
    const keys = new Set();
    for (const receipt of data.receipts) {
      object(receipt, ['idempotency_key', 'review_hash', 'reviewed_snapshot_hash', 'base', 'snapshot_id', 'snapshot_hash', 'semantic_hash', 'content_changed', 'changes_hash', 'change_counts', 'reported_retrieved_at', 'accepted_at', 'status', 'verification']);
      if (typeof receipt.idempotency_key !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(receipt.idempotency_key) || keys.has(receipt.idempotency_key)
        || !digest(receipt.review_hash) || !digest(receipt.reviewed_snapshot_hash) || !digest(receipt.changes_hash) || !digest(receipt.snapshot_hash) || !digest(receipt.semantic_hash)
        || !ids.has(receipt.snapshot_id) || typeof receipt.content_changed !== 'boolean' || !instant(receipt.reported_retrieved_at)
        || !instant(receipt.accepted_at) || !['imported', 'updated', 'unchanged'].includes(receipt.status) || receipt.verification !== 'atomic_private_snapshot_head_readback') fail('VERSION_MISMATCH');
      object(receipt.base, ['head_id', 'revision', 'current_snapshot_id', 'snapshot_hash', 'semantic_hash']);
      if (!Number.isSafeInteger(receipt.base.revision) || receipt.base.revision < 0
        || (receipt.base.head_id !== null && !uuid(receipt.base.head_id))
        || (receipt.base.current_snapshot_id !== null && !ids.has(receipt.base.current_snapshot_id))
        || (receipt.base.snapshot_hash !== null && !digest(receipt.base.snapshot_hash))
        || (receipt.base.semantic_hash !== null && !digest(receipt.base.semantic_hash))) fail('VERSION_MISMATCH');
      object(receipt.change_counts, ['added', 'changed', 'unchanged', 'not_returned', 'conflicted']);
      if (Object.values(receipt.change_counts).some(value => !Number.isSafeInteger(value) || value < 0 || value > 8100)) fail('VERSION_MISMATCH');
      keys.add(receipt.idempotency_key);
    }
    object(data.last_observation, ['reported_retrieved_at', 'accepted_at', 'coverage_claim']);
    if (!instant(data.last_observation.reported_retrieved_at) || !instant(data.last_observation.accepted_at)
      || data.last_observation.coverage_claim !== 'source_reported') fail('VERSION_MISMATCH');
    const saved = checkedSnapshot(store.getWorkspaceRecord(current.snapshot_id));
    if (saved.data.snapshot.snapshot_hash !== current.snapshot_hash || academicStreamKey(saved.data.snapshot) !== key
      || academicSemanticHash(saved.data.snapshot) !== current.semantic_hash
      || workflowHash(academicRefreshScope(saved.data.snapshot)) !== workflowHash(data.scope)) fail('VERSION_MISMATCH');
    return record;
  }
  function headForKey(key) {
    const record = store.getWorkspaceRecord(academicHeadId(store.identity.student_id, key));
    return record ? checkedHead(record, key) : null;
  }
  function legacyForKey(key) {
    return academicRecords().filter(record => record.data.format === 'academic_snapshot' && record.data.stream_key === undefined)
      .map(checkedSnapshot).filter(record => academicStreamKey(record.data.snapshot) === key);
  }
  function newestLegacy(records) {
    if (!records.length) return null;
    const latest = records.reduce((date, item) => date > item.data.snapshot.retrieved_at ? date : item.data.snapshot.retrieved_at, '');
    const candidates = records.filter(item => item.data.snapshot.retrieved_at === latest);
    if (new Set(candidates.map(item => academicSemanticHash(item.data.snapshot))).size > 1) fail('INVALID_INPUT');
    // Equivalent observations may choose a stable retained receipt; UUID order
    // never chooses authority between different source contents.
    return candidates.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))[0];
  }
  function baselineFor(snapshot) {
    const key = academicStreamKey(snapshot); const head = headForKey(key);
    const record = head ? checkedSnapshot(store.getWorkspaceRecord(head.data.current_snapshot_id)) : newestLegacy(legacyForKey(key));
    return record ? { stream_key: key, head_id: head?.id ?? null, revision: head?.revision ?? 0,
      current_snapshot_id: record.id, current_snapshot_hash: record.data.snapshot.snapshot_hash,
      current_semantic_hash: academicSemanticHash(record.data.snapshot), snapshot: record.data.snapshot } : null;
  }
  function streamMetadata(head) {
    const data = head.data;
    return { id: head.id, revision: head.revision, stream_key: data.stream_key, scope: data.scope, state: data.state,
      current_snapshot_id: data.current_snapshot_id, snapshot_hash: data.current_snapshot_hash, semantic_hash: data.current_semantic_hash,
      snapshot_count: data.history.length, observation_count: data.receipts.length, last_observation: data.last_observation,
      source: 'student_selected_export', coverage_claim: 'source_reported', history_limit: ACADEMIC_HISTORY_LIMIT, observation_limit: ACADEMIC_RECEIPT_LIMIT };
  }
  function currentSnapshot(record) {
    const saved = checkedSnapshot(record); const key = academicStreamKey(saved.data.snapshot); const head = headForKey(key);
    if (head) {
      if (head.data.state !== 'active' || head.data.current_snapshot_id !== saved.id) fail('SCOPE_DENIED');
      return { ...saved, stream_id: head.id, stream_revision: head.revision, semantic_hash: head.data.current_semantic_hash };
    }
    if (saved.data.stream_key !== undefined || newestLegacy(legacyForKey(key))?.id !== saved.id) fail('SCOPE_DENIED');
    return saved;
  }
  function prepareAcademic(snapshot) {
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 100000) fail('BUDGET_EXCEEDED');
    const head = headForKey(academicStreamKey(snapshot));
    if (head && (snapshot.retrieved_at < head.data.last_observation.reported_retrieved_at
      || (snapshot.retrieved_at === head.data.last_observation.reported_retrieved_at && academicSemanticHash(snapshot) !== head.data.current_semantic_hash))) fail('INVALID_INPUT');
    return academicRefreshPreview(snapshot, { baseline: baselineFor(snapshot) });
  }
  function commitAcademicRefresh(rawPreview, input) {
    object(input, ['review_hash', 'expected_head_revision', 'idempotency_key']);
    if (!digest(input.review_hash) || !Number.isSafeInteger(input.expected_head_revision) || input.expected_head_revision < 0
      || typeof input.idempotency_key !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(input.idempotency_key)) fail('INVALID_INPUT');
    // Clone and validate before reading properties: no accessor, cyclic or
    // unbounded caller input is evaluated as a reviewed academic payload.
    object(rawPreview, ['format', 'schema_version', 'stream_key', 'scope', 'base', 'snapshot', 'semantic_hash', 'content_changed', 'changes', 'review_hash']);
    object(rawPreview.base, ['head_id', 'revision', 'current_snapshot_id', 'snapshot_hash', 'semantic_hash']);
    const previewSnapshot = academicRefreshScope(rawPreview.snapshot);
    const key = academicStreamKey(rawPreview.snapshot); let head = headForKey(key);
    const storedReceipt = head?.data.receipts.find(receipt => receipt.idempotency_key === input.idempotency_key);
    let baseline = null;
    if (rawPreview.base.current_snapshot_id !== null) {
      const record = checkedSnapshot(store.getWorkspaceRecord(rawPreview.base.current_snapshot_id));
      baseline = { stream_key: key, head_id: rawPreview.base.head_id, revision: rawPreview.base.revision,
        current_snapshot_id: record.id, current_snapshot_hash: record.data.snapshot.snapshot_hash,
        current_semantic_hash: academicSemanticHash(record.data.snapshot), snapshot: record.data.snapshot };
    }
    const preview = validateAcademicRefreshPreview(rawPreview, { baseline });
    if (preview.review_hash !== input.review_hash || preview.base.revision !== input.expected_head_revision
      || workflowHash(preview.scope) !== workflowHash(previewSnapshot)) fail('REVISION_CONFLICT');
    if (storedReceipt) {
      if (head.data.state !== 'active' || storedReceipt.review_hash !== preview.review_hash
        || workflowHash(storedReceipt.base) !== workflowHash(preview.base)) fail('REVISION_CONFLICT');
      const snapshot = checkedSnapshot(store.getWorkspaceRecord(storedReceipt.snapshot_id));
      if (snapshot.data.snapshot.snapshot_hash !== storedReceipt.snapshot_hash) fail('VERSION_MISMATCH');
      return { snapshot, stream: streamMetadata(head), receipt: storedReceipt, status: 'replayed' };
    }
    const actual = baselineFor(preview.snapshot);
    const actualBase = actual ? { head_id: actual.head_id, revision: actual.revision, current_snapshot_id: actual.current_snapshot_id,
      snapshot_hash: actual.current_snapshot_hash, semantic_hash: actual.current_semantic_hash } :
      { head_id: null, revision: 0, current_snapshot_id: null, snapshot_hash: null, semantic_hash: null };
    if (workflowHash(preview.base) !== workflowHash(actualBase)) fail('REVISION_CONFLICT');
    if (head && (preview.snapshot.retrieved_at < head.data.last_observation.reported_retrieved_at
      || (preview.snapshot.retrieved_at === head.data.last_observation.reported_retrieved_at && preview.semantic_hash !== head.data.current_semantic_hash))) fail('INVALID_INPUT');
    const timestamp = new Date().toISOString(); const history = head ? [...head.data.history] : legacyForKey(key).map(record => ({
      snapshot_id: record.id, snapshot_hash: record.data.snapshot.snapshot_hash, semantic_hash: academicSemanticHash(record.data.snapshot), accepted_at: record.created_at, origin: 'legacy' }));
    const receipts = head ? [...head.data.receipts] : [];
    const changed = preview.content_changed || !actual;
    const snapshotId = changed ? randomUUID() : actual.current_snapshot_id;
    if (changed) history.push({ snapshot_id: snapshotId, snapshot_hash: preview.snapshot.snapshot_hash,
      semantic_hash: preview.semantic_hash, accepted_at: timestamp, origin: 'managed' });
    if (history.length > ACADEMIC_HISTORY_LIMIT || receipts.length >= ACADEMIC_RECEIPT_LIMIT) fail('BUDGET_EXCEEDED');
    const savedSnapshotHash = changed ? preview.snapshot.snapshot_hash : actual.current_snapshot_hash;
    const status = !actual ? 'imported' : changed ? 'updated' : 'unchanged';
    const receipt = { idempotency_key: input.idempotency_key, review_hash: preview.review_hash, reviewed_snapshot_hash: preview.snapshot.snapshot_hash, base: preview.base,
      snapshot_id: snapshotId, snapshot_hash: savedSnapshotHash, semantic_hash: preview.semantic_hash, content_changed: changed,
      changes_hash: workflowHash(preview.changes), change_counts: Object.fromEntries(Object.entries(preview.changes).map(([name, values]) => [name, values.length])),
      reported_retrieved_at: preview.snapshot.retrieved_at, accepted_at: timestamp, status, verification: 'atomic_private_snapshot_head_readback' };
    receipts.push(receipt);
    const data = { format: 'academic_stream', schema_version: 1, stream_key: key, scope: preview.scope, state: 'active',
      current_snapshot_id: snapshotId, current_snapshot_hash: savedSnapshotHash, current_semantic_hash: preview.semantic_hash,
      history, receipts, last_observation: { reported_retrieved_at: preview.snapshot.retrieved_at, accepted_at: timestamp, coverage_claim: 'source_reported' } };
    if (Buffer.byteLength(JSON.stringify(data)) > 128000) fail('BUDGET_EXCEEDED');
    const headId = academicHeadId(store.identity.student_id, key);
    const creates = changed ? [{ id: snapshotId, kind: 'academic_item', title: `${preview.snapshot.institution.name} course snapshot`,
      data: { format: 'academic_snapshot', snapshot: preview.snapshot, stream_key: key, semantic_hash: preview.semantic_hash } }] : [];
    if (!head) creates.push({ id: headId, kind: 'academic_item', title: `${preview.snapshot.institution.name} course refresh history`, data });
    const batch = store.commitWorkspaceBatch({ creates, updates: head ? [{ id: head.id, expected_revision: head.revision, data }] : [] });
    head = checkedHead((batch.updates[0] || batch.creates.find(record => record.id === headId)), key);
    const saved = checkedSnapshot(store.getWorkspaceRecord(snapshotId));
    if (saved.data.snapshot.snapshot_hash !== savedSnapshotHash || head.data.receipts.at(-1).review_hash !== preview.review_hash) fail('VERSION_MISMATCH');
    return { snapshot: { ...saved, stream_id: head.id, stream_revision: head.revision, semantic_hash: preview.semantic_hash }, stream: streamMetadata(head), receipt, status };
  }
  function snapshotRecords(ids) {
    return selected(ids).map(id => {
      return currentSnapshot(store.getWorkspaceRecord(id));
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
    previewAcademicExport(input) {
      object(input, ['export', 'selected_course_ids']); selected(input.selected_course_ids);
      const initial = normalizeAcademicExport(input.export, { selectedCourseIds: input.selected_course_ids });
      const baseline = baselineFor(initial);
      const snapshot = baseline ? normalizeAcademicExport(input.export, { selectedCourseIds: input.selected_course_ids, previous: baseline.snapshot }) : initial;
      return prepareAcademic(snapshot);
    },
    commitAcademicRefresh,
    listAcademicStreams: () => academicRecords().filter(record => record.data.format === 'academic_stream' && record.data.state === 'active')
      .map(record => streamMetadata(checkedHead(record, record.data.stream_key))),
    academicStreamHistory(streamId) {
      const raw = store.getWorkspaceRecord(streamId); if (!raw || raw.data.format !== 'academic_stream') fail('SCOPE_DENIED');
      const head = checkedHead(raw, raw.data.stream_key); if (head.data.state !== 'active') fail('CONSENT_REQUIRED');
      return { stream: streamMetadata(head), items: head.data.history.map(ref => {
        const record = checkedSnapshot(store.getWorkspaceRecord(ref.snapshot_id));
        if (record.data.snapshot.snapshot_hash !== ref.snapshot_hash || academicSemanticHash(record.data.snapshot) !== ref.semantic_hash
          || academicStreamKey(record.data.snapshot) !== head.data.stream_key) fail('VERSION_MISMATCH');
        return { id: record.id, revision: record.revision, title: record.title,
          snapshot_hash: ref.snapshot_hash, semantic_hash: ref.semantic_hash, accepted_at: ref.accepted_at,
          retrieved_at: record.data.snapshot.retrieved_at, selected_course_ids: record.data.snapshot.selected_course_ids,
          counts: Object.fromEntries(['courses', 'assignments', 'announcements', 'materials'].map(category => [category, record.data.snapshot[category].length])),
          coverage: Object.fromEntries(['courses', 'assignments', 'announcements', 'materials'].map(category => [category, { state: record.data.snapshot.coverage[category].state, coverage_claim: 'source_reported' }])),
          status: ref.snapshot_id === head.data.current_snapshot_id ? 'current' : 'historical', origin: ref.origin };
      }), observations: head.data.receipts, notice: 'Retained exports are source-reported observations. Missing items are not deleted facts. Historical snapshots are excluded from current search and tutoring.' };
    },
    academicHistorySnapshot(streamId, snapshotId) {
      const history = this.academicStreamHistory(streamId); const metadata = history.items.find(item => item.id === snapshotId);
      if (!metadata) fail('SCOPE_DENIED');
      const record = checkedSnapshot(store.getWorkspaceRecord(snapshotId));
      return { stream: history.stream, item: { ...metadata, snapshot: record.data.snapshot },
        notice: metadata.status === 'historical' ? 'This retained export is historical and is excluded from current search and tutoring.' : 'This is the current saved export. Its retrieval time and coverage are source-reported.' };
    },
    listSnapshots() {
      const records = academicRecords().filter(record => record.data.format === 'academic_snapshot');
      const result = []; const visited = new Set();
      for (const record of records) { const saved = checkedSnapshot(record); const key = academicStreamKey(saved.data.snapshot);
        if (visited.has(key)) continue; visited.add(key); const head = headForKey(key);
        if (head) { if (head.data.state === 'active') result.push(currentSnapshot(store.getWorkspaceRecord(head.data.current_snapshot_id))); }
        else { const latest = newestLegacy(legacyForKey(key)); if (latest) result.push(latest); }
      }
      return result;
    },
    saveSnapshot(snapshot, key) {
      const head = headForKey(academicStreamKey(snapshot));
      const receipt = head?.data.receipts.find(item => item.idempotency_key === key);
      if (receipt) {
        if (head.data.state !== 'active' || receipt.reviewed_snapshot_hash !== snapshot.snapshot_hash) fail('REVISION_CONFLICT');
        // A retry returns its original immutable artifact even after a newer
        // refresh. Current retrieval still independently rejects old IDs.
        return checkedSnapshot(store.getWorkspaceRecord(receipt.snapshot_id));
      }
      const preview = prepareAcademic(snapshot);
      return commitAcademicRefresh(preview, { review_hash: preview.review_hash, expected_head_revision: preview.base.revision, idempotency_key: key }).snapshot;
    },
    forgetSnapshot(id, expectedRevision, input = {}) {
      object(input, ['expected_stream_revision']); const record = currentSnapshot(store.getWorkspaceRecord(id));
      if (record.revision !== expectedRevision) fail('REVISION_CONFLICT');
      if (record.stream_id) {
        if (input.expected_stream_revision !== record.stream_revision) fail('REVISION_CONFLICT');
        const head = headForKey(academicStreamKey(record.data.snapshot));
        return store.updateWorkspaceRecord(head.id, { expected_revision: head.revision, data: { ...head.data, state: 'forgotten' } });
      }
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

import { LearnBridgeError } from '@learnbridge/core';
import { lifeHash } from './life.mjs';
import { profileView } from './profile.mjs';

const CATEGORIES = Object.freeze(['profile', 'local_files', 'academic_exports', 'agent_bridge']);
const PURPOSES = Object.freeze(['general', 'learning', 'career', 'meals', 'budget']);
const ARRAY_FIELDS = Object.freeze(['profile_ids', 'source_entry_ids', 'snapshot_ids', 'document_ids', 'agent_grant_ids']);
const SELECTION_KEYS = ['purpose', 'requested', ...ARRAY_FIELDS, 'destination'];
const PREVIEW_KEYS = ['format', 'schema_version', 'selection', 'observed_at', 'pins', 'coverage', 'overall', 'review_hash'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const CATALOGUE_LIMIT = 200;
const ACTIVE_REPORT_LIMIT = 128;
const REPORT_BYTES = 128000;
const fail = (code = 'INVALID_INPUT') => { throw new LearnBridgeError(code); };

/** Copy before property reads. No accessors, symbols, sparse arrays or inherited data. */
function clone(input, maxBytes = 64000) {
  let nodes = 0; const visiting = new Set();
  function visit(value, depth) {
    if (++nodes > 10000 || depth > 12) fail();
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail(); return value; }
    if (typeof value === 'string') { if (value.includes('\0') || Buffer.byteLength(value) > maxBytes) fail(); return value; }
    if (!value || typeof value !== 'object' || visiting.has(value)) fail();
    visiting.add(value); const descriptors = Object.getOwnPropertyDescriptors(value); let result;
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 1000 || Reflect.ownKeys(value).length !== value.length + 1) fail();
      result = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[index]; if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail();
        result.push(visit(descriptor.value, depth + 1));
      }
    } else {
      if (Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some(key => typeof key !== 'string'
        || ['__proto__', 'prototype', 'constructor'].includes(key) || !('value' in descriptors[key]) || !descriptors[key].enumerable)) fail();
      result = Object.fromEntries(Object.keys(descriptors).map(key => [key, visit(descriptors[key].value, depth + 1)]));
    }
    visiting.delete(value); return result;
  }
  const result = visit(input, 0); if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) fail('BUDGET_EXCEEDED'); return result;
}
function object(value, allowed, required = allowed) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !allowed.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) fail();
}
function stamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(); return value;
}
function checkedId(value) { if (typeof value !== 'string' || !UUID.test(value)) fail(); return value.toLowerCase(); }
function selection(input) {
  const value = clone(input, 12000); object(value, SELECTION_KEYS, ['purpose', 'requested']);
  if (!PURPOSES.includes(value.purpose) || !Array.isArray(value.requested) || value.requested.length > 4
    || new Set(value.requested).size !== value.requested.length || value.requested.some(category => !CATEGORIES.includes(category))) fail();
  const result = { purpose: value.purpose, requested: CATEGORIES.filter(category => value.requested.includes(category)) }; let total = 0;
  for (const field of ARRAY_FIELDS) {
    const ids = value[field] === undefined ? [] : value[field]; if (!Array.isArray(ids) || ids.length > 40) fail();
    result[field] = ids.map(checkedId).sort(); total += ids.length;
    if (new Set(result[field]).size !== ids.length) fail();
  }
  if (total > 40) fail('BUDGET_EXCEEDED');
  if (new Set(ARRAY_FIELDS.flatMap(field => result[field])).size !== total) fail();
  result.destination = value.destination ?? null;
  if (result.destination !== null && !['codex', 'claude'].includes(result.destination)) fail();
  const groups = { profile: ['profile_ids'], local_files: ['source_entry_ids'], academic_exports: ['snapshot_ids'], agent_bridge: ['document_ids', 'agent_grant_ids'] };
  for (const [category, fields] of Object.entries(groups)) if (!result.requested.includes(category) && fields.some(field => result[field].length)) fail();
  if ((!result.requested.includes('agent_bridge') && result.destination !== null) || (result.agent_grant_ids.length && result.destination === null)) fail();
  return result;
}
const previewHash = value => lifeHash(Object.fromEntries(PREVIEW_KEYS.filter(key => key !== 'review_hash').map(key => [key, value[key]])));
function checkedPreview(input) {
  const value = clone(input); object(value, PREVIEW_KEYS);
  if (value.format !== 'learnbridge-onboarding-preview' || value.schema_version !== 1 || typeof value.review_hash !== 'string'
    || !HASH.test(value.review_hash) || previewHash(value) !== value.review_hash) fail('REVISION_CONFLICT');
  stamp(value.observed_at); const normalized = selection(value.selection);
  if (lifeHash(normalized) !== lifeHash(value.selection)) fail();
  return value;
}
const next = (page, action) => ({ page, action });
const row = (category, requested, items, state, limitations, next_step) => ({ category, state: requested ? state : 'not_requested',
  checked_count: items.length, items, limitations, next_step });
function coverageMetadata(coverage) {
  return Object.fromEntries(['courses', 'assignments', 'announcements', 'materials'].map(category => [category, {
    state: coverage[category].state, reasons: [...(coverage[category].reasons ?? [])], coverage_claim: 'source_reported',
  }]));
}

/** Paired-human local guide. It reads saved records only and performs no discovery or processing. */
export function createOnboardingWorkspace(store, { studentWorkspace, clock = () => new Date().toISOString() } = {}) {
  if (!studentWorkspace || typeof studentWorkspace.listSnapshots !== 'function') fail();
  const currentTime = () => stamp(clock());
  const profiles = now => profileView(store.listWorkspaceRecords({ kind: 'profile_fact' }), { now, resolveEvidence: id => store.getDocument(id) });
  const reports = () => store.listWorkspaceRecords({ kind: 'artifact' }).filter(record => record.data.format === 'onboarding_report');
  const profileMetadata = record => ({ id: record.id, revision: record.revision, field: record.data.field, state: record.data.state,
    stale: record.stale, conflict: record.conflict, purposes: [...record.data.purposes] });
  const sourceMetadata = record => ({ id: record.id, revision: record.revision, title: record.title, source_id: record.source_id,
    created_at: record.created_at, format: record.office?.document_type ?? (record.pdf ? 'pdf' : 'text'),
    coverage: record.office?.coverage ?? record.pdf?.coverage ?? { state: 'complete', reasons: [] }, origin_freshness: 'not_checked' });
  const snapshotMetadata = record => ({ id: record.id, revision: record.revision, title: record.title,
    snapshot_hash: record.data.snapshot.snapshot_hash, stream_id: record.stream_id ?? null, stream_revision: record.stream_revision ?? null,
    retrieved_at: record.data.snapshot.retrieved_at, selected_course_ids: [...record.data.snapshot.selected_course_ids],
    coverage: coverageMetadata(record.data.snapshot.coverage), coverage_claim: 'source_reported' });
  function grantMetadata(grant, now) {
    return { id: grant.id, revision: grant.revision, destination: grant.destination,
      state: grant.state === 'active' && grant.expires_at <= now ? 'expired' : grant.state,
      expires_at: grant.expires_at, max_bytes: grant.max_bytes, used_bytes: grant.used_bytes,
      record_counts: Object.fromEntries(['tasks', 'documents', 'source_entries'].map(kind => [kind, grant.pins[kind].length])) };
  }
  function catalog() {
    const now = currentTime(); const lists = {
      profile: profiles(now).map(profileMetadata), source_entries: store.listSourceEntries().map(sourceMetadata),
      snapshots: studentWorkspace.listSnapshots().map(snapshotMetadata), documents: store.listDocuments().map(record => ({ id: record.id, revision: record.revision, title: record.title })),
      grants: store.listAgentGrants().map(grant => grantMetadata(grant, now)),
    };
    const reasons = Object.entries(lists).filter(([, items]) => items.length > CATALOGUE_LIMIT).map(([kind]) => `${kind}_catalogue_limit`);
    return { schema_version: 1, ...Object.fromEntries(Object.entries(lists).map(([kind, items]) => [kind, items.slice(0, CATALOGUE_LIMIT)])),
      catalogue_coverage: { state: reasons.length ? 'partial' : 'complete', reasons },
      limitations: ['Existing local records only; no files or connected accounts were discovered.', 'Profile values, note bodies, imported text and local paths are omitted.',
        'Sharing permission does not verify host login, tools or a model turn.'] };
  }
  function build(rawSelection, { observed_at = currentTime(), now = currentTime() } = {}) {
    const chosen = selection(rawSelection); stamp(observed_at); stamp(now); if (observed_at > now) fail();
    const requested = category => chosen.requested.includes(category); const pins = []; const coverage = [];
    const profileRecords = profiles(now); const profileItems = chosen.profile_ids.map(id => {
      const record = profileRecords.find(item => item.id === id); if (!record) fail('SCOPE_DENIED');
      const item = { kind: 'profile_fact', ...profileMetadata(record), purpose_compatible: record.data.purposes.includes(chosen.purpose),
        provenance: record.data.evidence.kind };
      pins.push({ kind: 'profile_fact', id, revision: record.revision, fingerprint: record.fingerprint,
        state: item.state, stale: item.stale, conflict: item.conflict, purpose_compatible: item.purpose_compatible }); return item;
    });
    const profileState = !profileItems.length ? 'awaiting_student' : profileItems.some(item => item.stale) ? 'stale'
      : profileItems.some(item => item.conflict || item.state !== 'confirmed' || !item.purpose_compatible) ? 'awaiting_student' : 'ready';
    coverage.push(row('profile', requested('profile'), profileItems, profileState, ['Selected facts are student-reviewed statements, not independently verified identity or mastery.',
      'Saving this report does not confirm a candidate or share a profile.'], next('profile', 'Review or correct facts for the selected purpose.')));

    const sourceRecords = store.listSourceEntries(); const sourceItems = chosen.source_entry_ids.map(id => {
      const record = sourceRecords.find(item => item.id === id); if (!record) fail('SCOPE_DENIED'); const source = store.getSource(record.source_id);
      if (source.state !== 'active') fail('CONSENT_REQUIRED'); const item = { kind: 'source_entry', ...sourceMetadata(record), coverage_claim: 'saved_text_snapshot' };
      pins.push({ kind: 'source_entry', id, revision: record.revision, sha256: record.sha256, version: record.version,
        inventory_id: record.inventory_id, source_id: source.id, source_revision: source.revision, source_state: source.state,
        provenance_hash: lifeHash(record.office ?? record.pdf ?? null), coverage: item.coverage }); return item;
    });
    const sourceState = !sourceItems.length ? 'awaiting_student' : sourceItems.some(item => item.coverage.state !== 'complete') ? 'partial' : 'ready';
    coverage.push(row('local_files', requested('local_files'), sourceItems, sourceState,
      ['Only the selected saved text snapshots were checked; original file freshness and folder coverage were not checked.',
        'PDF and Office coverage limitations remain attached to their imports. No new inventory or file read was performed.'],
      next('sources', 'Choose a narrow folder, review its inventory and import useful files explicitly.')));

    const currentSnapshots = studentWorkspace.listSnapshots(); const academicItems = chosen.snapshot_ids.map(id => {
      const record = currentSnapshots.find(item => item.id === id); if (!record) fail('SCOPE_DENIED'); const item = { kind: 'academic_snapshot', ...snapshotMetadata(record) };
      pins.push({ kind: 'academic_snapshot', id, revision: record.revision, snapshot_hash: item.snapshot_hash,
        stream_id: item.stream_id, stream_revision: item.stream_revision, coverage_hash: lifeHash(item.coverage) }); return item;
    });
    const academicState = !academicItems.length ? 'awaiting_student' : academicItems.some(item => Object.values(item.coverage).some(part => part.state !== 'complete')) ? 'partial' : 'ready';
    coverage.push(row('academic_exports', requested('academic_exports'), academicItems, academicState,
      ['Dates and coverage are reported by the selected saved export. Live university authorization and current D2L data were not checked.',
        'Historical exports are excluded. Missing items do not prove deletion, and no tasks were changed.'],
      next('sources', 'Preview and save a selected academic export, then inspect the current course version.')));

    const notes = chosen.document_ids.map(id => {
      const saved = store.getDocument(id); if (!saved) fail('SCOPE_DENIED'); const item = { kind: 'document', id, revision: saved.document.revision, title: saved.document.title, sha256: saved.sha256 };
      pins.push({ kind: 'document', id, revision: item.revision, sha256: saved.sha256 }); return item;
    });
    const grantItems = chosen.agent_grant_ids.map(id => {
      const grant = store.listAgentGrants().find(item => item.id === id); if (!grant) fail('SCOPE_DENIED');
      if (grant.destination !== chosen.destination) fail('SCOPE_DENIED'); let verification = 'permission_not_current';
      const metadata = grantMetadata(grant, now);
      if (metadata.state === 'active') {
        try { store.assertAgentGrant({ destination: chosen.destination, grant_id: id }); verification = 'selected_permission_valid'; }
        catch (error) { if (!['CONSENT_REQUIRED', 'VERSION_MISMATCH', 'SCOPE_DENIED'].includes(error.code)) throw error; verification = 'selected_permission_stale'; }
      }
      pins.push({ kind: 'agent_grant', id, revision: grant.revision, destination: grant.destination, state: metadata.state,
        expires_at: grant.expires_at, max_bytes: grant.max_bytes, used_bytes: grant.used_bytes, pins_hash: lifeHash(grant.pins), verification });
      return { kind: 'agent_grant', ...metadata, verification, host_auth: 'not_checked', tool_catalogue: 'not_checked', live_turn: 'not_checked' };
    });
    const agentItems = [...notes, ...grantItems]; const agentState = !chosen.destination || !grantItems.length ? 'awaiting_student'
      : grantItems.some(item => item.verification !== 'selected_permission_valid' || item.used_bytes >= item.max_bytes) ? 'stale' : 'partial';
    coverage.push(row('agent_bridge', requested('agent_bridge'), agentItems, agentState,
      ['Selected grants establish existing scoped sharing permission only. Host login, tool catalogue, subscription access and a real turn were not checked.',
        'Private notes remain local unless separately included in an active grant. Direct profile and course records are not granted by this report.',
        'No consent, note export, host configuration or model call was created.'],
      next('agents', 'Register the project MCP in your official host and review exact records before allowing sharing.')));
    const selectedRows = coverage.filter(item => item.state !== 'not_requested');
    const overall = !selectedRows.length || selectedRows.some(item => item.state === 'awaiting_student') ? 'awaiting_student'
      : selectedRows.some(item => item.state !== 'ready') ? 'partial' : 'review_ready';
    const result = { format: 'learnbridge-onboarding-preview', schema_version: 1, selection: chosen, observed_at, pins, coverage, overall };
    return clone({ ...result, review_hash: previewHash(result) });
  }
  function reportPreview(record) {
    if (!record || record.kind !== 'artifact' || record.data.format !== 'onboarding_report') fail('SCOPE_DENIED');
    const data = clone(record.data, REPORT_BYTES); object(data, ['format', 'schema_version', 'selection', 'observed_at', 'pins', 'coverage', 'overall', 'review_hash', 'review', 'creation_operation']);
    object(data.review, ['reviewer', 'reviewed_at', 'decision']); object(data.creation_operation, ['idempotency_key', 'review_hash']);
    if (data.review.reviewer !== store.identity.student_id || data.review.decision !== 'saved_coverage_report'
      || data.creation_operation.review_hash !== data.review_hash || !/^[a-zA-Z0-9_-]{8,80}$/.test(data.creation_operation.idempotency_key)) fail('VERSION_MISMATCH');
    stamp(data.review.reviewed_at);
    if (data.review.reviewed_at < data.observed_at) fail('VERSION_MISMATCH');
    return checkedPreview(Object.fromEntries(PREVIEW_KEYS.map(key => [key, key === 'format' ? 'learnbridge-onboarding-preview' : data[key]])));
  }
  function reportView(record) {
    const preview = reportPreview(record); let reasons = [];
    try {
      const current = build(preview.selection, { observed_at: preview.observed_at });
      if (current.review_hash !== preview.review_hash) reasons = ['selected_record_or_permission_changed'];
    } catch (error) {
      if (error.code === 'BUDGET_EXCEEDED') reasons = ['selected_metadata_now_exceeds_review_budget'];
      else {
        if (!['SCOPE_DENIED', 'CONSENT_REQUIRED', 'REVISION_CONFLICT', 'VERSION_MISMATCH'].includes(error.code)) throw error;
        reasons = ['selected_record_unavailable_or_no_longer_current'];
      }
    }
    return { ...record, needs_refresh: reasons.length > 0, refresh_reasons: reasons };
  }
  return {
    catalog,
    preview: input => build(input),
    save(rawPreview, rawInput) {
      const input = clone(rawInput, 1000); object(input, ['review_hash', 'idempotency_key']);
      if (typeof input.review_hash !== 'string' || !HASH.test(input.review_hash) || typeof input.idempotency_key !== 'string'
        || !/^[a-zA-Z0-9_-]{8,80}$/.test(input.idempotency_key)) fail();
      const preview = checkedPreview(rawPreview); if (input.review_hash !== preview.review_hash) fail('REVISION_CONFLICT');
      const activeReports = reports(); const existing = activeReports.find(record => record.data.creation_operation?.idempotency_key === input.idempotency_key);
      if (existing) {
        if (existing.data.review_hash !== preview.review_hash) fail('REVISION_CONFLICT'); return reportView(existing);
      }
      if (activeReports.length >= ACTIVE_REPORT_LIMIT) fail('BUDGET_EXCEEDED');
      let current;
      try { current = build(preview.selection, { observed_at: preview.observed_at }); }
      catch (error) { if (['SCOPE_DENIED', 'CONSENT_REQUIRED', 'VERSION_MISMATCH'].includes(error.code)) fail('REVISION_CONFLICT'); throw error; }
      if (current.review_hash !== preview.review_hash) fail('REVISION_CONFLICT');
      const reviewed_at = currentTime(); const data = clone({ ...current, format: 'onboarding_report', review: {
        reviewer: store.identity.student_id, reviewed_at, decision: 'saved_coverage_report' }, creation_operation: input }, REPORT_BYTES);
      const saved = store.createWorkspaceRecord({ kind: 'artifact', title: `Reviewed ${preview.selection.purpose} setup coverage`, data },
        { idempotencyKey: `onboarding-${input.idempotency_key}` });
      const actual = store.getWorkspaceRecord(saved.id);
      // A forgotten idempotent record is a refusal, never a resurrected report.
      if (!actual) fail('REVISION_CONFLICT');
      if (lifeHash(actual.data) !== lifeHash(data)) fail('VERSION_MISMATCH'); return reportView(actual);
    },
    listReports: () => reports().map(reportView),
    getReport(id) { return reportView(store.getWorkspaceRecord(checkedId(id))); },
    forgetReport(id, expected_revision) {
      const record = store.getWorkspaceRecord(checkedId(id)); reportPreview(record);
      if (!Number.isSafeInteger(expected_revision) || expected_revision < 1) fail();
      return store.deleteWorkspaceRecord(record.id, expected_revision);
    },
  };
}

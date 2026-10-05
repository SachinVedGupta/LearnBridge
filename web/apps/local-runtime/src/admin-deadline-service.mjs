import { randomUUID } from 'node:crypto';
import { LearnBridgeError, parseDeadline } from '@learnbridge/core';
import { canonicalCareerURL } from './career.mjs';
import { lifeHash, lifeText, lifeStamp, lifeTimezone } from './life.mjs';

const ITEM = 'student_admin_deadline_v1', PREVIEW = 'student_admin_task_preview_v1';
export const STUDENT_ADMIN_LIMITS = Object.freeze({ items: 200, previews: 300, requirements: 20, checklist: 20, profile_facts: 10, source_text: 12000, matching_tasks: 50, payload_bytes: 120000, preview_ttl_ms: 600000 });
export const STUDENT_ADMIN_CATEGORIES = Object.freeze(['school', 'scholarship', 'financial_aid', 'administration']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fail = (code = 'INVALID_INPUT') => { throw new LearnBridgeError(code); };
function object(value, keys, required = keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) || !('value' in descriptors[key]) || !descriptors[key].enumerable)
    || required.some(key => !Object.hasOwn(descriptors, key))) fail();
}
function array(value, max, parse, nonempty = false) {
  if (!Array.isArray(value) || value.length > max || (nonempty && !value.length)) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length || !('value' in descriptors[key]) || !descriptors[key].enumerable))) fail();
  return Array.from({ length: value.length }, (_, index) => { if (!Object.hasOwn(descriptors, String(index))) fail(); return parse(descriptors[index].value); });
}
const id = value => { if (typeof value !== 'string' || !UUID.test(value)) fail(); return value.toLowerCase(); };
const rev = value => { if (!Number.isSafeInteger(value) || value < 1) fail(); return value; };
const digest = value => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(); return value; };
const key = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(value)) fail(); return value; };
const shortKey = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(value)) fail(); return value; };
const bounded = value => { if (Buffer.byteLength(JSON.stringify(value), 'utf8') > STUDENT_ADMIN_LIMITS.payload_bytes) fail('BUDGET_EXCEEDED'); return value; };
function unique(values) { if (new Set(values).size !== values.length) fail(); return values; }
const definitionKeys = ['title', 'category', 'official_url', 'source_text', 'checked_at', 'timezone', 'deadline', 'requirements', 'checklist'];
const itemHash = data => lifeHash({ definition: data.definition, source_hash: data.source_hash, profile_pins: data.profile_pins });
const reviewHash = data => lifeHash({ item_pin: data.item_pin, definition: data.definition, source_hash: data.source_hash, profile_pins: data.profile_pins,
  task: data.task, blockers: data.blockers, eligibility: data.eligibility, matches: data.matches, created_at: data.created_at, expires_at: data.expires_at });
const taskFingerprint = task => lifeHash({ title: task.title, deadline: task.deadline });
const titleKey = value => value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');

/** Student statements and quotations stay local and unverified. No source fetch, model, provider or form submission. */
export function createAdminDeadlineService({ store, studentWorkspace, clock = Date.now }) {
  const stamp = () => { const value = clock(); let output; try { output = typeof value === 'string' ? value : new Date(value).toISOString(); } catch { fail(); } return lifeStamp(output); };
  const allItems = () => store.listWorkspaceRecords({ kind: 'administration_item' }).filter(row => row.data.format === ITEM);
  const allPreviews = () => store.listWorkspaceRecords({ kind: 'plan' }).filter(row => row.data.format === PREVIEW);
  function normalize(input) {
    object(input, definitionKeys);
    if (!STUDENT_ADMIN_CATEGORIES.includes(input.category)) fail();
    const timezone = lifeTimezone(input.timezone), checked_at = lifeStamp(input.checked_at); if (checked_at > stamp()) fail();
    object(input.deadline, ['precision', 'date', 'instant', 'timezone', 'original', 'reason'], ['precision']);
    const deadline = parseDeadline(input.deadline);
    if (deadline.precision !== 'unknown') { if (deadline.timezone !== undefined && deadline.timezone !== timezone) fail(); deadline.timezone = timezone; }
    const source_text = lifeText(input.source_text, STUDENT_ADMIN_LIMITS.source_text);
    const requirements = array(input.requirements, STUDENT_ADMIN_LIMITS.requirements, requirement => {
      object(requirement, ['key', 'excerpt', 'status', 'review_note', 'profile_fact_ids']);
      const excerpt = lifeText(requirement.excerpt, 1000); if (!source_text.includes(excerpt)) fail('SCOPE_DENIED');
      if (!['met', 'not_met', 'unknown'].includes(requirement.status)) fail();
      return { key: shortKey(requirement.key), excerpt, status: requirement.status, review_note: lifeText(requirement.review_note, 1000),
        profile_fact_ids: unique(array(requirement.profile_fact_ids, STUDENT_ADMIN_LIMITS.profile_facts, id)).sort() };
    }, true); unique(requirements.map(requirement => requirement.key));
    const checklist = array(input.checklist, STUDENT_ADMIN_LIMITS.checklist, entry => { object(entry, ['key', 'title', 'done']); if (typeof entry.done !== 'boolean') fail(); return { key: shortKey(entry.key), title: lifeText(entry.title, 300), done: entry.done }; });
    unique(checklist.map(entry => entry.key));
    return { title: lifeText(input.title, 300), category: input.category, official_url: canonicalCareerURL(input.official_url), source_text, checked_at,
      timezone, deadline, requirements, checklist };
  }
  function profilePins(definition) {
    const ids = [...new Set(definition.requirements.flatMap(requirement => requirement.profile_fact_ids))].sort();
    if (ids.length > STUDENT_ADMIN_LIMITS.profile_facts) fail();
    const context = studentWorkspace.profileContext({ purpose: 'general', allowed_ids: ids });
    if (context.length !== ids.length) fail('SCOPE_DENIED');
    for (const value of ids) { const raw = store.getWorkspaceRecord(value); if (!raw || (raw.data.expires_at !== null && raw.data.expires_at <= stamp())) fail('SCOPE_DENIED'); }
    return context.sort((a, b) => a.id.localeCompare(b.id)).map(fact => ({ id: fact.id, revision: fact.revision, hash: lifeHash(fact), fact }));
  }
  function pinsCurrent(definition, pins) { try { return lifeHash(profilePins(definition)) === lifeHash(pins); } catch { return false; } }
  function item(row) {
    if (!row || row.kind !== 'administration_item' || row.data.format !== ITEM) fail('SCOPE_DENIED');
    object(row.data, ['format', 'definition', 'provenance', 'source_hash', 'profile_pins', 'item_hash', 'linked_task_id', 'acceptance_preview_id', 'accepted_source_hash', 'operation']);
    const data = row.data;
    if (data.provenance !== 'student_pasted_unverified' || lifeHash(normalize(data.definition)) !== data.source_hash || itemHash(data) !== data.item_hash) fail('VERSION_MISMATCH');
    object(data.operation, ['key', 'hash']); key(data.operation.key); digest(data.operation.hash);
    if (data.linked_task_id !== null) id(data.linked_task_id); if (data.acceptance_preview_id !== null) id(data.acceptance_preview_id);
    if (data.accepted_source_hash !== null) digest(data.accepted_source_hash);
    return row;
  }
  function preview(row) {
    if (!row || row.kind !== 'plan' || row.data.format !== PREVIEW) fail('SCOPE_DENIED');
    const data = row.data;
    object(data, ['format', 'state', 'item_pin', 'definition', 'source_hash', 'profile_pins', 'task', 'blockers', 'eligibility', 'matches', 'created_at', 'expires_at', 'review_hash', 'operation', 'receipt', 'task_id']);
    if (!['prepared', 'accepting', 'accepted', 'cancelled'].includes(data.state) || data.review_hash !== reviewHash(data) || data.source_hash !== lifeHash(data.definition)) fail('VERSION_MISMATCH');
    id(data.item_pin.id); rev(data.item_pin.revision); digest(data.item_pin.item_hash); lifeStamp(data.created_at); lifeStamp(data.expires_at); parseDeadline(data.task.deadline);
    const definition = normalize(data.definition), reviewed = assessment(definition);
    if (lifeHash(data.task) !== lifeHash(taskFor(definition, reviewed)) || lifeHash(data.blockers) !== lifeHash(reviewed.blockers) || data.eligibility !== reviewed.eligibility) fail('VERSION_MISMATCH');
    if (data.task_id !== null) id(data.task_id);
    if ((data.state === 'accepted') !== (data.task_id !== null)) fail('VERSION_MISMATCH');
    if (data.state === 'prepared') { if (data.receipt !== null) fail('VERSION_MISMATCH'); }
    else { object(data.receipt, ['decision', 'reviewer', 'reviewed_revision', 'review_hash', 'decided_at']);
      if (data.receipt.reviewer !== store.identity.student_id || data.receipt.review_hash !== data.review_hash || data.receipt.decision !== (data.state === 'cancelled' ? 'cancel' : 'accept')
        || data.receipt.reviewed_revision >= row.revision) fail('VERSION_MISMATCH'); rev(data.receipt.reviewed_revision); lifeStamp(data.receipt.decided_at); }
    return row;
  }
  function assessment(definition) {
    const blockers = definition.requirements.filter(requirement => requirement.status !== 'met').map(requirement => ({ key: requirement.key, reason: requirement.status === 'unknown' ? 'requirement_unresolved' : 'student_reports_requirement_not_met', excerpt: requirement.excerpt, review_note: requirement.review_note }));
    if (definition.deadline.precision === 'unknown') blockers.push({ reason: 'deadline_unconfirmed', original: definition.deadline.original ?? null });
    for (const entry of definition.checklist.filter(entry => !entry.done)) blockers.push({ key: entry.key, reason: 'checklist_incomplete', title: entry.title });
    const eligibility = definition.requirements.some(requirement => requirement.status === 'not_met') ? 'student_reviewed_requirements_not_met'
      : definition.requirements.some(requirement => requirement.status === 'unknown') ? 'unresolved' : 'student_reviewed_requirements_met';
    return { blockers, eligibility };
  }
  function matches(task) {
    const selected = store.listTasks().filter(row => titleKey(row.title) === titleKey(task.title)); if (selected.length > STUDENT_ADMIN_LIMITS.matching_tasks) fail('BUDGET_EXCEEDED');
    return selected.map(row => ({ id: row.id, revision: row.revision, status: row.status, title: row.title, deadline: row.deadline })).sort((a, b) => a.id.localeCompare(b.id));
  }
  const taskFor = (definition, reviewed) => ({ title: `${reviewed.eligibility === 'student_reviewed_requirements_met' ? 'Prepare' : 'Review requirements'}: ${definition.title}`, deadline: definition.deadline });
  function taskView(row) {
    const taskId = row.data.linked_task_id ?? row.data.task_id; if (!taskId) return null;
    const current = store.getTask(taskId), accepted = row.data.task ?? allPreviews().find(value => value.id === row.data.acceptance_preview_id)?.data.task;
    return current ? { id: current.id, revision: current.revision, title: current.title, deadline: current.deadline, status: current.status,
      changed: current.revision !== 1 || (accepted ? taskFingerprint(current) !== taskFingerprint(accepted) : true) } : { id: taskId, unavailable: true };
  }
  function itemView(row) { row = item(row); return { ...row, ...assessment(row.data.definition), profile_stale: !pinsCurrent(row.data.definition, row.data.profile_pins), accepted_task: taskView(row),
    source_changed_since_acceptance: row.data.accepted_source_hash !== null && row.data.accepted_source_hash !== row.data.source_hash, provider_reads: 0, external_submissions: 0 }; }
  function sourcesCurrent(data) { try { const current = item(store.getWorkspaceRecord(data.item_pin.id)); return current.data.item_hash === data.item_pin.item_hash
    && (data.state !== 'prepared' || current.revision === data.item_pin.revision) && pinsCurrent(data.definition, data.profile_pins); } catch { return false; } }
  function previewView(row) { row = preview(row); return { ...row, expired: stamp() >= row.data.expires_at, needs_refresh: !sourcesCurrent(row.data), accepted_task: taskView(row),
    tasks_created: row.data.state === 'accepted' ? 1 : 0, provider_reads: 0, model_calls: 0, external_submissions: 0 }; }
  function receipt(row, input, decision) {
    object(input, ['expected_revision', 'review_hash', 'confirmed']); rev(input.expected_revision); digest(input.review_hash); if (input.confirmed !== true) fail('CONSENT_REQUIRED');
    if (input.review_hash !== row.data.review_hash) fail('REVISION_CONFLICT');
    return { decision, reviewer: store.identity.student_id, reviewed_revision: input.expected_revision, review_hash: row.data.review_hash, decided_at: stamp() };
  }
  function finish(row) {
    const data = row.data, retry = `student-admin-accept-${data.item_pin.id}`;
    let result = store.getTaskCreateResult(data.task, { idempotencyKey: retry });
    const current = item(store.getWorkspaceRecord(data.item_pin.id));
    if (current.data.acceptance_preview_id !== row.id || current.data.linked_task_id !== null) fail('REVISION_CONFLICT');
    if (!result) {
      if (!sourcesCurrent(data) || current.data.item_hash !== data.item_pin.item_hash || lifeHash(matches(data.task)) !== lifeHash(data.matches) || data.matches.length) fail('REVISION_CONFLICT');
      result = store.createTask(data.task, { idempotencyKey: retry });
    }
    // A saved task-create receipt recovers history, even if the student later edited/deleted the task. Never recreate or overwrite it.
    const batch = store.commitWorkspaceBatch({ creates: [], updates: [
      { id: row.id, expected_revision: row.revision, data: { ...data, state: 'accepted', task_id: result.id } },
      { id: current.id, expected_revision: current.revision, data: { ...current.data, linked_task_id: result.id, accepted_source_hash: data.source_hash } },
    ] }); return previewView(batch.updates[0]);
  }
  return {
    context() {
      const candidates = studentWorkspace.listProfiles().filter(row => row.data.state === 'confirmed' && row.data.purposes.includes('general') && !row.stale && !row.conflict);
      const profiles = studentWorkspace.profileContext({ purpose: 'general', allowed_ids: candidates.map(row => row.id).slice(0, 100) }).filter(fact => { const row = store.getWorkspaceRecord(fact.id); return row.data.expires_at === null || row.data.expires_at > stamp(); });
      return { categories: STUDENT_ADMIN_CATEGORIES, profiles, profile_purpose: 'general', limits: STUDENT_ADMIN_LIMITS, provenance: 'student_pasted_unverified', automatic_eligibility: false, provider_reads: false, form_submission: false };
    },
    list: () => allItems().map(itemView), get: value => itemView(store.getWorkspaceRecord(id(value))),
    create(input, { idempotencyKey } = {}) {
      const operation = key(idempotencyKey), definition = normalize(input), profile_pins = profilePins(definition), operation_hash = lifeHash({ definition, profile_pins });
      const previous = allItems().find(row => row.data.operation.key === operation); if (previous) { item(previous); if (previous.data.operation.hash !== operation_hash) fail('REVISION_CONFLICT'); return itemView(previous); }
      const data = { format: ITEM, definition, provenance: 'student_pasted_unverified', source_hash: lifeHash(definition), profile_pins, operation: { key: operation, hash: operation_hash },
        linked_task_id: null, acceptance_preview_id: null, accepted_source_hash: null }; data.item_hash = itemHash(data);
      // Existing storage enforces exact creation replay. Time and remote status are not invented into the request.
      if (allItems().length >= STUDENT_ADMIN_LIMITS.items) fail('BUDGET_EXCEEDED');
      const saved = store.createWorkspaceRecord({ kind: 'administration_item', title: definition.title, data: bounded(data) }, { idempotencyKey: operation }); return itemView(store.getWorkspaceRecord(saved.id) ?? saved);
    },
    correct(value, input) {
      object(input, ['expected_revision', 'item_hash', 'definition', 'confirmed']); rev(input.expected_revision); digest(input.item_hash); if (input.confirmed !== true) fail('CONSENT_REQUIRED');
      const current = item(store.getWorkspaceRecord(id(value))); if (current.revision !== input.expected_revision || current.data.item_hash !== input.item_hash) fail('REVISION_CONFLICT');
      if (current.data.acceptance_preview_id && !current.data.linked_task_id) fail('CONSENT_REQUIRED');
      const definition = normalize(input.definition), data = { ...current.data, definition, source_hash: lifeHash(definition), profile_pins: profilePins(definition) }; data.item_hash = itemHash(data);
      return itemView(store.updateWorkspaceRecord(current.id, { expected_revision: current.revision, title: definition.title, data: bounded(data) }));
    },
    prepare(value, input, { idempotencyKey } = {}) {
      object(input, ['expected_revision', 'item_hash']); rev(input.expected_revision); digest(input.item_hash); const retry = key(idempotencyKey), current = item(store.getWorkspaceRecord(id(value))), operation_hash = lifeHash({ id: current.id, ...input });
      const saved = allPreviews().find(row => row.data.operation.key === retry); if (saved) { preview(saved); if (saved.data.operation.hash !== operation_hash) fail('REVISION_CONFLICT'); return previewView(saved); }
      if (current.revision !== input.expected_revision || current.data.item_hash !== input.item_hash) fail('REVISION_CONFLICT');
      if (current.data.linked_task_id || current.data.acceptance_preview_id) fail('REVISION_CONFLICT');
      if (!pinsCurrent(current.data.definition, current.data.profile_pins)) fail('REVISION_CONFLICT'); if (allPreviews().length >= STUDENT_ADMIN_LIMITS.previews) fail('BUDGET_EXCEEDED');
      const { definition, source_hash, profile_pins } = current.data, reviewed = assessment(definition), task = taskFor(definition, reviewed);
      const created_at = stamp(), data = { format: PREVIEW, state: 'prepared', item_pin: { id: current.id, revision: current.revision, item_hash: current.data.item_hash }, definition, source_hash, profile_pins,
        task, ...reviewed, matches: matches(task), created_at, expires_at: new Date(Date.parse(created_at) + STUDENT_ADMIN_LIMITS.preview_ttl_ms).toISOString(), operation: { key: retry, hash: operation_hash }, receipt: null, task_id: null };
      data.review_hash = reviewHash(data);
      return previewView(store.commitWorkspaceBatch({ creates: [{ id: randomUUID(), kind: 'plan', title: `Review task: ${definition.title}`, data: bounded(data) }], updates: [] }).creates[0]);
    },
    listPreviews: () => allPreviews().map(previewView), getPreview: value => previewView(store.getWorkspaceRecord(id(value))),
    accept(value, input) {
      let row = preview(store.getWorkspaceRecord(id(value))); const approved = receipt(row, input, 'accept'), data = row.data;
      if (data.state === 'accepted') { if (![row.revision, data.receipt.reviewed_revision].includes(input.expected_revision)) fail('REVISION_CONFLICT'); return previewView(row); }
      if (data.state === 'cancelled') fail('REVISION_CONFLICT');
      if (data.state === 'accepting') { if (![row.revision, data.receipt.reviewed_revision].includes(input.expected_revision)) fail('REVISION_CONFLICT'); return finish(row); }
      if (row.revision !== input.expected_revision || stamp() >= data.expires_at) fail(row.revision !== input.expected_revision ? 'REVISION_CONFLICT' : 'CONSENT_REQUIRED');
      const current = item(store.getWorkspaceRecord(data.item_pin.id));
      if (current.revision !== data.item_pin.revision || !sourcesCurrent(data) || current.data.linked_task_id || current.data.acceptance_preview_id
        || lifeHash(matches(data.task)) !== lifeHash(data.matches) || data.matches.length) fail('REVISION_CONFLICT');
      const batch = store.commitWorkspaceBatch({ creates: [], updates: [
        { id: row.id, expected_revision: row.revision, data: { ...data, state: 'accepting', receipt: approved } },
        { id: current.id, expected_revision: current.revision, data: { ...current.data, acceptance_preview_id: row.id } },
      ] }); row = preview(batch.updates[0]); return finish(row);
    },
    cancel(value, input) {
      const row = preview(store.getWorkspaceRecord(id(value))), approved = receipt(row, input, 'cancel');
      if (row.data.state === 'cancelled' && [row.revision, row.data.receipt.reviewed_revision].includes(input.expected_revision)) return previewView(row);
      if (!['prepared', 'accepting'].includes(row.data.state) || ![row.revision, row.data.receipt?.reviewed_revision].includes(input.expected_revision)) fail('REVISION_CONFLICT');
      if (row.data.state === 'accepting' && store.getTaskCreateResult(row.data.task, { idempotencyKey: `student-admin-accept-${row.data.item_pin.id}` })) fail('CONSENT_REQUIRED');
      const current = item(store.getWorkspaceRecord(row.data.item_pin.id)), updates = [{ id: row.id, expected_revision: row.revision, data: { ...row.data, state: 'cancelled', receipt: approved } }];
      if (current.data.acceptance_preview_id === row.id && current.data.linked_task_id === null) updates.push({ id: current.id, expected_revision: current.revision, data: { ...current.data, acceptance_preview_id: null } });
      return previewView(store.commitWorkspaceBatch({ creates: [], updates }).updates[0]);
    },
  };
}

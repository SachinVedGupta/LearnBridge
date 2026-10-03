import { randomUUID } from 'node:crypto';
import { ERROR_CODES, LearnBridgeError, invalidInput } from './errors.mjs';

/**
 * Dependency-free version-one contracts. These functions validate data, not
 * authorization: an approved-looking receipt is still untrusted until the
 * runtime checks the actual paired human session and stored receipt.
 * No filesystem, credential store, network or environment access occurs here.
 */
export const SCHEMA_VERSION = 1;
export const CORE_LIMITS = Object.freeze({
  source_refs: 100, dependency_ids: 100, processing_destinations: 8,
  scope_members: 500, document_content_ref: 256, title: 500,
  run_evidence: 100, run_grants: 100, run_capabilities: 100,
});

/** @typedef {{id:string,schema_version:1,student_id:string,revision:number,created_at:string,updated_at:string,deleted_at:string|null}} RecordMetadata */
/** @typedef {{precision:'unknown',reason?:string,original?:string}|{precision:'date',date:string,timezone?:string,original?:string}|{precision:'instant',instant:string,timezone?:string,original?:string}} Deadline */
/** @typedef {RecordMetadata & {platform:'darwin'|'win32'|'linux',data_root_ref:string,edition:'local'|'hosted',timezone:string,setup_version:string}} Installation */
/** @typedef {{provider:string,destination_ref:string,purposes:string[],allowed_metadata:boolean,allowed_content:boolean,max_payload_bytes:number}} ProcessingDestination */
/** @typedef {RecordMetadata & {principal_ref:string,source_ref:string,state:'active'|'revoked',scope:object,operations:string[],processing:{local:boolean,destinations:ProcessingDestination[]},retention:object,expires_at:string|null,review_receipt:object}} SourceGrant */
/** @typedef {{source_id:string,object_id:string,source_version_id:string,version_hash?:string,locator:{kind:'url'|'path'|'opaque',ref:string},range:object|null,retrieved_at:string,grant_id:string}} ProvenanceRef */
/** @typedef {RecordMetadata & {title:string,status:'pending'|'in_progress'|'completed'|'cancelled',source_refs:ProvenanceRef[],course_id:string|null,course_label?:string|null,deadline:Deadline,effort_minutes:number|null,parent_id:string|null,dependency_ids:string[],recurrence:object|null,origin:string,student_overrides:string[]}} Task */
/** @typedef {RecordMetadata & {title:string,kind:string,course_id:string|null,current_revision:number,source_refs:ProvenanceRef[],content_ref:string,academic_policy:string}} Document */
/** @typedef {RecordMetadata & {document_id:string,content_ref:string,sha256:string,author:{kind:'student'|'agent'|'migration',principal_ref:string},change_reason:string}} DocumentRevision */
/** @typedef {{schema_version:1,adapter_id:string,adapter_version:string,account_ref:string|null,state:string,operations:object[],retrieved_at:string}} CapabilityReport */
/** @typedef {'created'|'validating'|'ready'|'running'|'awaiting_student'|'verifying'|'failed'|'cancelling'|'interrupted'|'cancelled'|'expired'|'completed'|'partial'|'unknown_outcome'} RunState */
/** @typedef {RecordMetadata & {recipe_id:string,recipe_version:string,state:RunState,grants:object[],capabilities:object[],budget:object,checkpoint:object|null,error:object|null,evidence_refs:string[]}} Run */

const META = ['id', 'schema_version', 'student_id', 'revision', 'created_at', 'updated_at', 'deleted_at'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_RE = /^[0-9a-f]{64}$/;
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const CAPABILITY_STATES = ['available', 'requires_auth', 'requires_scope', 'unsupported', 'degraded', 'unknown'];
const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'];
const TASK_ORIGINS = ['manual', 'imported', 'agent_proposed', 'agent_reviewed', 'migration'];
const TASK_OVERRIDES = ['title', 'status', 'course_id', 'course_label', 'deadline', 'effort_minutes', 'parent_id', 'dependency_ids', 'recurrence'];
const GRANT_OPERATIONS = ['metadata.read', 'content.read', 'local.write', 'external.write', 'external.send', 'external.submit', 'external.delete'];
const CREDENTIAL_URL_KEYS = new Set(['access_token', 'id_token', 'token', 'code', 'api_key',
  'client_secret', 'signature', 'x-amz-signature', 'x-goog-signature']);

function object(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalidInput();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string'
    || !keys.includes(key) || !('value' in descriptors[key]))) invalidInput();
  return value;
}

function text(value, max = 256, { empty = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (!empty && value.trim().length === 0)
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) invalidInput();
  return value;
}

function name(value) {
  if (typeof value !== 'string' || !NAME_RE.test(value)) invalidInput();
  return value;
}

function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalidInput();
  return value;
}

function enumeration(value, allowed) {
  if (!allowed.includes(value)) invalidInput();
  return value;
}

function boolean(value) {
  if (typeof value !== 'boolean') invalidInput();
  return value;
}

function uuid(value) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) invalidInput();
  return value.toLowerCase();
}

function sha(value) {
  if (typeof value !== 'string' || !SHA_RE.test(value)) invalidInput();
  return value;
}

function array(value, max, parse, unique = false) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) invalidInput();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== value.length + 1
    || Reflect.ownKeys(value).some(key => typeof key !== 'string'
      || (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))
      || !('value' in descriptors[key]))) invalidInput();
  for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) invalidInput();
  const result = value.map(parse);
  if (unique && new Set(result).size !== result.length) invalidInput();
  return result;
}

function optional(value, parse) { return value === null || value === undefined ? null : parse(value); }

function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalidInput();
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) invalidInput();
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > days[month - 1]) invalidInput();
  return value;
}

function instant(value) {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)) invalidInput();
  calendarDate(value.slice(0, 10));
  const parsed = new Date(value);
  const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== canonical) invalidInput();
  return value;
}

function timezone(value) {
  text(value, 100);
  // Offset strings are not an IANA zone and cannot resolve future DST rules.
  if (/^[+-]/.test(value)) invalidInput();
  try { new Intl.DateTimeFormat('en', { timeZone: value }); } catch { invalidInput(); }
  return value;
}

function ref(value) { return text(value, 256); }

function relativePath(value) {
  text(value, 1000);
  if (value.startsWith('/') || value.startsWith('\\') || /^[a-zA-Z]:/.test(value)
    || value.split(/[\\/]/).some(segment => !segment || segment === '.' || segment === '..')
    || value.includes('\n') || value.includes('\r')) invalidInput();
  return value;
}

function metadata(value) {
  if (value.schema_version !== SCHEMA_VERSION) {
    throw new LearnBridgeError('VERSION_MISMATCH', { next_action: 'refresh' });
  }
  const result = {
    id: uuid(value.id), schema_version: SCHEMA_VERSION, student_id: uuid(value.student_id),
    revision: parseExpectedRevision(value.revision), created_at: instant(value.created_at),
    updated_at: instant(value.updated_at), deleted_at: optional(value.deleted_at, instant),
  };
  if (Date.parse(result.updated_at) < Date.parse(result.created_at)
    || (result.deleted_at && (Date.parse(result.deleted_at) < Date.parse(result.created_at)
      || Date.parse(result.deleted_at) > Date.parse(result.updated_at)))) invalidInput();
  return result;
}

function creation(input, options, parse) {
  object(options, ['id', 'now']);
  // Unknown input keys are preserved for the parser to reject, never dropped.
  object(input, [...META.filter(key => key === 'student_id'), ...parse.fields]);
  const now = options.now === undefined ? new Date().toISOString() : instant(options.now);
  return parse({ ...input, id: options.id === undefined ? randomUUID() : uuid(options.id),
    schema_version: SCHEMA_VERSION, revision: 1, created_at: now, updated_at: now, deleted_at: null });
}

/** @returns {number} */
export function parseExpectedRevision(value) { return integer(value, 1); }

/** Date-only values never become UTC midnight; unresolved local timestamps fail. @returns {Deadline} */
export function parseDeadline(value) {
  object(value, ['precision', 'reason', 'original', 'date', 'instant', 'timezone']);
  const precision = enumeration(value.precision, ['unknown', 'date', 'instant']);
  if ((precision !== 'date' && 'date' in value) || (precision !== 'instant' && 'instant' in value)
    || (precision !== 'unknown' && 'reason' in value)
    || (precision === 'unknown' && 'timezone' in value)) invalidInput();
  const result = { precision };
  if (value.original !== undefined) result.original = text(value.original, 1000, { empty: true });
  if (precision === 'unknown' && value.reason !== undefined) result.reason = text(value.reason, 256);
  if (precision === 'date') result.date = calendarDate(value.date);
  if (precision === 'instant') result.instant = instant(value.instant);
  if (value.timezone !== undefined) result.timezone = timezone(value.timezone);
  return result;
}

/** @returns {Installation} */
export function parseInstallation(value) {
  object(value, [...META, ...parseInstallation.fields]);
  return { ...metadata(value), platform: enumeration(value.platform, ['darwin', 'win32', 'linux']),
    data_root_ref: ref(value.data_root_ref), edition: enumeration(value.edition, ['local', 'hosted']),
    timezone: timezone(value.timezone), setup_version: text(value.setup_version, 64) };
}
parseInstallation.fields = ['platform', 'data_root_ref', 'edition', 'timezone', 'setup_version'];
export function createInstallation(input, options = {}) { return creation(input, options, parseInstallation); }

/** @returns {ProvenanceRef} */
export function parseProvenanceRef(value) {
  object(value, ['source_id', 'object_id', 'source_version_id', 'version_hash', 'locator', 'range', 'retrieved_at', 'grant_id']);
  const locator = object(value.locator, ['kind', 'ref']);
  const kind = enumeration(locator.kind, ['url', 'path', 'opaque']);
  const locatorRef = text(locator.ref, 2000);
  if (kind === 'url') {
    let url;
    try { url = new URL(locatorRef); } catch { invalidInput(); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) invalidInput();
    if ([...url.searchParams.keys()].some(key => CREDENTIAL_URL_KEYS.has(key.toLowerCase()))) invalidInput();
    // OAuth fragments and signed query references must never enter citations.
    // This recognizes credential field names, not arbitrary private values.
    let fragment;
    try { fragment = decodeURIComponent(url.hash.slice(1)); } catch { invalidInput(); }
    const fragmentQuery = fragment.includes('?') ? fragment.slice(fragment.indexOf('?') + 1) : fragment;
    if ([...new URLSearchParams(fragmentQuery).keys()].some(key => CREDENTIAL_URL_KEYS.has(key.toLowerCase()))) invalidInput();
  }
  let range = null;
  if (value.range !== undefined && value.range !== null) {
    object(value.range, ['kind', 'start', 'end']);
    const rangeKind = enumeration(value.range.kind, ['page', 'slide', 'line', 'character']);
    const start = integer(value.range.start, rangeKind === 'character' ? 0 : 1);
    const end = integer(value.range.end, start);
    range = { kind: rangeKind, start, end };
  }
  const result = { source_id: uuid(value.source_id), object_id: uuid(value.object_id),
    source_version_id: uuid(value.source_version_id), locator: { kind, ref: locatorRef }, range,
    retrieved_at: instant(value.retrieved_at), grant_id: uuid(value.grant_id) };
  if (value.version_hash !== undefined) result.version_hash = sha(value.version_hash);
  return result;
}

function grantScope(value) {
  object(value, ['selection', 'object_ids', 'collection_ids', 'relative_paths']);
  const result = {
    selection: enumeration(value.selection, ['selected', 'entire_source']),
    object_ids: array(value.object_ids ?? [], CORE_LIMITS.scope_members, ref, true),
    collection_ids: array(value.collection_ids ?? [], CORE_LIMITS.scope_members, ref, true),
    relative_paths: array(value.relative_paths ?? [], CORE_LIMITS.scope_members, relativePath, true),
  };
  if (result.selection === 'selected'
    && !result.object_ids.length && !result.collection_ids.length && !result.relative_paths.length) invalidInput();
  if (result.selection === 'entire_source'
    && (result.object_ids.length || result.collection_ids.length || result.relative_paths.length)) invalidInput();
  return result;
}

function processing(value) {
  object(value, ['local', 'destinations']);
  const destinations = array(value.destinations, CORE_LIMITS.processing_destinations, item => {
    object(item, ['provider', 'destination_ref', 'purposes', 'allowed_metadata', 'allowed_content', 'max_payload_bytes']);
    const result = { provider: name(item.provider), destination_ref: ref(item.destination_ref),
      purposes: array(item.purposes, 20, name, true), allowed_metadata: boolean(item.allowed_metadata),
      allowed_content: boolean(item.allowed_content), max_payload_bytes: integer(item.max_payload_bytes, 0, 100_000_000) };
    if (!result.purposes.length || (!result.allowed_metadata && !result.allowed_content)
      || result.max_payload_bytes === 0) invalidInput();
    return result;
  });
  if (new Set(destinations.map(item => `${item.provider}:${item.destination_ref}`)).size !== destinations.length) invalidInput();
  return { local: boolean(value.local), destinations };
}

function grantReceipt(value, principal) {
  object(value, ['reviewer', 'decided_at', 'decision', 'authorization_source', 'fingerprint']);
  const reviewer = uuid(value.reviewer);
  if (reviewer !== principal) invalidInput();
  return { reviewer, decided_at: instant(value.decided_at), decision: enumeration(value.decision, ['approved']),
    authorization_source: enumeration(value.authorization_source, ['local_ui', 'host_approval']), fingerprint: sha(value.fingerprint) };
}

/** Read and destination-specific processing permissions are independent. @returns {SourceGrant} */
export function parseSourceGrant(value) {
  object(value, [...META, ...parseSourceGrant.fields]);
  const meta = metadata(value);
  const principal = uuid(value.principal_ref);
  if (principal !== meta.student_id) invalidInput();
  object(value.retention, ['mode', 'days']);
  const mode = enumeration(value.retention.mode, ['ephemeral', 'managed']);
  const days = optional(value.retention.days, item => integer(item, 0, 3650));
  if ((mode === 'ephemeral' && days !== 0) || (mode === 'managed' && days === 0)) invalidInput();
  const operations = array(value.operations, GRANT_OPERATIONS.length, item => enumeration(item, GRANT_OPERATIONS), true);
  if (!operations.length) invalidInput();
  const result = { ...meta, principal_ref: principal, source_ref: uuid(value.source_ref),
    state: enumeration(value.state, ['active', 'revoked']), scope: grantScope(value.scope), operations,
    processing: processing(value.processing), retention: { mode, days },
    expires_at: optional(value.expires_at, instant), review_receipt: grantReceipt(value.review_receipt, principal) };
  if (Date.parse(result.review_receipt.decided_at) > Date.parse(result.updated_at)
    || (result.expires_at && Date.parse(result.expires_at) <= Date.parse(result.review_receipt.decided_at))) invalidInput();
  return result;
}
parseSourceGrant.fields = ['principal_ref', 'source_ref', 'state', 'scope', 'operations', 'processing', 'retention', 'expires_at', 'review_receipt'];
export function createSourceGrant(input, options = {}) { return creation(input, options, parseSourceGrant); }

/** Policy precondition only; runtime still verifies ownership/session and actual scope. */
export function assertGrantAllows(grant, request) {
  object(request, ['operation', 'provider', 'destination_ref', 'purpose', 'content', 'now', 'payload_bytes']);
  const { operation, provider = null, destination_ref = null, purpose = null, content = false, now, payload_bytes = 0 } = request;
  enumeration(operation, GRANT_OPERATIONS);
  boolean(content);
  integer(payload_bytes, 0, 100_000_000);
  const parsed = parseSourceGrant(grant);
  instant(now);
  if (parsed.state !== 'active' || parsed.deleted_at
    || Date.parse(parsed.created_at) > Date.parse(now)
    || Date.parse(parsed.review_receipt.decided_at) > Date.parse(now)
    || (parsed.expires_at && Date.parse(parsed.expires_at) <= Date.parse(now))) {
    throw new LearnBridgeError('CONSENT_REQUIRED', { next_action: 'review_scope' });
  }
  if (!parsed.operations.includes(operation)) throw new LearnBridgeError('SCOPE_DENIED', { next_action: 'review_scope' });
  if (content && !parsed.operations.includes('content.read')) throw new LearnBridgeError('SCOPE_DENIED', { next_action: 'review_scope' });
  if (provider === null) {
    if (destination_ref !== null || purpose !== null) invalidInput();
    if (!parsed.processing.local) throw new LearnBridgeError('SCOPE_DENIED', { next_action: 'review_scope' });
    return parsed;
  }
  name(provider);
  ref(destination_ref);
  name(purpose);
  const destination = parsed.processing.destinations.find(item => item.provider === provider
    && item.destination_ref === destination_ref && item.purposes.includes(purpose));
  if (!destination || (content ? !destination.allowed_content : !destination.allowed_metadata)) {
    throw new LearnBridgeError('SCOPE_DENIED', { next_action: 'review_scope' });
  }
  if (payload_bytes > destination.max_payload_bytes) {
    throw new LearnBridgeError('BUDGET_EXCEEDED');
  }
  return parsed;
}

function recurrence(value) {
  if (value === null || value === undefined) return null;
  object(value, ['frequency', 'interval', 'until']);
  return { frequency: enumeration(value.frequency, ['daily', 'weekly', 'monthly']),
    interval: integer(value.interval, 1, 100), until: optional(value.until, calendarDate) };
}

/** Graph-wide cycle validation is a separate repository precondition. @returns {Task} */
export function parseTask(value) {
  object(value, [...META, ...parseTask.fields]);
  const meta = metadata(value);
  const dependencyIds = array(value.dependency_ids ?? [], CORE_LIMITS.dependency_ids, uuid, true);
  const parentId = optional(value.parent_id, uuid);
  if (parentId === meta.id || dependencyIds.includes(meta.id)) invalidInput();
  const result = { ...meta, title: text(value.title, CORE_LIMITS.title),
    status: enumeration(value.status ?? 'pending', TASK_STATUSES),
    source_refs: array(value.source_refs ?? [], CORE_LIMITS.source_refs, parseProvenanceRef),
    course_id: optional(value.course_id, uuid), deadline: parseDeadline(value.deadline ?? { precision: 'unknown' }),
    effort_minutes: optional(value.effort_minutes, item => integer(item, 0, 144_000)), parent_id: parentId,
    dependency_ids: dependencyIds, recurrence: recurrence(value.recurrence),
    origin: enumeration(value.origin ?? 'manual', TASK_ORIGINS),
    student_overrides: array(value.student_overrides ?? [], TASK_OVERRIDES.length, item => enumeration(item, TASK_OVERRIDES), true) };
  if (value.course_label !== undefined) result.course_label = optional(value.course_label, item => text(item, 500, { empty: true }));
  return result;
}
parseTask.fields = ['title', 'status', 'source_refs', 'course_id', 'course_label', 'deadline', 'effort_minutes', 'parent_id', 'dependency_ids', 'recurrence', 'origin', 'student_overrides'];
export function createTask(input, options = {}) { return creation(input, options, parseTask); }

/** Validate full task dependency/parent graphs before saving any batch. */
export function assertTaskGraph(tasks) {
  const parsed = array(tasks, 10_000, parseTask);
  const byId = new Map(parsed.map(task => [task.id, task]));
  if (byId.size !== parsed.length) invalidInput();
  const owners = new Set(parsed.map(task => task.student_id));
  if (owners.size > 1) invalidInput();
  // Iterative traversal avoids stack exhaustion on a valid but long graph.
  const visiting = new Set();
  const visited = new Set();
  for (const task of parsed) {
    if (visited.has(task.id)) continue;
    const stack = [{ id: task.id, exit: false }];
    while (stack.length) {
      const entry = stack.pop();
      if (entry.exit) { visiting.delete(entry.id); visited.add(entry.id); continue; }
      if (visited.has(entry.id)) continue;
      if (visiting.has(entry.id)) invalidInput();
      const current = byId.get(entry.id);
      if (!current) invalidInput();
      visiting.add(entry.id);
      stack.push({ id: entry.id, exit: true });
      const edges = [...current.dependency_ids, ...(current.parent_id ? [current.parent_id] : [])];
      for (const id of edges) stack.push({ id, exit: false });
    }
  }
  return parsed;
}

/** @returns {Document} */
export function parseDocument(value) {
  object(value, [...META, ...parseDocument.fields]);
  return { ...metadata(value), title: text(value.title, CORE_LIMITS.title),
    kind: enumeration(value.kind, ['note', 'assignment', 'study', 'resume', 'other']),
    course_id: optional(value.course_id, uuid), current_revision: parseExpectedRevision(value.current_revision),
    source_refs: array(value.source_refs ?? [], CORE_LIMITS.source_refs, parseProvenanceRef),
    content_ref: ref(value.content_ref), academic_policy: enumeration(value.academic_policy, ['learning_support', 'graded_restricted', 'unrestricted']) };
}
parseDocument.fields = ['title', 'kind', 'course_id', 'current_revision', 'source_refs', 'content_ref', 'academic_policy'];
export function createDocument(input, options = {}) { return creation(input, options, parseDocument); }

function immutable(value) {
  for (const item of Object.values(value)) if (item && typeof item === 'object') immutable(item);
  return Object.freeze(value);
}

/** Returns a deeply frozen revision; storage must also enforce append-only rows. @returns {DocumentRevision} */
export function parseDocumentRevision(value) {
  object(value, [...META, ...parseDocumentRevision.fields]);
  const meta = metadata(value);
  if (meta.deleted_at !== null || Date.parse(meta.created_at) !== Date.parse(meta.updated_at)) invalidInput();
  object(value.author, ['kind', 'principal_ref']);
  const author = { kind: enumeration(value.author.kind, ['student', 'agent', 'migration']), principal_ref: uuid(value.author.principal_ref) };
  if (author.principal_ref !== meta.student_id) invalidInput();
  return immutable({ ...meta, document_id: uuid(value.document_id), content_ref: ref(value.content_ref),
    sha256: sha(value.sha256), author, change_reason: text(value.change_reason, 1000) });
}
parseDocumentRevision.fields = ['document_id', 'content_ref', 'sha256', 'author', 'change_reason'];
export function createDocumentRevision(input, options = {}) { return creation(input, options, parseDocumentRevision); }

/** Append-only revision relation checked independently of the storage backend. */
export function assertNextDocumentRevision(document, previous, next) {
  const doc = parseDocument(document);
  const prior = parseDocumentRevision(previous);
  const proposed = parseDocumentRevision(next);
  if (prior.document_id !== doc.id || proposed.document_id !== doc.id
    || prior.student_id !== doc.student_id || proposed.student_id !== doc.student_id
    || proposed.id === prior.id || proposed.revision !== prior.revision + 1
    || doc.current_revision !== prior.revision || Date.parse(proposed.created_at) < Date.parse(prior.created_at)) {
    throw new LearnBridgeError('REVISION_CONFLICT', { next_action: 'refresh' });
  }
  return proposed;
}

/** A fixture proof is explicit and cannot become a live capability claim. @returns {CapabilityReport} */
export function parseCapabilityReport(value) {
  object(value, ['schema_version', 'adapter_id', 'adapter_version', 'account_ref', 'state', 'operations', 'retrieved_at']);
  if (value.schema_version !== SCHEMA_VERSION) throw new LearnBridgeError('VERSION_MISMATCH');
  const retrievedAt = instant(value.retrieved_at);
  const operations = array(value.operations, 100, item => {
    object(item, ['name', 'state', 'proof', 'last_verified_at']);
    const result = { name: name(item.name), state: enumeration(item.state, CAPABILITY_STATES),
      proof: enumeration(item.proof, ['none', 'fixture', 'live']), last_verified_at: optional(item.last_verified_at, instant) };
    if ((result.proof === 'none') !== (result.last_verified_at === null)) invalidInput();
    if (result.last_verified_at && Date.parse(result.last_verified_at) > Date.parse(retrievedAt)) invalidInput();
    return result;
  });
  if (new Set(operations.map(item => item.name)).size !== operations.length) invalidInput();
  const state = enumeration(value.state, CAPABILITY_STATES);
  if (state === 'available' && !operations.some(item => item.state === 'available')) invalidInput();
  return { schema_version: SCHEMA_VERSION, adapter_id: name(value.adapter_id),
    adapter_version: text(value.adapter_version, 64), account_ref: optional(value.account_ref, ref),
    state, operations, retrieved_at: retrievedAt };
}

export const RUN_TRANSITIONS = Object.freeze(Object.fromEntries(Object.entries({
  created: ['validating', 'cancelled', 'failed'], validating: ['ready', 'cancelled', 'failed'],
  ready: ['running', 'cancelled', 'failed'],
  running: ['awaiting_student', 'verifying', 'failed', 'cancelling', 'interrupted'],
  awaiting_student: ['running', 'cancelled', 'expired'],
  verifying: ['completed', 'partial', 'unknown_outcome', 'failed'],
  cancelling: ['cancelled', 'partial', 'unknown_outcome'],
  unknown_outcome: ['verifying', 'awaiting_student'],
  failed: ['ready'], partial: ['ready'], interrupted: ['ready'],
  cancelled: [], expired: [], completed: [],
}).map(([key, values]) => [key, Object.freeze(values)])));

const BUDGET_FIELDS = ['tool_calls', 'source_pages', 'read_bytes', 'elapsed_ms', 'model_requests'];
function budgetUsed(value) {
  object(value, BUDGET_FIELDS);
  return Object.fromEntries(BUDGET_FIELDS.map(key => [key, integer(value[key])]));
}
function budget(value) {
  object(value, [...BUDGET_FIELDS.map(key => `max_${key}`), 'used']);
  const used = budgetUsed(value.used);
  const result = { used };
  for (const key of BUDGET_FIELDS) {
    result[`max_${key}`] = integer(value[`max_${key}`]);
    if (used[key] > result[`max_${key}`]) throw new LearnBridgeError('BUDGET_EXCEEDED');
  }
  return result;
}
function keyedMap(value, keyParse, valueParse, max = 100) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalidInput();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length > max || Reflect.ownKeys(value).some(key => typeof key !== 'string'
    || !('value' in descriptors[key]) || !descriptors[key].enumerable)) invalidInput();
  const entries = Object.keys(value).map(key => [keyParse(key), valueParse(value[key])]);
  if (new Set(entries.map(([key]) => key)).size !== entries.length) invalidInput();
  return Object.fromEntries(entries);
}
function checkpoint(value) {
  if (value === null || value === undefined) return null;
  object(value, ['step_id', 'committed_at', 'grant_revisions', 'source_versions', 'capability_versions', 'budget_used', 'resumable']);
  return { step_id: name(value.step_id), committed_at: instant(value.committed_at),
    grant_revisions: keyedMap(value.grant_revisions, uuid, parseExpectedRevision),
    source_versions: keyedMap(value.source_versions, uuid, sha),
    capability_versions: keyedMap(value.capability_versions, name, item => text(item, 64)),
    budget_used: budgetUsed(value.budget_used), resumable: boolean(value.resumable) };
}
function runError(value) {
  if (value === null || value === undefined) return null;
  object(value, ['code', 'message', 'retryable', 'retry_after_seconds', 'next_action']);
  if (!ERROR_CODES.includes(value.code)) invalidInput();
  // Reconstruct rather than storing an arbitrary imported message.
  return new LearnBridgeError(value.code, value).toJSON();
}

/** @returns {Run} */
export function parseRun(value) {
  object(value, [...META, ...parseRun.fields]);
  const meta = metadata(value);
  const grants = array(value.grants, CORE_LIMITS.run_grants, item => {
    object(item, ['grant_id', 'revision']);
    return { grant_id: uuid(item.grant_id), revision: parseExpectedRevision(item.revision) };
  });
  const capabilities = array(value.capabilities, CORE_LIMITS.run_capabilities, item => {
    object(item, ['name', 'version']);
    return { name: name(item.name), version: text(item.version, 64) };
  });
  if (new Set(grants.map(item => item.grant_id)).size !== grants.length
    || new Set(capabilities.map(item => item.name)).size !== capabilities.length) invalidInput();
  const result = { ...meta, recipe_id: name(value.recipe_id), recipe_version: text(value.recipe_version, 64),
    state: enumeration(value.state, Object.keys(RUN_TRANSITIONS)), grants, capabilities,
    budget: budget(value.budget), checkpoint: checkpoint(value.checkpoint), error: runError(value.error),
    evidence_refs: array(value.evidence_refs ?? [], CORE_LIMITS.run_evidence, ref, true) };
  if (result.checkpoint) {
    if (Date.parse(result.checkpoint.committed_at) > Date.parse(result.updated_at)) invalidInput();
    for (const key of BUDGET_FIELDS) if (result.checkpoint.budget_used[key] > result.budget.used[key]) invalidInput();
    for (const [id, revision] of Object.entries(result.checkpoint.grant_revisions)) {
      if (!grants.some(item => item.grant_id === id && item.revision === revision)) invalidInput();
    }
    for (const [capabilityName, version] of Object.entries(result.checkpoint.capability_versions)) {
      if (!capabilities.some(item => item.name === capabilityName && item.version === version)) invalidInput();
    }
  }
  return result;
}
parseRun.fields = ['recipe_id', 'recipe_version', 'state', 'grants', 'capabilities', 'budget', 'checkpoint', 'error', 'evidence_refs'];
export function createRun(input, options = {}) {
  object(input, ['student_id', ...parseRun.fields]);
  return creation({ state: 'created', checkpoint: null, error: null, ...input }, options, parseRun);
}

/**
 * Resume checks snapshots again; a resumable boolean alone is not sufficient.
 * Current active grant revisions must have been obtained by trusted policy code.
 */
export function validateCheckpointForResume(value, context) {
  const saved = checkpoint(value);
  if (!saved || !saved.resumable) throw new LearnBridgeError('VERSION_MISMATCH', { next_action: 'refresh' });
  object(context, ['grant_revisions', 'source_versions', 'capability_versions', 'budget_used']);
  const grants = keyedMap(context.grant_revisions, uuid, parseExpectedRevision);
  const sources = keyedMap(context.source_versions, uuid, sha);
  const capabilities = keyedMap(context.capability_versions, name, item => text(item, 64));
  const used = budgetUsed(context.budget_used);
  for (const [id, revision] of Object.entries(saved.grant_revisions)) {
    if (grants[id] !== revision) throw new LearnBridgeError('CONSENT_REQUIRED', { next_action: 'review_scope' });
  }
  for (const [id, hash] of Object.entries(saved.source_versions)) {
    if (sources[id] !== hash) throw new LearnBridgeError('VERSION_MISMATCH', { next_action: 'refresh' });
  }
  for (const [capabilityName, version] of Object.entries(saved.capability_versions)) {
    if (capabilities[capabilityName] !== version) throw new LearnBridgeError('VERSION_MISMATCH', { next_action: 'refresh' });
  }
  for (const key of BUDGET_FIELDS) if (used[key] < saved.budget_used[key]) invalidInput();
  return saved;
}

/** State transitions do not execute tools or certify an external outcome. */
export function transitionRun(value, nextState, options = {}) {
  const run = parseRun(value);
  object(options, ['now', 'current_context']);
  enumeration(nextState, Object.keys(RUN_TRANSITIONS));
  if (!RUN_TRANSITIONS[run.state].includes(nextState)) invalidInput();
  let resumedBudget = run.budget;
  if (nextState === 'ready' && ['failed', 'partial', 'interrupted'].includes(run.state)) {
    validateCheckpointForResume(run.checkpoint, options.current_context);
    for (const key of BUDGET_FIELDS) {
      if (options.current_context.budget_used[key] < run.budget.used[key]) invalidInput();
    }
    resumedBudget = budget({ ...run.budget, used: options.current_context.budget_used });
  }
  const now = options.now === undefined ? new Date().toISOString() : instant(options.now);
  if (Date.parse(now) < Date.parse(run.updated_at)) invalidInput();
  return parseRun({ ...run, budget: resumedBudget, state: nextState, revision: run.revision + 1, updated_at: now });
}

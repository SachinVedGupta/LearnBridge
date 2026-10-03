import { createHash } from 'node:crypto';
import { createTask } from './contracts.mjs';

const MAX_BYTES = 1_000_000;
const MAX_TASKS = 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Zod 3's hosted UUID validation permits every hyphenated hexadecimal UUID,
// including nil/non-RFC variants. Preserve these opaque remote identities.
const HOSTED_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAMESPACE = Buffer.from('3c55b74b54cd5402bb1002a90fdc4a01', 'hex');
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** Invalid imports fail atomically. Messages expose locations, never private values. */
export class LegacyStateError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'LegacyStateError';
    this.code = code;
    this.path = path;
  }
}

function invalid(path, message, code = 'INVALID_LEGACY_STATE') {
  throw new LegacyStateError(code, path, message);
}

// Inspect descriptors instead of invoking accessors, to keep object imports pure.
// The returned clone is safe JSON; prototype keys are rejected at every level.
function cloneJson(value) {
  const seen = new Set();
  let nodes = 0;
  let textBytes = 0;
  function visit(item, path, depth) {
    if (++nodes > 20_000 || depth > 12) invalid(path, 'Import exceeds the structural limit.', 'IMPORT_TOO_LARGE');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) invalid(path, 'Import must contain finite JSON numbers.');
      return item;
    }
    if (typeof item === 'string') {
      textBytes += Buffer.byteLength(item, 'utf8');
      if (textBytes > MAX_BYTES) invalid(path, 'Import exceeds the text limit.', 'IMPORT_TOO_LARGE');
      return item;
    }
    if (typeof item !== 'object') invalid(path, 'Import must contain JSON data only.');
    const proto = Object.getPrototypeOf(item);
    if (Array.isArray(item) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) {
      invalid(path, 'Import must contain plain JSON objects and arrays.');
    }
    if (seen.has(item)) invalid(path, 'Import contains a cycle or reused object reference.');
    seen.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.getOwnPropertySymbols(item).length) invalid(path, 'Import cannot contain symbol properties.');
    if (Array.isArray(item)) {
      if (item.length > 10_000) invalid(path, 'Import array exceeds the item limit.', 'IMPORT_TOO_LARGE');
      const result = [];
      for (const key of Object.keys(descriptors)) {
        if (key === 'length') continue;
        if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length) invalid(path, 'Import arrays cannot have extra properties.');
      }
      for (let index = 0; index < item.length; index++) {
        const entry = descriptors[index];
        if (!entry || !Object.hasOwn(entry, 'value') || !entry.enumerable) invalid(`${path}[${index}]`, 'Import arrays cannot contain holes or accessors.');
        result.push(visit(entry.value, `${path}[${index}]`, depth + 1));
      }
      seen.delete(item);
      return result;
    }
    const result = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (FORBIDDEN_KEYS.has(key)) invalid(path, 'Import contains an unsafe property name.');
      textBytes += Buffer.byteLength(key, 'utf8');
      if (textBytes > MAX_BYTES) invalid(path, 'Import exceeds the text limit.', 'IMPORT_TOO_LARGE');
      if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid(path, 'Import objects cannot contain accessors or hidden properties.');
      // Arbitrary JSON property names may themselves contain private values.
      // Diagnostics use a structural placeholder; only the private backup
      // retains exact field names and values for reconciliation.
      result[key] = visit(descriptor.value, `${path}.field`, depth + 1);
    }
    seen.delete(item);
    return result;
  }
  return visit(value, '$', 0);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function deterministicId(studentId, snapshotHash, index) {
  const bytes = createHash('sha1').update(NAMESPACE).update(`${studentId.toLowerCase()}:${snapshotHash}:${index}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function calendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function stringField(task, key, index, max) {
  const value = task[key];
  if (typeof value !== 'string' || value.length > max) invalid(`$.value[${index}].${key}`, `Task ${key} must be a bounded string.`);
  return value;
}

/**
 * Plan, but never execute, an import from the existing hosted tasks schema.
 *
 * input: exact GET /api/state/tasks {value, revision}, or its tasks array.
 * options.studentId and importedAt are caller-provided local identity/import time;
 * importedAt is not a claim about the original tasks' creation times. Optional
 * timezone describes date-only deadlines without inventing an instant.
 *
 * The caller must transactionally persist the backup, pending records, mapping,
 * and snapshot hash. Blank legacy titles are retained as needs-review mappings,
 * not renamed or discarded. Do not mark a snapshot committed until all deferred
 * rows are resolved in a reviewed migration journal. existingSnapshotHashes
 * must come from committed import
 * journals scoped to studentId, and existingTaskIds must be student-owned.
 * Local IDs include studentId so two students' equal exports cannot collide.
 * A different snapshot requires review; it is not silently merged.
 * Neither this function nor its backup reads accounts/files or calls services.
 */
export function migrateHostedTasks(input, options) {
  const config = cloneJson(options);
  if (!config || Array.isArray(config) || typeof config !== 'object') invalid('options', 'Import options are required.');
  if (typeof config.studentId !== 'string' || !UUID.test(config.studentId)) invalid('options.studentId', 'A valid local student ID is required.');
  if (typeof config.importedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(config.importedAt) || !calendarDate(config.importedAt.slice(0, 10)) || Number(config.importedAt.slice(11, 13)) > 23 || Number(config.importedAt.slice(14, 16)) > 59 || Number(config.importedAt.slice(17, 19)) > 59 || !Number.isFinite(Date.parse(config.importedAt))) {
    invalid('options.importedAt', 'A UTC import timestamp is required.');
  }
  if (config.timezone !== undefined) {
    if (typeof config.timezone !== 'string' || config.timezone.length > 100 || /^[+-]/.test(config.timezone)) invalid('options.timezone', 'Timezone must be an IANA timezone.');
    try { new Intl.DateTimeFormat('en', { timeZone: config.timezone }); } catch { invalid('options.timezone', 'Timezone must be an IANA timezone.'); }
  }
  if (config.allowDateAlias !== undefined && typeof config.allowDateAlias !== 'boolean') invalid('options.allowDateAlias', 'Date-alias compatibility must be explicitly selected.');
  const hashes = config.existingSnapshotHashes ?? [];
  const ids = config.existingTaskIds ?? [];
  if (!Array.isArray(hashes) || hashes.length > 1_000 || hashes.some(hash => typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash))) invalid('options.existingSnapshotHashes', 'Committed import hashes are invalid.');
  if (!Array.isArray(ids) || ids.length > 10_000 || ids.some(id => typeof id !== 'string' || !UUID.test(id))) invalid('options.existingTaskIds', 'Existing local task IDs are invalid.');
  let originalText = null;
  let parsed = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > MAX_BYTES) invalid('$', 'Import exceeds the byte limit.', 'IMPORT_TOO_LARGE');
    originalText = input;
    try { parsed = JSON.parse(input); } catch { invalid('$', 'Import is not valid JSON.'); }
  }
  const original = cloneJson(parsed);
  const canonical = canonicalJson(original);
  if (Buffer.byteLength(canonical, 'utf8') > MAX_BYTES) invalid('$', 'Import exceeds the byte limit.', 'IMPORT_TOO_LARGE');
  const warnings = [];
  let tasks;
  let revision = null;
  if (Array.isArray(original)) {
    tasks = original;
  } else if (original && typeof original === 'object' && Object.hasOwn(original, 'value')) {
    if (!Number.isSafeInteger(original.revision) || original.revision < 0) invalid('$.revision', 'Hosted revision must be a nonnegative safe integer.');
    if (original.kind !== undefined && original.kind !== 'tasks') invalid('$.kind', 'This importer accepts hosted tasks only.');
    revision = original.revision;
    tasks = original.value;
    const fields = Object.keys(original).filter(key => !['value', 'revision', 'kind'].includes(key));
    if (fields.length) warnings.push({ code: 'UNMAPPED_ENVELOPE_FIELDS', path: '$', fields, disposition: 'preserved_in_backup' });
    if (tasks === null && revision === 0) tasks = [];
  } else {
    invalid('$', 'Expected the hosted tasks response or an explicit tasks array.');
  }
  if (!Array.isArray(tasks) || tasks.length > MAX_TASKS) invalid('$.value', 'Hosted tasks must be an array of at most 1000 tasks.');
  const snapshotHash = createHash('sha256').update('learnbridge-hosted-tasks-v1\0').update(canonical).digest('hex');
  const existing = new Set(ids.map(id => id.toLowerCase()));
  const alreadyImported = hashes.includes(snapshotHash);
  const mapping = [];
  const records = [];
  const remoteIds = new Set();
  for (const [index, task] of tasks.entries()) {
    if (!task || Array.isArray(task) || typeof task !== 'object') invalid(`$.value[${index}]`, 'Every hosted task must be an object.');
    const remoteId = stringField(task, 'id', index, 36);
    if (!HOSTED_UUID.test(remoteId)) invalid(`$.value[${index}].id`, 'Hosted task ID must be a UUID.');
    const title = stringField(task, 'title', index, 300);
    const course = stringField(task, 'course', index, 300);
    if (typeof task.done !== 'boolean') invalid(`$.value[${index}].done`, 'Hosted task completion must be a boolean.');
    const alias = !Object.hasOwn(task, 'due') && Object.hasOwn(task, 'date') && config.allowDateAlias === true;
    const dateField = alias ? 'date' : 'due';
    const due = stringField(task, dateField, index, 30);
    if (alias) warnings.push({ code: 'DATE_ALIAS_USED', path: `$.value[${index}].date`, disposition: 'mapped_explicit_compatibility' });
    const fields = Object.keys(task).filter(key => !['id', 'title', 'course', dateField, 'done'].includes(key));
    if (fields.length) warnings.push({ code: 'UNMAPPED_TASK_FIELDS', path: `$.value[${index}]`, fields, disposition: 'preserved_in_backup' });
    if (remoteIds.has(remoteId.toLowerCase())) warnings.push({ code: 'DUPLICATE_LEGACY_ID', path: `$.value[${index}].id`, disposition: 'preserved_as_distinct_task' });
    remoteIds.add(remoteId.toLowerCase());
    let deadline = { precision: 'unknown', reason: 'No deadline supplied.' };
    if (due !== '') {
      if (calendarDate(due)) deadline = { precision: 'date', date: due, original: due, ...(config.timezone ? { timezone: config.timezone } : {}) };
      else {
        deadline = { precision: 'unknown', reason: 'Legacy deadline requires reconciliation.', original: due };
        warnings.push({ code: 'INVALID_DEADLINE', path: `$.value[${index}].${dateField}`, disposition: 'original_retained_requires_review' });
      }
    }
    const localId = deterministicId(config.studentId, snapshotHash, index);
    const skip = alreadyImported || existing.has(localId);
    const blankTitle = title.trim().length === 0;
    mapping.push({ original_index: index, legacy_id: remoteId, local_id: localId, disposition: skip ? 'already_present' : blankTitle ? 'needs_review' : 'pending', deadline_field: dateField });
    if (blankTitle && !skip) warnings.push({ code: 'EMPTY_TASK_TITLE', path: `$.value[${index}].title`, disposition: 'source_retained_requires_review' });
    if (skip || blankTitle) continue;
    try {
      const record = createTask({ student_id: config.studentId, title, status: task.done ? 'completed' : 'pending', course_id: null, course_label: course, source_refs: [], deadline, dependency_ids: [], origin: 'migration', student_overrides: [] }, { id: localId, now: config.importedAt });
      records.push(record);
    } catch (error) {
      // Old Zod fields permitted control characters that the local contract
      // deliberately disallows. Preserve the valid hosted row for review.
      if (error?.code !== 'INVALID_INPUT') throw error;
      mapping.at(-1).disposition = 'needs_review';
      warnings.push({ code: 'LOCAL_CONTRACT_REQUIRES_REVIEW', path: `$.value[${index}]`, disposition: 'source_retained_requires_review' });
    }
  }
  if (!alreadyImported && hashes.length) warnings.push({ code: 'DIFFERENT_SNAPSHOT_REQUIRES_REVIEW', path: '$', disposition: 'no_automatic_merge_or_overwrite' });
  const skipped = mapping.filter(item => item.disposition === 'already_present').length;
  const deferred = mapping.filter(item => item.disposition === 'needs_review').length;
  if (!alreadyImported && skipped) warnings.push({ code: 'PARTIAL_REIMPORT', path: '$', disposition: 'only_missing_deterministic_ids_planned' });
  return {
    schema_version: 1,
    status: alreadyImported ? 'already_imported' : deferred ? 'requires_review' : 'ready',
    snapshot_hash: snapshotHash,
    source_revision: revision,
    source_count: tasks.length,
    pending_count: records.length,
    skipped_count: skipped,
    deferred_count: deferred,
    records,
    mapping,
    warnings,
    backup: {
      format: 'learnbridge-hosted-tasks-backup',
      schema_version: 1,
      source_schema: 'hosted.tasks.v1',
      snapshot_hash: snapshotHash,
      imported_at: config.importedAt,
      original_input: original,
      original_text: originalText,
    },
  };
}

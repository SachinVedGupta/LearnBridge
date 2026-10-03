import { createHash } from 'node:crypto';

export const ACADEMIC_SCHEMA_VERSION = 1;
export const AVENUE_AUDIT_COMMIT = '9f996323641aba91cc0bbf2b21efd429f9a465e1';
export const ACADEMIC_LIMITS = Object.freeze({ exportBytes: 1_000_000, outputBytes: 256_000, records: 2000, courses: 100, depth: 16, timeoutMs: 10_000, calls: 32 });
const categories = ['courses', 'assignments', 'announcements', 'materials'];
const errorCodes = ['AUTH_REQUIRED', 'AUTH_EXPIRED', 'SCOPE_DENIED', 'UNSUPPORTED', 'TIMEOUT', 'PROVIDER_FAILURE', 'CANCELLED', 'BUDGET_EXCEEDED', 'INVALID_INPUT'];
const messages = {
  INVALID_INPUT: 'The academic data or request does not match the reviewed format.',
  SCOPE_DENIED: 'This academic request is outside the selected institution, account or courses.',
  AUTH_REQUIRED: 'Sign in through the selected institution adapter before reading course data.',
  AUTH_EXPIRED: 'The institution session has expired. Sign in again through the selected adapter.',
  UNSUPPORTED: 'This academic operation or upstream schema is not supported.',
  TIMEOUT: 'The academic read exceeded its time limit.',
  CANCELLED: 'The academic read was cancelled.',
  BUDGET_EXCEEDED: 'The academic request exceeded its reviewed size or call limit.',
  PROVIDER_FAILURE: 'The academic source could not be read or validated.',
};

export class AcademicError extends Error {
  constructor(code) { super(messages[code] || messages.PROVIDER_FAILURE); this.name = 'AcademicError'; this.code = errorCodes.includes(code) ? code : 'PROVIDER_FAILURE'; }
  toJSON() { return { code: this.code, message: this.message }; }
}
const fail = (code = 'INVALID_INPUT') => { throw new AcademicError(code); };
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const fingerprint = value => hash(canonical(value));
function object(value, keys, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const props = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(props).some(key => typeof key !== 'string' || !keys.includes(key) || !('value' in props[key]) || !props[key].enumerable)
    || required.some(key => !Object.hasOwn(props, key))) fail();
  return value;
}
function boundedClone(value, maxBytes = ACADEMIC_LIMITS.exportBytes) {
  let nodes = 0; const seen = new Set();
  function visit(item, depth) {
    if (++nodes > 50_000 || depth > ACADEMIC_LIMITS.depth) fail('BUDGET_EXCEEDED');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object' || seen.has(item)) fail();
    seen.add(item);
    let result;
    if (Array.isArray(item)) {
      const props = Object.getOwnPropertyDescriptors(item);
      if (Reflect.ownKeys(props).some(key => key !== 'length' && (!/^\d+$/.test(String(key)) || !('value' in props[key]) || !props[key].enumerable)) || item.length > 10_000) fail();
      result = Array.from({ length: item.length }, (_, index) => { if (!Object.hasOwn(props, String(index))) fail(); return visit(props[index].value, depth + 1); });
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) fail();
      const props = Object.getOwnPropertyDescriptors(item);
      if (Reflect.ownKeys(props).some(key => typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key) || !('value' in props[key]) || !props[key].enumerable)) fail();
      result = Object.fromEntries(Object.keys(props).map(key => [key, visit(props[key].value, depth + 1)]));
    }
    seen.delete(item); return result;
  }
  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) fail('BUDGET_EXCEEDED');
  return result;
}
function text(value, max = 300, { empty = false } = {}) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (!empty && !value.trim())) fail();
  return value;
}
function sourceId(value) {
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value)) fail();
  return value;
}
function array(value, max, parse = item => item) {
  if (!Array.isArray(value) || value.length > max) fail('BUDGET_EXCEEDED');
  return value.map(parse);
}
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}
function knownInstant(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !validDate(match[1]) || +match[2] > 23 || +match[3] > 59 || +match[4] > 59) return null;
  if (match[6] !== 'Z' && (+match[6].slice(1, 3) > 23 || +match[6].slice(4) > 59)) return null;
  const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
function utcInstant(value) {
  const parsed = knownInstant(value);
  if (!parsed || !value.endsWith('Z')) fail();
  return parsed;
}
function timezone(value) {
  if (value === undefined || value === null) return null;
  text(value, 100);
  try { new Intl.DateTimeFormat('en', { timeZone: value }); } catch { fail(); }
  return value;
}
function institutionOrigin(value) {
  text(value, 2048);
  let url; try { url = new URL(value); } catch { fail(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || url.port || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(url.hostname)
    || !url.hostname.includes('.') || /^\d+(?:\.\d+){3}$/.test(url.hostname) || url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local') || url.hostname.endsWith('.internal')) fail('SCOPE_DENIED');
  return url.origin;
}
function safeUrl(value, origin) {
  if (value === undefined || value === null || value === '') return null;
  text(value, 2048);
  if (/^[\s]|[\s]$|[\u0000-\u001f\u007f]/.test(value) || value.startsWith('//')) fail('SCOPE_DENIED');
  let url; try { url = new URL(value, origin); } catch { fail('SCOPE_DENIED'); }
  if (url.origin !== origin || url.protocol !== 'https:' || url.username || url.password
    || [...url.searchParams.keys()].some(key => /token|key|secret|auth|session|password|^code$/i.test(key)) || /token=|secret=|password=|authorization=/i.test(url.hash)) fail('SCOPE_DENIED');
  return url.href;
}
function stableId(origin, account, category, course, source) {
  const bytes = Buffer.from(hash(canonical([origin, account, category, course || '', source])).slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 15) | 0x50; bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Date strings with lost/ambiguous precision remain reviewable source text. */
export function normalizeAcademicDeadline(value, defaultTimezone = null) {
  const zone = timezone(defaultTimezone);
  if (value === undefined || value === null || value === '') return { precision: 'unknown', reason: 'not_provided' };
  if (typeof value === 'object') {
    object(value, ['precision', 'date', 'instant', 'timezone', 'original', 'reason'], ['precision']);
    const original = value.original === undefined ? undefined : text(value.original, 300, { empty: true });
    if (value.precision === 'date' && validDate(value.date) && value.instant === undefined && value.reason === undefined) return { precision: 'date', date: value.date, timezone: timezone(value.timezone) ?? zone, ...(original === undefined ? {} : { original }) };
    if (value.precision === 'instant' && knownInstant(value.instant) && value.date === undefined && value.reason === undefined) return { precision: 'instant', instant: knownInstant(value.instant), timezone: timezone(value.timezone) ?? 'UTC', ...(original === undefined ? {} : { original }) };
    if (value.precision === 'unknown' && value.date === undefined && value.instant === undefined && value.timezone === undefined) return { precision: 'unknown', reason: value.reason === undefined ? 'not_provided' : text(value.reason, 100), ...(original === undefined ? {} : { original }) };
    fail();
  }
  const original = text(value, 300);
  if (validDate(original)) return { precision: 'date', date: original, timezone: zone, original };
  const instant = knownInstant(original);
  if (instant) return { precision: 'instant', instant, timezone: 'UTC', original };
  return { precision: 'unknown', reason: 'source_precision_unknown', original };
}

/** Strict student-selected export normalizer. No files, credentials or network. */
export function normalizeAcademicExport(raw, options) {
  const input = boundedClone(raw);
  object(input, ['schema_version', 'institution', 'account_ref', 'retrieved_at', ...categories, 'coverage', 'errors'], ['schema_version', 'institution', 'account_ref', 'retrieved_at', ...categories]);
  if (input.schema_version !== ACADEMIC_SCHEMA_VERSION) fail('UNSUPPORTED');
  object(input.institution, ['name', 'origin', 'timezone'], ['name', 'origin']);
  const institution = { name: text(input.institution.name, 150), origin: institutionOrigin(input.institution.origin), timezone: timezone(input.institution.timezone) };
  const account = sourceId(input.account_ref); const retrieved = utcInstant(input.retrieved_at);
  object(options, ['selectedCourseIds', 'previous'], ['selectedCourseIds']);
  const selected = [...new Set(array(options.selectedCourseIds, ACADEMIC_LIMITS.courses, sourceId))].sort();
  const chosen = new Set(selected);
  const warnings = []; const conflicts = []; const records = {};
  const counters = {};
  const knownCourses = new Set();
  for (const row of array(input.courses, ACADEMIC_LIMITS.courses)) {
    try { object(row, ['source_id', 'title', 'code', 'url'], ['source_id', 'title']); text(row.title); knownCourses.add(sourceId(row.source_id)); }
    catch (error) { if (!(error instanceof AcademicError)) throw error; }
  }
  for (const course of selected) if (!knownCourses.has(course)) warnings.push({ code: 'SELECTED_COURSE_MISSING', category: 'courses', source_id: course });
  const reported = input.coverage || {};
  object(reported, categories);
  const sourceErrors = array(input.errors || [], 100, row => {
    object(row, ['category', 'course_id', 'code'], ['category', 'code']);
    if (!categories.includes(row.category) || !errorCodes.includes(row.code)) fail();
    return { category: row.category, code: row.code, ...(row.course_id === undefined ? {} : { course_id: sourceId(row.course_id) }) };
  }).filter(row => !row.course_id || chosen.has(row.course_id));
  for (const category of categories) {
    const values = array(input[category], category === 'courses' ? ACADEMIC_LIMITS.courses : ACADEMIC_LIMITS.records);
    const unique = new Map(); const ambiguous = new Map(); let skipped = 0; let duplicate = 0;
    for (const rawRow of values) {
      try {
        const common = category === 'courses' ? ['source_id', 'title', 'code', 'url'] : category === 'assignments' ? ['source_id', 'course_id', 'title', 'description', 'due', 'url'] : category === 'announcements' ? ['source_id', 'course_id', 'title', 'body', 'published_at', 'url'] : ['source_id', 'course_id', 'title', 'body', 'url', 'type'];
        object(rawRow, common, category === 'courses' ? ['source_id', 'title'] : ['source_id', 'course_id', 'title']);
        const source = sourceId(rawRow.source_id); const course = category === 'courses' ? source : sourceId(rawRow.course_id);
        if (!chosen.has(course)) { skipped++; continue; }
        if (!knownCourses.has(course)) fail('SCOPE_DENIED');
        const row = { id: stableId(institution.origin, account, category, category === 'courses' ? null : course, source), source_id: source, ...(category === 'courses' ? {} : { course_id: course }), title: text(rawRow.title), url: safeUrl(rawRow.url, institution.origin) };
        if (category === 'courses') row.code = rawRow.code === undefined ? null : text(rawRow.code, 120, { empty: true });
        if (category === 'assignments') {
          row.description = rawRow.description === undefined ? '' : text(rawRow.description, 50_000, { empty: true });
          row.deadline = normalizeAcademicDeadline(rawRow.due, institution.timezone);
          if (row.deadline.precision === 'unknown' && row.deadline.original) warnings.push({ code: 'DEADLINE_NEEDS_REVIEW', category, source_id: source, course_id: course });
        }
        if (category === 'announcements') { row.body = rawRow.body === undefined ? '' : text(rawRow.body, 50_000, { empty: true }); row.published_at = normalizeAcademicDeadline(rawRow.published_at, institution.timezone); }
        if (category === 'materials') { row.body = rawRow.body === undefined ? '' : text(rawRow.body, 50_000, { empty: true }); row.type = rawRow.type === undefined ? 'unknown' : text(rawRow.type, 100); }
        row.source_hash = fingerprint(row);
        if (ambiguous.has(row.id)) {
          if (!ambiguous.get(row.id).some(item => item.source_hash === row.source_hash)) ambiguous.get(row.id).push(row); else duplicate++;
        } else if (unique.has(row.id)) {
          if (unique.get(row.id).source_hash === row.source_hash) duplicate++;
          else { ambiguous.set(row.id, [unique.get(row.id), row]); unique.delete(row.id); }
        } else unique.set(row.id, row);
      } catch (error) {
        if (!(error instanceof AcademicError)) throw error;
        skipped++; warnings.push({ code: error.code === 'SCOPE_DENIED' ? 'UNSAFE_OR_OUT_OF_SCOPE_ROW' : 'INVALID_ROW', category });
      }
    }
    for (const [id, variants] of ambiguous) conflicts.push({ category, id, variants });
    if (duplicate) warnings.push({ code: 'EXACT_DUPLICATE_COLLAPSED', category, count: duplicate });
    if (ambiguous.size) warnings.push({ code: 'CONFLICTING_DUPLICATE_NEEDS_REVIEW', category, count: ambiguous.size });
    records[category] = [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));
    const report = reported[category];
    if (report !== undefined) { object(report, ['state'], ['state']); if (!['complete', 'partial', 'unavailable', 'unknown'].includes(report.state)) fail(); }
    const bad = warnings.some(warning => warning.category === category && !['EXACT_DUPLICATE_COLLAPSED', 'DEADLINE_NEEDS_REVIEW'].includes(warning.code)) || sourceErrors.some(error => error.category === category);
    counters[category] = { state: bad ? 'partial' : report?.state || 'unknown', received: values.length, accepted: records[category].length, skipped, duplicates: duplicate, conflicts: ambiguous.size };
  }
  const changes = { added: [], changed: [], unchanged: [], missing: [] };
  const all = Object.values(records).flat();
  if (options.previous !== undefined) {
    const prior = boundedClone(options.previous);
    object(prior, ['format', 'schema_version', 'institution', 'account_ref', 'retrieved_at', 'selected_course_ids', ...categories, 'coverage', 'errors', 'warnings', 'conflicts', 'changes', 'snapshot_hash']);
    if (prior.format !== 'learnbridge-academic-snapshot' || prior.schema_version !== 1 || prior.account_ref !== account || prior.institution?.origin !== institution.origin || !/^[a-f0-9]{64}$/.test(prior.snapshot_hash || '')) fail('SCOPE_DENIED');
    const { snapshot_hash: priorHash, changes: priorChanges, ...priorPayload } = prior;
    if (fingerprint(priorPayload) !== priorHash) fail('INVALID_INPUT');
    const previous = new Map(categories.flatMap(category => array(prior[category], ACADEMIC_LIMITS.records).filter(row => chosen.has(category === 'courses' ? row.source_id : row.course_id))).map(row => [row.id, row.source_hash]));
    for (const row of all) { changes[!previous.has(row.id) ? 'added' : previous.get(row.id) === row.source_hash ? 'unchanged' : 'changed'].push(row.id); previous.delete(row.id); }
    changes.missing = [...previous.keys()].sort();
  } else changes.added = all.map(row => row.id);
  const payload = { format: 'learnbridge-academic-snapshot', schema_version: 1, institution, account_ref: account, retrieved_at: retrieved, selected_course_ids: selected, ...records, coverage: counters, errors: sourceErrors, warnings, conflicts };
  return boundedClone({ ...payload, changes, snapshot_hash: fingerprint(payload) });
}

const toolFields = Object.freeze({
  get_assignments: ['orgUnitId'], get_assignment: ['orgUnitId', 'assignmentId'], get_announcements: ['orgUnitId'],
  get_course_content: ['orgUnitId'], get_course_modules: ['orgUnitId'], get_course_module: ['orgUnitId', 'moduleId'],
  get_course_topic: ['orgUnitId', 'topicId'], get_upcoming_due_dates: ['orgUnitId', 'daysBack', 'daysAhead'],
});
export const AVENUE_READ_TOOLS = Object.freeze(Object.keys(toolFields));
function compatibleSchema(schema, fields) {
  if (!schema || schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) return false;
  if (schema.required !== undefined && !Array.isArray(schema.required)) return false;
  const names = Object.keys(schema.properties);
  if (names.some(name => !fields.includes(name)) || fields.some(field => !names.includes(field)) || (schema.required || []).some(name => !fields.includes(name))) return false;
  return names.every(name => ['number', 'integer'].includes(schema.properties[name]?.type) && !schema.properties[name].$ref);
}
function classified(error) {
  if (error instanceof AcademicError) return error;
  const description = typeof error?.message === 'string' ? error.message : '';
  if (/\b401\b|session.*expir|token.*expir|unauthenticated/i.test(description)) return new AcademicError('AUTH_EXPIRED');
  if (/\b403\b|permission denied|not authorized/i.test(description)) return new AcademicError('SCOPE_DENIED');
  if (error?.name === 'AbortError') return new AcademicError('CANCELLED');
  return new AcademicError('PROVIDER_FAILURE');
}
async function boundedCall(action, timeoutMs, signal) {
  if (signal?.aborted) fail('CANCELLED');
  const controller = new AbortController(); let timer; let onAbort;
  const stop = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new AcademicError('TIMEOUT')); }, timeoutMs);
    onAbort = () => { controller.abort(); reject(new AcademicError('CANCELLED')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(() => action(controller.signal)), stop]); }
  catch (error) { throw classified(error); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}
function checkedToolData(value, origin) {
  const data = boundedClone(value, ACADEMIC_LIMITS.outputBytes);
  function check(item) {
    if (Array.isArray(item)) return item.forEach(check);
    if (!item || typeof item !== 'object') return;
    for (const [key, value] of Object.entries(item)) {
      if (/password|secret|token|cookie|authorization|filepath|savepath/i.test(key)) fail('SCOPE_DENIED');
      if (['url', 'homeUrl', 'viewUrl', 'submitUrl'].includes(key)) safeUrl(value, origin);
      check(value);
    }
  }
  check(data); return data;
}

function assignmentRow(row) {
  object(row, ['id', 'name', 'dueDate', 'dueDateRelative', 'points', 'instructions', 'attachments', 'links', 'allowedFileTypes'], ['id', 'name']);
  numericId(row.id); text(row.name);
  for (const key of ['dueDate', 'dueDateRelative', 'allowedFileTypes']) if (row[key] !== undefined && row[key] !== null) text(row[key], 500, { empty: true });
  if (row.instructions !== undefined && row.instructions !== null) text(row.instructions, 50_000, { empty: true });
  if (row.points !== undefined && (!Number.isFinite(row.points) || row.points < 0)) fail();
  attachments(row.attachments);
  if (row.links !== undefined) array(row.links, 100, item => { object(item, ['name', 'url'], ['name', 'url']); text(item.name, 500); text(item.url, 2048); });
}
function numericId(value) { if (!Number.isSafeInteger(value) || value < 1) fail(); return value; }
function attachments(value) {
  if (value !== undefined) array(value, 100, item => { object(item, ['name', 'size'], ['name', 'size']); text(item.name, 500); text(item.size, 100); });
}
function topicRow(row, detail = false) {
  object(row, ['id', 'title', 'url', 'type', ...(detail ? ['description'] : [])], ['id', 'title']);
  numericId(row.id); text(row.title);
  for (const key of ['url', 'type', ...(detail ? ['description'] : [])]) if (row[key] !== undefined && row[key] !== null) text(row[key], key === 'description' ? 50_000 : 2048, { empty: true });
}
function moduleRow(row, depth = 0) {
  if (depth > 10) fail('BUDGET_EXCEEDED');
  object(row, ['id', 'title', 'description', 'topics', 'modules'], ['id', 'title']); numericId(row.id); text(row.title);
  if (row.description !== undefined && row.description !== null) text(row.description, 50_000, { empty: true });
  if (row.topics !== undefined) array(row.topics, ACADEMIC_LIMITS.records, item => topicRow(item));
  if (row.modules !== undefined) array(row.modules, ACADEMIC_LIMITS.records, item => moduleRow(item, depth + 1));
}
function validateToolData(name, data) {
  if (name === 'get_assignment') assignmentRow(data);
  else if (name === 'get_assignments') array(data, ACADEMIC_LIMITS.records, assignmentRow);
  else if (name === 'get_course_topic') topicRow(data, true);
  else if (name === 'get_course_module') moduleRow(data);
  else if (['get_course_content', 'get_course_modules'].includes(name)) array(data, ACADEMIC_LIMITS.records, moduleRow);
  else if (name === 'get_announcements') array(data, ACADEMIC_LIMITS.records, row => {
    object(row, ['id', 'title', 'body', 'date', 'attachments'], ['id', 'title', 'body']); numericId(row.id); text(row.title); text(row.body, 50_000, { empty: true });
    if (row.date !== undefined && row.date !== null) text(row.date, 500, { empty: true }); attachments(row.attachments);
  });
  else if (name === 'get_upcoming_due_dates') array(data, ACADEMIC_LIMITS.records, row => {
    object(row, ['title', 'dueDate', 'dueDateRelative', 'course', 'type', 'assignmentId', 'viewUrl', 'submitUrl', 'dateType', 'confidence'], ['title', 'course']); text(row.title); text(row.course, 500);
    for (const key of ['dueDate', 'dueDateRelative', 'type', 'viewUrl', 'submitUrl', 'dateType']) if (row[key] !== undefined && row[key] !== null) text(row[key], 2048, { empty: true });
    if (row.assignmentId !== undefined && row.assignmentId !== null) numericId(row.assignmentId);
    if (row.confidence !== undefined && typeof row.confidence !== 'string' && !Number.isFinite(row.confidence)) fail();
  });
}

/** Convert successful bounded reads into the same human-review export format. */
export function academicExportFromAvenueReads(reads, config) {
  object(config, ['institution', 'courses', 'accountRef', 'retrievedAt', 'selectedCourseIds', 'errors'], ['institution', 'courses', 'accountRef', 'retrievedAt', 'selectedCourseIds']);
  const origin = institutionOrigin(config.institution.origin); const account = sourceId(config.accountRef);
  const selected = new Set(array(config.selectedCourseIds, ACADEMIC_LIMITS.courses, sourceId));
  const exported = { schema_version: 1, institution: boundedClone(config.institution, 4096), account_ref: account, retrieved_at: utcInstant(config.retrievedAt), courses: boundedClone(config.courses), assignments: [], announcements: [], materials: [], coverage: Object.fromEntries(categories.map(category => [category, { state: 'unknown' }])), errors: config.errors || [] };
  function materials(module, course) {
    exported.materials.push({ source_id: `module:${module.id}`, course_id: course, title: module.title, body: module.description || '', type: 'module' });
    for (const topic of module.topics || []) exported.materials.push({ source_id: `topic:${topic.id}`, course_id: course, title: topic.title, url: topic.url || null, type: topic.type || 'topic' });
    for (const child of module.modules || []) materials(child, course);
  }
  for (const read of array(boundedClone(reads), ACADEMIC_LIMITS.calls)) {
    object(read, ['tool_name', 'course_id', 'account_ref', 'institution_origin', 'retrieved_at', 'proof', 'data', 'warnings'], ['tool_name', 'course_id', 'account_ref', 'institution_origin', 'data']);
    if (read.account_ref !== account || read.institution_origin !== origin || !selected.has(sourceId(read.course_id)) || !AVENUE_READ_TOOLS.includes(read.tool_name)) fail('SCOPE_DENIED');
    const data = checkedToolData(read.data, origin); validateToolData(read.tool_name, data); const course = sourceId(read.course_id);
    if (['get_assignment', 'get_assignments'].includes(read.tool_name)) for (const item of read.tool_name === 'get_assignment' ? [data] : data) exported.assignments.push({ source_id: String(item.id), course_id: course, title: item.name, description: item.instructions || '', due: item.dueDate || null });
    if (read.tool_name === 'get_announcements') for (const item of data) exported.announcements.push({ source_id: String(item.id), course_id: course, title: item.title, body: item.body, published_at: item.date || null });
    if (['get_course_content', 'get_course_modules', 'get_course_module'].includes(read.tool_name)) for (const item of read.tool_name === 'get_course_module' ? [data] : data) materials(item, course);
    if (read.tool_name === 'get_course_topic') exported.materials.push({ source_id: `topic:${data.id}`, course_id: course, title: data.title, body: data.description || '', url: data.url || null, type: data.type || 'topic' });
    // Calendar rows have heuristic date classifications and no stable event IDs
    // in this upstream format. They are read-only review data, not assignments.
  }
  normalizeAcademicExport(exported, { selectedCourseIds: [...selected] });
  return exported;
}

/**
 * Read-only policy around an already reviewed MCP client. This never launches
 * a server or authenticates. Session metadata is trusted host configuration,
 * not a receipt accepted from an HTTP/model request. The host must verify it.
 */
export function createAvenueReadAdapter(config) {
  object(config, ['client', 'institutionOrigin', 'accountRef', 'selectedCourseIds', 'session', 'proof', 'timeoutMs', 'maxCalls'], ['client', 'institutionOrigin', 'accountRef', 'selectedCourseIds']);
  if (!config.client || typeof config.client.listTools !== 'function' || typeof config.client.callTool !== 'function') fail();
  const origin = institutionOrigin(config.institutionOrigin); const account = sourceId(config.accountRef);
  const selected = new Set(array(config.selectedCourseIds, ACADEMIC_LIMITS.courses, sourceId));
  if ([...selected].some(value => !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))) fail();
  const proof = config.proof || 'fixture'; if (!['fixture', 'live'].includes(proof)) fail();
  const timeout = config.timeoutMs ?? ACADEMIC_LIMITS.timeoutMs; const maxCalls = config.maxCalls ?? ACADEMIC_LIMITS.calls;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000 || !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 100) fail();
  let session = config.session ? boundedClone(config.session, 4096) : null; let discovered = new Set(); let calls = 0; let authFailure = null; let sessionGeneration = 0; const verified = new Map();
  function authStatus() {
    if (authFailure) return authFailure;
    if (!session) return 'missing';
    object(session, ['account_ref', 'institution_origin', 'verified_at', 'expires_at'], ['account_ref', 'institution_origin', 'verified_at', 'expires_at']);
    if (sourceId(session.account_ref) !== account || institutionOrigin(session.institution_origin) !== origin) fail('SCOPE_DENIED');
    const expires = utcInstant(session.expires_at); const checked = utcInstant(session.verified_at);
    if (Date.parse(checked) > Date.now() || Date.parse(expires) <= Date.parse(checked)) fail();
    return Date.parse(expires) <= Date.now() ? 'expired' : 'ready';
  }
  function report() {
    const auth = authStatus();
    const state = auth !== 'ready' ? 'requires_auth' : discovered.size ? 'available' : 'unsupported';
    return { auth_status: auth, capability: { schema_version: 1, adapter_id: 'avenue_read', adapter_version: '0.1.0', account_ref: account, state,
      operations: AVENUE_READ_TOOLS.map(name => ({ name, state: auth !== 'ready' ? 'requires_auth' : discovered.has(name) ? 'available' : 'unsupported', proof: verified.has(name) ? proof : 'none', last_verified_at: verified.get(name) || null })), retrieved_at: new Date().toISOString() }, budget: { calls_used: calls, max_calls: maxCalls }, selected_course_count: selected.size };
  }
  function requireSameSession(generation) {
    const auth = authStatus();
    if (generation !== sessionGeneration || auth !== 'ready') fail(auth === 'expired' ? 'AUTH_EXPIRED' : 'AUTH_REQUIRED');
  }
  async function invoke(action, signal) {
    if (calls >= maxCalls) fail('BUDGET_EXCEEDED');
    calls++; const generation = sessionGeneration;
    try { return await boundedCall(action, timeout, signal); }
    catch (error) { if (error.code === 'AUTH_EXPIRED' && generation === sessionGeneration) authFailure = 'expired'; throw error; }
  }
  async function probe({ signal } = {}) {
    if (authStatus() !== 'ready') return report();
    const generation = sessionGeneration; const found = new Set(); const seen = new Set(); let cursor;
    for (let page = 0; page < 3; page++) {
      requireSameSession(generation);
      const rawResponse = await invoke(abort => config.client.listTools(cursor ? { cursor } : {}, { signal: abort }), signal);
      requireSameSession(generation);
      const response = boundedClone(rawResponse, ACADEMIC_LIMITS.outputBytes);
      object(response, ['tools', 'nextCursor', '_meta'], ['tools']);
      for (const tool of array(response.tools, 100)) {
        if (!tool || typeof tool !== 'object' || !AVENUE_READ_TOOLS.includes(tool.name)) continue;
        // Duplicate tool names do not establish an unambiguous capability.
        if (seen.has(tool.name)) { found.delete(tool.name); continue; }
        seen.add(tool.name);
        if (compatibleSchema(tool.inputSchema, toolFields[tool.name])) found.add(tool.name);
      }
      if (response.nextCursor === undefined) { discovered = found; return report(); }
      cursor = text(response.nextCursor, 200);
    }
    discovered = new Set(); fail('BUDGET_EXCEEDED');
  }
  async function read(name, rawArgs, { signal } = {}) {
    if (!AVENUE_READ_TOOLS.includes(name)) fail('UNSUPPORTED');
    const args = boundedClone(rawArgs, 4096); object(args, toolFields[name], ['orgUnitId']);
    if (!Number.isSafeInteger(args.orgUnitId) || !selected.has(String(args.orgUnitId))) fail('SCOPE_DENIED');
    for (const key of ['assignmentId', 'moduleId', 'topicId']) if (toolFields[name].includes(key) && (!Number.isSafeInteger(args[key]) || args[key] < 1)) fail();
    for (const key of ['daysBack', 'daysAhead']) if (args[key] !== undefined && (!Number.isInteger(args[key]) || args[key] < 0 || args[key] > 90)) fail();
    const auth = authStatus(); if (auth !== 'ready') fail(auth === 'expired' ? 'AUTH_EXPIRED' : 'AUTH_REQUIRED');
    if (!discovered.has(name)) fail('UNSUPPORTED');
    const generation = sessionGeneration;
    const rawResult = await invoke(abort => config.client.callTool({ name, arguments: args }, { signal: abort }), signal);
    requireSameSession(generation);
    const result = boundedClone(rawResult, ACADEMIC_LIMITS.outputBytes);
    object(result, ['content', 'isError', 'structuredContent', '_meta'], ['content']);
    const blocks = array(result.content, 4, block => { object(block, ['type', 'text', 'annotations', '_meta'], ['type', 'text']); if (block.type !== 'text') fail('UNSUPPORTED'); return text(block.text, ACADEMIC_LIMITS.outputBytes, { empty: true }); });
    if (result.isError !== undefined && typeof result.isError !== 'boolean') fail('PROVIDER_FAILURE');
    if (result.isError) {
      const error = classified(new Error(blocks.join('\n')));
      if (error.code === 'AUTH_EXPIRED') authFailure = 'expired';
      throw error;
    }
    if (blocks.length !== 1) fail('UNSUPPORTED');
    let data; try { data = JSON.parse(blocks[0]); } catch { fail('PROVIDER_FAILURE'); }
    data = checkedToolData(data, origin);
    if (['get_assignment', 'get_course_module', 'get_course_topic'].includes(name) ? !data || typeof data !== 'object' || Array.isArray(data) : !Array.isArray(data)) fail('PROVIDER_FAILURE');
    validateToolData(name, data);
    verified.set(name, new Date().toISOString());
    return { tool_name: name, course_id: String(args.orgUnitId), account_ref: account, institution_origin: origin, retrieved_at: new Date().toISOString(), proof, data, warnings: ['SOURCE_TEXT_IS_UNTRUSTED', ...(name.includes('assignment') || name === 'get_upcoming_due_dates' ? ['UPSTREAM_FORMATTED_DATES_REQUIRE_REVIEW'] : [])] };
  }
  function setSession(next) {
    const prior = session; const priorFailure = authFailure;
    session = boundedClone(next, 4096); authFailure = null;
    try { authStatus(); } catch (error) { session = prior; authFailure = priorFailure; throw error; }
    sessionGeneration++; discovered = new Set(); verified.clear();
  }
  return Object.freeze({ probe, read, capabilityReport: report, setSession });
}

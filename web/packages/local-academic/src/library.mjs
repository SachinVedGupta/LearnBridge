import { createHash } from 'node:crypto';
import { AcademicError } from './index.mjs';

const MAX_BYTES = 4_000_000;
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const fingerprint = value => hash(canonical(value));
const fail = (code = 'INVALID_INPUT') => { throw new AcademicError(code); };
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function clone(value) {
  let count = 0;
  const ancestors = new Set();
  function walk(item, depth) {
    if (++count > 100_000 || depth > 18) fail('BUDGET_EXCEEDED');
    if (item === null || typeof item === 'boolean' || typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item))) return item;
    if (!item || typeof item !== 'object' || ancestors.has(item)) fail();
    const props = Object.getOwnPropertyDescriptors(item);
    ancestors.add(item);
    let result;
    if (Array.isArray(item)) {
      if (item.length > 20_000 || Reflect.ownKeys(props).some(key => key !== 'length' && (!/^\d+$/.test(String(key)) || !('value' in props[key]) || !props[key].enumerable))) fail();
      result = Array.from({ length: item.length }, (_, index) => { if (!Object.hasOwn(props, String(index))) fail(); return walk(props[index].value, depth + 1); });
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item)) || Reflect.ownKeys(props).some(key => typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key) || !('value' in props[key]) || !props[key].enumerable)) fail();
      result = Object.fromEntries(Object.keys(props).map(key => [key, walk(props[key].value, depth + 1)]));
    }
    ancestors.delete(item); return result;
  }
  const result = walk(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) fail('BUDGET_EXCEEDED');
  return result;
}
function object(value, keys, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail();
}
function text(value, max = 1000, empty = false) { if (typeof value !== 'string' || value.length > max || value.includes('\0') || (!empty && !value.trim())) fail(); return value; }
function id(value) { text(value, 160); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) fail(); return value; }
function array(value, max = 2000) { if (!Array.isArray(value) || value.length > max) fail('BUDGET_EXCEEDED'); return value; }
function selections(value, max = 100) { return [...new Set(array(value, max).map(id))].sort(); }
function instant(value) { if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail(); return new Date(value).toISOString(); }
function sealed(payload, field = 'library_hash') { return { ...payload, [field]: fingerprint(payload) }; }

function verifiedSnapshot(value) {
  object(value, ['format', 'schema_version', 'institution', 'account_ref', 'retrieved_at', 'selected_course_ids', 'courses', 'assignments', 'announcements', 'materials', 'coverage', 'errors', 'warnings', 'conflicts', 'changes', 'snapshot_hash'], ['format', 'schema_version', 'institution', 'account_ref', 'retrieved_at', 'selected_course_ids', 'courses', 'assignments', 'announcements', 'materials', 'coverage', 'snapshot_hash']);
  if (value.format !== 'learnbridge-academic-snapshot' || value.schema_version !== 1 || !digest(value.snapshot_hash)) fail();
  const { snapshot_hash, changes, ...payload } = value;
  if (fingerprint(payload) !== snapshot_hash) fail();
  object(value.institution, ['name', 'origin', 'timezone'], ['name', 'origin', 'timezone']);
  text(value.institution.name); id(value.account_ref); instant(value.retrieved_at);
  let origin; try { origin = new URL(value.institution.origin); } catch { fail(); }
  if (origin.protocol !== 'https:' || origin.origin !== value.institution.origin || origin.username || origin.password) fail();
  const selected = new Set(selections(value.selected_course_ids));
  const seen = new Set();
  for (const category of ['courses', 'assignments', 'announcements', 'materials']) for (const row of array(value[category])) {
    const keys = category === 'courses' ? ['id', 'source_id', 'title', 'url', 'code', 'source_hash'] : category === 'assignments' ? ['id', 'source_id', 'course_id', 'title', 'url', 'description', 'deadline', 'source_hash'] : category === 'announcements' ? ['id', 'source_id', 'course_id', 'title', 'url', 'body', 'published_at', 'source_hash'] : ['id', 'source_id', 'course_id', 'title', 'url', 'body', 'type', 'source_hash'];
    object(row, keys, keys); id(row.id); id(row.source_id); text(row.title); if (seen.has(row.id)) fail(); seen.add(row.id);
    if (!selected.has(category === 'courses' ? row.source_id : id(row.course_id))) fail('SCOPE_DENIED');
    if (row.url !== null) { let url; try { url = new URL(row.url); } catch { fail(); } if (url.origin !== origin.origin || url.username || url.password || [...url.searchParams.keys()].some(key => /token|key|secret|auth|session|password|^code$/i.test(key))) fail('SCOPE_DENIED'); }
    const { source_hash, ...sourcePayload } = row;
    if (!digest(source_hash) || fingerprint(sourcePayload) !== source_hash) fail();
    if (category !== 'courses') text(category === 'assignments' ? row.description : row.body, 50_000, true);
  }
  return value;
}

function chunksFor(source, units) {
  const chunks = [];
  for (const unit of units) {
    const lines = unit.text.split(/\r\n|\n|\r/); let heading = null;
    for (let offset = 0; offset < lines.length;) {
      const first = offset; let selected = []; let bytes = 0; const initialHeading = heading;
      while (offset < lines.length && selected.length < 24) {
        const line = lines[offset]; const size = Buffer.byteLength(line + '\n');
        if (bytes + size > 6000 && selected.length) break;
        // Long single lines are split into exact Unicode-safe slices with byte-bounded excerpts.
        if (size > 6000) break;
        if (source.format === 'markdown' && /^#{1,6}\s+/.test(line) && selected.length) break;
        if (source.format === 'markdown' && /^#{1,6}\s+/.test(line)) heading = line.replace(/^#{1,6}\s+/, '').trim();
        selected.push(line); bytes += size; offset++;
      }
      if (!selected.length) {
        const line = lines[offset++]; let start = 0; let part = ''; let partBytes = 0;
        for (const char of line) {
          const size = Buffer.byteLength(char);
          if (partBytes + size > 5800) { add(part, first + 1, first + 1, { char_start: start, char_end: start + part.length }); start += part.length; part = ''; partBytes = 0; }
          part += char; partBytes += size;
        }
        if (part.trim()) add(part, first + 1, first + 1, { char_start: start, char_end: start + part.length });
      } else if (selected.join('\n').trim()) add(selected.join('\n'), first + 1, offset);
      function add(content, lineStart, lineEnd, extra = {}) {
        const locator = { kind: source.format === 'pdf_text' ? 'pdf_page' : 'text_lines', line_start: lineStart, line_end: lineEnd, ...(unit.physical_page === undefined ? {} : { physical_page: unit.physical_page, ...(unit.printed_label === undefined ? {} : { printed_label: unit.printed_label }) }), ...(source.format === 'markdown' ? { heading: heading || initialHeading } : {}), ...extra };
        const payload = { source_id: source.source_id, version_hash: source.version_hash, course_id: source.course_id, text: content, locator };
        chunks.push({ ...payload, chunk_id: fingerprint(payload), text_hash: hash(content), untrusted: true });
      }
    }
  }
  return chunks;
}

/** Build an immutable, course-scoped retrieval recipe. No files, storage or model calls. */
export function buildAcademicLibrary(raw) {
  const input = clone(raw);
  object(input, ['snapshots', 'selectedCourseIds', 'texts', 'revokedSourceIds'], ['snapshots', 'selectedCourseIds']);
  const selected = selections(input.selectedCourseIds); const chosen = new Set(selected); const revoked = new Set(selections(input.revokedSourceIds || [], 2000));
  const snapshots = [...new Map(array(input.snapshots, 100).map(verifiedSnapshot).map(snapshot => [snapshot.snapshot_hash, snapshot])).values()].sort((a, b) => a.retrieved_at.localeCompare(b.retrieved_at) || a.snapshot_hash.localeCompare(b.snapshot_hash));
  const owners = new Set(snapshots.map(snapshot => `${snapshot.institution.origin}\0${snapshot.account_ref}`));
  if (owners.size > 1) fail('SCOPE_DENIED');
  const versions = new Map(); const current = new Map(); const coverage = [];
  function add(source, units) {
    if (!chosen.has(source.course_id) || revoked.has(source.source_id)) return;
    const key = `${source.source_id}:${source.version_hash}`;
    if (versions.has(key)) {
      const prior = versions.get(key); if (prior.content_hash !== source.content_hash || prior.course_id !== source.course_id || prior.format !== source.format) fail();
      const old = current.get(source.source_id);
      if (old && old.retrieved_at === source.retrieved_at && old.version_hash !== source.version_hash) fail();
      if (!old || old.retrieved_at < source.retrieved_at) { current.set(source.source_id, source); prior.retrieved_at = source.retrieved_at; }
      return;
    }
    const chunks = chunksFor(source, units); const candidate = { ...source, extraction_status: chunks.length ? 'available' : 'text_unavailable', chunks };
    const old = current.get(source.source_id);
    if (old && old.retrieved_at === source.retrieved_at && old.version_hash !== source.version_hash) fail('INVALID_INPUT');
    versions.set(key, candidate);
    if (!old || old.retrieved_at < source.retrieved_at) current.set(source.source_id, source);
  }
  for (const snapshot of snapshots) {
    coverage.push({ snapshot_hash: snapshot.snapshot_hash, retrieved_at: snapshot.retrieved_at, selected_course_ids: snapshot.selected_course_ids.filter(course => chosen.has(course)), categories: Object.fromEntries(['courses', 'assignments', 'announcements', 'materials'].map(category => [category, { state: snapshot.coverage[category].state, scoped_records: snapshot[category].filter(row => chosen.has(category === 'courses' ? row.source_id : row.course_id)).length, coverage_claim: 'source_reported' }])) });
    for (const category of ['assignments', 'announcements', 'materials']) for (const row of snapshot[category]) {
      const content = category === 'assignments' ? row.description : row.body;
      add({ source_id: row.id, version_hash: row.source_hash, course_id: row.course_id, title: row.title, category, format: 'text', url: row.url, parser_version: 'academic-export/1', retrieved_at: snapshot.retrieved_at, snapshot_hash: snapshot.snapshot_hash, content_hash: hash(content), ...(category === 'assignments' ? { deadline: row.deadline } : {}) }, [{ text: content }]);
    }
  }
  for (const record of array(input.texts || [], 2000)) {
    object(record, ['source_id', 'version_hash', 'course_id', 'title', 'format', 'text', 'pages', 'parser_version', 'retrieved_at'], ['source_id', 'version_hash', 'course_id', 'title', 'format', 'parser_version', 'retrieved_at']);
    id(record.source_id); id(record.course_id); text(record.title); text(record.parser_version, 100); if (!digest(record.version_hash)) fail();
    const retrieved_at = instant(record.retrieved_at); let units;
    if (['text', 'markdown'].includes(record.format)) { if (record.pages !== undefined) fail(); units = [{ text: text(record.text, 1_000_000, true) }]; if (hash(record.text) !== record.version_hash) fail(); }
    else if (record.format === 'pdf_text') {
      if (record.text !== undefined) fail(); let last = 0;
      units = array(record.pages, 1000).map(page => { object(page, ['physical_page', 'printed_label', 'text'], ['physical_page', 'text']); if (!Number.isInteger(page.physical_page) || page.physical_page <= last || page.physical_page > 10000) fail(); last = page.physical_page; text(page.text, 200_000, true); if (page.printed_label !== undefined) text(page.printed_label, 100, true); return page; });
    } else fail('UNSUPPORTED');
    add({ source_id: record.source_id, version_hash: record.version_hash, course_id: record.course_id, title: record.title, format: record.format, category: 'selected_file', url: null, parser_version: record.parser_version, retrieved_at, content_hash: fingerprint(units) }, units);
  }
  const sources = [...versions.values()].map(source => ({ ...source, status: current.get(source.source_id)?.version_hash === source.version_hash ? 'current' : 'historical' })).sort((a, b) => a.source_id.localeCompare(b.source_id) || a.version_hash.localeCompare(b.version_hash));
  return clone(sealed({ format: 'learnbridge-academic-library', schema_version: 1, selected_course_ids: selected, sources, coverage, revoked_source_count: revoked.size }));
}

function verifiedLibrary(raw) {
  const library = clone(raw);
  object(library, ['format', 'schema_version', 'selected_course_ids', 'sources', 'coverage', 'revoked_source_count', 'library_hash'], ['format', 'schema_version', 'selected_course_ids', 'sources', 'coverage', 'revoked_source_count', 'library_hash']);
  const { library_hash, ...payload } = library;
  if (library.format !== 'learnbridge-academic-library' || library.schema_version !== 1 || !digest(library_hash) || fingerprint(payload) !== library_hash) fail();
  const courses = new Set(selections(library.selected_course_ids)); const versions = new Set(); const current = new Set();
  if (!Number.isInteger(library.revoked_source_count) || library.revoked_source_count < 0 || library.revoked_source_count > 2000) fail();
  for (const source of array(library.sources, 10_000)) {
    object(source, ['source_id', 'version_hash', 'course_id', 'title', 'format', 'category', 'url', 'parser_version', 'retrieved_at', 'snapshot_hash', 'content_hash', 'deadline', 'extraction_status', 'chunks', 'status'], ['source_id', 'version_hash', 'course_id', 'title', 'format', 'category', 'url', 'parser_version', 'retrieved_at', 'content_hash', 'extraction_status', 'chunks', 'status']);
    id(source.source_id); id(source.course_id); text(source.title); text(source.parser_version, 100); instant(source.retrieved_at);
    if (!courses.has(source.course_id) || !digest(source.version_hash) || !digest(source.content_hash) || !['text', 'markdown', 'pdf_text'].includes(source.format) || !['assignments', 'announcements', 'materials', 'selected_file'].includes(source.category) || !['current', 'historical'].includes(source.status) || !['available', 'text_unavailable'].includes(source.extraction_status)) fail();
    const key = `${source.source_id}:${source.version_hash}`; if (versions.has(key) || (source.status === 'current' && current.has(source.source_id))) fail(); versions.add(key); if (source.status === 'current') current.add(source.source_id);
    if (source.snapshot_hash !== undefined && !digest(source.snapshot_hash)) fail();
    if (source.url !== null) { text(source.url, 2048); let url; try { url = new URL(source.url); } catch { fail(); } if (url.protocol !== 'https:' || url.username || url.password || [...url.searchParams.keys()].some(key => /token|key|secret|auth|session|password|^code$/i.test(key))) fail(); }
    const chunks = array(source.chunks, 10_000); if ((source.extraction_status === 'text_unavailable') !== (chunks.length === 0)) fail(); const chunkIds = new Set();
    for (const chunk of chunks) {
      object(chunk, ['source_id', 'version_hash', 'course_id', 'text', 'locator', 'chunk_id', 'text_hash', 'untrusted'], ['source_id', 'version_hash', 'course_id', 'text', 'locator', 'chunk_id', 'text_hash', 'untrusted']);
      if (chunk.source_id !== source.source_id || chunk.version_hash !== source.version_hash || chunk.course_id !== source.course_id || chunk.untrusted !== true || !digest(chunk.chunk_id) || !digest(chunk.text_hash) || chunkIds.has(chunk.chunk_id)) fail(); chunkIds.add(chunk.chunk_id);
      text(chunk.text, 6000); if (Buffer.byteLength(chunk.text) > 6000 || hash(chunk.text) !== chunk.text_hash) fail();
      object(chunk.locator, ['kind', 'line_start', 'line_end', 'physical_page', 'printed_label', 'heading', 'char_start', 'char_end'], ['kind', 'line_start', 'line_end']); const locator = chunk.locator;
      if (!['text_lines', 'pdf_page'].includes(locator.kind) || !Number.isInteger(locator.line_start) || !Number.isInteger(locator.line_end) || locator.line_start < 1 || locator.line_end < locator.line_start) fail();
      if (source.format === 'pdf_text') { if (locator.kind !== 'pdf_page' || !Number.isInteger(locator.physical_page) || locator.physical_page < 1 || locator.physical_page > 10000) fail(); } else if (locator.kind !== 'text_lines' || locator.physical_page !== undefined || locator.printed_label !== undefined) fail();
      if (locator.printed_label !== undefined) text(locator.printed_label, 100, true); if (locator.heading !== undefined && locator.heading !== null) { if (source.format !== 'markdown') fail(); text(locator.heading, 6000); }
      if ((locator.char_start === undefined) !== (locator.char_end === undefined) || (locator.char_start !== undefined && (!Number.isInteger(locator.char_start) || !Number.isInteger(locator.char_end) || locator.char_start < 0 || locator.char_end <= locator.char_start || locator.char_end - locator.char_start !== chunk.text.length))) fail();
      const { chunk_id, text_hash, untrusted, ...chunkPayload } = chunk; if (fingerprint(chunkPayload) !== chunk_id) fail();
    }
  }
  for (const row of array(library.coverage, 100)) {
    object(row, ['snapshot_hash', 'retrieved_at', 'selected_course_ids', 'categories'], ['snapshot_hash', 'retrieved_at', 'selected_course_ids', 'categories']); if (!digest(row.snapshot_hash) || selections(row.selected_course_ids).some(course => !courses.has(course))) fail(); instant(row.retrieved_at);
    object(row.categories, ['courses', 'assignments', 'announcements', 'materials'], ['courses', 'assignments', 'announcements', 'materials']);
    for (const value of Object.values(row.categories)) { object(value, ['state', 'scoped_records', 'coverage_claim'], ['state', 'scoped_records', 'coverage_claim']); if (!['complete', 'partial', 'unavailable', 'unknown'].includes(value.state) || !Number.isInteger(value.scoped_records) || value.scoped_records < 0 || value.coverage_claim !== 'source_reported') fail(); }
  }
  return library;
}
function filterCourses(library, values) {
  const requested = selections(values); const approved = new Set(library.selected_course_ids);
  if (requested.some(course => !approved.has(course))) fail('SCOPE_DENIED');
  return new Set(requested);
}
function tokens(value) { return [...new Set(value.normalize('NFKC').toLocaleLowerCase('en').match(/[\p{L}\p{N}_]+/gu) || [])]; }

/** Deterministic whole-token retrieval. Selection is a hard boundary, not a rank hint. */
export function searchAcademicLibrary(raw, rawOptions) {
  const library = verifiedLibrary(raw); const options = clone(rawOptions);
  object(options, ['query', 'courseIds', 'limit'], ['query', 'courseIds']); const query = text(options.query, 500); const terms = tokens(query);
  if (terms.length < 1 || terms.length > 32) fail(); const limit = options.limit ?? 5; if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail();
  const courses = filterCourses(library, options.courseIds); const results = [];
  for (const source of library.sources) {
    if (!courses.has(source.course_id) || source.status !== 'current' || source.extraction_status !== 'available') continue;
    const titleTokens = new Set(tokens(source.title));
    for (const chunk of source.chunks) {
      const words = tokens(chunk.text); const wordSet = new Set(words); const matched = terms.filter(term => wordSet.has(term) || titleTokens.has(term));
      if (!matched.length) continue;
      const score = matched.length * 100 + terms.filter(term => titleTokens.has(term)).length * 10 + (chunk.text.normalize('NFKC').toLocaleLowerCase('en').includes(query.normalize('NFKC').toLocaleLowerCase('en')) ? 5 : 0);
      results.push({ source_id: source.source_id, version_hash: source.version_hash, chunk_id: chunk.chunk_id, course_id: source.course_id, title: source.title, excerpt: chunk.text, locator: chunk.locator, retrieved_at: source.retrieved_at, parser_version: source.parser_version, score, matched_terms: matched, untrusted: true });
    }
  }
  results.sort((a, b) => b.score - a.score || a.source_id.localeCompare(b.source_id) || a.locator.line_start - b.locator.line_start || a.chunk_id.localeCompare(b.chunk_id));
  return { query, selected_course_ids: [...courses].sort(), results: results.slice(0, limit), total_matching_chunks: results.length, coverage: library.coverage.map(item => ({ snapshot_hash: item.snapshot_hash, retrieved_at: item.retrieved_at, selected_course_ids: item.selected_course_ids.filter(course => courses.has(course)), categories: Object.fromEntries(Object.entries(item.categories).map(([category, value]) => [category, { state: value.state, scoped_records: [...courses].every(course => item.selected_course_ids.includes(course)) && courses.size === item.selected_course_ids.length ? value.scoped_records : null, coverage_claim: value.coverage_claim }])) })), library_hash: library.library_hash };
}

/** Resolve exact immutable evidence; historical references are never silently retargeted. */
export function resolveAcademicCitation(raw, rawOptions) {
  const library = verifiedLibrary(raw); const options = clone(rawOptions);
  object(options, ['source_id', 'version_hash', 'chunk_id', 'courseIds'], ['source_id', 'version_hash', 'chunk_id', 'courseIds']); id(options.source_id); if (!digest(options.version_hash) || !digest(options.chunk_id)) fail();
  const courses = filterCourses(library, options.courseIds);
  const source = library.sources.find(item => item.source_id === options.source_id && item.version_hash === options.version_hash && courses.has(item.course_id));
  const chunk = source?.chunks.find(item => item.chunk_id === options.chunk_id);
  if (!chunk) fail('SCOPE_DENIED');
  return { source_id: source.source_id, version_hash: source.version_hash, course_id: source.course_id, title: source.title, status: source.status, retrieved_at: source.retrieved_at, text: chunk.text, text_hash: chunk.text_hash, locator: chunk.locator, chunk_id: chunk.chunk_id, untrusted: true };
}

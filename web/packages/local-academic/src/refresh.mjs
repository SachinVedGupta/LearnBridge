import { createHash } from 'node:crypto';
import { AcademicError } from './index.mjs';
import { validateAcademicSnapshot } from './library.mjs';

const CATEGORIES = ['courses', 'assignments', 'announcements', 'materials'];
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const fingerprint = value => createHash('sha256').update(canonical(value)).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const fail = (code = 'INVALID_INPUT') => { throw new AcademicError(code); };
function clone(value) {
  let nodes = 0; const ancestors = new Set();
  function walk(item, depth) {
    if (++nodes > 100_000 || depth > 18) fail('BUDGET_EXCEEDED');
    if (item === null || typeof item === 'boolean' || typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item))) return item;
    if (!item || typeof item !== 'object' || ancestors.has(item)) fail();
    const props = Object.getOwnPropertyDescriptors(item); ancestors.add(item); let result;
    if (Array.isArray(item)) {
      if (item.length > 20_000 || Reflect.ownKeys(props).some(key => key !== 'length' && (!/^\d+$/.test(String(key)) || !('value' in props[key]) || !props[key].enumerable))) fail();
      result = Array.from({ length: item.length }, (_, index) => { if (!Object.hasOwn(props, String(index))) fail(); return walk(props[index].value, depth + 1); });
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item)) || Reflect.ownKeys(props).some(key => typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key) || !('value' in props[key]) || !props[key].enumerable)) fail();
      result = Object.fromEntries(Object.keys(props).map(key => [key, walk(props[key].value, depth + 1)]));
    }
    ancestors.delete(item); return result;
  }
  const result = walk(value, 0); if (Buffer.byteLength(JSON.stringify(result)) > 4_000_000) fail('BUDGET_EXCEEDED'); return result;
}
function object(value, keys, required = keys) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail(); }
function scopeOf(snapshot) {
  if (!snapshot.selected_course_ids.length) fail('SCOPE_DENIED');
  return { institution_origin: snapshot.institution.origin, account_ref: snapshot.account_ref, selected_course_ids: [...snapshot.selected_course_ids], category_scope: [...CATEGORIES] };
}
function semanticOf(snapshot) {
  // Row identities/hashes and conservative safety states matter; observation time,
  // traversal order and counted exact duplicates do not create content versions.
  const sortUnique = values => [...new Map(values.map(value => [canonical(value), value])).values()].sort((a, b) => compare(canonical(a), canonical(b)));
  return fingerprint({
    format: 'learnbridge-academic-semantic', schema_version: 1, scope: scopeOf(snapshot), institution: snapshot.institution,
    records: Object.fromEntries(CATEGORIES.map(category => [category, snapshot[category].map(row => ({ id: row.id, source_hash: row.source_hash })).sort((a, b) => compare(a.id, b.id))])),
    coverage: Object.fromEntries(CATEGORIES.map(category => [category, snapshot.coverage[category].state])),
    errors: sortUnique(snapshot.errors || []),
    warnings: sortUnique((snapshot.warnings || []).filter(row => row.code !== 'EXACT_DUPLICATE_COLLAPSED').map(({ count, ...warning }) => warning)),
    conflicts: (snapshot.conflicts || []).map(row => ({ category: row.category, id: row.id, variants: row.variants.map(variant => variant.source_hash).sort() })).sort((a, b) => compare(a.id, b.id)),
  });
}

/** Exact institution/account/course/category selection, separate from local consent. */
export function academicRefreshScope(raw) { return scopeOf(validateAcademicSnapshot(raw)); }
export function academicStreamKey(raw) { return fingerprint({ format: 'learnbridge-academic-stream', schema_version: 1, ...academicRefreshScope(raw) }); }
export function academicSemanticHash(raw) { return semanticOf(validateAcademicSnapshot(raw)); }

function reference(snapshot, row, category) {
  return { snapshot_hash: snapshot.snapshot_hash, retrieved_at: snapshot.retrieved_at, source_hash: row.source_hash, title: row.title, course_id: category === 'courses' ? row.source_id : row.course_id, url: row.url, ...(category === 'assignments' ? { deadline: row.deadline } : {}), ...(category === 'announcements' ? { published_at: row.published_at } : {}) };
}
function differences(snapshot, previous) {
  const changes = { added: [], changed: [], unchanged: [], not_returned: [], conflicted: [] };
  for (const category of CATEGORIES) {
    const prior = new Map((previous?.[category] || []).map(row => [row.id, row]));
    const conflicted = new Set((snapshot.conflicts || []).filter(row => row.category === category).map(row => row.id));
    for (const row of snapshot[category]) {
      const old = prior.get(row.id); const kind = !old ? 'added' : old.source_hash === row.source_hash ? 'unchanged' : 'changed';
      changes[kind].push({ category, id: row.id, before: old ? reference(previous, old, category) : null, after: reference(snapshot, row, category) }); prior.delete(row.id);
    }
    for (const conflict of (snapshot.conflicts || []).filter(row => row.category === category)) {
      const old = prior.get(conflict.id); prior.delete(conflict.id);
      changes.conflicted.push({ category, id: conflict.id, before: old ? reference(previous, old, category) : null, after: null, reason: 'conflicting_source_variants', coverage_state: snapshot.coverage[category].state, variants: conflict.variants.map(row => reference(snapshot, row, category)).sort((a, b) => compare(a.source_hash, b.source_hash)) });
    }
    for (const row of prior.values()) if (!conflicted.has(row.id)) changes.not_returned.push({ category, id: row.id, before: reference(previous, row, category), after: null, reason: 'not_seen_in_this_export', coverage_state: snapshot.coverage[category].state });
  }
  for (const entries of Object.values(changes)) entries.sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || compare(a.id, b.id));
  return changes;
}

function checkedBaseline(raw, streamKey) {
  if (raw === null || raw === undefined) return null;
  object(raw, ['stream_key', 'head_id', 'revision', 'current_snapshot_id', 'current_snapshot_hash', 'current_semantic_hash', 'snapshot']);
  if (raw.stream_key !== streamKey) fail('SCOPE_DENIED');
  if (!UUID.test(raw.current_snapshot_id || '') || !SHA.test(raw.current_snapshot_hash || '') || !SHA.test(raw.current_semantic_hash || '') || !Number.isSafeInteger(raw.revision) || (raw.head_id === null ? raw.revision !== 0 : !UUID.test(raw.head_id || '') || raw.revision < 1)) fail();
  const snapshot = validateAcademicSnapshot(raw.snapshot);
  if (academicStreamKey(snapshot) !== streamKey) fail('SCOPE_DENIED');
  if (snapshot.snapshot_hash !== raw.current_snapshot_hash || semanticOf(snapshot) !== raw.current_semantic_hash) fail();
  return { ...raw, snapshot };
}

/** A reviewable refresh recipe. This neither publishes snapshots nor mutates tasks. */
export function academicRefreshPreview(raw, rawOptions = {}) {
  const snapshot = validateAcademicSnapshot(raw); const options = clone(rawOptions); object(options, ['baseline'], []);
  const scope = scopeOf(snapshot); const streamKey = fingerprint({ format: 'learnbridge-academic-stream', schema_version: 1, ...scope });
  const baseline = checkedBaseline(options.baseline, streamKey); const semanticHash = semanticOf(snapshot);
  if (baseline && (snapshot.retrieved_at < baseline.snapshot.retrieved_at || (snapshot.retrieved_at === baseline.snapshot.retrieved_at && semanticHash !== baseline.current_semantic_hash))) fail();
  const payload = {
    format: 'learnbridge-academic-refresh-preview', schema_version: 1, stream_key: streamKey, scope,
    base: baseline ? { head_id: baseline.head_id, revision: baseline.revision, current_snapshot_id: baseline.current_snapshot_id, snapshot_hash: baseline.current_snapshot_hash, semantic_hash: baseline.current_semantic_hash } : { head_id: null, revision: 0, current_snapshot_id: null, snapshot_hash: null, semantic_hash: null },
    snapshot, semantic_hash: semanticHash, content_changed: !baseline || baseline.current_semantic_hash !== semanticHash,
    changes: differences(snapshot, baseline?.snapshot),
  };
  return clone({ ...payload, review_hash: fingerprint(payload) });
}

/** Recompute against a trusted persisted baseline; a browser-provided hash is not authority. */
export function validateAcademicRefreshPreview(raw, options = {}) {
  const preview = clone(raw);
  object(preview, ['format', 'schema_version', 'stream_key', 'scope', 'base', 'snapshot', 'semantic_hash', 'content_changed', 'changes', 'review_hash']);
  if (!SHA.test(preview.review_hash || '')) fail();
  const actual = academicRefreshPreview(preview.snapshot, options);
  if (canonical(actual) !== canonical(preview)) fail();
  return actual;
}

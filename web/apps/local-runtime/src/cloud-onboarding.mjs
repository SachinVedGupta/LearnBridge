import { createHash } from 'node:crypto';
import { LearnBridgeError } from '@learnbridge/core';

export const CLOUD_LIMITS = Object.freeze({ records: 3, textBytes: 20000, bundleBytes: 90000, searchResults: 20 });
export const CLOUD_PROVIDERS = Object.freeze(['googledocs', 'notion']);
const POLICIES = ['unrestricted', 'learning_support', 'graded_restricted'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const fail = (code = 'INVALID_INPUT') => { throw new LearnBridgeError(code); };
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
export const cloudHash = value => createHash('sha256').update(canonical(value)).digest('hex');
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');

/** Validate data before any getter, prototype, cycle or unbounded traversal. */
export function cloudCopy(input, maxBytes = CLOUD_LIMITS.bundleBytes) {
  let nodes = 0; const seen = new Set();
  function copy(value, depth) {
    if (++nodes > 12000 || depth > 12) fail('BUDGET_EXCEEDED');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') { if (value.includes('\0') || Buffer.byteLength(value) > maxBytes) fail('BUDGET_EXCEEDED'); return value; }
    if (!value || typeof value !== 'object' || seen.has(value)) fail();
    seen.add(value); const descriptors = Object.getOwnPropertyDescriptors(value); let result;
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 200 || Reflect.ownKeys(descriptors).length !== value.length + 1) fail();
      result = [];
      for (let index = 0; index < value.length; index++) { const descriptor = descriptors[index]; if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(); result.push(copy(descriptor.value, depth + 1)); }
    } else {
      if (Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key) || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) fail();
      result = Object.fromEntries(Object.keys(descriptors).map(key => [key, copy(descriptors[key].value, depth + 1)]));
    }
    seen.delete(value); return result;
  }
  const result = copy(input, 0); if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) fail('BUDGET_EXCEEDED'); return result;
}
export function cloudObject(value, keys, required = keys) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail(); }
export function cloudText(value, max = 500, empty = false) { if (typeof value !== 'string' || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || !value.isWellFormed()) fail(); if (Buffer.byteLength(value) > max) fail('BUDGET_EXCEEDED'); return value; }
export function cloudStamp(value) { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(); return value; }
export function cloudAccount(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) fail(); return value; }
export function cloudRecordId(provider, value) { if (provider === 'notion') { if (typeof value !== 'string' || !UUID.test(value)) fail(); } else if (provider !== 'googledocs' || typeof value !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(value)) fail(); return value; }
function sourceUrl(provider, value, id) {
  if (value === null) return null;
  cloudText(value, 1000); let url; try { url = new URL(value); } catch { fail(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) fail();
  if (provider === 'googledocs') { if (url.hostname !== 'docs.google.com' || !url.pathname.startsWith(`/document/d/${id}/`)) fail(); }
  else if (!['notion.so', 'www.notion.so'].includes(url.hostname) || !url.pathname.replaceAll('-', '').endsWith(id.replaceAll('-', ''))) fail();
  return url.href;
}
function bundleBody(raw) {
  const value = cloudCopy(raw); cloudObject(value, ['format', 'schema_version', 'origin', 'owner', 'provider', 'account_id', 'academic_policy', 'retrieved_at', 'records', 'limitations']);
  if (value.format !== 'learnbridge-selected-cloud-export' || value.schema_version !== 1 || !CLOUD_PROVIDERS.includes(value.provider) || !POLICIES.includes(value.academic_policy)) fail();
  let origin; try { origin = new URL(value.origin); } catch { fail(); }
  if (origin.origin !== value.origin || origin.username || origin.password || !(origin.protocol === 'https:' || (origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname)))) fail();
  cloudObject(value.owner, ['student_id', 'verification']); if (!UUID.test(value.owner.student_id) || value.owner.verification !== 'supabase_session_at_fetch') fail();
  cloudAccount(value.account_id); cloudStamp(value.retrieved_at);
  if (!Array.isArray(value.records) || !value.records.length || value.records.length > CLOUD_LIMITS.records) fail('BUDGET_EXCEEDED');
  const ids = new Set();
  for (const record of value.records) {
    cloudObject(record, ['id', 'title', 'url', 'modified_at', 'text', 'sha256', 'coverage', 'limitations']);
    cloudRecordId(value.provider, record.id); if (ids.has(record.id)) fail(); ids.add(record.id);
    cloudText(record.title, 500); sourceUrl(value.provider, record.url, record.id); if (record.modified_at !== null) cloudStamp(record.modified_at);
    cloudText(record.text, CLOUD_LIMITS.textBytes, true); if (!HASH.test(record.sha256) || sha(record.text) !== record.sha256) fail('VERSION_MISMATCH');
    if (record.coverage !== 'partial_text' || !Array.isArray(record.limitations) || !record.limitations.length || record.limitations.length > 8) fail();
    for (const reason of record.limitations) cloudText(reason, 500);
  }
  if (!Array.isArray(value.limitations) || !value.limitations.length || value.limitations.length > 8) fail();
  for (const reason of value.limitations) cloudText(reason, 500);
  value.records.sort((a, b) => a.id.localeCompare(b.id)); return value;
}
export function createCloudBundle(raw) {
  const value = bundleBody(raw), bundle = { ...value, bundle_hash: cloudHash(value) };
  // The transfer limit includes its integrity field. A body that barely fits
  // must not become an export-ready file its own importer will refuse.
  if (Buffer.byteLength(JSON.stringify(bundle)) > CLOUD_LIMITS.bundleBytes) fail('BUDGET_EXCEEDED');
  return bundle;
}
export function validateCloudBundle(raw) {
  const copied = cloudCopy(raw); cloudObject(copied, ['format', 'schema_version', 'origin', 'owner', 'provider', 'account_id', 'academic_policy', 'retrieved_at', 'records', 'limitations', 'bundle_hash']);
  const { bundle_hash, ...body } = copied, value = bundleBody(body);
  if (!HASH.test(bundle_hash) || cloudHash(value) !== bundle_hash) fail('VERSION_MISMATCH'); return { ...value, bundle_hash };
}
const fingerprint = value => { const { review_hash, ...body } = value; return cloudHash(body); };
const pin = saved => ({ id: saved.document.id, revision: saved.document.revision, sha256: saved.sha256 });

/** Transfer-file provenance is an assertion, not a locally authenticated cloud session. */
export function createCloudOnboarding(store, { clock = () => new Date().toISOString() } = {}) {
  const imports = () => store.listWorkspaceRecords({ kind: 'artifact' }).filter(item => item.data.format === 'cloud_import');
  function head(stream) { const found = imports().filter(item => item.data.stream_hash === stream); if (found.length > 1) fail('VERSION_MISMATCH'); return found[0] || null; }
  function exactNotes(item) {
    for (const note of item.data.notes) { const current = store.getDocument(note.id); if (!current || cloudHash(pin(current)) !== cloudHash(note)) fail('REVISION_CONFLICT'); }
  }
  function view(item) {
    let notes_current = true; try { exactNotes(item); } catch (error) { if (error.code !== 'REVISION_CONFLICT') throw error; notes_current = false; }
    return { id: item.id, revision: item.revision, title: item.title, state: item.data.state, provider: item.data.bundle.provider, account_id: item.data.bundle.account_id,
      upstream_student_id: item.data.bundle.owner.student_id, owner_verification: 'student_confirmed_bundle_reported', source_freshness: 'not_checked',
      retrieved_at: item.data.bundle.retrieved_at, last_observed_at: item.data.last_observed_at, notes: item.data.notes, notes_current, records: item.data.bundle.records.map(({ id, title, url, modified_at, sha256, coverage, limitations }) => ({ id, title, url, modified_at, sha256, coverage, limitations })),
      sharing: 'not_granted', limitations: ['This file does not authenticate the local student to the hosted account.', 'Live source freshness and later provider revocation have not been checked locally.', 'Imported notes, history, backups and downloaded bundles retain separate copies.'] };
  }
  function noteText(bundle, record, academic_policy) {
    return `${record.text}\n\n---\nLearnBridge selected cloud source\nApp: ${bundle.provider}\nItem: ${record.title}\nSource ID: ${record.id}\nURL: ${record.url || 'not reported'}\nAccount: ${bundle.account_id}\nHosted student ID (bundle reported): ${bundle.owner.student_id}\nRetrieved: ${bundle.retrieved_at}\nSource text SHA-256: ${record.sha256}\nBundle SHA-256: ${bundle.bundle_hash}\nAcademic policy: ${academic_policy}\nCoverage: partial text; original visuals and factual accuracy require review.\nLocal live freshness: not checked. Sharing: separately reviewed.\n`;
  }
  return {
    list() { return imports().filter(item => item.data.state !== 'forgotten').map(view); },
    get(id) { const item = store.getWorkspaceRecord(id); if (!item || item.data.format !== 'cloud_import' || item.data.state === 'forgotten') fail('SCOPE_DENIED'); return view(item); },
    preview(raw) {
      const input = cloudCopy(raw, 100000); cloudObject(input, ['bundle', 'academic_policy']); const bundle = validateCloudBundle(input.bundle);
      if (!POLICIES.includes(input.academic_policy)) fail(); const observed_at = cloudStamp(clock()); if (Date.parse(bundle.retrieved_at) > Date.parse(observed_at) + 300000) fail();
      const academic_policy = POLICIES[Math.max(POLICIES.indexOf(input.academic_policy), POLICIES.indexOf(bundle.academic_policy))];
      const stream_hash = cloudHash({ origin: bundle.origin, owner: bundle.owner.student_id, provider: bundle.provider, account_id: bundle.account_id, ids: bundle.records.map(record => record.id) });
      const semantic_hash = cloudHash({ ...bundle, retrieved_at: null, bundle_hash: null, academic_policy }); const prior = head(stream_hash);
      if (prior?.data.state === 'importing' && prior.data.semantic_hash !== semantic_hash) fail('REVISION_CONFLICT');
      if (prior?.data.state === 'active' && prior.data.semantic_hash === semantic_hash) exactNotes(prior);
      const preview = { format: 'learnbridge-cloud-import-preview', schema_version: 1, student_id: store.identity.student_id, bundle, academic_policy, stream_hash, semantic_hash,
        base: prior ? { id: prior.id, revision: prior.revision, state: prior.data.state } : null, observed_at,
        change: prior?.data.state === 'active' && prior.data.semantic_hash === semantic_hash ? 'unchanged' : prior?.data.state === 'importing' ? 'resume_incomplete' : 'new_private_copies',
        owner_verification: 'bundle_reported_needs_student_confirmation', source_freshness: 'not_checked', sharing: 'not_granted',
        limitations: ['Review the entire selected text and confirm this exported account is yours.', 'A hash checks file integrity; it does not authenticate the website or account locally.', 'Importing creates private notes; AI sharing requires a separate existing grant.', 'Provider revocation does not remove already exported bundles or imported notes.'] };
      return { ...preview, review_hash: fingerprint(preview) };
    },
    import(previewRaw, raw) {
      const preview = cloudCopy(previewRaw, 110000), input = cloudCopy(raw, 4096); cloudObject(input, ['review_hash', 'confirm_owner']);
      if (!HASH.test(input.review_hash) || preview.review_hash !== input.review_hash || fingerprint(preview) !== input.review_hash || input.confirm_owner !== true || preview.student_id !== store.identity.student_id) fail('CONSENT_REQUIRED');
      const now = cloudStamp(clock()); if (Date.parse(now) - Date.parse(preview.observed_at) > 300000 || Date.parse(preview.observed_at) > Date.parse(now)) fail('CONSENT_REQUIRED');
      const bundle = validateCloudBundle(preview.bundle), recomputed = this.preview({ bundle, academic_policy: preview.academic_policy });
      if (recomputed.stream_hash !== preview.stream_hash || recomputed.semantic_hash !== preview.semantic_hash) fail('VERSION_MISMATCH');
      let item = head(preview.stream_hash);
      if (cloudHash(item ? { id: item.id, revision: item.revision, state: item.data.state } : null) !== cloudHash(preview.base)) fail('REVISION_CONFLICT');
      const review = { reviewer: store.identity.student_id, reviewed_at: now, review_hash: input.review_hash, decision: 'import_selected_cloud_copies', owner_confirmation: 'student_confirmed_bundle_reported' };
      if (item?.data.state === 'active' && item.data.semantic_hash === preview.semantic_hash) {
        exactNotes(item); item = store.updateWorkspaceRecord(item.id, { expected_revision: item.revision, data: { ...item.data, last_observed_at: bundle.retrieved_at, last_observed_bundle_hash: bundle.bundle_hash, review } }); return view(item);
      }
      if (item?.data.state !== 'importing') {
        const data = { format: 'cloud_import', state: 'importing', stream_hash: preview.stream_hash, semantic_hash: preview.semantic_hash, generation: (item?.data.generation || 0) + 1,
          bundle, academic_policy: preview.academic_policy, notes: [], last_observed_at: bundle.retrieved_at, last_observed_bundle_hash: bundle.bundle_hash, review };
        item = item ? store.updateWorkspaceRecord(item.id, { expected_revision: item.revision, data }) : store.createWorkspaceRecord({ kind: 'artifact', title: `Selected ${bundle.provider} sources`, data }, { idempotencyKey: `cloud-${preview.stream_hash}` });
      }
      exactNotes(item);
      for (let index = item.data.notes.length; index < item.data.bundle.records.length; index++) {
        const record = item.data.bundle.records[index], text = noteText(item.data.bundle, record, item.data.academic_policy);
        const title = `Cloud ${item.data.bundle.provider}: ${record.title}`; let safeTitle = ''; for (const character of title) { if (Buffer.byteLength(safeTitle + character) > 500) break; safeTitle += character; }
        const saved = store.createDocument({ title: safeTitle, text, kind: 'study', academic_policy: item.data.academic_policy }, { idempotencyKey: `cloud-note-${cloudHash({ stream: item.data.stream_hash, generation: item.data.generation, index })}` });
        const current = store.getDocument(saved.document.id);
        if (!current || cloudHash(pin(current)) !== cloudHash(pin(saved)) || current.text !== text || current.document.academic_policy !== item.data.academic_policy) fail('REVISION_CONFLICT');
        item = store.updateWorkspaceRecord(item.id, { expected_revision: item.revision, data: { ...item.data, notes: [...item.data.notes, pin(current)] } });
      }
      item = store.updateWorkspaceRecord(item.id, { expected_revision: item.revision, data: { ...item.data, state: 'active', review } }); exactNotes(item);
      const readback = store.getWorkspaceRecord(item.id); if (cloudHash(readback) !== cloudHash(item)) fail('VERSION_MISMATCH'); return view(readback);
    },
    forget(id, expected_revision) {
      if (!Number.isSafeInteger(expected_revision) || expected_revision < 1) fail(); const item = store.getWorkspaceRecord(id);
      if (!item || item.data.format !== 'cloud_import' || item.revision !== expected_revision || item.data.state === 'forgotten') fail('REVISION_CONFLICT');
      return store.updateWorkspaceRecord(id, { expected_revision, data: { ...item.data, state: 'forgotten' } });
    },
  };
}

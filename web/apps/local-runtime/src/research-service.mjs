import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { LearnBridgeError } from '@learnbridge/core';

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const textHash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new LearnBridgeError(code); };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const RETENTION = 'Historical local revisions and backups may retain removed research. Existing exported notes keep their own copy until separately removed.';
function object(value, keys, required = []) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) || !('value' in Object.getOwnPropertyDescriptor(value, key)) || !Object.getOwnPropertyDescriptor(value, key).enumerable) || required.some(key => !Object.hasOwn(value, key))) fail('INVALID_INPUT');
}
function safeJson(input, maximum = 110000) {
  let nodes = 0; const ancestors = new Set();
  function walk(value, depth) {
    if (++nodes > 10000 || depth > 12) fail('BUDGET_EXCEEDED');
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
    if (typeof value === 'string') { if (value.includes('\0')) fail('INVALID_INPUT'); return value; }
    if (!value || typeof value !== 'object' || ancestors.has(value)) fail('INVALID_INPUT'); ancestors.add(value); let result;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      if (value.length > 100 || Reflect.ownKeys(descriptors).some(key => key !== 'length' && (!/^\d+$/.test(String(key)) || !('value' in descriptors[key]) || !descriptors[key].enumerable))) fail('INVALID_INPUT');
      result = Array.from({ length: value.length }, (_, i) => { if (!Object.hasOwn(descriptors, String(i))) fail('INVALID_INPUT'); return walk(descriptors[i].value, depth + 1); });
    } else {
      if (Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key) || !('value' in descriptors[key]) || !descriptors[key].enumerable)) fail('INVALID_INPUT');
      result = Object.fromEntries(Object.keys(descriptors).map(key => [key, walk(descriptors[key].value, depth + 1)]));
    }
    ancestors.delete(value); return result;
  }
  const result = walk(input, 0); if (Buffer.byteLength(JSON.stringify(result)) > maximum) fail('BUDGET_EXCEEDED'); return result;
}
function text(value, max, optional = false) { if (optional && value === undefined) return null; if (typeof value !== 'string' || !value.trim() || value.length > max || Buffer.byteLength(value) > max * 2 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail('INVALID_INPUT'); return value; }
function id(value) { if (typeof value !== 'string' || !UUID.test(value)) fail('INVALID_INPUT'); return value.toLowerCase(); }
function revision(value) { if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_INPUT'); return value; }
function digest(value) { if (typeof value !== 'string' || !SHA.test(value)) fail('INVALID_INPUT'); return value; }
function tags(value = []) { if (!Array.isArray(value) || value.length > 12) fail('INVALID_INPUT'); const result = value.map(tag => text(tag, 60).trim()); if (new Set(result).size !== result.length) fail('INVALID_INPUT'); return result; }
function retryKey(value, prefix) { if (value === undefined) return null; text(value, 100); if (value.length < 8 || /[^A-Za-z0-9._:-]/.test(value)) fail('INVALID_INPUT'); return `${prefix}-${hash(value)}`; }
function url(value) {
  text(value, 2048); let parsed; try { parsed = new URL(value); } catch { fail('INVALID_INPUT'); }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || isIP(host) || !host.includes('.') || /(^|\.)(localhost|local|internal|home|test)$/.test(host) || host.endsWith('.invalid')) fail('SCOPE_DENIED');
  for (const key of parsed.searchParams.keys()) if (/(token|secret|password|signature|auth|credential|api.?key)/i.test(key)) fail('SCOPE_DENIED');
  return parsed.href;
}
function publication(value) { if (value === undefined || value === null) return null; if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail('INVALID_INPUT'); return value; }
function range(value, maximum) { object(value, ['start', 'end'], ['start', 'end']); if (!Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end) || value.start < 0 || value.end <= value.start || value.end > maximum) fail('INVALID_INPUT'); return { start: value.start, end: value.end }; }
const meta = record => ({ id: record.id, title: record.title, revision: record.revision, created_at: record.created_at, updated_at: record.updated_at });
function escape(value) { return value.replace(/[\\`*_{}[\]<>]/g, '\\$&').replace(/\r?\n/g, ' '); }

/** Selected evidence and local notes only. No fetch, browser, model or external export. */
export function createResearchService({ store }) {
  if (!store || typeof store.getWorkspaceRecord !== 'function') fail('INVALID_INPUT');
  function records(format) { return store.listWorkspaceRecords({ kind: 'research_item' }).filter(record => record.data.format === format); }
  function requireRecord(recordId, format) { const record = store.getWorkspaceRecord(id(recordId)); if (!record || record.kind !== 'research_item' || record.data.format !== format) fail('SCOPE_DENIED'); return record; }
  function source(recordId) {
    const record = requireRecord(recordId, 'research_source'); const version = record.data.versions.at(-1);
    if (!version || version.version_hash !== hash(version.input) || record.data.source_key !== hash(version.input.kind === 'manual_url' ? { kind: 'manual_url', url: version.input.url } : { kind: 'local_note', document_id: version.input.document_id })) fail('VERSION_MISMATCH');
    if (version.input.kind === 'local_note') {
      const current = store.getDocument(version.input.document_id);
      if (!current || current.document.revision !== version.input.document_revision || current.sha256 !== version.input.document_sha256 || current.text.slice(version.input.range.start, version.input.range.end) !== version.input.excerpt) fail('REVISION_CONFLICT');
    }
    return { record, version };
  }
  function normalizeSource(value) {
    if (value.kind === 'manual_url') {
      object(value, ['kind', 'url', 'title', 'excerpt', 'official_source_declared', 'publisher', 'published_at', 'section_label', 'tags'], ['kind', 'url', 'title', 'excerpt', 'official_source_declared']);
      if (value.official_source_declared !== true) fail('CONSENT_REQUIRED');
      return { kind: value.kind, url: url(value.url), title: text(value.title, 256), excerpt: text(value.excerpt, 8000), official_source_declared: true, publisher: text(value.publisher, 160, true), published_at: publication(value.published_at), section_label: text(value.section_label, 256, true), tags: tags(value.tags), retrieval: 'student_supplied_excerpt', independently_retrieved: false, publisher_verified: false, freshness: 'unknown' };
    }
    object(value, ['kind', 'document_id', 'document_revision', 'document_sha256', 'range', 'title', 'tags'], ['kind', 'document_id', 'document_revision', 'document_sha256', 'range']);
    if (value.kind !== 'local_note') fail('INVALID_INPUT'); const documentId = id(value.document_id), documentRevision = revision(value.document_revision), sha256 = digest(value.document_sha256), current = store.getDocument(documentId);
    if (!current || current.document.revision !== documentRevision || current.sha256 !== sha256) fail('REVISION_CONFLICT'); const selected = range(value.range, current.text.length), excerpt = text(current.text.slice(selected.start, selected.end), 8000);
    return { kind: value.kind, document_id: documentId, document_revision: documentRevision, document_sha256: sha256, range: selected, title: value.title === undefined ? current.document.title : text(value.title, 256), excerpt, tags: tags(value.tags), academic_policy: current.document.academic_policy, retrieval: 'verified_local_document_range', independently_retrieved: false, publisher_verified: false, freshness: 'current_local_revision' };
  }
  function replay(format, retry, requestHash) { const existing = retry && records(format).find(record => record.data.client_request_key === retry); if (existing && existing.data.request_hash !== requestHash) fail('REVISION_CONFLICT'); return existing || null; }
  function evidence(value) {
    object(value, ['source_id', 'source_revision', 'source_hash', 'quote', 'range'], ['source_id', 'source_revision', 'source_hash', 'quote', 'range']);
    const { record, version } = source(value.source_id); if (revision(value.source_revision) !== record.revision || digest(value.source_hash) !== version.version_hash) fail('REVISION_CONFLICT');
    const selected = range(value.range, version.input.excerpt.length), quote = text(value.quote, 1500);
    if (version.input.excerpt.slice(selected.start, selected.end) !== quote) fail('INVALID_INPUT');
    return { source_id: record.id, source_revision: record.revision, source_hash: version.version_hash, quote, range: selected };
  }
  function claim(value) {
    object(value, ['id', 'text', 'kind', 'evidence', 'relationship', 'conflict_group'], ['id', 'text', 'kind', 'evidence']);
    text(value.id, 60); if (!/^[A-Za-z0-9._:-]+$/.test(value.id) || !['factual', 'opinion', 'open_question'].includes(value.kind) || !Array.isArray(value.evidence) || value.evidence.length > 5 || (value.kind === 'factual' && !value.evidence.length)) fail('INVALID_INPUT');
    const relationship = value.relationship ?? 'unclear'; if (!['supports', 'contradicts', 'unclear'].includes(relationship)) fail('INVALID_INPUT'); const citations = value.evidence.map(evidence); if (new Set(citations.map(cite => hash(cite))).size !== citations.length) fail('INVALID_INPUT');
    return { id: value.id, text: text(value.text, 1500), kind: value.kind, evidence: citations, relationship, conflict_group: text(value.conflict_group, 120, true) };
  }
  function verifyReport(record) {
    const report = record.data.report; if (!report || record.data.report_hash !== hash(report)) fail('VERSION_MISMATCH');
    for (const pin of report.source_pins) { const actual = source(pin.id); if (actual.record.revision !== pin.revision || actual.version.version_hash !== pin.hash) fail('REVISION_CONFLICT'); }
    for (const row of report.claims) for (const cite of row.evidence) evidence(cite);
    return record;
  }
  function requireReport(recordId) { return verifyReport(requireRecord(recordId, 'research_report')); }
  function render(report) {
    const lines = [`# ${escape(report.title)}`, '', 'Evidence report reviewed locally. Citations are checked against saved passages; support for a claim still requires student judgment.', '', 'No remote website was fetched. Manual URL excerpts, publisher declarations and dates were supplied by the student; remote freshness and publisher identity are unverified.', ''];
    for (const row of report.claims) {
      lines.push(`## ${escape(row.id)}: ${row.kind.replaceAll('_', ' ')}`, '', escape(row.text), '', `Declared evidence relationship: ${row.relationship}. Factual verification: not independently established.`, '');
      for (const cite of row.evidence) { const selected = source(cite.source_id), input = selected.version.input; lines.push(`Source: ${escape(input.title)} · captured revision ${cite.source_revision} · ${cite.source_hash}`, `Reference: ${input.kind === 'manual_url' ? input.url : `LearnBridge local note ${input.document_id}, revision ${input.document_revision}, SHA-256 ${input.document_sha256}`}`, `Capture method: ${input.retrieval}; freshness: ${input.freshness}${input.published_at ? `; student-declared publication date: ${input.published_at}` : ''}${input.section_label ? `; student-declared section: ${escape(input.section_label)}` : ''}`, `Exact quote (captured passage characters ${cite.range.start}–${cite.range.end}):`, ...cite.quote.split('\n').map(line => `> ${escape(line)}`), ''); }
    }
    if (report.conflicts.length) { lines.push('## Unresolved declared conflicts', ''); for (const conflict of report.conflicts) lines.push(`- ${escape(conflict.group)}: ${conflict.claim_ids.map(escape).join(', ')}`); lines.push(''); }
    if (report.open_questions.length) { lines.push('## Open questions', '', ...report.open_questions.map(value => `- ${escape(value)}`), ''); }
    if (report.tags.length) lines.push(`Tags: ${report.tags.map(escape).join(', ')}`, '');
    lines.push(`Report SHA-256: ${hash(report)}`, '', 'Private export. Existing copies must be separately removed if this evidence is later forgotten.', ''); return lines.join('\n');
  }
  function destination(value) {
    if (value === undefined || value === null) return null; object(value, ['document_id', 'revision', 'sha256'], ['document_id', 'revision', 'sha256']);
    const pin = { document_id: id(value.document_id), revision: revision(value.revision), sha256: digest(value.sha256) }, current = store.getDocument(pin.document_id); if (!current || current.document.revision !== pin.revision || current.sha256 !== pin.sha256) fail('REVISION_CONFLICT'); return pin;
  }
  function preview(recordId) { const record = requireRecord(recordId, 'research_export_preview'); if (record.data.preview_hash !== hash(record.data.preview) || record.data.preview.text_sha256 !== textHash(record.data.preview.markdown)) fail('VERSION_MISMATCH'); return record; }
  return {
    captureSource(input, options = {}) {
      input = safeJson(input, 20000); object(options, ['idempotencyKey']); const normalized = normalizeSource(input), retry = retryKey(options.idempotencyKey, 'research-capture'), requestHash = hash(normalized);
      const attempt = retry && records('research_capture').find(record => record.data.client_request_key === retry);
      if (attempt) { if (attempt.data.request_hash !== requestHash) fail('REVISION_CONFLICT'); const selected = source(attempt.data.source_id); if (selected.record.revision !== attempt.data.source_revision || selected.version.version_hash !== requestHash) fail('REVISION_CONFLICT'); return selected.record; }
      const sourceKey = hash(normalized.kind === 'manual_url' ? { kind: normalized.kind, url: normalized.url } : { kind: normalized.kind, document_id: normalized.document_id }); const prior = records('research_source').find(record => record.data.source_key === sourceKey);
      let saved;
      if (prior?.data.versions.at(-1)?.version_hash === requestHash) saved = source(prior.id).record;
      else {
        const versions = prior?.data.versions ?? []; if (versions.length >= 8) fail('BUDGET_EXCEEDED');
        const data = { format: 'research_source', source_key: sourceKey, versions: [...versions, { input: normalized, version_hash: requestHash, captured_at: new Date().toISOString() }] };
        saved = prior ? store.updateWorkspaceRecord(prior.id, { expected_revision: prior.revision, title: normalized.title, data }) : store.createWorkspaceRecord({ kind: 'research_item', title: normalized.title, data });
      }
      if (retry) store.createWorkspaceRecord({ kind: 'research_item', title: 'Research capture receipt', data: { format: 'research_capture', client_request_key: retry, request_hash: requestHash, source_id: saved.id, source_revision: saved.revision } }, { idempotencyKey: retry }); return saved;
    },
    listSources() { return records('research_source').map(record => { const version = record.data.versions.at(-1); try { source(record.id); return { ...meta(record), source_hash: version.version_hash, source_kind: version.input.kind, tags: version.input.tags, freshness: version.input.freshness, retrieval: version.input.retrieval, independently_retrieved: false, stale: false }; } catch (error) { if (!['REVISION_CONFLICT', 'SCOPE_DENIED'].includes(error.code)) throw error; return { ...meta(record), stale: true, reason: 'The selected local note changed or was removed. Capture its current revision again.' }; } }); },
    getSource(recordId) { return source(recordId).record; },
    createReport(input, options = {}) {
      input = safeJson(input, 100000); object(input, ['title', 'claims', 'tags', 'open_questions'], ['title', 'claims']); object(options, ['idempotencyKey']);
      if (!Array.isArray(input.claims) || !input.claims.length || input.claims.length > 20) fail('INVALID_INPUT'); const claims = input.claims.map(claim); if (new Set(claims.map(row => row.id)).size !== claims.length) fail('INVALID_INPUT');
      const questions = input.open_questions ?? []; if (!Array.isArray(questions) || questions.length > 12) fail('INVALID_INPUT'); const pins = new Map(), groups = new Map();
      for (const row of claims) { for (const cite of row.evidence) pins.set(cite.source_id, { id: cite.source_id, revision: cite.source_revision, hash: cite.source_hash }); if (row.conflict_group) { const group = groups.get(row.conflict_group) ?? []; group.push(row); groups.set(row.conflict_group, group); } }
      if (pins.size > 12) fail('BUDGET_EXCEEDED'); const conflicts = [...groups].filter(([, rows]) => rows.some(row => row.relationship === 'supports') && rows.some(row => row.relationship === 'contradicts')).map(([group, rows]) => ({ group, claim_ids: rows.map(row => row.id), resolution: 'unresolved_student_declared' }));
      const report = { title: text(input.title, 256), claims, tags: tags(input.tags), open_questions: questions.map(value => text(value, 1000)), source_pins: [...pins.values()], conflicts, citation_validation: 'exact_saved_passages', factual_verification: 'not_independently_established', remote_freshness: 'unknown' };
      const retry = retryKey(options.idempotencyKey, 'research-report'), requestHash = hash(report), existing = replay('research_report', retry, requestHash); if (existing) return verifyReport(existing);
      return store.createWorkspaceRecord({ kind: 'research_item', title: report.title, data: { format: 'research_report', report, report_hash: requestHash, state: 'draft', client_request_key: retry, request_hash: requestHash } }, { ...(retry ? { idempotencyKey: retry } : {}) });
    },
    listReports() { return records('research_report').map(record => { try { verifyReport(record); return { ...meta(record), state: record.data.state, report_hash: record.data.report_hash, source_count: record.data.report.source_pins.length, conflict_count: record.data.report.conflicts.length, citation_validation: 'exact_saved_passages', factual_verification: 'not_independently_established', stale: false }; } catch (error) { if (!['REVISION_CONFLICT', 'SCOPE_DENIED'].includes(error.code)) throw error; return { ...meta(record), state: 'stale', stale: true, reason: 'Selected source evidence changed or was removed. Build a new report from current passages.' }; } }); },
    getReport: requireReport,
    previewExport(recordId, input) {
      input = safeJson(input, 5000); object(input, ['expected_revision', 'report_hash', 'title', 'destination'], ['expected_revision', 'report_hash']); const report = requireReport(recordId);
      if (revision(input.expected_revision) !== report.revision || digest(input.report_hash) !== report.data.report_hash) fail('REVISION_CONFLICT');
      const target = destination(input.destination); if (target && report.data.report.source_pins.some(pin => source(pin.id).version.input.document_id === target.document_id)) fail('SCOPE_DENIED');
      const markdown = render(report.data.report); if (Buffer.byteLength(markdown) > 90000) fail('BUDGET_EXCEEDED');
      const body = { report_id: report.id, report_revision: report.revision, report_hash: report.data.report_hash, title: input.title === undefined ? report.title : text(input.title, 256), destination: target, markdown, text_sha256: textHash(markdown), academic_policy: report.data.report.source_pins.some(pin => source(pin.id).version.input.academic_policy === 'graded_restricted') ? 'graded_restricted' : 'learning_support' };
      const previewHash = hash(body), existing = records('research_export_preview').find(record => record.data.preview_hash === previewHash); if (existing) return preview(existing.id);
      return store.createWorkspaceRecord({ kind: 'research_item', title: `Export preview: ${report.title}`, data: { format: 'research_export_preview', preview: body, preview_hash: previewHash, state: 'ready' } }, { idempotencyKey: `research-preview-${previewHash}` });
    },
    exportReport(recordId, input) {
      input = safeJson(input, 4096); object(input, ['preview_id', 'expected_preview_revision', 'preview_hash'], ['preview_id', 'expected_preview_revision', 'preview_hash']); const report = requireReport(recordId), selected = preview(input.preview_id), body = selected.data.preview;
      if (body.report_id !== report.id || body.report_revision !== report.revision || body.report_hash !== report.data.report_hash || revision(input.expected_preview_revision) !== selected.revision || digest(input.preview_hash) !== selected.data.preview_hash) fail('REVISION_CONFLICT');
      const receipt = records('research_export_receipt').find(record => record.data.preview_id === selected.id);
      if (receipt) { const readback = store.getDocument(receipt.data.document_id); if (!readback || readback.sha256 !== body.text_sha256 || readback.document.revision !== receipt.data.document_revision || readback.document.title !== body.title) fail('REVISION_CONFLICT'); return { document: readback.document, text_sha256: readback.sha256, verification: 'exact_local_readback', sharing: 'not_granted', retention: RETENTION }; }
      const prior = destination(body.destination); verifyReport(report);
      const saved = prior ? store.updateDocument(prior.document_id, { title: body.title, text: body.markdown, academic_policy: body.academic_policy }, prior.revision) : store.createDocument({ title: body.title, text: body.markdown, kind: 'study', academic_policy: body.academic_policy }, { idempotencyKey: `research-export-${selected.data.preview_hash}` });
      const readback = store.getDocument(saved.document.id); if (!readback || readback.sha256 !== body.text_sha256 || readback.text !== body.markdown || readback.document.title !== body.title) fail('UNKNOWN_OUTCOME');
      store.createWorkspaceRecord({ kind: 'research_item', title: 'Research export readback', data: { format: 'research_export_receipt', preview_id: selected.id, report_id: report.id, document_id: readback.document.id, document_revision: readback.document.revision, text_sha256: readback.sha256, preview_hash: selected.data.preview_hash, approved_preview_revision: selected.revision, reviewed_by: 'paired_student', verified_at: new Date().toISOString() } }, { idempotencyKey: `research-export-receipt-${selected.data.preview_hash}` });
      return { document: readback.document, text_sha256: readback.sha256, verification: 'exact_local_readback', sharing: 'not_granted', retention: RETENTION };
    },
    forgetReport(recordId, expectedRevision) {
      const report = requireRecord(recordId, 'research_report'); if (revision(expectedRevision) !== report.revision) fail('REVISION_CONFLICT'); const retained = records('research_export_receipt').filter(record => record.data.report_id === report.id).map(record => record.data.document_id);
      store.deleteWorkspaceRecord(report.id, report.revision); for (const record of records('research_export_preview').filter(record => record.data.preview.report_id === report.id)) store.deleteWorkspaceRecord(record.id, record.revision);
      return { deleted: true, retained_document_ids: [...new Set(retained)], retention: RETENTION };
    },
    forgetSource(recordId, expectedRevision) {
      const selected = requireRecord(recordId, 'research_source'); if (revision(expectedRevision) !== selected.revision) fail('REVISION_CONFLICT'); const dependent = records('research_report').filter(record => record.data.report.source_pins.some(pin => pin.id === selected.id)), reportIds = new Set(dependent.map(record => record.id));
      const retained = records('research_export_receipt').filter(record => reportIds.has(record.data.report_id)).map(record => record.data.document_id);
      store.deleteWorkspaceRecord(selected.id, selected.revision); for (const record of dependent) store.deleteWorkspaceRecord(record.id, record.revision);
      for (const record of [...records('research_export_preview').filter(record => reportIds.has(record.data.preview.report_id)), ...records('research_capture').filter(record => record.data.source_id === selected.id)]) store.deleteWorkspaceRecord(record.id, record.revision);
      return { deleted: true, removed_reports: dependent.length, retained_document_ids: [...new Set(retained)], retention: RETENTION };
    },
  };
}

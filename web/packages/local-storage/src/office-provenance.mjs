import { createHash } from 'node:crypto';
import { LearnBridgeError } from '@learnbridge/core';

export const OFFICE_PROVENANCE_LIMITS = Object.freeze({ sourceBytes: 4_000_000, metadataBytes: 96000, textBytes: 256000, sections: 1000 });
const invalid = () => { throw new LearnBridgeError('INVALID_INPUT'); };
const changed = () => { throw new LearnBridgeError('VERSION_MISMATCH'); };
const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid(); };
function object(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) invalid();
}
function plainJson(value) {
  const seen = new Set(); let nodes = 0;
  function visit(input, depth) {
    if (++nodes > 16000 || depth > 8) invalid();
    if (input === null || typeof input === 'boolean') return;
    if (typeof input === 'number') { if (!Number.isFinite(input)) invalid(); return; }
    if (typeof input === 'string') { if (Buffer.byteLength(input) > OFFICE_PROVENANCE_LIMITS.textBytes) invalid(); return; }
    if (!input || typeof input !== 'object' || seen.has(input)) invalid();
    const array = Array.isArray(input);
    if (Object.getPrototypeOf(input) !== (array ? Array.prototype : Object.prototype)) invalid();
    seen.add(input); const fields = Object.getOwnPropertyDescriptors(input);
    if (array && (input.length > OFFICE_PROVENANCE_LIMITS.sections || Reflect.ownKeys(fields).length !== input.length + 1)) invalid();
    for (const key of Reflect.ownKeys(fields)) {
      const field = fields[key];
      if (typeof key !== 'string' || !('value' in field) || ['__proto__', 'constructor', 'prototype'].includes(key)
        || (key !== 'length' && !field.enumerable)
        || (array && key !== 'length' && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length))) invalid();
      if (key !== 'length') visit(field.value, depth + 1);
    }
    seen.delete(input);
  }
  visit(value, 0);
}

/** Validates acquired Office text only. This boundary opens no files, runs no
 * parser and does not authorize source acquisition or sharing with a model. */
export function validateOfficeProvenance(value, text, sourceBytes, documentType) {
  let office;
  try {
    plainJson(value); const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > OFFICE_PROVENANCE_LIMITS.metadataBytes) invalid();
    office = JSON.parse(encoded);
  } catch (error) { if (error instanceof LearnBridgeError) throw error; invalid(); }
  object(office, ['schema_version', 'format', 'parser_version', 'document_type', 'source_sha256', 'source_bytes', 'section_count', 'sections', 'extraction_status', 'coverage']);
  if (office.schema_version !== 1 || office.format !== 'office_text' || office.parser_version !== 'stdlib_ooxml.v1'
    || !['docx', 'pptx'].includes(office.document_type) || (documentType !== undefined && office.document_type !== documentType)
    || office.extraction_status !== 'available' || typeof text !== 'string' || !text.trim() || text.includes('\0')
    || Buffer.byteLength(text) > OFFICE_PROVENANCE_LIMITS.textBytes
    || !Number.isSafeInteger(office.source_bytes) || office.source_bytes < 1 || office.source_bytes > OFFICE_PROVENANCE_LIMITS.sourceBytes
    || (sourceBytes !== undefined && office.source_bytes !== sourceBytes)
    || !Number.isSafeInteger(office.section_count) || office.section_count < 1 || office.section_count > OFFICE_PROVENANCE_LIMITS.sections
    || !Array.isArray(office.sections) || office.sections.length !== office.section_count) invalid();
  digest(office.source_sha256); object(office.coverage, ['state', 'reasons']);
  if (office.coverage.state !== 'partial' || !Array.isArray(office.coverage.reasons) || office.coverage.reasons.length < 1
    || office.coverage.reasons.length > 20 || !office.coverage.reasons.includes('layout_not_preserved')
    || office.coverage.reasons.some(reason => typeof reason !== 'string' || !/^[a-z_]{1,80}$/.test(reason))
    || new Set(office.coverage.reasons).size !== office.coverage.reasons.length) invalid();
  const label = office.document_type === 'docx' ? 'DOCX paragraph' : 'PPTX slide';
  const unit = office.document_type === 'docx' ? 'paragraph' : 'slide';
  const bytes = Buffer.from(text, 'utf8'); let previousEnd = 0;
  for (const [index, section] of office.sections.entries()) {
    object(section, ['position', 'unit', 'text', 'sha256', 'byte_range']); object(section.byte_range, ['start', 'end']); digest(section.sha256);
    if (section.position !== index + 1 || section.unit !== unit || typeof section.text !== 'string' || section.text.includes('\0')
      || !Number.isSafeInteger(section.byte_range.start) || !Number.isSafeInteger(section.byte_range.end)
      || section.byte_range.start < 0 || section.byte_range.end < section.byte_range.start || section.byte_range.end > bytes.length) invalid();
    const bodyStart = previousEnd + (index ? 2 : 0) + Buffer.byteLength(`[${label} ${index + 1}]\n`);
    if (section.byte_range.start !== bodyStart || section.byte_range.end !== bodyStart + Buffer.byteLength(section.text)
      || bytes.subarray(section.byte_range.start, section.byte_range.end).toString('utf8') !== section.text
      || hash(section.text) !== section.sha256) changed();
    previousEnd = section.byte_range.end;
  }
  if (!office.sections.some(section => section.text.trim())) invalid();
  if (office.sections.map(section => `[${label} ${section.position}]\n${section.text}`).join('\n\n') !== text) changed();
  return office;
}

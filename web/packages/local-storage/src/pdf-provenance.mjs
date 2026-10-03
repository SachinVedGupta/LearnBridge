import { createHash } from 'node:crypto';
import { LearnBridgeError } from '@learnbridge/core';

const invalid = () => { throw new LearnBridgeError('INVALID_INPUT'); };
const changed = () => { throw new LearnBridgeError('VERSION_MISMATCH'); };
const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid(); };
function object(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) invalid();
}
function plainJson(value, depth = 0) {
  if (depth > 8) invalid();
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return;
  if (!value || typeof value !== 'object' || (![Object.prototype, Array.prototype].includes(Object.getPrototypeOf(value)))) invalid();
  const fields = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(fields)) {
    if (typeof key !== 'string' || !('value' in fields[key]) || ['__proto__', 'constructor', 'prototype'].includes(key)) invalid();
    if (key !== 'length' && !fields[key].enumerable) invalid();
    plainJson(fields[key].value, depth + 1);
  }
}

/** Only already-acquired text and provenance. This parser opens no files or
 * native programs and gives no import or model-processing permission. */
export function validatePdfProvenance(value, text, sourceBytes) {
  let pdf;
  try { plainJson(value); const encoded = JSON.stringify(value); if (Buffer.byteLength(encoded) > 96000) invalid(); pdf = JSON.parse(encoded); }
  catch (error) { if (error instanceof LearnBridgeError) throw error; invalid(); }
  object(pdf, ['schema_version', 'format', 'parser_version', 'source_sha256', 'source_bytes', 'page_count', 'pages', 'extraction_status', 'coverage']);
  if (pdf.schema_version !== 1 || pdf.format !== 'pdf_text' || pdf.parser_version !== 'macos_pdfkit.v1'
    || pdf.extraction_status !== 'available' || typeof text !== 'string' || !text.trim()
    || !Number.isSafeInteger(pdf.source_bytes) || pdf.source_bytes < 1 || pdf.source_bytes > 4_000_000
    || (sourceBytes !== undefined && pdf.source_bytes !== sourceBytes)
    || !Number.isSafeInteger(pdf.page_count) || pdf.page_count < 1 || pdf.page_count > 200
    || !Array.isArray(pdf.pages) || pdf.pages.length !== pdf.page_count) invalid();
  digest(pdf.source_sha256);
  object(pdf.coverage, ['state', 'reasons']);
  if (!['complete', 'partial'].includes(pdf.coverage.state) || !Array.isArray(pdf.coverage.reasons)
    || pdf.coverage.reasons.length > 20 || pdf.coverage.reasons.some(reason => typeof reason !== 'string'
      || !/^[a-z_]{1,80}$/.test(reason)) || new Set(pdf.coverage.reasons).size !== pdf.coverage.reasons.length
    || (pdf.coverage.state === 'complete' && pdf.coverage.reasons.length !== 0)
    || (pdf.coverage.state === 'partial' && pdf.coverage.reasons.length === 0)) invalid();
  const bytes = Buffer.from(text, 'utf8'); let previousEnd = 0;
  for (const [index, page] of pdf.pages.entries()) {
    object(page, ['physical_page', 'printed_label', 'text', 'sha256', 'byte_range']);
    object(page.byte_range, ['start', 'end']); digest(page.sha256);
    if (page.physical_page !== index + 1 || typeof page.text !== 'string' || page.text.includes('\0')
      || (page.printed_label !== null && (typeof page.printed_label !== 'string' || page.printed_label.length > 128 || Buffer.byteLength(page.printed_label) > 128
        || /[\x00-\x1f\x7f]/.test(page.printed_label)))
      || !Number.isSafeInteger(page.byte_range.start) || !Number.isSafeInteger(page.byte_range.end)
      || page.byte_range.start < previousEnd || page.byte_range.end < page.byte_range.start || page.byte_range.end > bytes.length) invalid();
    const bodyStart = previousEnd + (index ? 2 : 0) + Buffer.byteLength(`[PDF page ${index + 1}]\n`);
    if (page.byte_range.start !== bodyStart || page.byte_range.end !== bodyStart + Buffer.byteLength(page.text)
      || bytes.subarray(page.byte_range.start, page.byte_range.end).toString('utf8') !== page.text
      || hash(page.text) !== page.sha256 || page.byte_range.end - page.byte_range.start !== Buffer.byteLength(page.text)) changed();
    previousEnd = page.byte_range.end;
  }
  if (!pdf.pages.some(page => page.text.trim()) || (pdf.coverage.state === 'complete' && pdf.pages.some(page => !page.text.trim()))) invalid();
  if (pdf.pages.map(page => `[PDF page ${page.physical_page}]\n${page.text}`).join('\n\n') !== text) changed();
  return pdf;
}

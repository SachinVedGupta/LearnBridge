import { createHash } from 'node:crypto';
import { LearnBridgeError } from '@learnbridge/core';

export const WORD_TEXT_VERSION = 'learnbridge_word_text.v1';
export const WORD_TEXT_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const WORD_TEXT_LIMITS = Object.freeze({ inputBytes: 80000, paragraphs: 1000, outputBytes: 512000, sourceDocuments: 10 });
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PARTS = Object.freeze(['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels', 'docProps/custom.xml']);
const fail = code => { throw new LearnBridgeError(code); };
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

function object(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail('INVALID_INPUT');
  const descriptors = Object.getOwnPropertyDescriptors(value), own = Reflect.ownKeys(descriptors);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key)
    || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value')) || keys.some(key => !Object.hasOwn(descriptors, key))) fail('INVALID_INPUT');
}
function list(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail('INVALID_INPUT');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (value.length > WORD_TEXT_LIMITS.sourceDocuments || Reflect.ownKeys(descriptors).some(key => key !== 'length'
    && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length
      || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value')))) fail('INVALID_INPUT');
  for (let index = 0; index < value.length; index++) if (!Object.hasOwn(descriptors, String(index))) fail('INVALID_INPUT');
}
function id(value) { if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) fail('INVALID_INPUT'); return value; }
function revision(value) { if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_INPUT'); return value; }
function digest(value) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('INVALID_INPUT'); return value; }
function pin(value) { object(value, ['id', 'revision', 'sha256']); return { id: id(value.id), revision: revision(value.revision), sha256: digest(value.sha256) }; }
function provenance(value) {
  object(value, ['writing_record', 'document', 'source_documents', 'academic_policy', 'content_status']);
  object(value.writing_record, ['id', 'revision', 'payload_hash', 'state']);
  if (!['accepted', 'applied_revision'].includes(value.writing_record.state)
    || !['unrestricted', 'learning_support', 'graded_restricted'].includes(value.academic_policy)
    || !['student_reviewed_content', 'student_reviewed_model_output_facts_unverified'].includes(value.content_status)) fail('INVALID_INPUT');
  list(value.source_documents); const sources = value.source_documents.map(pin);
  if (new Set(sources.map(source => source.id)).size !== sources.length) fail('INVALID_INPUT');
  return { writing_record: { id: id(value.writing_record.id), revision: revision(value.writing_record.revision),
    payload_hash: digest(value.writing_record.payload_hash), state: value.writing_record.state }, document: pin(value.document),
  source_documents: sources.sort((a, b) => a.id.localeCompare(b.id)), academic_policy: value.academic_policy, content_status: value.content_status };
}
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); return value >>> 0;
});
function crc32(bytes) { let value = 0xffffffff; for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 255] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
function zip(entries) {
  const local = [], central = []; let offset = 0, centralBytes = 0;
  for (const [name, content] of entries) {
    const filename = Buffer.from(name, 'utf8'), bytes = Buffer.from(content, 'utf8'), crc = crc32(bytes);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(0x21, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(0x21, 14); directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(bytes.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, filename, bytes); central.push(directory, filename); offset += header.length + filename.length + bytes.length; centralBytes += directory.length + filename.length;
    if (offset + centralBytes + 22 > WORD_TEXT_LIMITS.outputBytes) fail('BUDGET_EXCEEDED');
  }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...local, ...central, end]);
}

/** Exact reviewed text to a fixed, inert Word container. No files, converters, hosts or providers. */
export function createWordTextArtifact(input) {
  object(input, ['text', 'provenance']);
  if (typeof input.text !== 'string' || !input.text.trim()) fail('INVALID_INPUT');
  if (input.text.length > WORD_TEXT_LIMITS.inputBytes || Buffer.byteLength(input.text, 'utf8') > WORD_TEXT_LIMITS.inputBytes) fail('BUDGET_EXCEEDED');
  for (const character of input.text) {
    const point = character.codePointAt(0);
    if (!(point === 9 || point === 10 || point === 13 || (point >= 32 && point <= 0xd7ff)
      || (point >= 0xe000 && point <= 0xfffd) || (point >= 0x10000 && point <= 0x10ffff))) fail('INVALID_INPUT');
  }
  const selected = provenance(input.provenance), originalHash = sha(input.text);
  if (selected.document.sha256 !== originalHash) fail('VERSION_MISMATCH');
  const normalized = input.text.replace(/\r\n?/g, '\n'), paragraphs = normalized.split('\n');
  if (paragraphs.length > WORD_TEXT_LIMITS.paragraphs) fail('BUDGET_EXCEEDED');
  const manifest = freeze({ format: 'learnbridge-word-text-artifact', schema_version: 1, generator_version: WORD_TEXT_VERSION,
    original_text_sha256: originalHash, original_text_bytes: Buffer.byteLength(input.text, 'utf8'),
    normalized_text_sha256: sha(normalized), normalized_text_bytes: Buffer.byteLength(normalized, 'utf8'), normalization: 'crlf_cr_to_lf',
    paragraph_count: paragraphs.length, provenance: selected, parts: [...PARTS],
    layout: { paper: 'US Letter', page_twips: { width: 12240, height: 15840 }, margin_twips: 1440, font: 'Calibri', font_half_points: 22, color: '000000' },
    limitations: ['Literal text; Markdown, lists, tables and citation URLs are not interpreted or made clickable.',
      'Structure and text preservation do not verify visual layout, pagination or font availability. Visual review remains pending.',
      'This local file does not grant sharing or verify factual claims.'], rendering: 'literal_text', visual_review: 'pending', sharing: 'not_granted' });
  const runs = value => value.split('\t').map(part => `<w:t xml:space="preserve">${xml(part)}</w:t>`).join('<w:tab/>');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>${paragraphs.map(value => `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r>${runs(value)}</w:r></w:p>`).join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:color w:val="000000"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="240" w:lineRule="auto"/><w:widowControl/><w:wordWrap/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>`;
  const types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>';
  const relationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="${R}/custom-properties" Target="docProps/custom.xml"/></Relationships>`;
  const documentRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/></Relationships>`;
  const properties = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="LearnBridgeManifest"><vt:lpwstr>${xml(canonical(manifest))}</vt:lpwstr></property></Properties>`;
  const bytes = zip(PARTS.map((name, index) => [name, [types, relationships, document, styles, documentRelationships, properties][index]]));
  return { bytes, manifest };
}

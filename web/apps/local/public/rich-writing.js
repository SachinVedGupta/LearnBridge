const WORD_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const TEX_MIME = 'application/x-tex; charset=utf-8';
const FORMATS = Object.freeze({ docx: { endpoint: 'export-formatted-docx', mime: WORD_MIME, validation: 'bounded_markdown_ooxml_and_pinned_source_hash', manifest: 'learnbridge-formatted-word-artifact' },
  tex: { endpoint: 'export-tex', mime: TEX_MIME, validation: 'escaped_standalone_latex_and_pinned_source_hash', manifest: 'learnbridge-tex-artifact' } });
function invalid() { throw new Error('The formatted download did not match this exact reviewed item. No file was prepared.'); }
export async function verifyRichWritingDownload(result, record, format) {
  const expected = FORMATS[format], pin = record?.data?.state === 'applied_revision' ? record.data.applied_note : record?.data?.accepted_note;
  const manifest = result?.manifest, provenance = manifest?.provenance;
  const samePin = value => value?.id === pin?.id && value?.revision === pin?.revision && value?.sha256 === pin?.sha256;
  const sources = values => Array.isArray(values) ? values.map(value => `${value.id}:${value.revision}:${value.sha256}`).sort().join('|') : null;
  if (!expected || !pin || !['accepted', 'applied_revision'].includes(record.data.state)
    || result?.mime !== expected.mime || result.validation !== expected.validation || result.sharing !== 'not_granted' || result.visual_review !== 'pending'
    || !Number.isSafeInteger(result.byte_length) || result.byte_length < 1 || result.byte_length > 512000
    || !/^[a-f0-9]{64}$/.test(result.sha256 || '') || typeof result.filename !== 'string' || result.filename.length > 100
    || !new RegExp(`^(?![.-])[\\p{L}\\p{N}._-]+\\.${format}$`, 'u').test(result.filename)
    || manifest?.format !== expected.manifest || manifest.schema_version !== 1 || manifest.generator_version !== 'learnbridge_rich_writing.v1'
    || manifest.original_text_sha256 !== pin.sha256 || manifest.normalization !== 'crlf_cr_to_lf' || manifest.rendering !== 'bounded_markdown_subset'
    || manifest.sharing !== 'not_granted' || manifest.visual_review !== 'pending' || !/^[a-f0-9]{64}$/.test(manifest.rendered_text_sha256 || '')
    || !samePin(provenance?.document) || !samePin(result.document)
    || provenance?.writing_record?.id !== record.id || provenance.writing_record.revision !== record.revision
    || provenance.writing_record.payload_hash !== record.data.payload_hash || provenance.writing_record.state !== record.data.state
    || provenance.academic_policy !== record.data.academic_policy || provenance.content_status !== record.data.content_status || result.content_status !== record.data.content_status
    || sources(result.source_documents) !== sources(record.data.source_documents) || sources(provenance.source_documents) !== sources(record.data.source_documents)) invalid();
  let bytes;
  if (format === 'docx') {
    if (result.encoding !== 'base64' || typeof result.base64 !== 'string' || result.base64.length > 682668 || result.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.base64)) invalid();
    const decoded = atob(result.base64); if (btoa(decoded) !== result.base64) invalid(); bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
    if (bytes.length < 4 || bytes[0] !== 80 || bytes[1] !== 75 || bytes[2] !== 3 || bytes[3] !== 4) invalid();
  } else {
    if (typeof result.text !== 'string' || result.text.length > 512000 || !result.text.startsWith(`% LearnBridge reviewed-source SHA-256: ${pin.sha256}\n`)
      || manifest.compiler !== 'not_run' || manifest.shell_escape !== 'not_requested') invalid();
    bytes = new TextEncoder().encode(result.text);
  }
  if (bytes.length !== result.byte_length) invalid();
  const digest = await crypto.subtle.digest('SHA-256', bytes), exactHash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  if (exactHash !== result.sha256) invalid();
  return bytes;
}

/** Adds controls only for an exact already reviewed writing item. */
export function mountRichWritingControls({ parent, record, request, element, busy, notice, isCurrent, registerDownload = () => {}, unregisterDownload = () => {} }) {
  if (!['accepted', 'applied_revision'].includes(record?.data?.state) || typeof isCurrent !== 'function') return { reset() {} };
  let active = true; const downloads = new Map(), inFlight = new Set();
  const help = element('p', 'field-help', 'Formatted Word and LaTeX support headings, flat lists and simple bold or italic text. Links, tables, images and other markup stay literal. LaTeX is source only; PDF compilation and layout review are separate.'); parent.append(help);
  for (const [format, label] of [['docx', 'Download formatted Word (.docx)'], ['tex', 'Download printable LaTeX source (.tex)']]) {
    const control = element('button', 'button secondary', label); control.type = 'button'; parent.append(control);
    control.addEventListener('click', () => {
      if (!active || !isCurrent() || inFlight.has(format)) return;
      inFlight.add(format);
      Promise.resolve().then(() => busy(control, async () => {
        const result = await request(`/writing/items/${record.id}/${FORMATS[format].endpoint}`, { method: 'POST', body: { expected_revision: record.revision, payload_hash: record.data.payload_hash } });
        if (!active || !isCurrent()) return;
        const bytes = await verifyRichWritingDownload(result, record, format); if (!active || !isCurrent()) return;
        const url = URL.createObjectURL(new Blob([bytes], { type: result.mime })), link = element('a', 'button secondary', `Download verified ${format === 'docx' ? 'formatted Word' : 'LaTeX source'}`);
        link.href = url; link.download = result.filename; parent.append(link); registerDownload(url); link.click();
        const timer = setTimeout(() => { URL.revokeObjectURL(url); unregisterDownload(url); link.remove(); downloads.delete(url); }, 30000); downloads.set(url, { link, timer });
        notice(`Verified ${format === 'docx' ? 'formatted Word' : 'LaTeX source'} download prepared: ${result.filename}. ${result.warning}`);
      })).catch(error => { if (active && isCurrent()) notice(error.message, true); }).finally(() => inFlight.delete(format));
    });
  }
  return { reset() { active = false; for (const [url, { link, timer }] of downloads) { clearTimeout(timer); URL.revokeObjectURL(url); unregisterDownload(url); link.remove(); } downloads.clear(); } };
}

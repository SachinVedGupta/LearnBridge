import { createHash } from 'node:crypto';
import { LearnBridgeError } from '@learnbridge/core';
import { createWritingService } from './writing-service.mjs';
import { createFormattedWordArtifact, createTexArtifact } from './rich-writing-artifact.mjs';

/** Paired browser export only; no agent grant, saved file write or provider call. */
export async function handleRichWritingRoute({ route, method, privateBody, store, session }) {
  const match = /^\/writing\/items\/([^/]+)\/(export-formatted-docx|export-tex)$/.exec(route);
  if (!match) return null;
  if (!session || typeof session.nonce !== 'string' || !session.nonce) throw new LearnBridgeError('AUTH_REQUIRED');
  if (method !== 'POST') throw new LearnBridgeError('INVALID_INPUT');
  const body = await privateBody(['expected_revision', 'payload_hash'], ['expected_revision', 'payload_hash'], 4096);
  // Use the existing acceptance/revision/source/academic-policy gate verbatim.
  // A formatter can never turn an unreviewed proposal into an exportable item.
  const reviewed = createWritingService({ store }).exportWordArtifact(match[1], body), saved = store.getDocument(reviewed.document.id);
  if (!saved || saved.document.revision !== reviewed.document.revision || saved.sha256 !== reviewed.document.sha256) throw new LearnBridgeError('REVISION_CONFLICT');
  const input = { text: saved.text, provenance: reviewed.manifest.provenance }, isWord = match[2] === 'export-formatted-docx';
  const artifact = isWord ? createFormattedWordArtifact(input) : createTexArtifact(input);
  const filename = reviewed.filename.replace(/\.docx$/, isWord ? '-formatted.docx' : '.tex');
  return { status: 200, data: { filename, mime: artifact.mime,
    ...(isWord ? { encoding: 'base64', base64: artifact.bytes.toString('base64') } : { text: artifact.text }),
    byte_length: artifact.bytes.length, sha256: createHash('sha256').update(artifact.bytes).digest('hex'), manifest: artifact.manifest,
    document: reviewed.document, source_documents: reviewed.source_documents, content_status: reviewed.content_status,
    validation: isWord ? 'bounded_markdown_ooxml_and_pinned_source_hash' : 'escaped_standalone_latex_and_pinned_source_hash',
    sharing: 'not_granted', visual_review: 'pending', warning: isWord
      ? 'Headings, flat lists and simple emphasis are formatted; other syntax stays literal. Review the layout and factual claims. This separately downloaded copy remains until you remove it.'
      : 'This is escaped LaTeX source, not a compiled PDF. Review its layout after compilation; Unicode fonts may require a compatible engine. This separately downloaded copy retains its source provenance until you remove it.' } };
}

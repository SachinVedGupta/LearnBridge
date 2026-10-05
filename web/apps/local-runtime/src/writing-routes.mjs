import { LearnBridgeError } from '@learnbridge/core';
import { createWritingService } from './writing-service.mjs';

/** The authenticated paired-browser host invokes this route adapter. No agent IPC authority. */
export async function handleWritingRoute({ route, method, privateBody, store, idempotencyKey, session }) {
  if (!route.startsWith('/writing/')) return null;
  if (!session || typeof session.nonce !== 'string' || !session.nonce) throw new LearnBridgeError('AUTH_REQUIRED');
  const service = createWritingService({ store }); const denied = () => { throw new LearnBridgeError('INVALID_INPUT'); };
  if (route === '/writing/documents') { if (method !== 'GET') denied(); return { status: 200, data: { items: service.documents() } }; }
  if (route === '/writing/items') { if (method !== 'GET') denied(); return { status: 200, data: { items: service.list(), capabilities: { ...service.capabilities(),
    formatted_docx: { state: 'available', processing: 'bounded_markdown_subset', verification: 'pinned_source_and_deterministic_ooxml', visual_review: 'pending' },
    latex: { state: 'available', processing: 'escaped_standalone_source', compilation: 'not_run', visual_review: 'pending', next_action: 'Download reviewed LaTeX source, then compile and review it separately.' },
  } } }; }
  if (route === '/writing/recipes') { if (method !== 'POST') denied(); const body = await privateBody(['title', 'kind', 'request', 'source_documents', 'academic_policy'], ['title', 'kind', 'request', 'source_documents', 'academic_policy'], 16000); return { status: 201, data: { item: service.createRecipe(body, { idempotencyKey }) } }; }
  if (route === '/writing/proposals') { if (method !== 'POST') denied(); const body = await privateBody(['title', 'kind', 'draft_text', 'source_documents', 'academic_policy', 'origin'], ['title', 'kind', 'draft_text', 'source_documents', 'academic_policy', 'origin'], 80000); return { status: 201, data: { item: service.createProposal(body, { idempotencyKey }) } }; }
  const match = /^\/writing\/items\/([^/]+)(?:\/(recipe-export|accept|apply-revision|reject|export|export-docx))?$/.exec(route); if (!match) return null;
  if (!match[2]) {
    if (method === 'GET') return { status: 200, data: { item: service.get(match[1]) } };
    if (method === 'DELETE') { const body = await privateBody(['expected_revision'], ['expected_revision'], 4096); service.forget(match[1], body.expected_revision); return { status: 200, data: { deleted: true, retention: 'Historical revisions, backups and separately exported notes may retain copies.' } }; }
    denied();
  }
  if (method !== 'POST') denied();
  if (match[2] === 'recipe-export') { const body = await privateBody(['expected_revision', 'recipe_hash'], ['expected_revision', 'recipe_hash'], 4096); return { status: 201, data: service.exportRecipe(match[1], body) }; }
  const body = await privateBody(['expected_revision', 'payload_hash'], ['expected_revision', 'payload_hash'], 4096);
  if (match[2] === 'accept') return { status: 200, data: { item: service.accept(match[1], body) } };
  if (match[2] === 'apply-revision') return { status: 200, data: { item: service.acceptRevision(match[1], body) } };
  if (match[2] === 'reject') return { status: 200, data: { item: service.reject(match[1], body) } };
  if (match[2] === 'export-docx') return { status: 200, data: service.exportWordArtifact(match[1], body) };
  return { status: 200, data: service.exportArtifact(match[1], body) };
}

import { LearnBridgeError } from '@learnbridge/core';
import { createResearchService } from './research-service.mjs';

/** The host must pass its paired-browser/session gate before calling. No agent IPC entry point. */
export async function handleResearchRoute({ route, method, privateBody, store, session, idempotencyKey }) {
  if (!route.startsWith('/research/')) return null;
  if (!session || typeof session.nonce !== 'string' || !session.nonce) throw new LearnBridgeError('AUTH_REQUIRED');
  const service = createResearchService({ store }), denied = () => { throw new LearnBridgeError('INVALID_INPUT'); };
  if (route === '/research/sources') {
    if (method === 'GET') return { status: 200, data: { items: service.listSources() } };
    if (method !== 'POST') denied();
    const body = await privateBody(['kind', 'url', 'title', 'excerpt', 'official_source_declared', 'publisher', 'published_at', 'section_label', 'tags', 'document_id', 'document_revision', 'document_sha256', 'range'], ['kind'], 20000);
    return { status: 201, data: { item: service.captureSource(body, { idempotencyKey }) } };
  }
  if (route === '/research/reports') {
    if (method === 'GET') return { status: 200, data: { items: service.listReports() } };
    if (method !== 'POST') denied();
    const body = await privateBody(['title', 'claims', 'tags', 'open_questions'], ['title', 'claims'], 100000);
    return { status: 201, data: { item: service.createReport(body, { idempotencyKey }) } };
  }
  const sourceMatch = /^\/research\/sources\/([^/]+)$/.exec(route);
  if (sourceMatch) {
    if (method === 'GET') return { status: 200, data: { item: service.getSource(sourceMatch[1]) } };
    if (method !== 'DELETE') denied(); const body = await privateBody(['expected_revision'], ['expected_revision'], 4096);
    return { status: 200, data: service.forgetSource(sourceMatch[1], body.expected_revision) };
  }
  const reportMatch = /^\/research\/reports\/([^/]+)(?:\/(export-preview|export))?$/.exec(route);
  if (!reportMatch) return null; const [, recordId, operation] = reportMatch;
  if (!operation) {
    if (method === 'GET') return { status: 200, data: { item: service.getReport(recordId) } };
    if (method !== 'DELETE') denied(); const body = await privateBody(['expected_revision'], ['expected_revision'], 4096);
    return { status: 200, data: service.forgetReport(recordId, body.expected_revision) };
  }
  if (method !== 'POST') denied();
  if (operation === 'export-preview') { const body = await privateBody(['expected_revision', 'report_hash', 'title', 'destination'], ['expected_revision', 'report_hash'], 5000); return { status: 201, data: { item: service.previewExport(recordId, body) } }; }
  const body = await privateBody(['preview_id', 'expected_preview_revision', 'preview_hash'], ['preview_id', 'expected_preview_revision', 'preview_hash'], 4096);
  return { status: 201, data: service.exportReport(recordId, body) };
}

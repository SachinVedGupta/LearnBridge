import { LearnBridgeError } from '@learnbridge/core';
import { HttpError } from './policy.mjs';

/** Root origin/cookie/nonce/query gates remain mandatory. No agent IPC entry point. */
export async function handleAcademicTaskRoute({ route, method, service, session, stillAuthorized, privateBody, idempotencyKey }) {
  if (!route.startsWith('/academic-tasks/')) return null;
  const authorize = () => { if (!session || typeof session.nonce !== 'string' || !session.nonce) throw new LearnBridgeError('AUTH_REQUIRED'); stillAuthorized?.(); };
  authorize(); const body = async keys => { const result = await privateBody(keys, keys, 12000); authorize(); return result; };
  const wrongMethod = () => { throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'This academic task operation is unavailable.'); };
  if (route === '/academic-tasks/context') { if (method !== 'GET') wrongMethod(); return { status: 200, data: service.context() }; }
  if (route === '/academic-tasks/inspect') { if (method !== 'POST') wrongMethod(); return { status: 200, data: service.inspect(await body(['snapshot_ids', 'course_ids'])) }; }
  if (route === '/academic-tasks/previews') {
    if (method === 'GET') return { status: 200, data: { items: service.listPreviews() } };
    if (method !== 'POST') wrongMethod(); return { status: 201, data: { item: service.preview(await body(['snapshot_ids', 'course_ids', 'assignment_ids']), { idempotencyKey }) } };
  }
  if (route === '/academic-tasks/proposals') { if (method !== 'GET') wrongMethod(); return { status: 200, data: { items: service.listProposals() } }; }
  const match = /^\/academic-tasks\/(previews|proposals)\/([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})(?:\/(save|accept|reject))?$/i.exec(route);
  if (match) {
    if (!match[3]) { if (method !== 'GET') wrongMethod(); return { status: 200, data: { item: service[match[1] === 'previews' ? 'getPreview' : 'getProposal'](match[2]) } }; }
    if ((match[1] === 'previews' && match[3] !== 'save') || (match[1] === 'proposals' && match[3] === 'save')) throw new HttpError(404, 'NOT_FOUND', 'Academic task operation not found.');
    if (method !== 'POST') wrongMethod();
    if (match[3] === 'save') return { status: 200, data: service.savePending(match[2], await body(['expected_revision', 'review_hash'])) };
    return { status: 200, data: { item: service[match[3]](match[2], await body(['expected_revision', 'payload_hash', 'confirmed'])) } };
  }
  throw new HttpError(404, 'NOT_FOUND', 'Academic task operation not found.');
}

import { LearnBridgeError } from '@learnbridge/core';
import { HttpError } from './policy.mjs';
const DEFINITION = ['title', 'category', 'official_url', 'source_text', 'checked_at', 'timezone', 'deadline', 'requirements', 'checklist'];
export async function handleAdminDeadlineRoute({ route, method, service, session, stillAuthorized, privateBody, idempotencyKey }) {
  if (!route.startsWith('/student-admin/')) return null;
  const authorize = () => { if (!session?.nonce || typeof session.nonce !== 'string') throw new LearnBridgeError('AUTH_REQUIRED'); stillAuthorized?.(); };
  authorize(); const body = async keys => { const result = await privateBody(keys, keys, 64000); authorize(); return result; };
  const wrong = () => { throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'This student administration operation is unavailable.'); };
  if (route === '/student-admin/context') { if (method !== 'GET') wrong(); return { status: 200, data: service.context() }; }
  if (route === '/student-admin/items') { if (method === 'GET') return { status: 200, data: { items: service.list() } }; if (method !== 'POST') wrong(); return { status: 201, data: { item: service.create(await body(DEFINITION), { idempotencyKey }) } }; }
  if (route === '/student-admin/previews') { if (method !== 'GET') wrong(); return { status: 200, data: { items: service.listPreviews() } }; }
  const match = /^\/student-admin\/(items|previews)\/([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})(?:\/(prepare|accept|cancel))?$/i.exec(route);
  if (match) {
    if (!match[3]) { if (method === 'GET') return { status: 200, data: { item: service[match[1] === 'items' ? 'get' : 'getPreview'](match[2]) } };
      if (match[1] !== 'items' || method !== 'POST') wrong(); return { status: 200, data: { item: service.correct(match[2], await body(['expected_revision', 'item_hash', 'definition', 'confirmed'])) } }; }
    if ((match[1] === 'items' && match[3] !== 'prepare') || (match[1] === 'previews' && match[3] === 'prepare')) throw new HttpError(404, 'NOT_FOUND', 'Student administration operation not found.');
    if (method !== 'POST') wrong(); const input = await body(match[3] === 'prepare' ? ['expected_revision', 'item_hash'] : ['expected_revision', 'review_hash', 'confirmed']);
    return { status: match[3] === 'prepare' ? 201 : 200, data: { item: service[match[3]](match[2], input, ...(match[3] === 'prepare' ? [{ idempotencyKey }] : [])) } };
  }
  throw new HttpError(404, 'NOT_FOUND', 'Student administration operation not found.');
}

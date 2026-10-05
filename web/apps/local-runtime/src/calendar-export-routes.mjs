import { LearnBridgeError } from '@learnbridge/core';
import { HttpError } from './policy.mjs';
/** Root pairing, origin, nonce and no-query gates are mandatory. Never exposed to agent IPC. */
export async function handleCalendarExportRoute({ route, method, service, session, stillAuthorized, privateBody, idempotencyKey }) {
  if (!route.startsWith('/calendar-export/')) return null;
  const authorize = () => { if (!session?.nonce || typeof session.nonce !== 'string') throw new LearnBridgeError('AUTH_REQUIRED'); stillAuthorized?.(); };
  authorize(); const body = async (keys, required = keys) => { const result = await privateBody(keys, required, 12000); authorize(); return result; };
  const wrong = () => { throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'This calendar export operation is unavailable.'); };
  if (route === '/calendar-export/context') { if (method !== 'GET') wrong(); return { status: 200, data: service.context() }; }
  if (route === '/calendar-export/previews') {
    if (method === 'GET') return { status: 200, data: { items: service.listPreviews() } };
    if (method !== 'POST') wrong(); return { status: 201, data: { item: service.preview(await body(['mode', 'task_ids', 'plan_id', 'expected_revision', 'plan_hash'], ['mode']), { idempotencyKey }) } };
  }
  const match = /^\/calendar-export\/previews\/([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})(\/download)?$/i.exec(route);
  if (match) {
    if (!match[2]) { if (method !== 'GET') wrong(); return { status: 200, data: { item: service.getPreview(match[1]) } }; }
    if (method !== 'POST') wrong(); return { status: 200, data: service.download(match[1], await body(['expected_revision', 'review_hash', 'confirmed'])) };
  }
  throw new HttpError(404, 'NOT_FOUND', 'Calendar export operation not found.');
}

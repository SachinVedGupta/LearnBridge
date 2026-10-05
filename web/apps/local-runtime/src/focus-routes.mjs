import { LearnBridgeError } from '@learnbridge/core';
import { HttpError } from './policy.mjs';
export async function handleFocusRoute({ route, method, service, session, stillAuthorized, privateBody, idempotencyKey }) {
  if (!route.startsWith('/focus/')) return null;
  const authorize = () => { if (!session?.nonce || typeof session.nonce !== 'string') throw new LearnBridgeError('AUTH_REQUIRED'); stillAuthorized?.(); };
  authorize(); const body = async (keys, required = keys) => { const result = await privateBody(keys, required, 8000); authorize(); return result; };
  const wrong = () => { throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'This focus timer operation is unavailable.'); };
  if (route === '/focus/context') { if (method !== 'GET') wrong(); return { status: 200, data: service.context() }; }
  if (route === '/focus/sessions') {
    if (method === 'GET') return { status: 200, data: { items: service.list() } }; if (method !== 'POST') wrong();
    return { status: 201, data: { item: service.start(await body(['title', 'planned_minutes', 'timezone', 'task_id', 'confirmed'], ['title', 'planned_minutes', 'timezone', 'confirmed']), { idempotencyKey }) } };
  }
  const match = /^\/focus\/sessions\/([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})(?:\/(pause|resume|end|discard))?$/i.exec(route);
  if (match) { if (!match[2]) { if (method !== 'GET') wrong(); return { status: 200, data: { item: service.get(match[1]) } }; } if (method !== 'POST') wrong(); return { status: 200, data: { item: service[match[2]](match[1], await body(['expected_revision', 'session_hash', 'confirmed'])) } }; }
  throw new HttpError(404, 'NOT_FOUND', 'Focus operation not found.');
}

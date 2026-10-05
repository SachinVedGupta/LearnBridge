import { LearnBridgeError } from '@learnbridge/core';
import { HttpError } from './policy.mjs';

export async function handleDynamicTaskAIRoute({ route, method, service, session, stillAuthorized, privateBody, idempotencyKey }) {
  if (!route.startsWith('/dynamic-task-ai/')) return null;
  const authorize = () => { if (!session?.nonce || typeof session.nonce !== 'string') throw new LearnBridgeError('AUTH_REQUIRED'); stillAuthorized?.(); return true; }; authorize();
  const body = async keys => { const value = await privateBody(keys, keys, 16000); authorize(); return value; };
  const wrong = () => { throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'This selected task extraction operation is unavailable.'); };
  if (route === '/dynamic-task-ai/context') { if (method !== 'GET') wrong(); return { status: 200, data: service.context() }; }
  if (route === '/dynamic-task-ai/preview') { if (method !== 'POST') wrong(); return { status: 200, data: service.preview(await body(['source_id', 'source_revision', 'source_hash'])) }; }
  if (route === '/dynamic-task-ai/extractions') {
    if (method === 'GET') return { status: 200, data: { items: service.list() } }; if (method !== 'POST') wrong();
    return { status: 202, data: { item: await service.start(await body(['source_id', 'source_revision', 'source_hash', 'review_hash', 'confirmed']), { idempotencyKey, authorize }) } };
  }
  const match = /^\/dynamic-task-ai\/extractions\/([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})(?:\/(collect|cancel))?$/i.exec(route);
  if (match) {
    if (!match[2]) { if (method !== 'GET') wrong(); return { status: 200, data: { item: service.get(match[1]) } }; }
    if (method !== 'POST') wrong(); if (match[2] === 'cancel') return { status: 200, data: { item: service.cancel(match[1], await body(['expected_revision', 'turn_revision'])) } };
    await body([]); return { status: 200, data: service.collect(match[1]) };
  }
  throw new HttpError(404, 'NOT_FOUND', 'Selected task extraction operation not found.');
}

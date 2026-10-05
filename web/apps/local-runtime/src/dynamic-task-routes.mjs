import { LearnBridgeError } from '@learnbridge/core';
import { HttpError } from './policy.mjs';

/** This route is paired-UI only; it grants no model or remote access. */
export async function handleDynamicTaskRoute({ route, method, service, session, stillAuthorized, privateBody }) {
  if (!route.startsWith('/dynamic-tasks/')) return null;
  const authorize = () => { if (!session?.nonce || typeof session.nonce !== 'string') throw new LearnBridgeError('AUTH_REQUIRED'); stillAuthorized?.(); }; authorize();
  const body = async keys => { const value = await privateBody(keys, keys, 16000); authorize(); return value; };
  const wrong = () => { throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'This dynamic task operation is unavailable.'); };
  if (route === '/dynamic-tasks/context') { if (method !== 'GET') wrong(); return { status: 200, data: service.context() }; }
  if (route === '/dynamic-tasks/config') {
    if (method === 'GET') return { status: 200, data: { item: service.config() } }; if (method !== 'POST') wrong();
    return { status: 200, data: { item: service.configure(await body(['expected_revision', 'selections', 'auto_create', 'auto_complete', 'enabled', 'confirmed'])) } };
  }
  if (route === '/dynamic-tasks/list') { if (method !== 'GET') wrong(); return { status: 200, data: service.list() }; }
  if (route === '/dynamic-tasks/refresh') { if (method !== 'POST') wrong(); await body([]); return { status: 200, data: service.refresh() }; }
  const match = /^\/dynamic-tasks\/items\/([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})(?:\/(accept|reject|apply-source))?$/i.exec(route);
  if (match) {
    if (!match[2]) { if (method !== 'GET') wrong(); return { status: 200, data: { item: service.getItem(match[1]) } }; }
    if (method !== 'POST') wrong(); const keys = ['expected_revision', 'review_hash', 'confirmed', ...(match[2] === 'accept' ? ['existing_task_id'] : match[2] === 'apply-source' ? ['task_revision'] : [])];
    return { status: 200, data: { item: service[match[2] === 'apply-source' ? 'applySource' : match[2]](match[1], await body(keys)) } };
  }
  throw new HttpError(404, 'NOT_FOUND', 'Dynamic task operation not found.');
}

import { LearnBridgeError } from '@learnbridge/core';
import { createPlanTaskService } from './plan-task-service.mjs';

export async function handlePlanTaskRoute({ route, method, privateBody, store, getLibrary, planTaskService, session, stillAuthorized, idempotencyKey }) {
  if (!route.startsWith('/plan-tasks/')) return null;
  if (typeof session?.nonce !== 'string' || !session.nonce) throw new LearnBridgeError('AUTH_REQUIRED');
  const service = planTaskService || createPlanTaskService({ store, getLibrary }), authorize = () => { if (stillAuthorized) stillAuthorized(); }, deny = () => { throw new LearnBridgeError('INVALID_INPUT'); };
  if (route === '/plan-tasks/state') { if (method !== 'GET') deny(); authorize(); return { status: 200, data: service.state() }; }
  const plan = /^\/plan-tasks\/plans\/([a-f0-9-]{36})$/.exec(route); if (plan) { if (method !== 'GET') deny(); authorize(); return { status: 200, data: service.inspect(plan[1]) }; }
  if (route === '/plan-tasks/previews') { if (method !== 'POST') deny(); const body = await privateBody(['plan_ref', 'topic_ids'], ['plan_ref', 'topic_ids'], 12000); authorize(); return { status: 201, data: service.preview(body, { idempotencyKey }) }; }
  const match = /^\/plan-tasks\/previews\/([a-f0-9-]{36})(?:\/(accept))?$/.exec(route); if (!match) return null;
  if (!match[2] && method === 'GET') { authorize(); return { status: 200, data: service.get(match[1]) }; }
  if ((match[2] && method !== 'POST') || (!match[2] && method !== 'DELETE')) deny();
  const fields = ['expected_revision', 'preview_hash', ...(match[2] ? ['topic_id', 'task_hash', 'confirmed'] : [])], body = await privateBody(fields, fields, 4096); authorize();
  return { status: 200, data: match[2] ? service.accept(match[1], body) : service.forget(match[1], body) };
}

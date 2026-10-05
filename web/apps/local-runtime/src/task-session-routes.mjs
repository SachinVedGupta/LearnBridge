import { HttpError } from './policy.mjs';
const methodError = () => { throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'This task-session operation is unavailable.'); };
export async function handleTaskSessionRoute({ route, method, privateBody, service, stillAuthorized, idempotencyKey }) {
  if (route === '/task-sessions/context') { if (method !== 'GET') methodError(); return { status: 200, data: service.context() }; }
  if (route === '/task-sessions') {
    if (method === 'GET') return { status: 200, data: { items: service.list() } };
    if (method !== 'POST') methodError();
    const body = await privateBody(['task_id', 'expected_revision', 'documents', 'instructions', 'confirmed', 'previous_session_id'], ['task_id', 'expected_revision', 'documents', 'instructions', 'confirmed'], 16000);
    return { status: 202, data: { item: await service.start(body, { idempotencyKey, authorize: () => { stillAuthorized(); return true; } }) } };
  }
  const matched = /^\/task-sessions\/([^/]+)(?:\/(cancel|complete))?$/.exec(route);
  if (!matched) return null;
  if (!matched[2]) { if (method !== 'GET') methodError(); return { status: 200, data: { item: service.get(matched[1]) } }; }
  if (method !== 'POST') methodError();
  const fields = matched[2] === 'cancel' ? ['expected_revision', 'turn_revision'] : ['expected_revision', 'turn_revision', 'task_revision', 'evidence_note', 'confirmed'];
  const body = await privateBody(fields, fields, 8000);
  return { status: 200, data: { item: service[matched[2]](matched[1], body) } };
}

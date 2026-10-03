import { HttpError } from './policy.mjs';
import { createProductivityWorkspace } from './productivity-service.mjs';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const unavailable = () => { throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'This local productivity operation is unavailable.'); };
/** The root server authenticates origin/session/nonce, rejects queries and rechecks after privateBody. */
export async function handleProductivityRoute({ route, method, privateBody, store, idempotencyKey, service }) {
  if (!route.startsWith('/productivity/')) return null; const productivity = service ?? createProductivityWorkspace(store);
  if (route === '/productivity/context') { if (method !== 'GET') unavailable(); return { status: 200, data: productivity.context() }; }
  const definitions = {
    '/productivity/updates': ['listUpdates', 'importUpdate', ['provider', 'account', 'source_id', 'subject', 'observed_at', 'body', 'source_url', 'section', 'expected_revision'], ['provider', 'account', 'source_id', 'subject', 'observed_at', 'body', 'section']],
    '/productivity/briefings': ['listBriefings', 'prepareBriefing', ['title', 'sources', 'coverage'], ['title', 'sources', 'coverage']],
    '/productivity/proposals': ['listProposals', 'prepareTask', ['title', 'sources', 'evidence', 'deadline', 'deadline_basis', 'owner', 'dependencies'], ['title', 'sources', 'evidence', 'deadline', 'deadline_basis', 'owner', 'dependencies']],
    '/productivity/projects': ['listProjects', 'createProject', ['title', 'goal', 'resources', 'sources', 'checklist'], ['title', 'goal', 'resources', 'sources', 'checklist']],
    '/productivity/schedules': ['listSchedules', 'createSchedule', ['title', 'first_due_at', 'every_minutes', 'timezone'], ['title', 'first_due_at', 'every_minutes', 'timezone']],
  };
  const definition = definitions[route];
  if (definition) {
    if (method === 'GET') return { status: 200, data: { items: productivity[definition[0]]() } };
    if (method !== 'POST') unavailable(); const body = await privateBody(definition[2], definition[3], 64000);
    return { status: 201, data: { item: productivity[definition[1]](body, { idempotencyKey }) } };
  }
  const match = /^\/productivity\/(proposals|briefings|projects|schedules)\/([^/]+)\/(accept|export|checklist|state|check)$/.exec(route);
  if (match) {
    if (!uuid.test(match[2])) throw new HttpError(404, 'NOT_FOUND', 'Local productivity item not found.'); if (method !== 'POST') unavailable();
    const action = `${match[1]}/${match[3]}`;
    const definition = action === 'proposals/accept' ? ['acceptTask', ['expected_revision', 'review_hash']]
      : ['briefings/export', 'projects/export'].includes(action) ? ['exportNote', ['expected_revision', 'export_hash']]
        : action === 'projects/checklist' ? ['completeChecklist', ['expected_revision', 'item_id', 'completed']]
          : action === 'schedules/state' ? ['setSchedule', ['expected_revision', 'state']]
            : action === 'schedules/check' ? ['checkSchedule', ['expected_revision']] : null;
    if (definition) {
      const body = await privateBody(definition[1], definition[1], 16000), result = productivity[definition[0]](match[2], body);
      return { status: 200, data: definition[0] === 'exportNote' ? result : { item: result } };
    }
  }
  throw new HttpError(404, 'NOT_FOUND', 'Local productivity operation not found.');
}

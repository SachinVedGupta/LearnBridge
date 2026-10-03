import { HttpError } from './policy.mjs';
import { createCareerWorkspace } from './career-service.mjs';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const methodError = () => { throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'This career operation is unavailable.'); };

/** Call only after root HTTP authentication/nonce/origin checks and noQuery.
 * privateBody must recheck the paired session after its asynchronous read. */
export async function handleCareerRoute({ route, method, privateBody, store, idempotencyKey, service }) {
  if (!route.startsWith('/career/')) return null;
  const career = service ?? createCareerWorkspace(store);
  if (route === '/career/facts') {
    if (method !== 'GET') methodError();
    return { status: 200, data: { items: career.listFacts(), processing: 'local_only', unavailable: ['gpa', 'work_authorization', 'disclosures'],
      note: 'Only current, confirmed, career-purpose profile facts are available. Generic eligibility text is never inferred.' } };
  }
  const definitions = {
    '/career/roles': { list: 'listRoles', create: 'createRole', fields: ['company', 'provider_job_id', 'title', 'url', 'locations', 'term', 'source_kind', 'source_excerpt', 'availability', 'deadline_text'],
      required: ['company', 'provider_job_id', 'title', 'url', 'source_kind', 'source_excerpt'] },
    '/career/applications': { list: 'listApplications', create: 'prepareApplication', fields: ['role_id', 'questions', 'selected_profile_ids', 'artifact_ids'], required: ['role_id', 'questions', 'selected_profile_ids'] },
    '/career/practice': { list: 'listPractice', create: 'startPractice', fields: ['exercise_id', 'title', 'source_url', 'mode', 'questions'], required: ['exercise_id', 'title', 'mode', 'questions'] },
    '/career/followups': { list: 'listFollowups', create: 'prepareFollowup', fields: ['application_id', 'contact_id', 'recipient', 'channel', 'selected_profile_ids', 'remind_at'],
      required: ['application_id', 'contact_id', 'recipient', 'channel', 'selected_profile_ids', 'remind_at'] },
  };
  const definition = definitions[route];
  if (definition) {
    if (method === 'GET') return { status: 200, data: { items: career[definition.list]() } };
    if (method !== 'POST') methodError();
    const body = await privateBody(definition.fields, definition.required, 64000);
    return { status: 201, data: { item: career[definition.create](body, { idempotencyKey }) } };
  }
  const operations = {
    shortlist: ['roles', 'changeShortlist', ['expected_revision', 'state', 'note']],
    review: ['applications', 'reviewApplication', ['expected_revision', 'review_hash', 'decision']],
    answer: ['practice', 'answerPractice', ['expected_revision', 'question_id', 'student_answer', 'hints_used']],
    transition: ['practice', 'transitionPractice', ['expected_revision', 'action']],
    reminder: ['followups', 'acceptReminder', ['expected_revision', 'followup_hash']],
  };
  const matched = /^\/career\/(roles|applications|practice|followups)\/([^/]+)\/(shortlist|review|answer|transition|reminder)$/.exec(route);
  if (matched) {
    const [resource, operation, fields] = operations[matched[3]];
    if (!uuid.test(matched[2]) || resource !== matched[1]) throw new HttpError(404, 'NOT_FOUND', 'Career item not found.');
    if (method !== 'POST') methodError();
    const required = fields.filter(field => !['note', 'hints_used'].includes(field));
    const body = await privateBody(fields, required, 32000);
    return { status: 200, data: { item: career[operation](matched[2], body) } };
  }
  throw new HttpError(404, 'NOT_FOUND', 'Career operation not found.');
}

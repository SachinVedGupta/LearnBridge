import { LearnBridgeError } from '@learnbridge/core';

/** Host invokes only after paired-browser authentication; not an MCP tool. */
export async function handleCourseStudioRoute({ route, method, privateBody, service, session, stillAuthorized, sourceOperation, idempotencyKey }) {
  if (!route.startsWith('/course-studio/')) return null;
  const fail = code => { throw new LearnBridgeError(code); };
  if (!session || typeof session.nonce !== 'string' || !session.nonce || typeof stillAuthorized !== 'function') fail('AUTH_REQUIRED');
  const authorized = () => { stillAuthorized(); return true; }; authorized();
  const guardedSource = operation => sourceOperation ? sourceOperation(signal => operation({ signal })) : operation({});
  if (route === '/course-studio/sessions') {
    if (method === 'GET') return { status: 200, data: { items: service.list(), capability: service.capability() } };
    if (method !== 'POST') fail('INVALID_INPUT');
    const body = await privateBody(['source_entry_id', 'physical_page', 'title', 'academic_policy', 'learning_session_id', 'expected_learning_pin', 'confirmed'], ['source_entry_id', 'physical_page', 'title', 'academic_policy', 'confirmed'], 4096);
    authorized(); return { status: 201, data: { item: service.create(body, { idempotencyKey }) } };
  }
  let match = /^\/course-studio\/sessions\/([^/]+)(?:\/(asset|messages|annotations))?$/.exec(route);
  if (match) {
    if (!match[2]) { if (method !== 'GET') fail('INVALID_INPUT'); return { status: 200, data: service.get(match[1]) }; }
    if (match[2] === 'asset') { if (method !== 'GET') fail('INVALID_INPUT'); const data = await guardedSource(options => service.asset(match[1], options)); authorized(); return { status: 200, data: { asset: data } }; }
    if (method !== 'POST') fail('INVALID_INPUT');
    if (match[2] === 'messages') {
      const body = await privateBody(['expected_revision', 'studio_hash', 'grant_id', 'mode', 'question', 'confirmed'], ['expected_revision', 'studio_hash', 'grant_id', 'mode', 'question', 'confirmed'], 6000); authorized();
      return { status: 202, data: await service.start(match[1], body, { idempotencyKey, authorize: authorized }) };
    }
    const body = await privateBody(['expected_revision', 'studio_hash', 'rectangle', 'label', 'message_id', 'quote_index', 'confirmed'], ['expected_revision', 'studio_hash', 'label', 'confirmed'], 6000); authorized();
    const item = await guardedSource(options => service.annotate(match[1], body, { ...options, idempotencyKey })); authorized(); return { status: 201, data: { item } };
  }
  match = /^\/course-studio\/messages\/([^/]+)\/(quiz-preview|quiz-review)$/.exec(route);
  if (match) {
    if (match[2] === 'quiz-preview') { if (method !== 'GET') fail('INVALID_INPUT'); return { status: 200, data: service.quizPreview(match[1]) }; }
    if (method !== 'POST') fail('INVALID_INPUT'); const body = await privateBody(['expected_revision', 'output_sha256', 'confirmed'], ['expected_revision', 'output_sha256', 'confirmed'], 4096); authorized(); return { status: 201, data: { item: service.reviewQuiz(match[1], body, { idempotencyKey }) } };
  }
  match = /^\/course-studio\/quizzes\/([^/]+)\/answer$/.exec(route);
  if (match) { if (method !== 'POST') fail('INVALID_INPUT'); const body = await privateBody(['expected_revision', 'question_id', 'response'], ['expected_revision', 'question_id', 'response'], 8000); authorized(); return { status: 201, data: service.answer(match[1], body, { idempotencyKey }) }; }
  match = /^\/course-studio\/attempts\/([^/]+)\/assess$/.exec(route);
  if (match) { if (method !== 'POST') fail('INVALID_INPUT'); const body = await privateBody(['expected_revision', 'assessment', 'reviewed_by_student'], ['expected_revision', 'assessment', 'reviewed_by_student'], 4096); authorized(); return { status: 200, data: { item: service.assess(match[1], body) } }; }
  match = /^\/course-studio\/annotations\/([^/]+)$/.exec(route);
  if (match) { if (method !== 'DELETE') fail('INVALID_INPUT'); const body = await privateBody(['expected_revision'], ['expected_revision'], 4096); authorized(); service.removeAnnotation(match[1], body.expected_revision); return { status: 200, data: { deleted: true, retention: 'Historical local records and backups can retain annotations.' } }; }
  return null;
}

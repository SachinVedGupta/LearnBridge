import { LearnBridgeError } from '@learnbridge/core';

/** Runs only behind the loopback paired-browser gate; requests cannot select an executor or tools. */
export async function handleCodingPracticeRoute({ route, method, privateBody, session, codingPracticeService, stillAuthorized, idempotencyKey }) {
  if (route !== '/coding-practice' && !route.startsWith('/coding-practice/')) return null;
  if (!session?.nonce) throw new LearnBridgeError('AUTH_REQUIRED'); if (!codingPracticeService) throw new LearnBridgeError('UNSUPPORTED');
  const authorize = () => { if (stillAuthorized) stillAuthorized(); return true; }, denied = () => { throw new LearnBridgeError('INVALID_INPUT'); };
  if (route === '/coding-practice/state') { if (method !== 'GET') denied(); authorize(); return { status: 200, data: codingPracticeService.state() }; }
  if (route === '/coding-practice/sessions') { if (method !== 'POST') denied(); const fields = ['problem_ref', 'language', 'mode'], body = await privateBody(fields, fields, 4096); authorize(); return { status: 201, data: { item: codingPracticeService.create(body, { idempotencyKey }) } }; }
  const match = /^\/coding-practice\/sessions\/([a-f0-9-]{36})(?:\/(checkpoint|import-submission|export-context|preview-run|run|transition))?$/.exec(route); if (!match) return null;
  if (!match[2]) { if (method !== 'GET') denied(); authorize(); return { status: 200, data: { item: codingPracticeService.get(match[1]) } }; }
  if (method !== 'POST') denied();
  const fields = { checkpoint: ['expected_revision', 'context_hash', 'code', 'explanation'], 'import-submission': ['expected_revision', 'context_hash', 'submission_ref', 'explanation', 'confirmed'], 'export-context': ['expected_revision', 'context_hash'], 'preview-run': ['expected_revision', 'context_hash', 'kind'], run: ['expected_revision', 'context_hash', 'kind', 'grant_id', 'prompt_sha256', 'confirmed'], transition: ['expected_revision', 'context_hash', 'action'] }[match[2]];
  const body = await privateBody(fields, fields, match[2] === 'checkpoint' ? 40000 : match[2] === 'import-submission' ? 14000 : 4096); authorize();
  const name = { checkpoint: 'checkpoint', 'import-submission': 'importSubmission', 'export-context': 'exportContext', 'preview-run': 'previewRun', run: 'run', transition: 'transition' }[match[2]];
  return { status: match[2] === 'run' ? 202 : 200, data: { item: await codingPracticeService[name](match[1], body, { idempotencyKey, authorize }) } };
}

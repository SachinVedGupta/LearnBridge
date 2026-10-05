import { LearnBridgeError } from '@learnbridge/core';

/** Reachable only through the loopback runtime's paired browser gate. */
export async function handleInterviewStudioRoute({ route, method, privateBody, session, interviewStudioService, stillAuthorized, idempotencyKey }) {
  if (route !== '/interview-studio' && !route.startsWith('/interview-studio/')) return null;
  if (!session?.nonce) throw new LearnBridgeError('AUTH_REQUIRED');
  if (!interviewStudioService) throw new LearnBridgeError('UNSUPPORTED');
  const authorize = () => { if (stillAuthorized) stillAuthorized(); return true; };
  const denied = () => { throw new LearnBridgeError('INVALID_INPUT'); };
  if (route === '/interview-studio/state') { if (method !== 'GET') denied(); authorize(); return { status: 200, data: interviewStudioService.state() }; }
  if (route === '/interview-studio/sessions') {
    if (method !== 'POST') denied(); const body = await privateBody(['role_ref', 'profile_refs', 'mode', 'round_limit'], ['role_ref', 'profile_refs', 'mode', 'round_limit'], 20000); authorize();
    return { status: 201, data: { item: interviewStudioService.create(body, { idempotencyKey }) } };
  }
  const match = /^\/interview-studio\/sessions\/([a-f0-9-]{36})(?:\/(export-context|preview-run|run|answer|transition))?$/.exec(route); if (!match) return null;
  if (!match[2]) { if (method !== 'GET') denied(); authorize(); return { status: 200, data: { item: interviewStudioService.get(match[1]) } }; }
  if (method !== 'POST') denied();
  const fields = { 'export-context': ['expected_revision', 'context_hash'], 'preview-run': ['expected_revision', 'context_hash'], run: ['expected_revision', 'context_hash', 'grant_id', 'prompt_sha256', 'confirmed'], answer: ['expected_revision', 'context_hash', 'round_id', 'student_answer'], transition: ['expected_revision', 'context_hash', 'action'] }[match[2]];
  const body = await privateBody(fields, fields, match[2] === 'answer' ? 12000 : 4096); authorize();
  const methodName = { 'export-context': 'exportContext', 'preview-run': 'previewRun', run: 'run', answer: 'answer', transition: 'transition' }[match[2]];
  const item = await interviewStudioService[methodName](match[1], body, { idempotencyKey, authorize }); return { status: match[2] === 'run' ? 202 : 200, data: { item } };
}

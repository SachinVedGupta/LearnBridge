import { LearnBridgeError } from '@learnbridge/core';
import { createLearningService } from './learning-service.mjs';

/** Called only after the host's paired-browser gate. Never exposed through agent IPC. */
export async function handleLearningRoute({ route, method, privateBody, store, getLibrary, idempotencyKey, session }) {
  if (!route.startsWith('/learning/')) return null;
  if (!session || typeof session.nonce !== 'string' || !session.nonce) throw new LearnBridgeError('AUTH_REQUIRED');
  const service = createLearningService({ store, getLibrary });
  const denied = () => { throw new LearnBridgeError('INVALID_INPUT'); };
  if (route === '/learning/sessions') {
    if (method === 'GET') return { status: 200, data: { items: service.listSessions() } };
    if (method !== 'POST') denied();
    const body = await privateBody(['scope', 'citations', 'topic', 'mode', 'academic_policy', 'student_attempt'], ['scope', 'citations', 'topic', 'mode', 'academic_policy'], 64000);
    return { status: 201, data: { item: service.createSession(body, { idempotencyKey }) } };
  }
  if (route === '/learning/checkpoints') { if (method !== 'GET') denied(); return { status: 200, data: { items: service.listCheckpoints() } }; }
  if (route === '/learning/reset-topic') {
    if (method !== 'POST') denied(); const body = await privateBody(['topic', 'expected_revisions'], ['topic', 'expected_revisions'], 12000);
    return { status: 200, data: service.resetTopic(body.topic, { expected_revisions: body.expected_revisions }) };
  }
  const planMatch = /^\/learning\/plans\/([^/]+)\/accept$/.exec(route);
  if (planMatch) { if (method !== 'POST') denied(); const body = await privateBody(['expected_revision', 'plan_hash', 'catch_up_hash'], ['expected_revision', 'plan_hash'], 4096); return { status: 200, data: { item: service.acceptCatchUp(planMatch[1], body) } }; }
  const match = /^\/learning\/sessions\/([^/]+)(?:\/(attempt|export|catch-up))?$/.exec(route); if (!match) return null;
  const recordId = match[1]; const action = match[2];
  if (!action) {
    if (method === 'GET') return { status: 200, data: { item: service.getSession(recordId) } };
    if (method === 'DELETE') { const body = await privateBody(['expected_revision'], ['expected_revision'], 4096); service.forgetSession(recordId, body.expected_revision); return { status: 200, data: { deleted: true, retention: 'Historical local revisions and backups may retain this session.' } }; }
    denied();
  }
  if (method !== 'POST') denied();
  if (action === 'export') { const body = await privateBody(['expected_revision', 'session_hash'], ['expected_revision', 'session_hash'], 4096); return { status: 201, data: service.exportRecipe(recordId, body) }; }
  if (action === 'attempt') {
    const body = await privateBody(['expected_revision', 'session_hash', 'question', 'student_response', 'feedback', 'assessment', 'reviewed_by_student'], ['expected_revision', 'session_hash', 'question', 'student_response'], 40000);
    return { status: 201, data: { item: service.saveAttempt(recordId, body, { idempotencyKey }) } };
  }
  const body = await privateBody(['expected_revision', 'session_hash', 'topics', 'selected_topic_ids', 'exam', 'planning_input'], ['expected_revision', 'session_hash', 'topics', 'selected_topic_ids', 'exam', 'planning_input'], 64000);
  return { status: 201, data: { item: service.previewCatchUp(recordId, body, { idempotencyKey }) } };
}

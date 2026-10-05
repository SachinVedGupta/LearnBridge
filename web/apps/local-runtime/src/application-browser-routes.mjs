import { LearnBridgeError } from '@learnbridge/core';

export async function handleApplicationBrowserRoute({ route, method, privateBody, session, applicationBrowserService, stillAuthorized, idempotencyKey }) {
  if (route !== '/application-browser' && !route.startsWith('/application-browser/')) return null;
  if (!session?.nonce) throw new LearnBridgeError('AUTH_REQUIRED'); if (!applicationBrowserService) throw new LearnBridgeError('UNSUPPORTED');
  const authorize = () => { if (stillAuthorized) stillAuthorized(); return true; }, denied = () => { throw new LearnBridgeError('INVALID_INPUT'); };
  if (route === '/application-browser/state') { if (method !== 'GET') denied(); authorize(); return { status: 200, data: applicationBrowserService.state() }; }
  if (route === '/application-browser/open') { if (method !== 'POST') denied(); const body = await privateBody(['role_ref', 'task_session_id', 'confirmed'], ['role_ref', 'task_session_id', 'confirmed'], 4096); authorize(); return { status: 201, data: { item: await applicationBrowserService.open(body, { authorize, idempotencyKey }) } }; }
  const match = /^\/application-browser\/sessions\/([a-f0-9-]{36})(?:\/(inspect|preview-fill|fill|close))?$/.exec(route); if (!match) return null;
  if (!match[2]) { if (method !== 'GET') denied(); authorize(); return { status: 200, data: { item: applicationBrowserService.get(match[1]) } }; }
  if (method !== 'POST') denied(); const fields = { inspect: ['expected_revision', 'confirmed'], 'preview-fill': ['expected_revision', 'form_fingerprint', 'mappings'], fill: ['expected_revision', 'payload_hash', 'confirmed'], close: ['expected_revision'] }[match[2]], body = await privateBody(fields, fields, match[2] === 'preview-fill' ? 64000 : 4096); authorize();
  const call = match[2] === 'preview-fill' ? 'previewFill' : match[2]; return { status: 200, data: { item: await applicationBrowserService[call](match[1], body, { authorize, idempotencyKey }) } };
}

import { randomUUID } from 'node:crypto';
import { createOnboardingWorkspace } from './onboarding.mjs';
import { HttpError } from './policy.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const selectionKeys = ['purpose', 'requested', 'profile_ids', 'source_entry_ids', 'snapshot_ids', 'document_ids', 'agent_grant_ids', 'destination'];

/** One paired runtime owns these human-review previews. No IPC/MCP entry point. */
export function createOnboardingRoutes({ store, studentWorkspace }) {
  const service = createOnboardingWorkspace(store, { studentWorkspace });
  const previews = new Map();
  const methodError = () => { throw new HttpError(405, 'UNSUPPORTED', 'This onboarding operation is unavailable.'); };
  return {
    clear() { previews.clear(); },
    async handle({ route, method, session, privateBody }) {
      if (!route.startsWith('/onboarding/')) return null;
      if (!session?.nonce) throw new HttpError(401, 'AUTH_REQUIRED', 'Pair this browser before reviewing setup.');
      if (route === '/onboarding/catalog') {
        if (method !== 'GET') methodError();
        return { status: 200, data: service.catalog() };
      }
      if (route === '/onboarding/preview') {
        if (method !== 'POST') methodError();
        const body = await privateBody(selectionKeys, selectionKeys, 16384);
        const preview = service.preview(body);
        for (const [key, value] of previews) if (value.expires < Date.now()) previews.delete(key);
        for (const [key, value] of previews) {
          if (previews.size < 10) break;
          if (value.consumed) previews.delete(key);
        }
        if (previews.size >= 10) throw new HttpError(429, 'RATE_LIMITED', 'Save a reviewed report or wait for the older previews to expire.');
        const previewId = randomUUID();
        previews.set(previewId, { preview, nonce: session.nonce, expires: Date.now() + 300000, consumed: false });
        return { status: 200, data: { preview_id: previewId, preview } };
      }
      if (route === '/onboarding/reports') {
        if (method === 'GET') return { status: 200, data: { items: service.listReports() } };
        if (method !== 'POST') methodError();
        const body = await privateBody(['preview_id', 'review_hash'], ['preview_id', 'review_hash'], 4096);
        if (!UUID.test(body.preview_id)) throw new HttpError(400, 'INVALID_INPUT', 'Review a valid setup preview.');
        const saved = previews.get(body.preview_id);
        if (!saved || saved.nonce !== session.nonce || saved.expires < Date.now()) throw new HttpError(403, 'CONSENT_REQUIRED', 'This setup preview ended. Review the selection again.');
        const item = service.save(saved.preview, { review_hash: body.review_hash, idempotency_key: `onboarding-${body.preview_id}` });
        saved.consumed = true;
        return { status: 201, data: { item } };
      }
      const report = /^\/onboarding\/reports\/([^/]+)$/.exec(route);
      if (!report || !UUID.test(report[1])) return null;
      if (method === 'GET') return { status: 200, data: { item: service.getReport(report[1]) } };
      if (method !== 'DELETE') methodError();
      const body = await privateBody(['expected_revision'], ['expected_revision'], 4096);
      service.forgetReport(report[1], body.expected_revision);
      return { status: 200, data: { deleted: true, retention: 'Only this active report was removed. Sources, profile facts, sharing choices, history and backups retain their own records.' } };
    },
  };
}

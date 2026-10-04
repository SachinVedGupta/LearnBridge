import { randomUUID } from 'node:crypto';
import { createCloudOnboarding } from './cloud-onboarding.mjs';
import { HttpError } from './policy.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
/** Paired browser review only. No cloud credentials, URL fetch, IPC or MCP operation. */
export function createCloudOnboardingRoutes({ store, clock = () => new Date().toISOString() }) {
  const service = createCloudOnboarding(store, { clock }), previews = new Map();
  const milliseconds = () => Date.parse(clock());
  const methodError = () => { throw new HttpError(405, 'UNSUPPORTED', 'This cloud import operation is unavailable.'); };
  return {
    clear() { previews.clear(); },
    async handle({ route, method, session, privateBody }) {
      if (!route.startsWith('/cloud-onboarding/')) return null;
      if (!session?.nonce) throw new HttpError(401, 'AUTH_REQUIRED', 'Pair this browser before importing selected cloud sources.');
      if (route === '/cloud-onboarding/preview') {
        if (method !== 'POST') methodError();
        const body = await privateBody(['bundle', 'academic_policy'], ['bundle', 'academic_policy'], 100000), preview = service.preview(body), now = milliseconds();
        for (const [id, value] of previews) if (value.expires <= now) previews.delete(id);
        for (const [id, value] of previews) { if (previews.size < 10) break; if (value.consumed) previews.delete(id); }
        if (previews.size >= 10) throw new HttpError(429, 'RATE_LIMITED', 'Finish a reviewed import or wait for older previews to expire.');
        const id = randomUUID(); previews.set(id, { preview, nonce: session.nonce, expires: now + 300000, consumed: false });
        return { status: 200, data: { preview_id: id, preview } };
      }
      if (route === '/cloud-onboarding/imports') {
        if (method === 'GET') return { status: 200, data: { items: service.list() } };
        if (method !== 'POST') methodError();
        const body = await privateBody(['preview_id', 'review_hash', 'confirm_owner'], ['preview_id', 'review_hash', 'confirm_owner'], 4096);
        if (!UUID.test(body.preview_id)) throw new HttpError(400, 'INVALID_INPUT', 'Review a valid selected-source preview.');
        const saved = previews.get(body.preview_id);
        if (!saved || saved.expires <= milliseconds() || saved.nonce !== session.nonce) throw new HttpError(403, 'CONSENT_REQUIRED', 'This preview ended. Review the file and account ownership again.');
        if (saved.consumed) {
          if (body.review_hash !== saved.preview.review_hash || body.confirm_owner !== true) throw new HttpError(403, 'CONSENT_REQUIRED', 'Confirm the exact reviewed selection.');
          const item = service.get(saved.item.id);
          if (item.revision !== saved.item.revision || !item.notes_current) throw new HttpError(409, 'REVISION_CONFLICT', 'Imported records changed. Prepare a new review.');
          return { status: 200, data: { item } };
        }
        const item = service.import(saved.preview, { review_hash: body.review_hash, confirm_owner: body.confirm_owner });
        saved.consumed = true; saved.item = { id: item.id, revision: item.revision };
        return { status: 201, data: { item } };
      }
      const match = /^\/cloud-onboarding\/imports\/([^/]+)$/.exec(route);
      if (!match || !UUID.test(match[1])) return null;
      if (method === 'GET') return { status: 200, data: { item: service.get(match[1]) } };
      if (method !== 'DELETE') methodError();
      const body = await privateBody(['expected_revision'], ['expected_revision'], 4096); service.forget(match[1], body.expected_revision);
      return { status: 200, data: { deleted: true, retention: 'This source receipt left active views. Imported notes, exports, historical revisions, backups and existing note-sharing grants retain their separate copies and choices.' } };
    },
  };
}

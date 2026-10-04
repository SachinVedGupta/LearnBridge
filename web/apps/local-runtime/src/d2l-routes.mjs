import { randomUUID } from 'node:crypto';
import { createD2lService } from './d2l-service.mjs';
import { HttpError } from './policy.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
/** Paired dashboard only. Connection and retained reviews belong to one nonce;
 * school browser control is never exposed over the agent IPC/MCP surface.
 */
export function createD2lRoutes({ studentWorkspace, browserFactory, clock = Date.now }) {
  const service = createD2lService({ studentWorkspace, ...(browserFactory ? { browserFactory } : {}), clock });
  const previews = new Map(); let owner = null;
  const methodError = () => { throw new HttpError(405, 'UNSUPPORTED', 'This school connection operation is unavailable.'); };
  async function school(work) {
    try { return await work(); }
    catch (error) {
      if (['AUTH_REQUIRED', 'AUTH_EXPIRED'].includes(error.code)) throw new HttpError(409, `D2L_${error.code}`,
        error.code === 'AUTH_EXPIRED' ? 'The school sign-in expired. Complete official sign-in and check the school account again.' : 'Complete official school sign-in in the separate browser, then check your school account.');
      throw error;
    }
  }
  function own(session) { if (!owner || owner !== session.nonce) throw new HttpError(403, 'CONSENT_REQUIRED', 'Open this school connection from the paired browser that started it.'); }
  return {
    capability() {
      const value = service.status();
      return { ...value.capability, state: value.connection?.state === 'ready' ? 'connected' : value.capability.state === 'available' ? 'requires_auth' : 'unsupported',
        proof: value.connection?.proof || 'none' };
    },
    async clear() { owner = null; previews.clear(); await service.close(); },
    async handle({ route, method, session, privateBody }) {
      if (!route.startsWith('/d2l/')) return null;
      if (!session?.nonce) throw new HttpError(401, 'AUTH_REQUIRED', 'Pair this browser before connecting your school.');
      if (route === '/d2l/status') {
        if (method !== 'GET') methodError(); const data = service.status();
        if (owner && owner !== session.nonce) data.connection = null;
        return { status: 200, data };
      }
      if (route === '/d2l/start') {
        if (method !== 'POST') methodError(); const body = await privateBody(['institution_id'], ['institution_id'], 4096);
        if (owner) throw new HttpError(403, 'CONSENT_REQUIRED', 'Disconnect the current school browser before opening another.');
        owner = session.nonce;
        try { return { status: 201, data: await school(() => service.start(body)) }; }
        catch (error) { if (owner === session.nonce) owner = null; throw error; }
      }
      if (['/d2l/verify', '/d2l/disconnect'].includes(route)) {
        if (method !== 'POST') methodError(); own(session);
        const body = await privateBody(['connection_id'], ['connection_id'], 4096);
        if (route === '/d2l/verify') return { status: 200, data: await school(() => service.verify(body)) };
        const data = await school(() => service.disconnect(body)); previews.clear(); owner = null; return { status: 200, data };
      }
      if (route === '/d2l/preview') {
        if (method !== 'POST') methodError(); own(session);
        const body = await privateBody(['connection_id', 'selected_course_ids', 'categories'], ['connection_id', 'selected_course_ids', 'categories'], 4096);
        for (const [key, value] of previews) if (value.expires <= clock() || value.consumed) previews.delete(key);
        if (previews.size >= 10) throw new HttpError(429, 'RATE_LIMITED', 'Review a school preview or wait for an older preview to expire.');
        const value = await school(() => service.preview(body)); own(session);
        const previewId = randomUUID(); previews.set(previewId, { value, nonce: session.nonce, expires: clock() + 300000, consumed: false });
        return { status: 200, data: { preview_id: previewId, ...value } };
      }
      if (route === '/d2l/import') {
        if (method !== 'POST') methodError(); own(session);
        const body = await privateBody(['preview_id', 'review_hash'], ['preview_id', 'review_hash'], 4096);
        if (typeof body.preview_id !== 'string' || !UUID.test(body.preview_id)) throw new HttpError(400, 'INVALID_INPUT', 'Review a valid school preview.');
        const saved = previews.get(body.preview_id);
        if (!saved || saved.nonce !== session.nonce || saved.expires <= clock()) throw new HttpError(403, 'CONSENT_REQUIRED', 'The school preview expired. Read and review the selected courses again.');
        const data = await school(() => service.save(saved.value, { review_hash: body.review_hash, idempotency_key: `d2l-preview-${body.preview_id}` }));
        saved.consumed = true; return { status: 201, data };
      }
      return null;
    },
  };
}

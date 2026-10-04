import { RemoteError, remoteObject, remoteFail } from '../../../packages/core/src/remote-companion.mjs';
import { createRemoteResults } from './remote-results.mjs';

/** Only the runtime's paired browser may enroll, approve results or foreground-poll. */
export function createRemoteRoutes(options) {
  let consent = false, ownerNonce = null, ownerExpires = 0, ownerAuthorize = null, controller = null, generation = 0, pairing = false;
  const previews = new Map(), external = options.authorize || (() => true);
  const clock = options.clock || (() => new Date().toISOString());
  const nativeAvailable = () => typeof options.nativeEnabled === 'function' ? options.nativeEnabled() === true : options.nativeEnabled === true;
  const authorized = () => { if (!consent || !ownerNonce || ownerExpires <= Date.parse(clock()) || external() !== true || typeof ownerAuthorize !== 'function') return false;
    try { return ownerAuthorize() !== false; } catch { return false; } };
  function create() {
    const capturedGeneration = generation, capturedNonce = ownerNonce;
    if (!controller) controller = createRemoteResults({ ...options, nativeEnabled: nativeAvailable(), instance: options.instance || (options.instanceFactory ? options.instanceFactory() : undefined),
      authorize: () => capturedGeneration === generation && capturedNonce === ownerNonce && authorized(),
      executeStudy: options.executeStudy && (input => { if (!nativeAvailable()) remoteFail('REMOTE_NATIVE_UNAVAILABLE', 503);
        return options.executeStudy({ ...input, authorize: () => nativeAvailable() && input.authorize() }); }) });
    return controller;
  }
  function current(id, body) {
    const row = controller.results().find(row => row.id === id);
    if (!row || row.revision !== body.expected_revision || row.review_hash !== body.review_hash) remoteFail('REMOTE_RESULT_CONFLICT', 409);
  }
  function clear({ nonce } = {}) {
    for (const [id, item] of previews) if (!nonce || item.nonce === nonce) previews.delete(id);
    if (nonce && nonce !== ownerNonce) return;
    generation++; pairing = false; consent = false; ownerNonce = null; ownerExpires = 0; ownerAuthorize = null;
    const previous = controller; controller = null; return previous?.stop();
  }
  return {
    get controller() { return controller; },
    clear,
    async handle({ route, method, privateBody, session, stillAuthorized }) {
      if (!route.startsWith('/remote/')) return null;
      if (!session?.nonce || typeof stillAuthorized !== 'function') remoteFail('REMOTE_AUTH_REQUIRED', 401);
      function live() {
        if (stillAuthorized() === false) remoteFail('REMOTE_AUTH_REQUIRED', 401);
        if (ownerNonce !== session.nonce || ownerExpires <= Date.parse(clock())) remoteFail('REMOTE_AUTH_REQUIRED', 403);
        ownerAuthorize = stillAuthorized;
      }
      try {
        if (stillAuthorized() === false) remoteFail('REMOTE_AUTH_REQUIRED', 401);
        if (ownerNonce && ownerExpires <= Date.parse(clock())) { await clear(); if (stillAuthorized() === false) remoteFail('REMOTE_AUTH_REQUIRED', 401); }
        if (route === '/remote/status' && method === 'GET') return { status: 200, data: ownerNonce === session.nonce && authorized() && controller ? { ...controller.status(), native_available: nativeAvailable(), native_execution: nativeAvailable() && controller.status().native_execution }
          : { enabled: options.enabled === true, paired: false, permission_current: false, native_available: nativeAvailable(), native_execution: false,
            foreground_required: true, credentials_persisted: false, requires_pairing_or_owner_recovery: true } };
        if (['/remote/jobs', '/remote/results'].includes(route) && method === 'GET') {
          if (!ownerNonce) return { status: 200, data: { items: [] } }; live();
          return { status: 200, data: { items: route === '/remote/jobs' ? controller.jobs() : controller.results() } };
        }
        if (method !== 'POST') remoteFail('INVALID_REMOTE_OPERATION', 405);
        if (route === '/remote/pair') {
          if (options.enabled !== true) remoteFail('REMOTE_DISABLED', 503);
          if (ownerNonce && ownerNonce !== session.nonce) remoteFail('REMOTE_AUTH_REQUIRED', 403);
          if (pairing || controller?.status().paired) remoteFail('REMOTE_BUSY', 409);
          const capturedGeneration = generation; let capturedController = null; pairing = true;
          try {
            const keys = ['pending_id', 'challenge', 'confirmed', 'host_grant_id', 'expires_in_minutes', 'max_requests', 'max_request_bytes', 'native_execution_confirmed'];
            const body = await privateBody(keys, keys, 8192); if (body.confirmed !== true) remoteFail('REMOTE_CONSENT_REQUIRED', 403);
            if (body.native_execution_confirmed === true && !nativeAvailable()) remoteFail('REMOTE_NATIVE_UNAVAILABLE', 503);
            if (stillAuthorized() === false || capturedGeneration !== generation) remoteFail('REMOTE_AUTH_REQUIRED', 401);
            if (typeof session.expires_at !== 'string' || !Number.isFinite(Date.parse(session.expires_at)) || Date.parse(session.expires_at) <= Date.parse(clock())) remoteFail('REMOTE_AUTH_REQUIRED', 401);
            ownerNonce = session.nonce; ownerExpires = Date.parse(session.expires_at); ownerAuthorize = stillAuthorized; consent = true; capturedController = create();
            const data = await capturedController.pair(body); live(); if (capturedGeneration !== generation || controller !== capturedController) remoteFail('REMOTE_AUTH_REQUIRED', 401);
            return { status: 201, data };
          } catch (error) {
            if (capturedGeneration === generation && controller === capturedController) await clear();
            else await capturedController?.stop(); throw error;
          } finally { if (capturedGeneration === generation) pairing = false; }
        }
        live(); if (!controller) remoteFail('REMOTE_PAIRING_REQUIRED', 403);
        if (route === '/remote/poll') {
          await privateBody([], [], 4096); const request = await controller.pollOnce();
          const native = controller.status().native_execution ? await controller.pollNative() : { state: 'unavailable' };
          live(); return { status: 200, data: { request, native } };
        }
        if (route === '/remote/delivery/poll') { await privateBody([], [], 4096); const data = await controller.pollDeliveryOnce(); live(); return { status: 200, data }; }
        if (route === '/remote/results/preview') {
          const keys = ['job_id', 'writing_record_id', 'expected_revision', 'payload_hash', 'expires_in_minutes'];
          const body = await privateBody(keys, keys, 4096), now = Date.parse(clock());
          for (const [key, value] of previews) if (value.expires <= now) previews.delete(key);
          if (previews.size >= 10) remoteFail('REMOTE_RATE_LIMITED', 429);
          const preview = await controller.previewResult(body); live(); const id = crypto.randomUUID();
          previews.set(id, { preview, nonce: session.nonce, expires: now + 300000 });
          return { status: 200, data: { preview_id: id, preview } };
        }
        if (route === '/remote/results') {
          const body = await privateBody(['preview_id', 'review_hash', 'confirmed'], ['preview_id', 'review_hash', 'confirmed'], 4096);
          const retained = previews.get(body.preview_id);
          if (!retained || retained.nonce !== session.nonce || retained.expires <= Date.parse(clock())) remoteFail('REMOTE_RESULT_CONSENT_REQUIRED', 403);
          const result = await controller.approveResult(retained.preview, { review_hash: body.review_hash, confirmed: body.confirmed });
          live(); previews.delete(body.preview_id); return { status: 201, data: { item: result } };
        }
        const match = /^\/remote\/results\/([a-f0-9-]+)\/(send|revoke)$/.exec(route);
        if (match) {
          const body = await privateBody(['expected_revision', 'review_hash'], ['expected_revision', 'review_hash'], 4096); current(match[1], body);
          const item = await controller[match[2] === 'send' ? 'sendResult' : 'revokeResult'](match[1]); live(); return { status: 200, data: { item } };
        }
        if (route === '/remote/unpair') { const body = await privateBody(['confirmed'], ['confirmed'], 4096);
          const data = await controller.unpair(body); live(); await clear();
          return { status: 200, data }; }
        return null;
      } catch (error) {
        if (!(error instanceof RemoteError)) throw error;
        return { status: error.status, data: { error: { code: error.code, message: error.code === 'REMOTE_DISABLED' ? 'Phone access is disabled. Finish the relay release checks before enabling it.'
          : error.code === 'REMOTE_NATIVE_UNAVAILABLE' ? 'Set up and verify the local Codex profile first, or leave agent execution unchecked.'
            : error.code === 'REMOTE_PAIRING_REQUIRED' ? 'Pair your phone and this computer before continuing.'
            : error.code === 'REMOTE_OFFLINE' ? 'The relay is unavailable. An uncertain upload will be checked before retrying.'
              : 'The phone action needs current permission and the exact reviewed records. Refresh and review before trying again.' } } };
      }
    },
  };
}

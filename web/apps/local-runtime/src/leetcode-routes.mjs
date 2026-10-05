import { createLeetCodeService } from './leetcode-service.mjs';
import { HttpError } from './policy.mjs';
import { createLeetCodeBrowser } from './leetcode-browser.mjs';
import { createLeetCodeClient } from './leetcode-client.mjs';

/** No remote/agent surface. The initiating paired browser owns live account authority. */
export function createLeetCodeRoutes({ store, clientFactory = createLeetCodeClient, browserFactory = createLeetCodeBrowser, clock }) {
  const service = createLeetCodeService({ store, clientFactory, ...(clock ? { clock } : {}) });
  let browser = browserFactory({ workspaceRoot: store.root }), owner = null, browserOwner = null, browserConnected = false;
  const browserView = () => { const value = browser.status(); return { ...value, sign_in_stage: value.state, state: ['awaiting_sign_in', 'awaiting_account_check', 'account_session_available', 'ready'].includes(value.state) ? 'open' : ['not_started', 'forgotten'].includes(value.state) ? 'closed' : value.state }; };
  const denyMethod = () => { throw new HttpError(405, 'UNSUPPORTED', 'This LeetCode operation is unavailable.'); };
  const own = session => { if (!owner || owner !== session.nonce) throw new HttpError(403, 'CONSENT_REQUIRED', 'Use the paired browser that connected this LeetCode account.'); };
  async function account(work) { try { return await work(); } catch (error) { if (['AUTH_REQUIRED', 'AUTH_EXPIRED'].includes(error.code)) { await service.disconnect(); throw new HttpError(409, 'LEETCODE_AUTH_REQUIRED', 'The LeetCode session is missing or expired. Finish normal sign-in in the LeetCode browser and check again; saved observations remain private local copies.'); }
    const statuses = { SCOPE_DENIED: 403, CONSENT_REQUIRED: 403, CANCELLED: 409, INVALID_INPUT: 400, BUDGET_EXCEEDED: 413, RATE_LIMITED: 429, NOT_FOUND: 404, OFFLINE: 502, PROVIDER_FAILURE: 502, TIMEOUT: 504 };
    if (Object.hasOwn(statuses, error.code)) throw new HttpError(statuses[error.code], error.code, 'The LeetCode read could not complete. Check the selected account and reconnect if needed. No platform data was changed.'); throw error; } }
  return {
    service,
    async clear() { owner = null; browserOwner = null; browserConnected = false; await Promise.allSettled([service.disconnect({ confirmed: true }), browser.close()]); },
    async close() { owner = null; browserOwner = null; browserConnected = false; await Promise.allSettled([service.close(), browser.close()]); },
    async handle({ route, method, session, privateBody, stillAuthorized, sourceOperation, idempotencyKey }) {
      if (!route.startsWith('/leetcode/')) return null;
      if (!session?.nonce) throw new HttpError(401, 'AUTH_REQUIRED', 'Pair this browser first.');
      const authorize = () => { stillAuthorized?.(); return true; };
      if (route === '/leetcode/state') { if (method !== 'GET') denyMethod(); authorize(); const data = service.state(); data.browser = browserView(); data.browser.owner = !browserOwner || browserOwner === session.nonce; if (browserOwner && browserOwner !== session.nonce) data.browser.state = 'owned_by_other_browser'; if (owner && owner !== session.nonce) data.connection = { state: 'disconnected', username: null, private_history_available: false, owned_by_other_browser: true, provider: 'learnbridge_bundled_leetcode_mcp' }; return { status: 200, data }; }
      const snapshot = /^\/leetcode\/snapshots\/([a-f0-9-]{36})$/.exec(route); if (snapshot) { if (method !== 'GET') denyMethod(); authorize(); return { status: 200, data: { item: service.snapshot(snapshot[1]) } }; }
      const retained = /^\/leetcode\/saved-submissions\/([a-f0-9-]{36})$/.exec(route); if (retained) { if (method !== 'GET') denyMethod(); authorize(); return { status: 200, data: { item: service.submission(retained[1]) } }; }
      const exportHistory = /^\/leetcode\/snapshots\/([a-f0-9-]{36})\/export-context$/.exec(route); if (exportHistory) { if (method !== 'POST') denyMethod(); const body = await privateBody(['expected_revision', 'sha256', 'confirmed'], ['expected_revision', 'sha256', 'confirmed'], 4096); authorize(); return { status: 201, data: { item: service.exportSnapshot(exportHistory[1], body) } }; }
      if (method !== 'POST') denyMethod();
      if (route === '/leetcode/browser/start') {
        const body = await privateBody(['confirmed'], ['confirmed'], 4096); authorize(); if (body.confirmed !== true) throw new HttpError(403, 'CONSENT_REQUIRED', 'Review this browser sign-in action.');
        if ((browserOwner && browserOwner !== session.nonce) || (owner && owner !== session.nonce)) throw new HttpError(403, 'CONSENT_REQUIRED', 'Use the paired browser that owns this account connection.');
        if (['closed', 'forgotten'].includes(browser.status().state)) browser = browserFactory({ workspaceRoot: store.root });
        const selectedBrowser = browser;
        browserOwner = session.nonce;
        try { await account(() => sourceOperation(() => selectedBrowser.start())); authorize(); if (browser !== selectedBrowser || browserOwner !== session.nonce) throw new HttpError(403, 'CONSENT_REQUIRED', 'The browser sign-in permission changed.'); return { status: 201, data: { browser: browserView() } }; } catch (error) { if (browser === selectedBrowser) browserOwner = null; await selectedBrowser.close(); throw error; }
      }
      if (route === '/leetcode/browser/forget') {
        const body = await privateBody(['confirmed'], ['confirmed'], 4096); authorize(); if (body.confirmed !== true) throw new HttpError(403, 'CONSENT_REQUIRED', 'Review removal of this saved local sign-in.');
        if ((browserOwner && browserOwner !== session.nonce) || (owner && owner !== session.nonce)) throw new HttpError(403, 'CONSENT_REQUIRED', 'Use the browser that owns this connection.');
        owner = null; browserOwner = null; browserConnected = false; await service.disconnect(); await browser.close({ forget: true }); return { status: 200, data: { forgotten: true, historical_copies_retained: true } };
      }
      if (route === '/leetcode/browser/check') {
        const body = await privateBody(['username', 'confirmed'], ['confirmed'], 4096); authorize(); if (body.confirmed !== true || browserOwner !== session.nonce || (owner && owner !== session.nonce)) throw new HttpError(403, 'CONSENT_REQUIRED', 'Open and review this local sign-in first.');
        if (body.username !== undefined && (typeof body.username !== 'string' || !/^[A-Za-z0-9_-]{1,50}$/.test(body.username))) throw new HttpError(400, 'INVALID_INPUT', 'Choose a valid optional account username.');
        const selectedBrowser = browser;
        const result = await account(() => sourceOperation(async signal => {
          let secret = await selectedBrowser.session({ signal }), probe = null; const epoch = selectedBrowser.authorityEpoch?.();
          try {
            const checkAuthority = () => { authorize(); if (browser !== selectedBrowser || browserOwner !== session.nonce || (epoch !== undefined && selectedBrowser.authorityEpoch?.() !== epoch)) throw new HttpError(403, 'CONSENT_REQUIRED', 'The local sign-in permission changed.'); return true; }; checkAuthority();
            const current = service.state().connection;
            if (current.state !== 'disconnected') {
              own(session); if (current.state !== 'private' || (body.username && body.username.toLowerCase() !== current.username.toLowerCase())) throw new HttpError(403, 'CONSENT_REQUIRED', 'Disconnect the current profile before choosing a different signed-in account.');
              await service.refreshSession(secret, { signal, authorize: checkAuthority });
            } else {
              probe = clientFactory({ session: secret }); const identity = await probe.call('get_user_status', {}, { signal }); checkAuthority();
              if (identity.isSignedIn !== true || typeof identity.username !== 'string') throw new HttpError(409, 'LEETCODE_AUTH_REQUIRED', 'Finish normal LeetCode sign-in in its browser.');
              if (body.username && body.username.toLowerCase() !== identity.username.toLowerCase()) throw new HttpError(403, 'SCOPE_DENIED', 'The signed-in LeetCode account differs from the selected username.');
              await probe.close(); probe = null; owner = session.nonce;
              await service.connect({ username: identity.username, session: secret, confirmed: true }, { signal, authorize: checkAuthority });
            }
            checkAuthority(); browserConnected = true; return service.state().connection;
          } finally { secret = ''; await probe?.close(); }
        })); return { status: 200, data: { connection: result, browser: browserView() } };
      }
      if (route === '/leetcode/connect') {
        const body = await privateBody(['username', 'session', 'confirmed'], ['username', 'confirmed'], 10000); authorize(); if (owner) throw new HttpError(403, 'CONSENT_REQUIRED', 'Disconnect the current LeetCode connection first.'); owner = session.nonce;
        try { const data = await account(() => sourceOperation(signal => service.connect(body, { signal, authorize }))); own(session); return { status: 201, data: { connection: data } }; } catch (error) { if (owner === session.nonce) owner = null; throw error; } finally { body.session = ''; }
      }
      if (route === '/leetcode/disconnect') { own(session); const body = await privateBody(['confirmed'], ['confirmed'], 4096); authorize(); const result = await service.disconnect(body); owner = null; browserOwner = null; browserConnected = false; await browser.close(); return { status: 200, data: result }; }
      own(session); const options = signal => ({ signal, authorize: () => { authorize(); own(session); return true; }, idempotencyKey });
      const withBrowser = async (signal, work) => {
        const opts = options(signal); if (!browserConnected) return work(opts);
        if (browserOwner !== session.nonce) throw new HttpError(403, 'CONSENT_REQUIRED', 'Review the local sign-in again.');
        const selectedBrowser = browser; let secret = await selectedBrowser.session({ signal }); const epoch = selectedBrowser.authorityEpoch?.(), normalAuthority = opts.authorize;
        opts.authorize = () => { normalAuthority(); if (browser !== selectedBrowser || browserOwner !== session.nonce || (epoch !== undefined && selectedBrowser.authorityEpoch?.() !== epoch)) throw new HttpError(403, 'CONSENT_REQUIRED', 'The local sign-in page changed. Check the signed-in account again.'); return true; };
        try { await service.refreshSession(secret, opts); } finally { secret = ''; }
        return work(opts);
      };
      if (route === '/leetcode/sync') { const body = await privateBody(['confirmed', 'limit', 'include_contest'], ['confirmed', 'limit', 'include_contest'], 4096); return { status: 201, data: { item: await account(() => sourceOperation(signal => withBrowser(signal, opts => service.sync(body, opts)))) } }; }
      if (route === '/leetcode/problems') { const body = await privateBody(['slug', 'confirmed'], ['slug', 'confirmed'], 4096); return { status: 201, data: { item: await account(() => sourceOperation(signal => withBrowser(signal, opts => service.fetchProblem(body, opts)))) } }; }
      const submission = /^\/leetcode\/submissions\/([1-9]\d{0,15})$/.exec(route); if (submission) { const body = await privateBody(['snapshot_id', 'confirmed'], ['snapshot_id', 'confirmed'], 4096); return { status: 201, data: { item: await account(() => sourceOperation(signal => withBrowser(signal, opts => service.fetchSubmission(submission[1], body, opts)))) } }; }
      return null;
    },
  };
}

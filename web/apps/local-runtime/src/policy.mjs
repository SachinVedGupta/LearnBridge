import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const hash = value => createHash('sha256').update(value).digest('hex');
export const opaqueToken = () => randomBytes(32).toString('base64url');
export function secretEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || actual.length > 256) return false;
  return timingSafeEqual(Buffer.from(hash(actual), 'hex'), Buffer.from(hash(expected), 'hex'));
}
const denied = () => { throw new HttpError(403, 'SCOPE_DENIED', 'This request is not from the paired local dashboard.'); };
const unauthenticated = () => { throw new HttpError(401, 'AUTH_REQUIRED', 'Pair this browser with the local launcher.'); };

export function assertLocalRequest(request, origin, { mutation = false } = {}) {
  const expectedHost = new URL(origin).host;
  if (request.headers.host !== expectedHost) denied();
  if (typeof request.url !== 'string' || !request.url.startsWith('/') || request.url.startsWith('//')) denied();
  const suppliedOrigin = request.headers.origin;
  if (suppliedOrigin !== undefined && suppliedOrigin !== origin) denied();
  if (mutation && suppliedOrigin !== origin) denied();
  const site = request.headers['sec-fetch-site'];
  if (site !== undefined && !['same-origin', 'none'].includes(site)) denied();
}

function cookieToken(request) {
  const header = request.headers.cookie;
  if (typeof header !== 'string' || header.length > 4096) return null;
  const values = header.split(';').map(item => item.trim()).filter(item => item.startsWith('lb_local_session='));
  if (values.length !== 1) return null;
  const value = values[0].slice('lb_local_session='.length);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

/** Sessions stay in memory. Restart invalidates every browser session/code. */
export function createSessionPolicy({ origin, sessionTtlMs = 8 * 60 * 60 * 1000, pairingTtlMs = 5 * 60 * 1000 }) {
  for (const duration of [sessionTtlMs, pairingTtlMs]) {
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > 24 * 60 * 60 * 1000) throw new TypeError('Invalid local session lifetime.');
  }
  const sessions = new Map();
  let pairing = null;
  let attempts = [];
  const prune = () => {
    const now = Date.now();
    for (const [key, value] of sessions) if (value.expiresAt <= now) sessions.delete(key);
    attempts = attempts.filter(time => now - time < 60_000);
  };
  const cookie = (token, ttl) => 'lb_local_session=' + token + '; HttpOnly; SameSite=Strict; Path=/api/local/v1; Max-Age=' + Math.max(1, Math.ceil(ttl / 1000));
  return {
    createPairingCode() {
      prune();
      const code = randomBytes(16).toString('base64url');
      pairing = { digest: hash(code), expiresAt: Date.now() + pairingTtlMs };
      return code;
    },
    pair(request, code) {
      assertLocalRequest(request, origin, { mutation: true });
      prune();
      if (attempts.length >= 5) throw new HttpError(429, 'RATE_LIMITED', 'Too many pairing attempts. Wait one minute.');
      attempts.push(Date.now());
      if (typeof code !== 'string' || code.length > 100 || !pairing || pairing.expiresAt <= Date.now()
        || !secretEqual(hash(code), pairing.digest)) unauthenticated();
      pairing = null;
      if (sessions.size >= 16) throw new HttpError(429, 'RATE_LIMITED', 'Too many paired sessions. Restart the local launcher.');
      const token = opaqueToken();
      const session = { nonce: opaqueToken(), expiresAt: Date.now() + sessionTtlMs };
      sessions.set(hash(token), session);
      return { cookie: cookie(token, sessionTtlMs), nonce: session.nonce, expires_at: new Date(session.expiresAt).toISOString() };
    },
    authenticate(request, { mutation = false, bootstrap = false } = {}) {
      assertLocalRequest(request, origin, { mutation });
      prune();
      const token = cookieToken(request);
      const session = token && sessions.get(hash(token));
      if (!session) unauthenticated();
      if (bootstrap) {
        if (request.headers['sec-fetch-site'] !== 'same-origin'
          || !['cors', 'same-origin'].includes(request.headers['sec-fetch-mode'])
          || (request.headers['sec-fetch-dest'] !== undefined && request.headers['sec-fetch-dest'] !== 'empty')) denied();
      } else if (!secretEqual(request.headers['x-learnbridge-nonce'], session.nonce)) denied();
      return { nonce: session.nonce, expires_at: new Date(session.expiresAt).toISOString() };
    },
    logout(request) {
      this.authenticate(request, { mutation: true });
      sessions.delete(hash(cookieToken(request)));
      return 'lb_local_session=; HttpOnly; SameSite=Strict; Path=/api/local/v1; Max-Age=0';
    },
    clear() { sessions.clear(); pairing = null; attempts = []; },
  };
}

export function plainBody(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some(key => !allowed.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) {
    throw new HttpError(400, 'INVALID_INPUT', 'The request does not match the local API.');
  }
  return value;
}

export function readJson(request, maxBytes = 300_000) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')) {
    throw new HttpError(415, 'INVALID_INPUT', 'Use a JSON request body.');
  }
  const advertised = request.headers['content-length'];
  if (advertised !== undefined && (!/^\d+$/.test(advertised) || Number(advertised) > maxBytes)) {
    request.resume();
    throw new HttpError(413, 'INVALID_INPUT', 'The request is too large.');
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let failed = false;
    const fail = error => { if (!failed) { failed = true; chunks.length = 0; reject(error); } };
    request.on('data', chunk => {
      if (failed) return;
      size += chunk.length;
      if (size > maxBytes) fail(new HttpError(413, 'INVALID_INPUT', 'The request is too large.'));
      else chunks.push(chunk);
    });
    request.on('error', () => fail(new HttpError(400, 'INVALID_INPUT', 'The request could not be read.')));
    request.on('aborted', () => fail(new HttpError(400, 'INVALID_INPUT', 'The request was interrupted.')));
    request.on('end', () => {
      if (failed) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { fail(new HttpError(400, 'INVALID_INPUT', 'The request must contain valid JSON.')); }
    });
  });
}

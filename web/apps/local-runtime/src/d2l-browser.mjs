import { spawn } from 'node:child_process';
import { accessSync, constants, lstatSync, mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AcademicError } from '../../../packages/local-academic/src/index.mjs';

export const D2L_INSTITUTION = Object.freeze({ id: 'mcmaster-avenue', name: 'McMaster Avenue to Learn',
  origin: 'https://avenue.cllmcmaster.ca', login_url: 'https://avenue.mcmaster.ca/login.php', timezone: 'America/Toronto' });
export const D2L_BROWSER_BINARY = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const D2L_BROWSER_LIMITS = Object.freeze({ outputBytes: 256000, frameBytes: 1000000, timeoutMs: 15000 });
const AUTH_LIMITS = Object.freeze({ tokenBytes: 8192, observations: 64, lifetimeMs: 15000 });
const SIGNED_OUT = /^\/d2l\/(?:(?:lp\/)?auth(?:\/|$)|(?:login|logout)(?:[/.]|$))/i;
const fail = code => { throw new AcademicError(code); };
const allowed = /^\/d2l\/api\/(?:versions\/|lp\/1\.\d{1,3}\/users\/whoami|lp\/1\.\d{1,3}\/courses\/[1-9]\d{0,14}|le\/1\.\d{1,3}\/[1-9]\d{0,14}\/(?:dropbox\/folders\/|news\/|content\/toc))$/;

/** Strict JSON boundary also used for synthetic transport responses. */
export function cloneD2lData(input, maxBytes = D2L_BROWSER_LIMITS.outputBytes) {
  let nodes = 0; const seen = new Set();
  function walk(value, depth) {
    if (++nodes > 20000 || depth > 16) fail('BUDGET_EXCEEDED');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') { if (value.includes('\0') || Buffer.byteLength(value) > maxBytes) fail('BUDGET_EXCEEDED'); return value; }
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || seen.has(value)) fail('INVALID_INPUT'); seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value); let result;
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 4000 || Reflect.ownKeys(value).length !== value.length + 1) fail('INVALID_INPUT');
      result = Array.from({ length: value.length }, (_, index) => { const descriptor = descriptors[index]; if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) fail('INVALID_INPUT'); return walk(descriptor.value, depth + 1); });
    } else {
      if (Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some(key => typeof key !== 'string'
        || ['__proto__', 'constructor', 'prototype'].includes(key) || !descriptors[key].enumerable || !('value' in descriptors[key]))) fail('INVALID_INPUT');
      result = Object.fromEntries(Object.keys(descriptors).map(key => [key, walk(descriptors[key].value, depth + 1)]));
    }
    seen.delete(value); return result;
  }
  const result = walk(input, 0); if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) fail('BUDGET_EXCEEDED'); return result;
}
function environment() {
  const values = Object.fromEntries(['HOME', 'LANG', 'LC_ALL', 'TMPDIR'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  return { ...values, PATH: '/usr/bin:/bin' };
}
function signalGroup(child, signal) {
  try { if (child?.pid && process.platform !== 'win32') { process.kill(-child.pid, signal); return; } } catch {}
  try { child?.kill(signal); } catch {}
}
function browserExpression(path, bearer) {
  // Per-request authorization mirrors Avenue MCP's browser-issued bearer flow.
  // No cookie/storage extraction, token exchange or global browser headers.
  return `(async () => {
    const origin = ${JSON.stringify(D2L_INSTITUTION.origin)}, path = ${JSON.stringify(path)}, max = ${D2L_BROWSER_LIMITS.outputBytes};
    const signedOut = new RegExp(${JSON.stringify(SIGNED_OUT.source)}, 'i');
    if (location.origin !== origin || !location.pathname.startsWith('/d2l/') || signedOut.test(location.pathname)) return { error: 'AUTH_REQUIRED' };
    const bearer = ${JSON.stringify(bearer)};
    if (path !== '/d2l/api/versions/' && !bearer) return { error: 'AUTH_REQUIRED' };
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(origin + path, { method: 'GET', mode: 'same-origin', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
        ...(path === '/d2l/api/versions/' ? {} : { headers: { Authorization: 'Bearer ' + bearer } }) });
      if (location.origin !== origin || !location.pathname.startsWith('/d2l/') || signedOut.test(location.pathname) || response.url !== origin + path) return { error: 'SCOPE_DENIED' };
      if (!response.ok) return { error: response.status === 401 ? 'AUTH_EXPIRED' : response.status === 403 ? 'SCOPE_DENIED' : response.status === 404 ? 'UNSUPPORTED' : 'PROVIDER_FAILURE' };
      const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (type !== 'application/json' && !(type.startsWith('application/') && type.endsWith('+json'))) return { error: 'AUTH_REQUIRED' };
      if (Number(response.headers.get('content-length')) > max) return { error: 'BUDGET_EXCEEDED' };
      const reader = response.body?.getReader(); if (!reader) return { error: 'PROVIDER_FAILURE' };
      const chunks = []; let length = 0;
      while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > max) { await reader.cancel(); return { error: 'BUDGET_EXCEEDED' }; } chunks.push(part.value); }
      const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (bearer && text.includes(bearer)) return { error: 'PROVIDER_FAILURE' };
      return { data: JSON.parse(text) };
    } catch (error) { return { error: error?.name === 'AbortError' ? 'TIMEOUT' : 'PROVIDER_FAILURE' }; }
    finally { clearTimeout(timer); }
  })()`;
}

/** A private CDP pipe owns a fresh visible Chrome profile. Never attaches to a
 * pre-existing browser or exposes a debugging port, secret or arbitrary command.
 * Injectable factory is a trusted test boundary, never accepted from the API.
 */
export function createD2lBrowser({ factory = spawn, timeoutMs = D2L_BROWSER_LIMITS.timeoutMs } = {}) {
  if (typeof factory !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 15000) fail('INVALID_INPUT');
  let child = null, profile = null, target = null, closed = null, closing = null, ended = false, nextId = 0, sessionId = null;
  let buffer = Buffer.alloc(0); const pending = new Map(); const proof = factory === spawn ? 'live' : 'fixture';
  // Credentials never enter status, SQLite, backups, logs or the hosted app.
  // Observe only this owned target's school API requests, without intercepting
  // or modifying the school's own traffic. ExtraInfo can precede its request.
  let bearer = null, bearerRequestId = null, authEpoch = 0, pageFrame = null, pageLoader = null, captureEnabled = false; const observations = new Map();
  function clearAuth() { bearer = null; bearerRequestId = null; authEpoch++; observations.clear(); captureEnabled = false; }
  function schoolPage(value) {
    try { const url = new URL(value); return url.origin === D2L_INSTITUTION.origin && !url.username && !url.password && url.pathname.startsWith('/d2l/') && !SIGNED_OUT.test(url.pathname); } catch { return false; }
  }
  function authorization(headers) {
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return null;
    const matches = Object.keys(headers).filter(key => key.toLowerCase() === 'authorization'); if (matches.length !== 1) return null;
    const value = headers[matches[0]];
    if (typeof value !== 'string' || value.length > AUTH_LIMITS.tokenBytes + 7 || !/^Bearer [A-Za-z0-9._~+/-]+=*$/.test(value)) return null;
    return value.slice(7);
  }
  function observe(value) {
    if (!sessionId || value.sessionId !== sessionId) return;
    if (value.method === 'Page.frameNavigated') {
      const frame = value.params?.frame;
      if (frame && !frame.parentId) {
        clearAuth(); pageFrame = frame.id; pageLoader = frame.loaderId;
        captureEnabled = typeof pageFrame === 'string' && typeof pageLoader === 'string' && Boolean(pageFrame && pageLoader) && schoolPage(frame.url);
      }
      return;
    }
    if (!captureEnabled) return;
    if (!['Network.requestWillBeSent', 'Network.requestWillBeSentExtraInfo'].includes(value.method)) return;
    const params = value.params, id = params?.requestId;
    if (typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(id)) return;
    const now = Date.now();
    for (const [key, item] of observations) if (now - item.at > AUTH_LIMITS.lifetimeMs || item.epoch !== authEpoch) observations.delete(key);
    let item = observations.get(id);
    if (!item) { if (observations.size >= AUTH_LIMITS.observations) observations.delete(observations.keys().next().value); item = { at: now, epoch: authEpoch, allowed: null, token: null, extraSeen: false }; observations.set(id, item); }
    if (value.method === 'Network.requestWillBeSent') {
      let valid = false;
      try { const url = new URL(params.request?.url); valid = params.frameId === pageFrame && params.loaderId === pageLoader && ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(params.request?.method) && schoolPage(params.documentURL)
        && url.origin === D2L_INSTITUTION.origin && !url.username && !url.password && !url.hash && /^\/d2l\/api\/(?:lp|le)\/1\.\d{1,3}\//.test(url.pathname); } catch {}
      item.allowed = valid;
      // ExtraInfo's raw headers take precedence when both observations exist.
      if (!item.extraSeen) item.token = authorization(params.request?.headers);
    } else { item.extraSeen = true; item.token = authorization(params.headers); }
    if (bearerRequestId === id && (item.allowed === false || (item.extraSeen && !item.token))) { clearAuth(); return; }
    if (item.allowed && item.token && item.epoch === authEpoch && bearer !== item.token) {
      bearer = item.token; bearerRequestId = id; authEpoch++; item.epoch = authEpoch;
    }
  }
  function capability() {
    let available = false;
    try { const stat = lstatSync(D2L_BROWSER_BINARY); accessSync(D2L_BROWSER_BINARY, constants.X_OK); available = process.platform === 'darwin' && stat.isFile() && !stat.isSymbolicLink(); } catch {}
    return { state: available || proof === 'fixture' ? 'available' : 'unsupported', platform: 'macos_chrome', proof: 'none',
      detail: 'Official school SSO/MFA in a fresh visible Chrome profile; browser-issued bearer authorization stays in connection memory. Actual account verification is required.' };
  }
  function rejectPending(code) {
    for (const item of pending.values()) { clearTimeout(item.timer); item.signal?.removeEventListener('abort', item.cancel); item.reject(new AcademicError(code)); }
    pending.clear();
  }
  function command(method, params = {}, { signal, scoped = false } = {}) {
    if (!child || ended || closing) return Promise.reject(new AcademicError('AUTH_REQUIRED'));
    if (signal?.aborted) return Promise.reject(new AcademicError('CANCELLED'));
    if (pending.size >= 4) return Promise.reject(new AcademicError('BUDGET_EXCEEDED'));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const stop = code => { const item = pending.get(id); if (!item) return; pending.delete(id); clearTimeout(item.timer); signal?.removeEventListener('abort', item.cancel); reject(new AcademicError(code)); void close(); };
      const cancel = () => stop('CANCELLED'), timer = setTimeout(() => stop('TIMEOUT'), timeoutMs);
      pending.set(id, { resolve, reject, signal, cancel, timer }); signal?.addEventListener('abort', cancel, { once: true });
      try { child.stdio[3].write(JSON.stringify({ id, method, params, ...(scoped ? { sessionId } : {}) }) + '\0'); } catch { stop('PROVIDER_FAILURE'); }
    });
  }
  function receive(chunk) {
    if (ended || closing) return;
    buffer = Buffer.concat([buffer, chunk]); if (buffer.length > D2L_BROWSER_LIMITS.frameBytes) { rejectPending('BUDGET_EXCEEDED'); void close(); return; }
    while (buffer.includes(0)) {
      const end = buffer.indexOf(0), frame = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
      let value; try { value = JSON.parse(frame.toString('utf8')); } catch { rejectPending('PROVIDER_FAILURE'); void close(); return; }
      if (value.method) { observe(value); continue; }
      const item = pending.get(value.id); if (!item) continue; pending.delete(value.id);
      clearTimeout(item.timer); item.signal?.removeEventListener('abort', item.cancel);
      if (value.error) item.reject(new AcademicError('PROVIDER_FAILURE')); else item.resolve(value.result);
    }
  }
  async function start() {
    if (child) fail('SCOPE_DENIED'); if (capability().state !== 'available') fail('UNSUPPORTED');
    // A repository-specific TMPDIR must not put the cookie-bearing Chrome
    // profile into Git, selected source roots or workspace database backups.
    const temporaryRoot = process.platform === 'darwin' ? '/private/tmp' : '/tmp';
    profile = mkdtempSync(join(temporaryRoot, 'learnbridge-d2l-browser-')); chmodSync(profile, 0o700);
    try {
      child = factory(D2L_BROWSER_BINARY, ['--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', 'about:blank'],
        { env: environment(), stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      if (!child?.stdio?.[3]?.write || !child.stdio[4]?.on || !child.once) fail('UNSUPPORTED');
      closed = new Promise(resolve => { child.once('close', () => { ended = true; clearAuth(); rejectPending('AUTH_REQUIRED'); resolve(); void close(); }); child.once('error', () => { ended = true; clearAuth(); rejectPending('UNSUPPORTED'); resolve(); void close(); }); });
      child.stdio[4].on('data', receive); child.stdio[3].on('error', () => { rejectPending('PROVIDER_FAILURE'); void close(); }); child.stdio[4].on('error', () => { rejectPending('PROVIDER_FAILURE'); void close(); });
      const created = await command('Target.createTarget', { url: 'about:blank' }); target = created?.targetId;
      if (typeof target !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(target)) fail('PROVIDER_FAILURE');
      const attached = await command('Target.attachToTarget', { targetId: target, flatten: true }); sessionId = attached?.sessionId;
      if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) fail('PROVIDER_FAILURE');
      await command('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 }, { scoped: true });
      await command('Page.enable', {}, { scoped: true });
      const navigation = await command('Page.navigate', { url: D2L_INSTITUTION.login_url }, { scoped: true });
      if (navigation?.errorText) fail('PROVIDER_FAILURE');
      return { state: 'awaiting_sign_in', institution: D2L_INSTITUTION, proof: 'none' };
    } catch (error) { await close(); throw error instanceof AcademicError ? error : new AcademicError('PROVIDER_FAILURE'); }
  }
  async function readJson(path, { signal } = {}) {
    if (typeof path !== 'string' || !allowed.test(path)) fail('SCOPE_DENIED');
    if (!sessionId || ended) fail('AUTH_REQUIRED');
    const epoch = authEpoch, credential = path === '/d2l/api/versions/' ? null : bearer;
    const response = await command('Runtime.evaluate', { expression: browserExpression(path, credential), awaitPromise: true, returnByValue: true }, { signal, scoped: true });
    if (authEpoch !== epoch || ended || closing) fail('AUTH_REQUIRED');
    if (response?.exceptionDetails || response?.result?.type !== 'object' || !response.result.value) fail('PROVIDER_FAILURE');
    const value = cloneD2lData(response.result.value);
    if (value.error) { if (value.error === 'AUTH_EXPIRED') clearAuth(); throw new AcademicError(value.error); }
    if (credential && JSON.stringify(value).includes(credential)) fail('PROVIDER_FAILURE');
    if (!Object.hasOwn(value, 'data') || Object.keys(value).length !== 1) fail('PROVIDER_FAILURE');
    return value.data;
  }
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      clearAuth(); rejectPending('CANCELLED'); const owned = child; signalGroup(owned, 'SIGTERM');
      if (owned && closed && !ended) {
        let timer; try { await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => { signalGroup(owned, 'SIGKILL'); resolve(); }, 1500); })]); } finally { clearTimeout(timer); }
      }
      signalGroup(owned, 'SIGKILL');
      if (owned && closed && !ended) {
        let timer; try { await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 1000); })]); } finally { clearTimeout(timer); }
      }
      ended = true; buffer = Buffer.alloc(0); sessionId = null; target = null;
      if (profile) rmSync(profile, { recursive: true, force: true }); profile = null;
    })();
    return closing;
  }
  return Object.freeze({ start, readJson, close, capability, proof });
}

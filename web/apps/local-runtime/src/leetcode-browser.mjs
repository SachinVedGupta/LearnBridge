import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { LeetCodeError, validateLeetCodeSession } from './leetcode-mcp.mjs';

export const LEETCODE_BROWSER_BINARY = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const LEETCODE_LOGIN_URL = 'https://leetcode.com/accounts/login/';
export const LEETCODE_BROWSER_LIMITS = Object.freeze({ timeoutMs: 15000, frameBytes: 256000, cookies: 1000 });
const fail = code => { throw new LeetCodeError(code); };
const inside = (path, parent) => { const value = relative(parent, path); return !value || (!value.startsWith('..') && !isAbsolute(value)); };
const markerName = '.learnbridge-leetcode-profile', leaseName = '.learnbridge-browser-owner';
function own(path, directory = false, privateMode = true) {
  let stat; try { stat = lstatSync(path); } catch { fail('SCOPE_DENIED'); }
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) || (process.getuid && stat.uid !== process.getuid()) || (privateMode && stat.mode & 0o077)) fail('SCOPE_DENIED');
  return stat;
}
function workspacePath(input) {
  if (typeof input !== 'string' || !input.isWellFormed() || input.length > 4096 || !isAbsolute(input) || /[\u0000-\u001f\u007f]/.test(input) || resolve(input) === '/') fail('INVALID_INPUT');
  const proposed = resolve(input); own(proposed, true); const root = realpathSync(proposed);
  // LocalStore already canonicalizes roots. Refuse explicit symlinked roots,
  // Git ancestors and an unmarked folder rather than adopting arbitrary files.
  const localMarker = join(root, '.learnbridge-local-root'); const stat = own(localMarker);
  if (stat.size !== Buffer.byteLength('learnbridge-local-data-v1\n') || readFileSync(localMarker, 'utf8') !== 'learnbridge-local-data-v1\n') fail('SCOPE_DENIED');
  for (let ancestor = root; ; ancestor = dirname(ancestor)) { if (existsSync(join(ancestor, '.git'))) fail('SCOPE_DENIED'); if (ancestor === dirname(ancestor)) break; }
  const parent = dirname(root), parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || ((parentStat.mode & 0o022) && !(parentStat.mode & 0o1000))) fail('SCOPE_DENIED');
  const profile = join(parent, `${basename(root)}-leetcode-browser`);
  if (profile === root || inside(profile, root)) fail('SCOPE_DENIED');
  const rootStat = own(root, true);
  return { root, rootInode: `${rootStat.dev}:${rootStat.ino}`, profile, marker: JSON.stringify({ format: 'learnbridge_leetcode_browser.v1', workspace_sha256: createHash('sha256').update(root).digest('hex') }) };
}
function allowedPage(input) {
  try {
    const url = new URL(input);
    return url.origin === 'https://leetcode.com' && !url.username && !url.password && !/^\/(?:accounts|account\/login|login|logout|signin|signup|cdn-cgi|captcha|challenge|security|sorry)(?:\/|$)/i.test(url.pathname);
  } catch { return false; }
}
const pageCheck = `(() => {
  const allowed = location.origin === 'https://leetcode.com' && !/^\\/(?:accounts|account\\/login|login|logout|signin|signup|cdn-cgi|captcha|challenge|security|sorry)(?:\\/|$)/i.test(location.pathname);
  const heading = (document.title + ' ' + (document.body?.innerText || '').slice(0, 4000)).toLowerCase();
  const blocked = /just a moment|verify (?:that )?you are human|checking your browser|access denied|security verification|complete the captcha|sorry, you have been blocked|captcha verification/.test(heading)
    || Boolean(document.querySelector('#challenge-form, #cf-challenge-running, [id^="cf-chl-"], iframe[src*="challenges.cloudflare.com"]'));
  return { allowed, blocked, loading: document.readyState === 'loading' };
})()`;
function environment() {
  const env = Object.fromEntries(['HOME', 'LANG', 'LC_ALL'].filter(key => typeof process.env[key] === 'string' && !process.env[key].startsWith('()')).map(key => [key, process.env[key]]));
  return { ...env, PATH: '/usr/bin:/bin', TMPDIR: process.platform === 'darwin' ? '/private/tmp' : '/tmp' };
}
function signalGroup(child, signal) { try { if (child?.pid && process.platform !== 'win32') { process.kill(-child.pid, signal); return; } } catch {} try { child?.kill(signal); } catch {} }

/** Dedicated visible Chrome profile, controlled over private pipes. The normal
 * website owns all sign-in/social-login/MFA; this adapter never fills, clicks,
 * submits or bypasses access checks. Profile cookies remain Chrome-managed.
 * factory is a trusted synthetic test seam, never an HTTP input. */
export function createLeetCodeBrowser({ workspaceRoot, factory = spawn, timeoutMs = LEETCODE_BROWSER_LIMITS.timeoutMs } = {}) {
  if (typeof factory !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > LEETCODE_BROWSER_LIMITS.timeoutMs) fail('INVALID_INPUT');
  let paths; try { paths = workspacePath(workspaceRoot); } catch (error) { throw error instanceof LeetCodeError ? error : new LeetCodeError('SCOPE_DENIED'); }
  const proof = factory === spawn ? 'live' : 'fixture'; let profileInode = null;
  let child = null, target = null, sessionId = null, closed = false, closing = null, exited = null, ended = false, lease = null, buffer = Buffer.alloc(0), nextId = 0, epoch = 0, frame = null, state = 'not_started';
  const pending = new Map();
  function validateProfile() {
    let current; try { current = workspacePath(paths.root); } catch { fail('SCOPE_DENIED'); } if (current.rootInode !== paths.rootInode) fail('SCOPE_DENIED');
    const profileStat = own(paths.profile, true), inode = `${profileStat.dev}:${profileStat.ino}`;
    if ((profileInode && inode !== profileInode) || realpathSync(paths.profile) !== paths.profile) fail('SCOPE_DENIED'); profileInode = inode;
    const file = join(paths.profile, markerName), stat = own(file);
    try { if (stat.size > 1000 || readFileSync(file, 'utf8') !== paths.marker) fail('SCOPE_DENIED'); } catch { fail('SCOPE_DENIED'); }
  }
  function ensureProfile() {
    if (!existsSync(paths.profile)) { mkdirSync(paths.profile, { mode: 0o700 }); writeFileSync(join(paths.profile, markerName), paths.marker, { mode: 0o600, flag: 'wx' }); }
    validateProfile();
    const file = join(paths.profile, leaseName); if (existsSync(file)) fail('SCOPE_DENIED');
    lease = JSON.stringify({ format: 'learnbridge_leetcode_browser_owner.v1', owner: randomUUID(), pid: process.pid });
    try { writeFileSync(file, lease, { mode: 0o600, flag: 'wx' }); } catch { lease = null; fail('SCOPE_DENIED'); }
  }
  function releaseLease() {
    if (!lease) return; validateProfile(); const file = join(paths.profile, leaseName), stat = own(file);
    if (stat.size > 1000 || readFileSync(file, 'utf8') !== lease) fail('SCOPE_DENIED'); rmSync(file); lease = null;
  }
  function capability() {
    let available = false;
    try { const stat = lstatSync(LEETCODE_BROWSER_BINARY); accessSync(LEETCODE_BROWSER_BINARY, constants.X_OK); available = process.platform === 'darwin' && stat.isFile() && !stat.isSymbolicLink(); } catch {}
    return { state: available || proof === 'fixture' ? 'available' : 'unsupported', platform: 'macos_chrome', proof: 'none',
      detail: 'Sign in yourself in a dedicated local Chrome window. LeetCode social login is supported by its website; this is not third-party OAuth. A private Chrome profile remembers sign-in on this Mac.' };
  }
  function status() { return { state, capability: capability(), profile_retained: existsSync(paths.profile), proof: 'none' }; }
  function rejectPending(code) { for (const item of pending.values()) { clearTimeout(item.timer); item.signal?.removeEventListener('abort', item.cancel); item.reject(new LeetCodeError(code)); } pending.clear(); }
  function command(method, params = {}, { signal, scoped = false } = {}) {
    if (!child || ended || closing || closed) return Promise.reject(new LeetCodeError('AUTH_REQUIRED'));
    if (signal?.aborted) return Promise.reject(new LeetCodeError('CANCELLED')); if (pending.size >= 4) return Promise.reject(new LeetCodeError('BUDGET_EXCEEDED'));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const stop = code => { const item = pending.get(id); if (!item) return; pending.delete(id); clearTimeout(item.timer); signal?.removeEventListener('abort', item.cancel); reject(new LeetCodeError(code)); void close().catch(() => {}); };
      const cancel = () => stop('CANCELLED'), timer = setTimeout(() => stop('TIMEOUT'), timeoutMs);
      pending.set(id, { resolve, reject, signal, cancel, timer }); signal?.addEventListener('abort', cancel, { once: true });
      try { child.stdio[3].write(JSON.stringify({ id, method, params, ...(scoped ? { sessionId } : {}) }) + '\0'); } catch { stop('PROVIDER_FAILURE'); }
    });
  }
  function observe(value) {
    if (!sessionId || value.sessionId !== sessionId) return;
    if (value.method === 'Page.frameNavigated' && value.params?.frame && !value.params.frame.parentId) {
      epoch++; const next = value.params.frame; frame = { id: next.id, loaderId: next.loaderId, url: next.url }; state = allowedPage(next.url) ? 'awaiting_account_check' : 'awaiting_sign_in';
    } else if (value.method === 'Page.navigatedWithinDocument' && value.params?.frameId === frame?.id) { epoch++; frame = { ...frame, url: value.params.url }; state = allowedPage(frame.url) ? 'awaiting_account_check' : 'awaiting_sign_in'; }
  }
  function receive(chunk) {
    if (closed || closing || ended) return;
    buffer = Buffer.concat([buffer, chunk]); if (buffer.length > LEETCODE_BROWSER_LIMITS.frameBytes) { rejectPending('BUDGET_EXCEEDED'); void close().catch(() => {}); return; }
    while (buffer.includes(0)) {
      const end = buffer.indexOf(0), raw = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
      let value; try { value = JSON.parse(raw.toString('utf8')); } catch { rejectPending('PROVIDER_FAILURE'); void close().catch(() => {}); return; }
      if (value.method) { observe(value); continue; }
      const item = pending.get(value.id); if (!item) continue; pending.delete(value.id); clearTimeout(item.timer); item.signal?.removeEventListener('abort', item.cancel);
      if (value.error) item.reject(new LeetCodeError('PROVIDER_FAILURE')); else item.resolve(value.result);
    }
  }
  async function start() {
    if (closed) fail('OFFLINE'); if (child || closing) fail('SCOPE_DENIED'); if (capability().state !== 'available') fail('UNSUPPORTED');
    try {
      ensureProfile(); child = factory(LEETCODE_BROWSER_BINARY, ['--remote-debugging-pipe', `--user-data-dir=${paths.profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', 'about:blank'],
        { env: environment(), stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      if (!child?.stdio?.[3]?.write || !child.stdio[4]?.on || !child.once) fail('UNSUPPORTED');
      exited = new Promise(resolve => { child.once('close', () => { ended = true; epoch++; frame = null; state = 'closed'; rejectPending('AUTH_REQUIRED'); resolve(); void close().catch(() => {}); }); child.once('error', () => { ended = true; epoch++; frame = null; state = 'closed'; rejectPending('UNSUPPORTED'); resolve(); void close().catch(() => {}); }); });
      child.stdio[4].on('data', receive); for (const stream of [child.stdio[3], child.stdio[4]]) stream.on('error', () => { rejectPending('PROVIDER_FAILURE'); void close().catch(() => {}); });
      const created = await command('Target.createTarget', { url: 'about:blank' }); target = created?.targetId; if (typeof target !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(target)) fail('PROVIDER_FAILURE');
      const attached = await command('Target.attachToTarget', { targetId: target, flatten: true }); sessionId = attached?.sessionId; if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) fail('PROVIDER_FAILURE');
      await command('Browser.setDownloadBehavior', { behavior: 'deny' });
      await command('Page.enable', {}, { scoped: true });
      const result = await command('Page.navigate', { url: LEETCODE_LOGIN_URL }, { scoped: true }); if (result?.errorText) fail('PROVIDER_FAILURE');
      state = 'awaiting_sign_in'; return status();
    } catch (error) { await close(); throw error instanceof LeetCodeError ? error : new LeetCodeError('PROVIDER_FAILURE'); }
  }
  async function session({ signal } = {}) {
    if (!child || closed || closing || ended || !sessionId) fail('AUTH_REQUIRED'); validateProfile(); const version = epoch;
    const current = () => { if (closed || ended || closing || epoch !== version || signal?.aborted) fail(signal?.aborted ? 'CANCELLED' : 'AUTH_REQUIRED'); };
    const tree = await command('Page.getFrameTree', {}, { scoped: true, signal }); current(); const top = tree?.frameTree?.frame;
    if (!top || !frame || top.id !== frame.id || top.loaderId !== frame.loaderId || top.url !== frame.url || !allowedPage(top.url)) fail('AUTH_REQUIRED');
    async function check() {
      const result = await command('Runtime.evaluate', { expression: pageCheck, returnByValue: true }, { scoped: true, signal }); current();
      const value = result?.result?.value;
      if (result?.exceptionDetails || result?.result?.type !== 'object' || !value || typeof value.allowed !== 'boolean' || typeof value.blocked !== 'boolean' || typeof value.loading !== 'boolean') fail('PROVIDER_FAILURE');
      if (value.blocked) { state = 'blocked'; fail('SCOPE_DENIED'); } if (!value.allowed || value.loading) fail('AUTH_REQUIRED');
    }
    await check(); current();
    const result = await command('Network.getCookies', { urls: ['https://leetcode.com/'] }, { scoped: true, signal }); current();
    if (!Array.isArray(result?.cookies) || result.cookies.length > LEETCODE_BROWSER_LIMITS.cookies) fail('BUDGET_EXCEEDED');
    const matches = result.cookies.filter(cookie => cookie?.name === 'LEETCODE_SESSION'); if (matches.length !== 1) fail('AUTH_REQUIRED');
    const cookie = matches[0];
    if (!['leetcode.com', '.leetcode.com'].includes(cookie.domain) || cookie.path !== '/' || cookie.secure !== true || cookie.httpOnly !== true || Object.hasOwn(cookie, 'partitionKey')) fail('SCOPE_DENIED');
    if (typeof cookie.expires !== 'number' || !Number.isFinite(cookie.expires) || (cookie.expires !== -1 && cookie.expires <= Date.now() / 1000)) fail('AUTH_EXPIRED');
    const value = validateLeetCodeSession(cookie.value); if (value.length < 20) fail('AUTH_REQUIRED');
    await check(); current(); validateProfile(); state = 'account_session_available';
    // Trusted local service only. Never return this string through HTTP/status.
    return value;
  }
  async function close({ forget = false } = {}) {
    if (typeof forget !== 'boolean') fail('INVALID_INPUT');
    if (!closing) closing = (async () => {
      closed = true; epoch++; frame = null; rejectPending('CANCELLED'); const owned = child; signalGroup(owned, 'SIGTERM');
      if (owned && exited && !ended) {
        let timer; try { await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { signalGroup(owned, 'SIGKILL'); resolve(); }, 1500); })]); } finally { clearTimeout(timer); }
      }
      signalGroup(owned, 'SIGKILL'); if (owned && exited && !ended) { let timer; try { await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 1000); })]); } finally { clearTimeout(timer); } }
      if (owned && !ended) fail('PROVIDER_FAILURE');
      buffer = Buffer.alloc(0); sessionId = null; target = null; child = null; state = 'closed'; releaseLease();
    })();
    await closing;
    if (forget && existsSync(paths.profile)) { validateProfile(); if (existsSync(join(paths.profile, leaseName))) fail('SCOPE_DENIED'); rmSync(paths.profile, { recursive: true, force: false }); state = 'forgotten'; }
    return status();
  }
  return Object.freeze({ start, status, session, close, capability, proof, authorityEpoch: () => epoch });
}

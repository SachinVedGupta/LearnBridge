import { spawn } from 'node:child_process';
import { accessSync, constants, lstatSync, mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { LearnBridgeError } from '@learnbridge/core';

export const APPLICATION_BROWSER_BINARY = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const APPLICATION_BROWSER_LIMITS = Object.freeze({ timeoutMs: 15000, frameBytes: 1500000, outputBytes: 90000, controls: 150, fields: 30 });
const fail = code => { throw new LearnBridgeError(code); };
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
export const applicationBrowserHash = value => sha(canonical(value));
export function checkedApplicationUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) fail('INVALID_INPUT'); let url; try { url = new URL(value); } catch { fail('SCOPE_DENIED'); }
  if (url.href !== value || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.search) fail('SCOPE_DENIED');
  const gh = url.hostname === 'job-boards.greenhouse.io' && /^\/[a-z0-9][a-z0-9_-]{0,99}\/jobs\/[1-9]\d{0,11}$/.test(url.pathname);
  const lever = url.hostname === 'jobs.lever.co' && /^\/[a-z0-9][a-z0-9_-]{0,99}\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:\/apply)?$/.test(url.pathname);
  if (!gh && !lever) fail('SCOPE_DENIED'); return value;
}

// Executed in an isolated world. No page-provided selector, script, callback,
// URL, cookie or storage expression crosses the paired HTTP boundary.
const snapshotCode = `(() => {
  const forms = Array.from(document.forms), nodes = Array.from(document.querySelectorAll('input,textarea,select,button'));
  if (nodes.length > 150 || forms.length > 20) return { error: 'BUDGET_EXCEEDED' };
  const safe = (v, n) => String(v || '').slice(0, n), protectedName = /password|token|secret|ssn|social.security|gender|race|ethnic|disab|veteran|sponsor|citizen|demograph|work.authoriz|gpa/i;
  const fields = [];
  for (let index = 0; index < nodes.length; index++) {
    const el = nodes[index], rect = el.getBoundingClientRect(), style = getComputedStyle(el);
    if (!rect.width || !rect.height || style.display === 'none' || style.visibility === 'hidden' || el.type === 'hidden') continue;
    const type = el.tagName.toLowerCase() === 'textarea' ? 'textarea' : el.tagName.toLowerCase() === 'select' ? 'select' : safe(el.type || 'text', 30);
    const label = safe(Array.from(el.labels || []).map(l => l.textContent).join(' ').trim() || el.getAttribute('aria-label') || el.placeholder || el.name || el.id || el.textContent, 1000);
    const name = safe(el.name || el.id, 300), formIndex = forms.indexOf(el.form);
    const eligible = ['text','email','tel','url','textarea'].includes(type) && !el.disabled && !el.readOnly && formIndex >= 0 && !protectedName.test(name + ' ' + label);
    fields.push({ id: 'field-' + index, form_id: formIndex < 0 ? null : 'form-' + formIndex, type, name, label, required: Boolean(el.required), disabled: Boolean(el.disabled), readonly: Boolean(el.readOnly), eligible, value: ['password','file'].includes(type) ? '' : safe(el.value, 8000), maxlength: Number.isSafeInteger(el.maxLength) && el.maxLength > -1 ? el.maxLength : null });
  }
  return { url: location.href, title: safe(document.title, 1000), forms: forms.map((form,index) => ({ id: 'form-' + index, method: safe(form.method, 20), action_origin: (()=>{try{return new URL(form.action,location.href).origin;}catch{return '';}})() })), fields, iframe_count: document.querySelectorAll('iframe').length, coverage: 'visible_top_level_controls_only' };
})()`;
function fillCode(expectedUrl, before, mappings) {
  return `(() => {
    const before = ${JSON.stringify(before)}, mappings = ${JSON.stringify(mappings)}, url = ${JSON.stringify(expectedUrl)};
    if (location.href !== url) return { error: 'SCOPE_DENIED' };
    const observed = ${snapshotCode};
    if (observed.error || JSON.stringify(observed) !== JSON.stringify(before)) return { error: 'REVISION_CONFLICT' };
    const nodes = Array.from(document.querySelectorAll('input,textarea,select,button'));
    const selected = mappings.map(m => ({ m, el: nodes[Number(m.field_id.slice(6))], field: before.fields.find(f => f.id === m.field_id) }));
    if (selected.some(r => !r.el || !r.field?.eligible || (r.field.maxlength !== null && r.m.value.length > r.field.maxlength))) return { error: 'SCOPE_DENIED' };
    const writes = [];
    for (const row of selected) {
      const desc = Object.getOwnPropertyDescriptor(row.field.type === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value');
      if (!desc?.set) return { error: 'VERSION_MISMATCH', partial_writes: writes.length };
      desc.set.call(row.el, row.m.value);
      row.el.dispatchEvent(new Event('input', { bubbles: true })); row.el.dispatchEvent(new Event('change', { bubbles: true }));
      writes.push({ field_id: row.m.field_id, value: row.el.value });
      if (location.href !== url || row.el.value !== row.m.value) return { error: 'UNKNOWN_OUTCOME', partial_writes: writes.length };
    }
    const after = ${snapshotCode}; if (after.error || location.href !== url) return { error: 'UNKNOWN_OUTCOME', partial_writes: writes.length };
    const expected = JSON.parse(JSON.stringify(before)); for (const row of mappings) expected.fields.find(f => f.id === row.field_id).value = row.value;
    if (JSON.stringify(after) !== JSON.stringify(expected)) return { error: 'UNKNOWN_OUTCOME', partial_writes: writes.length };
    return { snapshot: after, writes };
  })()`;
}
function environment() { return { ...Object.fromEntries(['HOME', 'LANG', 'LC_ALL'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])), PATH: '/usr/bin:/bin' }; }
function kill(child, signal) { try { if (child?.pid && process.platform !== 'win32') { process.kill(-child.pid, signal); return; } } catch {} try { child?.kill(signal); } catch {} }

/** A fresh owned Chrome, fixed commands only. testPageUrl is a trusted local
 * fixture seam, never a route parameter, and always labeled fixture proof. */
export function createApplicationBrowser({ factory = spawn, timeoutMs = APPLICATION_BROWSER_LIMITS.timeoutMs, testPageUrl = null } = {}) {
  if (typeof factory !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 15000) fail('INVALID_INPUT');
  if (testPageUrl !== null && (typeof testPageUrl !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/fixture\/application$/.test(testPageUrl))) fail('SCOPE_DENIED');
  let child = null, profile = null, sessionId = null, target = null, expectedUrl = null, ended = false, closing = null, closed = null, frozen = false, nextId = 0, buffer = Buffer.alloc(0), blocked = 0, world = null;
  const pending = new Map(), proof = testPageUrl || factory !== spawn ? 'fixture' : 'live_owned_browser';
  function capability() { let available = false; try { const stat = lstatSync(APPLICATION_BROWSER_BINARY); accessSync(APPLICATION_BROWSER_BINARY, constants.X_OK); available = process.platform === 'darwin' && stat.isFile() && !stat.isSymbolicLink(); } catch {} return { state: available || factory !== spawn ? 'available' : 'unsupported', platform: 'macos_chrome', mode: 'prepare_only', proof: 'none', automated_submission: false, automated_clicks: false, file_uploads: false }; }
  function rejectAll(code) { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new LearnBridgeError(code)); } pending.clear(); }
  function command(method, params = {}, scoped = true) {
    if (!child || ended || closing) return Promise.reject(new LearnBridgeError('OFFLINE')); if (pending.size >= 256) return Promise.reject(new LearnBridgeError('BUDGET_EXCEEDED'));
    return new Promise((resolve, reject) => { const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new LearnBridgeError('TIMEOUT')); void close(); }, timeoutMs); pending.set(id, { resolve, reject, timer });
      try { child.stdio[3].write(JSON.stringify({ id, method, params, ...(scoped ? { sessionId } : {}) }) + '\0'); } catch { clearTimeout(timer); pending.delete(id); reject(new LearnBridgeError('PROVIDER_FAILURE')); void close(); }
    });
  }
  function observe(value) {
    if (value.method === 'Target.targetCreated' && target && value.params?.targetInfo?.type === 'page' && value.params.targetInfo.targetId !== target) { void command('Target.closeTarget', { targetId: value.params.targetInfo.targetId }, false).catch(() => close()); return; }
    if (value.sessionId !== sessionId) return;
    if (value.method === 'Fetch.requestPaused') {
      const row = value.params, request = row?.request; if (!row?.requestId || !request) { void close(); return; }
      const denied = frozen || !['GET', 'HEAD'].includes(request.method) || (row.resourceType === 'Document' && request.url !== expectedUrl) || /^wss?:/i.test(request.url);
      if (denied) blocked++; void command(denied ? 'Fetch.failRequest' : 'Fetch.continueRequest', { requestId: row.requestId, ...(denied ? { errorReason: 'BlockedByClient' } : {}) }).catch(() => close());
    }
  }
  function receive(chunk) { if (ended || closing) return; buffer = Buffer.concat([buffer, chunk]); if (buffer.length > APPLICATION_BROWSER_LIMITS.frameBytes) { rejectAll('BUDGET_EXCEEDED'); void close(); return; }
    while (buffer.includes(0)) { const end = buffer.indexOf(0), frame = buffer.subarray(0, end); buffer = buffer.subarray(end + 1); let value; try { value = JSON.parse(frame.toString('utf8')); } catch { rejectAll('PROVIDER_FAILURE'); void close(); return; }
      if (value.method) { observe(value); continue; } const item = pending.get(value.id); if (!item) continue; clearTimeout(item.timer); pending.delete(value.id); if (value.error) item.reject(new LearnBridgeError('PROVIDER_FAILURE')); else item.resolve(value.result);
    }
  }
  async function evaluate(expression) { const response = await command('Runtime.evaluate', { expression, contextId: world, returnByValue: true, awaitPromise: true }); if (response?.exceptionDetails || response?.result?.type !== 'object' || !response.result.value) fail('PROVIDER_FAILURE'); const value = response.result.value;
    if (Buffer.byteLength(JSON.stringify(value)) > APPLICATION_BROWSER_LIMITS.outputBytes) fail('BUDGET_EXCEEDED'); if (value.error) fail(value.error); return JSON.parse(JSON.stringify(value));
  }
  async function top() { const tree = await command('Page.getFrameTree'); const frame = tree?.frameTree?.frame; if (!frame || frame.url !== expectedUrl) fail('SCOPE_DENIED'); const created = await command('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'learnbridge-application-preparation', grantUniveralAccess: false }); if (!Number.isSafeInteger(created?.executionContextId)) fail('VERSION_MISMATCH'); world = created.executionContextId; return frame; }
  async function start({ url }) {
    checkedApplicationUrl(url); if (child) fail('REVISION_CONFLICT'); if (capability().state !== 'available') fail('UNSUPPORTED'); expectedUrl = testPageUrl || url;
    profile = mkdtempSync(join(process.platform === 'darwin' ? '/private/tmp' : '/tmp', 'learnbridge-application-browser-')); chmodSync(profile, 0o700);
    try {
      child = factory(APPLICATION_BROWSER_BINARY, ['--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking', 'about:blank'], { env: environment(), stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      if (!child?.stdio?.[3]?.write || !child.stdio[4]?.on || !child.once) fail('UNSUPPORTED'); closed = new Promise(resolve => { child.once('close', () => { ended = true; rejectAll('OFFLINE'); resolve(); void close(); }); child.once('error', () => { ended = true; rejectAll('UNSUPPORTED'); resolve(); void close(); }); }); child.stdio[4].on('data', receive); child.stdio[3].on('error', () => close()); child.stdio[4].on('error', () => close());
      target = (await command('Target.createTarget', { url: 'about:blank' }, false))?.targetId; if (typeof target !== 'string') fail('VERSION_MISMATCH'); sessionId = (await command('Target.attachToTarget', { targetId: target, flatten: true }, false))?.sessionId; if (typeof sessionId !== 'string') fail('VERSION_MISMATCH');
      await command('Target.setDiscoverTargets', { discover: true }, false); await command('Browser.setDownloadBehavior', { behavior: 'deny' }, false);
      await command('Page.enable'); await command('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 }); await command('Network.setBypassServiceWorker', { bypass: true }); await command('Network.setBlockedURLs', { urls: ['ws://*', 'wss://*'] }); await command('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }); await command('Page.setInterceptFileChooserDialog', { enabled: true });
      const nav = await command('Page.navigate', { url: expectedUrl }); if (nav?.errorText) fail('PROVIDER_FAILURE'); return { state: 'opened', selected_url: url, proof, automatic_submission: false };
    } catch (error) { await close(); throw error instanceof LearnBridgeError ? error : new LearnBridgeError('PROVIDER_FAILURE'); }
  }
  async function snapshot() { await top(); const value = await evaluate(snapshotCode); if (value.url !== expectedUrl || value.coverage !== 'visible_top_level_controls_only' || !Array.isArray(value.fields) || value.fields.length > APPLICATION_BROWSER_LIMITS.controls) fail('VERSION_MISMATCH'); return { ...value, fingerprint: applicationBrowserHash(value), network_frozen: frozen, proof }; }
  async function fill({ expected_fingerprint, mappings }) {
    if (typeof expected_fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(expected_fingerprint) || !Array.isArray(mappings) || mappings.length < 1 || mappings.length > APPLICATION_BROWSER_LIMITS.fields || new Set(mappings.map(row => row.field_id)).size !== mappings.length || mappings.some(row => !row || Object.keys(row).length !== 2 || !/^field-\d{1,3}$/.test(row.field_id) || typeof row.value !== 'string' || !row.value.trim() || Buffer.byteLength(row.value) > 7000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(row.value))) fail('INVALID_INPUT');
    const current = await snapshot(), { fingerprint, network_frozen, proof: proofView, ...before } = current; if (fingerprint !== expected_fingerprint) fail('REVISION_CONFLICT');
    for (const row of mappings) { const field = before.fields.find(field => field.id === row.field_id); if (!field?.eligible || (field.maxlength !== null && row.value.length > field.maxlength)) fail('SCOPE_DENIED'); }
    // Page code stays disabled after review: a native setter must not give an
    // employer event handler a chance to send reviewed values elsewhere. The
    // fixed isolated DevTools evaluation remains available for local readback.
    frozen = true; await command('Emulation.setScriptExecutionDisabled', { value: true }); await command('Network.setBlockedURLs', { urls: ['*'] });
    try { const filled = await evaluate(fillCode(expectedUrl, before, mappings)); const observed = await snapshot(); if (JSON.stringify(filled.snapshot) !== JSON.stringify(Object.fromEntries(Object.entries(observed).filter(([key]) => !['fingerprint', 'network_frozen', 'proof'].includes(key))))) fail('UNKNOWN_OUTCOME');
      return { snapshot: observed, writes: filled.writes, proof, effects: { field_writes: filled.writes.length, navigation: 0, clicks: 0, uploads: 0, submissions: 0 }, network_frozen: true, blocked_requests: blocked };
    } catch (error) { if (!['SCOPE_DENIED', 'REVISION_CONFLICT'].includes(error.code)) fail('UNKNOWN_OUTCOME'); throw error; }
  }
  async function close() { if (closing) return closing; closing = (async () => { rejectAll('CANCELLED'); const owned = child; kill(owned, 'SIGTERM'); if (owned && closed && !ended) { let timer; try { await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => { kill(owned, 'SIGKILL'); resolve(); }, 1500); })]); } finally { clearTimeout(timer); } } kill(owned, 'SIGKILL'); ended = true; buffer = Buffer.alloc(0); world = null; sessionId = null; target = null; if (profile) rmSync(profile, { recursive: true, force: true }); profile = null; })(); return closing; }
  return Object.freeze({ capability, start, snapshot, fill, close, proof, status: () => ({ opened: Boolean(child && !ended && !closing), network_frozen: frozen, proof }) });
}

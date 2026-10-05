// Private-pipe fixture with invented cookies. No browser, credentials or network.
import { createReadStream, writeSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const mode = process.argv[2] || 'normal'; let buffer = Buffer.alloc(0), loader = 1;
const sessionId = 'synthetic-leetcode-cdp', frameId = 'synthetic-main-frame';
let url = 'https://leetcode.com/';
const urls = { signed_out: 'https://leetcode.com/accounts/login/', foreign_origin: 'https://accounts.google.com/signin', lookalike_origin: 'https://leetcode.com.outside.test/', insecure_origin: 'http://leetcode.com/', userinfo_origin: 'https://student:secret@leetcode.com/', security_path: 'https://leetcode.com/cdn-cgi/challenge-platform/' };
if (urls[mode]) url = urls[mode];
const cookie = { name: 'LEETCODE_SESSION', value: 'SYNTHETIC_OWNED_LEETCODE_COOKIE_CANARY.v1', domain: '.leetcode.com', path: '/', secure: true, httpOnly: true, expires: Date.now() / 1000 + 3600 };
const bad = { bad_domain: ['domain', '.outside.test'], bad_path: ['path', '/private/'], insecure_cookie: ['secure', false], readable_cookie: ['httpOnly', false], expired: ['expires', 1], oversized_cookie: ['value', 'x'.repeat(8193)], newline_cookie: ['value', 'secret\r\nheader'], short_cookie: ['value', 'short'], partitioned_cookie: ['partitionKey', { topLevelSite: 'https://leetcode.com' }] };
if (bad[mode]) cookie[bad[mode][0]] = bad[mode][1];
function output(value) { writeSync(4, JSON.stringify(value) + '\0'); }
function event(method, params, owner = sessionId) { output({ method, params, sessionId: owner }); }
function top(next = url) { url = next; event('Page.frameNavigated', { frame: { id: frameId, loaderId: `loader-${loader++}`, url } }); }
function answer(request, result) { output({ id: request.id, result }); }
async function receive(request) {
  if (process.env.LEARNBRIDGE_TEST_SECRET_CANARY || process.env.OPENAI_API_KEY || process.env.NODE_OPTIONS) process.exit(3);
  if (mode === 'malformed') { writeSync(4, '{bad\0'); return; }
  if (request.method === 'Target.createTarget') { if (request.params.url !== 'about:blank') process.exit(4); return answer(request, { targetId: 'synthetic-target' }); }
  if (request.method === 'Target.attachToTarget') { if (request.params.targetId !== 'synthetic-target' || request.params.flatten !== true) process.exit(4); return answer(request, { sessionId }); }
  if (request.method === 'Browser.setDownloadBehavior') { if (request.params.behavior !== 'deny') process.exit(4); return answer(request, {}); }
  if (request.sessionId !== sessionId) process.exit(4);
  if (request.method === 'Page.enable') return answer(request, {});
  if (request.method === 'Page.navigate') { if (request.params.url !== 'https://leetcode.com/accounts/login/') process.exit(4); top(); return answer(request, { frameId }); }
  if (request.method === 'Page.getFrameTree') return answer(request, { frameTree: { frame: { id: frameId, loaderId: `loader-${loader - 1}`, url } } });
  if (request.method === 'Runtime.evaluate') {
    if (!request.params.returnByValue || request.params.awaitPromise || /document\.cookie|localStorage|sessionStorage|fetch\(|https:\/\//.test(request.params.expression.replace('https://leetcode.com', ''))) process.exit(4);
    const parsed = new URL(url), data = runInNewContext(request.params.expression, { location: { origin: parsed.origin, pathname: parsed.pathname }, document: { title: mode === 'blocked' ? 'Just a moment...' : 'LeetCode', body: { innerText: mode === 'body_blocked' ? 'Verify you are human' : 'Synthetic student page' }, readyState: mode === 'loading' ? 'loading' : 'complete', querySelector: () => mode === 'captcha_element' ? {} : null } });
    return answer(request, { result: { type: 'object', value: data } });
  }
  if (request.method === 'Network.getCookies') {
    if (JSON.stringify(request.params) !== JSON.stringify({ urls: ['https://leetcode.com/'] })) process.exit(4);
    if (mode === 'slow') return;
    if (mode === 'navigate_in_flight') top('https://leetcode.com/problemset/');
    if (mode === 'logout_in_flight') top('https://leetcode.com/accounts/login/');
    if (mode === 'same_document_in_flight') { url = 'https://leetcode.com/?changed=1'; event('Page.navigatedWithinDocument', { frameId, url }); }
    if (mode === 'subframe_event') event('Page.frameNavigated', { frame: { id: 'child-frame', parentId: frameId, loaderId: 'child-loader', url: 'https://outside.test/' } });
    if (mode === 'foreign_session_event') event('Page.frameNavigated', { frame: { id: frameId, loaderId: 'foreign-loader', url: 'https://outside.test/' } }, 'unowned-session');
    if (mode === 'oversized_frame') return output({ id: request.id, result: { cookies: [], padding: 'x'.repeat(300000) } });
    const cookies = mode === 'missing_cookie' ? [] : mode === 'duplicate_cookie' ? [cookie, { ...cookie, domain: 'leetcode.com' }] : [cookie];
    return answer(request, { cookies });
  }
  process.exit(4);
}
createReadStream(null, { fd: 3 }).on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); while (buffer.includes(0)) { const end = buffer.indexOf(0), raw = buffer.subarray(0, end); buffer = buffer.subarray(end + 1); void receive(JSON.parse(raw.toString('utf8'))); } });

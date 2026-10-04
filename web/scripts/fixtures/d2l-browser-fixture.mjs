import { createReadStream, readFileSync, writeSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Invented school data in a separate process. It executes the shipped in-page
// expression with a synthetic fetch boundary, never contacts a real institution.
const mode = process.argv[2] || 'normal', controlPath = process.argv[3]; let buffer = Buffer.alloc(0), identities = 0, protectedReads = 0;
const origin = 'https://avenue.cllmcmaster.ca';
const sessionId = 'synthetic-cdp-session', bearer = 'SYNTHETIC_D2L_BEARER_CANARY.v1', rotatedBearer = 'SYNTHETIC_D2L_BEARER_CANARY.v2';
let expectedBearer = bearer, loaderId = 'synthetic-school-loader-0', navigationCount = 0;
function output(value) { writeSync(4, JSON.stringify(value) + '\0'); }
function event(method, params, owner = sessionId) { output({ method, params, sessionId: owner }); }
function topFrame(url = origin + '/d2l/home') {
  loaderId = `synthetic-school-loader-${++navigationCount}`;
  event('Page.frameNavigated', { frame: { id: 'synthetic-main-frame', url, loaderId } });
}
function tokenRequest({ url = origin + '/d2l/api/lp/1.49/users/whoami', documentURL = origin + '/d2l/home', method = 'GET', headers = { Authorization: `Bearer ${expectedBearer}` }, requestId = 'synthetic-api-request', owner = sessionId, loader = loaderId, frameId = 'synthetic-main-frame' } = {}) {
  event('Network.requestWillBeSent', { requestId, documentURL, frameId, loaderId: loader, request: { url, method, headers } }, owner);
}
function authenticate() {
  topFrame();
  const cases = {
    missing_token: null,
    foreign_origin: { url: 'https://outside.example/d2l/api/lp/1.49/users/whoami' },
    lookalike_origin: { url: 'https://avenue.cllmcmaster.ca.outside.example/d2l/api/lp/1.49/users/whoami' },
    insecure_origin: { url: 'http://avenue.cllmcmaster.ca/d2l/api/lp/1.49/users/whoami' },
    foreign_document: { documentURL: 'https://outside.example/d2l/home' },
    login_document: { documentURL: origin + '/d2l/login' },
    wrong_session: { owner: 'synthetic-foreign-session' },
    wrong_frame: { frameId: 'synthetic-unowned-frame' },
    wrong_loader: { loader: 'synthetic-old-loader' },
    post_request: { method: 'POST' },
    head_request: { method: 'HEAD' },
    put_request: { method: 'PUT' },
    patch_request: { method: 'PATCH' },
    delete_request: { method: 'DELETE' },
    options_request: { method: 'OPTIONS' },
    invalid_method: { method: 'TRACE' },
    non_api_request: { url: origin + '/d2l/lp/auth/oauth2/token' },
    blank_token: { headers: { Authorization: 'Bearer ' } },
    invalid_token: { headers: { Authorization: 'Bearer =bad' } },
    newline_token: { headers: { Authorization: 'Bearer abc\r\nInjected: value' } },
    oversized_token: { headers: { Authorization: 'Bearer ' + 'a'.repeat(9000) } },
    duplicate_headers: { headers: { Authorization: `Bearer ${bearer}`, authorization: `Bearer ${bearer}` } },
  };
  if (Object.hasOwn(cases, mode)) { if (cases[mode]) tokenRequest(cases[mode]); return; }
  if (mode === 'redirected_foreign') { tokenRequest(); tokenRequest({ url: 'https://outside.example/d2l/api/lp/1.49/users/whoami' }); return; }
  if (mode.startsWith('extra_')) {
    const requestId = 'synthetic-extra-request', extra = { requestId, headers: { authorization: `Bearer ${bearer}` } };
    if (mode === 'extra_unknown') { event('Network.requestWillBeSentExtraInfo', extra); return; }
    if (mode === 'extra_wrong_session') { tokenRequest({ requestId, headers: {} }); event('Network.requestWillBeSentExtraInfo', extra, 'synthetic-foreign-session'); return; }
    if (mode === 'extra_foreign_origin') { event('Network.requestWillBeSentExtraInfo', extra); tokenRequest({ requestId, headers: {}, url: 'https://outside.example/d2l/api/lp/1.49/users/whoami' }); return; }
    if (mode === 'extra_evicted') {
      event('Network.requestWillBeSentExtraInfo', extra);
      for (let index = 0; index < 64; index++) tokenRequest({ requestId: `synthetic-pressure-${index}`, headers: {}, url: 'https://outside.example/d2l/api/lp/1.49/users/whoami' });
      tokenRequest({ requestId, headers: {} }); return;
    }
    if (mode === 'extra_before_navigation') { event('Network.requestWillBeSentExtraInfo', extra); topFrame(); tokenRequest({ requestId, headers: {} }); return; }
    if (mode === 'extra_invalid_after_valid') { tokenRequest({ requestId }); extra.headers = { Authorization: 'Bearer =bad' }; event('Network.requestWillBeSentExtraInfo', extra); return; }
    if (mode === 'extra_duplicate_headers') extra.headers.Authorization = `Bearer ${bearer}`;
    if (mode === 'extra_before') event('Network.requestWillBeSentExtraInfo', extra);
    tokenRequest({ requestId, headers: {} });
    if (mode !== 'extra_before') event('Network.requestWillBeSentExtraInfo', extra);
    return;
  }
  if (mode === 'lowercase_header') tokenRequest({ headers: { authorization: `Bearer ${bearer}` } });
  else tokenRequest();
}
function response(body, url, status = 200, type = 'application/json') {
  const value = new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': type } });
  Object.defineProperty(value, 'url', { value: url }); return value;
}
async function fetchSchool(url, options) {
  const control = controlPath ? JSON.parse(readFileSync(controlPath, 'utf8')) : {};
  if (options.method !== 'GET' || options.credentials !== 'omit' || options.mode !== 'same-origin' || options.redirect !== 'error'
    || options.cache !== 'no-store' || options.body || !url.startsWith(origin + '/d2l/api/')) throw new Error('Unexpected synthetic school request');
  const path = url.slice(origin.length);
  // Versions are public. Every protected fixture read rejects cookie-only auth,
  // so these tests execute and validate the actual shipped bearer expression.
  if (path === '/d2l/api/versions/') {
    if (options.headers && Object.keys(options.headers).length) throw new Error('Bearer was sent to a public versions endpoint');
  } else {
    protectedReads++;
    if (!options.headers || Object.keys(options.headers).length !== 1 || options.headers.Authorization !== `Bearer ${expectedBearer}`) {
      return response('SYNTHETIC_SECRET_DIAGNOSTIC_CANARY: authenticated API requires bearer', url, 401, 'text/plain');
    }
  }
  if (mode === 'slow' || control.slow) return new Promise(() => {});
  if (mode === 'denied') return response('SYNTHETIC_SECRET_DIAGNOSTIC_CANARY', url, 403, 'text/plain');
  if (mode === 'expired' || mode === 'expired_resurrection') return response('SYNTHETIC_SECRET_DIAGNOSTIC_CANARY', url, 401, 'text/plain');
  if (mode === 'html') return response('<form>Not signed in</form>', url, 200, 'text/html');
  if (mode === 'redirect') return response({}, 'https://outside.example/d2l/api/versions/');
  if (mode === 'oversized') return response('x'.repeat(256001), url);
  if (mode === 'invalid_json') return response('{broken', url);
  if (control.expired) return response('SYNTHETIC_SECRET_DIAGNOSTIC_CANARY', url, 401, 'text/plain');
  if (control.denied) return response('SYNTHETIC_SECRET_DIAGNOSTIC_CANARY', url, 403, 'text/plain');
  if (path === '/d2l/api/versions/') return response(control.versions || [{ ProductCode: 'lp', LatestVersion: '1.49', SupportedVersions: ['1.43', '1.49'] },
    { ProductCode: 'le', LatestVersion: '1.85', SupportedVersions: ['1.57', '1.85'] }], url);
  if (path.endsWith('/users/whoami')) {
    identities++;
    if (control.slowIdentity) return new Promise(() => {});
    if (mode === 'reflect_token') return response({ Identifier: '12345', DisplayName: expectedBearer }, url);
    return response({ Identifier: control.account || (mode === 'switch_account' && identities > 1 ? '99999' : '12345'), FirstName: 'Synthetic', LastName: 'Student',
      UniqueName: 'synthetic-student@example.test', ProfileIdentifier: 'SYNTHETIC_UNRETURNED_ID_CANARY',
      EnvLeaked: Boolean(process.env.LEARNBRIDGE_TEST_SECRET_CANARY || process.env.OPENAI_API_KEY || process.env.NODE_OPTIONS) }, url);
  }
  const course = /\/courses\/([1-9]\d*)$/.exec(path);
  if (course) return response({ Identifier: control.wrongCourse ? '123' : course[1], Name: 'Synthetic design course', Code: 'SYN101', Path: '/SYNTHETIC_UNRETURNED_PATH_CANARY' }, url);
  if (path.endsWith('/dropbox/folders/')) return response([{ Id: 17, Name: 'Synthetic practice', DueDate: control.due || '2026-10-15T23:59:00-04:00',
    CustomInstructions: { Text: 'SYNTHETIC_SELECTED_D2L_BODY_CANARY: explain your reasoning.', Html: '<p>Never execute this source.</p>' } }], url);
  if (path.endsWith('/news/')) return mode === 'partial' || control.partial ? response('SYNTHETIC_SECRET_DIAGNOSTIC_CANARY', url, 403, 'text/plain')
    : response([{ Id: 18, Title: 'Synthetic office hours', CreatedDate: '2026-10-03T10:00:00Z', Body: { Text: '', Html: '<p>Literal synthetic announcement.</p>' } }], url);
  if (path.endsWith('/content/toc')) return response({ Modules: [{ ModuleId: 19, Title: 'Synthetic lecture module',
    Description: { Text: 'Synthetic module description', Html: '' }, Modules: [], Topics: [{ TopicId: 20, Title: 'Synthetic note',
      Url: '/d2l/le/content/781264/viewContent/20/View', TypeIdentifier: 'File' }] }] }, url);
  return response({}, url, 404);
}
async function receive(value) {
  if (value.method === 'Target.createTarget' && controlPath && JSON.parse(readFileSync(controlPath, 'utf8')).slowStart) return new Promise(() => {});
  if (mode === 'malformed') { writeSync(4, '{broken\0'); return; }
  if (value.method === 'Target.createTarget') {
    if (value.params.url !== 'about:blank') throw new Error('Browser observation must be installed before school navigation');
    return output({ id: value.id, result: { targetId: 'synthetic-target' } });
  }
  if (value.method === 'Target.attachToTarget') return output({ id: value.id, result: { sessionId: 'synthetic-cdp-session' } });
  if (value.sessionId !== sessionId) throw new Error('Unexpected CDP fixture session');
  if (value.method === 'Network.enable' || value.method === 'Page.enable') return output({ id: value.id, result: {} });
  if (value.method === 'Page.navigate') {
    if (value.params.url !== 'https://avenue.mcmaster.ca/login.php') throw new Error('Unexpected school login destination');
    authenticate(); return output({ id: value.id, result: { frameId: 'synthetic-main-frame' } });
  }
  if (value.method !== 'Runtime.evaluate' || value.sessionId !== 'synthetic-cdp-session' || !value.params.awaitPromise || !value.params.returnByValue) throw new Error('Unexpected CDP fixture command');
  const data = await runInNewContext(value.params.expression, { location: { origin: mode === 'signed_out' ? 'https://login.microsoftonline.com' : origin, pathname: '/d2l/home' },
    fetch: fetchSchool, AbortController, Uint8Array, TextDecoder, setTimeout, clearTimeout });
  // Events deliberately precede delivery of the pending evaluation response.
  // This tests in-flight revocation deterministically without pipe timing races.
  if (protectedReads === 1 && mode === 'rotate_token') { expectedBearer = rotatedBearer; tokenRequest({ requestId: 'synthetic-rotated-request' }); }
  if (protectedReads === 1 && mode === 'navigate_after_read') topFrame(origin + '/d2l/home/781264');
  if (protectedReads === 1 && mode === 'logout_after_read') topFrame('https://login.microsoftonline.com/synthetic-signin');
  if (protectedReads === 1 && mode === 'subframe_after_read') event('Page.frameNavigated', { frame: { id: 'synthetic-child-frame', parentId: 'synthetic-main-frame', url: origin + '/d2l/home', loaderId: 'synthetic-child-loader' } });
  if (protectedReads === 1 && mode === 'foreign_navigation_after_read') event('Page.frameNavigated', { frame: { id: 'synthetic-main-frame', url: origin + '/d2l/home', loaderId: 'synthetic-foreign-loader' } }, 'synthetic-foreign-session');
  if (protectedReads === 1 && mode === 'late_old_loader') { const oldLoader = loaderId; topFrame(); tokenRequest({ requestId: 'synthetic-late-old-request', loader: oldLoader }); }
  if (protectedReads === 1 && mode === 'same_token_during_read') tokenRequest({ requestId: 'synthetic-same-token-request' });
  output({ id: value.id, result: { result: { type: 'object', value: data } } });
  if (protectedReads === 1 && mode === 'expired_resurrection') setTimeout(() => tokenRequest({ requestId: 'synthetic-resurrection-request' }), 20);
}
createReadStream(null, { fd: 3 }).on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.includes(0)) { const end = buffer.indexOf(0); const frame = buffer.subarray(0, end); buffer = buffer.subarray(end + 1); void receive(JSON.parse(frame.toString('utf8'))); }
});

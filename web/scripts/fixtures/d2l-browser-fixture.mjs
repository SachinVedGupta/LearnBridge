import { createReadStream, readFileSync, writeSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Invented school data in a separate process. It executes the shipped in-page
// expression with a synthetic fetch boundary, never contacts a real institution.
const mode = process.argv[2] || 'normal', controlPath = process.argv[3]; let buffer = Buffer.alloc(0), identities = 0;
const origin = 'https://avenue.cllmcmaster.ca';
function output(value) { writeSync(4, JSON.stringify(value) + '\0'); }
function response(body, url, status = 200, type = 'application/json') {
  const value = new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': type } });
  Object.defineProperty(value, 'url', { value: url }); return value;
}
async function fetchSchool(url, options) {
  const control = controlPath ? JSON.parse(readFileSync(controlPath, 'utf8')) : {};
  if (options.method !== 'GET' || options.credentials !== 'same-origin' || options.mode !== 'same-origin' || options.redirect !== 'error'
    || options.cache !== 'no-store' || options.headers || options.body || !url.startsWith(origin + '/d2l/api/')) throw new Error('Unexpected synthetic school request');
  if (mode === 'slow' || control.slow) return new Promise(() => {});
  if (mode === 'denied') return response('SYNTHETIC_SECRET_DIAGNOSTIC_CANARY', url, 403, 'text/plain');
  if (mode === 'expired') return response('SYNTHETIC_SECRET_DIAGNOSTIC_CANARY', url, 401, 'text/plain');
  if (mode === 'html') return response('<form>Not signed in</form>', url, 200, 'text/html');
  if (mode === 'redirect') return response({}, 'https://outside.example/d2l/api/versions/');
  if (mode === 'oversized') return response('x'.repeat(256001), url);
  if (mode === 'invalid_json') return response('{broken', url);
  const path = url.slice(origin.length);
  if (control.expired) return response('SYNTHETIC_SECRET_DIAGNOSTIC_CANARY', url, 401, 'text/plain');
  if (control.denied) return response('SYNTHETIC_SECRET_DIAGNOSTIC_CANARY', url, 403, 'text/plain');
  if (path === '/d2l/api/versions/') return response(control.versions || [{ ProductCode: 'lp', LatestVersion: '1.49', SupportedVersions: ['1.43', '1.49'] },
    { ProductCode: 'le', LatestVersion: '1.85', SupportedVersions: ['1.57', '1.85'] }], url);
  if (path.endsWith('/users/whoami')) {
    identities++;
    if (control.slowIdentity) return new Promise(() => {});
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
  if (value.method === 'Target.createTarget') return output({ id: value.id, result: { targetId: 'synthetic-target' } });
  if (value.method === 'Target.attachToTarget') return output({ id: value.id, result: { sessionId: 'synthetic-cdp-session' } });
  if (value.method !== 'Runtime.evaluate' || value.sessionId !== 'synthetic-cdp-session' || !value.params.awaitPromise || !value.params.returnByValue) throw new Error('Unexpected CDP fixture command');
  const data = await runInNewContext(value.params.expression, { location: { origin: mode === 'signed_out' ? 'https://login.microsoftonline.com' : origin, pathname: '/d2l/home' },
    fetch: fetchSchool, AbortController, Uint8Array, TextDecoder, setTimeout, clearTimeout });
  output({ id: value.id, result: { result: { type: 'object', value: data } } });
}
createReadStream(null, { fd: 3 }).on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.includes(0)) { const end = buffer.indexOf(0); const frame = buffer.subarray(0, end); buffer = buffer.subarray(end + 1); void receive(JSON.parse(frame.toString('utf8'))); }
});

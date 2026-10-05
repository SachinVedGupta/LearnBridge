import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { createPublicJobService } from '../apps/local-runtime/src/public-job-service.mjs';
import { profileCandidate, profileHash, reviewProfileFact } from '../apps/local-runtime/src/profile.mjs';
import { createApplicationBrowser, checkedApplicationUrl, applicationBrowserHash, APPLICATION_BROWSER_BINARY } from '../apps/local-runtime/src/application-browser.mjs';
import { createApplicationBrowserService } from '../apps/local-runtime/src/application-browser-service.mjs';
import { handleApplicationBrowserRoute } from '../apps/local-runtime/src/application-browser-routes.mjs';
import { createHostTurns } from '../apps/local-runtime/src/host-turns.mjs';
import { createTaskSessionService } from '../apps/local-runtime/src/task-session-service.mjs';

const officialUrl = 'https://job-boards.greenhouse.io/fixture/jobs/123', selection = { provider: 'greenhouse', board_slug: 'fixture', job_id: '123' };
function rawSnapshot() { return { url: officialUrl, title: 'Fixture employer form', forms: [{ id: 'form-0', method: 'post', action_origin: 'https://job-boards.greenhouse.io' }], fields: [
  { id: 'field-0', form_id: 'form-0', type: 'text', name: 'name', label: 'Full name', required: true, disabled: false, readonly: false, eligible: true, value: '', maxlength: 500 },
  { id: 'field-1', form_id: 'form-0', type: 'email', name: 'email', label: 'Email', required: true, disabled: false, readonly: false, eligible: true, value: '', maxlength: 500 },
  { id: 'field-2', form_id: 'form-0', type: 'file', name: 'resume', label: 'Resume', required: true, disabled: false, readonly: false, eligible: false, value: '', maxlength: null },
  { id: 'field-3', form_id: 'form-0', type: 'text', name: 'work_authorization', label: 'Work authorization', required: true, disabled: false, readonly: false, eligible: false, value: '', maxlength: null },
  { id: 'field-4', form_id: 'form-0', type: 'submit', name: 'submit', label: 'Submit application', required: false, disabled: false, readonly: false, eligible: false, value: '', maxlength: null },
], iframe_count: 0, coverage: 'visible_top_level_controls_only' }; }
const observed = raw => ({ ...structuredClone(raw), fingerprint: applicationBrowserHash(raw), network_frozen: false, proof: 'fixture' });
function browserFixture(extra = {}) { const calls = []; let raw = rawSnapshot(), opened = false, frozen = false; return { calls, proof: 'fixture', capability: () => ({ state: 'available', automated_submission: false }), status: () => ({ opened }), start: async ({ url }) => { calls.push({ action: 'start', url }); opened = true; return { state: 'opened', proof: 'fixture' }; }, snapshot: async () => { calls.push({ action: 'snapshot' }); return observed(raw); }, fill: async input => { calls.push({ action: 'fill', input }); if (extra.fill) return extra.fill(input); assert.equal(input.expected_fingerprint, applicationBrowserHash(raw)); frozen = true; for (const item of input.mappings) raw.fields.find(field => field.id === item.field_id).value = item.value; return { snapshot: { ...observed(raw), network_frozen: true }, writes: input.mappings.map(row => ({ field_id: row.field_id, value: row.value })), effects: { field_writes: input.mappings.length, navigation: 0, clicks: 0, uploads: 0, submissions: 0 }, network_frozen: true, proof: 'fixture' }; }, close: async () => { calls.push({ action: 'close' }); opened = false; }, mutate: operation => operation(raw), get frozen() { return frozen; } }; }
async function fixture(t, extra = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-application-')), root = join(parent, 'private'); let store = LocalStore.open({ root }), jobs; const browser = extra.browser || browserFixture(extra), post = { id: 123, title: 'Synthetic Internship', location: { name: 'Toronto' }, content: '<p>Build useful student tools.</p>' }, fetchImpl = async url => new Response(JSON.stringify(url.endsWith('/jobs') ? { jobs: [post] } : post), { headers: { 'Content-Type': 'application/json' } });
  jobs = createPublicJobService({ store, fetchImpl }); await jobs.search({ provider: 'greenhouse', board_slug: 'fixture' }); const role = (await jobs.read(selection)).role;
  function fact(field, value, other = {}) { let data = profileCandidate({ field, value, ...other }); data = reviewProfileFact(data, { decision: 'confirm', fingerprint: profileHash(data) }, { reviewer: store.identity.student_id }); return store.createWorkspaceRecord({ kind: 'profile_fact', title: field, data }); }
  const name = fact('name', 'Fixture Student'), email = fact('email', 'fixture@example.test'), privateNote = store.createDocument({ title: 'Private unrelated note', text: 'UNSELECTED_APPLICATION_SECRET_CANARY' });
  let service = createApplicationBrowserService({ store, publicJobService: jobs, browserFactory: () => browser, ...(extra.service || {}) }), allowed = true;
  t.after(async () => { await service.drain(); jobs.close(); store.close(); rmSync(parent, { recursive: true, force: true }); });
  const options = () => ({ authorize: () => allowed, idempotencyKey: randomUUID() });
  const body = () => ({ role_ref: { id: role.id, revision: role.revision, source_sha256: role.data.snapshot.source_sha256 }, task_session_id: null, confirmed: true });
  async function open() { return service.open(body(), options()); }
  async function inspect(record) { return service.inspect(record.id, { expected_revision: record.revision, confirmed: true }, options()); }
  async function preview(record, mappings = [{ field_id: 'field-0', value: name.data.value, profile_ref: { id: name.id, revision: name.revision, fingerprint: profileHash(name.data) } }]) { return service.previewFill(record.id, { expected_revision: record.revision, form_fingerprint: record.data.snapshot.fingerprint, mappings }, options()); }
  async function fill(record, inputKey = randomUUID()) { return service.fill(record.id, { expected_revision: record.revision, payload_hash: record.data.pending.payload_hash, confirmed: true }, { ...options(), idempotencyKey: inputKey }); }
  return { browser, role, name, email, privateNote, fact, options, body, open, inspect, preview, fill, setAllowed: value => { allowed = value; }, get store() { return store; }, get jobs() { return jobs; }, get service() { return service; },
    async restart() { await service.drain(); jobs.close(); store.close(); store = LocalStore.open({ root }); jobs = createPublicJobService({ store, fetchImpl }); service = createApplicationBrowserService({ store, publicJobService: jobs, browserFactory: () => browser }); },
  };
}

test('AB01 official application URL allowlist rejects arbitrary URLs, credentials, queries, lookalikes and indirect origins', () => {
  assert.equal(checkedApplicationUrl(officialUrl), officialUrl); const lever = 'https://jobs.lever.co/fixture/12345678-1234-1234-1234-123456789abc/apply'; assert.equal(checkedApplicationUrl(lever), lever);
  for (const raw of ['http://job-boards.greenhouse.io/fixture/jobs/123', 'https://job-boards.greenhouse.io.evil.test/fixture/jobs/123', 'https://student:password@job-boards.greenhouse.io/fixture/jobs/123', `${officialUrl}?secret=123`, `${officialUrl}#application`, 'http://127.0.0.1:1234/fixture/application', 'file:///tmp/private', 'https://jobs.lever.co/fixture/123/apply', 'https://boards.greenhouse.io/fixture/jobs/123']) assert.throws(() => checkedApplicationUrl(raw), error => ['SCOPE_DENIED', 'INVALID_INPUT'].includes(error.code));
  assert.throws(() => createApplicationBrowser({ testPageUrl: 'https://outside.example/fixture/application' }), { code: 'SCOPE_DENIED' });
});

test('AB02 selected current official source opens only derived owned browser URL, no profile reads or model sharing', async t => {
  const f = await fixture(t), before = { tasks: f.store.listTasks(), grants: f.store.listAgentGrants(), documents: f.store.listDocuments() }, record = await f.open(); assert.equal(record.data.state, 'opened'); assert.equal(record.data.selected_url, officialUrl); assert.equal(record.data.proof, 'fixture'); assert.equal(record.external_application_completed, false); assert.equal(record.automatic_submission, false);
  assert.deepEqual(f.browser.calls, [{ action: 'start', url: officialUrl }]); assert.equal(JSON.stringify(record).includes('UNSELECTED_APPLICATION_SECRET_CANARY'), false); assert.deepEqual({ tasks: f.store.listTasks(), grants: f.store.listAgentGrants(), documents: f.store.listDocuments() }, before);
  await assert.rejects(f.service.open({ ...f.body(), url: 'https://outside.example' }, f.options()), { code: 'INVALID_INPUT' });
});

test('AB03 exact visible form → checked mapping preview → reviewed fill/readback receipt has zero clicks/uploads/submissions/task changes', async t => {
  const f = await fixture(t); let record = await f.inspect(await f.open()); assert.equal(record.data.state, 'inspected'); assert.equal(record.data.snapshot.fields[2].eligible, false);
  record = await f.preview(record); assert.equal(record.data.state, 'awaiting_review'); assert.equal(record.data.pending.payload.mappings[0].evidence, 'selected_current_confirmed_profile_fact'); assert.equal(f.browser.calls.some(row => row.action === 'fill'), false);
  const final = await f.fill(record); assert.equal(final.data.state, 'filled_local_draft'); assert.deepEqual(final.data.receipt.effects, { field_writes: 1, navigation: 0, clicks: 0, uploads: 0, submissions: 0 }); assert.equal(final.data.receipt.network_frozen, true); assert.equal(final.data.receipt.application_submitted, false); assert.equal(f.browser.frozen, true); assert.equal(f.store.listTasks().length, 0);
});

test('AB04 unsupported uploads, protected disclosure and submit controls are never approved or filled', async t => {
  const f = await fixture(t), record = await f.inspect(await f.open());
  for (const field_id of ['field-2', 'field-3', 'field-4']) await assert.rejects(f.preview(record, [{ field_id, value: 'Unwanted value', profile_ref: null }]), { code: 'SCOPE_DENIED' }); assert.equal(f.browser.calls.some(row => row.action === 'fill'), false);
});

test('AB05 explicit student literal values stay labeled; typed fact mapping must exactly match current confirmed source', async t => {
  const f = await fixture(t), record = await f.inspect(await f.open()), ref = { id: f.name.id, revision: f.name.revision, fingerprint: profileHash(f.name.data) };
  await assert.rejects(f.preview(record, [{ field_id: 'field-0', value: 'Fabricated Student', profile_ref: ref }]), { code: 'REVISION_CONFLICT' }); const literal = await f.preview(record, [{ field_id: 'field-1', value: 'exact-student-input@example.test', profile_ref: null }]); assert.equal(literal.data.pending.payload.mappings[0].evidence, 'student_entered_literal_value');
});

test('AB06 form changes between inspect/preview/fill reject old review with zero writes and no automatic refresh', async t => {
  for (const stage of ['preview', 'fill']) {
    const f = await fixture(t); let record = await f.inspect(await f.open()); if (stage === 'fill') record = await f.preview(record); f.browser.mutate(raw => { raw.fields[0].label = 'Changed meaning'; }); await assert.rejects(stage === 'preview' ? f.preview(record) : f.fill(record), { code: 'REVISION_CONFLICT' }); assert.equal(f.browser.calls.some(row => row.action === 'fill'), false);
  }
});

test('AB07 source posting/profile conflicts or edits cannot reuse a pending reviewed mapping', async t => {
  for (const mutation of ['posting', 'profile', 'conflict']) {
    const f = await fixture(t), record = await f.preview(await f.inspect(await f.open()));
    if (mutation === 'posting') f.store.updateWorkspaceRecord(f.role.id, { expected_revision: f.role.revision, data: { ...f.role.data, snapshot: { ...f.role.data.snapshot, source_sha256: '0'.repeat(64) } } });
    else if (mutation === 'profile') f.store.updateWorkspaceRecord(f.name.id, { expected_revision: f.name.revision, data: { ...f.name.data, value: 'Changed Name' } }); else f.fact('name', 'Conflicting Name');
    await assert.rejects(f.fill(record), error => ['REVISION_CONFLICT', 'CONSENT_REQUIRED'].includes(error.code)); assert.equal(f.browser.calls.some(row => row.action === 'fill'), false);
  }
});

test('AB08 exact confirmed payload/revision/retry are required, and replay never repeats browser writes', async t => {
  const f = await fixture(t), record = await f.preview(await f.inspect(await f.open())), inputKey = 'fixture-fill-one-time';
  await assert.rejects(f.service.fill(record.id, { expected_revision: record.revision, payload_hash: record.data.pending.payload_hash, confirmed: false }, f.options()), { code: 'CONSENT_REQUIRED' });
  await assert.rejects(f.service.fill(record.id, { expected_revision: record.revision, payload_hash: '0'.repeat(64), confirmed: true }, f.options()), { code: 'REVISION_CONFLICT' });
  const final = await f.fill(record, inputKey); assert.equal((await f.fill(record, inputKey)).id, final.id); assert.equal(f.browser.calls.filter(row => row.action === 'fill').length, 1);
  await assert.rejects(f.fill(record, 'fixture-fill-different'), { code: 'REVISION_CONFLICT' });
});

test('AB09 unknown/partially observed fill cannot become verified completion or be automatically replayed', async t => {
  const f = await fixture(t, { fill: async () => { const error = new Error('Unknown browser condition'); error.code = 'UNKNOWN_OUTCOME'; throw error; } }), record = await f.preview(await f.inspect(await f.open())); await assert.rejects(f.fill(record), { code: 'UNKNOWN_OUTCOME' }); const saved = f.service.get(record.id); assert.equal(saved.data.state, 'unknown_outcome'); assert.equal(saved.data.receipt.observed_writes, 'not_established'); assert.equal(saved.external_application_completed, false); await assert.rejects(f.fill(saved), { code: 'REVISION_CONFLICT' }); assert.equal(f.browser.calls.filter(row => row.action === 'fill').length, 1);
});

test('AB10 revoked paired authorization never reads or fills; close cleans only owned browser and persists receipt', async t => {
  const f = await fixture(t); let record = await f.open(); f.setAllowed(false); await assert.rejects(f.inspect(record), { code: 'CONSENT_REQUIRED' }); assert.equal(f.browser.calls.length, 1); f.setAllowed(true); record = await f.fill(await f.preview(await f.inspect(record))); const closed = await f.service.close(record.id, { expected_revision: record.revision }, f.options()); assert.equal(closed.browser_open, false); assert.equal(closed.browser_connection_active, false); assert.deepEqual(closed.data.receipt, record.data.receipt); assert.equal(f.browser.calls.filter(row => row.action === 'close').length, 1);
});

test('AB11 restart preserves preparation receipt and never opens another browser or repeats fill', async t => {
  const f = await fixture(t), record = await f.fill(await f.preview(await f.inspect(await f.open()))), receipt = structuredClone(record.data.receipt); await f.restart(); const saved = f.service.get(record.id); assert.equal(saved.browser_open, false); assert.deepEqual(saved.data.receipt, receipt); assert.equal(f.browser.calls.filter(row => row.action === 'start').length, 1); assert.equal(f.browser.calls.filter(row => row.action === 'fill').length, 1); assert.equal(f.store.integrity().integrity, 'ok');
});

test('AB12 task session link must be exact/current; unrelated artifacts or task changes cannot authorize preparations', async t => {
  const taskId = randomUUID(); let current = true; const taskSessions = { getCurrentPin: session_id => ({ id: session_id, kind: 'artifact', data: { format: 'learnbridge_task_session_v1', source_current: current, task_pin: { id: taskId, title: 'Apply to fixture role', revision: 1, hash: '1'.repeat(64) } } }) }, f = await fixture(t, { service: { taskSessions } });
  const body = { ...f.body(), task_session_id: randomUUID() }, record = await f.service.open(body, f.options()); assert.equal(record.data.task_link.task_pin.id, taskId); current = false; await assert.rejects(f.inspect(record), { code: 'REVISION_CONFLICT' }); assert.equal(f.service.get(record.id).source_current, false);
});

test('AB15 actual task-session/application progress uses raw validated pin without recursive view and preserves reviewed field count', async t => {
  const f = await fixture(t), task = f.store.createTask({ title: 'Prepare fixture application' }); let application, progressCalls = 0;
  const output = 'Synthetic application preparation plan', host = createHostTurns({ store: f.store, enabled: true, execute: async () => ({ state: 'completed', complete: true, text: output, output_sha256: applicationBrowserHash(output), tool_receipts: [{ tool: 'learnbridge_context', status: 'completed', failed: false, result_hash: applicationBrowserHash('fixture') }], host_version: '0.154.0' }) });
  t.after(() => host.drain());
  const taskSessions = createTaskSessionService({ store: f.store, hostTurns: host, applicationProgress: sessionId => { progressCalls++; assert(progressCalls < 20, 'Progress resolver recursed through task session view'); return application?.progressForTaskSession(sessionId) ?? []; } });
  application = createApplicationBrowserService({ store: f.store, publicJobService: f.jobs, browserFactory: () => f.browser, taskSessions });t.after(() => application.drain());
  const session = await taskSessions.start({ task_id: task.id, expected_revision: task.revision, documents: [], instructions: 'Prepare a synthetic factual application draft for my review.', confirmed: true }, { authorize: () => true, idempotencyKey: 'application-task-integration' });
  const options = f.options(), opened = await application.open({ ...f.body(), task_session_id: session.id }, options), inspected = await application.inspect(opened.id, { expected_revision: opened.revision, confirmed: true }, options), reviewed = await application.previewFill(inspected.id, { expected_revision: inspected.revision, form_fingerprint: inspected.data.snapshot.fingerprint, mappings: [{ field_id: 'field-0', value: 'Fixture Student', profile_ref: null }, { field_id: 'field-1', value: 'fixture@example.test', profile_ref: null }] }, options);
  const filled = await application.fill(reviewed.id, { expected_revision: reviewed.revision, payload_hash: reviewed.data.pending.payload_hash, confirmed: true }, options);assert.equal(filled.data.receipt.effects.field_writes, 2);
  const before = progressCalls, saved = taskSessions.get(session.id);assert.equal(progressCalls, before + 1);assert.equal(saved.data.application_preparation.length, 1);assert.equal(saved.data.application_preparation[0].field_writes, 2);assert.equal(saved.data.application_preparation[0].source_current, true);assert.equal(saved.data.application_preparation[0].application_submitted, false);assert.equal(saved.data.application_preparation[0].task_completion_established, false);assert.equal(f.store.getTask(task.id).status, 'pending');
  f.store.updateTask(task.id, { title: 'Changed task after review' }, task.revision);const stale = application.get(filled.id);assert.equal(stale.source_current, false);assert.equal(taskSessions.get(session.id).data.application_preparation[0].source_current, false);
  await host.drain();await application.drain();
});

test('AB13 paired route contract rejects unpaired requests, method abuse and unbounded configuration surfaces', async t => {
  const f = await fixture(t), session = { nonce: 'fixture-session' }, route = '/application-browser/state'; assert.equal(await handleApplicationBrowserRoute({ route: '/unrelated', method: 'GET' }), null); await assert.rejects(handleApplicationBrowserRoute({ route, method: 'GET', applicationBrowserService: f.service }), { code: 'AUTH_REQUIRED' });
  assert.equal((await handleApplicationBrowserRoute({ route, method: 'GET', session, applicationBrowserService: f.service })).status, 200); await assert.rejects(handleApplicationBrowserRoute({ route, method: 'POST', session, applicationBrowserService: f.service }), { code: 'INVALID_INPUT' }); let fields;
  const opened = await handleApplicationBrowserRoute({ route: '/application-browser/open', method: 'POST', session, applicationBrowserService: f.service, privateBody: async allowed => { fields = allowed; return f.body(); }, stillAuthorized: () => true, idempotencyKey: 'fixture-route-browser' }); assert.equal(opened.status, 201); assert.deepEqual(fields, ['role_ref', 'task_session_id', 'confirmed']);
});

test('AB14 actual owned Chrome executes fixed isolated-world inspection/fill on a local fixture and prevents all attempted outgoing writes/submission requests', { timeout: 30000 }, async t => {
  if (process.platform !== 'darwin' || !existsSync(APPLICATION_BROWSER_BINARY)) { t.skip('Actual macOS Chrome fixture gate unavailable; no live browser claim'); return; }
  const hits = [], page = '<!doctype html><title>LearnBridge synthetic application</title><form action="/submit" method="post"><label>Name<input name="name" maxlength="500"></label><label>Email<input name="email" type="email"></label><label>Experience<textarea name="experience"></textarea></label><label>Resume<input name="resume" type="file"></label><label>Password<input name="password" type="password" value="PRIVATE_BROWSER_PASSWORD_CANARY"></label><label>Gender<input name="gender"></label><button type="submit">Submit application</button></form><script>document.querySelector("input[name=name]").addEventListener("input",()=>{fetch("/attempted-autosave",{method:"POST",body:"PRIVATE_FILL_CANARY"}).catch(()=>{});fetch("/submit").catch(()=>{});});</script>';
  const server = createServer((req, res) => { hits.push({ method: req.method, url: req.url }); if (req.url === '/fixture/application') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(page); } else { res.writeHead(204); res.end(); } }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/fixture/application`, launches = [], commands = []; let profile;
  const browser = createApplicationBrowser({ testPageUrl: url, factory(binary, args, options) { profile = args.find(value => value.startsWith('--user-data-dir=')).slice('--user-data-dir='.length); launches.push({ binary, args, options }); const child = spawn(binary, args, options), write = child.stdio[3].write.bind(child.stdio[3]); child.stdio[3].write = raw => { const command = JSON.parse(raw.slice(0, -1)); commands.push(command.method); return write(raw); }; return child; } }); t.after(() => browser.close());
  const opened = await browser.start({ url: officialUrl }); assert.equal(opened.proof, 'fixture'); let snapshot; for (let n = 0; n < 40; n++) { try { snapshot = await browser.snapshot(); if (snapshot.fields.length >= 7) break; } catch (error) { if (!['SCOPE_DENIED', 'PROVIDER_FAILURE'].includes(error.code)) throw error; } await delay(100); } assert.ok(snapshot?.fields.length >= 7, 'Actual Chrome did not render fixture controls');
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE_BROWSER_PASSWORD_CANARY'), false); assert.equal(snapshot.fields.find(row => row.name === 'resume').eligible, false); assert.equal(snapshot.fields.find(row => row.name === 'gender').eligible, false); const name = snapshot.fields.find(row => row.name === 'name'), email = snapshot.fields.find(row => row.name === 'email');
  const filled = await browser.fill({ expected_fingerprint: snapshot.fingerprint, mappings: [{ field_id: name.id, value: 'Fixture Student' }, { field_id: email.id, value: 'fixture@example.test' }] }); assert.equal(filled.network_frozen, true); assert.equal(filled.snapshot.fields.find(row => row.id === name.id).value, 'Fixture Student'); assert.deepEqual(filled.effects, { field_writes: 2, navigation: 0, clicks: 0, uploads: 0, submissions: 0 }); await delay(100); assert.equal(hits.some(row => row.url === '/submit' || row.url === '/attempted-autosave' || row.method !== 'GET'), false);
  assert.equal(commands.some(command => /Input\.|DOM.setFileInputFiles|setCookie|getAllCookies|executeScript|click/.test(command)), false); assert.ok(commands.includes('Page.createIsolatedWorld')); assert.ok(commands.includes('Network.setBlockedURLs')); assert.ok(launches[0].args.includes('--remote-debugging-pipe')); assert.equal(launches[0].args.some(value => /remote-debugging-port|no-sandbox|disable-web-security|load-extension/.test(value)), false); assert.equal(launches[0].options.env.OPENAI_API_KEY, undefined);
  await browser.close(); assert.equal(existsSync(profile), false); assert.equal(browser.status().opened, false);
});

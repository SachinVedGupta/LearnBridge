import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { ADOPTION_CONSENT_VERSION, ADOPTION_PROMPT_VERSION, ADOPTION_FIELDS, parseAdoptionEvent, parseEnrollment, parseReportRange, createPublicAdoptionCollector, createPublicAdoptionLimiter, boundedAdoptionBody } from '../apps/web/src/lib/adoption/policy.mjs';
import * as policy from '../apps/web/src/lib/adoption/policy.mjs';
import { createSetupAdoptionClient } from '../apps/web/src/lib/adoption/client.mjs';

const envelope = (name = 'setup_prompt_copy_succeeded', eventId = randomUUID()) => ({ consent: { state: 'opted_in', version: ADOPTION_CONSENT_VERSION }, event: { schema_version: 1, event_id: eventId, event_name: name, route: '/setup', prompt_version: ADOPTION_PROMPT_VERSION } });
const request = (body, extra = {}) => ({ origin: 'https://learnbridge.fixture', path: '/api/adoption/events', contentType: 'application/json', body: JSON.stringify(body), ...extra });
const consent = { consent_version: ADOPTION_CONSENT_VERSION, reviewed_fields: [...ADOPTION_FIELDS] };
function eventRepository() {
  const events = new Map(); let mode = 'ok';
  return { events, setMode(value) { mode = value; }, async insertPublicEvent(input) {
    if (mode === 'offline') throw new Error('PRIVATE_DATABASE_ERROR_CANARY'); if (mode !== 'ok') return { status: mode };
    const old = events.get(input.event.event_id); if (old) return { status: JSON.stringify(old) === JSON.stringify(input) ? 'duplicate' : 'conflict' }; events.set(input.event.event_id, structuredClone(input)); return { status: 'accepted' };
  } };
}

test('AM01 off-by-default observer and collector create no IDs, queue, network or database operations', async () => {
  let ids = 0, sends = 0, writes = 0; const client = createSetupAdoptionClient({ createId: () => { ids++; return randomUUID(); }, send: async () => { sends++; return { status: 202 }; } }); assert.equal(client.optIn(consent), false); assert.equal(client.observeCopySucceeded(), false); await client.flush(); assert.equal(ids + sends, 0); assert.equal(client.status().queued, 0); assert.equal(client.status().local_reporting, 'off');
  const collector = createPublicAdoptionCollector({ origin: 'https://learnbridge.fixture', repository: { insertPublicEvent: async () => { writes++; } } }); assert.equal((await collector.collect(request(envelope()))).status, 503); assert.equal(writes, 0);
});

test('AM02 explicit reviewed fields and successful clipboard promises gate distinct observations', async () => {
  const require = createRequire(import.meta.url), source = readFileSync(new URL('../apps/web/src/app/setup/copy-prompt.ts', import.meta.url), 'utf8'), code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, module = { exports: {} }; new Function('require', 'module', 'exports', code)(require, module, module.exports); const { copyPrompt } = module.exports;
  const ledger = [], client = createSetupAdoptionClient({ enabled: true, send: async (path, options) => { ledger.push({ path, options, body: JSON.parse(options.body) }); return { status: 202 }; } }); assert.equal(client.optIn({ ...consent, reviewed_fields: ['email'] }), false); assert.equal(client.observeCopySucceeded(), false); assert.equal(client.optIn(consent), true);
  let resolve; const copy = copyPrompt('PRIVATE_PROMPT_CANARY', { writeText: () => new Promise(done => { resolve = done; }) }, client.observeCopySucceeded); await Promise.resolve(); assert.equal(ledger.length, 0); resolve(); assert.equal(await copy, 'copied'); await client.flush(); assert.equal(ledger.length, 1);
  assert.equal(await copyPrompt('PRIVATE_PROMPT_CANARY', { writeText: async () => { throw new Error('clipboard denied'); } }, client.observeCopySucceeded), 'failed'); assert.equal(await copyPrompt('PRIVATE_PROMPT_CANARY', undefined, client.observeCopySucceeded), 'failed'); assert.equal(ledger.length, 1);
  await copyPrompt('PRIVATE_PROMPT_CANARY', { writeText: async () => {} }, client.observeCopySucceeded); await client.flush(); assert.equal(ledger.length, 2); assert.notEqual(ledger[0].body.event.event_id, ledger[1].body.event.event_id); assert.equal(JSON.stringify(ledger).includes('PRIVATE_PROMPT_CANARY'), false);
  assert.equal(ledger[0].options.credentials, 'omit'); assert.equal(ledger[0].options.referrerPolicy, 'no-referrer'); assert.equal(ledger[0].path, '/api/adoption/events'); assert.deepEqual(Object.keys(ledger[0].body.event).sort(), [...ADOPTION_FIELDS].sort());
});

test('AM03 strict one-event payload rejects URL, identity, content, token and source canaries with redacted codes', async () => {
  const repo = eventRepository(), collector = createPublicAdoptionCollector({ enabled: true, origin: 'https://learnbridge.fixture', repository: repo });
  for (const property of ['email', 'account_id', 'url', 'referrer', 'prompt', 'file_path', 'token', 'source_id', 'visitor_id']) { const result = await collector.collect(request({ ...envelope(), [property]: 'PRIVATE_FORBIDDEN_CANARY' })); assert.equal(result.status, 400); assert.equal(JSON.stringify(result).includes('PRIVATE_FORBIDDEN'), false); }
  for (const event of [{ ...envelope().event, route: '/private?token=canary' }, { ...envelope().event, prompt_version: 'unreviewed' }, { ...envelope().event, event_id: 'student@example.invalid' }, { ...envelope().event, event_name: 'installation_complete' }]) assert.throws(() => parseAdoptionEvent(JSON.stringify({ consent: envelope().consent, event })));
  assert.equal((await collector.collect(request(envelope(), { origin: 'https://hostile.invalid' }))).status, 403); assert.equal((await collector.collect(request(envelope(), { path: '/api/adoption/events?token=canary' }))).status, 403); assert.equal((await collector.collect(request(envelope(), { contentType: 'text/plain' }))).status, 415); assert.equal(repo.events.size, 0);
});

test('AM04 immutable event-ID retry deduplicates while changed payload, quotas and outage never fabricate success', async () => {
  const repo = eventRepository(), collector = createPublicAdoptionCollector({ enabled: true, origin: 'https://learnbridge.fixture', repository: repo }), event = envelope(); assert.equal((await collector.collect(request(event))).data.status, 'accepted'); assert.equal((await collector.collect(request(event))).data.status, 'duplicate'); assert.equal(repo.events.size, 1);
  assert.equal((await collector.collect(request({ ...event, event: { ...event.event, event_name: 'setup_page_view' } }))).status, 409); assert.equal(repo.events.size, 1);
  for (const mode of ['quota_paused', 'rate_limited', 'offline']) { repo.setMode(mode); const result = await collector.collect(request(envelope())); assert.equal(result.status, mode === 'offline' ? 503 : 429); assert.equal(JSON.stringify(result).includes('PRIVATE_DATABASE_ERROR_CANARY'), false); } assert.equal(repo.events.size, 1);
});

test('AM05 bounded coarse abuse bucket resets by minute without any visitor identity', async () => {
  let clock = Date.UTC(2026, 9, 5); const repo = eventRepository(), limiter = createPublicAdoptionLimiter({ clock: () => clock }), collector = createPublicAdoptionCollector({ enabled: true, origin: 'https://learnbridge.fixture', repository: repo, limiter });
  for (let i = 0; i < 10; i++) assert.equal((await collector.collect(request(envelope('setup_page_view')))).status, 202); assert.equal((await collector.collect(request(envelope()))).status, 429); assert.equal(repo.events.size, 10); clock += 60000; assert.equal((await collector.collect(request(envelope()))).status, 202);
});

test('AM06 streamed UTF-8 body is bounded before parsing/persistence', async () => {
  assert.throws(() => parseAdoptionEvent(JSON.stringify({ ...envelope(), content: '🔒'.repeat(1024) })), error => error.code === 'EVENT_TOO_LARGE');
  const req = new Request('https://learnbridge.fixture/api/adoption/events', { method: 'POST', body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('🔒'.repeat(1024))); controller.close(); } }), duplex: 'half' }); await assert.rejects(boundedAdoptionBody(req), error => error.code === 'EVENT_TOO_LARGE');
  assert.throws(() => parseEnrollment(JSON.stringify({ expected_revision: 0, enabled: true, directory_enabled: false, consent_version: ADOPTION_CONSENT_VERSION, user_id: 'forged' }))); assert.throws(() => parseReportRange('2026-02-31', '2026-03-02')); assert.throws(() => parseReportRange('2025-01-01', '2026-10-01'));
});

test('AM07 opt-out purges unsent observations, aborts in-flight sends and prevents further retries', async () => {
  let sends = 0, resolve; const client = createSetupAdoptionClient({ enabled: true, send: async (_path, options) => { sends++; return new Promise(done => { resolve = done; options.signal.addEventListener('abort', () => done({ status: 503 }), { once: true }); }); } }); client.optIn(consent); client.observeCopySucceeded(); await Promise.resolve(); client.observePageView(); assert.equal(client.status().queued, 2); const off = client.optOut(); assert.equal(off.queued, 0); assert.match(off.retention, /30 days/); resolve?.({ status: 202 }); await client.flush(); assert.equal(client.observeCopySucceeded(), false); assert.equal(client.status().queued, 0); assert.equal(sends, 1); assert.equal(client.status().accepted_observations, 0);
});

test('AM08 transient outage keeps only a bounded session queue and never breaks clipboard setup', async () => {
  let sends = 0; const client = createSetupAdoptionClient({ enabled: true, send: async () => { sends++; return { status: 503 }; } }); client.optIn(consent); for (let i = 0; i < 30; i++) client.observeCopySucceeded(); await client.flush(); assert.equal(client.status().queued, 20); assert.equal(client.status().dropped_observations, 10); assert.equal(sends, 1); assert.equal(client.status().accepted_observations, 0); client.optOut(); assert.equal(client.status().queued, 0);
});

test('AM09 prompt/schema pins match current public setup and SQL privacy guard is present (not a DB execution proof)', () => {
  const setup = readFileSync(new URL('../apps/web/src/app/setup/setup-content.ts', import.meta.url), 'utf8'), sql = readFileSync(new URL('../../supabase/migrations/202610030002_adoption_metrics.sql', import.meta.url), 'utf8'); assert(setup.includes(ADOPTION_PROMPT_VERSION)); assert(sql.includes(ADOPTION_PROMPT_VERSION));
  for (const table of ['adoption_public_events', 'adoption_daily_counts', 'adoption_enrollments', 'adoption_account_activity', 'adoption_admins']) assert(sql.includes(`alter table public.${table} enable row level security;`)); assert.match(sql, /revoke all on public\.adoption_public_events/); assert.doesNotMatch(sql, /grant select.*to (anon|authenticated)/);
  assert.match(sql, /pg_advisory_xact_lock/); assert.match(sql, /interval '30 days'/); assert.match(sql, /interval '12 months'/); assert.match(sql, /auth\.uid\(\)/); assert.match(sql, /ADMIN_REQUIRED/); assert.match(sql, /state_revision/); assert.match(sql, /local_activation_enrollments',null/);
});

// Real Next route handlers and their actual auth helper, with synthetic SDK
// transport responses. This proves boundary behavior; SQL/RLS needs its SQL fixture.
const require = createRequire(import.meta.url), modules = new Map(); let authState;
function resetAuthState() { authState = { user: null, admin: false, calls: [], after: [], tableCalls: [], stateRows: new Map(), failActivity: false, enrollment: { revision: 0, enabled: false, directory_enabled: false, consent_version: ADOPTION_CONSENT_VERSION } }; }
resetAuthState();
function fakeDb(anonymous = false) { return { auth: { getUser: async () => ({ data: { user: anonymous ? null : authState.user }, error: null }) }, from(table) {
  assert.equal(table, 'student_state'); const operation = { table, mode: 'read', row: null, filters: [] }; authState.tableCalls.push(operation);
  const query = { insert(row) { operation.mode = 'insert'; operation.row = row; return query; }, update(row) { operation.mode = 'update'; operation.row = row; return query; }, select(columns) { operation.columns = columns; return query; }, eq(key, value) { operation.filters.push([key, value]); return query; }, async maybeSingle() {
    if (operation.mode === 'read') { const fields = Object.fromEntries(operation.filters), row = authState.stateRows.get(`${fields.user_id}:${fields.kind}`); return { data: row ? { value: row.value, revision: row.revision } : null, error: null }; }
    const row = operation.row, key = `${row.user_id}:${row.kind}`, current = authState.stateRows.get(key), fields = Object.fromEntries(operation.filters);
    if ((operation.mode === 'insert' && current) || (operation.mode === 'update' && (!current || fields.user_id !== row.user_id || fields.kind !== row.kind || fields.revision !== current.revision))) return { data: null, error: { message: 'SYNTHETIC_STALE_STATE' } };
    authState.stateRows.set(key, structuredClone(row)); return { data: { revision: row.revision }, error: null };
  } }; return query;
}, async rpc(name, args = {}) { authState.calls.push({ name, args, anonymous });
  if (name === 'adoption_is_admin') return { data: authState.admin, error: null };
  if (name === 'adoption_collect_public') return { data: { status: 'accepted', PRIVATE_CANARY: 'not emitted' }, error: null };
  if (name === 'adoption_get_enrollment') return { data: authState.enrollment, error: null };
  if (name === 'adoption_set_enrollment') { if (args.p_revision !== authState.enrollment.revision) return { data: null, error: { message: 'REVISION_CONFLICT' } }; authState.enrollment = { revision: args.p_revision + 1, enabled: args.p_enabled, directory_enabled: args.p_directory_enabled, consent_version: ADOPTION_CONSENT_VERSION }; return { data: authState.enrollment, error: null }; }
  if (name === 'adoption_admin_report') return { data: { observed_page_views: 10, successful_prompt_copies: 4, opted_in_setup_account_enrollments: 2, visitor_estimate: null, local_activation_enrollments: null, opt_in_weekly_active_installations: null }, error: null };
  if (name === 'adoption_admin_directory') return { data: [], error: null };
  if (name === 'adoption_admin_purge') return { data: { events_removed: 1 }, error: null };
  if (name === 'adoption_record_state_activity') { if (authState.failActivity) throw new Error('PRIVATE_ACTIVITY_OUTAGE_CANARY'); return { data: true, error: null }; } return { data: null, error: { message: 'PRIVATE_SQL_ERROR_CANARY' } };
} }; }
function load(file) {
  if (modules.has(file)) return modules.get(file); const source = readFileSync(new URL(`../apps/web/src/${file}`, import.meta.url), 'utf8'), code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, module = { exports: {} };
  new Function('require', 'module', 'exports', code)(id => {
    if (id.endsWith('policy.mjs')) return policy;
    if (id === '@/lib/server/auth' || id === './auth') return load('lib/server/auth.ts');
    if (id === '@/lib/server/access') return load('lib/server/access.ts');
    if (id === '@/lib/adoption/server') return load('lib/adoption/server.ts');
    if (id === 'next/server') return { ...require(id), after: callback => { authState.after.push(callback); } };
    if (id === '@supabase/supabase-js') return { createClient: (_url, _key, options) => { assert.equal(options.auth.persistSession, false); return fakeDb(true); } };
    if (id === '@supabase/ssr') return { createServerClient: () => fakeDb() };
    if (id === 'next/headers') return { cookies: async () => ({ getAll: () => [], set: () => {} }) }; return require(id);
  }, module, module.exports); modules.set(file, module.exports); return module.exports;
}
function envFixture(t, enabled = true) { const names = ['LEARNBRIDGE_ADOPTION_ENABLED', 'APP_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'], saved = names.map(name => process.env[name]); process.env.LEARNBRIDGE_ADOPTION_ENABLED = enabled ? '1' : '0'; process.env.APP_URL = 'https://learnbridge.fixture'; process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fixture.supabase.co'; process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'synthetic-publishable-not-secret'; t.after(() => names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; })); resetAuthState(); }
const httpRequest = (path, body, origin = 'https://learnbridge.fixture') => new Request(`https://learnbridge.fixture${path}`, { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });

test('AM10 actual collector route stays disabled by default and strips all SDK fields from response', async t => {
  envFixture(t, false); const route = load('app/api/adoption/events/route.ts'); assert.equal((await route.POST(httpRequest('/api/adoption/events', envelope()))).status, 503); assert.equal(authState.calls.length, 0); process.env.LEARNBRIDGE_ADOPTION_ENABLED = '1';
  assert.equal((await route.POST(httpRequest('/api/adoption/events', envelope(), 'https://hostile.invalid'))).status, 403); assert.equal(authState.calls.length, 0);
  const response = await route.POST(httpRequest('/api/adoption/events', envelope())); assert.equal(response.status, 202); assert.equal((await response.text()).includes('PRIVATE_CANARY'), false); assert.equal(authState.calls[0].anonymous, true); assert.deepEqual(Object.keys(authState.calls[0].args).sort(), ['p_consent_version', 'p_event_id', 'p_event_name', 'p_prompt_version']);
});

test('AM11 real auth/admin helper denies anonymous, ordinary and forged metadata roles before aggregate RPC', async t => {
  envFixture(t); const route = load('app/api/admin/adoption/route.ts'); const req = () => httpRequest('/api/admin/adoption?start=2026-10-01&end=2026-10-03'); assert.equal((await route.GET(req())).status, 401);
  authState.user = { id: randomUUID(), email_confirmed_at: '2026-10-01', user_metadata: { admin: true }, app_metadata: { role: 'admin' } }; assert.equal((await route.GET(req())).status, 403); assert.equal(authState.calls.some(call => call.name === 'adoption_admin_report'), false);
  authState.admin = true; const response = await route.GET(req()); assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.report.observed_page_views, 10); assert.equal(result.report.successful_prompt_copies, 4); assert.equal(result.report.opted_in_setup_account_enrollments, 2); assert.equal(result.report.visitor_estimate, null); assert.equal(result.report.local_activation_enrollments, null); assert.match(result.method, /Copies, accounts and installations are different/);
  assert.equal((await route.GET(httpRequest('/api/admin/adoption?start=2026-10-01&end=2026-10-03&email=PRIVATE_CANARY'))).status, 400);
});

test('AM12 verified enrollment accepts no account/name/email selector and directory requires a separate choice', async t => {
  envFixture(t); const route = load('app/api/adoption/enrollment/route.ts'); const body = { expected_revision: 0, expected_review_hash: 'a'.repeat(64), enabled: true, directory_enabled: false, consent_version: ADOPTION_CONSENT_VERSION }; assert.equal((await route.PUT(httpRequest('/api/adoption/enrollment', body))).status, 401); authState.user = { id: randomUUID(), email_confirmed_at: '2026-10-01' };
  assert.equal((await route.PUT(httpRequest('/api/adoption/enrollment', { ...body, user_id: randomUUID(), email: 'PRIVATE_EMAIL_CANARY' }))).status, 400); assert.equal(authState.calls.length, 0);
  body.expected_review_hash = (await (await route.GET(httpRequest('/api/adoption/enrollment'))).json()).review_hash;
  const response = await route.PUT(httpRequest('/api/adoption/enrollment', body)); assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.identity, 'no_directory_access'); const write = authState.calls.find(call => call.name === 'adoption_set_enrollment'); assert.equal(write.args.p_directory_enabled, false); assert.equal(Object.hasOwn(write.args, 'p_user_id'), false);
  const directory = load('app/api/admin/adoption/directory/route.ts'); assert.equal((await directory.GET(httpRequest('/api/admin/adoption/directory'))).status, 403); authState.admin = true; assert.equal((await directory.GET(httpRequest('/api/admin/adoption/directory'))).status, 200);
});

test('AM13 hosted meaningful activity hook is off by default and never counts polls or blocks saves', async t => {
  envFixture(t, false); const server = load('lib/adoption/server.ts'); assert.equal(await server.recordHostedStateSave(fakeDb(), 'tasks', 1), false); assert.equal(authState.calls.length, 0); process.env.LEARNBRIDGE_ADOPTION_ENABLED = '1'; assert.equal(await server.recordHostedStateSave(fakeDb(), 'poll', 1), false); assert.equal(await server.recordHostedStateSave(fakeDb(), 'tasks', 0), false); assert.equal(await server.recordHostedStateSave(fakeDb(), 'tasks', 1), true); assert.equal(authState.calls.length, 1);
  assert.equal(await server.recordHostedStateSave({ rpc: async () => { throw new Error('PRIVATE_OUTAGE'); } }, 'draft', 2), false);
});

test('AM14 incomplete request bodies end at a fixed deadline without a collector write', async () => {
  const req = new Request('https://learnbridge.fixture/api/adoption/events', { method: 'POST', body: new ReadableStream({ pull() { return new Promise(() => {}); } }), duplex: 'half' }); await assert.rejects(boundedAdoptionBody(req, 2048, 10), error => error.code === 'BODY_TIMEOUT' && error.status === 408);
});

test('AM15 actual hosted state route schedules only successful own CAS saves, and metrics never delays or blocks them', async t => {
  envFixture(t, false); const route = load('app/api/state/[kind]/route.ts'), userId = randomUUID(); authState.user = { id: userId, email_confirmed_at: '2026-10-01' };
  const params = { params: Promise.resolve({ kind: 'tasks' }) }, save = revision => route.PUT(httpRequest('/api/state/tasks', { revision, value: [] }), params);
  const first = await save(0); assert.equal(first.status, 200); assert.deepEqual(await first.json(), { revision: 1 }); assert.equal(authState.after.length, 1); assert.equal(authState.calls.length, 0); assert.equal(await authState.after[0](), false); assert.equal(authState.calls.length, 0, 'disabled deferred hook performs no RPC');
  assert.equal(authState.tableCalls[0].row.user_id, userId); process.env.LEARNBRIDGE_ADOPTION_ENABLED = '1';
  const second = await save(1); assert.equal(second.status, 200); assert.equal(authState.after.length, 2); assert.equal(authState.calls.length, 0, 'response completes before background collector'); assert.equal(await authState.after[1](), true); assert.deepEqual(authState.calls[0].args, { p_kind: 'tasks', p_revision: 2 });
  assert.equal((await save(1)).status, 409); assert.equal(authState.after.length, 2, 'stale CAS save never schedules activity'); assert.equal(authState.calls.length, 1);
  const poll = await route.GET(httpRequest('/api/state/tasks'), params); assert.equal(poll.status, 200); assert.equal(authState.after.length, 2); assert.equal(authState.calls.length, 1, 'read/poll never records an activity');
  authState.failActivity = true; const duringOutage = await save(2); assert.equal(duringOutage.status, 200); assert.deepEqual(await duringOutage.json(), { revision: 3 }); assert.equal(authState.after.length, 3); assert.equal(await authState.after[2](), false); assert.equal(authState.stateRows.get(`${userId}:tasks`).revision, 3, 'collector outage does not roll back saved workspace');
  authState.user = null; assert.equal((await save(3)).status, 401); authState.user = { id: userId, email_confirmed_at: null }; assert.equal((await save(3)).status, 401); assert.equal(authState.after.length, 3, 'anonymous/unconfirmed saves schedule no collector');
});

test('AM16 account-choice review binds the current authenticated identity and settings while exposing no raw selector', async t => {
  envFixture(t); const route = load('app/api/adoption/enrollment/route.ts'), accountA = { id: randomUUID(), email_confirmed_at: '2026-10-01' }, accountB = { id: randomUUID(), email_confirmed_at: '2026-10-01' };
  authState.user = accountA; authState.enrollment.PRIVATE_CANARY = 'SDK_PRIVATE_EMAIL_CANARY'; const viewed = await (await route.GET(httpRequest('/api/adoption/enrollment'))).json(); assert.match(viewed.review_hash, /^[a-f0-9]{64}$/); assert.equal(JSON.stringify(viewed).includes('PRIVATE_CANARY'), false); assert.equal(JSON.stringify(viewed).includes(accountA.id), false);
  const choice = { expected_revision: 0, expected_review_hash: viewed.review_hash, enabled: true, directory_enabled: false, consent_version: ADOPTION_CONSENT_VERSION };
  authState.user = accountB; assert.equal((await route.PUT(httpRequest('/api/adoption/enrollment', choice))).status, 409); assert.equal(authState.calls.some(call => call.name === 'adoption_set_enrollment'), false, 'stale account A form cannot write account B even when both revisions are zero');
  authState.user = accountA; const saved = await route.PUT(httpRequest('/api/adoption/enrollment', choice)); assert.equal(saved.status, 200); const readback = await saved.json(); assert.notEqual(readback.review_hash, viewed.review_hash); assert.equal(readback.enrollment.revision, 1);
  assert.equal((await route.PUT(httpRequest('/api/adoption/enrollment', choice))).status, 409); assert.equal(authState.calls.filter(call => call.name === 'adoption_set_enrollment').length, 1, 'old exact review cannot silently repeat');
  authState.user = { ...accountA, email_confirmed_at: null }; assert.equal((await route.GET(httpRequest('/api/adoption/enrollment'))).status, 401);
});

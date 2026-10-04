import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { CLOUD_TOOL_CONTRACTS, createHostedCloudOnboarding } from '../apps/web/src/lib/server/cloud-onboarding-service.mjs';
import { validateCloudBundle } from '../apps/local-runtime/src/cloud-onboarding.mjs';

const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORIGIN = 'https://learnbridge.example';
const DOC_ID = 'synthetic_doc_1';
const TEXT = 'SYNTHETIC_SELECTED_LINK_TEXT\nhttps://untrusted.invalid/literal-reference\nLiteral document instructions remain source text.';
const SECRET_CANARY = 'SYNTHETIC_CREDENTIAL_CANARY_DO_NOT_FORWARD';
const choice = { provider: 'googledocs', account_id: 'ca_synthetic_alice', url: `https://docs.google.com/document/d/${DOC_ID}/edit`, academic_policy: 'learning_support' };
const readArgs = id => ({ document_id: id, include_tabs_content: true, include_tables: true, include_headers: true, include_footers: true, include_footnotes: true });
const denies = (promise, code) => assert.rejects(promise, error => error.code === code);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture() {
  const calls = [];
  let now = Date.parse('2026-10-04T12:00:00.000Z');
  let account = { id: choice.account_id, provider: choice.provider, owner_id: ALICE, shared: false, status: 'ACTIVE', configured: true };
  let reply = args => ({ document_id: args.document_id, title: 'Title reported by the selected provider', plain_text: TEXT, warnings: [], credentials: SECRET_CANARY });
  let schemaHook = rows => rows;
  let executeHook = async () => {};
  let accountHook = () => {};
  let accountChecks = 0;
  const transport = {
    async listAccounts(owner, signal) {
      calls.push(['accounts', owner, signal]);
      accountHook(++accountChecks);
      return { partial: false, items: account ? [{ ...account }] : [] };
    },
    async schemas(provider, signal) {
      calls.push(['schemas', provider, signal]);
      const contract = CLOUD_TOOL_CONTRACTS[provider];
      return schemaHook([[contract.search, contract.searchFields], [contract.read, contract.readFields]].map(([slug, fields]) => ({ slug, version: contract.version, input_fields: [...fields] })));
    },
    async execute(owner, selected, slug, args, signal) {
      calls.push(['execute', owner, selected.account_id, slug, structuredClone(args), signal]);
      assert.equal(owner, ALICE);
      assert.equal(selected.provider, 'googledocs');
      assert.equal(selected.account_id, choice.account_id);
      assert.equal(slug, CLOUD_TOOL_CONTRACTS.googledocs.read, 'The link path may execute only the pinned plaintext read, never search, HTTP fetch, or a write.');
      await executeHook(signal);
      return reply(args);
    },
  };
  const services = new Map();
  const service = (owner = ALICE) => {
    if (!services.has(owner)) services.set(owner, createHostedCloudOnboarding({ transport, secret: SECRET_CANARY, origin: ORIGIN, userId: owner, clock: () => now }));
    return services.get(owner);
  };
  return {
    calls, service,
    account(patch) { account = patch === null ? null : { ...account, ...patch }; },
    accountsAt(hook) { accountHook = hook; },
    response(value) { reply = typeof value === 'function' ? value : () => value; },
    schemas(hook) { schemaHook = hook; },
    duringRead(hook) { executeHook = hook; },
    advance(ms) { now += ms; },
  };
}

function loaded(path, stubs) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(id => {
    if (!Object.hasOwn(stubs, id)) throw Error(`Unexpected fixture module: ${id}`);
    return stubs[id];
  }, module, module.exports);
  return module.exports;
}
class AppError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const next = { NextResponse: { json: (body, options = {}) => ({ body, status: options.status || 200, headers: options.headers || {} }) } };
function helper(Composio = class {}) {
  return loaded('../apps/web/src/lib/server/cloud-onboarding.ts', {
    '@composio/core': { Composio },
    './auth': { AppError, appOrigin: () => ORIGIN },
    './cloud-onboarding-service.mjs': { CLOUD_TOOL_CONTRACTS, createHostedCloudOnboarding },
  });
}
function routeFixture({ factory, authDenied = false, ownerChangesAt = Infinity } = {}) {
  const calls = [], conversion = helper();
  let authCalls = 0;
  const access = loaded('../apps/web/src/lib/server/access.ts', { 'next/server': next, './auth': { AppError, appOrigin: () => ORIGIN } });
  const route = loaded('../apps/web/src/app/api/cloud-onboarding/[action]/route.ts', {
    'next/server': next,
    '@/lib/server/auth': {
      AppError,
      requireUser: async () => { calls.push(['auth']); authCalls++; if (authDenied) throw new AppError('Sign in', 401); return { db: 'owned-db', user: { id: authCalls >= ownerChangesAt ? BOB : ALICE } }; },
      useQuota: async (...args) => { calls.push(['quota', ...args]); },
    },
    '@/lib/server/access': access,
    '@/lib/server/cloud-onboarding': {
      cloudOperationError: conversion.cloudOperationError,
      cloudRequestBody: async (...args) => { calls.push(['body', args[1]]); return conversion.cloudRequestBody(...args); },
      hostedCloudOnboarding: owner => { calls.push(['factory', owner]); return factory(owner); },
    },
  });
  return { route, calls };
}
function request(body = choice, { origin = ORIGIN, action = 'preview_link', query = '', raw, signal } = {}) {
  const url = `${ORIGIN}/api/cloud-onboarding/${action}${query}`;
  const result = new Request(url, { method: 'POST', body: raw === undefined ? JSON.stringify(body) : raw, signal, headers: { ...(origin === null ? {} : { origin }), 'Content-Type': 'application/json', 'X-Student-ID': BOB } });
  result.nextUrl = new URL(url);
  return result;
}
const context = (action = 'preview_link') => ({ params: Promise.resolve({ action }) });
const exportInput = preview => ({ preview_token: preview.preview_token, review_hash: preview.review_hash, confirm: true });

test('CDLINK01: one exact Google Docs URL reads only its pinned ID and returns provider title, explicit partial provenance and a sealed review', async t => {
  const f = fixture(), controller = new AbortController();
  let networkFetches = 0;
  t.mock.method(globalThis, 'fetch', async () => { networkFetches++; throw Error('No URL fetch is permitted.'); });
  const preview = await f.service().previewLink(choice, controller.signal);
  assert.deepEqual(validateCloudBundle(preview.bundle), preview.bundle);
  const record = preview.bundle.records[0];
  assert.equal(preview.bundle.records.length, 1);
  assert.equal(record.id, DOC_ID);
  assert.equal(record.title, 'Title reported by the selected provider');
  assert.equal(record.url, choice.url);
  assert.equal(record.modified_at, null);
  assert.equal(record.text, TEXT);
  assert.equal(record.sha256, createHash('sha256').update(TEXT).digest('hex'));
  assert.equal(record.coverage, 'partial_text');
  assert.ok(record.limitations.some(reason => /link|URL/i.test(reason)), 'Direct-link acquisition must disclose its provenance.');
  assert.ok(record.limitations.some(reason => /modification|revision|time/i.test(reason)), 'A source modification time or stable revision was not obtained.');
  assert.deepEqual(preview.bundle.owner, { student_id: ALICE, verification: 'supabase_session_at_fetch' });
  assert.equal(preview.bundle.origin, ORIGIN);
  assert.equal(preview.bundle.academic_policy, 'learning_support');
  assert.equal(preview.review_hash, preview.bundle.bundle_hash);
  assert.equal(preview.sharing, 'not_granted');
  assert.equal(preview.expires_at, '2026-10-04T12:05:00.000Z');
  assert.equal(JSON.stringify(preview).includes(SECRET_CANARY), false);
  const execution = f.calls.filter(call => call[0] === 'execute');
  assert.equal(execution.length, 1);
  assert.deepEqual(execution[0].slice(1, 5), [ALICE, choice.account_id, CLOUD_TOOL_CONTRACTS.googledocs.read, readArgs(DOC_ID)]);
  assert.equal(execution[0][5], controller.signal);
  assert.ok(f.calls.filter(call => call[0] === 'accounts').length >= 4, 'Ownership is checked around schema validation and the exact read.');
  assert.equal(networkFetches, 0);
});

test('CDLINK02: noncanonical URL authorities, normalization variants and invalid IDs are denied before any account, schema or provider activity', async () => {
  const invalid = [
    undefined, null, 42, {}, [], '', 'not-a-url',
    `http://docs.google.com/document/d/${DOC_ID}/edit`,
    `https://DOCS.google.com/document/d/${DOC_ID}/edit`,
    `HTTPS://docs.google.com/document/d/${DOC_ID}/edit`,
    `https://docs.google.com:443/document/d/${DOC_ID}/edit`,
    `https://docs.google.com:8443/document/d/${DOC_ID}/edit`,
    `https://user@docs.google.com/document/d/${DOC_ID}/edit`,
    `https://user:pass@docs.google.com/document/d/${DOC_ID}/edit`,
    `https://docs.google.com.evil.invalid/document/d/${DOC_ID}/edit`,
    `https://evil.invalid/document/d/${DOC_ID}/edit`,
    `https://docs.google.com./document/d/${DOC_ID}/edit`,
    `https://docs.google.com/document/d/${DOC_ID}/edit?usp=sharing`,
    `https://docs.google.com/document/d/${DOC_ID}/edit#heading`,
    `https://docs.google.com/document/d/${DOC_ID}/edit?`,
    `https://docs.google.com/document/d/${DOC_ID}/edit#`,
    ` https://docs.google.com/document/d/${DOC_ID}/edit`,
    `https://docs.google.com/document/d/${DOC_ID}/edit\\n`,
    `https://docs.google.com/document/d/${DOC_ID}/edit\n`,
    `https://docs.google.com/document/d/${DOC_ID}/edit\r`,
    `https://docs.google.com/document/d/${DOC_ID}/edit\r\n`,
    `https://docs.google.com/document/d/${DOC_ID}/edit\t`,
    `https://docs.google.com/document/d/${DOC_ID}/edit\u2028`,
    `https://docs.google.com/document/d/${DOC_ID}/edit\u2029`,
    `https://docs.google.com/document/d/${DOC_ID}/edit/`,
    `https://docs.google.com/document/d/${DOC_ID}/view`,
    `https://docs.google.com/document/u/0/d/${DOC_ID}/edit`,
    `https://docs.google.com/document/d/../${DOC_ID}/edit`,
    `https://docs.google.com/document/d/placeholder/../${DOC_ID}/edit`,
    `https://docs.google.com/document/d/${DOC_ID}/./edit`,
    `https://docs.google.com/document/d/${DOC_ID}/%65dit`,
    `https://docs.google.com/document/d/%73ynthetic_doc_1/edit`,
    `https://docs.google.com/document/d/synthetic%2Fdoc_1/edit`,
    `https://docs.google.com\\document\\d\\${DOC_ID}\\edit`,
    `https://docs.google.com/document/d/a/edit`,
    `https://docs.google.com/document/d/${'a'.repeat(9)}/edit`,
    `https://docs.google.com/document/d/${'a'.repeat(201)}/edit`,
    `https://docs.google.com/document/d/synthetic.doc.1/edit`,
    `https://docs.google.com/document/d/synthetic+doc_1/edit`,
  ];
  for (const url of invalid) {
    const f = fixture();
    await denies(f.service().previewLink({ ...choice, url }), 'INVALID_INPUT');
    assert.deepEqual(f.calls, [], `Invalid URL must be rejected locally: ${String(url)}`);
  }
});

test('CDLINK03: unsupported providers, browser-supplied identity, extra fields and invalid academic policy cannot invoke the link transport', async () => {
  const inputs = [
    { ...choice, provider: 'notion' }, { ...choice, provider: 'gdrive' },
    { ...choice, account_id: 'account with space' }, { ...choice, account_id: 'a'.repeat(201) },
    { ...choice, academic_policy: 'automatically_complete_graded_work' },
    { ...choice, user_id: BOB }, { ...choice, document_id: 'another_doc_id' },
    { ...choice, title: 'Browser title must not become trusted metadata' },
    { ...choice, destination: 'codex' }, { ...choice, token: SECRET_CANARY },
  ];
  for (const input of inputs) {
    const f = fixture(); await denies(f.service().previewLink(input), 'INVALID_INPUT'); assert.deepEqual(f.calls, []);
  }
});

test('CDLINK04: canonical ID and text byte boundaries remain accepted without expanding the selected record', async () => {
  for (const id of ['a'.repeat(10), `A_${'z'.repeat(198)}`]) {
    const f = fixture();
    f.response(args => ({ document_id: args.document_id, title: 't'.repeat(500), plain_text: 'x'.repeat(20000), warnings: [] }));
    const result = await f.service().previewLink({ ...choice, url: `https://docs.google.com/document/d/${id}/edit`, academic_policy: 'graded_restricted' });
    assert.equal(result.bundle.records.length, 1); assert.equal(result.bundle.records[0].id, id);
    assert.equal(Buffer.byteLength(result.bundle.records[0].text), 20000); assert.equal(result.bundle.academic_policy, 'graded_restricted');
    assert.deepEqual(f.calls.find(call => call[0] === 'execute')[4], readArgs(id));
  }
});

test('CDLINK05: foreign, shared, disabled, unconfigured or provider-mismatched accounts are rejected before schemas or content reads', async () => {
  for (const patch of [null, { owner_id: BOB }, { shared: true }, { status: 'DISABLED' }, { status: 'EXPIRED' }, { configured: false }, { provider: 'notion' }, { id: 'ca_unselected' }]) {
    const f = fixture(); f.account(patch);
    await denies(f.service().previewLink(choice), 'CONSENT_REQUIRED');
    assert.deepEqual(f.calls.map(call => call[0]), ['accounts']);
  }
  const f = fixture(); await denies(f.service(BOB).previewLink(choice), 'CONSENT_REQUIRED');
  assert.deepEqual(f.calls.map(call => call.slice(0, 2)), [['accounts', BOB]]);
});

test('CDLINK06: account revocation during schemas, immediately before reading or after reading prevents an export-ready bundle', async () => {
  for (const checks of [2, 3, 4]) {
    for (const patch of [{ owner_id: BOB }, { shared: true }, { status: 'DISABLED' }, { configured: false }]) {
      const f = fixture(); f.accountsAt(number => { if (number >= checks) f.account(patch); });
      await denies(f.service().previewLink(choice), 'CONSENT_REQUIRED');
      assert.equal(f.calls.filter(call => call[0] === 'execute').length, checks === 4 ? 1 : 0);
    }
  }
});

test('CDLINK07: reviewed export rechecks the owned account and never performs another source read or model operation', async () => {
  const f = fixture(), preview = await f.service().previewLink(choice);
  const before = f.calls.filter(call => call[0] === 'execute').length;
  const exported = await f.service().export(exportInput(preview));
  assert.deepEqual(exported.bundle, preview.bundle); assert.equal(exported.filename, 'LearnBridge-selected-googledocs.json'); assert.equal(exported.sharing, 'not_granted');
  assert.equal(f.calls.filter(call => call[0] === 'execute').length, before);
  f.account({ configured: false }); await denies(f.service().export(exportInput(preview)), 'CONSENT_REQUIRED');
  assert.equal(f.calls.filter(call => call[0] === 'execute').length, before);
  assert.equal(JSON.stringify(exported).includes(SECRET_CANARY), false);
});

test('CDLINK08: cancellation before work, during schema validation or during a delayed exact read never returns private text', async () => {
  const pre = fixture(), cancelled = new AbortController(); cancelled.abort();
  await denies(pre.service().previewLink(choice, cancelled.signal), 'CANCELLED'); assert.deepEqual(pre.calls, []);
  const probe = fixture(), probing = new AbortController();
  probe.schemas(rows => { probing.abort(); return rows; });
  await denies(probe.service().previewLink(choice, probing.signal), 'CANCELLED'); assert.equal(probe.calls.some(call => call[0] === 'execute'), false);
  const f = fixture(), controller = new AbortController(), started = deferred(), release = deferred();
  f.duringRead(async signal => { assert.equal(signal, controller.signal); started.resolve(); await release.promise; });
  const pending = f.service().previewLink(choice, controller.signal); await started.promise; controller.abort(); release.resolve();
  await denies(pending, 'CANCELLED');
  assert.equal(f.calls.filter(call => call[0] === 'execute').length, 1);
  f.duringRead(async () => {});
  const preview = await f.service().previewLink(choice); await denies(f.service().export(exportInput(preview), controller.signal), 'CANCELLED');
});

test('CDLINK09: both existing pinned schema contracts are checked before the direct read despite search never being executed', async () => {
  for (const alter of [
    rows => rows.filter(row => row.slug !== CLOUD_TOOL_CONTRACTS.googledocs.search),
    rows => rows.filter(row => row.slug !== CLOUD_TOOL_CONTRACTS.googledocs.read),
    rows => rows.map(row => ({ ...row, version: 'unknown_version' })),
    rows => rows.map(row => row.slug === CLOUD_TOOL_CONTRACTS.googledocs.search ? { ...row, input_fields: row.input_fields.filter(field => field !== 'query') } : row),
    rows => rows.map(row => row.slug === CLOUD_TOOL_CONTRACTS.googledocs.read ? { ...row, input_fields: row.input_fields.filter(field => field !== 'document_id') } : row),
  ]) {
    const f = fixture(); f.schemas(alter); await denies(f.service().previewLink(choice), 'VERSION_MISMATCH');
    assert.equal(f.calls.some(call => call[0] === 'execute'), false);
  }
});

test('CDLINK10: mismatched IDs, malformed titles/text/warnings and provider response budgets never prepare a transferable record', async () => {
  const valid = { document_id: DOC_ID, title: 'Provider title', plain_text: TEXT, warnings: [] };
  const cases = [
    [{ document_id: 'foreign_document_id' }, 'PROVIDER_FAILURE'],
    [{ document_id: null }, 'PROVIDER_FAILURE'],
    [{ plain_text: {} }, 'INVALID_INPUT'], [{ plain_text: null }, 'INVALID_INPUT'],
    [{ plain_text: 'text\u0001' }, 'INVALID_INPUT'], [{ plain_text: '\ud800' }, 'INVALID_INPUT'],
    [{ plain_text: 'x'.repeat(20001) }, 'BUDGET_EXCEEDED'],
    [{ plain_text: '€'.repeat(6667) }, 'BUDGET_EXCEEDED'],
    [{ unrelated_metadata: 'x'.repeat(100001) }, 'BUDGET_EXCEEDED'],
    [{ title: '' }, 'INVALID_INPUT'], [{ title: {} }, 'INVALID_INPUT'], [{ title: null }, 'INVALID_INPUT'],
    [{ title: 'x'.repeat(501) }, 'BUDGET_EXCEEDED'],
    [{ warnings: {} }, 'PROVIDER_FAILURE'], [{ warnings: Array.from({ length: 21 }, () => 'Warning') }, 'PROVIDER_FAILURE'],
    [{ warnings: [42] }, 'INVALID_INPUT'], [{ warnings: ['x'.repeat(501)] }, 'BUDGET_EXCEEDED'],
  ];
  for (const [patch, code] of cases) {
    const f = fixture(); f.response({ ...valid, ...patch }); await denies(f.service().previewLink(choice), code);
    assert.equal(f.calls.filter(call => call[0] === 'execute').length, 1);
  }
  const f = fixture(); f.response({ ...valid, warnings: ['Provider warning one', 'Provider warning two', 'Provider warning three', 'Provider warning four', 'Omitted fifth warning'] });
  const record = (await f.service().previewLink(choice)).bundle.records[0];
  assert.ok(record.limitations.includes('Provider warning one')); assert.ok(record.limitations.includes('Provider warning four')); assert.equal(record.limitations.includes('Omitted fifth warning'), false);
});

test('CDLINK11: changed review hashes, forged or expired tokens, missing confirmation and a different hosted owner deny exports before transport', async () => {
  const f = fixture(), preview = await f.service().previewLink(choice), before = f.calls.length;
  const changedToken = preview.preview_token.slice(0, -1) + (preview.preview_token.endsWith('0') ? '1' : '0');
  for (const patch of [{ confirm: false }, { review_hash: '0'.repeat(64) }, { preview_token: changedToken }, { preview_token: 'malformed' }]) {
    await denies(f.service().export({ ...exportInput(preview), ...patch }), 'CONSENT_REQUIRED'); assert.equal(f.calls.length, before);
  }
  await denies(f.service(BOB).export(exportInput(preview)), 'CONSENT_REQUIRED'); assert.equal(f.calls.length, before);
  f.advance(300000); await denies(f.service().export(exportInput(preview)), 'CONSENT_REQUIRED'); assert.equal(f.calls.length, before);
});

test('CDLINK12: actual preview_link route enforces sign-in, exact same origin, action/query allowlists, quota and verified identity', async () => {
  const f = fixture(), factory = owner => f.service(owner);
  const denied = routeFixture({ factory, authDenied: true });
  assert.equal((await denied.route.POST(request(), context())).status, 401); assert.equal(denied.calls.some(call => call[0] === 'body'), false);
  for (const origin of [null, 'https://foreign.invalid']) {
    const wrong = routeFixture({ factory }); assert.equal((await wrong.route.POST(request(choice, { origin }), context())).status, 403); assert.deepEqual(wrong.calls, []);
  }
  for (const action of ['execute', 'previewLink', 'read']) {
    const wrong = routeFixture({ factory }); assert.equal((await wrong.route.POST(request(choice, { action }), context(action))).status, 404); assert.equal(wrong.calls.some(call => call[0] === 'body'), false);
  }
  const queried = routeFixture({ factory });
  assert.equal((await queried.route.POST(request(choice, { query: `?user_id=${BOB}` }), context())).status, 404); assert.equal(queried.calls.some(call => call[0] === 'factory'), false);
  const correct = routeFixture({ factory }), result = await correct.route.POST(request(), context());
  assert.equal(result.status, 200); assert.equal(result.headers['Cache-Control'], 'private, no-store'); assert.equal(result.body.bundle.owner.student_id, ALICE);
  assert.deepEqual(correct.calls.filter(call => call[0] === 'quota'), [['quota', 'owned-db', 'connector']]);
  assert.deepEqual(correct.calls.filter(call => call[0] === 'factory'), [['factory', ALICE]]);
  assert.deepEqual(correct.calls.filter(call => call[0] === 'body'), [['body', 4096]]);
  assert.equal((await correct.route.GET(request(), context())).status, 404);
});

test('CDLINK13: actual route rechecks owner around body/read and applies streaming body bounds, cancellation and private error sanitization', async () => {
  for (const ownerChangesAt of [2, 3]) {
    const f = fixture(), r = routeFixture({ factory: owner => f.service(owner), ownerChangesAt });
    const result = await r.route.POST(request(), context());
    assert.equal(result.status, 403); assert.equal(JSON.stringify(result).includes(TEXT), false);
    assert.equal(f.calls.filter(call => call[0] === 'execute').length, ownerChangesAt === 2 ? 0 : 1);
  }
  for (const [raw, status] of [['x'.repeat(4097), 413], ['not-json', 400], [new Uint8Array([0xff]), 400]]) {
    const f = fixture(), r = routeFixture({ factory: owner => f.service(owner) });
    assert.equal((await r.route.POST(request(choice, { raw }), context())).status, status); assert.equal(r.calls.some(call => call[0] === 'factory'), false); assert.deepEqual(f.calls, []);
  }
  const privateError = fixture(); privateError.duringRead(async () => { throw new Error(SECRET_CANARY); });
  const bad = routeFixture({ factory: owner => privateError.service(owner) }), failed = await bad.route.POST(request(), context());
  assert.equal(failed.status, 502); assert.equal(JSON.stringify(failed).includes(SECRET_CANARY), false); assert.equal(JSON.stringify(failed).includes(TEXT), false);
  const controller = new AbortController(); controller.abort();
  const cancelled = fixture(), r = routeFixture({ factory: owner => cancelled.service(owner) });
  assert.equal((await r.route.POST(request(choice, { signal: controller.signal }), context())).status, 409); assert.deepEqual(cancelled.calls, []);
});

test('CDLINK14: actual SDK adapter pins one PRIVATE student account and exact read version/flags without credential leakage or direct URL fetch', async t => {
  const names = ['COMPOSIO_API_KEY', 'COMPOSIO_AUTH_GOOGLEDOCS', 'COMPOSIO_AUTH_NOTION'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  process.env.COMPOSIO_API_KEY = SECRET_CANARY; process.env.COMPOSIO_AUTH_GOOGLEDOCS = 'ac_synthetic_docs';
  const calls = [];
  let wrongConfig = false;
  class Composio {
    constructor(config) { calls.push(['construct', { allowTracking: config.allowTracking, disableVersionCheck: config.disableVersionCheck, toolkitVersions: config.toolkitVersions }]); }
    connectedAccounts = { list: async (query, options) => {
      calls.push(['list', query, options]);
      return { items: [{ id: choice.account_id, toolkit: { slug: 'googledocs' }, status: 'ACTIVE', isDisabled: false, authConfig: { id: wrongConfig ? 'ac_unconfigured' : 'ac_synthetic_docs', isDisabled: false }, experimental: { accountType: 'PRIVATE' }, data: { access_token: SECRET_CANARY }, state: { credential: SECRET_CANARY } }] };
    } };
    tools = {
      getRawComposioToolBySlug: async (slug, version, options) => {
        calls.push(['schema', slug, version, options]); const contract = CLOUD_TOOL_CONTRACTS.googledocs;
        return { slug, version: contract.version, inputParameters: { properties: Object.fromEntries((slug === contract.search ? contract.searchFields : contract.readFields).map(field => [field, {}])) } };
      },
      execute: async (slug, body, options) => {
        calls.push(['execute', slug, body, options]);
        assert.equal(slug, CLOUD_TOOL_CONTRACTS.googledocs.read);
        return { successful: true, data: { document_id: body.arguments.document_id, title: 'SDK-reported selected title', plain_text: TEXT, warnings: [], ignored_secret: SECRET_CANARY } };
      },
    };
  }
  const official = helper(Composio), signal = new AbortController().signal;
  const preview = await official.hostedCloudOnboarding(ALICE).previewLink(choice, signal);
  assert.equal(JSON.stringify(preview).includes(SECRET_CANARY), false);
  assert.deepEqual(calls.find(call => call[0] === 'construct')[1], { allowTracking: false, disableVersionCheck: true, toolkitVersions: { googledocs: '20260826_00', notion: '20260915_00' } });
  assert.ok(calls.filter(call => call[0] === 'list').every(call => JSON.stringify(call[1]) === JSON.stringify({ userIds: [ALICE], toolkitSlugs: ['googledocs', 'notion'], accountType: 'PRIVATE', statuses: ['ACTIVE'], limit: 100 }) && call[2].signal === signal));
  const schemas = calls.filter(call => call[0] === 'schema'); assert.equal(schemas.length, 2);
  assert.ok(schemas.every(call => call[2].version === '20260826_00' && call[3].signal === signal));
  const executions = calls.filter(call => call[0] === 'execute'); assert.equal(executions.length, 1);
  assert.deepEqual(executions[0][2], { userId: ALICE, connectedAccountId: choice.account_id, arguments: readArgs(DOC_ID), version: '20260826_00', allowTracing: false });
  assert.equal(executions[0][3].signal, signal);
  wrongConfig = true;
  await denies(official.hostedCloudOnboarding(ALICE).previewLink(choice, signal), 'CONSENT_REQUIRED'); assert.equal(calls.filter(call => call[0] === 'execute').length, 1);
});

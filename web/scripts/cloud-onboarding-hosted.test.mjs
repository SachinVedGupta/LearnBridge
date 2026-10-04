import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { CLOUD_TOOL_CONTRACTS, createHostedCloudOnboarding } from '../apps/web/src/lib/server/cloud-onboarding-service.mjs';

const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const choice = { provider: 'googledocs', account_id: 'ca_synthetic_alice' };
function fixture() {
  const calls = []; let now = Date.parse('2026-10-04T12:00:00.000Z'), available = true, mode = 'normal', textCount = 0;
  const transport = {
    async listAccounts(owner, signal) { calls.push(['accounts', owner]); return { partial: false, items: available ? [{ id: choice.account_id, provider: choice.provider, owner_id: ALICE, shared: false, status: 'ACTIVE', configured: true }, { id: 'ca_foreign', provider: 'googledocs', owner_id: BOB, shared: false, status: 'ACTIVE', configured: true }, { id: 'ca_shared', provider: 'googledocs', owner_id: ALICE, shared: true, status: 'ACTIVE', configured: true }, { id: 'ca_notion', provider: 'notion', owner_id: ALICE, shared: false, status: 'ACTIVE', configured: true }] : [] }; },
    async schemas(provider) { calls.push(['schemas', provider]); const contract = CLOUD_TOOL_CONTRACTS[provider]; return [[contract.search, contract.searchFields], [contract.read, contract.readFields]].map(([slug, fields]) => ({ slug, version: mode === 'schema' ? 'unknown_version' : contract.version, input_fields: fields })); },
    async execute(owner, selected, slug, args) {
      calls.push(['execute', owner, selected.account_id, slug, args]);
      if (slug === 'GOOGLEDOCS_SEARCH_DOCUMENTS') return { files: [{ id: 'synthetic_doc_1', name: 'Selected synthetic notes', modified_time: '2026-10-04T10:00:00Z' }, { id: 'synthetic_doc_2', name: 'Unchecked synthetic notes' }, ...(mode === 'escaped_boundary' ? [{ id: 'synthetic_doc_3', name: 'Boundary synthetic notes' }] : [])], next_page_token: 'NOT_FOLLOWED' };
      if (slug === 'NOTION_SEARCH_NOTION_PAGE') return { results: [{ object: 'page', id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', properties: { title: { type: 'title', title: [{ plain_text: 'Synthetic Notion page' }] } }, last_edited_time: '2026-10-04T10:00:00Z' }], has_more: true };
      if (mode === 'revoke') available = false;
      if (slug === 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT') return { document_id: mode === 'wrong_id' ? 'foreign_document_id' : args.document_id, title: 'Selected synthetic notes', plain_text: mode === 'oversize' ? 'x'.repeat(20001) : mode === 'escaped_boundary' ? '\n'.repeat(textCount) : 'SYNTHETIC_SELECTED_CLOUD_BODY', warnings: [] };
      if (slug === 'NOTION_GET_PAGE_MARKDOWN') return { object: 'page_markdown', id: args.page_id, markdown: '# SYNTHETIC_NOTION_TEXT\nLiteral link, never fetched.', truncated: true, unknown_block_ids: ['synthetic_unknown_block'] };
      assert.fail('No other tool, model, file or source operation is allowed.');
    },
  };
  const service = userId => createHostedCloudOnboarding({ transport, secret: 'synthetic_signing_config_only', origin: 'https://learnbridge.example', userId, clock: () => now });
  return { calls, get service() { return service(ALICE); }, bob: () => service(BOB), advance(ms) { now += ms; }, revoke() { available = false; }, mode(value) { mode = value; }, textCount(value) { textCount = value; } };
}
async function selected(f, selectedChoice = choice) { const result = await f.service.search({ ...selectedChoice, query: 'my course' }); return { ...selectedChoice, selection_tokens: [result.items[0].selection_token], academic_policy: 'learning_support' }; }
const denies = (promise, code) => assert.rejects(promise, error => error.code === code);
test('CHOST01: owned private accounts only; metadata search is explicit and body-free, with hardcoded bounded read arguments', async () => {
  const f = fixture(); assert.deepEqual((await f.service.accounts()).items.map(account => account.id), ['ca_synthetic_alice', 'ca_notion']);
  await denies(f.service.search({ ...choice, account_id: 'ca_foreign', query: 'course' }), 'CONSENT_REQUIRED'); await denies(f.service.search({ ...choice, account_id: 'ca_shared', query: 'course' }), 'CONSENT_REQUIRED');
  await denies(f.service.search({ ...choice, query: '' }), 'INVALID_INPUT'); await denies(f.service.search({ ...choice, query: 'course', user_id: BOB }), 'INVALID_INPUT');
  const results = await f.service.search({ ...choice, query: "my 'course'" }); assert.equal(results.coverage, 'partial'); assert.equal(JSON.stringify(results).includes('SYNTHETIC_SELECTED_CLOUD_BODY'), false);
  const executed = f.calls.filter(call => call[0] === 'execute'); assert.equal(executed.length, 1); assert.equal(executed[0][3], 'GOOGLEDOCS_SEARCH_DOCUMENTS'); assert.deepEqual(executed[0][4], { query: "fullText contains 'my \\'course\\''", max_results: 20, response_detail: 'minimal', include_trashed: false });
});
test('CHOST02: selected-only preview and exact review export contain no connection credentials, selection tokens or model access', async () => {
  const f = fixture(), input = await selected(f), result = await f.service.preview(input); assert.equal(result.bundle.records.length, 1); assert.equal(result.bundle.records[0].text, 'SYNTHETIC_SELECTED_CLOUD_BODY'); assert.equal(result.bundle.owner.student_id, ALICE);
  assert.equal(f.calls.filter(call => call[3] === 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT').length, 1); assert.equal(f.calls.some(call => call[4]?.document_id === 'synthetic_doc_2'), false);
  const before = f.calls.filter(call => call[0] === 'execute').length, exported = await f.service.export({ preview_token: result.preview_token, review_hash: result.review_hash, confirm: true });
  assert.deepEqual(exported.bundle, result.bundle); assert.equal(exported.filename, 'LearnBridge-selected-googledocs.json'); assert.equal(exported.sharing, 'not_granted'); assert.equal(f.calls.filter(call => call[0] === 'execute').length, before);
  assert.equal(JSON.stringify(exported.bundle).includes('selection_token'), false); assert.equal(JSON.stringify(exported.bundle).includes('synthetic_signing_config_only'), false);
});
test('CHOST03: forged selection, cross-owner token, duplicate/mixed selections and unsigned extra authorities are refused', async () => {
  const f = fixture(), input = await selected(f); const token = input.selection_tokens[0];
  for (const altered of [token.slice(0, -1) + (token.endsWith('0') ? '1' : '0'), token + '=', 'malformed']) await denies(f.service.preview({ ...input, selection_tokens: [altered] }), 'CONSENT_REQUIRED');
  await denies(f.bob().preview(input), 'CONSENT_REQUIRED'); await denies(f.service.preview({ ...input, selection_tokens: [token, token] }), 'CONSENT_REQUIRED'); await denies(f.service.preview({ ...input, account_id: 'ca_notion' }), 'CONSENT_REQUIRED');
  await denies(f.service.preview({ ...input, destination: 'codex' }), 'INVALID_INPUT'); assert.equal(f.calls.filter(call => call[3] === 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT').length, 0);
});
test('CHOST04: expired preview/selection and changed export review hash or missing confirmation refuse a transfer', async () => {
  const f = fixture(), input = await selected(f), result = await f.service.preview(input);
  await denies(f.service.export({ preview_token: result.preview_token, review_hash: result.review_hash, confirm: false }), 'CONSENT_REQUIRED');
  await denies(f.service.export({ preview_token: result.preview_token, review_hash: '0'.repeat(64), confirm: true }), 'CONSENT_REQUIRED');
  f.advance(300001); await denies(f.service.preview(input), 'CONSENT_REQUIRED'); await denies(f.service.export({ preview_token: result.preview_token, review_hash: result.review_hash, confirm: true }), 'CONSENT_REQUIRED');
});
test('CHOST05: provider/schema drift, changed returned ID, oversized content and mid-read revocation never prepare a bundle', async () => {
  for (const [mode, code] of [['schema', 'VERSION_MISMATCH'], ['wrong_id', 'PROVIDER_FAILURE'], ['oversize', 'BUDGET_EXCEEDED'], ['revoke', 'CONSENT_REQUIRED']]) {
    const f = fixture(), input = await selected(f); f.mode(mode); await denies(f.service.preview(input), code);
  }
  const f = fixture(), result = await f.service.preview(await selected(f)); f.revoke(); await denies(f.service.export({ preview_token: result.preview_token, review_hash: result.review_hash, confirm: true }), 'CONSENT_REQUIRED');
});
test('CHOST06: Notion truncation and unknown blocks remain explicit partial coverage, with no transcript or referenced-file fetch', async () => {
  const f = fixture(), result = await f.service.preview(await selected(f, { provider: 'notion', account_id: 'ca_notion' })); const item = result.bundle.records[0]; assert.equal(item.coverage, 'partial_text'); assert.ok(item.limitations.some(reason => reason.includes('truncated'))); assert.ok(item.limitations.some(reason => reason.includes('could not be rendered')));
  assert.deepEqual(f.calls.find(call => call[3] === 'NOTION_GET_PAGE_MARKDOWN')[4], { page_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', include_transcript: false });
});
test('CHOST07: an already cancelled operation does not list accounts, probe tools or fetch text', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort(); await denies(f.service.search({ ...choice, query: 'course' }, controller.signal), 'CANCELLED'); assert.deepEqual(f.calls, []);
});
function loaded(path, stubs) {
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} }; new Function('require', 'module', 'exports', code)(id => { if (!Object.hasOwn(stubs, id)) throw Error(`Unexpected fixture module: ${id}`); return stubs[id]; }, module, module.exports); return module.exports;
}
class AppError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
test('CHOST08: actual hosted route independently checks auth/origin, refuses query/unknown actions and passes only verified student identity', async () => {
  let deniedAuth = false, originDenied = false, bodies = 0; const owners = [], actions = [], quota = [];
  const route = loaded('../apps/web/src/app/api/cloud-onboarding/[action]/route.ts', {
    'next/server': { NextResponse: { json: (body, options) => ({ body, ...options }) } }, '@/lib/server/auth': { AppError, requireUser: async () => { if (deniedAuth) throw new AppError('Sign in', 401); return { db: 'owned-db', user: { id: ALICE } }; }, useQuota: async (...args) => quota.push(args) },
    '@/lib/server/access': { sameOrigin: () => originDenied ? { status: 403 } : null, failure: error => ({ status: error.status || 502 }) },
    '@/lib/server/cloud-onboarding': { cloudOperationError: error => error, cloudRequestBody: async request => { bodies++; return request.fixtureBody; }, hostedCloudOnboarding: owner => { owners.push(owner); return Object.fromEntries(['accounts', 'probe', 'search', 'preview', 'export'].map(action => [action, async input => { actions.push([action, input]); return { received: true }; }])); } },
  });
  const request = { nextUrl: new URL('https://learnbridge.example/api/cloud-onboarding/search'), signal: new AbortController().signal, fixtureBody: { ...choice, query: 'course' }, headers: new Headers({ 'X-Student-ID': BOB }) }, context = action => ({ params: Promise.resolve({ action }) });
  deniedAuth = true; assert.equal((await route.POST(request, context('search'))).status, 401); assert.equal(bodies, 0); deniedAuth = false;
  originDenied = true; assert.equal((await route.POST(request, context('search'))).status, 403); assert.equal(bodies, 0); originDenied = false;
  assert.equal((await route.POST(request, context('execute'))).status, 404); assert.equal(bodies, 0);
  assert.equal((await route.GET({ ...request, nextUrl: new URL(request.nextUrl + '?user_id=' + BOB) }, context('accounts'))).status, 404);
  const result = await route.POST(request, context('search')); assert.equal(result.headers['Cache-Control'], 'private, no-store'); assert.deepEqual(owners, [ALICE]); assert.deepEqual(actions, [['search', request.fixtureBody]]); assert.deepEqual(quota, [['owned-db', 'connector']]);
});
test('CHOST09: real SDK adapter sends PRIVATE user filter and exact direct account/version/read-only arguments without forwarding raw credential fields', async t => {
  const saved = Object.fromEntries(['COMPOSIO_API_KEY', 'COMPOSIO_AUTH_GOOGLEDOCS', 'COMPOSIO_AUTH_NOTION'].map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  process.env.COMPOSIO_API_KEY = 'synthetic_signing_config_only'; process.env.COMPOSIO_AUTH_GOOGLEDOCS = 'ac_synthetic_docs';
  const calls = [];
  class Composio {
    constructor(config) { calls.push(['construct', { allowTracking: config.allowTracking, disableVersionCheck: config.disableVersionCheck, toolkitVersions: config.toolkitVersions }]); }
    connectedAccounts = { list: async (query, options) => { calls.push(['list', query, options]); return { items: [{ id: choice.account_id, toolkit: { slug: 'googledocs' }, status: 'ACTIVE', isDisabled: false, authConfig: { id: 'ac_synthetic_docs', isDisabled: false }, experimental: { accountType: 'PRIVATE' }, data: { access_token: 'SYNTHETIC_CREDENTIAL_CANARY' } }] }; } };
    tools = { getRawComposioToolBySlug: async (slug, options) => { calls.push(['schema', slug, options]); const contract = CLOUD_TOOL_CONTRACTS.googledocs; return { slug, version: contract.version, inputParameters: { properties: Object.fromEntries((slug === contract.search ? contract.searchFields : contract.readFields).map(field => [field, {}])) } }; },
      execute: async (slug, body, options) => { calls.push(['execute', slug, body, options]); return { successful: true, data: { files: [{ id: 'synthetic_doc_1', name: 'Selected synthetic source' }] } }; } };
  }
  const helper = loaded('../apps/web/src/lib/server/cloud-onboarding.ts', { '@composio/core': { Composio }, './auth': { AppError, appOrigin: () => 'https://learnbridge.example' }, './cloud-onboarding-service.mjs': { CLOUD_TOOL_CONTRACTS, createHostedCloudOnboarding } });
  const result = await helper.hostedCloudOnboarding(ALICE).search({ ...choice, query: 'course' }, new AbortController().signal);
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_CREDENTIAL_CANARY'), false); assert.ok(calls.filter(call => call[0] === 'list').every(call => call[1].userIds.length === 1 && call[1].userIds[0] === ALICE && call[1].accountType === 'PRIVATE'));
  const execution = calls.find(call => call[0] === 'execute'); assert.equal(execution[1], CLOUD_TOOL_CONTRACTS.googledocs.search); assert.equal(execution[2].userId, ALICE); assert.equal(execution[2].connectedAccountId, choice.account_id); assert.equal(execution[2].version, '20260826_00'); assert.equal(execution[2].allowTracing, false); assert.ok(execution[3].signal instanceof AbortSignal);
});
test('CHOST10: request body streaming bounds and error conversion never echo private provider errors', async () => {
  const helper = loaded('../apps/web/src/lib/server/cloud-onboarding.ts', { '@composio/core': { Composio: class {} }, './auth': { AppError, appOrigin: () => 'https://learnbridge.example' }, './cloud-onboarding-service.mjs': { CLOUD_TOOL_CONTRACTS, createHostedCloudOnboarding } });
  assert.deepEqual(await helper.cloudRequestBody(new Request('https://learnbridge.example', { method: 'POST', body: '{"query":"course"}' }), 100), { query: 'course' });
  await assert.rejects(helper.cloudRequestBody(new Request('https://learnbridge.example', { method: 'POST', body: 'x'.repeat(101) }), 100), error => error.status === 413);
  await assert.rejects(helper.cloudRequestBody(new Request('https://learnbridge.example', { method: 'POST', body: 'not-json' }), 100), error => error.status === 400);
  assert.equal(helper.cloudOperationError(new Error('SYNTHETIC_PRIVATE_TOKEN')).message.includes('SYNTHETIC_PRIVATE_TOKEN'), false);
});
test('CHOST11: owner identity is rechecked after reading the request body and before returning fetched content', async () => {
  for (const changedAt of [2, 3]) {
    let authCalls = 0, factories = 0, executes = 0;
    const route = loaded('../apps/web/src/app/api/cloud-onboarding/[action]/route.ts', {
      'next/server': { NextResponse: { json: (body, options) => ({ body, ...options }) } }, '@/lib/server/auth': { AppError, requireUser: async () => ({ db: {}, user: { id: ++authCalls >= changedAt ? BOB : ALICE } }), useQuota: async () => {} },
      '@/lib/server/access': { sameOrigin: () => null, failure: error => ({ status: error.status || 502 }) },
      '@/lib/server/cloud-onboarding': { cloudOperationError: error => error, cloudRequestBody: async () => ({ ...choice, query: 'course' }), hostedCloudOnboarding: owner => { factories++; assert.equal(owner, ALICE); return { search: async () => { executes++; return { private_text: 'NEVER_RETURNED_TO_CHANGED_OWNER' }; } }; } },
    });
    const request = { nextUrl: new URL('https://learnbridge.example/api/cloud-onboarding/search'), signal: new AbortController().signal }, result = await route.POST(request, { params: Promise.resolve({ action: 'search' }) });
    assert.equal(result.status, 403); assert.equal(JSON.stringify(result).includes('NEVER_RETURNED_TO_CHANGED_OWNER'), false); assert.equal(factories, changedAt === 2 ? 0 : 1); assert.equal(executes, changedAt === 2 ? 0 : 1);
  }
});
test('CHOST12: missing existing server connection credentials fails closed before constructing the SDK or calling a provider', t => {
  const original = process.env.COMPOSIO_API_KEY; delete process.env.COMPOSIO_API_KEY; t.after(() => { if (original === undefined) delete process.env.COMPOSIO_API_KEY; else process.env.COMPOSIO_API_KEY = original; });
  let constructed = 0; const helper = loaded('../apps/web/src/lib/server/cloud-onboarding.ts', { '@composio/core': { Composio: class { constructor() { constructed++; } } }, './auth': { AppError, appOrigin: () => 'https://learnbridge.example' }, './cloud-onboarding-service.mjs': { CLOUD_TOOL_CONTRACTS, createHostedCloudOnboarding } });
  assert.throws(() => helper.hostedCloudOnboarding(ALICE), error => error.status === 503); assert.equal(constructed, 0);
});
test('CHOST13: selected texts whose serialized body fits but final hash pushes the transfer over budget never return an export-ready preview', async () => {
  const f = fixture(); f.mode('escaped_boundary'); const rows = await f.service.search({ ...choice, query: 'boundary' });
  const input = { ...choice, selection_tokens: rows.items.map(row => row.selection_token), academic_policy: 'learning_support' }, baseline = await f.service.preview(input);
  const { bundle_hash, ...body } = baseline.bundle; f.textCount(Math.floor((90000 - Buffer.byteLength(JSON.stringify(body))) / 6));
  await denies(f.service.preview(input), 'BUDGET_EXCEEDED');
});

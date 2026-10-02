import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

function callback(exchange) {
  const source = readFileSync(new URL('../apps/web/src/app/auth/callback/route.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
  const module = {exports: {}};
  const stubs = {
    'next/server': {NextResponse: {redirect: (url, options) => ({url, ...options})}},
    '@/lib/server/auth': {appOrigin: () => 'https://learnbridge.example', authClient: async () => ({auth: {exchangeCodeForSession: exchange}})},
  };
  new Function('require', 'module', 'exports', code)(id => {
    if (!(id in stubs)) throw Error(`Unexpected module: ${id}`);
    return stubs[id];
  }, module, module.exports);
  return module.exports.GET;
}

test('OAuth callback rejects missing codes and ignores untrusted return destinations', async () => {
  const get = callback(() => {throw Error('Must not exchange without a code');});
  const result = await get({nextUrl: new URL('https://host.invalid/auth/callback?next=https://attacker.invalid')});
  assert.equal(result.url, 'https://learnbridge.example/login?auth_error=1');
  assert.equal(result.headers['Cache-Control'], 'private, no-store');
});

test('OAuth callback exchanges the code with its flow ID and uses the configured origin', async () => {
  let received;
  const get = callback(async (...args) => {received = args; return {error: null};});
  const result = await get({nextUrl: new URL('https://host.invalid/auth/callback?code=synthetic&sb_flow_id=flow&next=//attacker.invalid')});
  assert.deepEqual(received, ['synthetic', {flowId: 'flow'}]);
  assert.equal(result.url, 'https://learnbridge.example/');
});

test('OAuth exchange failures do not expose provider errors or authorization codes', async () => {
  const get = callback(async () => {throw Error('private-token-value');});
  const result = await get({nextUrl: new URL('https://host.invalid/auth/callback?code=private-code')});
  assert.equal(result.url, 'https://learnbridge.example/login?auth_error=1');
  assert(!JSON.stringify(result).includes('private-token-value'));
  assert(!JSON.stringify(result).includes('private-code'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const modules = new Map();
function loadSetup(name) {
  if (modules.has(name)) return modules.get(name);
  const source = readFileSync(new URL(`../apps/web/src/app/setup/${name}`, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
  } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)((id) => {
    if (id === './setup-content') return loadSetup('setup-content.ts');
    if (id === './copy-prompt') return loadSetup('copy-prompt.ts');
    if (id === './SetupPrompt') return loadSetup('SetupPrompt.tsx');
    if (id === './SetupMeasurement') return loadSetup('SetupMeasurement.tsx');
    if (id === './AccountMeasurement') return loadSetup('AccountMeasurement.tsx');
    if (id === '@/lib/adoption/client.mjs') return require('../apps/web/src/lib/adoption/client.mjs');
    if (id === '@/lib/adoption/policy.mjs') return require('../apps/web/src/lib/adoption/policy.mjs');
    return require(id);
  }, module, module.exports);
  modules.set(name, module.exports);
  return module.exports;
}
const content = loadSetup('setup-content.ts');
const { copyPrompt } = loadSetup('copy-prompt.ts');
const events = loadSetup('setup-events.ts');

test('public setup renders usable choices and exact versioned prompt without an account', () => {
  const page = loadSetup('page.tsx').default;
  const markup = renderToStaticMarkup(page());
  assert.match(markup, /Online edition/);
  assert.match(markup, /Local edition/);
  assert.match(markup, /Copy setup prompt/);
  assert.match(markup, /Select prompt manually/);
  assert.match(markup, /readonly=""/);
  assert.match(markup, /local-setup-1-2026-10-03/);
  assert.match(markup, /Setup measurement is currently off/);
  assert.match(markup, /Windows local storage is not supported/);
  assert.match(markup, /npm run local:start/);
  assert.match(markup, /https:\/\/github.com\/SachinVedGupta\/LearnBridge/);
  assert.doesNotMatch(markup, /Sign out|api_key|sk-proj-|127\.0\.0\.1:\d+\/.*pair/);
});

test('setup prompt preserves files, scopes, official host approvals and objective verification', () => {
  const prompt = content.SETUP_PROMPT;
  for (const expected of ['AGENTS.md', 'SETUP_LEARNBRIDGE.md', 'npm run test:local',
    'restart persistence', 'fresh private workspace', 'expected input hash',
    'Local imports are separate from cloud-model processing consent',
    'pending task proposal', 'Do not enroll analytics or remote access by default']) {
    assert.ok(prompt.includes(expected), `Missing setup instruction: ${expected}`);
  }
  assert.doesNotMatch(prompt, /\/Users\/|@gmail\.com|[?&](?:token|code|state)=|sk-proj-/);
});

test('clipboard confirmation gates success; unresolved and rejected promises never observe a successful copy', async () => {
  let resolveCopy;
  const received = [];
  const successes = [];
  const pending = copyPrompt(content.SETUP_PROMPT, {
    writeText(text) { received.push(text); return new Promise(resolve => { resolveCopy = resolve; }); },
  }, () => successes.push('observed'));
  await Promise.resolve();
  assert.deepEqual(received, [content.SETUP_PROMPT]);
  assert.equal(successes.length, 0);
  resolveCopy();
  assert.equal(await pending, 'copied');
  assert.deepEqual(successes, ['observed']);

  const denied = await copyPrompt(content.SETUP_PROMPT, {
    writeText: async () => { throw new Error('browser denied clipboard'); },
  }, () => successes.push('denied'));
  assert.equal(denied, 'failed');
  assert.deepEqual(successes, ['observed']);
});

test('unavailable clipboard and synchronous failures preserve manual-copy fallback without observations', async () => {
  let observed = 0;
  assert.equal(await copyPrompt(content.SETUP_PROMPT, undefined, () => observed++), 'failed');
  assert.equal(await copyPrompt(content.SETUP_PROMPT, {
    writeText: () => { throw new Error('unsupported policy'); },
  }, () => observed++), 'failed');
  assert.equal(observed, 0);
});

test('two completed copies are distinct observations and optional collector failure does not break copy', async () => {
  let count = 0;
  const clipboard = { writeText: async () => {} };
  assert.equal(await copyPrompt(content.SETUP_PROMPT, clipboard, () => count++), 'copied');
  assert.equal(await copyPrompt(content.SETUP_PROMPT, clipboard, () => count++), 'copied');
  assert.equal(count, 2);
  assert.equal(await copyPrompt(content.SETUP_PROMPT, clipboard, () => { throw new Error('collector offline'); }), 'copied');
  assert.equal(await copyPrompt(content.SETUP_PROMPT, clipboard, async () => { throw new Error('async collector offline'); }), 'copied');
});

const validEvent = {
  schema_version: 1,
  event_id: '1713c683-85b3-4c57-b8f4-eaf3c0662d72',
  event_name: 'setup_prompt_copy_succeeded',
  route: '/setup',
  prompt_version: content.SETUP_PROMPT_VERSION,
};

test('future event schema accepts only constant route/version, event names and random per-event identity', () => {
  const parsed = events.parseSetupEvent(JSON.stringify(validEvent));
  assert.deepEqual(parsed, validEvent);
  for (const change of [
    { route: '/workspace' }, { route: '/setup?email=private@example.invalid' },
    { prompt_version: 'unreviewed' }, { event_name: 'install_completed' },
    { event_id: 'user@example.invalid' }, { schema_version: 2 },
    { account_id: 'forged-admin' }, { email: 'private@example.invalid' },
    { prompt: 'private text' }, { url: 'https://host.invalid/setup?token=canary' },
    { referrer: '/Users/private/coursework' }, { timestamp: Date.now() },
  ]) {
    assert.throws(() => events.parseSetupEvent(JSON.stringify({ ...validEvent, ...change })),
      error => error.code === 'INVALID_EVENT');
  }
  for (const body of ['null', '[]', '{', '{}']) {
    assert.throws(() => events.parseSetupEvent(body), error => error.code === 'INVALID_EVENT');
  }
});

test('event schema bounds UTF-8 bytes and exposes only redacted error codes', () => {
  assert.throws(() => events.parseSetupEvent(JSON.stringify({ ...validEvent, prompt: '🔒'.repeat(1024) })),
    error => error.code === 'EVENT_TOO_LARGE' && error.message === 'EVENT_TOO_LARGE');
  assert.throws(() => events.parseSetupEvent('PRIVATE_EMAIL_CANARY'),
    error => error.message === 'INVALID_EVENT' && !error.message.includes('CANARY'));
});

test('setup route stays public without enabling an event network sender or local enrollment', () => {
  const proxy = readFileSync(new URL('../apps/web/src/proxy.ts', import.meta.url), 'utf8');
  const setupUI = readFileSync(new URL('../apps/web/src/app/setup/SetupPrompt.tsx', import.meta.url), 'utf8');
  const setupPage = readFileSync(new URL('../apps/web/src/app/setup/page.tsx', import.meta.url), 'utf8');
  const accountNav = readFileSync(new URL('../apps/web/src/components/AccountNav.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(proxy, /matcher:[\s\S]*['"]\/setup/);
  assert.match(accountNav, /'\/setup'/);
  assert.doesNotMatch(`${setupUI}\n${setupPage}`, /fetch\(|sendBeacon\(|localStorage|sessionStorage|requireUser|createServerClient/);
});

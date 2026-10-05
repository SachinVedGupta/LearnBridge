import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLeetCodeBrowser, LEETCODE_BROWSER_BINARY, LEETCODE_LOGIN_URL } from '../apps/local-runtime/src/leetcode-browser.mjs';

const fixture = fileURLToPath(new URL('./fixtures/leetcode-browser-fixture.mjs', import.meta.url)), secret = 'SYNTHETIC_OWNED_LEETCODE_COOKIE_CANARY.v1', temporary = tmpdir();
const isCode = code => error => error.code === code && !error.message.includes(secret) && !error.message.includes('user-data-dir');
function root(t) { const parent = mkdtempSync(join(temporary, 'learnbridge-leetcode-browser-test-')); chmodSync(parent, 0o700); const workspace = join(parent, 'workspace'); mkdirSync(workspace, { mode: 0o700 }); writeFileSync(join(workspace, '.learnbridge-local-root'), 'learnbridge-local-data-v1\n', { mode: 0o600 }); t.after(() => rmSync(parent, { recursive: true, force: true })); return { parent, workspace, profile: join(parent, 'workspace-leetcode-browser') }; }
function browser(t, mode = 'normal', options = {}) {
  const paths = options.paths || root(t), launches = [], commands = []; let child;
  const value = createLeetCodeBrowser({ workspaceRoot: paths.workspace, ...options, factory(binary, args, config) {
    launches.push({ binary, args, config }); child = spawn(process.execPath, [fixture, mode], config);
    const write = child.stdio[3].write.bind(child.stdio[3]); child.stdio[3].write = bytes => { commands.push(JSON.parse(bytes.slice(0, -1))); return write(bytes); }; return child;
  } });
  // Registered after root cleanup, Node runs after hooks in registration order.
  // Individual cases close before cleanup; the fallback handles early failures.
  t.after(async () => { try { await value.close(); } catch {} });
  return { paths, value, launches, commands, get child() { return child; } };
}
test('owned Chrome pipe opens normal sign-in and scopes cookie reads to one fixed domain without credential automation', async t => {
  const h = browser(t); const start = await h.value.start(); assert.equal(start.state, 'awaiting_sign_in');
  assert.equal(h.launches[0].binary, LEETCODE_BROWSER_BINARY); assert.equal(h.launches[0].config.detached, true);
  assert.ok(h.launches[0].args.includes('--remote-debugging-pipe')); assert.equal(h.launches[0].args.some(value => /remote-debugging-port|no-sandbox|disable-web-security|headless|load-extension/.test(value)), false);
  assert.equal(h.commands.find(command => command.method === 'Page.navigate').params.url, LEETCODE_LOGIN_URL);
  assert.equal(h.commands.find(command => command.method === 'Browser.setDownloadBehavior').params.behavior, 'deny');
  assert.equal(lstatSync(h.paths.profile).mode & 0o077, 0); assert.equal(lstatSync(join(h.paths.profile, '.learnbridge-leetcode-profile')).mode & 0o077, 0);
  assert.equal(await h.value.session(), secret); assert.deepEqual(h.commands.find(command => command.method === 'Network.getCookies').params, { urls: ['https://leetcode.com/'] });
  assert.equal(h.commands.filter(command => command.method === 'Runtime.evaluate').length, 2);
  assert.equal(h.commands.some(command => /Input\.|setCookie|clearCookie|DOM\.|Runtime.callFunctionOn/.test(command.method)), false);
  assert.equal(JSON.stringify({ start, status: h.value.status(), capability: h.value.capability(), commands: h.commands }).includes(secret), false);
  await h.value.close(); assert.equal(existsSync(h.paths.profile), true); assert.equal(existsSync(join(h.paths.profile, '.learnbridge-browser-owner')), false); assert.equal(h.child.exitCode === null && h.child.signalCode === null, false);
});
test('dedicated profile persists across separate adapter instances and explicit forget removes only its owned marked directory', async t => {
  const paths = root(t), h = browser(t, 'normal', { paths }); await h.value.start(); await h.value.session(); writeFileSync(join(paths.profile, 'synthetic-chrome-managed-cookie-file'), 'synthetic Chrome fixture state', { mode: 0o600 }); await h.value.close();
  const second = browser(t, 'normal', { paths }); await second.value.start(); assert.equal(readFileSync(join(paths.profile, 'synthetic-chrome-managed-cookie-file'), 'utf8'), 'synthetic Chrome fixture state'); await second.value.close({ forget: true });
  assert.equal(existsSync(paths.profile), false); assert.equal(existsSync(paths.workspace), true); assert.equal(second.value.status().state, 'forgotten');
});
test('profile is outside the workspace and no arbitrary host environment or repository TMPDIR is inherited', async t => {
  const prior = process.env.LEARNBRIDGE_TEST_SECRET_CANARY, priorTemp = process.env.TMPDIR;
  process.env.LEARNBRIDGE_TEST_SECRET_CANARY = 'synthetic-host-only-secret'; process.env.TMPDIR = '/synthetic/repository';
  t.after(() => { if (prior === undefined) delete process.env.LEARNBRIDGE_TEST_SECRET_CANARY; else process.env.LEARNBRIDGE_TEST_SECRET_CANARY = prior; if (priorTemp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = priorTemp; });
  const h = browser(t); await h.value.start(); await h.value.session();
  assert.equal(h.launches[0].config.env.LEARNBRIDGE_TEST_SECRET_CANARY, undefined); assert.equal(h.launches[0].config.env.OPENAI_API_KEY, undefined); assert.equal(h.launches[0].config.env.NODE_OPTIONS, undefined);
  assert.equal(h.launches[0].config.env.TMPDIR, process.platform === 'darwin' ? '/private/tmp' : '/tmp'); assert.equal(h.paths.profile.startsWith(h.paths.workspace + '/'), false);
  assert.deepEqual(readdirSync(h.paths.workspace), ['.learnbridge-local-root']); await h.value.close();
});
for (const mode of ['signed_out', 'foreign_origin', 'lookalike_origin', 'insecure_origin', 'userinfo_origin', 'security_path', 'loading']) test(`${mode} cannot extract a session cookie`, async t => {
  const h = browser(t, mode); await h.value.start(); await assert.rejects(h.value.session(), isCode('AUTH_REQUIRED')); assert.equal(h.commands.some(command => command.method === 'Network.getCookies'), false); await h.value.close();
});
for (const mode of ['blocked', 'body_blocked', 'captcha_element']) test(`${mode} stops without cookie extraction or any alternate endpoint`, async t => {
  const h = browser(t, mode); await h.value.start(); await assert.rejects(h.value.session(), isCode('SCOPE_DENIED')); assert.equal(h.value.status().state, 'blocked'); assert.equal(h.commands.some(command => command.method === 'Network.getCookies'), false); await h.value.close();
});
for (const [mode, code] of [['missing_cookie', 'AUTH_REQUIRED'], ['duplicate_cookie', 'AUTH_REQUIRED'], ['bad_domain', 'SCOPE_DENIED'], ['bad_path', 'SCOPE_DENIED'], ['insecure_cookie', 'SCOPE_DENIED'], ['readable_cookie', 'SCOPE_DENIED'], ['partitioned_cookie', 'SCOPE_DENIED'], ['expired', 'AUTH_EXPIRED'], ['oversized_cookie', 'INVALID_INPUT'], ['newline_cookie', 'INVALID_INPUT'], ['short_cookie', 'AUTH_REQUIRED']]) test(`${mode} cookie is rejected without returning credentials`, async t => {
  const h = browser(t, mode); await h.value.start(); await assert.rejects(h.value.session(), isCode(code)); assert.equal(JSON.stringify(h.value.status()).includes(secret), false); await h.value.close();
});
for (const mode of ['navigate_in_flight', 'logout_in_flight', 'same_document_in_flight']) test(`${mode} invalidates an in-flight cookie read`, async t => {
  const h = browser(t, mode); await h.value.start(); await assert.rejects(h.value.session(), isCode('AUTH_REQUIRED')); await h.value.close();
});
for (const mode of ['subframe_event', 'foreign_session_event']) test(`${mode} cannot alter the owned top-frame authorization epoch`, async t => {
  const h = browser(t, mode); await h.value.start(); assert.equal(await h.value.session(), secret); await h.value.close();
});
test('bounded timeout and cancellation stop the child while retaining Chrome-managed sign-in', async t => {
  const timed = browser(t, 'slow', { timeoutMs: 100 }); await timed.value.start(); await assert.rejects(timed.value.session(), isCode('TIMEOUT')); await timed.value.close(); assert.equal(existsSync(timed.paths.profile), true);
  const cancelled = browser(t, 'slow'); await cancelled.value.start(); const controller = new AbortController(), pending = cancelled.value.session({ signal: controller.signal }); setTimeout(() => controller.abort(), 10); await assert.rejects(pending, isCode('CANCELLED')); await cancelled.value.close(); assert.equal(existsSync(cancelled.paths.profile), true);
});
test('malformed and oversized pipe frames fail closed without deleting remembered profile', async t => {
  const malformed = browser(t, 'malformed'); await assert.rejects(malformed.value.start(), isCode('PROVIDER_FAILURE')); assert.equal(existsSync(malformed.paths.profile), true);
  const huge = browser(t, 'oversized_frame'); await huge.value.start(); await assert.rejects(huge.value.session(), isCode('BUDGET_EXCEEDED')); await huge.value.close(); assert.equal(existsSync(huge.paths.profile), true);
});
test('symlinked/unmarked/workspace-in-Git roots and existing permissive/unmarked profiles are refused', async t => {
  const paths = root(t), linked = join(paths.parent, 'linked'); symlinkSync(paths.workspace, linked);
  assert.throws(() => createLeetCodeBrowser({ workspaceRoot: linked }), isCode('SCOPE_DENIED'));
  const unmarked = join(paths.parent, 'unmarked'); mkdirSync(unmarked, { mode: 0o700 }); assert.throws(() => createLeetCodeBrowser({ workspaceRoot: unmarked }), isCode('SCOPE_DENIED'));
  writeFileSync(join(paths.parent, '.git'), 'gitdir: synthetic'); assert.throws(() => createLeetCodeBrowser({ workspaceRoot: paths.workspace }), isCode('SCOPE_DENIED')); rmSync(join(paths.parent, '.git'));
  mkdirSync(paths.profile, { mode: 0o755 }); const h = browser(t, 'normal', { paths }); await assert.rejects(h.value.start(), isCode('SCOPE_DENIED')); assert.equal(h.launches.length, 0);
  chmodSync(paths.profile, 0o700); const second = browser(t, 'normal', { paths }); await assert.rejects(second.value.start(), isCode('SCOPE_DENIED')); assert.equal(second.launches.length, 0); assert.equal(existsSync(paths.profile), true);
});
test('an unmarked or symlink-swapped profile cannot be forgotten, and another active adapter owns its lease', async t => {
  const paths = root(t), first = browser(t, 'normal', { paths }); await first.value.start(); const second = browser(t, 'normal', { paths }); await assert.rejects(second.value.start(), isCode('SCOPE_DENIED')); await assert.rejects(second.value.close({ forget: true }), isCode('SCOPE_DENIED')); assert.equal(await first.value.session(), secret); await first.value.close();
  rmSync(join(paths.profile, '.learnbridge-leetcode-profile')); const unmarked = browser(t, 'normal', { paths }); await assert.rejects(unmarked.value.close({ forget: true }), isCode('SCOPE_DENIED')); assert.equal(existsSync(paths.profile), true);
  rmSync(paths.profile, { recursive: true }); const other = join(paths.parent, 'unrelated'); mkdirSync(other, { mode: 0o700 }); writeFileSync(join(other, 'keep'), 'keep'); symlinkSync(other, paths.profile);
  const swapped = browser(t, 'normal', { paths }); await assert.rejects(swapped.value.close({ forget: true }), isCode('SCOPE_DENIED')); assert.equal(readFileSync(join(other, 'keep'), 'utf8'), 'keep');
});

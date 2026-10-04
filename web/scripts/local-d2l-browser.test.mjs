import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createD2lBrowser, D2L_BROWSER_BINARY, D2L_INSTITUTION } from '../apps/local-runtime/src/d2l-browser.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/d2l-browser-fixture.mjs', import.meta.url));
const isCode = code => error => error.code === code && !error.message.includes('SYNTHETIC_SECRET_DIAGNOSTIC_CANARY');
function browser(t, mode = 'normal', options = {}) {
  const launches = [], commands = []; let profile, child;
  const value = createD2lBrowser({ ...options, factory(binary, args, config) {
    launches.push({ binary, args, config }); profile = args.find(value => value.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
    child = spawn(process.execPath, [fixturePath, mode], config); const write = child.stdio[3].write.bind(child.stdio[3]);
    child.stdio[3].write = data => { commands.push(JSON.parse(data.slice(0, -1))); return write(data); }; return child;
  } });
  t.after(() => value.close());
  return { value, launches, commands, get profile() { return profile; }, get child() { return child; } };
}

test('D2LB01: an actual private child pipe executes the fixed same-origin browser GET without copied credentials or a debugging port', async t => {
  const prior = process.env.LEARNBRIDGE_TEST_SECRET_CANARY; process.env.LEARNBRIDGE_TEST_SECRET_CANARY = 'SYNTHETIC_PRIVATE_ENV';
  const priorTemporary = process.env.TMPDIR; process.env.TMPDIR = '/synthetic/REPOSITORY_TMPDIR_CANARY';
  t.after(() => prior === undefined ? delete process.env.LEARNBRIDGE_TEST_SECRET_CANARY : process.env.LEARNBRIDGE_TEST_SECRET_CANARY = prior);
  t.after(() => priorTemporary === undefined ? delete process.env.TMPDIR : process.env.TMPDIR = priorTemporary);
  const h = browser(t); await h.value.start();
  assert.equal(h.launches[0].binary, D2L_BROWSER_BINARY); assert.equal(h.launches[0].config.detached, true);
  assert.equal(h.launches[0].config.env.LEARNBRIDGE_TEST_SECRET_CANARY, undefined); assert.equal(h.launches[0].config.env.NODE_OPTIONS, undefined);
  assert.ok(h.launches[0].args.includes('--remote-debugging-pipe')); assert.equal(h.launches[0].args.some(value => /remote-debugging-port|--no-sandbox|--disable-web-security|--load-extension/.test(value)), false);
  assert.equal(lstatSync(h.profile).mode & 0o077, 0); assert.equal(h.commands[0].params.url, D2L_INSTITUTION.login_url);
  assert.ok(h.profile.startsWith(process.platform === 'darwin' ? '/private/tmp/learnbridge-d2l-browser-' : '/tmp/learnbridge-d2l-browser-'));
  const who = await h.value.readJson('/d2l/api/lp/1.49/users/whoami'); assert.equal(who.Identifier, '12345'); assert.equal(who.EnvLeaked, false);
  assert.deepEqual(h.commands.map(value => value.method), ['Target.createTarget', 'Target.attachToTarget', 'Runtime.evaluate']);
  assert.equal(h.value.proof, 'fixture'); assert.equal(h.value.capability().proof, 'none');
  const expression = h.commands.at(-1).params.expression; assert.equal(/document.cookie|localStorage|Authorization|oauth2\/token|Network\./.test(expression), false);
  await h.value.close(); assert.equal(existsSync(h.profile), false); assert.equal(h.child.exitCode === null && h.child.signalCode === null, false);
});

test('D2LB02: arbitrary URL, path, query, global discovery, grades, submissions and writes are refused before the child sees a read', async t => {
  const h = browser(t); await h.value.start(); const before = h.commands.length;
  for (const path of ['https://outside.example/d2l/api/versions/', '//outside.example/x', '/d2l/api/versions/?token=bad',
    '/d2l/api/lp/1.49/enrollments/myenrollments/', '/d2l/api/le/1.85/781264/grades/', '/d2l/api/le/1.85/781264/dropbox/folders/17/submissions/',
    '/d2l/api/lp/1.49/users/12345', '/d2l/lp/auth/oauth2/token', '/d2l/api/le/1.85/../../news/']) {
    await assert.rejects(h.value.readJson(path), isCode('SCOPE_DENIED'));
  }
  assert.equal(h.commands.length, before);
});

for (const [mode, code] of [['signed_out', 'AUTH_REQUIRED'], ['denied', 'SCOPE_DENIED'], ['expired', 'AUTH_EXPIRED'], ['html', 'AUTH_REQUIRED'],
  ['redirect', 'SCOPE_DENIED'], ['oversized', 'BUDGET_EXCEEDED'], ['invalid_json', 'PROVIDER_FAILURE']]) {
  test(`D2LB03-${mode}: in-page ${mode} response is denied without returning provider body or credentials`, async t => {
    const h = browser(t, mode); await h.value.start(); await assert.rejects(h.value.readJson('/d2l/api/lp/1.49/users/whoami'), isCode(code));
  });
}

test('D2LB04: a bounded command timeout terminates its owned child and erases its temporary browser profile', async t => {
  const h = browser(t, 'slow', { timeoutMs: 150 }); await h.value.start();
  await assert.rejects(h.value.readJson('/d2l/api/lp/1.49/users/whoami'), isCode('TIMEOUT')); await h.value.close();
  assert.equal(existsSync(h.profile), false); await assert.rejects(h.value.readJson('/d2l/api/lp/1.49/users/whoami'), isCode('AUTH_REQUIRED'));
});

test('D2LB05: cancellation discards an in-flight read and closes only the owned child/profile', async t => {
  const h = browser(t, 'slow'); await h.value.start(); const controller = new AbortController();
  const pending = h.value.readJson('/d2l/api/lp/1.49/users/whoami', { signal: controller.signal }); controller.abort();
  await assert.rejects(pending, isCode('CANCELLED')); await h.value.close(); assert.equal(existsSync(h.profile), false);
});

test('D2LB06: malformed CDP framing fails closed and cleans the owned profile', async t => {
  const h = browser(t, 'malformed'); await assert.rejects(h.value.start(), isCode('PROVIDER_FAILURE'));
  assert.equal(existsSync(h.profile), false);
});

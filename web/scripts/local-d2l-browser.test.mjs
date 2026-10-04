import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createD2lBrowser, D2L_BROWSER_BINARY, D2L_INSTITUTION } from '../apps/local-runtime/src/d2l-browser.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/d2l-browser-fixture.mjs', import.meta.url));
const bearer = 'SYNTHETIC_D2L_BEARER_CANARY.v1', rotatedBearer = 'SYNTHETIC_D2L_BEARER_CANARY.v2';
const isCode = code => error => error.code === code && !/SYNTHETIC_SECRET_DIAGNOSTIC_CANARY|SYNTHETIC_D2L_BEARER_CANARY/.test(JSON.stringify({ message: error.message, code: error.code, details: error.details }));
function browser(t, mode = 'normal', options = {}) {
  const launches = [], commands = [], events = []; let profile, child, incoming = Buffer.alloc(0), waiting = [];
  const value = createD2lBrowser({ ...options, factory(binary, args, config) {
    launches.push({ binary, args, config }); profile = args.find(value => value.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
    child = spawn(process.execPath, [fixturePath, mode], config);
    child.stdio[4].on('data', chunk => {
      incoming = Buffer.concat([incoming, chunk]);
      while (incoming.includes(0)) {
        const end = incoming.indexOf(0), frame = incoming.subarray(0, end); incoming = incoming.subarray(end + 1);
        let item; try { item = JSON.parse(frame.toString('utf8')); } catch { continue; }
        if (item.method) events.push(item);
        for (const item of [...waiting]) if (events.some(item.matches)) { waiting = waiting.filter(value => value !== item); clearTimeout(item.timer); item.resolve(); }
      }
    });
    const write = child.stdio[3].write.bind(child.stdio[3]);
    child.stdio[3].write = data => { commands.push(JSON.parse(data.slice(0, -1))); return write(data); }; return child;
  } });
  t.after(() => value.close());
  return { value, launches, commands, events,
    waitEvent(matches) { if (events.some(matches)) return Promise.resolve(); return new Promise((resolve, reject) => {
      const item = { matches, resolve, timer: setTimeout(() => { waiting = waiting.filter(value => value !== item); reject(new Error('Expected synthetic browser event did not arrive')); }, 1000) }; waiting.push(item);
    }); },
    get profile() { return profile; }, get child() { return child; } };
}

test('D2LB01: an actual private child observes school browser authorization and executes the shipped bearer GET without passwords, cookies or a debugging port', async t => {
  const prior = process.env.LEARNBRIDGE_TEST_SECRET_CANARY; process.env.LEARNBRIDGE_TEST_SECRET_CANARY = 'SYNTHETIC_PRIVATE_ENV';
  const priorTemporary = process.env.TMPDIR; process.env.TMPDIR = '/synthetic/REPOSITORY_TMPDIR_CANARY';
  t.after(() => prior === undefined ? delete process.env.LEARNBRIDGE_TEST_SECRET_CANARY : process.env.LEARNBRIDGE_TEST_SECRET_CANARY = prior);
  t.after(() => priorTemporary === undefined ? delete process.env.TMPDIR : process.env.TMPDIR = priorTemporary);
  const h = browser(t); await h.value.start();
  assert.equal(h.launches[0].binary, D2L_BROWSER_BINARY); assert.equal(h.launches[0].config.detached, true);
  assert.equal(h.launches[0].config.env.LEARNBRIDGE_TEST_SECRET_CANARY, undefined); assert.equal(h.launches[0].config.env.NODE_OPTIONS, undefined);
  assert.ok(h.launches[0].args.includes('--remote-debugging-pipe')); assert.equal(h.launches[0].args.some(value => /remote-debugging-port|--no-sandbox|--disable-web-security|--load-extension/.test(value)), false);
  assert.equal(lstatSync(h.profile).mode & 0o077, 0); assert.equal(h.commands[0].params.url, 'about:blank');
  assert.equal(h.commands[4].params.url, D2L_INSTITUTION.login_url);
  assert.deepEqual(h.commands[2].params, { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 });
  assert.ok(h.profile.startsWith(process.platform === 'darwin' ? '/private/tmp/learnbridge-d2l-browser-' : '/tmp/learnbridge-d2l-browser-'));
  const who = await h.value.readJson('/d2l/api/lp/1.49/users/whoami'); assert.equal(who.Identifier, '12345'); assert.equal(who.EnvLeaked, false);
  assert.deepEqual(h.commands.map(value => value.method), ['Target.createTarget', 'Target.attachToTarget', 'Network.enable', 'Page.enable', 'Page.navigate', 'Runtime.evaluate']);
  assert.equal(h.commands.slice(2).every(value => value.sessionId === 'synthetic-cdp-session'), true);
  assert.equal(h.value.proof, 'fixture'); assert.equal(h.value.capability().proof, 'none');
  const expression = h.commands.at(-1).params.expression;
  assert.equal(/document.cookie|localStorage|oauth2\/token|Network\.|sessionStorage/.test(expression), false);
  assert.match(expression, /credentials: 'omit'/); assert.match(expression, /Authorization: 'Bearer '/); assert.ok(expression.includes(bearer));
  assert.equal(JSON.stringify({ who, capability: h.value.capability(), start: await h.value.readJson('/d2l/api/versions/') }).includes(bearer), false);
  assert.equal(h.commands.at(-1).params.expression.includes(bearer), false);
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

for (const [label, modes] of [['native_methods', ['lowercase_header', 'head_request', 'post_request', 'put_request', 'patch_request', 'delete_request', 'options_request']],
  ['extra_before', ['extra_before']], ['extra_after', ['extra_after']]]) {
  test(`D2LB07-${label}: passive browser ${label} bearer observations authorize only the shipped read-only GET`, async t => {
    for (const mode of modes) {
      const h = browser(t, mode); await h.value.start();
      const who = await h.value.readJson('/d2l/api/lp/1.49/users/whoami'); assert.equal(who.Identifier, '12345');
      assert.ok(h.commands.at(-1).params.expression.includes(bearer)); assert.equal(JSON.stringify(who).includes(bearer), false);
      await h.value.close();
    }
  });
}

for (const mode of ['missing_token', 'foreign_origin', 'redirected_foreign', 'lookalike_origin', 'insecure_origin', 'foreign_document', 'login_document', 'wrong_session', 'wrong_frame', 'wrong_loader',
  'invalid_method', 'non_api_request', 'blank_token', 'invalid_token', 'newline_token', 'oversized_token', 'duplicate_headers',
  'extra_unknown', 'extra_wrong_session', 'extra_foreign_origin', 'extra_duplicate_headers', 'extra_evicted', 'extra_before_navigation', 'extra_invalid_after_valid']) {
  test(`D2LB08-${mode}: ${mode} cannot authorize a protected API even when anonymous versions succeed`, async t => {
    const h = browser(t, mode); const opened = await h.value.start(); assert.equal(opened.proof, 'none');
    assert.equal((await h.value.readJson('/d2l/api/versions/')).length, 2);
    assert.equal(h.commands.at(-1).params.expression.includes(bearer), false);
    await assert.rejects(h.value.readJson('/d2l/api/lp/1.49/users/whoami'), isCode('AUTH_REQUIRED'));
    assert.equal(h.commands.at(-1).params.expression.includes(bearer), false); assert.equal(h.value.capability().proof, 'none');
  });
}

test('D2LB09: a 401 clears browser authorization; subsequent protected reads cannot reuse the stale token', async t => {
  const h = browser(t, 'expired'); await h.value.start();
  await assert.rejects(h.value.readJson('/d2l/api/lp/1.49/users/whoami'), isCode('AUTH_EXPIRED'));
  assert.ok(h.commands.at(-1).params.expression.includes(bearer));
  await assert.rejects(h.value.readJson('/d2l/api/lp/1.49/users/whoami'), isCode('AUTH_REQUIRED'));
  assert.equal(h.commands.at(-1).params.expression.includes(bearer), false);
});

for (const mode of ['navigate_after_read', 'logout_after_read', 'late_old_loader']) {
  test(`D2LB10-${mode}: top-frame ${mode} discards an in-flight identity and revokes the old bearer`, async t => {
    const h = browser(t, mode); await h.value.start();
    await assert.rejects(h.value.readJson('/d2l/api/lp/1.49/users/whoami'), isCode('AUTH_REQUIRED'));
    await assert.rejects(h.value.readJson('/d2l/api/lp/1.49/users/whoami'), isCode('AUTH_REQUIRED'));
    assert.equal(h.commands.at(-1).params.expression.includes(bearer), false);
  });
}

test('D2LB11: a fresh observed bearer discards the old in-flight identity and is the only credential used by the next read', async t => {
  const h = browser(t, 'rotate_token'); await h.value.start();
  await assert.rejects(h.value.readJson('/d2l/api/lp/1.49/users/whoami'), isCode('AUTH_REQUIRED'));
  assert.equal((await h.value.readJson('/d2l/api/lp/1.49/users/whoami')).Identifier, '12345');
  const expression = h.commands.at(-1).params.expression; assert.ok(expression.includes(rotatedBearer)); assert.equal(expression.includes(bearer), false);
});

for (const mode of ['subframe_after_read', 'foreign_navigation_after_read', 'same_token_during_read']) {
  test(`D2LB14-${mode}: ${mode} cannot invalidate the owned top-frame school authorization`, async t => {
    const h = browser(t, mode); await h.value.start();
    assert.equal((await h.value.readJson('/d2l/api/lp/1.49/users/whoami')).Identifier, '12345');
    assert.equal((await h.value.readJson('/d2l/api/lp/1.49/users/whoami')).Identifier, '12345');
  });
}

test('D2LB15: a late authenticated request from the expired loader cannot resurrect a token after 401', async t => {
  const h = browser(t, 'expired_resurrection'); await h.value.start();
  await assert.rejects(h.value.readJson('/d2l/api/lp/1.49/users/whoami'), isCode('AUTH_EXPIRED'));
  await h.waitEvent(value => value.params?.requestId === 'synthetic-resurrection-request');
  await assert.rejects(h.value.readJson('/d2l/api/lp/1.49/users/whoami'), isCode('AUTH_REQUIRED'));
  assert.equal(h.commands.at(-1).params.expression.includes(bearer), false);
});

test('D2LB12: a provider reflecting the authorization token cannot return that token through a school data response or error', async t => {
  const h = browser(t, 'reflect_token'); await h.value.start();
  await assert.rejects(h.value.readJson('/d2l/api/lp/1.49/users/whoami'), isCode('PROVIDER_FAILURE'));
  assert.equal(JSON.stringify(h.value.capability()).includes(bearer), false);
});

test('D2LB13: owned browser exit invalidates authorization and removes the temporary profile without a caller disconnect', async t => {
  const h = browser(t); await h.value.start(); assert.equal((await h.value.readJson('/d2l/api/lp/1.49/users/whoami')).Identifier, '12345');
  const closed = new Promise(resolve => h.child.once('close', resolve)); h.child.kill('SIGTERM'); await closed;
  assert.equal(existsSync(h.profile), false);
  await assert.rejects(h.value.readJson('/d2l/api/lp/1.49/users/whoami'), isCode('AUTH_REQUIRED'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const demo = fileURLToPath(new URL('../packages/core/examples/fixture-demo.mjs', import.meta.url));
const supported = ['darwin', 'linux'].includes(process.platform);

function temporaryHarness(fn) {
  const root = mkdtempSync(join(tmpdir(), 'learnbridge-demo-test-'));
  chmodSync(root, 0o700);
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('synthetic core demo proves records survive a fresh process and removes every fixture file', { skip: !supported }, () => temporaryHarness(root => {
  const child = spawnSync(process.execPath, [demo], {
    env: { TMPDIR: root, TMP: root, TEMP: root, OPENAI_API_KEY: 'synthetic_secret_must_not_be_inherited', ANTHROPIC_API_KEY: 'synthetic_other_secret', NODE_OPTIONS: '--no-warnings' },
    timeout: 10_000,
    maxBuffer: 32_000,
    encoding: 'utf8',
  });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0);
  assert.equal(child.stderr, '');
  assert.equal(child.stdout.includes(root), false);
  assert.equal(child.stdout.includes('synthetic_secret'), false);
  assert.equal(child.stdout.includes('synthetic_other_secret'), false);
  assert.equal(child.stdout.includes('Synthetic study'), false);
  const report = JSON.parse(child.stdout);
  assert.equal(report.status, 'PASS');
  assert.equal(report.evidence_type, 'synthetic_fixture');
  assert.equal(report.kind, 'core_contract_fixture_round_trip');
  assert.deepEqual(report.counts, { tasks: 1, documents: 1, document_revisions: 1 });
  assert.deepEqual(report.assertions, {
    validated_before_write: true, verified_in_fresh_process: true,
    records_equal_after_restart: true, content_hash_matches: true,
    revision_immutable: true, private_file_modes: true,
    child_environment_allowlisted: true, cleanup_complete: true,
  });
  assert.match(report.limitations[0], /no production repository/);
  // Independently verify cleanup rather than trusting the demo's own report.
  assert.deepEqual(readdirSync(root), []);
}));

test('demo refuses custom data roots and never reads or deletes existing student files', { skip: !supported }, () => temporaryHarness(root => {
  const sentinel = join(root, 'keep.txt');
  writeFileSync(sentinel, 'synthetic existing file to preserve', { mode: 0o600 });
  const child = spawnSync(process.execPath, [demo, '--data-root', root], {
    env: { TMPDIR: root }, timeout: 10_000, maxBuffer: 32_000, encoding: 'utf8',
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  assert.equal(child.stderr, '');
  assert.deepEqual(JSON.parse(child.stdout), { schema_version: 1, kind: 'core_contract_fixture_round_trip', status: 'FAIL', evidence_type: 'synthetic_fixture', code: 'INVALID_ARGUMENTS' });
  assert.equal(child.stdout.includes(root), false);
  assert.equal(readFileSync(sentinel, 'utf8'), 'synthetic existing file to preserve');
  assert.deepEqual(readdirSync(root), ['keep.txt']);
}));

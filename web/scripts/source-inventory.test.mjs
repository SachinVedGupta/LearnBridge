import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, lstat, mkdir, writeFile, readFile, rename, symlink, unlink, link, utimes, chmod, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { basename, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { describeRoot, inventorySource, readSelectedEntry, probeSourceCapability, createSourceAdapterForTests } from '../packages/local-sources/src/index.mjs';

// These marked roots contain synthetic data only. Native phase barriers let
// the test change the actual filesystem between open/check/read operations;
// no filesystem operation or body-read function is replaced by a mock.
const PREFIX = 'learnbridge-source-fixture-';
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(value).digest('hex');
const refusal = error => ['INVALID_INPUT', 'SCOPE_DENIED', 'VERSION_MISMATCH', 'BUDGET_EXCEEDED', 'CANCELLED', 'UNSUPPORTED'].includes(error?.code);

async function fixture(t) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), PREFIX)));
  const identity = await lstat(parent);
  const marker = randomUUID();
  await writeFile(join(parent, '.fixture-marker'), marker, { mode: 0o600, flag: 'wx' });
  const root = join(parent, 'approved');
  const outside = join(parent, 'outside');
  await mkdir(root); await mkdir(outside);
  t.after(async () => {
    const current = await lstat(parent);
    assert(basename(parent).startsWith(PREFIX));
    assert(current.isDirectory() && !current.isSymbolicLink());
    assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino);
    assert.equal(await readFile(join(parent, '.fixture-marker'), 'utf8'), marker);
    await rm(parent, { recursive: true });
  });
  return { parent, root, outside };
}

async function selectedFixture(t, { nested = false, text = 'LB_ALLOWED_SYNTHETIC_BODY\nλ, résumé and 🧠.\n' } = {}) {
  const fx = await fixture(t);
  const relativePath = nested ? 'notes/allowed.md' : 'allowed.md';
  if (nested) { await mkdir(join(fx.root, 'notes')); await mkdir(join(fx.outside, 'notes')); }
  const allowed = join(fx.root, relativePath);
  const outside = join(fx.outside, relativePath);
  await writeFile(allowed, text);
  await writeFile(outside, `LB_OUTSIDE_BODY_CANARY_${randomUUID()}`);
  const descriptor = await describeRoot(fx.root);
  const inventory = await inventorySource(descriptor);
  assert.equal(inventory.entries.length, 1);
  return { ...fx, allowed, outsideFile: outside, descriptor, inventory, chosen: inventory.entries[0], text };
}

test('SRC01: the fixed isolated runtime proves native anchored-directory operations', async () => {
  const capability = await probeSourceCapability();
  assert.equal(capability.state, 'available');
  assert.equal(capability.anchored_directory_fd, true);
  assert.equal(typeof capability.python_version, 'string');
  assert.equal(JSON.stringify(capability).includes('.venv'), false);
});

test('SRC02: inventory reads no source bodies and excludes secret, linked, dependency and unsupported entries', async t => {
  const fx = await fixture(t);
  await mkdir(join(fx.root, 'notes'));
  await mkdir(join(fx.root, '.codex'));
  await mkdir(join(fx.root, 'node_modules'));
  for (const [relative, text] of [
    ['notes/course.md', 'LB_ALLOWED_METADATA_ONLY_BODY'], ['schedule.TXT', 'LB_ALLOWED_OTHER_BODY'],
    ['credentials.txt', 'LB_EXCLUDED_CREDENTIAL_BODY'], ['.env.notes.txt', 'LB_EXCLUDED_ENV_BODY'],
    ['.codex/memory.md', 'LB_EXCLUDED_AGENT_PRIVATE_BODY'], ['node_modules/library.md', 'LB_EXCLUDED_DEPENDENCY_BODY'],
    ['image.png', 'LB_UNSUPPORTED_TYPE_BODY'],
  ]) await writeFile(join(fx.root, relative), text);
  await writeFile(join(fx.outside, 'outside.txt'), 'LB_OUTSIDE_BODY_CANARY');
  await symlink(join(fx.outside, 'outside.txt'), join(fx.root, 'linked.txt'));
  const reads = [];
  const adapter = createSourceAdapterForTests({ onBodyRead: record => reads.push(record) });
  const descriptor = await adapter.describeRoot(fx.root, { label: 'Synthetic school folder' });
  const inventory = await adapter.inventorySource(descriptor);
  assert.deepEqual(reads, []);
  assert.deepEqual(inventory.entries.map(item => item.relativePath), ['notes/course.md', 'schedule.TXT']);
  assert.equal(inventory.coverage.state, 'complete');
  assert.equal(inventory.exclusions.secret, 4);
  assert.equal(inventory.exclusions.symlink, 1);
  assert.equal(inventory.exclusions.unsupportedType, 1);
  const encoded = JSON.stringify(inventory);
  for (const forbidden of ['LB_ALLOWED_METADATA_ONLY_BODY', 'LB_OUTSIDE_BODY_CANARY', 'credentials.txt', '.env.notes.txt', '.codex', 'node_modules', 'image.png']) assert.equal(encoded.includes(forbidden), false);
  const next = await adapter.inventorySource(descriptor);
  assert.equal(next.version, inventory.version);
  assert.notEqual(next.id, inventory.id);
  assert.deepEqual(next.entries, inventory.entries);
});

test('SRC03: selected text is read from the exact validated descriptor with matching version and hash', async t => {
  const fx = await selectedFixture(t, { nested: true });
  const reads = [];
  const adapter = createSourceAdapterForTests({ onBodyRead: record => reads.push(record) });
  const result = await adapter.readSelectedEntry(fx.descriptor, fx.inventory, fx.chosen.id);
  assert.deepEqual(result, { text: fx.text, title: 'allowed.md', sha256: hash(fx.text), version: fx.chosen.snapshot.version });
  assert.equal(reads.reduce((sum, item) => sum + item.bytes, 0), Buffer.byteLength(fx.text));
  assert(reads.every(item => item.dev === fx.chosen.snapshot.dev && item.ino === fx.chosen.snapshot.ino));
  const outside = await lstat(fx.outsideFile, { bigint: true });
  assert(reads.every(item => item.ino !== outside.ino.toString() || item.dev !== outside.dev.toString()));
  assert.equal(Object.isFrozen(result), true);
});

test('SRC03: Unicode filenames and multibyte output preserve exact text across pipe chunks', async t => {
  const fx = await fixture(t);
  const name = 'étude-🧠.md';
  const text = 'λ résumé 🧠\n'.repeat(10_000);
  assert(Buffer.byteLength(text) < 256_000);
  await writeFile(join(fx.root, name), text);
  const source = await describeRoot(fx.root);
  const inventory = await inventorySource(source);
  assert.equal(inventory.entries[0].relativePath, name);
  const content = await readSelectedEntry(source, inventory, inventory.entries[0].id);
  assert.equal(content.text, text);
  assert.equal(content.sha256, hash(text));
});

test('SRC04: root selection refuses home/system roots, traversal and linked roots before acquisition', async t => {
  const fx = await fixture(t);
  const reads = [];
  const adapter = createSourceAdapterForTests({ onBodyRead: record => reads.push(record) });
  await symlink(fx.root, join(fx.parent, 'linked-root'));
  for (const path of ['/', homedir(), '/usr', join(fx.parent, 'linked-root'), fx.root + '/../outside', 'relative/folder']) {
    await assert.rejects(adapter.describeRoot(path), refusal);
  }
  assert.deepEqual(reads, []);
});

test('SRC05: lexical escapes, fake descriptors and altered inventories cannot reach a body read', async t => {
  const fx = await selectedFixture(t);
  const reads = [];
  const adapter = createSourceAdapterForTests({ onBodyRead: record => reads.push(record) });
  const wrongRoot = clone(fx.descriptor); wrongRoot.root = fx.outside;
  await assert.rejects(adapter.readSelectedEntry(wrongRoot, fx.inventory, fx.chosen.id), refusal);
  for (const path of ['../outside/allowed.md', '/absolute.md', 'notes/../../allowed.md', 'C:\\outside.md']) {
    const altered = clone(fx.inventory); altered.entries[0].relativePath = path;
    await assert.rejects(adapter.readSelectedEntry(fx.descriptor, altered, fx.chosen.id), refusal);
  }
  const altered = clone(fx.inventory); altered.entries[0].snapshot.ino = '1';
  await assert.rejects(adapter.readSelectedEntry(fx.descriptor, altered, fx.chosen.id), refusal);
  await assert.rejects(adapter.readSelectedEntry(fx.descriptor, fx.inventory, randomUUID()), refusal);
  let invoked = false;
  const getter = clone(fx.descriptor); Object.defineProperty(getter, 'root', { enumerable: true, get() { invoked = true; return fx.root; } });
  await assert.rejects(adapter.inventorySource(getter), refusal);
  assert.equal(invoked, false);
  assert.deepEqual(reads, []);
});

for (const phase of ['after_root_open', 'before_file_open', 'after_file_open', 'before_body_read']) {
  test(`SRC06: a real root swap at ${phase} cannot read an outside body`, async t => {
    const fx = await selectedFixture(t);
    const reads = [];
    let swapped = false;
    const adapter = createSourceAdapterForTests({
      onBodyRead: record => reads.push(record),
      onPhase: async event => {
        if (!swapped && event.phase === phase) {
          swapped = true;
          await rename(fx.root, join(fx.parent, 'original-approved'));
          await rename(fx.outside, fx.root);
        }
      },
    });
    await assert.rejects(adapter.readSelectedEntry(fx.descriptor, fx.inventory, fx.chosen.id), refusal);
    assert.equal(swapped, true);
    assert.deepEqual(reads, []);
  });
}

for (const phase of ['before_directory_open', 'after_directory_open', 'before_file_open', 'before_body_read']) {
  test(`SRC07: a real parent-directory swap at ${phase} cannot read an outside body`, async t => {
    const fx = await selectedFixture(t, { nested: true });
    const reads = [];
    let swapped = false;
    const adapter = createSourceAdapterForTests({
      onBodyRead: record => reads.push(record),
      onPhase: async event => {
        if (!swapped && event.phase === phase) {
          swapped = true;
          await rename(join(fx.root, 'notes'), join(fx.root, 'old-notes'));
          await rename(join(fx.outside, 'notes'), join(fx.root, 'notes'));
        }
      },
    });
    await assert.rejects(adapter.readSelectedEntry(fx.descriptor, fx.inventory, fx.chosen.id), refusal);
    assert.equal(swapped, true);
    assert.deepEqual(reads, []);
  });
}

for (const phase of ['before_file_open', 'after_file_open', 'before_body_read']) {
  test(`SRC08: a leaf symlink swap at ${phase} cannot read its outside target`, async t => {
    const fx = await selectedFixture(t);
    const reads = [];
    let swapped = false;
    const adapter = createSourceAdapterForTests({
      onBodyRead: record => reads.push(record),
      onPhase: async event => {
        if (!swapped && event.phase === phase) {
          swapped = true; await unlink(fx.allowed); await symlink(fx.outsideFile, fx.allowed);
        }
      },
    });
    await assert.rejects(adapter.readSelectedEntry(fx.descriptor, fx.inventory, fx.chosen.id), refusal);
    assert.equal(swapped, true); assert.deepEqual(reads, []);
  });
}

test('SRC09: inventory refuses pre-existing hard links and reads refuse a new post-inventory link', async t => {
  const fx = await selectedFixture(t);
  const reads = [];
  const adapter = createSourceAdapterForTests({ onBodyRead: record => reads.push(record) });
  await link(fx.allowed, join(fx.outside, 'hardlinked.md'));
  await assert.rejects(adapter.readSelectedEntry(fx.descriptor, fx.inventory, fx.chosen.id), refusal);
  const next = await adapter.inventorySource(fx.descriptor);
  assert.equal(next.entries.length, 0);
  assert.equal(next.exclusions.hardlink, 1);
  assert.deepEqual(reads, []);
});

test('SRC10: changed file versions fail before reading even when mtime is restored', async t => {
  const fx = await selectedFixture(t);
  const reads = [];
  const adapter = createSourceAdapterForTests({ onBodyRead: record => reads.push(record) });
  const before = await lstat(fx.allowed);
  await writeFile(fx.allowed, 'LB_REPLACED_VERSION_CANARY');
  await utimes(fx.allowed, before.atime, before.mtime);
  await assert.rejects(adapter.readSelectedEntry(fx.descriptor, fx.inventory, fx.chosen.id), refusal);
  assert.deepEqual(reads, []);
});

test('SRC11: oversized selection fails before reading and hard byte limits cannot be expanded', async t => {
  const fx = await selectedFixture(t, { text: 'x'.repeat(256_001) });
  const reads = [];
  const adapter = createSourceAdapterForTests({ onBodyRead: record => reads.push(record) });
  await assert.rejects(adapter.readSelectedEntry(fx.descriptor, fx.inventory, fx.chosen.id), error => error.code === 'BUDGET_EXCEEDED');
  await assert.rejects(adapter.readSelectedEntry(fx.descriptor, fx.inventory, fx.chosen.id, { maxBytes: 256_001 }), refusal);
  assert.deepEqual(reads, []);
});

test('SRC12: entry, file and depth budgets report partial coverage without body reads', async t => {
  const fx = await fixture(t);
  await mkdir(join(fx.root, 'nested'));
  for (const name of ['one.md', 'two.md', 'nested/three.txt']) await writeFile(join(fx.root, name), 'LB_BUDGET_METADATA_BODY');
  const reads = [];
  const adapter = createSourceAdapterForTests({ onBodyRead: record => reads.push(record) });
  const source = await adapter.describeRoot(fx.root);
  for (const [options, reason] of [[{ maxEntries: 2 }, 'entry_limit'], [{ maxFiles: 1 }, 'file_limit'], [{ maxDepth: 0 }, 'depth_limit']]) {
    const result = await adapter.inventorySource(source, options);
    assert.equal(result.coverage.state, 'partial');
    assert(result.coverage.reasons.includes(reason));
    assert(result.counts.entriesVisited <= (options.maxEntries ?? 500));
    assert(result.entries.length <= (options.maxFiles ?? 100));
  }
  for (const options of [{ maxEntries: 501 }, { maxFiles: 101 }, { maxDepth: 9 }, { onPhase: () => {} }]) await assert.rejects(adapter.inventorySource(source, options), refusal);
  assert.deepEqual(reads, []);
});

test('SRC13: pre-cancelled and mid-inventory cancellation preserve honest coverage and read no bodies', async t => {
  const fx = await selectedFixture(t);
  const reads = [];
  const before = new AbortController(); before.abort();
  const cancelled = await inventorySource(fx.descriptor, { signal: before.signal });
  assert.equal(cancelled.coverage.state, 'cancelled');
  assert.deepEqual(cancelled.entries, []);
  const controller = new AbortController();
  const adapter = createSourceAdapterForTests({
    onBodyRead: record => reads.push(record),
    onPhase: event => { if (event.phase === 'inventory_entry') controller.abort(); },
  });
  const result = await adapter.inventorySource(fx.descriptor, { signal: controller.signal });
  assert.equal(result.coverage.state, 'cancelled');
  assert(result.coverage.reasons.includes('cancelled'));
  assert.equal(result.counts.entriesVisited, 1);
  assert.deepEqual(reads, []);
});

test('SRC14: cancellation before the body read returns no selected content', async t => {
  const fx = await selectedFixture(t);
  const reads = [];
  const controller = new AbortController();
  const adapter = createSourceAdapterForTests({
    onBodyRead: record => reads.push(record),
    onPhase: event => { if (event.phase === 'before_body_read') controller.abort(); },
  });
  await assert.rejects(adapter.readSelectedEntry(fx.descriptor, fx.inventory, fx.chosen.id, { signal: controller.signal }), error => error.code === 'CANCELLED');
  assert.deepEqual(reads, []);
});

test('SRC15: an in-place write during extraction is quarantined rather than returned as a valid snapshot', async t => {
  const fx = await selectedFixture(t, { text: 'Approved original text. '.repeat(5000) });
  const reads = [];
  const adapter = createSourceAdapterForTests({
    onBodyRead: async record => {
      reads.push(record);
      if (reads.length === 1) await writeFile(fx.allowed, 'LB_CHANGED_DURING_READ_CANARY');
    },
  });
  await assert.rejects(adapter.readSelectedEntry(fx.descriptor, fx.inventory, fx.chosen.id), refusal);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].bytes, 65536);
  assert.equal(reads[0].ino, fx.chosen.snapshot.ino);
});

test('SRC16: special files are excluded and a FIFO leaf swap cannot block or read a body', async t => {
  const fx = await selectedFixture(t);
  execFileSync('/usr/bin/mkfifo', [join(fx.root, 'fifo.txt')], { env: { TZ: 'UTC' }, timeout: 2000 });
  const reads = [];
  const adapter = createSourceAdapterForTests({ onBodyRead: record => reads.push(record) });
  const next = await adapter.inventorySource(fx.descriptor);
  assert.equal(next.exclusions.special, 1);
  const choice = next.entries.find(item => item.relativePath === 'allowed.md');
  let swapped = false;
  const attacker = createSourceAdapterForTests({
    onBodyRead: record => reads.push(record),
    onPhase: async event => {
      if (!swapped && event.phase === 'before_file_open') {
        swapped = true; await unlink(fx.allowed); execFileSync('/usr/bin/mkfifo', [fx.allowed], { env: { TZ: 'UTC' }, timeout: 2000 });
      }
    },
  });
  const start = Date.now();
  await assert.rejects(attacker.readSelectedEntry(fx.descriptor, next, choice.id), refusal);
  assert(Date.now() - start < 2000);
  assert.equal(swapped, true); assert.deepEqual(reads, []);
});

test('SRC17: unavailable subdirectories produce partial permission coverage without traversing them', async t => {
  const fx = await fixture(t);
  const privateFolder = join(fx.root, 'unreadable');
  await mkdir(privateFolder); await writeFile(join(privateFolder, 'private.md'), 'LB_PERMISSION_DENIED_BODY');
  const source = await describeRoot(fx.root);
  await chmod(privateFolder, 0o000);
  try {
    const result = await inventorySource(source);
    assert.equal(result.coverage.state, 'partial');
    assert(result.coverage.reasons.includes('permission_denied'));
    assert.equal(result.exclusions.permission, 1);
    assert.deepEqual(result.entries, []);
  } finally { await chmod(privateFolder, 0o700); }
});

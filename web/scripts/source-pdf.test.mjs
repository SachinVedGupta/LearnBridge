import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, lstat, symlink, link, copyFile, access } from 'node:fs/promises';
import childProcess, { execFile } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { join, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { describeRoot, inventorySource, readSelectedEntry, readSelectedPdf, probePdfCapability, PDF_LIMITS,
  PDF_PARSER_VERSION, createSourceAdapterForTests } from '../packages/local-sources/src/index.mjs';

const exec = promisify(execFile), native = process.platform === 'darwin';
const sha = value => createHash('sha256').update(value).digest('hex');
const fixtureScript = fileURLToPath(new URL('./fixtures/pdf-source-fixture.swift', import.meta.url));
let fixtures;
before(async () => {
  if (!native) return;
  fixtures = await realpath(await mkdtemp(join(tmpdir(), 'learnbridge-pdf-generated-')));
  await exec('/usr/bin/swift', ['-module-cache-path', join(fixtures, 'modules'), fixtureScript, fixtures], {
    timeout: 30_000, maxBuffer: 32_000, env: { PATH: '/usr/bin:/bin', HOME: fixtures, TMPDIR: fixtures },
  });
}, { timeout: 35_000 });
after(async () => { if (fixtures) { assert(basename(fixtures).startsWith('learnbridge-pdf-generated-')); await rm(fixtures, { recursive: true, force: true }); } });

async function sourceFixture(t, name = 'text.pdf') {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'learnbridge-pdf-source-')));
  const root = join(parent, 'approved'); await mkdir(root);
  const marker = randomUUID(); await writeFile(join(parent, '.fixture-marker'), marker, { mode: 0o600 });
  const identity = await lstat(parent);
  t.after(async () => {
    const current = await lstat(parent); assert(current.isDirectory() && !current.isSymbolicLink());
    assert.equal(current.ino, identity.ino); assert.equal(current.dev, identity.dev);
    assert.equal(await readFile(join(parent, '.fixture-marker'), 'utf8'), marker);
    assert(basename(parent).startsWith('learnbridge-pdf-source-')); await rm(parent, { recursive: true });
  });
  const path = join(root, name); await copyFile(join(fixtures, name), path);
  const descriptor = await describeRoot(root), inventory = await inventorySource(descriptor);
  const chosen = inventory.entries.find(entry => entry.title === name); assert(chosen);
  return { parent, root, path, descriptor, inventory, chosen };
}

test('PDF01: startup checks prerequisites without a child; explicit native verification and other-platform refusal remain available', async () => {
  const capability = await probePdfCapability();
  assert.equal(capability.state, native ? 'available' : 'unsupported'); assert.equal(capability.parser_version, PDF_PARSER_VERSION);
  assert.equal(JSON.stringify(capability).includes('/Users/'), false);
  if (native) {
    assert.equal(capability.ocr, false); assert.equal(capability.processing, 'local_text_only'); assert.equal(capability.limits.maxPages, 200);
    assert.equal(capability.verification, 'prerequisites_only');
    const verified = await probePdfCapability({ verify: true }); assert.equal(verified.state, 'available'); assert.equal(verified.verification, 'native_probe_passed');
  }
  const moduleURL = new URL('../packages/local-sources/src/index.mjs', import.meta.url).href;
  const cheap = await exec(process.execPath, ['--input-type=module', '-e', `import cp from 'node:child_process';import{syncBuiltinESMExports}from'node:module';let count=0;cp.spawn=()=>{count++;throw Error('probe must not spawn');};syncBuiltinESMExports();const m=await import(${JSON.stringify(moduleURL)});const c=await m.probePdfCapability();console.log(JSON.stringify({count,state:c.state,verification:c.verification}));`], { maxBuffer: 4000 });
  assert.equal(JSON.parse(cheap.stdout).count, 0); assert.equal(JSON.parse(cheap.stdout).state, native ? 'available' : 'unsupported');
  await assert.rejects(probePdfCapability({ verify: 'yes' }), { code: 'INVALID_INPUT' });
  const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(probePdfCapability({ verify: true, signal: cancelled.signal }), { code: 'CANCELLED' });
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', `Object.defineProperty(process,'platform',{value:'linux'}); const m=await import(${JSON.stringify(moduleURL)}); const c=await m.probePdfCapability(); console.log(JSON.stringify(c)); try {await m.readSelectedPdf({}, {}, 'not-a-file');} catch(e){console.log(e.code);}`], { maxBuffer: 4000 });
  assert.match(stdout, /native_pdf_platform_unsupported/); assert.match(stdout, /UNSUPPORTED/);
});

function labelledPDF(label) {
  const encoded = Buffer.from(label, 'utf16le'); encoded.swap16();
  const prefix = `FEFF${encoded.toString('hex')}`;
  const stream = 'BT /F1 12 Tf 40 740 Td (Synthetic labelled PDF.) Tj ET';
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R /PageLabels << /Nums [0 << /P <${prefix}> >>] >> >>`,
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let output = '%PDF-1.7\n', offsets = [0];
  objects.forEach((value, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${value}\nendobj\n`; });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

test('PDF10: native printed labels satisfy both character and UTF-8 budgets while physical pages remain exact', { skip: !native }, async t => {
  for (const [label, expected] of [['é'.repeat(64), 'é'.repeat(64)], ['é'.repeat(65), null], ['a'.repeat(129), null]]) {
    const fx = await sourceFixture(t); await writeFile(fx.path, labelledPDF(label));
    const inventory = await inventorySource(fx.descriptor), result = await readSelectedPdf(fx.descriptor, inventory, inventory.entries[0].id);
    assert.equal(result.pdf.extraction_status, 'available'); assert.equal(result.pdf.pages[0].physical_page, 1);
    assert.equal(result.pdf.pages[0].printed_label, expected);
    if (expected !== null) { assert(expected.length <= 128); assert(Buffer.byteLength(expected) <= 128); }
  }
});

test('PDF11: cleanup timeout cannot settle or remove the private cache before real exit acknowledgement', { skip: !native }, async t => {
  const fx = await sourceFixture(t), controller = new AbortController();
  const originalSpawn = childProcess.spawn; let directory, nativeChild, observed = [], hold = true;
  childProcess.spawn = function (...args) {
    const child = originalSpawn.apply(this, args);
    if (args[0] === '/usr/bin/swift') {
      nativeChild = child; directory = dirname(args[1][1]);
      const emit = child.emit;
      child.emit = function (event, ...values) {
        if (hold && ['exit', 'close'].includes(event)) { observed.push([event, values]); return true; }
        return emit.call(this, event, ...values);
      };
      child.releaseObservedExit = () => { hold = false; for (const [event, values] of observed) emit.call(child, event, ...values); observed = []; };
    }
    return child;
  };
  syncBuiltinESMExports();
  let settled = false, operation;
  try {
    const adapter = createSourceAdapterForTests({ onPhase: value => { if (value.phase === 'pdf_process_started') controller.abort(); } });
    operation = adapter.readSelectedPdf(fx.descriptor, fx.inventory, fx.chosen.id, { signal: controller.signal });
    operation.then(() => { settled = true; }, () => { settled = true; });
    await delay(2750);
    assert(nativeChild && directory); assert(observed.some(([event]) => event === 'exit'));
    assert.equal(settled, false); await access(directory);
    nativeChild.releaseObservedExit();
    await assert.rejects(operation, { code: 'CANCELLED' });
    await assert.rejects(access(directory), { code: 'ENOENT' });
    assert.throws(() => process.kill(nativeChild.pid, 0), { code: 'ESRCH' });
  } finally {
    nativeChild?.releaseObservedExit(); childProcess.spawn = originalSpawn; syncBuiltinESMExports();
    await operation?.catch(() => {});
  }
});

test('PDF02: inventory is metadata-only and excludes secret, linked, hardlinked and oversized PDFs', { skip: !native }, async t => {
  const fx = await sourceFixture(t); const reads = [], adapter = createSourceAdapterForTests({ onBodyRead: value => reads.push(value) });
  await copyFile(join(fixtures, 'text.pdf'), join(fx.root, 'tokens.pdf'));
  await symlink(fx.path, join(fx.root, 'linked.pdf'));
  await copyFile(fx.path, join(fx.parent, 'outside.pdf'));
  await link(join(fx.parent, 'outside.pdf'), join(fx.root, 'hardlinked.pdf'));
  await writeFile(join(fx.root, 'oversized.pdf'), Buffer.alloc(PDF_LIMITS.maxPdfBytes + 1));
  const listed = await adapter.inventorySource(fx.descriptor);
  assert.deepEqual(reads, []); assert.deepEqual(listed.entries.map(entry => [entry.title, entry.kind]), [['text.pdf', 'pdf']]);
  assert.equal(listed.exclusions.secret, 1); assert.equal(listed.exclusions.symlink, 1); assert.equal(listed.exclusions.hardlink, 1); assert.equal(listed.exclusions.unsupportedType, 1);
  assert.equal(JSON.stringify(listed).includes('Recursion'), false);
  await assert.rejects(readSelectedEntry(fx.descriptor, listed, listed.entries[0].id), { code: 'UNSUPPORTED' });
});

test('PDF03: actual PDFKit text has original/text/page hashes, exact UTF-8 page ranges and frozen provenance', { skip: !native }, async t => {
  const fx = await sourceFixture(t), observations = [];
  const adapter = createSourceAdapterForTests({ onBodyRead: value => observations.push(value) });
  const result = await adapter.readSelectedPdf(fx.descriptor, fx.inventory, fx.chosen.id);
  const original = await readFile(fx.path);
  assert.equal(result.pdf.source_sha256, sha(original)); assert.equal(result.pdf.source_bytes, original.length);
  assert.equal(result.sha256, sha(result.text)); assert.notEqual(result.sha256, result.pdf.source_sha256);
  assert.equal(result.version, fx.chosen.snapshot.version); assert.equal(result.pdf.parser_version, PDF_PARSER_VERSION);
  assert.equal(result.pdf.extraction_status, 'available'); assert.equal(result.pdf.page_count, 2); assert.equal(result.pdf.coverage.state, 'complete');
  assert.match(result.pdf.pages[0].text, /Recursion λ café résumé\./); assert.match(result.pdf.pages[1].text, /Base cases end recursion\./);
  const bytes = Buffer.from(result.text);
  for (const page of result.pdf.pages) {
    assert.equal(bytes.subarray(page.byte_range.start, page.byte_range.end).toString('utf8'), page.text);
    assert.equal(sha(page.text), page.sha256); assert.equal(typeof page.printed_label, 'string');
  }
  assert.equal(observations.reduce((sum, value) => sum + value.bytes, 0), original.length);
  assert(observations.every(value => value.dev === fx.chosen.snapshot.dev && value.ino === fx.chosen.snapshot.ino));
  assert(Buffer.byteLength(JSON.stringify(result.pdf)) <= 96_000); assert(Buffer.byteLength(JSON.stringify(result)) <= 128_000);
  assert(Object.isFrozen(result.pdf.pages[0].byte_range)); assert(Object.isFrozen(result));
  assert.equal(JSON.stringify(result).includes(fx.root), false);
});

test('PDF04: mixed, image-only, encrypted and malformed files have explicit coverage without invented text', { skip: !native }, async t => {
  for (const [name, status, coverage] of [['mixed.pdf', 'available', 'partial'], ['image.pdf', 'text_unavailable', 'unavailable'], ['encrypted.pdf', 'encrypted', 'unavailable']]) {
    const fx = await sourceFixture(t, name), result = await readSelectedPdf(fx.descriptor, fx.inventory, fx.chosen.id);
    assert.equal(result.pdf.extraction_status, status); assert.equal(result.pdf.coverage.state, coverage);
    if (status !== 'available') { assert.equal(result.text, ''); assert.deepEqual(result.pdf.pages, []); assert.equal(result.sha256, sha('')); }
    else { assert(result.pdf.coverage.reasons.includes('pages_without_extractable_text')); assert.equal(result.pdf.pages[1].text, ''); assert.equal(result.pdf.pages[1].byte_range.start, result.pdf.pages[1].byte_range.end); }
  }
  const fx = await sourceFixture(t); await writeFile(fx.path, '%PDF-1.7\nLB_MALFORMED_SYNTHETIC_CANARY\n');
  const inventory = await inventorySource(fx.descriptor), result = await readSelectedPdf(fx.descriptor, inventory, inventory.entries[0].id);
  assert.equal(result.pdf.extraction_status, 'malformed'); assert.equal(result.pdf.coverage.state, 'unavailable'); assert.equal(result.text, ''); assert.equal(JSON.stringify(result).includes('LB_MALFORMED'), false);
});

test('PDF05: page/text limits are enforced and request options cannot expand hard budgets or install callbacks', { skip: !native }, async t => {
  const fx = await sourceFixture(t, 'many.pdf');
  await assert.rejects(readSelectedPdf(fx.descriptor, fx.inventory, fx.chosen.id), { code: 'BUDGET_EXCEEDED' });
  const short = await sourceFixture(t);
  await assert.rejects(readSelectedPdf(short.descriptor, short.inventory, short.chosen.id, { maxBytes: 8 }), { code: 'BUDGET_EXCEEDED' });
  const observations = [], adapter = createSourceAdapterForTests({ onBodyRead: value => observations.push(value) });
  for (const options of [{ maxBytes: PDF_LIMITS.maxTextBytes + 1 }, { binary: '/bin/echo' }, { onPhase() {} }, { maxPages: 1000 }]) await assert.rejects(adapter.readSelectedPdf(short.descriptor, short.inventory, short.chosen.id, options), { code: 'INVALID_INPUT' });
  await assert.rejects(adapter.readSelectedPdf(short.descriptor, short.inventory, randomUUID()), { code: 'SCOPE_DENIED' }); assert.deepEqual(observations, []);
});

test('PDF06: a symlink leaf swap still produces zero outside-body reads', { skip: !native }, async t => {
  const fx = await sourceFixture(t); const outside = join(fx.parent, 'outside.pdf'); await copyFile(join(fixtures, 'image.pdf'), outside);
  const observations = []; let changed = false;
  const adapter = createSourceAdapterForTests({ onBodyRead: value => observations.push(value), onPhase: async value => {
    if (!changed && value.phase === 'before_file_open') { changed = true; await rm(fx.path); await symlink(outside, fx.path); }
  } });
  await assert.rejects(adapter.readSelectedPdf(fx.descriptor, fx.inventory, fx.chosen.id), { code: 'VERSION_MISMATCH' });
  assert.equal(changed, true); assert.deepEqual(observations, []);
});

test('PDF07: changing the approved source after native extraction withholds the entire late result', { skip: !native }, async t => {
  const fx = await sourceFixture(t); let parsed = false;
  const adapter = createSourceAdapterForTests({ onPhase: async value => {
    if (value.phase === 'after_pdf_parse') { parsed = true; await writeFile(fx.path, await readFile(join(fixtures, 'image.pdf'))); }
  } });
  await assert.rejects(adapter.readSelectedPdf(fx.descriptor, fx.inventory, fx.chosen.id), { code: 'VERSION_MISMATCH' }); assert.equal(parsed, true);
});

test('PDF08: abort before or after extraction never releases a late native result', { skip: !native }, async t => {
  for (const phase of ['before_pdf_parse', 'after_pdf_parse']) {
    const fx = await sourceFixture(t), controller = new AbortController(); let reached = false, spawned = false;
    const adapter = createSourceAdapterForTests({ onPhase: value => { if (value.phase === 'pdf_process_started') spawned = true; if (value.phase === phase) { reached = true; controller.abort(); } } });
    await assert.rejects(adapter.readSelectedPdf(fx.descriptor, fx.inventory, fx.chosen.id, { signal: controller.signal }), { code: 'CANCELLED' });
    assert.equal(reached, true); if (phase === 'before_pdf_parse') assert.equal(spawned, false);
  }
});

for (const mode of ['cancel', 'timeout']) test(`PDF09: a stopped real native process is killed on ${mode} before the operation resolves`, { skip: !native }, async t => {
  const fx = await sourceFixture(t), controller = new AbortController(); let pid;
  const adapter = createSourceAdapterForTests({ ...(mode === 'timeout' ? { pdfTimeoutMs: 250 } : {}), onPhase: value => {
    if (value.phase === 'pdf_process_started') { pid = value.pid; process.kill(-pid, 'SIGSTOP'); if (mode === 'cancel') controller.abort(); }
  } });
  const started = Date.now();
  await assert.rejects(adapter.readSelectedPdf(fx.descriptor, fx.inventory, fx.chosen.id, { signal: controller.signal }), { code: mode === 'cancel' ? 'CANCELLED' : 'BUDGET_EXCEEDED' });
  assert(pid); assert(Date.now() - started < 5000); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }); assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' });
});

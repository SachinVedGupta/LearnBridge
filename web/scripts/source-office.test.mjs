import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, lstat, symlink, link, copyFile } from 'node:fs/promises';
import childProcess, { execFile, spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { describeRoot, inventorySource, readSelectedEntry, readSelectedOffice, probeOfficeCapability,
  OFFICE_LIMITS, OFFICE_PARSER_VERSION, createSourceAdapterForTests } from '../packages/local-sources/src/index.mjs';

const exec = promisify(execFile), supported = ['darwin', 'linux'].includes(process.platform);
const python = fileURLToPath(new URL('../../.venv/bin/python3', import.meta.url));
const fixtureScript = fileURLToPath(new URL('./fixtures/office-source-fixture.py', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
let fixtures;
before(async () => {
  if (!supported) return;
  fixtures = await realpath(await mkdtemp(join(tmpdir(), 'learnbridge-office-generated-')));
  await exec(python, ['-I', '-S', '-B', fixtureScript, fixtures], { timeout: 5000, maxBuffer: 2000 });
});
after(async () => { if (fixtures) { assert(basename(fixtures).startsWith('learnbridge-office-generated-')); await rm(fixtures, { recursive: true }); } });

async function sourceFixture(t, name = 'text.docx') {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'learnbridge-office-source-'))), root = join(parent, 'approved');
  await mkdir(root); const marker = randomUUID(); await writeFile(join(parent, '.fixture-marker'), marker, { mode: 0o600 });
  const identity = await lstat(parent);
  t.after(async () => { const current = await lstat(parent); assert(current.isDirectory() && !current.isSymbolicLink());
    assert.equal(current.ino, identity.ino); assert.equal(current.dev, identity.dev);
    assert.equal(await readFile(join(parent, '.fixture-marker'), 'utf8'), marker);
    assert(basename(parent).startsWith('learnbridge-office-source-')); await rm(parent, { recursive: true }); });
  const path = join(root, name); await copyFile(join(fixtures, name), path);
  const descriptor = await describeRoot(root), inventory = await inventorySource(descriptor);
  const chosen = inventory.entries.find(entry => entry.title === name); assert(chosen);
  return { parent, root, path, descriptor, inventory, chosen };
}

const CUSTOM = String.raw`
import json,runpy,sys,io,struct,zipfile
f=runpy.run_path(sys.argv[1]); req=json.load(sys.stdin); parts=f['docx_parts'](['VISIBLE SYNTHETIC TEXT']); extra=[]
v=req['variant']
if v=='nul': extra=[('word/document.xmlX','NUL CANARY')]
elif v=='absolute': extra=[('/outside.xml','ABSOLUTE CANARY')]
elif v=='backslash': extra=[('word\\outside.xml','BACKSLASH CANARY')]
elif v=='drive': extra=[('C:/outside.xml','DRIVE CANARY')]
elif v=='dot': extra=[('word/./outside.xml','DOT CANARY')]
elif v=='case_duplicate': extra=[('WORD/DOCUMENT.XML',parts['word/document.xml'])]
elif v=='many_entries': extra=[('word/items/p'+str(i)+'.dat','x') for i in range(1000)]
elif v=='xml_limit': parts=f['docx_parts'](['x'*2100000])
elif v=='sections': parts=f['docx_parts'](['x']*1001)
elif v=='metadata': parts=f['docx_parts'](['x']*1000)
elif v=='long': parts=f['docx_parts'](['x'*70000])
elif v=='deep': parts['word/document.xml']=f['document']('<w:customXml>'*70+f['paragraph']('DEEP CANARY')+'</w:customXml>'*70)
elif v=='declaration': parts['word/document.xml']=parts['word/document.xml'].replace('encoding="UTF-8"','encoding="ISO-8859-1"')
elif v=='unused_entity': parts['word/styles.xml']='<!DOCTYPE x [<!ENTITY x "UNUSED ENTITY CANARY">]><x>&x;</x>'
elif v=='bad_relationship': parts['word/_rels/document.xml.rels']=f['relationships']([('rBad',f['R']+'/image','../../outside.xml',None)])
elif v=='hyperlink': parts['word/_rels/document.xml.rels']=f['relationships']([('rUrl',f['R']+'/hyperlink','https://example.invalid/never-fetch','External')])
elif v=='table': parts['word/document.xml']=f['document'](f['paragraph']('First paragraph.')+'<w:tbl><w:tr><w:tc>'+f['paragraph']('Inside table.')+'</w:tc></w:tr></w:tbl>'+f['paragraph']('Last paragraph.'))
elif v=='mixed': parts=f['docx_parts'](['α 😀','', 'é\tline\nnext'])
elif v=='malformed_xml': parts['word/document.xml']='<unclosed'
elif v=='macro_type': parts['[Content_Types].xml']=f['content_types']([('word/document.xml','application/vnd.ms-word.document.macroEnabled.main+xml')])
elif v=='only_revisions': parts['word/document.xml']=f['document']('<w:p><w:ins><w:r><w:t>REVISION CANARY MUST BE OMITTED</w:t></w:r></w:ins></w:p>')
elif v=='only_images': parts=f['docx_parts'](['']); extra=[('word/media/image.png',b'SYNTHETIC NONRENDERED IMAGE')]
elif v in ('local_crc','local_compressed','local_uncompressed'): pass
elif v in ('streaming','bad_descriptor'): pass
else: raise ValueError('Unknown synthetic variant')
data=f['package_bytes'](parts,extra)
if v in ('streaming','bad_descriptor'):
    class Streaming(io.BytesIO):
        def seek(self,*args): raise io.UnsupportedOperation('Synthetic nonseekable writer')
    stream=Streaming()
    with zipfile.ZipFile(stream,'w',compression=zipfile.ZIP_DEFLATED) as archive:
        for name,value in parts.items(): archive.writestr(name,value)
    data=stream.getvalue()
    if v=='bad_descriptor':
        data=bytearray(data)
        with zipfile.ZipFile(io.BytesIO(data)) as archive: item=archive.getinfo('word/document.xml')
        name_size,extra_size=struct.unpack_from('<HH',data,item.header_offset+26)
        descriptor=item.header_offset+30+name_size+extra_size+item.compress_size
        if data[descriptor:descriptor+4]==b'PK\x07\x08': descriptor+=4
        struct.pack_into('<I',data,descriptor,struct.unpack_from('<I',data,descriptor)[0]^1)
if v=='nul': data=data.replace(b'word/document.xmlX',b'word/document.xml\x00')
if v in ('local_crc','local_compressed','local_uncompressed'):
    data=bytearray(data)
    with zipfile.ZipFile(io.BytesIO(data)) as archive: offset=archive.getinfo('word/document.xml').header_offset
    field=offset+{'local_crc':14,'local_compressed':18,'local_uncompressed':22}[v]
    struct.pack_into('<I',data,field,struct.unpack_from('<I',data,field)[0]^1)
with open(req['path'],'wb') as output: output.write(data)
`;
async function custom(fx, variant) {
  await new Promise((resolve, reject) => {
    const child = spawn(python, ['-I', '-S', '-B', '-c', CUSTOM, fixtureScript], { stdio: ['pipe', 'ignore', 'pipe'], env: { TZ: 'UTC' } });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; }); child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`Synthetic archive generation failed: ${stderr}`)));
    child.stdin.end(JSON.stringify({ path: fx.path, variant }));
  });
  const inventory = await inventorySource(fx.descriptor); return { ...fx, inventory, chosen: inventory.entries.find(entry => entry.title === fx.chosen.title) };
}

test('OFFICE01: startup is prerequisite-only with zero children and no caller-configurable parser', async () => {
  const capability = await probeOfficeCapability(); assert.equal(capability.state, supported ? 'available' : 'unsupported');
  assert.equal(capability.parser_version, OFFICE_PARSER_VERSION); assert.equal(JSON.stringify(capability).includes('/Users/'), false);
  if (supported) { assert.equal(capability.verification, 'prerequisites_only'); assert.equal(capability.rendering, false); assert.deepEqual(capability.limits, OFFICE_LIMITS); }
  const moduleURL = new URL('../packages/local-sources/src/index.mjs', import.meta.url).href;
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', `import cp from 'node:child_process';import{syncBuiltinESMExports}from'node:module';let count=0;cp.spawn=()=>{count++;throw Error('must not spawn')};syncBuiltinESMExports();const m=await import(${JSON.stringify(moduleURL)});const c=await m.probeOfficeCapability();console.log(JSON.stringify({count,state:c.state}));`], { maxBuffer: 2000 });
  assert.equal(JSON.parse(stdout).count, 0);
  await assert.rejects(probeOfficeCapability({ binary: '/bin/echo' }), { code: 'INVALID_INPUT' });
  const unsupported = await exec(process.execPath, ['--input-type=module', '-e', `Object.defineProperty(process,'platform',{value:'win32'});const m=await import(${JSON.stringify(moduleURL)});console.log((await m.probeOfficeCapability()).state);try{await m.readSelectedOffice({}, {}, 'x')}catch(e){console.log(e.code)}`], { maxBuffer: 2000 });
  assert.match(unsupported.stdout, /unsupported/); assert.match(unsupported.stdout, /UNSUPPORTED/);
});

test('OFFICE02: metadata-only inventory includes bounded docx/pptx, excludes credentials/links, and requires explicit office dispatch', { skip: !supported }, async t => {
  const fx = await sourceFixture(t), reads = [], adapter = createSourceAdapterForTests({ onBodyRead: value => reads.push(value) });
  await copyFile(join(fixtures, 'ordered.pptx'), join(fx.root, 'ordered.pptx'));
  await copyFile(fx.path, join(fx.root, 'tokens.docx')); await symlink(fx.path, join(fx.root, 'linked.docx'));
  await copyFile(fx.path, join(fx.parent, 'outside.docx')); await link(join(fx.parent, 'outside.docx'), join(fx.root, 'hardlinked.docx'));
  await writeFile(join(fx.root, 'oversized.docx'), Buffer.alloc(OFFICE_LIMITS.maxOfficeBytes + 1));
  await copyFile(fx.path, join(fx.root, 'unsupported.docm'));
  const inventory = await adapter.inventorySource(fx.descriptor);
  assert.deepEqual(reads, []); assert.deepEqual(inventory.entries.map(value => [value.title, value.kind]), [['ordered.pptx', 'pptx'], ['text.docx', 'docx']]);
  assert.equal(inventory.exclusions.secret, 1); assert.equal(inventory.exclusions.symlink, 1); assert.equal(inventory.exclusions.hardlink, 1); assert.equal(inventory.exclusions.unsupportedType, 2);
  for (const entry of inventory.entries) await assert.rejects(readSelectedEntry(fx.descriptor, inventory, entry.id), { code: 'UNSUPPORTED' });
});

for (const name of ['text.docx', 'ordered.pptx']) test(`OFFICE03: actual ${name} yields deterministic ordered source/text/section provenance`, { skip: !supported }, async t => {
  const fx = await sourceFixture(t, name), observations = [], adapter = createSourceAdapterForTests({ onBodyRead: value => observations.push(value) });
  const result = await adapter.readSelectedOffice(fx.descriptor, fx.inventory, fx.chosen.id), original = await readFile(fx.path);
  assert.equal(result.office.extraction_status, 'available'); assert.equal(result.office.coverage.state, 'partial');
  assert.deepEqual(result.office.coverage.reasons, ['layout_not_preserved']); assert.equal(result.office.parser_version, OFFICE_PARSER_VERSION);
  assert.equal(result.office.source_sha256, sha(original)); assert.equal(result.office.source_bytes, original.length);
  assert.equal(result.sha256, sha(result.text)); assert.notEqual(result.sha256, result.office.source_sha256); assert.equal(result.version, fx.chosen.snapshot.version);
  assert.equal(result.office.section_count, 2); const bytes = Buffer.from(result.text);
  for (const [index, section] of result.office.sections.entries()) { assert.equal(section.position, index + 1); assert.equal(section.unit, name.endsWith('.docx') ? 'paragraph' : 'slide');
    assert.equal(bytes.subarray(section.byte_range.start, section.byte_range.end).toString('utf8'), section.text); assert.equal(section.sha256, sha(section.text)); assert(Object.isFrozen(section.byte_range)); }
  if (name.endsWith('.pptx')) { assert.match(result.office.sections[0].text, /Second file, first presentation slide λ/); assert.match(result.office.sections[1].text, /First file, second presentation slide café/); }
  else assert.match(result.text, /Synthetic course note λ café résumé/);
  assert(observations.every(value => value.dev === fx.chosen.snapshot.dev && value.ino === fx.chosen.snapshot.ino));
  assert.equal(observations.reduce((sum, value) => sum + value.bytes, 0), original.length);
  assert(Buffer.byteLength(JSON.stringify(result.office)) <= 96_000); assert(Buffer.byteLength(JSON.stringify(result)) <= 128_000); assert(Object.isFrozen(result));
  assert.equal(JSON.stringify(result).includes(fx.root), false);
  const again = await adapter.readSelectedOffice(fx.descriptor, fx.inventory, fx.chosen.id); assert.deepEqual(again, result);
});

test('OFFICE04: blank, malformed, encrypted, macro, unsafe ZIP/XML and slide relationships release no source excerpts', { skip: !supported }, async t => {
  const cases = [['blank.docx', 'text_unavailable'], ['blank.pptx', 'text_unavailable'], ['malformed.docx', 'malformed'], ['encrypted.docx', 'encrypted'],
    ['macro.docx', 'unsupported'], ['unsafe.docx', 'unsupported'], ['duplicate.docx', 'unsupported'], ['entity.docx', 'unsupported'], ['utf16.docx', 'unsupported'],
    ['relationship.pptx', 'unsupported'], ['missing-slide.pptx', 'malformed'], ['wrong-content-type.pptx', 'unsupported'], ['missing-content-type.pptx', 'unsupported']];
  for (const [name, status] of cases) { const fx = await sourceFixture(t, name), result = await readSelectedOffice(fx.descriptor, fx.inventory, fx.chosen.id);
    assert.equal(result.office.extraction_status, status, name); assert.equal(result.office.coverage.state, 'unavailable'); assert.equal(result.text, '');
    assert.equal(result.sha256, sha('')); assert.deepEqual(result.office.sections, []); assert.equal(JSON.stringify(result).includes('MUST'), false); }
});

test('OFFICE05: tracked revisions, text boxes and mutually exclusive markup are explicitly omitted without duplicating text', { skip: !supported }, async t => {
  const revisions = await sourceFixture(t, 'revisions.docx'), revised = await readSelectedOffice(revisions.descriptor, revisions.inventory, revisions.chosen.id);
  assert.equal(revised.office.section_count, 3); assert.equal(revised.office.sections[0].text, 'Visible base paragraph.');
  assert.equal(revised.office.sections[1].text, ''); assert.equal(revised.office.sections[2].text, ''); assert.equal(revised.text.includes('MUST'), false);
  for (const reason of ['images_omitted', 'revisions_omitted', 'text_boxes_omitted', 'sections_without_extractable_text']) assert(revised.office.coverage.reasons.includes(reason));
  for (const [variant, omission] of [['only_revisions', 'revisions_omitted'], ['only_images', 'images_omitted']]) {
    const fx = await custom(await sourceFixture(t), variant), result = await readSelectedOffice(fx.descriptor, fx.inventory, fx.chosen.id);
    assert.equal(result.office.extraction_status, 'text_unavailable'); assert.equal(result.office.coverage.state, 'unavailable');
    assert.equal(result.text, ''); assert.deepEqual(result.office.sections, []);
    assert(result.office.coverage.reasons.includes('no_extractable_text')); assert(result.office.coverage.reasons.includes(omission));
    assert.equal(JSON.stringify(result).includes('CANARY'), false);
  }
  for (const name of ['markup.docx', 'markup.pptx']) { const fx = await sourceFixture(t, name), result = await readSelectedOffice(fx.descriptor, fx.inventory, fx.chosen.id);
    assert.match(result.text, /Visible legitimate base/); assert.equal(result.text.includes('MUST'), false); assert(result.office.coverage.reasons.includes('unsupported_markup_omitted')); }
});

test('OFFICE06: UTF-8 byte ranges include empty positions and main-body table order without rendering claims', { skip: !supported }, async t => {
  for (const variant of ['mixed', 'table', 'hyperlink']) { const fx = await custom(await sourceFixture(t), variant), result = await readSelectedOffice(fx.descriptor, fx.inventory, fx.chosen.id);
    if (variant === 'mixed') { assert.deepEqual(result.office.sections.map(section => section.text), ['α 😀', '', 'é\tline\nnext']); const blank = result.office.sections[1]; assert.equal(blank.byte_range.start, blank.byte_range.end); }
    if (variant === 'table') assert.deepEqual(result.office.sections.map(section => section.text), ['First paragraph.', 'Inside table.', 'Last paragraph.']);
    if (variant === 'hyperlink') { assert(result.office.coverage.reasons.includes('external_relationships_not_followed')); assert.equal(result.text.includes('https://'), false); }
    const bytes = Buffer.from(result.text); for (const section of result.office.sections) assert.equal(bytes.subarray(section.byte_range.start, section.byte_range.end).toString('utf8'), section.text);
  }
});

test('OFFICE07: actual NUL aliases, canonical path attacks, case duplicates, unused DTDs and unsafe internal relationships are refused', { skip: !supported }, async t => {
  for (const variant of ['nul', 'absolute', 'backslash', 'drive', 'dot', 'case_duplicate', 'declaration', 'unused_entity', 'bad_relationship', 'macro_type', 'malformed_xml']) {
    const fx = await custom(await sourceFixture(t), variant), result = await readSelectedOffice(fx.descriptor, fx.inventory, fx.chosen.id);
    assert.equal(result.office.extraction_status, variant === 'malformed_xml' ? 'malformed' : 'unsupported', variant);
    assert.equal(result.text, ''); assert.deepEqual(result.office.sections, []); assert.equal(JSON.stringify(result).includes('CANARY'), false);
  }
});

test('OFFICE08: archive, XML depth/size, section, text and combined provenance budgets withhold all partial content', { skip: !supported }, async t => {
  const bomb = await sourceFixture(t, 'bomb.docx'); await assert.rejects(readSelectedOffice(bomb.descriptor, bomb.inventory, bomb.chosen.id), { code: 'BUDGET_EXCEEDED' });
  for (const variant of ['many_entries', 'xml_limit', 'deep', 'sections', 'metadata', 'long']) { const fx = await custom(await sourceFixture(t), variant);
    await assert.rejects(readSelectedOffice(fx.descriptor, fx.inventory, fx.chosen.id, { maxBytes: OFFICE_LIMITS.maxTextBytes }), { code: 'BUDGET_EXCEEDED' }, variant); }
  const short = await sourceFixture(t); await assert.rejects(readSelectedOffice(short.descriptor, short.inventory, short.chosen.id, { maxBytes: 8 }), { code: 'BUDGET_EXCEEDED' });
  for (const options of [{ maxBytes: OFFICE_LIMITS.maxTextBytes + 1 }, { binary: '/bin/echo' }, { onPhase() {} }, { timeoutMs: 99 }]) await assert.rejects(readSelectedOffice(short.descriptor, short.inventory, short.chosen.id, options), { code: 'INVALID_INPUT' });
});

test('OFFICE15: contradictory local ZIP CRC and size metadata cannot become usable evidence', { skip: !supported }, async t => {
  for (const variant of ['local_crc', 'local_compressed', 'local_uncompressed']) {
    const fx = await custom(await sourceFixture(t), variant), result = await readSelectedOffice(fx.descriptor, fx.inventory, fx.chosen.id);
    assert.equal(result.office.extraction_status, 'malformed'); assert.deepEqual(result.office.coverage.reasons, ['malformed_archive']);
    assert.equal(result.text, ''); assert.deepEqual(result.office.sections, []);
  }
});

test('OFFICE16: genuine streaming ZIP descriptors are supported and contradictory trailing metadata is refused', { skip: !supported }, async t => {
  const valid = await custom(await sourceFixture(t), 'streaming'), result = await readSelectedOffice(valid.descriptor, valid.inventory, valid.chosen.id);
  assert.equal(result.office.extraction_status, 'available'); assert.equal(result.office.sections[0].text, 'VISIBLE SYNTHETIC TEXT');
  const broken = await custom(await sourceFixture(t), 'bad_descriptor'), refused = await readSelectedOffice(broken.descriptor, broken.inventory, broken.chosen.id);
  assert.equal(refused.office.extraction_status, 'malformed'); assert.deepEqual(refused.office.coverage.reasons, ['malformed_archive']); assert.equal(refused.text, '');
});

test('OFFICE09: unknown and wrong-kind selections refuse before any file-body read', { skip: !supported }, async t => {
  const fx = await sourceFixture(t); await writeFile(join(fx.root, 'plain.md'), 'Synthetic markdown');
  const inventory = await inventorySource(fx.descriptor), observations = [], adapter = createSourceAdapterForTests({ onBodyRead: value => observations.push(value) });
  await assert.rejects(adapter.readSelectedOffice(fx.descriptor, inventory, randomUUID()), { code: 'SCOPE_DENIED' });
  await assert.rejects(adapter.readSelectedOffice(fx.descriptor, inventory, inventory.entries.find(entry => entry.kind === 'markdown').id), { code: 'SCOPE_DENIED' });
  assert.deepEqual(observations, []);
});

test('OFFICE10: no-follow leaf substitution cannot read an outside document', { skip: !supported }, async t => {
  const fx = await sourceFixture(t), outside = join(fx.parent, 'outside.docx'); await copyFile(join(fixtures, 'blank.docx'), outside);
  const observations = []; let changed = false;
  const adapter = createSourceAdapterForTests({ onBodyRead: value => observations.push(value), onPhase: async value => {
    if (!changed && value.phase === 'before_file_open') { changed = true; await rm(fx.path); await symlink(outside, fx.path); }
  } });
  await assert.rejects(adapter.readSelectedOffice(fx.descriptor, fx.inventory, fx.chosen.id), { code: 'VERSION_MISMATCH' });
  assert(changed); assert.deepEqual(observations, []);
});

test('OFFICE11: post-parse source mutation or renamed selected root withholds the complete late result', { skip: !supported }, async t => {
  for (const mode of ['write', 'root']) { const fx = await sourceFixture(t); let parsed = false;
    const adapter = createSourceAdapterForTests({ onPhase: async value => { if (value.phase === 'after_office_parse') { parsed = true;
      if (mode === 'write') await writeFile(fx.path, await readFile(join(fixtures, 'blank.docx')));
      else { const { rename } = await import('node:fs/promises'); await rename(fx.root, join(fx.parent, 'moved')); await mkdir(fx.root); }
    } } });
    await assert.rejects(adapter.readSelectedOffice(fx.descriptor, fx.inventory, fx.chosen.id), { code: 'VERSION_MISMATCH' }); assert(parsed);
  }
});

test('OFFICE12: cancellation before/after parsing never releases late content', { skip: !supported }, async t => {
  for (const phase of ['before_office_parse', 'after_office_parse']) { const fx = await sourceFixture(t), controller = new AbortController(); let reached = false, spawned = false;
    const adapter = createSourceAdapterForTests({ onPhase: value => { if (value.phase === 'office_process_started') spawned = true; if (value.phase === phase) { reached = true; controller.abort(); } } });
    await assert.rejects(adapter.readSelectedOffice(fx.descriptor, fx.inventory, fx.chosen.id, { signal: controller.signal }), { code: 'CANCELLED' });
    assert(reached); if (phase === 'before_office_parse') assert.equal(spawned, false);
  }
});

for (const mode of ['cancel', 'timeout']) test(`OFFICE13: stopped actual stdlib child is killed on ${mode} before settlement`, { skip: !supported }, async t => {
  const fx = await sourceFixture(t), controller = new AbortController(); let pid;
  const adapter = createSourceAdapterForTests({ ...(mode === 'timeout' ? { officeTimeoutMs: 100 } : {}), onPhase: value => {
    if (value.phase === 'office_process_started') { pid = value.pid; process.kill(-pid, 'SIGSTOP'); if (mode === 'cancel') controller.abort(); }
  } });
  const started = Date.now(); await assert.rejects(adapter.readSelectedOffice(fx.descriptor, fx.inventory, fx.chosen.id, { signal: controller.signal }), { code: mode === 'cancel' ? 'CANCELLED' : 'BUDGET_EXCEEDED' });
  assert(pid); assert(Date.now() - started < 3000); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }); assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' });
});

test('OFFICE14: cleanup fallback cannot substitute for real child exit acknowledgement', { skip: !supported }, async t => {
  const fx = await sourceFixture(t), controller = new AbortController(), originalSpawn = childProcess.spawn; let child, observed = [], hold = true;
  childProcess.spawn = function (...args) { const result = originalSpawn.apply(this, args);
    if (args[1]?.includes(fileURLToPath(new URL('../packages/local-sources/src/office-text.py', import.meta.url)))) {
      child = result; const emit = result.emit;
      result.emit = function (event, ...values) { if (hold && ['exit', 'close'].includes(event)) { observed.push([event, values]); return true; } return emit.call(this, event, ...values); };
      result.releaseObserved = () => { hold = false; for (const [event, values] of observed) emit.call(result, event, ...values); observed = []; };
    } return result;
  }; syncBuiltinESMExports();
  let settled = false, operation;
  try { const adapter = createSourceAdapterForTests({ onPhase: value => { if (value.phase === 'office_process_started') controller.abort(); } });
    operation = adapter.readSelectedOffice(fx.descriptor, fx.inventory, fx.chosen.id, { signal: controller.signal }); operation.then(() => { settled = true; }, () => { settled = true; });
    await delay(2750); assert(child); assert(observed.some(([event]) => event === 'exit')); assert.equal(settled, false);
    child.releaseObserved(); await assert.rejects(operation, { code: 'CANCELLED' }); assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  } finally { child?.releaseObserved(); childProcess.spawn = originalSpawn; syncBuiltinESMExports(); await operation?.catch(() => {}); }
});

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, copyFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';
import * as source from '../packages/local-sources/src/index.mjs';

const native = ['darwin', 'linux'].includes(process.platform), API = '/api/local/v1', exec = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
let generated;
before(async () => {
  if (!native) return;
  generated = await realpath(await mkdtemp(join(tmpdir(), 'learnbridge-office-http-generated-')));
  await exec(fileURLToPath(new URL('../../.venv/bin/python3', import.meta.url)), ['-I', '-S', '-B',
    fileURLToPath(new URL('./fixtures/office-source-fixture.py', import.meta.url)), generated],
  { timeout: 10_000, maxBuffer: 32_000, env: { TZ: 'UTC' } });
}, { timeout: 15_000 });
after(async () => { if (generated) await rm(generated, { recursive: true }); });

async function fixture(t, adapter = source, options = {}) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'learnbridge-office-http-'))), root = join(parent, 'workspace'), selected = join(parent, 'selected');
  await mkdir(selected);
  for (const name of ['text.docx', 'ordered.pptx', 'blank.docx', 'blank.pptx', 'malformed.docx', 'encrypted.docx', 'entity.docx']) await copyFile(join(generated, name), join(selected, name));
  const runtime = await startRuntime({ dataRoot: root, port: 0, sourceAdapter: adapter, ...options });
  t.after(async () => { await runtime.close(); await rm(parent, { recursive: true }); });
  const pairing = await fetch(runtime.origin + API + '/pair', { method: 'POST', headers: { origin: runtime.origin, 'content-type': 'application/json' }, body: JSON.stringify({ code: runtime.createPairingCode() }) });
  assert.equal(pairing.status, 200); const cookie = pairing.headers.get('set-cookie').split(';')[0], nonce = (await pairing.json()).nonce;
  const call = async (path, method = 'GET', body) => {
    const result = await fetch(runtime.origin + API + path, { method, headers: { cookie, 'x-learnbridge-nonce': nonce,
      ...(method === 'GET' ? {} : { origin: runtime.origin, 'content-type': 'application/json' }) }, signal: AbortSignal.timeout(20_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: result.status, data: await result.json() };
  };
  const folder = await call('/sources', 'POST', { path: selected, label: 'Synthetic Office course' }); assert.equal(folder.status, 201);
  const inventory = await call(`/sources/${folder.data.source.id}/inventory`, 'POST', {}); assert.equal(inventory.status, 200);
  const importFile = name => call(`/sources/${folder.data.source.id}/import`, 'POST', { inventory_id: inventory.data.inventory.id, entry_id: inventory.data.inventory.inventory.entries.find(v => v.title === name).id });
  return { parent, root, runtime, call, folder: folder.data.source, inventory: inventory.data.inventory, importFile, selected };
}

test('Office HTTP → exact saved paragraphs/slides → real MCP → restart and backup restore', { skip: !native }, async t => {
  const fx = await fixture(t), docx = await fx.importFile('text.docx'), pptx = await fx.importFile('ordered.pptx');
  assert.equal(docx.status, 201); assert.equal(pptx.status, 201);
  const entries = [docx.data.entry, pptx.data.entry];
  assert.deepEqual(entries[0].office.sections.map(v => v.text), ['Synthetic course note λ café résumé.', 'Read this evidence, then explain one idea.']);
  assert.deepEqual(entries[1].office.sections.map(v => v.text), ['Second file, first presentation slide λ.', 'First file, second presentation slide café.']);
  for (const [index, entry] of entries.entries()) {
    assert.equal(entry.office.coverage.state, 'partial'); assert.ok(entry.office.coverage.reasons.includes('layout_not_preserved'));
    assert.equal(entry.office.source_sha256, hash(await readFile(join(fx.selected, index ? 'ordered.pptx' : 'text.docx'))));
    assert.equal(entry.sha256, hash(entry.text)); assert.deepEqual((await fx.call(`/source-entries/${entry.id}`)).data.entry, entry);
    for (const section of entry.office.sections) {
      assert.equal(Buffer.from(entry.text).subarray(section.byte_range.start, section.byte_range.end).toString('utf8'), section.text);
      assert.equal(section.sha256, hash(section.text));
    }
  }
  const listing = await fx.call('/sources'); assert.equal(listing.data.office_capability.state, 'available');
  assert.equal(JSON.stringify(listing.data).includes('Synthetic course note'), false);
  assert.ok(listing.data.entries.every(v => !('sections' in v.office)));
  const grant = await fx.call('/agent-grants', 'POST', { destination: 'codex', task_ids: [], document_ids: [], source_entry_ids: entries.map(v => v.id),
    expected_records: { tasks: [], documents: [], source_entries: entries.map(v => ({ id: v.id, revision: 1 })) }, max_bytes: 48000, expires_in_minutes: 10 }); assert.equal(grant.status, 201);
  const client = new Client({ name: 'synthetic-office-verifier', version: '1' }), transport = new StdioClientTransport({ command: '/usr/bin/env',
    args: ['-i', 'PATH=/usr/bin:/bin', process.execPath, fileURLToPath(new URL('../apps/local-runtime/src/mcp.mjs', import.meta.url)), '--data-root', fx.root, '--destination', 'codex'], stderr: 'pipe' });
  try {
    await client.connect(transport); const tools = await client.listTools();
    assert.match(tools.tools.find(v => v.name === 'learnbridge_context').description, /DOCX paragraph or PPTX presentation-order slide/);
    const reply = await client.callTool({ name: 'learnbridge_context', arguments: { grant_id: grant.data.grant.id } });
    assert.equal(reply.isError, undefined); const context = JSON.parse(reply.content[0].text);
    assert.equal(context.source_entries.length, 2);
    for (const entry of entries) assert.deepEqual(context.source_entries.find(v => v.id === entry.id).office, entry.office);
    assert.equal(JSON.stringify(context).includes(fx.selected), false); assert.equal(context.serialized_bytes, Buffer.byteLength(JSON.stringify(context)));
  } finally { await client.close(); }
  await fx.runtime.close(); const store = LocalStore.open({ root: fx.root });
  const backup = join(fx.parent, 'backup'), restored = join(fx.parent, 'restored');
  try { for (const entry of entries) assert.deepEqual(store.getSourceEntry(entry.id), entry); await store.backup(backup); } finally { store.close(); }
  await LocalStore.restore({ backupRoot: backup, root: restored }); const copy = LocalStore.open({ root: restored });
  try { for (const entry of entries) assert.deepEqual(copy.getSourceEntry(entry.id), entry); assert.equal(copy.integrity().source_office_provenance_count, 2); } finally { copy.close(); }
});

test('Office HTTP unavailable text, malformed, encrypted flag and DTD save no snapshot', { skip: !native }, async t => {
  const fx = await fixture(t);
  for (const [name, expected] of [['blank.docx', 'text_unavailable'], ['blank.pptx', 'text_unavailable'], ['malformed.docx', 'malformed'], ['encrypted.docx', 'encrypted'], ['entity.docx', 'unsupported']]) {
    const result = await fx.importFile(name); assert.equal(result.status, 200, name);
    assert.equal(result.data.imported, false); assert.equal(result.data.extraction_status, expected, name);
    assert.equal(result.data.coverage.state, 'unavailable'); assert.equal('entry' in result.data, false);
  }
  assert.deepEqual((await fx.call('/sources')).data.entries, []);
  await fx.runtime.close(); const store = LocalStore.open({ root: fx.root }); try { assert.equal(store.integrity().source_office_provenance_count, 0); } finally { store.close(); }
});

test('Office capability denial never falls through to a text reader', { skip: !native }, async t => {
  let reads = 0;
  const adapter = { ...source, probeOfficeCapability: async () => ({ state: 'unsupported', reason: 'fixture_runtime_unavailable' }),
    readSelectedOffice: async () => { reads++; throw new Error('must not read'); }, readSelectedEntry: async () => { reads++; throw new Error('must not fall through'); } };
  const fx = await fixture(t, adapter);
  assert.equal((await fx.call('/sources')).data.office_capability.state, 'unsupported');
  for (const name of ['text.docx', 'ordered.pptx']) assert.equal((await fx.importFile(name)).status, 501);
  assert.equal(reads, 0); assert.deepEqual((await fx.call('/sources')).data.entries, []);
});

for (const action of ['revoke', 'logout']) test(`${action} during actual Office extraction withholds acquired text and persists nothing`, { skip: !native }, async t => {
  let entered, release; const acquired = new Promise(done => { entered = done; }), resumed = new Promise(done => { release = done; });
  t.after(() => release());
  const adapter = { ...source, async readSelectedOffice(...args) { const value = await source.readSelectedOffice(...args); entered(value); await resumed; return value; } };
  const fx = await fixture(t, adapter), pending = fx.importFile('text.docx'); const value = await acquired; assert.equal(value.office.section_count, 2);
  const control = action === 'revoke' ? await fx.call(`/sources/${fx.folder.id}/revoke`, 'POST', { expected_revision: fx.folder.revision }) : await fx.call('/logout', 'POST', {});
  assert.equal(control.status, 200); release(); const rejected = await pending;
  assert.equal(rejected.status, action === 'revoke' ? 403 : 401); assert.deepEqual(Object.keys(rejected.data), ['error']);
  assert.equal(JSON.stringify(rejected.data).includes('Synthetic course note'), false);
  await fx.runtime.close(); const store = LocalStore.open({ root: fx.root });
  try { assert.deepEqual(store.listSourceEntries(), []); assert.equal(store.integrity().source_office_provenance_count, 0); } finally { store.close(); }
});

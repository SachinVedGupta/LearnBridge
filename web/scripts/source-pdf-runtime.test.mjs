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

const native = process.platform === 'darwin', API = '/api/local/v1', exec = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
let generated;
before(async () => {
  if (!native) return;
  generated = await realpath(await mkdtemp(join(tmpdir(), 'learnbridge-pdf-http-generated-')));
  await exec('/usr/bin/swift', ['-module-cache-path', join(generated, 'modules'), fileURLToPath(new URL('./fixtures/pdf-source-fixture.swift', import.meta.url)), generated],
    { timeout: 30_000, maxBuffer: 32_000, env: { PATH: '/usr/bin:/bin', HOME: generated, TMPDIR: generated } });
}, { timeout: 35_000 });
after(async () => { if (generated) await rm(generated, { recursive: true }); });
async function fixture(t, adapter = source) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'learnbridge-pdf-http-'))), root = join(parent, 'workspace'), selected = join(parent, 'selected');
  await mkdir(selected); for (const name of ['text.pdf', 'image.pdf', 'mixed.pdf']) await copyFile(join(generated, name), join(selected, name));
  const runtime = await startRuntime({ dataRoot: root, port: 0, sourceAdapter: adapter });
  t.after(async () => { await runtime.close(); await rm(parent, { recursive: true }); });
  const pairing = await fetch(runtime.origin + API + '/pair', { method: 'POST', headers: { origin: runtime.origin, 'content-type': 'application/json' }, body: JSON.stringify({ code: runtime.createPairingCode() }) });
  assert.equal(pairing.status, 200); const cookie = pairing.headers.get('set-cookie').split(';')[0], nonce = (await pairing.json()).nonce;
  const call = async (path, method = 'GET', body) => {
    const result = await fetch(runtime.origin + API + path, { method, headers: { cookie, 'x-learnbridge-nonce': nonce,
      ...(method === 'GET' ? {} : { origin: runtime.origin, 'content-type': 'application/json' }) }, signal: AbortSignal.timeout(40_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: result.status, data: await result.json() };
  };
  const folder = await call('/sources', 'POST', { path: selected, label: 'Synthetic PDF course' }); assert.equal(folder.status, 201);
  const inventory = await call(`/sources/${folder.data.source.id}/inventory`, 'POST', {}); assert.equal(inventory.status, 200);
  const importFile = name => call(`/sources/${folder.data.source.id}/import`, 'POST', { inventory_id: inventory.data.inventory.id, entry_id: inventory.data.inventory.inventory.entries.find(v => v.title === name).id });
  return { parent, root, runtime, call, folder: folder.data.source, importFile, selected };
}

test('PDF HTTP → exact saved read → real MCP context → backup restore preserves page citations', { skip: !native }, async t => {
  const fx = await fixture(t), response = await fx.importFile('text.pdf'); assert.equal(response.status, 201);
  const entry = response.data.entry; assert.equal(entry.pdf.page_count, 2); assert.equal(entry.pdf.source_sha256, hash(await readFile(join(fx.selected, 'text.pdf'))));
  assert.equal(entry.sha256, hash(entry.text)); assert.deepEqual((await fx.call(`/source-entries/${entry.id}`)).data.entry, entry);
  const listing = await fx.call('/sources'); assert.equal(listing.data.pdf_capability.state, 'available');
  assert.equal(JSON.stringify(listing.data).includes('Recursion'), false); assert.equal('pages' in listing.data.entries[0].pdf, false);
  const grant = await fx.call('/agent-grants', 'POST', { destination: 'codex', task_ids: [], document_ids: [], source_entry_ids: [entry.id],
    expected_records: { tasks: [], documents: [], source_entries: [{ id: entry.id, revision: 1 }] }, max_bytes: 48000, expires_in_minutes: 10 }); assert.equal(grant.status, 201);
  const client = new Client({ name: 'synthetic-pdf-verifier', version: '1' }), transport = new StdioClientTransport({ command: '/usr/bin/env',
    args: ['-i', 'PATH=/usr/bin:/bin', process.execPath, fileURLToPath(new URL('../apps/local-runtime/src/mcp.mjs', import.meta.url)), '--data-root', fx.root, '--destination', 'codex'], stderr: 'pipe' });
  try {
    await client.connect(transport); const reply = await client.callTool({ name: 'learnbridge_context', arguments: { grant_id: grant.data.grant.id } });
    assert.equal(reply.isError, undefined); const context = JSON.parse(reply.content[0].text);
    assert.equal(context.source_entries.length, 1); assert.deepEqual(context.source_entries[0].pdf, entry.pdf);
    assert.equal(JSON.stringify(context).includes(fx.selected), false); assert.equal(context.serialized_bytes, Buffer.byteLength(JSON.stringify(context)));
  } finally { await client.close(); }
  await fx.runtime.close(); const store = LocalStore.open({ root: fx.root });
  const backup = join(fx.parent, 'backup'), restored = join(fx.parent, 'restored');
  try { assert.deepEqual(store.getSourceEntry(entry.id), entry); await store.backup(backup); } finally { store.close(); }
  await LocalStore.restore({ backupRoot: backup, root: restored }); const copy = LocalStore.open({ root: restored });
  try { assert.deepEqual(copy.getSourceEntry(entry.id), entry); assert.equal(copy.integrity().source_provenance_count, 1); } finally { copy.close(); }
});

test('PDF HTTP unavailable scans save nothing; mixed handouts preserve explicit partial coverage', { skip: !native }, async t => {
  const fx = await fixture(t), image = await fx.importFile('image.pdf'); assert.equal(image.status, 200);
  assert.deepEqual(image.data, { imported: false, extraction_status: 'text_unavailable', coverage: { state: 'unavailable', reasons: ['no_extractable_text'] } });
  assert.deepEqual((await fx.call('/sources')).data.entries, []);
  const mixed = await fx.importFile('mixed.pdf'); assert.equal(mixed.status, 201); assert.equal(mixed.data.entry.pdf.coverage.state, 'partial');
  assert.equal(mixed.data.entry.pdf.pages[1].text, ''); assert.equal(mixed.data.entry.pdf.pages[1].byte_range.start, mixed.data.entry.pdf.pages[1].byte_range.end);
});

test('revoking a folder while real PDF extraction is held discards every page and persists nothing', { skip: !native }, async t => {
  let entered, release; const acquired = new Promise(done => { entered = done; }), resumed = new Promise(done => { release = done; });
  t.after(() => release());
  const adapter = { ...source, async readSelectedPdf(...args) { const value = await source.readSelectedPdf(...args); entered(value); await resumed; return value; } };
  const fx = await fixture(t, adapter), pending = fx.importFile('text.pdf'); const value = await acquired; assert.equal(value.pdf.page_count, 2);
  assert.equal((await fx.call(`/sources/${fx.folder.id}/revoke`, 'POST', { expected_revision: fx.folder.revision })).status, 200); release();
  const rejected = await pending; assert.equal(rejected.status, 403); assert.deepEqual(Object.keys(rejected.data), ['error']);
  assert.equal(JSON.stringify(rejected.data).includes('Recursion'), false); assert.deepEqual((await fx.call('/sources')).data.entries, []);
  await fx.runtime.close(); const store = LocalStore.open({ root: fx.root }); try { assert.equal(store.integrity().source_provenance_count, 0); } finally { store.close(); }
});

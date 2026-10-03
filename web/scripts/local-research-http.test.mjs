import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'learnbridge-research-http-')), dataRoot = join(base, 'private'), runtimes = [];
  t.after(async () => { for (const runtime of runtimes.reverse()) await runtime.close(); await rm(base, { recursive: true, force: true }); });
  async function start() { const runtime = await startRuntime({ dataRoot, port: 0 }); runtimes.push(runtime); return runtime; }
  return { start, runtime: await start() };
}
async function pair(runtime) {
  const response = await fetch(`${runtime.origin}/api/local/v1/pair`, { method: 'POST', headers: { Origin: runtime.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: runtime.createPairingCode() }) });
  assert.equal(response.status, 200); return { nonce: (await response.json()).nonce, cookie: response.headers.get('set-cookie').split(';')[0] };
}
async function call(runtime, session, path, { method = 'GET', body, origin = runtime.origin, headers = {} } = {}) {
  const response = await fetch(`${runtime.origin}/api/local/v1${path}`, { method, headers: { ...(session ? { Cookie: session.cookie, 'X-LearnBridge-Nonce': session.nonce } : {}), ...(method === 'GET' ? {} : { Origin: origin, 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}
const input = { kind: 'manual_url', url: 'https://www.mcmaster.ca/research?topic=fixture', title: 'Selected synthetic official passage', excerpt: 'PRIVATE_HTTP_RESEARCH_CANARY: Synthetic recursion requires a base case.', official_source_declared: true };
function reportBody(source) { const version = source.data.versions.at(-1), quote = 'Synthetic recursion requires a base case.', start = version.input.excerpt.indexOf(quote); return { title: 'Synthetic evidence report', claims: [{ id: 'claim', text: 'Recursion needs a base case.', kind: 'factual', evidence: [{ source_id: source.id, source_revision: source.revision, source_hash: version.version_hash, quote, range: { start, end: start + quote.length } }] }] }; }
const exactReport = report => ({ expected_revision: report.revision, report_hash: report.data.report_hash });
const exactPreview = preview => ({ preview_id: preview.id, expected_preview_revision: preview.revision, preview_hash: preview.data.preview_hash });

test('RH01 paired capture, citations, exact preview/export and retry survive actual runtime restart', async t => {
  const { runtime, start } = await fixture(t); let session = await pair(runtime);
  const captured = await call(runtime, session, '/research/sources', { method: 'POST', body: input, headers: { 'Idempotency-Key': 'research-http-capture-1' } }); assert.equal(captured.status, 201); const source = captured.data.item;
  assert.equal((await call(runtime, session, '/research/sources', { method: 'POST', body: input })).data.item.id, source.id); const list = await call(runtime, session, '/research/sources'); assert.equal(list.data.items.length, 1); assert.equal(JSON.stringify(list.data).includes('PRIVATE_HTTP_RESEARCH_CANARY'), false);
  const saved = await call(runtime, session, '/research/reports', { method: 'POST', body: reportBody(source), headers: { 'Idempotency-Key': 'research-http-report-1' } }); assert.equal(saved.status, 201); const report = saved.data.item;
  assert.equal((await call(runtime, session, `/research/reports/${report.id}/export`, { method: 'POST', body: { ...exactReport(report), approved: true } })).status, 400);
  const previewed = await call(runtime, session, `/research/reports/${report.id}/export-preview`, { method: 'POST', body: exactReport(report) }); assert.equal(previewed.status, 201); const preview = previewed.data.item;
  const exported = await call(runtime, session, `/research/reports/${report.id}/export`, { method: 'POST', body: exactPreview(preview) }); assert.equal(exported.status, 201); assert.equal(exported.data.verification, 'exact_local_readback'); assert.equal(exported.data.sharing, 'not_granted');
  const note = await call(runtime, session, `/documents/${exported.data.document.id}`); assert.equal(note.data.content, preview.data.preview.markdown); assert.equal(note.data.sha256, preview.data.preview.text_sha256); assert.equal((await call(runtime, session, '/agent-grants')).data.items.length, 0);
  await runtime.close(); const restarted = await start(); session = await pair(restarted); assert.equal((await call(restarted, session, '/research/reports')).data.items.length, 1); const retry = await call(restarted, session, `/research/reports/${report.id}/export`, { method: 'POST', body: exactPreview(preview) }); assert.equal(retry.status, 201); assert.equal(retry.data.document.id, exported.data.document.id); assert.equal((await call(restarted, session, '/documents')).data.items.length, 1);
  const removed = await call(restarted, session, `/research/sources/${source.id}`, { method: 'DELETE', body: { expected_revision: source.revision } }); assert.equal(removed.status, 200); assert.deepEqual(removed.data.retained_document_ids, [exported.data.document.id]); assert.equal((await call(restarted, session, '/research/reports')).data.items.length, 0);
});

test('RH02 source changes, forged quotes and changed export destination block exact HTTP effects', async t => {
  const { runtime } = await fixture(t), session = await pair(runtime); const source = (await call(runtime, session, '/research/sources', { method: 'POST', body: input })).data.item, body = reportBody(source);
  const forged = structuredClone(body); forged.claims[0].evidence[0].quote = 'Invented quotation'; assert.equal((await call(runtime, session, '/research/reports', { method: 'POST', body: forged })).status, 400);
  const report = (await call(runtime, session, '/research/reports', { method: 'POST', body })).data.item; const target = (await call(runtime, session, '/documents', { method: 'POST', body: { title: 'Original destination', content: 'Original text.' } })).data;
  const preview = (await call(runtime, session, `/research/reports/${report.id}/export-preview`, { method: 'POST', body: { ...exactReport(report), destination: { document_id: target.document.id, revision: target.document.revision, sha256: target.sha256 } } })).data.item;
  assert.equal((await call(runtime, session, `/documents/${target.document.id}`, { method: 'PATCH', body: { expected_revision: target.document.revision, content: 'Human concurrent edit.' } })).status, 200); assert.equal((await call(runtime, session, `/research/reports/${report.id}/export`, { method: 'POST', body: exactPreview(preview) })).status, 409); assert.equal((await call(runtime, session, `/documents/${target.document.id}`)).data.content, 'Human concurrent edit.');
  await call(runtime, session, '/research/sources', { method: 'POST', body: { ...input, excerpt: 'New selected evidence at the same URL.' } }); assert.equal((await call(runtime, session, `/research/reports/${report.id}`)).status, 409); assert.equal((await call(runtime, session, '/research/reports')).data.items[0].stale, true);
});

test('RH03 host pairing/origin/nonce/query boundaries protect research and expose no remote fetch/share routes', async t => {
  const { runtime } = await fixture(t); assert.equal((await call(runtime, null, '/research/sources')).status, 401); const session = await pair(runtime);
  assert.equal((await call(runtime, { ...session, nonce: 'forged' }, '/research/sources')).status, 403); assert.equal((await call(runtime, session, '/research/sources', { method: 'POST', body: input, origin: 'https://hostile.invalid' })).status, 403); assert.equal((await call(runtime, session, '/research/sources?secret=PRIVATE_QUERY_CANARY')).status, 400);
  assert.equal((await call(runtime, session, '/research/sources', { method: 'POST', body: { ...input, independently_retrieved: true } })).status, 400); assert.equal((await call(runtime, session, '/research/sources', { method: 'POST', body: { ...input, url: 'https://127.0.0.1/private' } })).status, 403);
  for (const path of ['/research/fetch', `/research/reports/${randomUUID()}/share`, '/research/remote-export']) assert.equal((await call(runtime, session, path, { method: 'POST', body: {} })).status, 404);
  assert.equal((await call(runtime, session, '/research/sources')).data.items.length, 0); assert.equal((await call(runtime, session, '/logout', { method: 'POST', body: {} })).status, 200); assert.equal((await call(runtime, session, '/research/reports')).status, 401);
});

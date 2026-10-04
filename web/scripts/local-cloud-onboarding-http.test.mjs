import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { createCloudBundle } from '../apps/local-runtime/src/cloud-onboarding.mjs';
const API = '/api/local/v1', BODY = 'SYNTHETIC_CLOUD_HTTP_SELECTED_BODY';
const sha = value => createHash('sha256').update(value).digest('hex');
function bundle(text = BODY) { return createCloudBundle({ format: 'learnbridge-selected-cloud-export', schema_version: 1, origin: 'https://learnbridge.example', owner: { student_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', verification: 'supabase_session_at_fetch' }, provider: 'googledocs', account_id: 'ca_synthetic_alice', academic_policy: 'learning_support', retrieved_at: new Date().toISOString(), records: [{ id: 'synthetic_http_doc', title: 'Synthetic selected cloud notes', url: 'https://docs.google.com/document/d/synthetic_http_doc/edit', modified_at: null, text, sha256: sha(text), coverage: 'partial_text', limitations: ['Original visuals not checked.'] }], limitations: ['Selected returned text only.'] }); }
async function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-cloud-http-')), root = join(parent, 'workspace'); let runtime;
  t.after(async () => { await runtime?.close(); rmSync(parent, { recursive: true, force: true }); });
  async function pair() {
    const response = await fetch(runtime.origin + API + '/pair', { method: 'POST', headers: { Origin: runtime.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: runtime.createPairingCode() }) }); assert.equal(response.status, 200);
    const session = await response.json(), cookie = response.headers.get('set-cookie').split(';')[0], origin = runtime.origin;
    return async (path, body, method = body === undefined ? 'GET' : 'POST', headers = {}) => { const requestHeaders = { Cookie: cookie, Origin: origin, 'X-LearnBridge-Nonce': session.nonce, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }; for (const [name, value] of Object.entries(requestHeaders)) if (value === null) delete requestHeaders[name]; const response = await fetch(origin + API + path, { method, headers: requestHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json(), headers: response.headers }; };
  }
  async function restart(dataRoot = root) { await runtime?.close(); runtime = await startRuntime({ dataRoot, port: 0, hostAdapter: { enabled: false } }); return pair(); }
  return { parent, root, pair, restart, close: () => runtime.close(), get origin() { return runtime.origin; }, call: await restart() };
}
async function preview(call, selected = bundle()) { const response = await call('/cloud-onboarding/preview', { bundle: selected, academic_policy: 'learning_support' }); assert.equal(response.status, 200, JSON.stringify(response.data)); return response.data; }
const save = (call, selected) => call('/cloud-onboarding/imports', { preview_id: selected.preview_id, review_hash: selected.preview.review_hash, confirm_owner: true });
test('CHTTP01: actual paired route imports exact selected text, preserves unrelated notes and creates no sharing/profile/task side effects', async t => {
  const f = await fixture(t); const unrelated = await f.call('/documents', { title: 'Unrelated synthetic note', content: 'SYNTHETIC_UNRELATED_KEEP' }); assert.equal(unrelated.status, 201);
  const selected = await preview(f.call); assert.equal(selected.preview.owner_verification, 'bundle_reported_needs_student_confirmation'); assert.equal((await f.call('/documents')).data.items.length, 1);
  const imported = await save(f.call, selected); assert.equal(imported.status, 201); const item = imported.data.item; assert.equal(item.state, 'active'); assert.equal(item.notes.length, 1); assert.equal(item.source_freshness, 'not_checked');
  const saved = await f.call(`/documents/${item.notes[0].id}`); assert.ok(saved.data.content.startsWith(BODY)); assert.equal(sha(saved.data.content), item.notes[0].sha256); assert.equal(saved.data.document.academic_policy, 'learning_support');
  assert.equal((await f.call(`/documents/${unrelated.data.document.id}`)).data.content, 'SYNTHETIC_UNRELATED_KEEP'); assert.equal((await f.call('/tasks')).data.items.length, 0); assert.equal((await f.call('/profile')).data.items.length, 0); assert.equal((await f.call('/agent-grants')).data.items.length, 0);
  const metadata = await f.call('/cloud-onboarding/imports'); assert.equal(JSON.stringify(metadata.data).includes(BODY), false); assert.equal(metadata.headers.get('cache-control'), 'private, no-store');
});
test('CHTTP02: pairing, nonce, same-origin, method, strict body and hash/owner review prevent forged or cross-session imports', async t => {
  const f = await fixture(t), selected = await preview(f.call), body = { preview_id: selected.preview_id, review_hash: selected.preview.review_hash, confirm_owner: true };
  assert.equal((await f.call('/cloud-onboarding/imports', body, 'POST', { Cookie: '' })).status, 401); assert.equal((await f.call('/cloud-onboarding/imports', body, 'POST', { 'X-LearnBridge-Nonce': 'foreign' })).status, 403); assert.equal((await f.call('/cloud-onboarding/imports', body, 'POST', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.call('/cloud-onboarding/imports', { ...body, student_id: selected.preview.student_id })).status, 400); assert.equal((await f.call('/cloud-onboarding/imports', { ...body, review_hash: '0'.repeat(64) })).status, 403); assert.equal((await f.call('/cloud-onboarding/imports', { ...body, confirm_owner: false })).status, 403);
  assert.equal((await f.call('/cloud-onboarding/imports?account=all')).status, 400); assert.equal((await f.call('/cloud-onboarding/preview')).status, 405);
  const other = await f.pair(); assert.equal((await save(other, selected)).status, 403); assert.equal((await f.call('/documents')).data.items.length, 0);
});
test('CHTTP03: consumed preview retry is idempotent while current; competing previews and changed notes cannot silently import again', async t => {
  const f = await fixture(t), a = await preview(f.call), b = await preview(f.call); const imported = await save(f.call, a); assert.equal(imported.status, 201); assert.equal((await save(f.call, a)).status, 200); assert.equal((await save(f.call, b)).status, 409); assert.equal((await f.call('/documents')).data.items.length, 1);
  const note = imported.data.item.notes[0]; assert.equal((await f.call(`/documents/${note.id}`, { expected_revision: note.revision, content: 'Student manual edits retained.' }, 'PATCH')).status, 200);
  assert.equal((await save(f.call, a)).status, 409); assert.equal((await f.call('/cloud-onboarding/preview', { bundle: a.preview.bundle, academic_policy: 'learning_support' })).status, 409); assert.equal((await f.call(`/documents/${note.id}`)).data.content, 'Student manual edits retained.');
});
test('CHTTP04: more than ten successful reviewed imports do not exhaust pending-preview quota or duplicate unchanged text', async t => {
  const f = await fixture(t); let first;
  for (let index = 0; index < 12; index++) { const selected = await preview(f.call); first ||= selected; assert.ok([200, 201].includes((await save(f.call, selected)).status)); }
  assert.equal((await f.call('/documents')).data.items.length, 1); assert.equal((await f.call('/cloud-onboarding/imports')).data.items.length, 1); assert.equal((await save(f.call, first)).status, 403);
  for (let index = 0; index < 10; index++) await preview(f.call); assert.equal((await f.call('/cloud-onboarding/preview', { bundle: bundle(), academic_policy: 'learning_support' })).status, 429); assert.equal((await f.call('/documents')).data.items.length, 1);
});
test('CHTTP05: exact source-receipt removal retains private copies, and a fresh review creates a new import generation', async t => {
  const f = await fixture(t), imported = await save(f.call, await preview(f.call)), item = imported.data.item;
  assert.equal((await f.call(`/cloud-onboarding/imports/${item.id}`, { expected_revision: item.revision - 1 }, 'DELETE')).status, 409);
  const removed = await f.call(`/cloud-onboarding/imports/${item.id}`, { expected_revision: item.revision }, 'DELETE'); assert.equal(removed.status, 200); assert.ok(removed.data.retention.includes('notes')); assert.equal((await f.call('/cloud-onboarding/imports')).data.items.length, 0); assert.equal((await f.call('/documents')).data.items.length, 1);
  const reimport = await save(f.call, await preview(f.call)); assert.equal(reimport.status, 201); assert.notEqual(reimport.data.item.notes[0].id, item.notes[0].id); assert.equal((await f.call('/documents')).data.items.length, 2);
});
test('CHTTP06: imported exact copies/receipt survive restart and fresh backup restore; temporary previews do not', async t => {
  const f = await fixture(t), selected = await preview(f.call), imported = await save(f.call, selected), item = imported.data.item;
  let call = await f.restart(); assert.equal((await save(call, selected)).status, 403); assert.deepEqual((await call(`/cloud-onboarding/imports/${item.id}`)).data.item, item); const before = (await call(`/documents/${item.notes[0].id}`)).data;
  await f.close(); const store = LocalStore.open({ root: f.root }); try { await store.backup(join(f.parent, 'backup')); } finally { store.close(); }
  const restored = join(f.parent, 'restored'); await LocalStore.restore({ backupRoot: join(f.parent, 'backup'), root: restored }); call = await f.restart(restored);
  assert.deepEqual((await call(`/cloud-onboarding/imports/${item.id}`)).data.item, item); assert.deepEqual((await call(`/documents/${item.notes[0].id}`)).data, before); assert.equal((await call('/agent-grants')).data.items.length, 0);
});
test('CHTTP07: local reviewed transfer import works without cloud, Supabase or model credentials and grants no access', async t => {
  const names = ['COMPOSIO_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
  const previous = names.map(name => [name, process.env[name]]); for (const name of names) delete process.env[name];
  t.after(() => { for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const f = await fixture(t), selected = await preview(f.call), imported = await save(f.call, selected);
  assert.equal(imported.status, 201); assert.equal(imported.data.item.owner_verification, 'student_confirmed_bundle_reported'); assert.equal(imported.data.item.source_freshness, 'not_checked');
  assert.ok((await f.call(`/documents/${imported.data.item.notes[0].id}`)).data.content.startsWith(BODY)); assert.equal((await f.call('/agent-grants')).data.items.length, 0);
});
test('CHTTP08: paired browser-style metadata GET without Origin succeeds while an import POST still requires Origin', async t => {
  const f = await fixture(t); const before = await f.call('/cloud-onboarding/imports', undefined, 'GET', { Origin: null }); assert.equal(before.status, 200); assert.deepEqual(before.data.items, []);
  const selected = await preview(f.call), denied = await f.call('/cloud-onboarding/imports', { preview_id: selected.preview_id, review_hash: selected.preview.review_hash, confirm_owner: true }, 'POST', { Origin: null }); assert.equal(denied.status, 403); assert.equal((await f.call('/documents')).data.items.length, 0);
  const imported = await save(f.call, selected); assert.equal(imported.status, 201); const metadata = await f.call('/cloud-onboarding/imports', undefined, 'GET', { Origin: null }); assert.equal(metadata.status, 200); assert.equal(metadata.data.items.length, 1); assert.equal(JSON.stringify(metadata.data).includes(BODY), false);
});

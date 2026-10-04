import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { createCloudBundle, validateCloudBundle, createCloudOnboarding, CLOUD_LIMITS } from '../apps/local-runtime/src/cloud-onboarding.mjs';
import { createCloudOnboardingRoutes } from '../apps/local-runtime/src/cloud-onboarding-routes.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const denied = (action, code) => assert.throws(action, error => error.code === code);
function bundle({ count = 2, text = 'Synthetic cloud source, not personal data.', timestamp = '2026-10-04T12:00:00.000Z', policy = 'learning_support', provider = 'googledocs' } = {}) {
  return createCloudBundle({ format: 'learnbridge-selected-cloud-export', schema_version: 1, origin: 'https://learnbridge.example', owner: { student_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', verification: 'supabase_session_at_fetch' },
    provider, account_id: 'ca_synthetic_alice', academic_policy: policy, retrieved_at: timestamp,
    records: Array.from({ length: count }, (_, index) => { const id = provider === 'notion' ? `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${index}` : `synthetic_doc_${index}`; return { id, title: `Synthetic item ${index}`, url: provider === 'notion' ? `https://www.notion.so/${id.replaceAll('-', '')}` : `https://docs.google.com/document/d/${id}/edit`, modified_at: '2026-10-04T10:00:00.000Z', text, sha256: sha(text), coverage: 'partial_text', limitations: ['Original visual content not checked.'] }; }), limitations: ['Only explicitly selected returned text is exported.'] });
}
function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-cloud-onboarding-')), root = join(parent, 'workspace'); let store = LocalStore.open({ root }), now = '2026-10-04T12:01:00.000Z';
  t.after(() => { store.close(); rmSync(parent, { recursive: true, force: true }); });
  return { parent, root, get store() { return store; }, get service() { return createCloudOnboarding(store, { clock: () => now }); }, clock: () => now,
    advance(ms) { now = new Date(Date.parse(now) + ms).toISOString(); }, restart() { store.close(); store = LocalStore.open({ root }); } };
}
const preview = (f, selected = bundle(), policy = 'learning_support') => f.service.preview({ bundle: selected, academic_policy: policy });
const save = (service, selected) => service.import(selected, { review_hash: selected.review_hash, confirm_owner: true });
const proxy = (store, override) => new Proxy(store, { get(target, key) { if (override[key]) return override[key]; const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; } });

test('CLOUD01: exact reviewed selected bundle creates only private source notes and receipt, without sharing or profile synthesis', t => {
  const f = fixture(t), selected = preview(f), before = f.store.integrity(); const item = save(f.service, selected);
  assert.equal(item.state, 'active'); assert.equal(item.notes.length, 2); assert.equal(item.owner_verification, 'student_confirmed_bundle_reported'); assert.equal(item.source_freshness, 'not_checked'); assert.equal(item.sharing, 'not_granted');
  for (const note of item.notes) { const saved = f.store.getDocument(note.id); assert.equal(saved.sha256, note.sha256); assert.ok(saved.text.startsWith('Synthetic cloud source')); assert.ok(saved.text.includes('Hosted student ID (bundle reported)')); assert.equal(saved.document.academic_policy, 'learning_support'); }
  assert.equal(f.store.listAgentGrants().length, 0); assert.equal(f.store.listTasks().length, 0); assert.equal(f.store.listWorkspaceRecords({ kind: 'profile_fact' }).length, 0); assert.equal(f.store.integrity().schema_version, before.schema_version);
});
test('CLOUD02: bundle canonicalization binds every selected field and accepts Notion identifiers without accepting credential fields', () => {
  const value = bundle({ provider: 'notion' }); assert.deepEqual(validateCloudBundle(value), value);
  for (const mutate of [v => v.records[0].text += 'forged', v => v.records[0].sha256 = 'A'.repeat(64), v => v.owner.student_id = randomUUID(), v => v.records[0].title = 'changed', v => v.account_id = 'another_account']) { const copy = structuredClone(value); mutate(copy); denied(() => validateCloudBundle(copy), 'VERSION_MISMATCH'); }
  for (const field of ['access_token', 'api_key', 'oauth_secret', 'destination', 'auto_share']) denied(() => validateCloudBundle({ ...value, [field]: 'never allowed' }), 'INVALID_INPUT');
});
test('CLOUD03: strict bounds, source URLs, XML-safe text and plain data objects fail before storage', () => {
  const body = bundle(); const { bundle_hash, ...raw } = body;
  denied(() => createCloudBundle({ ...raw, records: [] }), 'BUDGET_EXCEEDED'); denied(() => bundle({ count: 4 }), 'BUDGET_EXCEEDED');
  denied(() => bundle({ text: 'é'.repeat(10001) }), 'BUDGET_EXCEEDED'); assert.equal(bundle({ count: 1, text: 'a'.repeat(CLOUD_LIMITS.textBytes) }).records[0].text.length, 20000);
  for (const url of ['http://docs.google.com/document/d/synthetic_doc_0/edit', 'https://evil.example/x', 'https://docs.google.com/document/d/synthetic_doc_1/edit', 'https://docs.google.com/document/d/synthetic_doc_0/edit?token=secret']) denied(() => createCloudBundle({ ...raw, records: [{ ...raw.records[0], url }] }), 'INVALID_INPUT');
  denied(() => createCloudBundle({ ...raw, records: [raw.records[0], raw.records[0]] }), 'INVALID_INPUT');
  let reads = 0; const accessor = {}; Object.defineProperty(accessor, 'records', { enumerable: true, get() { reads++; return []; } }); denied(() => validateCloudBundle(accessor), 'INVALID_INPUT'); assert.equal(reads, 0);
  const cycle = {}; cycle.self = cycle; denied(() => validateCloudBundle(cycle), 'INVALID_INPUT'); denied(() => validateCloudBundle(Object.create(raw)), 'INVALID_INPUT');
  denied(() => bundle({ text: '\ud800' }), 'INVALID_INPUT');
});
test('CLOUD04: preview is read-only and exact owner confirmation, hash, workspace identity and expiry are required', t => {
  const f = fixture(t), selected = preview(f); assert.equal(f.store.listDocuments().length, 0); assert.equal(f.store.listWorkspaceRecords().length, 0);
  for (const body of [{ review_hash: selected.review_hash, confirm_owner: false }, { review_hash: '0'.repeat(64), confirm_owner: true }, { review_hash: selected.review_hash, confirm_owner: true, auto_share: true }]) denied(() => f.service.import(selected, body), body.auto_share ? 'INVALID_INPUT' : 'CONSENT_REQUIRED');
  const changed = structuredClone(selected); changed.bundle.records[0].text += 'bad'; denied(() => save(f.service, changed), 'CONSENT_REQUIRED');
  f.advance(300001); denied(() => save(f.service, selected), 'CONSENT_REQUIRED'); assert.equal(f.store.listDocuments().length, 0);
});
test('CLOUD05: per-bundle graded restrictions cannot be weakened by the local import selection', t => {
  const f = fixture(t), selected = preview(f, bundle({ policy: 'graded_restricted' }), 'unrestricted'); assert.equal(selected.academic_policy, 'graded_restricted');
  const item = save(f.service, selected); for (const note of item.notes) assert.equal(f.store.getDocument(note.id).document.academic_policy, 'graded_restricted');
});
test('CLOUD06: semantically unchanged newer retrieval updates observation metadata without duplicate private notes', t => {
  const f = fixture(t), item = save(f.service, preview(f)); f.advance(60000);
  const next = preview(f, bundle({ timestamp: '2026-10-04T12:02:00.000Z' })); assert.equal(next.change, 'unchanged'); const observed = save(f.service, next);
  assert.equal(observed.id, item.id); assert.equal(observed.revision, item.revision + 1); assert.deepEqual(observed.notes, item.notes); assert.equal(observed.last_observed_at, '2026-10-04T12:02:00.000Z'); assert.equal(f.store.listDocuments().length, 2);
});
test('CLOUD07: competing previews reject stale CAS and do not create competing copies', t => {
  const f = fixture(t), a = preview(f), b = preview(f); save(f.service, a); denied(() => save(f.service, b), 'REVISION_CONFLICT'); assert.equal(f.store.listDocuments().length, 2);
});
test('CLOUD08: locally modified or removed imported notes refuse unchanged-source reuse', t => {
  const f = fixture(t), item = save(f.service, preview(f)); const note = item.notes[0]; f.store.updateDocument(note.id, { text: 'Student manual changes preserved.' }, note.revision);
  assert.equal(f.service.list()[0].notes_current, false); denied(() => preview(f), 'REVISION_CONFLICT'); assert.equal(f.store.getDocument(note.id).text, 'Student manual changes preserved.');
  f.store.deleteDocument(item.notes[1].id, item.notes[1].revision); assert.equal(f.service.get(item.id).notes_current, false);
});
test('CLOUD09: changed cloud content creates new copies without overwriting earlier student-edited notes', t => {
  const f = fixture(t), item = save(f.service, preview(f)); f.store.updateDocument(item.notes[0].id, { text: 'Keep my edits.' }, 1);
  const next = save(f.service, preview(f, bundle({ text: 'Changed synthetic cloud version.' }))); assert.equal(next.id, item.id); assert.notDeepEqual(next.notes, item.notes); assert.equal(f.store.listDocuments().length, 4); assert.equal(f.store.getDocument(item.notes[0].id).text, 'Keep my edits.');
});
for (const stage of ['second_note', 'note_receipt', 'final_receipt']) test(`CLOUD10-${stage}: interrupted import resumes after restart without duplicate notes or false success`, t => {
  const f = fixture(t); let creates = 0, fired = false;
  const wrapped = proxy(f.store, { createDocument(input, options) { creates++; if (!fired && stage === 'second_note' && creates === 2) { fired = true; throw new Error('SYNTHETIC_FAIL'); } return f.store.createDocument(input, options); },
    updateWorkspaceRecord(id, patch) { if (!fired && ((stage === 'note_receipt' && patch.data.notes.length === 1) || (stage === 'final_receipt' && patch.data.state === 'active'))) { fired = true; throw new Error('SYNTHETIC_FAIL'); } return f.store.updateWorkspaceRecord(id, patch); } });
  const service = createCloudOnboarding(wrapped, { clock: f.clock }), selected = service.preview({ bundle: bundle(), academic_policy: 'learning_support' }); assert.throws(() => save(service, selected), /SYNTHETIC_FAIL/);
  assert.equal(f.service.list()[0].state, 'importing'); f.restart(); const next = preview(f); assert.equal(next.change, 'resume_incomplete'); const item = save(f.service, next); assert.equal(item.state, 'active'); assert.equal(item.notes.length, 2); assert.equal(f.store.listDocuments().length, 2); assert.equal(f.store.listAgentGrants().length, 0);
});
test('CLOUD11: changed orphaned note after an interrupted note receipt refuses reconciliation rather than trusting the creation journal', t => {
  const f = fixture(t); let fired = false; const wrapped = proxy(f.store, { updateWorkspaceRecord(id, patch) { if (!fired && patch.data.notes.length === 1) { fired = true; throw new Error('SYNTHETIC_FAIL'); } return f.store.updateWorkspaceRecord(id, patch); } });
  const service = createCloudOnboarding(wrapped, { clock: f.clock }); assert.throws(() => save(service, service.preview({ bundle: bundle(), academic_policy: 'learning_support' })), /SYNTHETIC_FAIL/);
  const note = f.store.listDocuments()[0]; f.store.updateDocument(note.id, { text: 'Manual change during interruption.' }, note.revision); f.restart(); denied(() => save(f.service, preview(f)), 'REVISION_CONFLICT'); assert.equal(f.store.listDocuments().length, 1); assert.equal(f.service.list()[0].state, 'importing');
});
test('CLOUD12: forgetting source receipts requires exact revision, retains separate notes and permits fresh explicit reimport', t => {
  const f = fixture(t), item = save(f.service, preview(f)); denied(() => f.service.forget(item.id, item.revision - 1), 'REVISION_CONFLICT'); f.service.forget(item.id, item.revision); assert.equal(f.service.list().length, 0); assert.equal(f.store.listDocuments().length, 2); denied(() => f.service.get(item.id), 'SCOPE_DENIED');
  const next = save(f.service, preview(f)); assert.equal(next.id, item.id); assert.notDeepEqual(next.notes, item.notes); assert.equal(f.store.listDocuments().length, 4);
});
test('CLOUD13: source metadata listing omits every original text body and a foreign local identity cannot commit its preview', t => {
  const a = fixture(t), b = fixture(t), selected = preview(a); denied(() => save(b.service, selected), 'CONSENT_REQUIRED'); const item = save(a.service, selected); const serialized = JSON.stringify(a.service.list()); assert.equal(serialized.includes('Synthetic cloud source, not personal data.'), false); assert.equal(serialized.includes('"text":'), false); assert.equal(b.store.listDocuments().length, 0); assert.equal(a.service.get(item.id).source_freshness, 'not_checked');
});
test('CLOUD14: paired route previews are session-bound, capped, consumed safely, replayable while current and evicted with no effect', async t => {
  const f = fixture(t), routes = createCloudOnboardingRoutes({ store: f.store, clock: f.clock }), session = { nonce: 'synthetic-owner-nonce' };
  async function request(route, method, body, selectedSession = session) { return routes.handle({ route, method, session: selectedSession, privateBody: async (allowed, required) => { assert.ok(required.every(key => Object.hasOwn(body, key))); assert.ok(Object.keys(body).every(key => allowed.includes(key))); return body; } }); }
  const previews = [];
  for (let index = 0; index < 10; index++) previews.push((await request('/cloud-onboarding/preview', 'POST', { bundle: bundle(), academic_policy: 'learning_support' })).data);
  await assert.rejects(request('/cloud-onboarding/preview', 'POST', { bundle: bundle(), academic_policy: 'learning_support' }), error => error.status === 429); assert.equal(f.store.listDocuments().length, 0);
  const first = previews[0], body = { preview_id: first.preview_id, review_hash: first.preview.review_hash, confirm_owner: true };
  await assert.rejects(request('/cloud-onboarding/imports', 'POST', body, { nonce: 'foreign' }), error => error.status === 403);
  const imported = await request('/cloud-onboarding/imports', 'POST', body); assert.equal(imported.status, 201); assert.equal((await request('/cloud-onboarding/imports', 'POST', body)).status, 200);
  await request('/cloud-onboarding/preview', 'POST', { bundle: bundle(), academic_policy: 'learning_support' }); await assert.rejects(request('/cloud-onboarding/imports', 'POST', body), error => error.status === 403); assert.equal(f.store.listDocuments().length, 2);
  routes.clear(); await assert.rejects(request('/cloud-onboarding/imports', 'POST', { preview_id: previews[1].preview_id, review_hash: previews[1].preview.review_hash, confirm_owner: true }), error => error.status === 403);
});
test('CLOUD15: the complete bundle including its hash must fit, so every created boundary bundle validates', () => {
  const { bundle_hash, ...raw } = bundle({ count: 3, text: '' });
  const newlineCount = Math.floor((CLOUD_LIMITS.bundleBytes - Buffer.byteLength(JSON.stringify(raw))) / 6);
  const fill = count => ({ ...raw, records: raw.records.map(record => ({ ...record, text: '\n'.repeat(count), sha256: sha('\n'.repeat(count)) })) });
  const near = fill(newlineCount); assert.ok(Buffer.byteLength(JSON.stringify(near)) <= CLOUD_LIMITS.bundleBytes); assert.ok(newlineCount <= CLOUD_LIMITS.textBytes);
  denied(() => createCloudBundle(near), 'BUDGET_EXCEEDED');
  const accepted = createCloudBundle(fill(newlineCount - 20)); assert.ok(Buffer.byteLength(JSON.stringify(accepted)) <= CLOUD_LIMITS.bundleBytes); assert.deepEqual(validateCloudBundle(accepted), accepted);
});

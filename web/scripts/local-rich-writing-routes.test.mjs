import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { createWritingService } from '../apps/local-runtime/src/writing-service.mjs';
import { handleRichWritingRoute } from '../apps/local-runtime/src/rich-writing-routes.mjs';
import { verifyRichWritingDownload } from '../apps/local/public/rich-writing.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const review = record => ({ expected_revision: record.revision, payload_hash: record.data.payload_hash });
const FORMATS = ['docx', 'tex'];
function fixture(t, policy = 'learning_support') {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-rich-route-')), root = join(parent, 'workspace'); let store = LocalStore.open({ root });
  t.after(() => { store.close(); rmSync(parent, { recursive: true, force: true }); });
  const source = store.createDocument({ title: 'Selected course notes', text: 'Original notes\nSYNTHETIC_RICH_SELECTED_CANARY', academic_policy: policy });
  store.createDocument({ title: 'Unselected private notes', text: 'SYNTHETIC_RICH_UNSELECTED_CANARY' });
  const reference = { id: source.document.id, revision: source.document.revision, sha256: source.sha256 };
  return { parent, root, source, reference, get store() { return store; }, get service() { return createWritingService({ store }); },
    restart() { store.close(); store = LocalStore.open({ root }); },
    async restore() { const backup = join(parent, 'backup'); await store.backup(backup); store.close(); const restored = join(parent, 'restored'); await LocalStore.restore({ backupRoot: backup, root: restored }); store = LocalStore.open({ root: restored }); } };
}
function propose(f, { title = 'Résumé / & report', kind = 'revision', policy = 'learning_support', origin = 'agent_paste' } = {}) {
  return f.service.createProposal({ title, kind, draft_text: '# Reviewed notes\nA **bold** and *italic* résumé line.\n- One\n2. Two\nSYNTHETIC_RICH_SELECTED_CANARY',
    source_documents: [f.reference], academic_policy: policy, origin });
}
function exportRoute(f, record, format, body = review(record), extra = {}) {
  return handleRichWritingRoute({ route: `/writing/items/${record.id}/${format === 'docx' ? 'export-formatted-docx' : 'export-tex'}`, method: 'POST', privateBody: async () => body, store: f.store, session: { nonce: 'synthetic-paired-route' }, ...extra });
}
function snapshot(f) { return { documents: f.store.listDocuments().map(document => ({ current: f.store.getDocument(document.id), history: f.store.listDocumentRevisions(document.id) })),
  records: f.store.listWorkspaceRecords({ kind: 'artifact' }), grants: f.store.listAgentGrants() }; }
async function exported(f, record, format) {
  const response = await exportRoute(f, record, format); assert.equal(response.status, 200); const result = response.data;
  assert.equal(result.sharing, 'not_granted'); assert.equal(result.visual_review, 'pending'); assert.equal(result.content_status, record.data.content_status);
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_RICH_UNSELECTED_CANARY'), false); assert.ok(result.filename.endsWith(`.${format}`)); assert.equal(/[\/\\]/.test(result.filename), false);
  const bytes = format === 'docx' ? Buffer.from(result.base64, 'base64') : Buffer.from(result.text); assert.equal(bytes.length, result.byte_length); assert.equal(sha(bytes), result.sha256);
  const verified = await verifyRichWritingDownload(result, record, format); assert.deepEqual(Buffer.from(verified), bytes);
  return result;
}

test('RWR01: only exact accepted current saved content is formatted; both exports preserve all source, note, record, history and sharing state', async t => {
  const f = fixture(t), pending = propose(f), accepted = f.service.accept(pending.id, review(pending)), before = snapshot(f);
  for (const format of FORMATS) {
    const first = await exported(f, accepted, format), second = await exported(f, accepted, format); assert.deepEqual(first, second);
    const saved = f.store.getDocument(accepted.data.accepted_note.id); assert.equal(first.manifest.original_text_sha256, saved.sha256);
    assert.equal(first.manifest.original_text_bytes, Buffer.byteLength(saved.text)); assert.deepEqual(first.manifest.provenance.writing_record, { id: accepted.id, revision: accepted.revision, payload_hash: accepted.data.payload_hash, state: 'accepted' });
  }
  assert.deepEqual(snapshot(f), before); assert.equal(f.store.getDocument(f.source.document.id).text, f.source.text);
});

test('RWR02: applied revision exports pin its actual new source revision and retain original version/history', async t => {
  const f = fixture(t), pending = propose(f, { origin: 'student' }), applied = f.service.acceptRevision(pending.id, review(pending)), before = snapshot(f);
  for (const format of FORMATS) { const result = await exported(f, applied, format); assert.equal(result.document.id, f.source.document.id); assert.equal(result.document.revision, 2); assert.equal(result.content_status, 'student_reviewed_content'); assert.equal(result.manifest.provenance.writing_record.state, 'applied_revision'); }
  assert.deepEqual(snapshot(f), before); assert.equal(f.store.listDocumentRevisions(f.source.document.id)[0].text, f.source.text);
});

test('RWR03: unpaired/malformed authority or non-POST methods fail; unrelated routes are untouched', async t => {
  const f = fixture(t), pending = propose(f), accepted = f.service.accept(pending.id, review(pending));
  for (const format of FORMATS) {
    for (const session of [null, {}, { nonce: '' }, { nonce: 1 }]) await assert.rejects(exportRoute(f, accepted, format, review(accepted), { session }), { code: 'AUTH_REQUIRED' });
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) await assert.rejects(exportRoute(f, accepted, format, review(accepted), { method }), { code: 'INVALID_INPUT' });
  }
  assert.equal(await handleRichWritingRoute({ route: '/writing/items', method: 'GET' }), null);
  assert.equal(await handleRichWritingRoute({ route: `/writing/items/${accepted.id}/export-tex?path=/private`, method: 'POST' }), null);
});

test('RWR04: clients cannot replace saved text, output paths, formats, provenance or exact revision/hash authority', async t => {
  const f = fixture(t), pending = propose(f), accepted = f.service.accept(pending.id, review(pending)), exact = review(accepted), before = snapshot(f);
  for (const format of FORMATS) {
    for (const body of [{}, { expected_revision: 0, payload_hash: exact.payload_hash }, { expected_revision: '2', payload_hash: exact.payload_hash },
      ...['text', 'filename', 'path', 'provenance', 'format', 'sharing', 'confirmed'].map(field => ({ ...exact, [field]: 'PRIVATE_RICH_CANARY' }))]) {
      await assert.rejects(exportRoute(f, accepted, format, body), { code: 'INVALID_INPUT' });
    }
    await assert.rejects(exportRoute(f, accepted, format, { ...exact, payload_hash: 'f'.repeat(64) }), { code: 'REVISION_CONFLICT' });
    await assert.rejects(exportRoute(f, accepted, format, review(pending)), error => ['CONSENT_REQUIRED', 'REVISION_CONFLICT'].includes(error.code));
  }
  assert.deepEqual(snapshot(f), before);
});

test('RWR05: pending, rejected, forgotten, cross-workspace and non-writing records never become formatted downloads', async t => {
  const f = fixture(t), second = fixture(t), pending = propose(f);
  for (const format of FORMATS) await assert.rejects(exportRoute(f, pending, format), { code: 'CONSENT_REQUIRED' });
  const rejected = f.service.reject(pending.id, review(pending)); for (const format of FORMATS) await assert.rejects(exportRoute(f, rejected, format), { code: 'CONSENT_REQUIRED' });
  const next = propose(f), accepted = f.service.accept(next.id, review(next));
  for (const format of FORMATS) await assert.rejects(exportRoute(second, accepted, format), { code: 'SCOPE_DENIED' });
  f.service.forget(accepted.id, accepted.revision); for (const format of FORMATS) await assert.rejects(exportRoute(f, accepted, format), { code: 'SCOPE_DENIED' });
  const wrong = { ...accepted, id: randomUUID() }; for (const format of FORMATS) await assert.rejects(exportRoute(f, wrong, format), { code: 'SCOPE_DENIED' });
});

test('RWR06: edited/deleted selected sources, accepted copies or applied revisions invalidate both export formats', async t => {
  for (const mode of ['source_edit', 'source_delete', 'accepted_edit', 'accepted_delete', 'applied_edit']) {
    const f = fixture(t), pending = propose(f), accepted = mode === 'applied_edit' ? f.service.acceptRevision(pending.id, review(pending)) : f.service.accept(pending.id, review(pending));
    const target = mode.startsWith('accepted') ? accepted.data.accepted_note : mode === 'applied_edit' ? accepted.data.applied_note : f.reference;
    if (mode.endsWith('delete')) f.store.deleteDocument(target.id, target.revision); else f.store.updateDocument(target.id, { text: 'Later independent student edit.' }, target.revision);
    const before = snapshot(f); for (const format of FORMATS) await assert.rejects(exportRoute(f, accepted, format), { code: 'REVISION_CONFLICT' }); assert.deepEqual(snapshot(f), before);
  }
});

test('RWR07: graded scaffolding exports retain the original policy, review status and unverified-fact warning', async t => {
  const f = fixture(t, 'graded_restricted'); assert.throws(() => propose(f, { policy: 'unrestricted' }), { code: 'SCOPE_DENIED' });
  const pending = propose(f, { policy: 'unrestricted', kind: 'outline' }), accepted = f.service.accept(pending.id, review(pending)), before = snapshot(f);
  for (const format of FORMATS) { const result = await exported(f, accepted, format); assert.equal(result.manifest.provenance.academic_policy, 'graded_restricted'); assert.equal(result.document.academic_policy, 'graded_restricted'); assert.equal(result.content_status, 'student_reviewed_model_output_facts_unverified'); }
  assert.deepEqual(snapshot(f), before);
});

test('RWR08: restart and fresh verified backup restore preserve deterministic rich bytes and source review pins', async t => {
  const f = fixture(t), pending = propose(f), accepted = f.service.accept(pending.id, review(pending));
  const original = await Promise.all(FORMATS.map(format => exported(f, accepted, format))), before = snapshot(f); f.restart();
  assert.deepEqual(await Promise.all(FORMATS.map(format => exported(f, accepted, format))), original); assert.deepEqual(snapshot(f), before); await f.restore();
  assert.deepEqual(await Promise.all(FORMATS.map(format => exported(f, accepted, format))), original); assert.deepEqual(snapshot(f), before);
});

test('RWR09: client verification rejects altered file bytes, filename, format, pin, record and policy before preparing a download', async t => {
  const f = fixture(t), pending = propose(f), accepted = f.service.accept(pending.id, review(pending));
  for (const format of FORMATS) {
    const original = await exported(f, accepted, format);
    for (const patch of [{ sha256: 'f'.repeat(64) }, { byte_length: original.byte_length + 1 }, { filename: '../PRIVATE_RICH_CANARY.' + format }, { mime: 'text/html' },
      { sharing: 'granted' }, { visual_review: 'verified' }, { content_status: 'facts_verified' }, { document: { ...original.document, revision: original.document.revision + 1 } },
      { manifest: { ...original.manifest, original_text_sha256: 'f'.repeat(64) } }, { manifest: { ...original.manifest, rendering: 'unbounded_html' } }]) {
      await assert.rejects(verifyRichWritingDownload({ ...original, ...patch }, accepted, format), /No file was prepared/);
    }
    const modifiedBytes = format === 'docx' ? Buffer.from(original.base64, 'base64') : null; if (modifiedBytes) modifiedBytes[80] ^= 1;
    const tampered = format === 'docx' ? { ...original, base64: modifiedBytes.toString('base64') } : { ...original, text: original.text + '\\input{bad}\n' };
    await assert.rejects(verifyRichWritingDownload(tampered, accepted, format), /No file was prepared/);
    await assert.rejects(verifyRichWritingDownload(original, { ...accepted, revision: accepted.revision + 1 }, format), /No file was prepared/);
  }
});

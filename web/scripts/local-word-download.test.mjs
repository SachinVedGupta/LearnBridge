import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWordTextArtifact, WORD_TEXT_MIME } from '../apps/local-runtime/src/word-text-artifact.mjs';
import { verifyWordDownload } from '../apps/local/public/writing.js';

// Real formatter bytes, client verifier only. No DOM, file download, Office app,
// provider or model is invoked; package rendering is a separate release check.
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const clone = value => structuredClone(value);
const ids = {
  writing: '11111111-1111-4111-8111-111111111111',
  destination: '22222222-2222-4222-8222-222222222222',
  sourceA: '33333333-3333-4333-8333-333333333333',
  sourceB: '44444444-4444-4444-8444-444444444444',
  other: '55555555-5555-4555-8555-555555555555',
};
function fixture({ state = 'accepted', text = 'Reviewed synthetic text. 🧠\r\nKeep <tags>, & punctuation literal.\n\nA final line.\tTab.', modelOutput = false } = {}) {
  const document = { id: ids.destination, revision: state === 'applied_revision' ? 4 : 1, sha256: sha(text) };
  const sources = state === 'applied_revision' ? [
    { id: document.id, revision: document.revision - 1, sha256: sha('Synthetic original before the applied revision'), title: 'Synthetic original', academic_policy: 'learning_support' },
  ] : [
    { id: ids.sourceB, revision: 3, sha256: sha('Synthetic second source'), title: 'Second synthetic source' },
    { id: ids.sourceA, revision: 1, sha256: sha('Synthetic first source'), title: 'First synthetic source' },
  ];
  const payload = { title: 'Reviewed synthetic writing', kind: state === 'applied_revision' ? 'revision' : 'markdown_artifact',
    origin: modelOutput ? 'agent_paste' : 'student', draft_text: text, draft_sha256: sha(text), academic_policy: 'learning_support', source_documents: sources };
  const record = { id: ids.writing, revision: 2, title: 'Reviewed synthetic writing', data: {
    format: 'writing_proposal', state, payload, payload_hash: sha(canonical(payload)), source_documents: sources,
    academic_policy: 'learning_support', content_status: modelOutput ? 'student_reviewed_model_output_facts_unverified' : 'student_reviewed_content',
    [state === 'applied_revision' ? 'applied_note' : 'accepted_note']: document,
  } };
  const generated = createWordTextArtifact({ text, provenance: {
    writing_record: { id: record.id, revision: record.revision, payload_hash: record.data.payload_hash, state },
    document, source_documents: sources.map(({ id, revision, sha256 }) => ({ id, revision, sha256 })),
    academic_policy: record.data.academic_policy, content_status: record.data.content_status,
  } });
  const result = {
    filename: 'Synthetic-reviewed-writing.docx', mime: WORD_TEXT_MIME, encoding: 'base64',
    base64: generated.bytes.toString('base64'), byte_length: generated.bytes.length, sha256: sha(generated.bytes),
    manifest: generated.manifest, document: { ...document, title: record.title }, source_documents: sources,
    validation: 'fixed_ooxml_structure_and_exact_text_hash', sharing: 'not_granted', content_status: record.data.content_status,
    visual_review: 'pending', warning: 'Synthetic text export; visual review remains pending.',
  };
  return { record, result, bytes: generated.bytes };
}
function mutated(change) {
  const valid = fixture(); const result = clone(valid.result), record = clone(valid.record); change(result, record); return { result, record };
}
async function refuses(change) {
  const { result, record } = mutated(change);
  await assert.rejects(verifyWordDownload(result, record));
}

test('WORD-CLIENT01: real formatter receipt verifies exact bytes for accepted student content without mutating either input', async () => {
  const { result, record, bytes } = fixture(); const beforeResult = clone(result), beforeRecord = clone(record);
  const verified = await verifyWordDownload(result, record);
  assert.ok(verified instanceof Uint8Array); assert.deepEqual(Buffer.from(verified), bytes);
  assert.equal(sha(verified), result.sha256); assert.equal(verified.byteLength, result.byte_length);
  assert.deepEqual(result, beforeResult); assert.deepEqual(record, beforeRecord);
});

test('WORD-CLIENT02: applied revision uses its applied-note pin and model-output status stays explicitly unverified', async () => {
  const { result, record, bytes } = fixture({ state: 'applied_revision', modelOutput: true });
  assert.deepEqual(Buffer.from(await verifyWordDownload(result, record)), bytes);
  assert.equal(result.manifest.provenance.content_status, 'student_reviewed_model_output_facts_unverified');
  assert.equal(result.visual_review, 'pending'); assert.equal(result.sharing, 'not_granted');
  const alternate = clone(record); alternate.data.applied_note.sha256 = sha('Different applied copy');
  await assert.rejects(verifyWordDownload(result, alternate));
});

test('WORD-CLIENT03: provenance source order is irrelevant while exact source identity, revision and hash remain required', async () => {
  const { result, record, bytes } = fixture(); const reversed = clone(result);
  reversed.manifest.provenance.source_documents.reverse();
  assert.deepEqual(Buffer.from(await verifyWordDownload(reversed, record)), bytes);
  for (const change of [
    value => { value.manifest.provenance.source_documents[0].id = ids.other; },
    value => { value.manifest.provenance.source_documents[0].revision++; },
    value => { value.manifest.provenance.source_documents[0].sha256 = sha('Different source'); },
    value => { value.manifest.provenance.source_documents.pop(); },
    value => { value.manifest.provenance.source_documents.push(value.manifest.provenance.source_documents[0]); },
    value => { value.manifest.provenance.source_documents = null; },
  ]) await refuses(change);
});

test('WORD-CLIENT04: changed bytes and false hash receipts are rejected even when size and ZIP signature still agree', async () => {
  await refuses(result => {
    const bytes = Buffer.from(result.base64, 'base64'); bytes[bytes.length - 5] ^= 1; result.base64 = bytes.toString('base64');
  });
  await refuses(result => { result.sha256 = sha('Not this Word package'); });
  await refuses(result => { result.sha256 = result.sha256.toUpperCase(); });
  await refuses(result => { result.sha256 = 'wrong'; });
});

test('WORD-CLIENT05: decoded size must equal the positive bounded integer receipt', async () => {
  for (const length of [0, -1, 0.5, 512001, Number.MAX_SAFE_INTEGER, NaN, Infinity, '100']) {
    await refuses(result => { result.byte_length = length; });
  }
  await refuses(result => { result.byte_length--; });
  await refuses(result => { result.byte_length++; });
});

test('WORD-CLIENT06: valid hash cannot turn a non-ZIP signature or too-short byte string into a Word download', async () => {
  for (const bytes of [Buffer.from('PK\x03'), Buffer.from('TEXT'), Buffer.from([80, 75, 5, 6])]) {
    await refuses(result => { result.base64 = bytes.toString('base64'); result.byte_length = bytes.length; result.sha256 = sha(bytes); });
  }
  await refuses(result => {
    const bytes = Buffer.from(result.base64, 'base64'); bytes[0] = 0; result.base64 = bytes.toString('base64'); result.sha256 = sha(bytes);
  });
});

test('WORD-CLIENT07: only canonical padded standard base64 is accepted', async () => {
  for (const change of [
    result => { result.base64 = ' '; }, result => { result.base64 = '\n' + result.base64; },
    result => { result.base64 += '\n'; }, result => { result.base64 = result.base64.slice(1); },
    result => { result.base64 = result.base64.replace(/^./, '-'); }, result => { result.base64 = '===='; },
    result => { result.base64 = 'A=== '; }, result => { result.base64 = null; },
  ]) await refuses(change);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'; let valid;
  for (let suffix = 0; suffix < 3; suffix++) {
    const candidate = fixture({ text: 'Padding fixture' + 'x'.repeat(suffix) });
    if (candidate.result.base64.endsWith('=')) { valid = candidate; break; }
  }
  assert.ok(valid, 'Actual formatter should produce a padded fixture');
  const canonical = valid.result.base64; const index = canonical.endsWith('==') ? canonical.length - 3 : canonical.length - 2;
  const padIndex = alphabet.indexOf(canonical[index]); assert.equal(padIndex % (canonical.endsWith('==') ? 16 : 4), 0);
  const noncanonical = clone(valid.result); noncanonical.base64 = canonical.slice(0, index) + alphabet[padIndex + 1] + canonical.slice(index + 1);
  assert.deepEqual(Buffer.from(noncanonical.base64, 'base64'), valid.bytes, 'Unused padding bits do not change decoded bytes');
  await assert.rejects(verifyWordDownload(noncanonical, valid.record));
  assert.deepEqual(Buffer.from(await verifyWordDownload(valid.result, valid.record)), valid.bytes);
});

test('WORD-CLIENT08: oversized encoded payloads are refused before preparation', async () => {
  await refuses(result => { result.base64 = 'A'.repeat(682672); });
});

test('WORD-CLIENT09: content type, encoding, validation, visual status and sharing must match the inert text-export contract', async () => {
  for (const [key, value] of [
    ['mime', 'application/msword'], ['mime', WORD_TEXT_MIME + '; charset=utf-8'], ['encoding', 'hex'],
    ['validation', 'model_says_valid'], ['visual_review', 'verified'], ['sharing', 'granted'],
  ]) await refuses(result => { result[key] = value; });
});

test('WORD-CLIENT10: filename is a bounded basename ending in docx, never a path or executable suffix', async () => {
  for (const name of ['../bad.docx', '/tmp/bad.docx', 'folder/bad.docx', 'C:\\bad.docx', '.hidden.docx', '-flag.docx', 'bad.docm', 'bad.docx.exe', 'bad\n.docx', 'bad name.docx', 'x'.repeat(96) + '.docx', '', null]) {
    await refuses(result => { result.filename = name; });
  }
  const { result, record, bytes } = fixture(); result.filename = 'Étude_学習.docx';
  assert.deepEqual(Buffer.from(await verifyWordDownload(result, record)), bytes);
});

test('WORD-CLIENT11: manifest format, schema, generator and normalization are fixed versions', async () => {
  for (const [key, value] of [
    ['format', 'other-artifact'], ['schema_version', 2], ['generator_version', 'unreviewed-generator'],
    ['normalization', 'strip_all_whitespace'], ['original_text_sha256', sha('Other original')],
    ['normalized_text_sha256', 'invalid-normalized-hash'],
  ]) await refuses(result => { result.manifest[key] = value; });
  await refuses(result => { result.manifest = null; });
  await refuses(result => { result.manifest.provenance = null; });
});

test('WORD-CLIENT12: destination record ID, revision and content hash must match the accepted-note pin', async () => {
  for (const [key, value] of [['id', ids.other], ['revision', 2], ['sha256', sha('Other accepted copy')]]) {
    await refuses(result => { result.manifest.provenance.document[key] = value; });
  }
  await refuses(result => { result.document.id = ids.other; });
  await refuses(result => { result.document.revision++; });
  await refuses(result => { result.document = null; });
});

test('WORD-CLIENT13: writing record identity, revision, payload hash and review state bind provenance', async () => {
  for (const [key, value] of [['id', ids.other], ['revision', 3], ['payload_hash', sha('Other proposal')], ['state', 'applied_revision']]) {
    await refuses(result => { result.manifest.provenance.writing_record[key] = value; });
  }
  await refuses(result => { result.manifest.provenance.writing_record = null; });
  await refuses((_result, record) => { record.revision++; });
  await refuses((_result, record) => { record.id = ids.other; });
  await refuses((_result, record) => { record.data.payload_hash = sha('Changed proposal'); });
});

test('WORD-CLIENT14: academic policy and reviewed content status cannot change through provenance', async () => {
  await refuses(result => { result.manifest.provenance.academic_policy = 'unrestricted'; });
  await refuses(result => { result.manifest.provenance.content_status = 'facts_verified'; });
  await refuses(result => { result.manifest.provenance.content_status = 'student_reviewed_model_output_facts_unverified'; });
});

test('WORD-CLIENT15: recipe, awaiting, rejected and unknown states cannot download a reviewed artifact', async () => {
  for (const state of ['awaiting_review', 'rejected', 'recipe', 'needs_reconciliation', 'unknown', null]) {
    await refuses((_result, record) => { record.data.state = state; });
  }
  await refuses((_result, record) => { delete record.data.accepted_note; });
});

test('WORD-CLIENT16: duplicate receipt fields cannot contradict the exact document, sources, rendering or review limits', async () => {
  for (const change of [
    result => { result.document.sha256 = sha('Different top-level destination content'); },
    result => { delete result.document.sha256; },
    result => { result.content_status = 'facts_verified'; },
    result => { result.content_status = 'student_reviewed_model_output_facts_unverified'; },
    result => { result.source_documents[0].id = ids.other; },
    result => { result.source_documents[0].revision++; },
    result => { result.source_documents[0].sha256 = sha('Different top-level source'); },
    result => { result.source_documents = []; },
    result => { result.source_documents = null; },
    result => { result.manifest.rendering = 'rich_markdown'; },
    result => { result.manifest.visual_review = 'verified'; },
    result => { result.manifest.sharing = 'granted'; },
  ]) await refuses(change);
  const { result, record, bytes } = fixture(); result.source_documents.reverse();
  assert.deepEqual(Buffer.from(await verifyWordDownload(result, record)), bytes);
});

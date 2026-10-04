import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createWordTextArtifact, WORD_TEXT_LIMITS, WORD_TEXT_MIME, WORD_TEXT_VERSION } from '../apps/local-runtime/src/word-text-artifact.mjs';
import { runOfficeParser } from '../packages/local-sources/src/office-native.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const PYTHON = fileURLToPath(new URL('../../.venv/bin/python3', import.meta.url));
const VERIFIER = fileURLToPath(new URL('./fixtures/word-artifact-verify.py', import.meta.url));
const TEXT = '  # Literal title & <xml> "quotes" \'apostrophes\' 😀 café 文本  \r\n\t- A list remains literal\r\n\r\nCitation: https://example.com/course?q=one&two=three\rFinal line\n';
function input(text = TEXT, extra = {}) {
  return { text, provenance: { writing_record: { id: randomUUID(), revision: 2, payload_hash: sha('exact reviewed proposal'), state: 'accepted' },
    document: { id: randomUUID(), revision: 1, sha256: sha(text) }, source_documents: [{ id: randomUUID(), revision: 4, sha256: sha('selected source') }],
    academic_policy: 'learning_support', content_status: 'student_reviewed_model_output_facts_unverified', ...extra } };
}
function verify(value, artifact = createWordTextArtifact(value)) {
  const request = Buffer.from(JSON.stringify({ expected_text: value.text, expected_manifest: artifact.manifest }) + '\n');
  const result = spawnSync(PYTHON, ['-I', '-S', '-B', '-X', 'utf8', VERIFIER], { input: Buffer.concat([request, artifact.bytes]),
    env: { TZ: 'UTC' }, encoding: 'utf8', timeout: 5000, maxBuffer: 200000 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  const readback = JSON.parse(result.stdout); assert.equal(readback.status, 'PASS'); assert.equal(readback.sha256, sha(artifact.bytes));
  assert.equal(readback.byte_length, artifact.bytes.length); assert.equal(readback.normalized_text_sha256, artifact.manifest.normalized_text_sha256);
  return readback;
}
function code(action, expected = 'INVALID_INPUT') { assert.throws(action, error => error.code === expected && !error.message.includes('PRIVATE_WORD_CANARY')); }

test('Word text is independently reopened with literal Unicode, whitespace, tabs, CR normalization, provenance and no external relationships', () => {
  const value = input(), artifact = createWordTextArtifact(value), readback = verify(value, artifact);
  assert.equal(WORD_TEXT_MIME, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(artifact.manifest.generator_version, WORD_TEXT_VERSION); assert.equal(artifact.manifest.original_text_sha256, sha(value.text));
  assert.equal(artifact.manifest.normalized_text_sha256, sha(value.text.replace(/\r\n?/g, '\n')));
  assert.equal(readback.paragraph_count, 6); assert.equal(readback.part_count, 6); assert.equal(readback.external_relationships, 0);
  assert.equal(artifact.manifest.visual_review, 'pending'); assert.equal(artifact.manifest.sharing, 'not_granted');
  assert.equal(JSON.stringify(artifact.manifest).includes('https://example.com/course'), false);
});

test('fixed ZIP metadata and canonical source ordering produce identical bytes without retaining mutable input references', () => {
  const value = input(); value.provenance.source_documents.push({ id: randomUUID(), revision: 1, sha256: sha('another selected source') });
  const first = createWordTextArtifact(value), reordered = structuredClone(value); reordered.provenance.source_documents.reverse();
  const second = createWordTextArtifact(reordered); assert.deepEqual(first.bytes, second.bytes); assert.deepEqual(first.manifest, second.manifest); verify(value, first);
  const previous = first.manifest.provenance.document.revision; value.provenance.document.revision++;
  assert.equal(first.manifest.provenance.document.revision, previous);
  assert.throws(() => { first.manifest.provenance.document.revision++; }, TypeError);
});

test('strict object and array contracts reject accessors, unknown keys, cycles, custom prototypes, sparse and duplicate source lists', () => {
  let called = false; const value = input(); Object.defineProperty(value, 'text', { enumerable: true, get() { called = true; return 'PRIVATE_WORD_CANARY'; } });
  code(() => createWordTextArtifact(value)); assert.equal(called, false);
  const getterPin = input(); Object.defineProperty(getterPin.provenance.source_documents[0], 'sha256', { enumerable: true, get() { called = true; return sha(TEXT); } });
  code(() => createWordTextArtifact(getterPin)); assert.equal(called, false);
  const symbol = input(); symbol[Symbol('private')] = 'PRIVATE_WORD_CANARY'; code(() => createWordTextArtifact(symbol));
  const extra = input(); extra.provenance.private_path = '/PRIVATE_WORD_CANARY'; code(() => createWordTextArtifact(extra));
  const cycle = input(); cycle.provenance.writing_record = cycle.provenance; code(() => createWordTextArtifact(cycle));
  const custom = input(); Object.setPrototypeOf(custom.provenance.document, { path: '/PRIVATE_WORD_CANARY' }); code(() => createWordTextArtifact(custom));
  const sparse = input(); sparse.provenance.source_documents = Array(1); code(() => createWordTextArtifact(sparse));
  const duplicate = input(); duplicate.provenance.source_documents.push({ ...duplicate.provenance.source_documents[0] }); code(() => createWordTextArtifact(duplicate));
  const injected = input(); injected.provenance.source_documents.path = '/PRIVATE_WORD_CANARY'; code(() => createWordTextArtifact(injected));
  const noText = input(); delete noText.text; code(() => createWordTextArtifact(noText));
});

test('only exact current reviewed document hashes and bounded typed provenance are accepted', () => {
  const mismatch = input(); mismatch.provenance.document.sha256 = sha('changed saved text'); code(() => createWordTextArtifact(mismatch), 'VERSION_MISMATCH');
  for (const [key, wrong] of [['state', 'awaiting_review'], ['revision', 0], ['revision', 1.5], ['id', '../PRIVATE_WORD_CANARY'], ['payload_hash', 'x'.repeat(64)]]) {
    const value = input(); value.provenance.writing_record[key] = wrong; code(() => createWordTextArtifact(value));
  }
  for (const [key, wrong] of [['academic_policy', 'completed_graded_answer'], ['content_status', 'facts_verified']]) { const value = input(); value.provenance[key] = wrong; code(() => createWordTextArtifact(value)); }
  const value = input('', { source_documents: [] }); code(() => createWordTextArtifact(value));
  const independent = input('Student-authored body.', { source_documents: [], content_status: 'student_reviewed_content' }); verify(independent);
  const applied = input(); applied.provenance.writing_record.state = 'applied_revision'; verify(applied);
});

test('invalid XML characters and lone surrogates fail without silent text sanitization', () => {
  for (const character of ['\0', '\x01', '\x08', '\x0b', '\x0c', '\x0e', '\x1f', '\ufffe', '\uffff', '\ud800', '\udfff']) code(() => createWordTextArtifact(input(`PRIVATE_WORD_CANARY${character}after`)));
  const value = input('A\tB\rC\nD\u007f\u0085\u2028\u2029😀e\u0301'); verify(value);
});

test('input bytes, paragraph count, output bytes and selected-source bounds are enforced at actual boundaries', () => {
  const bytes = input('a'.repeat(WORD_TEXT_LIMITS.inputBytes)); verify(bytes);
  const unicode = input('😀'.repeat(WORD_TEXT_LIMITS.inputBytes / 4)); verify(unicode);
  code(() => createWordTextArtifact(input('a'.repeat(WORD_TEXT_LIMITS.inputBytes + 1))), 'BUDGET_EXCEEDED');
  code(() => createWordTextArtifact(input('😀'.repeat(WORD_TEXT_LIMITS.inputBytes / 4) + 'x')), 'BUDGET_EXCEEDED');
  const lines = input('a\n'.repeat(WORD_TEXT_LIMITS.paragraphs - 1)); assert.equal(verify(lines).paragraph_count, WORD_TEXT_LIMITS.paragraphs);
  code(() => createWordTextArtifact(input('a\n'.repeat(WORD_TEXT_LIMITS.paragraphs))), 'BUDGET_EXCEEDED');
  code(() => createWordTextArtifact(input('\t'.repeat(WORD_TEXT_LIMITS.inputBytes - 1) + 'x')), 'BUDGET_EXCEEDED');
  const sources = input(); sources.provenance.source_documents = Array.from({ length: WORD_TEXT_LIMITS.sourceDocuments }, () => ({ id: randomUUID(), revision: 1, sha256: sha('selected') })); verify(sources);
  sources.provenance.source_documents.push({ id: randomUUID(), revision: 1, sha256: sha('one too many') }); code(() => createWordTextArtifact(sources));
});

test('independent verifier rejects corrupted bytes and trailing data instead of accepting the generator report', () => {
  const value = input(), artifact = createWordTextArtifact(value);
  for (const bytes of [Buffer.concat([artifact.bytes, Buffer.from('hidden trailing data')]), Buffer.from(artifact.bytes)]) {
    if (bytes.length === artifact.bytes.length) bytes[80] ^= 1;
    const result = spawnSync(PYTHON, ['-I', '-S', '-B', '-X', 'utf8', VERIFIER], { input: Buffer.concat([Buffer.from(JSON.stringify({ expected_text: value.text, expected_manifest: artifact.manifest }) + '\n'), bytes]), env: { TZ: 'UTC' }, timeout: 5000 });
    assert.equal(result.status, 1); assert.match(result.stderr.toString(), /WORD_TEXT_FIXTURE_VERIFICATION_FAILED/);
  }
});

test('existing bounded Office parser independently extracts every normalized Word paragraph including blank and final lines', async () => {
  const value = input(), artifact = createWordTextArtifact(value), readback = await runOfficeParser(artifact.bytes, { documentType: 'docx', maxTextBytes: 48000 });
  assert.equal(readback.status, 'available'); assert.deepEqual(readback.sections, value.text.replace(/\r\n?/g, '\n').split('\n'));
  assert.deepEqual(readback.reasons, ['layout_not_preserved', 'sections_without_extractable_text']);
});

test('macOS native textutil independently reopens Word text with literal Unicode and citation text', { skip: process.platform !== 'darwin' }, () => {
  const value = input(), artifact = createWordTextArtifact(value);
  const result = spawnSync('/usr/bin/textutil', ['-convert', 'txt', '-format', 'docx', '-stdin', '-stdout'], { input: artifact.bytes,
    env: { TZ: 'UTC' }, encoding: 'utf8', timeout: 5000, maxBuffer: 200000 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, value.text.replace(/\r\n?/g, '\n') + '\n');
});

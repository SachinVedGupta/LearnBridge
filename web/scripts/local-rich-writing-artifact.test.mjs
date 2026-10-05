import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createFormattedWordArtifact, createTexArtifact, RICH_WRITING_LIMITS, RICH_WRITING_VERSION } from '../apps/local-runtime/src/rich-writing-artifact.mjs';

const PYTHON = fileURLToPath(new URL('../../.venv/bin/python3', import.meta.url));
const ORACLE = fileURLToPath(new URL('./fixtures/rich-writing-verify.py', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const run = (text, bold = false, italic = false) => ({ text, bold, italic });
const paragraph = (text, style = 'Normal', extra = {}) => ({ style, number: null, bullet: false, runs: Array.isArray(text) ? text : [run(text)], ...extra });
function input(text) { return { text, provenance: { writing_record: { id: randomUUID(), revision: 2, payload_hash: sha('synthetic exact draft'), state: 'accepted' },
  document: { id: randomUUID(), revision: 1, sha256: sha(text) }, source_documents: [{ id: randomUUID(), revision: 4, sha256: sha('synthetic selected source') }],
  academic_policy: 'learning_support', content_status: 'student_reviewed_model_output_facts_unverified' } }; }
function verify(value, expectedParagraphs, artifact = createFormattedWordArtifact(value)) {
  const request = Buffer.from(JSON.stringify({ expected_text: value.text, expected_paragraphs: expectedParagraphs, expected_manifest: artifact.manifest }) + '\n');
  const result = spawnSync(PYTHON, ['-I', '-S', '-B', '-X', 'utf8', ORACLE], { input: Buffer.concat([request, artifact.bytes]), env: { TZ: 'UTC' }, encoding: 'utf8', timeout: 5000, maxBuffer: 200000 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); const readback = JSON.parse(result.stdout);
  assert.equal(readback.status, 'PASS'); assert.equal(readback.sha256, sha(artifact.bytes)); assert.equal(readback.byte_length, artifact.bytes.length); assert.equal(readback.external_relationships, 0);
  return artifact;
}
function denied(action, code = 'INVALID_INPUT') { assert.throws(action, error => error.code === code && !error.message.includes('PRIVATE_RICH_CANARY')); }

test('RWA01: independent ZIP/XML parser proves semantic headings, bold/italic runs, actual bullet/numbered lists and original/rendered source hashes', () => {
  const text = '# Student notes\r\n## Subtopic\r\n### Detail\r\nA **bold** and *italic* résumé 🧠.\r\n- First & <safe>\r\n+ Second\r\n3. Third\r\n4) Fourth\r\n9. Restarted\r\n\r\n\tFinal line\r\n';
  const value = input(text), artifact = verify(value, [paragraph('Student notes', 'Heading1'), paragraph('Subtopic', 'Heading2'), paragraph('Detail', 'Heading3'),
    paragraph([run('A '), run('bold', true), run(' and '), run('italic', false, true), run(' résumé 🧠.')]), paragraph('First & <safe>', 'ListParagraph', { bullet: true }),
    paragraph('Second', 'ListParagraph', { bullet: true }), paragraph('Third', 'ListParagraph', { number: 3 }), paragraph('Fourth', 'ListParagraph', { number: 4 }),
    paragraph('Restarted', 'ListParagraph', { number: 9 }), paragraph(''), paragraph('\tFinal line'), paragraph('')]);
  assert.equal(artifact.manifest.generator_version, RICH_WRITING_VERSION); assert.equal(artifact.manifest.original_text_sha256, sha(text));
  assert.deepEqual(artifact.manifest.features, { headings: 3, bullet_items: 2, ordered_items: 3, bold_runs: 1, italic_runs: 1 });
  assert.equal(artifact.manifest.original_text_sha256, artifact.manifest.provenance.document.sha256); assert.equal(artifact.manifest.visual_review, 'pending');
});

test('RWA02: unsupported links, images, HTML, tables, nested lists, code fences, unmatched emphasis and identifiers remain inert literal content', () => {
  const lines = ['[source](https://example.com)', '![image](file:///PRIVATE_RICH_CANARY)', '<script>unsafe()</script>', '| A | B |', '  - Nested list stays literal',
    '#### Four levels stay literal', 'Unmatched **bold', '\\**escaped**', 'foo_bar_baz', '***nested***', '```js', '# Literal fenced heading', '- Literal fenced list', '**literal fenced bold**', '```'];
  const artifact = verify(input(lines.join('\n')), lines.map(line => paragraph(line)));
  assert.deepEqual(artifact.manifest.features, { headings: 0, bullet_items: 0, ordered_items: 0, bold_runs: 0, italic_runs: 0 });
  assert.equal(artifact.bytes.includes(Buffer.from('<script>')), false); assert.equal(artifact.bytes.includes(Buffer.from('&lt;script&gt;')), true);
});

test('RWA03: underscore emphasis respects whole-word boundaries and newline/empty paragraphs are preserved', () => {
  const value = input('  __bold__ and _italic_  \n\nword_with_underscores\n_ two spaces _\n');
  verify(value, [paragraph([run('  '), run('bold', true), run(' and '), run('italic', false, true), run('  ')]), paragraph(''), paragraph('word_with_underscores'), paragraph('_ two spaces _'), paragraph('')]);
});

test('RWA04: discontinuous/restarted numbered blocks preserve each reviewed source number rather than silently renumbering', () => {
  const value = input('2. Second\n3. Third\n1. New block\nText between blocks\n8) Eighth\n9999. Last supported number\n10000. Literal beyond supported range');
  verify(value, [paragraph('Second', 'ListParagraph', { number: 2 }), paragraph('Third', 'ListParagraph', { number: 3 }), paragraph('New block', 'ListParagraph', { number: 1 }),
    paragraph('Text between blocks'), paragraph('Eighth', 'ListParagraph', { number: 8 }), paragraph('Last supported number', 'ListParagraph', { number: 9999 }), paragraph('10000. Literal beyond supported range')]);
});

test('RWA05: source-order canonicalization produces deterministic package bytes and immutable exact source provenance', () => {
  const value = input('# Title\n**Body**'); value.provenance.source_documents.push({ id: randomUUID(), revision: 2, sha256: sha('another selected source') });
  const first = createFormattedWordArtifact(value), reversed = structuredClone(value); reversed.provenance.source_documents.reverse(); const second = createFormattedWordArtifact(reversed);
  assert.deepEqual(first.bytes, second.bytes); assert.deepEqual(first.manifest, second.manifest); const previous = first.manifest.provenance.document.revision;
  value.provenance.document.revision++; assert.equal(first.manifest.provenance.document.revision, previous); assert.throws(() => { first.manifest.features.headings++; }, TypeError);
});

test('RWA06: no accessor execution, unsupported provenance, stale saved text or invalid XML characters are accepted', () => {
  let read = false; const getter = input('safe'); Object.defineProperty(getter, 'text', { enumerable: true, get() { read = true; return 'PRIVATE_RICH_CANARY'; } });
  denied(() => createFormattedWordArtifact(getter)); denied(() => createTexArtifact(getter)); assert.equal(read, false);
  const stale = input('safe'); stale.provenance.document.sha256 = sha('changed'); denied(() => createFormattedWordArtifact(stale), 'VERSION_MISMATCH');
  for (const state of ['awaiting_review', 'rejected', 'prepared']) { const wrong = input('safe'); wrong.provenance.writing_record.state = state; denied(() => createFormattedWordArtifact(wrong)); }
  for (const text of ['', 'only\0bad', 'bad\ud800', 'bad\uffff']) { denied(() => createFormattedWordArtifact(input(text))); denied(() => createTexArtifact(input(text))); }
  const unknown = input('safe'); unknown.path = '/PRIVATE_RICH_CANARY'; denied(() => createFormattedWordArtifact(unknown));
});

test('RWA07: rich formatting adds bounded run/emphasis budgets and enforces original byte/paragraph/source bounds', () => {
  denied(() => createFormattedWordArtifact(input('x'.repeat(RICH_WRITING_LIMITS.inputBytes + 1))), 'BUDGET_EXCEEDED');
  denied(() => createTexArtifact(input('x\n'.repeat(RICH_WRITING_LIMITS.paragraphs))), 'BUDGET_EXCEEDED');
  denied(() => createFormattedWordArtifact(input(Array.from({ length: 101 }, () => '**b**').join(' '))), 'BUDGET_EXCEEDED');
  const lines = Array.from({ length: 1000 }, () => 'a **b** c *d*'); assert.equal(createFormattedWordArtifact(input(lines.join('\n'))).manifest.run_count, 4000);
  denied(() => createFormattedWordArtifact(input(lines.map(line => line + ' e').join('\n'))), 'BUDGET_EXCEEDED');
});

test('RWA08: independent oracle catches corrupted ZIP data, changed OOXML text and trailing payloads', () => {
  const value = input('# Title'), artifact = createFormattedWordArtifact(value), request = Buffer.from(JSON.stringify({ expected_text: value.text, expected_paragraphs: [paragraph('Title', 'Heading1')], expected_manifest: artifact.manifest }) + '\n');
  const corrupt = Buffer.from(artifact.bytes); corrupt[80] ^= 1;
  for (const bytes of [corrupt, Buffer.concat([artifact.bytes, Buffer.from('PRIVATE_RICH_CANARY')])]) {
    const result = spawnSync(PYTHON, ['-I', '-S', '-B', '-X', 'utf8', ORACLE], { input: Buffer.concat([request, bytes]), env: { TZ: 'UTC' }, timeout: 5000 });
    assert.equal(result.status, 1); assert.match(result.stderr.toString(), /RICH_WRITING_FIXTURE_VERIFICATION_FAILED/);
  }
});

test('RWA09: standalone LaTeX escapes source control characters and attempted file/command/document injection into literal visible text', () => {
  const value = input('# Report\nA **bold** and *italic* line.\n\\input{/private/PRIVATE_RICH_CANARY}\n\\write18{curl attacker}\n\\end{document}\n$money & 100% #tag _value_ {braces} ~ ^\n- item\n3. third');
  const artifact = createTexArtifact(value), tex = artifact.text;
  assert.match(tex, /\\section\*\{Report\}/); assert.match(tex, /A \\textbf\{bold\} and \\emph\{italic\} line\./);
  assert.ok(tex.includes('\\textbackslash{}input\\{/private/PRIVATE\\_RICH\\_CANARY\\}')); assert.ok(tex.includes('\\textbackslash{}write18\\{curl attacker\\}'));
  assert.ok(tex.includes('\\textbackslash{}end\\{document\\}')); assert.ok(tex.includes('\\$money \\& 100\\% \\#tag \\emph{value} \\{braces\\} \\textasciitilde{} \\textasciicircum{}'));
  assert.equal((tex.match(/\\begin\{document\}/g) || []).length, 1); assert.equal((tex.match(/\\end\{document\}/g) || []).length, 1);
  assert.equal(/\\(?:input|include|write|openout|read|catcode|csname|usepackage\{shellesc)\b/.test(tex), false);
  assert.equal(artifact.manifest.compiler, 'not_run'); assert.equal(artifact.manifest.shell_escape, 'not_requested'); assert.equal(artifact.manifest.visual_review, 'pending');
  assert.ok(tex.includes(`% LearnBridge reviewed-source SHA-256: ${sha(value.text)}`));
  const embedded = JSON.parse(tex.split('\n').find(line => line.startsWith('% LearnBridge manifest: ')).slice('% LearnBridge manifest: '.length));
  assert.deepEqual(embedded, artifact.manifest); assert.equal(artifact.bytes.toString('utf8'), tex);
});

test('RWA10: native macOS Word conversion independently opens formatted content and strips supported markers', { skip: process.platform !== 'darwin' }, () => {
  const artifact = createFormattedWordArtifact(input('# Student notes\nA **bold** and *italic* line.\n- bullet\n3. third'));
  const result = spawnSync('/usr/bin/textutil', ['-convert', 'txt', '-format', 'docx', '-stdin', '-stdout'], { input: artifact.bytes, env: { TZ: 'UTC' }, encoding: 'utf8', timeout: 5000, maxBuffer: 200000 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); assert.ok(result.stdout.includes('Student notes')); assert.ok(result.stdout.includes('A bold and italic line.'));
  assert.equal(result.stdout.includes('**bold**'), false); assert.equal(result.stdout.includes('# Student notes'), false); assert.ok(result.stdout.includes('bullet')); assert.ok(result.stdout.includes('third'));
});

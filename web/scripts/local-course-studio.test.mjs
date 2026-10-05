import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, readFile, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import * as source from '../packages/local-sources/src/index.mjs';
import { createHostTurns } from '../apps/local-runtime/src/host-turns.mjs';
import { createCourseStudioService } from '../apps/local-runtime/src/course-studio-service.mjs';
import { handleCourseStudioRoute } from '../apps/local-runtime/src/course-studio-routes.mjs';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';
import { requestAgentControl } from '../apps/local-runtime/src/ipc.mjs';

const native = process.platform === 'darwin', exec = promisify(execFile), hash = value => createHash('sha256').update(value).digest('hex');
let directory, descriptor, inventory, imported, asset;
before(async () => {
  if (!native) return;
  directory = await realpath(await mkdtemp(join(tmpdir(), 'learnbridge-course-studio-fixture-')));
  await exec('/usr/bin/swift', ['-module-cache-path', join(directory, 'modules'), fileURLToPath(new URL('./fixtures/pdf-source-fixture.swift', import.meta.url)), directory], { timeout: 30000, maxBuffer: 32000, env: { PATH: '/usr/bin:/bin', HOME: directory, TMPDIR: directory } });
  descriptor = await source.describeRoot(directory, { label: 'Synthetic course' }); inventory = await source.inventorySource(descriptor); const selected = inventory.entries.find(item => item.title === 'text.pdf');
  imported = await source.readSelectedPdf(descriptor, inventory, selected.id); asset = await source.readSelectedPdfAsset(descriptor, inventory, selected.id, { physicalPage: 2 });
  await writeFile(join(tmpdir(), 'learnbridge-course-page-synthetic.png'), Buffer.from(asset.png_base64, 'base64'));
}, { timeout: 60000 });
after(async () => { if (directory) await rm(directory, { recursive: true }); });
const errorCode = (fn, code) => assert.throws(fn, error => error.code === code);
async function fixture(t, { answer, readAsset, importData = imported } = {}) {
  const parent = await mkdtemp(join(tmpdir(), 'learnbridge-course-studio-store-')), root = join(parent, 'workspace'); let store = LocalStore.open({ root, timezone: 'America/Toronto' }), host;
  t.after(async () => { await host?.drain(); store.close(); await rm(parent, { recursive: true }); });
  const folder = store.createSource({ label: descriptor.label, descriptor }); const saved = store.saveSourceInventory(folder.id, inventory), entry = store.importSourceEntry({ source_id: folder.id, inventory_id: saved.id, entry_id: inventory.entries.find(item => item.title === 'text.pdf').id, ...importData });
  const seen = [];
  const execute = async input => {
    const context = store.agentContext({ destination: 'codex', grant_id: input.grantId }); seen.push({ prompt: input.prompt, context });
    input.onProgress({ phase: 'tool', tool: 'learnbridge_context', state: 'running' });
    input.onProgress({ phase: 'tool', tool: 'learnbridge_context', state: 'finished' });
    const text = typeof answer === 'function' ? answer(context, input.prompt) : answer || 'A base case terminates recursion. Physical page 2. BEGIN_LEARNBRIDGE_POINTERS_V1 {"version":1,"quotes":[{"quote":"Base cases end recursion.","label":"The termination condition"}]} END_LEARNBRIDGE_POINTERS_V1';
    return { state: 'completed', text, output_sha256: hash(text), complete: true, tool_receipts: [{ tool: 'learnbridge_context', status: 'completed', failed: false, result_hash: hash(JSON.stringify(context)), origin: 'model' }], host_version: 'fixture-only' };
  };
  const construct = () => {
    host = createHostTurns({ store, enabled: true, execute });
    return createCourseStudioService({ store, hostTurns: host, readPdfAsset: readAsset || (async () => asset) });
  };
  let service = construct();
  const input = { source_entry_id: entry.id, physical_page: 2, title: 'Recursion page', academic_policy: { grading: 'ungraded', ai_rule: 'allowed' }, confirmed: true };
  return { parent, root, folder, entry, input, seen, get store() { return store; }, get service() { return service; }, get host() { return host; }, async restart() { await host.drain(); store.close(); store = LocalStore.open({ root, timezone: 'America/Toronto' }); service = construct(); } };
}
const create = f => f.service.create(f.input, { idempotencyKey: 'synthetic-studio-create-1' });
const exact = row => ({ expected_revision: row.revision, studio_hash: row.data.studio_hash });
const grant = (f, studio) => f.store.createAgentGrant({ destination: 'codex', document_ids: [studio.data.context_document.id], task_ids: [], source_entry_ids: [], max_bytes: 256000, expires_in_minutes: 30 });
async function complete(f, studio, selection, mode = 'question', key = 'synthetic-course-message-1') {
  const sent = await f.service.start(studio.id, { ...exact(studio), grant_id: selection.id, mode, question: 'Explain the base case.', confirmed: true }, { idempotencyKey: key, authorize: () => true });
  for (let index = 0; index < 30 && ['queued', 'running'].includes(f.host.get(sent.host_turn.id).data.state); index++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.host.get(sent.host_turn.id).data.state, 'completed'); return sent;
}

// These use the real private SQLite store and actual saved host receipts with a
// synthetic executor seam. They do not claim a live subscription/model result.
test('native selected PDF page renders PNG at exact original SHA and supplies non-guessed text geometry', { skip: !native }, async () => {
  const png = Buffer.from(asset.png_base64, 'base64'); assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]); assert.equal(asset.png_sha256, hash(png)); assert.equal(asset.source_sha256, hash(await readFile(join(directory, 'text.pdf')))); assert.equal(asset.source_version, imported.version); assert.equal(asset.physical_page, 2); assert.equal(asset.page_count, 2); assert.equal(png.readUInt32BE(16), asset.width); assert.equal(png.readUInt32BE(20), asset.height);
  assert.equal(asset.text_coordinates_available, true); const region = asset.text_regions.find(row => row.text.includes('Base cases')); assert.ok(region); assert.ok(region.y < .2); assert.ok(region.x > 0 && region.width < 1);
  await assert.rejects(source.readSelectedPdfAsset(descriptor, inventory, inventory.entries.find(item => item.title === 'text.pdf').id, { physicalPage: 0 }), error => error.code === 'INVALID_INPUT');
});

test('selected-page session retains exact source and local context only; restart and retry create one note/session', { skip: !native }, async t => {
  const f = await fixture(t), studio = create(f); assert.equal(f.service.create(f.input, { idempotencyKey: 'synthetic-studio-create-1' }).id, studio.id); assert.equal(f.store.listAgentGrants().length, 0); assert.equal(f.store.listDocuments().length, 1); const note = f.store.getDocument(studio.data.context_document.id);
  assert.match(note.text, /Base cases end recursion/); assert.equal(note.text.includes('café'), false); assert.equal(note.document.academic_policy, 'learning_support'); assert.equal(studio.data.source_pin.original_sha256, imported.pdf.source_sha256); assert.equal(JSON.stringify(f.service.list()).includes('Base cases'), false);
  await f.restart(); assert.equal(f.service.get(studio.id).page.text, imported.pdf.pages[1].text); assert.equal(create(f).id, studio.id); errorCode(() => f.service.create({ ...f.input, physical_page: 1 }, { idempotencyKey: 'synthetic-studio-create-1' }), 'REVISION_CONFLICT');
});

test('slideshow metadata stays text-free and a new page rejects a changed exact course recipe before retaining a context copy', { skip: !native }, async t => {
  const f = await fixture(t); const selected = { id: '962bd1a1-8989-4f2d-9c81-f84a76ad453b', revision: 2, data: { recipe: { state: 'ready', session_hash: 'b'.repeat(64), academic_policy: { grading: 'ungraded', ai_rule: 'allowed' }, source_evidence: 'Explicit synthetic course passage' } } };
  const service = createCourseStudioService({ store: f.store, hostTurns: f.host, learningService: { getSession: () => selected }, readPdfAsset: async () => asset });
  const pin = { id: selected.id, revision: selected.revision, session_hash: selected.data.recipe.session_hash }, input = { ...f.input, learning_session_id: selected.id, expected_learning_pin: pin }, row = service.create(input, { idempotencyKey: 'synthetic-recipe-page-1' });
  assert.equal(service.get(row.id).page.page_count, 2); const metadata = service.list()[0]; assert.deepEqual(metadata.learning_pin, pin); assert.equal(metadata.source_pin.id, f.entry.id); assert.deepEqual(metadata.academic_policy, input.academic_policy); assert.equal(JSON.stringify(metadata).includes('Base cases'), false); assert.equal(JSON.stringify(metadata).includes('Explicit synthetic'), false);
  selected.revision = 3; selected.data.recipe.session_hash = 'c'.repeat(64); assert.equal(service.list()[0].stale, true); const beforeNotes = f.store.listDocuments().length;
  errorCode(() => service.create({ ...input, physical_page: 1 }, { idempotencyKey: 'synthetic-recipe-page-2' }), 'VERSION_MISMATCH'); assert.equal(f.store.listDocuments().length, beforeNotes); assert.equal(f.store.listAgentGrants().length, 0); assert.equal(f.seen.length, 0);
});

// This synthetic imported-text seam exercises the domain limit independently
// from native PDF parsing; the real reader/render path is covered above.
function withPageText(pageText) {
  const value = structuredClone(imported); value.pdf.pages[1].text = pageText; let bytes = 0;
  value.text = value.pdf.pages.map((page, index) => { const header = `${index ? '\n\n' : ''}[PDF page ${page.physical_page}]\n`; const start = bytes + Buffer.byteLength(header); bytes = start + Buffer.byteLength(page.text); page.sha256 = hash(page.text); page.byte_range = { start, end: bytes }; return header + page.text; }).join(''); value.sha256 = hash(value.text); return value;
}
test('oversized plain or JSON-escaped selected page is rejected before note/studio/grant creation without trimming the imported source', { skip: !native }, async t => {
  for (const content of ['PLAIN_START ' + 'v'.repeat(25000) + ' PLAIN_END', '\\"'.repeat(4000)]) {
    const f = await fixture(t, { importData: withPageText(content) }); errorCode(() => create(f), 'BUDGET_EXCEEDED'); assert.equal(f.store.listDocuments().length, 0); assert.equal(f.service.list().length, 0); assert.equal(f.store.listAgentGrants().length, 0); assert.equal(f.seen.length, 0); assert.equal(f.store.getSourceEntry(f.entry.id).pdf.pages[1].text, content); assert.equal(f.store.getSourceEntry(f.entry.id).text, f.entry.text);
  }
});
test('oversized optional exact course recipe creates no copy; page-only selection still fits a real 32000-byte broker read', { skip: !native }, async t => {
  const f = await fixture(t), selected = { id: '962bd1a1-8989-4f2d-9c81-f84a76ad453b', revision: 2, data: { recipe: { state: 'ready', session_hash: 'b'.repeat(64), academic_policy: { grading: 'ungraded', ai_rule: 'allowed' }, source_evidence: '\\"'.repeat(4000) } } };
  const service = createCourseStudioService({ store: f.store, hostTurns: f.host, learningService: { getSession: () => selected }, readPdfAsset: async () => asset }); errorCode(() => service.create({ ...f.input, learning_session_id: selected.id }, { idempotencyKey: 'synthetic-large-recipe-1' }), 'BUDGET_EXCEEDED'); assert.equal(f.store.listDocuments().length, 0); assert.equal(service.list().length, 0); assert.equal(f.store.listAgentGrants().length, 0);
  const studio = service.create(f.input, { idempotencyKey: 'synthetic-page-only-1' }), note = f.store.getDocument(studio.data.context_document.id), selection = grant(f, studio), context = f.store.agentContext({ destination: 'codex', grant_id: selection.id, max_bytes: 32000 }); assert.equal(context.documents.length, 1); assert.equal(context.documents[0].text, note.text); assert(context.serialized_bytes <= 32000); assert.equal(JSON.parse(note.text).source.text, imported.pdf.pages[1].text); assert.equal(JSON.parse(note.text).selected_course_recipe, null);
});
test('a large fitting selected page keeps exact start/end text and fits the fixed broker envelope without truncation', { skip: !native }, async t => {
  const content = 'EXACT_START ' + 'v'.repeat(20000) + ' EXACT_END', f = await fixture(t, { importData: withPageText(content) }), studio = create(f), note = f.store.getDocument(studio.data.context_document.id), selection = grant(f, studio), context = f.store.agentContext({ destination: 'codex', grant_id: selection.id, max_bytes: 32000 }); assert.equal(JSON.parse(note.text).source.text, content); assert(Buffer.byteLength(JSON.stringify(note.text)) <= 24000); assert(context.serialized_bytes <= 32000); assert.equal(context.documents[0].text, note.text);
});
test('an older saved oversized studio stays readable locally but is denied before asset work or model context processing', { skip: !native }, async t => {
  let renders = 0; const f = await fixture(t, { importData: withPageText('v'.repeat(25000)), readAsset: async () => { renders++; return asset; } }), selected = f.entry.pdf.pages[1], sourcePin = { id: f.entry.id, source_id: f.entry.source_id, version: f.entry.version, text_sha256: f.entry.sha256, original_sha256: f.entry.pdf.source_sha256, physical_page: 2, page_sha256: selected.sha256 };
  // Reconstruct a valid pinned pre-cap artifact through the real storage API;
  // no migration or production path is permitted to bypass today's cap.
  const note = f.store.createDocument({ title: 'Retained course context before size cap', text: JSON.stringify({ format: 'learnbridge_course_context.v1', source: { ...sourcePin, text: selected.text }, selected_course_recipe: null }), kind: 'study', academic_policy: 'learning_support' });
  const pins = { source_pin: sourcePin, learning_pin: null, academic_policy: f.input.academic_policy, context_document: { id: note.document.id, revision: note.document.revision, sha256: note.sha256 } }, canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
  const studio = f.store.createWorkspaceRecord({ kind: 'artifact', title: 'Older retained slide', data: { format: 'learnbridge_course_studio.v1', ...pins, source_title: f.entry.title, studio_hash: hash(canonical(pins)) } }); assert.equal(f.service.get(studio.id).page.text, selected.text); const selection = grant(f, studio);
  await assert.rejects(f.service.start(studio.id, { ...exact(studio), grant_id: selection.id, mode: 'question', question: 'Explain the selected slide.', confirmed: true }, { idempotencyKey: 'synthetic-older-large-start-1', authorize: () => true }), error => error.code === 'BUDGET_EXCEEDED'); assert.equal(renders, 0); assert.equal(f.seen.length, 0); assert.equal(f.store.getAgentGrant(selection.id).used_bytes, 0); assert.equal(f.service.get(studio.id).page.text, selected.text);
});

test('unknown grading is restricted and prohibited rule creates no studio or context copy', { skip: !native }, async t => {
  const f = await fixture(t); errorCode(() => f.service.create({ ...f.input, academic_policy: { grading: 'ungraded', ai_rule: 'prohibited' } }, { idempotencyKey: 'synthetic-prohibited-1' }), 'SCOPE_DENIED'); assert.equal(f.store.listDocuments().length, 0);
  const studio = f.service.create({ ...f.input, academic_policy: { grading: 'unknown', ai_rule: 'unknown' } }, { idempotencyKey: 'synthetic-unknown-rule-1' }); assert.equal(f.store.getDocument(studio.data.context_document.id).document.academic_policy, 'graded_restricted');
});

test('actual host orchestration pins selected note, persists progress/chat, deduplicates and rejects a wrong context grant', { skip: !native }, async t => {
  const f = await fixture(t), studio = create(f), selection = grant(f, studio), wrong = f.store.createAgentGrant({ destination: 'codex', document_ids: [], task_ids: [], source_entry_ids: [], max_bytes: 256000, expires_in_minutes: 30 });
  await assert.rejects(f.service.start(studio.id, { ...exact(studio), grant_id: wrong.id, mode: 'question', question: 'Q', confirmed: true }, { idempotencyKey: 'synthetic-wrong-grant-1', authorize: () => true }), error => error.code === 'SCOPE_DENIED');
  const sent = await complete(f, studio, selection), view = f.service.get(studio.id); assert.equal(view.messages.length, 1); assert.equal(view.messages[0].state, 'completed'); assert.match(view.messages[0].text, /terminates recursion/); assert.equal(view.messages[0].progress.length, 2); assert.equal(view.messages[0].pointers[0].quote, 'Base cases end recursion.'); assert.equal(f.seen.length, 1); assert.equal(f.seen[0].context.documents.length, 1); assert.equal(f.seen[0].context.source_entries.length, 0); assert.equal(f.seen[0].context.documents[0].id, studio.data.context_document.id); assert.equal(JSON.stringify(f.seen[0].context).includes('café'), false);
  assert.match(f.seen[0].prompt, /natural student-facing prose and short paragraphs in plain text/); assert.match(f.seen[0].prompt, /without Markdown formatting markers/); assert.match(f.seen[0].prompt, /Cite as physical slide\/page 2/); assert.match(f.seen[0].prompt, /Keep IDs, hashes, revisions and tooling details out of explanatory text/); assert.match(f.seen[0].prompt, /one small section, ask one comprehension check, and wait/);
  assert.equal((await complete(f, studio, selection)).item.id, sent.item.id); assert.equal(f.seen.length, 1); await f.restart(); assert.equal(f.service.get(studio.id).messages[0].host_turn_id, sent.host_turn.id);
  f.store.revokeAgentGrant(selection.id, f.store.getAgentGrant(selection.id).revision); assert.equal(f.service.get(studio.id).messages[0].text, ''); assert.deepEqual(f.service.get(studio.id).messages[0].pointers, []); assert.equal(f.service.get(studio.id).messages[0].state, 'withheld'); assert.deepEqual(f.service.get(studio.id).messages[0].progress, []);
});

test('course requests reject broader existing grants before PDF rendering, idempotent replay, host work or context charge', { skip: !native }, async t => {
  let renders = 0; const f = await fixture(t, { readAsset: async () => { renders++; return asset; } }), studio = create(f), other = f.store.createDocument({ title: 'Other selected fixture note', text: 'UNRELATED_PRIVATE_CANARY', kind: 'note' }), task = f.store.createTask({ title: 'Unrelated selected task' });
  const extras = [{ document_ids: [other.document.id] }, { task_ids: [task.id] }, { source_entry_ids: [f.entry.id] }];
  for (const extra of extras) {
    const wider = f.store.createAgentGrant({ destination: 'codex', task_ids: [], document_ids: [studio.data.context_document.id, ...(extra.document_ids || [])], source_entry_ids: [], max_bytes: 256000, expires_in_minutes: 30, ...('task_ids' in extra ? { task_ids: extra.task_ids } : {}), ...('source_entry_ids' in extra ? { source_entry_ids: extra.source_entry_ids } : {}) });
    await assert.rejects(f.service.start(studio.id, { ...exact(studio), grant_id: wider.id, mode: 'question', question: 'Explain the base case.', confirmed: true }, { idempotencyKey: 'synthetic-course-message-1', authorize: () => true }), error => error.code === 'SCOPE_DENIED'); assert.equal(f.store.getAgentGrant(wider.id).used_bytes, 0);
  }
  assert.equal(renders, 0); assert.equal(f.seen.length, 0); assert.equal(f.service.get(studio.id).messages.length, 0);
  // A normal prior receipt does not turn the same key into a broad-scope read.
  await complete(f, studio, grant(f, studio)); const before = f.seen.length, wider = f.store.createAgentGrant({ destination: 'codex', task_ids: [], document_ids: [studio.data.context_document.id, other.document.id], source_entry_ids: [], max_bytes: 256000, expires_in_minutes: 30 });
  await assert.rejects(f.service.start(studio.id, { ...exact(studio), grant_id: wider.id, mode: 'question', question: 'Explain the base case.', confirmed: true }, { idempotencyKey: 'synthetic-course-message-1', authorize: () => true }), error => error.code === 'SCOPE_DENIED'); assert.equal(f.seen.length, before); assert.equal(renders, 1); assert.equal(f.store.getAgentGrant(wider.id).used_bytes, 0);
});

test('removed host-turn history remains an unavailable message with no answer/pointers instead of breaking the slide', { skip: !native }, async t => {
  const f = await fixture(t), studio = create(f), sent = await complete(f, studio, grant(f, studio)); const turn = f.store.getWorkspaceRecord(sent.host_turn.id); f.store.deleteWorkspaceRecord(turn.id, turn.revision); const message = f.service.get(studio.id).messages[0]; assert.equal(message.state, 'unavailable'); assert.equal(message.text, ''); assert.deepEqual(message.pointers, []); assert.equal(f.service.get(studio.id).page.text, imported.pdf.pages[1].text);
});

function quizAnswer(context) { const note = JSON.parse(context.documents[0].text); return `BEGIN_LEARNBRIDGE_QUIZ_V1 ${JSON.stringify({ version: 1, questions: [{ question: 'What ends recursion?', answer: 'A base case.', explanation: 'It returns without another recursive call.', citation: { source_entry_id: note.source.id, physical_page: note.source.physical_page, page_sha256: note.source.page_sha256 } }] })} END_LEARNBRIDGE_QUIZ_V1`; }
test('quiz uses completed model output, exact citations and review; actual answers precede reference reveal and student-only rating', { skip: !native }, async t => {
  const f = await fixture(t, { answer: quizAnswer }), studio = create(f), selection = grant(f, studio), sent = await complete(f, studio, selection, 'quiz');
  const preview = f.service.quizPreview(sent.item.id); assert.equal(preview.questions.length, 1); assert.equal(preview.questions[0].citation.page_sha256, imported.pdf.pages[1].sha256);
  const quiz = f.service.reviewQuiz(sent.item.id, { expected_revision: sent.item.revision, output_sha256: preview.output_sha256, confirmed: true }, { idempotencyKey: 'synthetic-review-quiz-1' }); assert.equal('answer' in quiz.data.questions[0], false); assert.equal(f.service.get(studio.id).messages[0].text, ''); assert.equal(f.store.listTasks().length, 0);
  errorCode(() => f.service.answer(quiz.id, { expected_revision: quiz.revision, question_id: 'q1', response: '' }, { idempotencyKey: 'synthetic-empty-answer-1' }), 'INVALID_INPUT');
  const attempt = f.service.answer(quiz.id, { expected_revision: quiz.revision, question_id: 'q1', response: 'Return at a base case.' }, { idempotencyKey: 'synthetic-student-answer-1' }); assert.equal(attempt.reference_answer, 'A base case.'); assert.equal(attempt.item.data.exact_student_response, 'Return at a base case.'); assert.equal(attempt.item.data.mastery_claim, false);
  errorCode(() => f.service.assess(attempt.item.id, { expected_revision: 1, assessment: 'correct', reviewed_by_student: false }), 'INVALID_INPUT'); const reviewed = f.service.assess(attempt.item.id, { expected_revision: 1, assessment: 'correct', reviewed_by_student: true }); assert.equal(reviewed.data.assessment, 'correct'); assert.equal(reviewed.data.review_receipt.mastery_claim, false); assert.equal(f.service.assess(attempt.item.id, { expected_revision: 1, assessment: 'correct', reviewed_by_student: true }).revision, 2);
  await f.restart(); assert.equal(f.service.get(studio.id).quizzes.length, 1); assert.equal(f.service.get(studio.id).attempts[0].data.assessment, 'correct'); assert.equal(f.service.get(studio.id).attempts[0].reference_answer, 'A base case.');
});

test('malformed or invented-citation quiz remains failed parser rather than fabricated questions', { skip: !native }, async t => {
  const f = await fixture(t, { answer: 'BEGIN_LEARNBRIDGE_QUIZ_V1 {"version":1,"questions":[{"question":"Q","answer":"A","explanation":"E","citation":{"source_entry_id":"00000000-0000-4000-8000-000000000000","physical_page":2,"page_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}]} END_LEARNBRIDGE_QUIZ_V1' }), studio = create(f), selection = grant(f, studio), sent = await complete(f, studio, selection, 'quiz');
  errorCode(() => f.service.quizPreview(sent.item.id), 'VERSION_MISMATCH'); assert.equal(f.service.get(studio.id).quizzes.length, 0); errorCode(() => f.service.reviewQuiz(sent.item.id, { expected_revision: 1, output_sha256: f.host.get(sent.host_turn.id).data.output_sha256, confirmed: true }, { idempotencyKey: 'synthetic-forged-quiz-1' }), 'VERSION_MISMATCH');
});

test('reviewed model quote annotations use native exact text bounds; manual annotations stay separate and restart durable', { skip: !native }, async t => {
  const f = await fixture(t), studio = create(f), selection = grant(f, studio), sent = await complete(f, studio, selection);
  const model = await f.service.annotate(studio.id, { ...exact(studio), label: 'Termination', message_id: sent.item.id, quote_index: 0, confirmed: true }, { idempotencyKey: 'synthetic-model-circle-1' }); const geometry = asset.text_regions.find(row => row.text.includes('Base cases end recursion.'));
  assert.equal(model.data.origin, 'model_quote_reviewed'); assert.equal(model.data.rectangle.x, geometry.x); assert.equal(model.data.rectangle.y, geometry.y); assert.equal(model.data.model_source.quote, 'Base cases end recursion.');
  const manual = await f.service.annotate(studio.id, { ...exact(studio), label: 'My area', rectangle: { x: .1, y: .2, width: .2, height: .1 }, confirmed: true }, { idempotencyKey: 'synthetic-manual-circle-1' }); assert.equal(manual.data.origin, 'student');
  await assert.rejects(f.service.annotate(studio.id, { ...exact(studio), label: 'Outside', rectangle: { x: .9, y: .2, width: .2, height: .1 }, confirmed: true }, { idempotencyKey: 'synthetic-outside-circle-1' }), error => error.code === 'INVALID_INPUT'); await f.restart(); assert.equal(f.service.get(studio.id).annotations.length, 2); f.service.removeAnnotation(manual.id, manual.revision); assert.equal(f.service.get(studio.id).annotations.length, 1);
});

test('source revocation and changed context versions withhold all page/chat/quiz/annotation data', { skip: !native }, async t => {
  const f = await fixture(t), studio = create(f), selection = grant(f, studio); await complete(f, studio, selection); f.store.revokeSource(f.folder.id, f.folder.revision);
  errorCode(() => f.service.get(studio.id), 'CONSENT_REQUIRED'); await assert.rejects(f.service.asset(studio.id), error => error.code === 'CONSENT_REQUIRED'); assert.equal(f.service.list()[0].stale, true); assert.equal(JSON.stringify(f.service.list()).includes('Base cases'), false);
});

test('changed actual PDF bytes fail anchored render before returning image or starting model', { skip: !native }, async t => {
  const f = await fixture(t), studio = create(f);
  const failedReader = async () => { const error = new Error('changed'); error.code = 'VERSION_MISMATCH'; throw error; };
  const service = createCourseStudioService({ store: f.store, hostTurns: f.host, readPdfAsset: failedReader }); const selection = grant(f, studio);
  await assert.rejects(service.asset(studio.id), error => error.code === 'VERSION_MISMATCH'); await assert.rejects(service.start(studio.id, { ...exact(studio), grant_id: selection.id, mode: 'question', question: 'Q', confirmed: true }, { idempotencyKey: 'synthetic-changed-source-1', authorize: () => true }), error => error.code === 'VERSION_MISMATCH'); assert.equal(f.seen.length, 0);
  const copied = await realpath(await mkdtemp(join(tmpdir(), 'learnbridge-course-changed-'))); t.after(() => rm(copied, { recursive: true })); await copyFile(join(directory, 'text.pdf'), join(copied, 'selected.pdf')); const root = await source.describeRoot(copied), items = await source.inventorySource(root); await writeFile(join(copied, 'selected.pdf'), '%PDF-changed'); await assert.rejects(source.readSelectedPdfAsset(root, items, items.entries[0].id, { physicalPage: 1 }), error => error.code === 'VERSION_MISMATCH');
});

test('route denies missing pairing/session and recognizes only strict controlled endpoints', { skip: !native }, async t => {
  const f = await fixture(t), args = { route: '/course-studio/sessions', method: 'GET', privateBody: async () => ({}), service: f.service, stillAuthorized: () => true };
  await assert.rejects(handleCourseStudioRoute(args), error => error.code === 'AUTH_REQUIRED'); assert.equal(await handleCourseStudioRoute({ ...args, route: '/different' }), null);
  const response = await handleCourseStudioRoute({ ...args, session: { nonce: 'synthetic-session' } }); assert.equal(response.status, 200); assert.deepEqual(response.data.items, []);
  let invoked = false; const bad = {}; Object.defineProperty(bad, 'source_entry_id', { enumerable: true, get() { invoked = true; return f.entry.id; } }); errorCode(() => f.service.create(bad, { idempotencyKey: 'synthetic-getter-1' }), 'INVALID_INPUT'); assert.equal(invoked, false);
  const nested = {}; Object.defineProperty(nested, 'toJSON', { enumerable: true, get() { invoked = true; return () => f.entry.id; } }); errorCode(() => f.service.create({ ...f.input, learning_session_id: nested }, { idempotencyKey: 'synthetic-nested-getter-1' }), 'INVALID_INPUT'); assert.equal(invoked, false);
});

test('paired HTTP selected-page render, actual saved host link, quote/quiz review, attempt and source denial flow', { skip: !native, timeout: 60000 }, async t => {
  const f = await fixture(t); const seen = []; let executorStage = 'initial'; f.store.close();
  const runtime = await startRuntime({ dataRoot: f.root, port: 0, hostAdapter: { enabled: true, execute: async input => {
    executorStage = 'context';
    const context = await requestAgentControl(input.dataRoot, 'codex', 'context', { grant_id: input.grantId });
    seen.push(context); executorStage = 'progress'; input.onProgress({ phase: 'tool', tool: 'learnbridge_context', state: 'finished' }); executorStage = 'answer';
    const text = input.prompt.includes('BEGIN_LEARNBRIDGE_QUIZ_V1') ? quizAnswer(context) : 'A base case terminates recursion on physical page 2.';
    executorStage = 'result';
    return { state: 'completed', text, output_sha256: hash(text), complete: true, tool_receipts: [{ tool: 'learnbridge_context', status: 'completed', failed: false, result_hash: hash(JSON.stringify(context)), origin: 'model' }], host_version: 'fixture-only' };
  } } }); t.after(() => runtime.close());
  const api = runtime.origin + '/api/local/v1';
  assert.equal((await fetch(api + '/course-studio/sessions')).status, 401);
  const paired = await fetch(api + '/pair', { method: 'POST', headers: { origin: runtime.origin, 'content-type': 'application/json' }, body: JSON.stringify({ code: runtime.createPairingCode() }) }); const cookie = paired.headers.get('set-cookie').split(';')[0], nonce = (await paired.json()).nonce;
  const call = async (path, method = 'GET', body, key) => {
    const result = await fetch(api + path, { method, headers: { cookie, 'x-learnbridge-nonce': nonce, ...(method === 'GET' ? {} : { origin: runtime.origin, 'content-type': 'application/json' }), ...(key ? { 'idempotency-key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: result.status, data: await result.json(), headers: result.headers };
  };
  const created = await call('/course-studio/sessions', 'POST', f.input, 'http-course-session-1'); assert.equal(created.status, 201); const studio = created.data.item;
  const rendered = await call(`/course-studio/sessions/${studio.id}/asset`); assert.equal(rendered.status, 200); assert.equal(rendered.data.asset.source_sha256, imported.pdf.source_sha256); assert.equal(rendered.headers.get('cache-control'), 'private, no-store');
  assert.equal((await call(`/course-studio/sessions/${studio.id}/asset?path=/etc/passwd`)).status, 400);
  const selection = await call('/agent-grants', 'POST', { destination: 'codex', task_ids: [], document_ids: [studio.data.context_document.id], source_entry_ids: [], expected_records: { tasks: [], documents: [{ id: studio.data.context_document.id, revision: 1 }], source_entries: [] }, max_bytes: 256000, expires_in_minutes: 30 }); assert.equal(selection.status, 201);
  const sent = await call(`/course-studio/sessions/${studio.id}/messages`, 'POST', { ...exact(studio), grant_id: selection.data.grant.id, mode: 'quiz', question: 'Test the base case.', confirmed: true }, 'http-course-quiz-1'); assert.equal(sent.status, 202);
  let view; for (let index = 0; index < 40; index++) { view = await call(`/course-studio/sessions/${studio.id}`); if (view.data.messages[0]?.state === 'completed') break; await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(view.data.messages[0].state, 'completed', `state=${view.data.messages[0].state}; code=${view.data.messages[0].error_code}; executorStage=${executorStage}; contextReads=${seen.length}`); assert.equal(view.data.messages[0].host_turn_id, sent.data.host_turn.id); assert.equal(seen.length, 1); assert.equal(JSON.stringify(seen).includes('café'), false);
  const preview = await call(`/course-studio/messages/${sent.data.item.id}/quiz-preview`); assert.equal(preview.status, 200);
  const reviewed = await call(`/course-studio/messages/${sent.data.item.id}/quiz-review`, 'POST', { expected_revision: 1, output_sha256: preview.data.output_sha256, confirmed: true }, 'http-course-review-1'); assert.equal(reviewed.status, 201); assert.equal('answer' in reviewed.data.item.data.questions[0], false);
  const answered = await call(`/course-studio/quizzes/${reviewed.data.item.id}/answer`, 'POST', { expected_revision: 1, question_id: 'q1', response: 'The base case stops it.' }, 'http-course-answer-1'); assert.equal(answered.status, 201); assert.equal(answered.data.reference_answer, 'A base case.');
  const assessed = await call(`/course-studio/attempts/${answered.data.item.id}/assess`, 'POST', { expected_revision: 1, assessment: 'correct', reviewed_by_student: true }); assert.equal(assessed.status, 200); assert.equal(assessed.data.item.data.mastery_claim, false);
  await call(`/sources/${f.folder.id}/revoke`, 'POST', { expected_revision: 1 }); const denied = await call(`/course-studio/sessions/${studio.id}`); assert.equal(denied.status, 403); assert.equal(JSON.stringify(denied.data).includes('Base cases'), false);
  await runtime.close();
  const reopened = LocalStore.open({ root: f.root }); try { const saved = reopened.getWorkspaceRecord(answered.data.item.id); assert.equal(saved.data.exact_student_response, 'The base case stops it.'); assert.equal(saved.data.assessment, 'correct'); assert.equal(reopened.listTasks().length, 0); } finally { reopened.close(); }
});

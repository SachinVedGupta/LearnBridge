import { createHash } from 'node:crypto';
import { LearnBridgeError } from '@learnbridge/core';

const STUDIO = 'learnbridge_course_studio.v1', MESSAGE = 'learnbridge_course_message.v1', QUIZ = 'learnbridge_course_quiz.v1', ATTEMPT = 'learnbridge_course_attempt.v1', ANNOTATION = 'learnbridge_course_annotation.v1';
const fail = code => { throw new LearnBridgeError(code); };
const sha = text => createHash('sha256').update(text).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = value => sha(canonical(value));
function plain(value, keys, required = keys) { if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) || !('value' in Object.getOwnPropertyDescriptor(value, key))) || required.some(key => !Object.hasOwn(value, key))) fail('INVALID_INPUT'); }
function safeInput(value) {
  let nodes = 0; const visited = new Set();
  function walk(item, depth) {
    if (++nodes > 2000 || depth > 12) fail('BUDGET_EXCEEDED');
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return item;
    if (!item || typeof item !== 'object' || visited.has(item)) fail('INVALID_INPUT');
    visited.add(item); const descriptors = Object.getOwnPropertyDescriptors(item); let result;
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || item.length > 200 || Reflect.ownKeys(descriptors).some(key => key !== 'length' && (!/^\d+$/.test(String(key)) || !('value' in descriptors[key]) || !descriptors[key].enumerable)) || Reflect.ownKeys(descriptors).length !== item.length + 1) fail('INVALID_INPUT');
      result = Array.from({ length: item.length }, (_, index) => { if (!Object.hasOwn(descriptors, index)) fail('INVALID_INPUT'); return walk(descriptors[index].value, depth + 1); });
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype || Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key) || !('value' in descriptors[key]) || !descriptors[key].enumerable)) fail('INVALID_INPUT');
      result = Object.fromEntries(Object.keys(descriptors).map(key => [key, walk(descriptors[key].value, depth + 1)]));
    }
    visited.delete(item); return result;
  }
  const result = walk(value, 0); if (Buffer.byteLength(JSON.stringify(result)) > 64000) fail('BUDGET_EXCEEDED'); return result;
}
function id(value) { if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) fail('INVALID_INPUT'); return value.toLowerCase(); }
function integer(value, min = 1, max = 200) { if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_INPUT'); return value; }
function text(value, max = 4000) { if (typeof value !== 'string' || !value.trim() || value.includes('\0') || /[\ud800-\udfff]/u.test(value) || Buffer.byteLength(value) > max) fail('INVALID_INPUT'); return value; }
function excerpt(value, maxBytes) { let result = '', bytes = 0; for (const character of value) { const size = Buffer.byteLength(character); if (bytes + size > maxBytes) break; result += character; bytes += size; } return result; }
// The host's first selected-context read has a fixed 32,000-byte envelope.
// Count the note as its JSON string in that envelope, retaining 8,000 bytes
// for identity, document metadata and broker accounting. Never truncate pins.
function readableNote(value) { if (Buffer.byteLength(JSON.stringify(value)) > 24000) fail('BUDGET_EXCEEDED'); }
function retryKey(value, prefix) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(value)) fail('INVALID_INPUT'); return `${prefix}-${sha(value)}`; }
function exact(record, input) { integer(input.expected_revision, 1, Number.MAX_SAFE_INTEGER); if (input.expected_revision !== record.revision || input.studio_hash !== record.data.studio_hash) fail('REVISION_CONFLICT'); }
function boundedBlock(answer, marker) {
  const begin = `BEGIN_LEARNBRIDGE_${marker}_V1`, end = `END_LEARNBRIDGE_${marker}_V1`;
  if (typeof answer !== 'string' || Buffer.byteLength(answer) > 64000 || answer.split(begin).length !== 2 || answer.split(end).length !== 2) fail('VERSION_MISMATCH');
  const start = answer.indexOf(begin) + begin.length, finish = answer.indexOf(end); if (finish <= start) fail('VERSION_MISMATCH');
  const body = answer.slice(start, finish).trim(); if (Buffer.byteLength(body) > 16000) fail('BUDGET_EXCEEDED');
  let value; try { value = JSON.parse(body); } catch { fail('VERSION_MISMATCH'); } return value;
}
function parseQuiz(answer, pin) {
  const payload = boundedBlock(answer, 'QUIZ'); plain(payload, ['version', 'questions']);
  if (payload.version !== 1 || !Array.isArray(payload.questions) || payload.questions.length < 1 || payload.questions.length > 5) fail('VERSION_MISMATCH');
  return payload.questions.map((row, index) => {
    plain(row, ['question', 'answer', 'explanation', 'citation']); plain(row.citation, ['source_entry_id', 'physical_page', 'page_sha256']);
    if (row.citation.source_entry_id !== pin.id || row.citation.physical_page !== pin.physical_page || row.citation.page_sha256 !== pin.page_sha256) fail('VERSION_MISMATCH');
    return { id: `q${index + 1}`, question: text(row.question, 2000), answer: text(row.answer, 3000), explanation: text(row.explanation, 3000), citation: row.citation };
  });
}
function parsePointers(answer, pageText) {
  if (!answer.includes('BEGIN_LEARNBRIDGE_POINTERS_V1')) return [];
  const payload = boundedBlock(answer, 'POINTERS'); plain(payload, ['version', 'quotes']);
  if (payload.version !== 1 || !Array.isArray(payload.quotes) || payload.quotes.length > 5) fail('VERSION_MISMATCH');
  return payload.quotes.map(row => { plain(row, ['quote', 'label']); const quote = text(row.quote, 512); if (!pageText.includes(quote)) fail('VERSION_MISMATCH'); return { quote, label: text(row.label, 200) }; });
}
function rectangle(value) { plain(value, ['x', 'y', 'width', 'height']); for (const key of Object.keys(value)) if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0 || value[key] > 1) fail('INVALID_INPUT'); if (value.width < 0.005 || value.height < 0.005 || value.x + value.width > 1.000001 || value.y + value.height > 1.000001) fail('INVALID_INPUT'); return { ...value }; }
function stripQuestions(record, answers = false) { return { ...record, data: { ...record.data, questions: record.data.questions.map(question => answers ? question : ({ id: question.id, question: question.question, citation: question.citation })) } }; }

/** Paired-human course sessions; the actual Codex host owns execution and grant enforcement. */
export function createCourseStudioService({ store, learningService, hostTurns, readPdfAsset }) {
  if (!store || !hostTurns || typeof hostTurns.start !== 'function') fail('INVALID_INPUT');
  const records = format => store.listWorkspaceRecords({ kind: 'artifact' }).filter(row => row.data.format === format);
  const record = (recordId, format) => { const row = store.getWorkspaceRecord(id(recordId)); if (!row || row.kind !== 'artifact' || row.data.format !== format) fail('SCOPE_DENIED'); return row; };
  function current(recordId) {
    const row = record(recordId, STUDIO), pin = row.data.source_pin, entry = store.getSourceEntry(pin.id);
    if (!entry || !entry.pdf || entry.version !== pin.version || entry.sha256 !== pin.text_sha256 || entry.pdf.source_sha256 !== pin.original_sha256) fail('VERSION_MISMATCH');
    const page = entry.pdf.pages.find(value => value.physical_page === pin.physical_page); if (!page || page.sha256 !== pin.page_sha256) fail('VERSION_MISMATCH');
    const originalInventory = store.getSourceInventory(entry.inventory_id), originalPath = originalInventory.inventory.entries.find(item => item.id === entry.entry_id)?.relativePath;
    for (const candidate of store.listSourceEntries(entry.source_id)) {
      if (candidate.id === entry.id || candidate.created_at < entry.created_at) continue;
      const chosen = store.getSourceInventory(candidate.inventory_id).inventory.entries.find(item => item.id === candidate.entry_id);
      if (chosen?.relativePath === originalPath && candidate.version !== entry.version) fail('VERSION_MISMATCH');
    }
    if (row.data.learning_pin) { const selected = learningService?.getSession(row.data.learning_pin.id); if (!selected || selected.revision !== row.data.learning_pin.revision || selected.data.recipe.session_hash !== row.data.learning_pin.session_hash) fail('VERSION_MISMATCH'); }
    const note = store.getDocument(row.data.context_document.id); if (!note || note.document.revision !== row.data.context_document.revision || note.sha256 !== row.data.context_document.sha256) fail('VERSION_MISMATCH');
    if (hash({ source_pin: row.data.source_pin, learning_pin: row.data.learning_pin, academic_policy: row.data.academic_policy, context_document: row.data.context_document }) !== row.data.studio_hash) fail('VERSION_MISMATCH');
    return { row, entry, page };
  }
  const replay = (format, key, requestHash) => { const old = records(format).find(row => row.data.client_request_key === key); if (old && old.data.request_hash !== requestHash) fail('REVISION_CONFLICT'); return old; };
  function singleNoteGrant(row, grantId) {
    const grant = store.getAgentGrant(grantId), note = row.data.context_document;
    if (grant.pins.tasks.length || grant.pins.source_entries.length || grant.pins.documents.length !== 1 || grant.pins.documents[0].id !== note.id) fail('SCOPE_DENIED');
    return store.assertAgentDocumentSelection({ destination: 'codex', grant_id: grantId, document_id: note.id, revision: note.revision, sha256: note.sha256 });
  }
  function output(messageId) {
    const message = record(messageId, MESSAGE), { row } = current(message.data.studio_id); singleNoteGrant(row, message.data.grant_id); const turn = hostTurns.get(message.data.host_turn_id);
    if (turn.data.state !== 'completed' || turn.data.visibility !== 'selected_grant_current' || !turn.data.text || sha(turn.data.text) !== turn.data.output_sha256) fail('REVISION_CONFLICT');
    if (turn.data.grant_id !== message.data.grant_id || turn.data.prompt !== message.data.prompt) fail('VERSION_MISMATCH');
    return { message, turn };
  }
  const service = {
    capability: () => ({ id: 'course_studio', state: 'available', pdf_rendering: typeof readPdfAsset === 'function' ? 'macos_selected_page' : 'unavailable', ai_host: hostTurns.capability?.() || null, visual_model_access: false, automatic_mastery: false }),
    list() { return records(STUDIO).map(row => { let stale = false; try { current(row.id); } catch { stale = true; } return { id: row.id, title: row.title, revision: row.revision, stale, physical_page: row.data.source_pin.physical_page, source_title: row.data.source_title, source_pin: { ...row.data.source_pin }, learning_pin: row.data.learning_pin ? { ...row.data.learning_pin } : null, academic_policy: { ...row.data.academic_policy }, created_at: row.created_at }; }); },
    create(input, { idempotencyKey } = {}) {
      input = safeInput(input);
      plain(input, ['source_entry_id', 'physical_page', 'title', 'academic_policy', 'learning_session_id', 'expected_learning_pin', 'confirmed'], ['source_entry_id', 'physical_page', 'title', 'academic_policy', 'confirmed']);
      if (input.confirmed !== true) fail('CONSENT_REQUIRED'); text(input.title, 500); plain(input.academic_policy, ['grading', 'ai_rule']);
      if (!['graded', 'ungraded', 'unknown'].includes(input.academic_policy.grading) || !['allowed', 'scaffolding_only', 'prohibited', 'unknown'].includes(input.academic_policy.ai_rule)) fail('INVALID_INPUT');
      if (input.academic_policy.ai_rule === 'prohibited') fail('SCOPE_DENIED');
      const key = retryKey(idempotencyKey, 'studio'), requestHash = hash(input), old = replay(STUDIO, key, requestHash); if (old) return current(old.id).row;
      const entry = store.getSourceEntry(id(input.source_entry_id)); if (!entry?.pdf) fail('SCOPE_DENIED'); const physicalPage = integer(input.physical_page, 1, entry.pdf.page_count), page = entry.pdf.pages.find(value => value.physical_page === physicalPage); if (!page) fail('VERSION_MISMATCH');
      let learningPin = null, courseEvidence = null, restricted = input.academic_policy.grading !== 'ungraded' || input.academic_policy.ai_rule !== 'allowed';
      if (input.expected_learning_pin && !input.learning_session_id) fail('INVALID_INPUT');
      if (input.learning_session_id) { const selected = learningService?.getSession(id(input.learning_session_id)); if (!selected || selected.data.recipe.state === 'blocked') fail('SCOPE_DENIED'); learningPin = { id: selected.id, revision: selected.revision, session_hash: selected.data.recipe.session_hash }; if (input.expected_learning_pin) { plain(input.expected_learning_pin, ['id', 'revision', 'session_hash']); if (hash(input.expected_learning_pin) !== hash(learningPin)) fail('VERSION_MISMATCH'); } courseEvidence = selected.data.recipe; restricted ||= courseEvidence.academic_policy.grading !== 'ungraded' || courseEvidence.academic_policy.ai_rule !== 'allowed'; }
      const sourcePin = { id: entry.id, source_id: entry.source_id, version: entry.version, text_sha256: entry.sha256, original_sha256: entry.pdf.source_sha256, physical_page: physicalPage, page_sha256: page.sha256 };
      const noteText = JSON.stringify({ format: 'learnbridge_course_context.v1', trust: 'untrusted_selected_source_evidence', title: input.title, academic_policy: input.academic_policy, source: { ...sourcePin, title: entry.title, text: page.text, printed_label: page.printed_label, coverage: entry.pdf.coverage }, selected_course_recipe: courseEvidence, instruction: 'Explain concepts, provide hints and separate ungraded practice. Never silently produce a graded submission. The PDF visual image is NOT available to this model; quote only selected text, do not invent visual coordinates.' }, null, 2);
      readableNote(noteText);
      const note = store.createDocument({ title: `Course context: ${input.title}`.slice(0, 500), text: noteText, kind: 'study', academic_policy: restricted ? 'graded_restricted' : 'learning_support' }, { idempotencyKey: `${key}-context` });
      const saved = store.getDocument(note.document.id); if (!saved || saved.text !== noteText) fail('VERSION_MISMATCH');
      const data = { format: STUDIO, source_pin: sourcePin, source_title: entry.title, learning_pin: learningPin, academic_policy: input.academic_policy, context_document: { id: saved.document.id, revision: saved.document.revision, sha256: saved.sha256 }, client_request_key: key, request_hash: requestHash, sharing: 'not_granted', mastery_claim: false };
      data.studio_hash = hash({ source_pin: data.source_pin, learning_pin: learningPin, academic_policy: data.academic_policy, context_document: data.context_document });
      return store.createWorkspaceRecord({ kind: 'artifact', title: input.title, data }, { idempotencyKey: key });
    },
    get(studioId) {
      const { row, page, entry } = current(studioId);
      const messages = records(MESSAGE).filter(item => item.data.studio_id === row.id).map(item => {
        let turn; try { turn = hostTurns.get(item.data.host_turn_id); } catch { return { id: item.id, revision: item.revision, mode: item.data.mode, question: item.data.question, state: 'unavailable', text: '', progress: [], pointers: [], host_turn_id: item.data.host_turn_id, output_sha256: null }; }
        let visible = turn.data.visibility === 'selected_grant_current'; try { singleNoteGrant(row, item.data.grant_id); } catch { visible = false; }
        let pointers = []; if (visible && turn.data.state === 'completed' && item.data.mode === 'question') { try { pointers = parsePointers(turn.data.text, page.text); } catch {} }
        return { id: item.id, revision: item.revision, mode: item.data.mode, question: item.data.question, state: visible ? turn.data.state : 'withheld', text: visible && item.data.mode === 'question' ? turn.data.text : '', progress: visible ? turn.data.progress : [], error_code: visible ? turn.data.error_code : 'CONSENT_REQUIRED', host_turn_id: turn.id, output_sha256: visible ? turn.data.output_sha256 || null : null, pointers };
      });
      const quizzes = records(QUIZ).filter(item => item.data.studio_id === row.id);
      const attempts = records(ATTEMPT).filter(item => item.data.studio_id === row.id).map(attempt => {
        const parent = quizzes.find(quiz => quiz.id === attempt.data.quiz_id && quiz.revision === attempt.data.quiz_revision), question = parent?.data.questions.find(item => item.id === attempt.data.question_id);
        if (!question) fail('VERSION_MISMATCH'); return { ...attempt, reference_answer: question.answer, explanation: question.explanation };
      });
      return { item: row, page: { physical_page: page.physical_page, page_count: entry.pdf.page_count, printed_label: page.printed_label, text: page.text, sha256: page.sha256 }, messages, quizzes: quizzes.map(item => stripQuestions(item)), annotations: records(ANNOTATION).filter(item => item.data.studio_id === row.id), attempts };
    },
    async asset(studioId, options = {}) {
      const { row, entry } = current(studioId); if (typeof readPdfAsset !== 'function') fail('UNSUPPORTED');
      const asset = await readPdfAsset(entry, row.data.source_pin.physical_page, options); current(studioId);
      if (!asset || asset.source_sha256 !== row.data.source_pin.original_sha256 || asset.source_version !== row.data.source_pin.version || asset.physical_page !== row.data.source_pin.physical_page || typeof asset.png_base64 !== 'string') fail('VERSION_MISMATCH'); return asset;
    },
    async start(studioId, input, { idempotencyKey, authorize } = {}) {
      input = safeInput(input);
      plain(input, ['expected_revision', 'studio_hash', 'grant_id', 'mode', 'question', 'confirmed']);
      const { row } = current(studioId); exact(row, input); if (input.confirmed !== true || typeof authorize !== 'function' || authorize() !== true) fail('CONSENT_REQUIRED');
      readableNote(store.getDocument(row.data.context_document.id).text);
      if (!['question', 'quiz'].includes(input.mode)) fail('INVALID_INPUT'); text(input.question, 4000); const grant = singleNoteGrant(row, input.grant_id);
      const key = retryKey(idempotencyKey, 'studio-message'), requestHash = hash({ studio_id: row.id, ...input }), old = replay(MESSAGE, key, requestHash); if (old) return { item: old, host_turn: hostTurns.get(old.data.host_turn_id) };
      await service.asset(row.id);
      if (authorize() !== true) fail('CONSENT_REQUIRED');
      const pin = row.data.source_pin;
      const instructions = input.mode === 'quiz' ? `Create 3 ungraded short-answer practice questions grounded only in the selected page and course context. If evidence is insufficient, explain the limitation and do not emit a quiz. Otherwise output exactly one block BEGIN_LEARNBRIDGE_QUIZ_V1 then a JSON object {"version":1,"questions":[{"question":"...","answer":"...","explanation":"...","citation":{"source_entry_id":"${pin.id}","physical_page":${pin.physical_page},"page_sha256":"${pin.page_sha256}"}}]} then END_LEARNBRIDGE_QUIZ_V1. Maximum 5 questions. Answers are proposals for student review, not proof of mastery.` : `Answer as a tutor using exact selected page ${pin.physical_page} and course context. Cite the physical page and explain uncertainty. Ask a useful check. You have extracted text, NOT the visual PDF. Optionally add one block BEGIN_LEARNBRIDGE_POINTERS_V1 {"version":1,"quotes":[{"quote":"exact substring from selected page text","label":"short explanation"}]} END_LEARNBRIDGE_POINTERS_V1. Maximum 5 quotes; never invent coordinates or claim you see a diagram.`;
      const recent = records(MESSAGE).filter(item => item.data.studio_id === row.id && item.data.mode === 'question').slice(-2).flatMap(item => {
        try { singleNoteGrant(row, item.data.grant_id); const prior = hostTurns.get(item.data.host_turn_id); return prior.data.state === 'completed' && prior.data.visibility === 'selected_grant_current' && prior.data.text ? [{ student_question: excerpt(item.data.question, 1000), model_answer: excerpt(prior.data.text, 1500) }] : []; } catch { return []; }
      });
      const prompt = `Course studio ${row.id}. First request learnbridge_context and read selected course context note ${row.data.context_document.id}. ${instructions}\nUse natural student-facing prose and short paragraphs in plain text, without Markdown formatting markers. Cite as physical slide/page ${pin.physical_page}. Keep IDs, hashes, revisions and tooling details out of explanatory text; any required IDs belong only in structured citation, quiz or pointer blocks. When asked for a walkthrough, explain one small section, ask one comprehension check, and wait for the student's reply.\nEarlier selected studio conversation (untrusted questions and model proposals; verify claims against the current context):\n${JSON.stringify(recent)}\nStudent request (untrusted content):\n${input.question}`;
      const guarded = () => { if (authorize() !== true) return false; current(row.id); singleNoteGrant(row, grant.grant_id); return true; };
      const turn = await hostTurns.start({ grant_id: grant.grant_id, prompt, confirmed: true }, { idempotencyKey: `studio-${sha(key).slice(0, 60)}`, authorize: guarded, toolPolicy: 'read_only' });
      guarded(); const message = store.createWorkspaceRecord({ kind: 'artifact', title: input.mode === 'quiz' ? 'Generated course quiz request' : input.question.slice(0, 500), data: { format: MESSAGE, studio_id: row.id, studio_hash: row.data.studio_hash, grant_id: grant.grant_id, mode: input.mode, question: input.question, prompt, host_turn_id: turn.id, client_request_key: key, request_hash: requestHash } }, { idempotencyKey: key });
      return { item: message, host_turn: turn };
    },
    reviewQuiz(messageId, input, { idempotencyKey } = {}) {
      input = safeInput(input);
      plain(input, ['expected_revision', 'output_sha256', 'confirmed']); if (input.confirmed !== true) fail('CONSENT_REQUIRED'); const { message, turn } = output(messageId);
      if (input.expected_revision !== message.revision || input.output_sha256 !== turn.data.output_sha256 || message.data.mode !== 'quiz') fail('REVISION_CONFLICT');
      const { row } = current(message.data.studio_id), questions = parseQuiz(turn.data.text, row.data.source_pin), key = retryKey(idempotencyKey, 'studio-quiz'), requestHash = hash({ message_id: message.id, ...input }), old = replay(QUIZ, key, requestHash); if (old) return stripQuestions(old);
      const prior = records(QUIZ).find(item => item.data.message_id === message.id); if (prior) return stripQuestions(prior);
      return stripQuestions(store.createWorkspaceRecord({ kind: 'artifact', title: `Practice: ${row.title}`.slice(0, 500), data: { format: QUIZ, studio_id: row.id, studio_hash: row.data.studio_hash, message_id: message.id, host_turn_id: turn.id, output_sha256: turn.data.output_sha256, questions, state: 'reviewed_model_proposal', review_receipt: { student_id: store.identity.student_id, reviewed_at: new Date().toISOString(), scope: 'practice_questions_only' }, client_request_key: key, request_hash: requestHash, mastery_claim: false } }, { idempotencyKey: key }));
    },
    quizPreview(messageId) { const { message, turn } = output(messageId); if (message.data.mode !== 'quiz') fail('INVALID_INPUT'); const { row } = current(message.data.studio_id); return { message_id: message.id, message_revision: message.revision, output_sha256: turn.data.output_sha256, questions: parseQuiz(turn.data.text, row.data.source_pin), assessment: 'model_proposal_requires_review' }; },
    answer(quizId, input, { idempotencyKey } = {}) {
      input = safeInput(input);
      plain(input, ['expected_revision', 'question_id', 'response']); const quiz = record(quizId, QUIZ); current(quiz.data.studio_id); if (input.expected_revision !== quiz.revision) fail('REVISION_CONFLICT'); text(input.response, 6000);
      const question = quiz.data.questions.find(value => value.id === input.question_id); if (!question) fail('INVALID_INPUT'); const key = retryKey(idempotencyKey, 'studio-answer'), requestHash = hash({ quiz_id: quiz.id, ...input }), old = replay(ATTEMPT, key, requestHash); if (old) return { item: old, reference_answer: question.answer, explanation: question.explanation };
      const item = store.createWorkspaceRecord({ kind: 'artifact', title: `Attempt: ${question.question}`.slice(0, 500), data: { format: ATTEMPT, studio_id: quiz.data.studio_id, quiz_id: quiz.id, quiz_revision: quiz.revision, question_id: question.id, question: question.question, exact_student_response: input.response, citation: question.citation, assessment: 'unassessed', mastery_claim: false, attempted_at: new Date().toISOString(), client_request_key: key, request_hash: requestHash } }, { idempotencyKey: key }); return { item, reference_answer: question.answer, explanation: question.explanation };
    },
    assess(attemptId, input) {
      input = safeInput(input);
      plain(input, ['expected_revision', 'assessment', 'reviewed_by_student']); const attempt = record(attemptId, ATTEMPT); current(attempt.data.studio_id);
      if (!['correct', 'partly_correct', 'needs_practice'].includes(input.assessment) || input.reviewed_by_student !== true) fail('INVALID_INPUT');
      if (attempt.data.assessment === input.assessment && [attempt.revision, attempt.revision - 1].includes(input.expected_revision)) return attempt; if (input.expected_revision !== attempt.revision) fail('REVISION_CONFLICT');
      return store.updateWorkspaceRecord(attempt.id, { expected_revision: attempt.revision, data: { ...attempt.data, assessment: input.assessment, review_receipt: { student_id: store.identity.student_id, reviewed_at: new Date().toISOString(), basis: 'student_compared_model_reference_answer', mastery_claim: false } } });
    },
    async annotate(studioId, input, { idempotencyKey, signal } = {}) {
      input = safeInput(input);
      plain(input, ['expected_revision', 'studio_hash', 'rectangle', 'label', 'message_id', 'quote_index', 'confirmed'], ['expected_revision', 'studio_hash', 'label', 'confirmed']); const { row, page } = current(studioId); exact(row, input); if (input.confirmed !== true) fail('CONSENT_REQUIRED'); text(input.label, 200);
      let rect, origin = 'student', modelSource = null;
      if (input.message_id !== undefined) {
        if (input.rectangle !== undefined) fail('INVALID_INPUT'); const { message, turn } = output(input.message_id); if (message.data.studio_id !== row.id || message.data.mode !== 'question') fail('SCOPE_DENIED');
        const pointer = parsePointers(turn.data.text, page.text)[integer(input.quote_index, 0, 4)]; if (!pointer) fail('INVALID_INPUT');
        const asset = await service.asset(row.id, { signal }); const regions = asset.text_regions.filter(region => region.text.includes(pointer.quote)); if (regions.length !== 1) fail('UNSUPPORTED'); rect = rectangle({ x: regions[0].x, y: regions[0].y, width: regions[0].width, height: Math.max(0.005, regions[0].height) }); origin = 'model_quote_reviewed'; modelSource = { message_id: message.id, output_sha256: turn.data.output_sha256, quote: pointer.quote };
      } else { if (input.quote_index !== undefined) fail('INVALID_INPUT'); rect = rectangle(input.rectangle); await service.asset(row.id, { signal }); }
      current(row.id); const key = retryKey(idempotencyKey, 'studio-annotation'), requestHash = hash({ studio_id: row.id, ...input }), old = replay(ANNOTATION, key, requestHash); if (old) return old;
      if (records(ANNOTATION).filter(item => item.data.studio_id === row.id).length >= 100) fail('BUDGET_EXCEEDED');
      return store.createWorkspaceRecord({ kind: 'artifact', title: input.label, data: { format: ANNOTATION, studio_id: row.id, studio_hash: row.data.studio_hash, page_pin: row.data.source_pin, rectangle: rect, label: input.label, shape: 'ellipse', coordinate_system: 'normalized_rendered_page_top_left', origin, model_source: modelSource, client_request_key: key, request_hash: requestHash } }, { idempotencyKey: key });
    },
    removeAnnotation(annotationId, expectedRevision) { const selected = record(annotationId, ANNOTATION); current(selected.data.studio_id); return store.deleteWorkspaceRecord(selected.id, integer(expectedRevision, 1, Number.MAX_SAFE_INTEGER)); },
  };
  return service;
}

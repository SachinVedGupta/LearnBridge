import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { block, exact, lectureFixture, sha } from './fixtures/lecture-test-support.mjs';
import { handleLectureRoute } from '../apps/local-runtime/src/lecture-routes.mjs';

// Real SQLite, source pins, Course studio and host-turn orchestration are used.
// The model and native media seams are synthetic and have separate live gates.
test('LS01 selected lecture pages are copied exactly once into one private context; no sharing/model/media implicit', async t => {
  const f = lectureFixture(t), beforeNotes = f.store.listDocuments().length, created = await f.create();
  assert.equal(created.item.title, 'Understanding recursion'); assert.equal(created.chapters.length, 0); assert.equal(f.store.listDocuments().length, beforeNotes + 1); assert.equal(f.store.listAgentGrants().length, 0); assert.equal(f.seen.length, 0); assert.equal(f.mediaCalls.length, 0);
  const note = f.store.getDocument(created.context_document.id); for (const page of f.pages) assert(note.text.includes(page.text)); assert(!note.text.includes('UNSELECTED_LECTURE_PRIVATE_CANARY'));
  assert.equal((await f.create()).item.id, created.item.id); assert.equal(f.store.listDocuments().length, beforeNotes + 1); await assert.rejects(f.create({ title: 'Different retry' }), { code: 'REVISION_CONFLICT' });
  const listed = f.service.list(f.studio.id); assert.equal(listed.length, 1); assert(!JSON.stringify(listed).includes(f.pages[0].text));
});

test('LS02 source/page/parent revision selection and consent fail before context copies', async t => {
  const f = lectureFixture(t), before = f.store.listDocuments().length;
  for (const changed of [{ pages: [] }, { pages: [1, 1] }, { pages: [2, 1] }, { pages: [0] }, { pages: [3] }, { expected_revision: 999 }, { studio_hash: sha('wrong') }, { quiz_every: 0 }, { quiz_every: 5 }, { confirmed: false }, { injected: true }]) await assert.rejects(f.create(changed));
  assert.equal(f.store.listDocuments().length, before); assert.equal(f.service.list(f.studio.id).length, 0); assert.equal(f.seen.length, 0); assert.equal(f.mediaCalls.length, 0);
  let getter = 0; const bad = {}; Object.defineProperty(bad, 'pages', { enumerable: true, get() { getter++; return [1, 2]; } }); await assert.rejects(f.service.create(f.studio.id, bad, { idempotencyKey: 'lecture-getter-fixture-1' })); assert.equal(getter, 0);
});

test('LS03 serialized source budget includes UTF-8 and JSON escaping without silently trimming selected slides', async t => {
  for (const pageTexts of [['A base case ends recursion.', 'A'.repeat(25000)], ['A base case ends recursion.', '"\\'.repeat(8000)], ['A base case ends recursion.', '🧠'.repeat(7000)]]) {
    const f = lectureFixture(t, { pageTexts }), beforeNotes = f.store.listDocuments().length; await assert.rejects(f.create(), { code: 'BUDGET_EXCEEDED' }); assert.equal(f.store.listDocuments().length, beforeNotes); assert.equal(f.store.getSourceEntry(f.entry.id).pdf.pages[1].text, pageTexts[1]); assert.equal(f.store.listAgentGrants().length, 0); assert.equal(f.seen.length, 0);
  }
});

test('LS04 exact reviewed prompt and one-note read-only host run preserve real receipts; broad grants fail before rendering', async t => {
  const f = lectureFixture(t), created = await f.create(), note = f.store.createDocument({ title: 'Extra note', text: 'UNSELECTED_MODEL_CANARY' }), broad = f.store.createAgentGrant({ destination: 'codex', document_ids: [created.context_document.id, note.document.id], task_ids: [], source_entry_ids: [], max_bytes: 256000, expires_in_minutes: 30 }), preview = f.service.previewRun(created.item.id, exact(created));
  await assert.rejects(f.service.run(created.item.id, { ...exact(created), grant_id: broad.id, prompt_sha256: preview.prompt_sha256, confirmed: true }, { idempotencyKey: 'lecture-broad-run-1', authorize: f.authority }), { code: 'SCOPE_DENIED' }); assert.equal(f.store.getAgentGrant(broad.id).used_bytes, 0); assert.equal(f.seen.length, 0); assert.equal(f.renders.length, 0);
  const grant = f.grant(created); await assert.rejects(f.service.run(created.item.id, { ...exact(created), grant_id: grant.id, prompt_sha256: sha('changed prompt'), confirmed: true }, { idempotencyKey: 'lecture-wrong-prompt-1', authorize: f.authority }), { code: 'REVISION_CONFLICT' });
  const generated = await f.settle(await f.run(created, grant)); assert.equal(f.seen.length, 1); assert.equal(f.seen[0].input.toolPolicy, 'read_only'); assert.equal(f.seen[0].context.documents.length, 1); assert.equal(f.seen[0].context.documents[0].id, created.context_document.id); assert.equal(f.seen[0].context.source_entries.length, 0); assert(!JSON.stringify(f.seen[0].context).includes('UNSELECTED_LECTURE_PRIVATE_CANARY')); assert(f.seen[0].context.serialized_bytes <= 32000);
  assert.match(f.seen[0].input.prompt, /BEGIN_LEARNBRIDGE_LECTURE_V1/); assert.equal(generated.chapters.length, 0, 'AI proposals do not become playable before review'); assert.equal(f.mediaCalls.length, 0); const review = f.service.reviewPreview(generated.item.id); assert.equal(review.chapters.length, 2); assert.equal(review.chapters[1].physical_page, 2);
});

test('LS05 exact output review hash gates playable lecture; references remain hidden until actual quiz answer', async t => {
  const f = lectureFixture(t), created = await f.create(), grant = f.grant(created), generated = await f.settle(await f.run(created, grant)), preview = f.service.reviewPreview(created.item.id);
  for (const changed of [{ output_sha256: sha('wrong') }, { pack_hash: sha('wrong') }, { confirmed: false }, { expected_revision: 999 }]) await assert.rejects(f.service.accept(created.item.id, { ...exact(generated), output_sha256: preview.output_sha256, pack_hash: preview.pack_hash, confirmed: true, ...changed }));
  const accepted = await f.accept(generated); assert.equal(accepted.chapters.length, 2); assert(accepted.chapters[1].quiz); assert.equal('answer' in accepted.chapters[1].quiz, false); assert.equal('explanation' in accepted.chapters[1].quiz, false); assert.equal(JSON.stringify(accepted).includes('A base case.'), false); assert.equal(f.store.listTasks().length, 0);
  await assert.rejects(f.service.answer(accepted.item.id, { ...exact(accepted), quiz_id: accepted.chapters[1].quiz.id, response: '' })); const answered = await f.service.answer(accepted.item.id, { ...exact(accepted), quiz_id: accepted.chapters[1].quiz.id, response: 'At zero a base case returns without another recursive call.' }, { idempotencyKey: 'lecture-answer-fixture-1' }); assert.equal(answered.reference_answer, 'A base case.'); assert.equal(answered.attempt.data.exact_student_response, 'At zero a base case returns without another recursive call.'); assert.equal(answered.attempt.data.mastery_claim, false); assert(answered.item.progress.answered_quiz_ids.includes(accepted.chapters[1].quiz.id));
});

test('LS06 parser rejects forged literal anchors, source citations, missing/reordered pages and unwanted schema fields', async t => {
  const mutations = [payload => { payload.chapters[0].evidence_quote = 'I saw a diagram that proves mastery.'; }, payload => { payload.chapters[0].citation.source_entry_id = randomUUID(); }, payload => { payload.chapters[0].citation.page_sha256 = sha('wrong'); }, payload => { payload.chapters.reverse(); }, payload => { payload.chapters.pop(); }, payload => { payload.chapters.push(payload.chapters[0]); }, payload => { payload.chapters[1].quiz = null; }, payload => { payload.chapters[1].quiz.evidence_quote = 'All tests passed.'; }, payload => { payload.chapters[0].score = 100; }, payload => { payload.chapters[0].narration = ''; }];
  for (const mutate of mutations) { const f = lectureFixture(t, { answer: payload => { mutate(payload); return payload; } }), created = await f.create(), generated = await f.settle(await f.run(created, f.grant(created))); assert.equal(generated.chapters.length, 0); assert.throws(() => f.service.reviewPreview(generated.item.id)); assert.equal(f.mediaCalls.length, 0); }
});

test('LS07 cancelled authority, revoked grant and revoked selected source prevent late proposal attachment', async t => {
  for (const revoke of ['authority', 'grant', 'source']) {
    let release; const f = lectureFixture(t, { executor: async (_, { text, context }) => new Promise(resolve => { release = () => resolve({ state: 'completed', complete: true, text, output_sha256: sha(text), tool_receipts: [{ tool: 'learnbridge_context', status: 'completed', failed: false, result_hash: sha(JSON.stringify(context)), origin: 'model' }], host_version: 'synthetic_fixture' }); }) }), created = await f.create(), grant = f.grant(created), running = await f.run(created, grant); for (let n = 0; !release && n < 20; n++) await delay(2);
    if (revoke === 'authority') f.setAuthority(false); else if (revoke === 'grant') { const current = f.store.getAgentGrant(grant.id); f.store.revokeAgentGrant(current.id, current.revision); } else f.store.revokeSource(f.folder.id, f.folder.revision); release(); await delay(10);
    if (revoke === 'source') await assert.rejects(f.service.get(running.item.id)); else { const view = await f.service.get(running.item.id); assert.equal(view.chapters.length, 0); assert.throws(() => f.service.reviewPreview(running.item.id)); } assert.equal(f.mediaCalls.length, 0);
  }
});

test('LS08 reviewed local lecture remains readable after generation grant revocation; source change still blocks it', async t => {
  const f = lectureFixture(t), { view, grant } = await f.accepted(), currentGrant = f.store.getAgentGrant(grant.id); f.store.revokeAgentGrant(currentGrant.id, currentGrant.revision); assert.equal((await f.service.get(view.item.id)).chapters.length, 2); assert.equal((await f.service.get(view.item.id)).chapters[0].narration, view.chapters[0].narration); f.changeSource(); await assert.rejects(f.service.get(view.item.id)); assert.throws(() => f.service.list(f.studio.id));
});

test('LS09 playback progress is optimistic concurrency data; quiz answers cannot be forged by playback and listening never means mastery', async t => {
  const f = lectureFixture(t), { view } = await f.accepted(), changed = await f.service.progress(view.item.id, { ...exact(view), chapter_index: 0, position_seconds: 1, state: 'paused', completed_chapter_ids: [] }); assert.equal(changed.progress.chapter_index, 0); assert.equal(changed.progress.state, 'paused'); assert.deepEqual(changed.progress.answered_quiz_ids, []); await assert.rejects(f.service.progress(view.item.id, { ...exact(view), chapter_index: 1, position_seconds: 0, state: 'playing', completed_chapter_ids: [] }), { code: 'REVISION_CONFLICT' });
  for (const altered of [{ chapter_index: 2 }, { position_seconds: -1 }, { completed_chapter_ids: ['p999'] }, { answered_quiz_ids: ['q2'] }, { mastery_claim: true }]) await assert.rejects(f.service.progress(view.item.id, { ...exact(changed), chapter_index: 0, position_seconds: 0, state: 'paused', completed_chapter_ids: [], ...altered }));
  assert.equal(changed.item.data.mastery_claim, false); assert.equal(f.store.listTasks().length, 0);
});

test('LS10 native preparation is explicit and bounded; saved audio/video route metadata pins exact returned bytes', async t => {
  const f = lectureFixture(t), { view } = await f.accepted(); assert.equal(f.mediaCalls.length, 0); const prepared = await f.service.prepareAudio(view.item.id, { ...exact(view), voice: 'Samantha', rate: 180, confirmed: true }, { idempotencyKey: 'lecture-audio-fixture-1', authorize: f.authority }); await f.service.drain(); let current = await f.service.get(view.item.id); assert.equal(f.mediaCalls.filter(call => call.operation === 'audio').length, 1); assert.equal(f.mediaCalls[0].input.segments.length, 2); assert.equal(f.mediaCalls[0].input.segments[0].page, 1); assert(Buffer.isBuffer(f.mediaCalls[0].input.segments[0].png)); assert.equal(current.audio.state, 'ready');
  const audio = await f.service.audio(current.item.id, 'p1', { authorize: f.authority }); const audioBytes = Buffer.isBuffer(audio) ? audio : audio.bytes; assert.deepEqual(audioBytes, Buffer.from('SYNTHETIC_AUDIO_1'));
  await f.service.exportVideo(current.item.id, { ...exact(current), confirmed: true }, { idempotencyKey: 'lecture-video-fixture-1', authorize: f.authority }); await f.service.drain(); current = await f.service.get(view.item.id); assert.equal(current.export.state, 'ready'); assert.equal(f.mediaCalls.filter(call => call.operation === 'video').length, 1); const video = await f.service.video(current.item.id, { authorize: f.authority }); assert.deepEqual(Buffer.isBuffer(video) ? video : video.bytes, Buffer.from('SYNTHETIC_MP4')); assert.equal(prepared.item.id, view.item.id);
});

test('LS11 restart preserves reviewed lecture, attempts and cursor but missing native cache does not generate automatically', async t => {
  const f = lectureFixture(t), { view } = await f.accepted(); await f.service.prepareAudio(view.item.id, { ...exact(view), voice: 'Samantha', rate: 180, confirmed: true }, { idempotencyKey: 'lecture-restart-audio-1', authorize: f.authority }); await f.service.drain(); let current = await f.service.get(view.item.id); const answer = await f.service.answer(current.item.id, { ...exact(current), quiz_id: current.chapters[1].quiz.id, response: 'A base case stops it.' }, { idempotencyKey: 'lecture-restart-answer-1' }); current = await f.service.progress(current.item.id, { ...exact(answer.item), chapter_index: 1, position_seconds: 1, state: 'paused', completed_chapter_ids: ['p1'] }); const beforeCalls = f.seen.length, beforeMedia = f.mediaCalls.filter(call => call.operation === 'audio').length; await f.reopen(); const restored = await f.service.get(current.item.id); assert.equal(restored.chapters.length, 2); assert.equal(restored.progress.chapter_index, 1); assert(restored.progress.answered_quiz_ids.includes('q2')); assert.equal(restored.audio.state, 'unavailable'); assert.equal(f.seen.length, beforeCalls); assert.equal(f.mediaCalls.filter(call => call.operation === 'audio').length, beforeMedia); assert.equal(f.store.integrity().integrity, 'ok');
});

test('LS12 media source revocation while native work is pending discards late result and exposes no download', async t => {
  let release; const f = lectureFixture(t, { mediaDelay: () => new Promise(resolve => { release = resolve; }), ignoreMediaCancellation: true }), { view } = await f.accepted(); await f.service.prepareAudio(view.item.id, { ...exact(view), voice: 'Samantha', rate: 180, confirmed: true }, { idempotencyKey: 'lecture-revoke-audio-1', authorize: f.authority }); for (let n = 0; !release && n < 20; n++) await delay(2); assert(release); f.store.revokeSource(f.folder.id, f.folder.revision); release(); await f.service.drain(); assert.equal(f.cache.size, 0); assert(f.mediaCalls.some(call => call.operation === 'remove')); await assert.rejects(f.service.audio(view.item.id, 'p1', { authorize: f.authority })); await assert.rejects(f.service.get(view.item.id));
});

test('LS13 clarification uses a fresh exact selected-context grant and reviewed question; revoked output is withheld', async t => {
  const f = lectureFixture(t, { executor: async (input, { text, context }) => { const response = input.prompt.includes('BEGIN_LEARNBRIDGE_LECTURE_V1') ? text : 'Physical slide 2: the stopping condition returns without another recursive call. What would happen if no such condition existed?'; return { state: 'completed', complete: true, text: response, output_sha256: sha(response), tool_receipts: [{ tool: 'learnbridge_context', status: 'completed', failed: false, result_hash: sha(JSON.stringify(context)), origin: 'model' }], host_version: 'synthetic_clarification_fixture' }; } }), { view, grant } = await f.accepted();
  const old = f.store.getAgentGrant(grant.id); f.store.revokeAgentGrant(old.id, old.revision); const selection = { ...exact(view), chapter_id: 'p2', question: 'Why does a base case prevent another call?' }, preview = f.service.clarificationPreview(view.item.id, selection);
  await assert.rejects(f.service.clarify(view.item.id, { ...selection, grant_id: grant.id, prompt_sha256: preview.prompt_sha256, confirmed: true }, { idempotencyKey: 'lecture-old-clarification-1', authorize: f.authority })); const fresh = f.grant(view);
  await assert.rejects(f.service.clarify(view.item.id, { ...selection, grant_id: fresh.id, prompt_sha256: sha('changed question'), confirmed: true }, { idempotencyKey: 'lecture-wrong-clarification-1', authorize: f.authority }), { code: 'REVISION_CONFLICT' });
  await f.service.clarify(view.item.id, { ...selection, grant_id: fresh.id, prompt_sha256: preview.prompt_sha256, confirmed: true }, { idempotencyKey: 'lecture-clarification-fixture-1', authorize: f.authority }); let result; for (let n = 0; n < 30; n++) { result = await f.service.get(view.item.id); if (result.clarifications[0]?.state === 'completed') break; await delay(2); }
  assert.equal(result.clarifications[0].state, 'completed'); assert.match(result.clarifications[0].text, /What would happen/); assert.equal(f.seen.length, 2); assert.equal(f.seen[1].input.toolPolicy, 'read_only'); assert.equal(f.seen[1].context.documents.length, 1); assert.match(f.seen[1].input.prompt, /Why does a base case prevent another call/); assert.equal(f.store.listTasks().length, 0);
  const current = f.store.getAgentGrant(fresh.id); f.store.revokeAgentGrant(current.id, current.revision); result = await f.service.get(view.item.id); assert.equal(result.chapters.length, 2); assert.equal(result.clarifications[0].state, 'withheld'); assert.equal(result.clarifications[0].text, '');
});

test('LS14 exact source image hash and a changed context note block native preparation and disclosure', async t => {
  const mismatched = lectureFixture(t, { alteredAsset: true }), { view } = await mismatched.accepted(); await assert.rejects(mismatched.service.asset(view.item.id, 'p1'), { code: 'VERSION_MISMATCH' }); await mismatched.service.prepareAudio(view.item.id, { ...exact(view), voice: 'Samantha', rate: 180, confirmed: true }, { authorize: mismatched.authority }); await mismatched.service.drain(); assert.equal(mismatched.mediaCalls.length, 0); assert.equal((await mismatched.service.get(view.item.id)).audio.state, 'failed');
  const edited = lectureFixture(t), accepted = (await edited.accepted()).view, note = edited.store.getDocument(accepted.context_document.id); edited.store.updateDocument(note.document.id, { text: 'FORGED_LECTURE_CONTEXT' }, note.document.revision); await assert.rejects(edited.service.get(accepted.item.id), { code: 'VERSION_MISMATCH' }); await assert.rejects(edited.service.asset(accepted.item.id, 'p1'), { code: 'VERSION_MISMATCH' }); assert.equal(edited.mediaCalls.length, 0);
});

test('LS15 explicit native cancellation rejects late transport success and never exposes retained audio', async t => {
  let release; const f = lectureFixture(t, { mediaDelay: () => new Promise(resolve => { release = resolve; }), ignoreMediaCancellation: true }), { view } = await f.accepted(); await f.service.prepareAudio(view.item.id, { ...exact(view), voice: 'Samantha', rate: 180, confirmed: true }, { authorize: f.authority }); for (let n = 0; !release && n < 20; n++) await delay(2); assert(release); const current = await f.service.get(view.item.id); await f.service.cancel(current.item.id, { ...exact(current), confirmed: true }); release(); await f.service.drain(); const stopped = await f.service.get(view.item.id); assert.equal(stopped.audio.state, 'failed'); assert.equal(f.cache.size, 0); assert(f.mediaCalls.some(call => call.operation === 'remove')); await assert.rejects(f.service.audio(view.item.id, 'p1', { authorize: f.authority })); assert.equal(f.mediaCalls.filter(call => call.operation === 'audio').length, 1);
});

test('LS16 restored lecture metadata and accepted script hashes reject a forged local artifact', async t => {
  for (const mutation of ['lecture_hash', 'accepted_pack']) {
    const f = lectureFixture(t), { view } = await f.accepted(), saved = f.store.getWorkspaceRecord(view.item.id), data = structuredClone(saved.data);
    if (mutation === 'lecture_hash') data.lecture_hash = sha('forged lecture base'); else data.pack[0].narration = 'TAMPERED_UNREVIEWED_NARRATION';
    f.store.updateWorkspaceRecord(saved.id, { expected_revision: saved.revision, data }); await assert.rejects(f.service.get(saved.id), { code: 'VERSION_MISMATCH' }); await assert.rejects(f.service.asset(saved.id, 'p1'), { code: 'VERSION_MISMATCH' }); assert.equal(f.mediaCalls.length, 0);
  }
});

test('LS17 private media read requires current student authority and rejects a corrupted returned buffer', async t => {
  const f = lectureFixture(t), { view } = await f.accepted(); await f.service.prepareAudio(view.item.id, { ...exact(view), voice: 'Samantha', rate: 180, confirmed: true }, { authorize: f.authority }); await f.service.drain(); f.setAuthority(false); await assert.rejects(f.service.audio(view.item.id, 'p1', { authorize: f.authority })); f.setAuthority(true);
  const readAsset = f.media.readAsset; f.media.readAsset = async (...args) => { const selected = await readAsset.apply(f.media, args); return { ...selected, data: Buffer.from('CORRUPTED_AUDIO') }; }; await assert.rejects(f.service.audio(view.item.id, 'p1', { authorize: f.authority }), { code: 'VERSION_MISMATCH' });
});

test('LS18 paired route requires current browser authority and exposes only fixed reviewed fields/methods', async t => {
  const f = lectureFixture(t), common = { service: f.service, session: { nonce: 'synthetic-paired-browser' }, stillAuthorized: f.authority, privateBody: async () => ({}) };
  assert.equal(await handleLectureRoute({ route: '/not-a-lecture', method: 'GET' }), null); await assert.rejects(handleLectureRoute({ ...common, session: null, route: '/lectures/capability', method: 'GET' }), { code: 'AUTH_REQUIRED' }); await assert.rejects(handleLectureRoute({ ...common, stillAuthorized: () => { throw Object.assign(Error('expired'), { code: 'AUTH_REQUIRED' }); }, route: '/lectures/capability', method: 'GET' }), { code: 'AUTH_REQUIRED' });
  await assert.rejects(handleLectureRoute({ ...common, route: '/lectures/capability', method: 'POST' }), { code: 'INVALID_INPUT' }); const created = await f.create(); await assert.rejects(handleLectureRoute({ ...common, route: `/lectures/${created.item.id}/run`, method: 'GET' }), { code: 'INVALID_INPUT' }); assert.equal(await handleLectureRoute({ ...common, route: `/lectures/${created.item.id}/run-shell`, method: 'POST' }), null);
  let acceptedKeys; const preview = await handleLectureRoute({ ...common, route: `/lectures/${created.item.id}/preview-run`, method: 'POST', privateBody: async allowed => { acceptedKeys = allowed; return exact(created); } }); assert.equal(preview.status, 200); assert.deepEqual(acceptedKeys, ['expected_revision', 'lecture_hash']); assert.equal(preview.data.prompt_sha256, sha(preview.data.prompt)); assert.equal(f.seen.length, 0);
});

test('LS19 route media returns bounded private binary data with no arbitrary path/executable selection', async t => {
  const f = lectureFixture(t), { view } = await f.accepted(); await f.service.prepareAudio(view.item.id, { ...exact(view), voice: 'Samantha', rate: 180, confirmed: true }, { authorize: f.authority }); await f.service.drain(); const common = { service: f.service, session: { nonce: 'synthetic-paired-browser' }, stillAuthorized: f.authority, privateBody: async () => ({}) };
  const audio = await handleLectureRoute({ ...common, route: `/lectures/${view.item.id}/chapters/p1/audio`, method: 'GET' }); assert.equal(audio.status, 200); assert.equal(audio.mime, 'audio/wav'); assert(Buffer.isBuffer(audio.bytes)); assert.deepEqual(audio.bytes, Buffer.from('SYNTHETIC_AUDIO_1'));
  let guarded = 0; const asset = await handleLectureRoute({ ...common, route: `/lectures/${view.item.id}/chapters/p2/asset`, method: 'GET', sourceOperation: async run => { guarded++; return run(new AbortController().signal); } }); assert.equal(guarded, 1); assert.equal(asset.data.asset.physical_page, 2); assert.equal(await handleLectureRoute({ ...common, route: `/lectures/${view.item.id}/chapters/../../etc/passwd/audio`, method: 'GET' }), null); await assert.rejects(handleLectureRoute({ ...common, route: `/lectures/${view.item.id}/chapters/p1/audio`, method: 'POST' }), { code: 'INVALID_INPUT' });
});

test('LS20 a model script must fit native spoken-text limits before it can be accepted, with no silent truncation', async t => {
  for (const size of ['single_chapter', 'aggregate']) {
    const pageTexts = size === 'aggregate' ? Array.from({ length: 7 }, (_, index) => `Synthetic concept ${index + 1}: every recursive call approaches a base case.`) : undefined;
    const f = lectureFixture(t, { ...(pageTexts ? { pageTexts } : {}), answer: payload => { for (const chapter of payload.chapters) { chapter.narration = 'N'.repeat(size === 'single_chapter' ? 1401 : 1400); chapter.example = 'E'.repeat(600); chapter.takeaway = 'T'.repeat(300); } return payload; } }), created = await f.create(), generated = await f.settle(await f.run(created, f.grant(created)));
    assert.equal(generated.chapters.length, 0); assert.equal(generated.generation.state, 'failed'); assert.throws(() => f.service.reviewPreview(generated.item.id), { code: size === 'aggregate' ? 'BUDGET_EXCEEDED' : 'INVALID_INPUT' }); assert.equal(f.mediaCalls.length, 0); const source = f.store.getSourceEntry(f.entry.id); assert.equal(source.pdf.pages.length, size === 'aggregate' ? 7 : 2);
  }
});

test('LS21 removing cached media preserves the exact reviewed transcript, student attempts and playback cursor', async t => {
  const f = lectureFixture(t), { view } = await f.accepted();
  await f.service.prepareAudio(view.item.id, { ...exact(view), voice: 'Samantha', rate: 180, confirmed: true }, { authorize: f.authority }); await f.service.drain();
  let current = await f.service.get(view.item.id); await f.service.exportVideo(current.item.id, { ...exact(current), confirmed: true }, { authorize: f.authority }); await f.service.drain(); current = await f.service.get(view.item.id);
  const attempted = await f.service.answer(current.item.id, { ...exact(current), quiz_id: 'q2', response: 'The zero case returns immediately.' }, { idempotencyKey: 'lecture-remove-answer-1' });
  current = await f.service.progress(current.item.id, { ...exact(attempted.item), chapter_index: 1, position_seconds: 1, state: 'paused', completed_chapter_ids: ['p1'] });
  const before = { chapters: current.chapters, progress: current.progress, context: current.context_document, hash: current.lecture_hash }, mediaId = current.audio.manifest.id;
  const removed = await f.service.removeMedia(current.item.id, { ...exact(current), confirmed: true }, { authorize: f.authority });
  assert.equal(removed.audio.state, 'none'); assert.equal(removed.export.state, 'none'); assert.equal(removed.audio.manifest, null); assert.equal(f.cache.has(mediaId), false);
  assert.deepEqual(removed.chapters, before.chapters); assert.deepEqual(removed.progress, before.progress); assert.deepEqual(removed.context_document, before.context); assert.equal(removed.lecture_hash, before.hash); assert.equal(removed.generation.state, 'accepted');
  assert.equal(removed.progress.attempts[0].data.exact_student_response, 'The zero case returns immediately.'); assert.equal(removed.mastery_claim, false); await assert.rejects(f.service.audio(current.item.id, 'p1', { authorize: f.authority })); await assert.rejects(f.service.video(current.item.id, { authorize: f.authority })); assert.equal(f.seen.length, 1);
});

test('LS22 cached-media removal requires exact review, explicit consent and current student authority before deleting bytes', async t => {
  const f = lectureFixture(t), { view } = await f.accepted(); await f.service.prepareAudio(view.item.id, { ...exact(view), voice: 'Samantha', rate: 180, confirmed: true }, { authorize: f.authority }); await f.service.drain(); const current = await f.service.get(view.item.id), mediaId = current.audio.manifest.id;
  for (const changed of [{ confirmed: false }, { expected_revision: 999 }, { lecture_hash: sha('stale') }, { shell: 'remove all media' }]) await assert.rejects(f.service.removeMedia(current.item.id, { ...exact(current), confirmed: true, ...changed }, { authorize: f.authority }));
  f.setAuthority(false); await assert.rejects(f.service.removeMedia(current.item.id, { ...exact(current), confirmed: true }, { authorize: f.authority }), { code: 'CONSENT_REQUIRED' }); f.setAuthority(true);
  assert.equal(f.cache.has(mediaId), true); assert.equal(f.mediaCalls.filter(call => call.operation === 'remove').length, 0); assert.equal((await f.service.get(current.item.id)).audio.state, 'ready');
  const remove = f.media.remove; f.media.remove = async () => { throw Object.assign(Error('cache busy'), { code: 'RATE_LIMITED' }); };
  await assert.rejects(f.service.removeMedia(current.item.id, { ...exact(current), confirmed: true }, { authorize: f.authority }), { code: 'RATE_LIMITED' }); const retry = await f.service.get(current.item.id); assert.equal(retry.audio.manifest.id, mediaId); assert.equal(retry.audio.state, 'ready'); assert.equal(f.cache.has(mediaId), true);
  f.media.remove = remove; await f.service.removeMedia(retry.item.id, { ...exact(retry), confirmed: true }, { authorize: f.authority }); assert.equal(f.cache.has(mediaId), false);
});

test('LS23 missing cached bytes can be forgotten safely without model or native regeneration', async t => {
  const f = lectureFixture(t), { view } = await f.accepted(); await f.service.prepareAudio(view.item.id, { ...exact(view), voice: 'Samantha', rate: 180, confirmed: true }, { authorize: f.authority }); await f.service.drain(); f.cache.clear();
  const current = await f.service.get(view.item.id); assert.equal(current.audio.state, 'unavailable'); const before = f.mediaCalls.filter(call => call.operation === 'audio').length;
  const removed = await f.service.removeMedia(current.item.id, { ...exact(current), confirmed: true }, { authorize: f.authority }); assert.equal(removed.audio.state, 'none'); assert.equal(removed.chapters.length, 2); assert.equal(f.mediaCalls.filter(call => call.operation === 'audio').length, before); assert.equal(f.seen.length, 1);
});

test('LS24 unchanged narration is reused; changed narrator settings replace and remove only the prior owned cache', async t => {
  const f = lectureFixture(t), { view } = await f.accepted(); await f.service.prepareAudio(view.item.id, { ...exact(view), voice: 'Samantha', rate: 180, confirmed: true }, { authorize: f.authority }); await f.service.drain(); let current = await f.service.get(view.item.id), oldId = current.audio.manifest.id;
  await f.service.prepareAudio(current.item.id, { ...exact(current), voice: 'Samantha', rate: 180, confirmed: true }, { authorize: f.authority }); await f.service.drain(); assert.equal(f.mediaCalls.filter(call => call.operation === 'audio').length, 1); assert.equal(f.cache.size, 1);
  f.media.capability = async () => ({ state: 'available', voices: [{ id: 'Samantha' }, { id: 'SyntheticSecondVoice' }], platform: 'synthetic_test_only' }); current = await f.service.get(view.item.id);
  await f.service.prepareAudio(current.item.id, { ...exact(current), voice: 'SyntheticSecondVoice', rate: 170, confirmed: true }, { authorize: f.authority }); await f.service.drain(); current = await f.service.get(view.item.id);
  assert.equal(current.audio.state, 'ready'); assert.equal(current.audio.voice, 'SyntheticSecondVoice'); assert.equal(current.audio.rate, 170); assert.notEqual(current.audio.manifest.id, oldId); assert.equal(f.cache.has(oldId), false); assert.equal(f.cache.size, 1); assert(f.mediaCalls.some(call => call.operation === 'remove' && call.id === oldId)); assert.equal(f.seen.length, 1); assert.equal(current.export.state, 'none');
});

test('LS25 interrupted startup generation becomes UNKNOWN_OUTCOME without replaying or manufacturing a proposal', async t => {
  const f = lectureFixture(t), created = await f.create(), row = f.store.getWorkspaceRecord(created.item.id);
  f.store.updateWorkspaceRecord(row.id, { expected_revision: row.revision, data: { ...row.data, generation: { state: 'starting' } } }); await f.reopen();
  const restored = await f.service.get(row.id); assert.equal(restored.generation.state, 'failed'); assert.equal(restored.generation.error_code, 'UNKNOWN_OUTCOME'); assert.equal(restored.chapters.length, 0); assert.equal(f.seen.length, 0); assert.equal(f.mediaCalls.length, 0); assert.equal(f.store.listAgentGrants().length, 0);
});

test('LS26 a terminal model error retains its actionable code and never yields reviewable or native output', async t => {
  const f = lectureFixture(t, { executor: async () => { throw Object.assign(Error('synthetic provider limit'), { code: 'RATE_LIMITED' }); } }), created = await f.create(), result = await f.settle(await f.run(created, f.grant(created)));
  assert.equal(result.generation.state, 'failed'); assert.equal(result.generation.error_code, 'RATE_LIMITED'); assert.equal(result.chapters.length, 0); assert.equal(f.mediaCalls.length, 0); assert.throws(() => f.service.reviewPreview(result.item.id)); await f.reopen(); const restored = await f.service.get(result.item.id); assert.equal(restored.generation.state, 'failed'); assert.equal(restored.generation.error_code, 'RATE_LIMITED'); assert.equal(f.seen.length, 1);
});

// context_delivery is trusted executor metadata, not an instruction or field
// the model may put in its lecture JSON or a browser caller may choose.
const runtimePrepared = (text, context, overrides = {}) => ({ state: 'completed', complete: true, text, output_sha256: sha(text), context_delivery: 'runtime_prepared',
  tool_receipts: [
    { tool: 'learnbridge_status', status: 'completed', failed: false, result_hash: sha('synthetic selected runtime status'), origin: 'runtime' },
    { tool: 'learnbridge_context', status: 'completed', failed: false, result_hash: sha(JSON.stringify(context)), origin: 'runtime' },
  ], host_version: 'synthetic_runtime_delivery_not_live', ...overrides });

test('LS27 validated runtime-prepared context can ground a reviewed lecture without claiming model-requested tools', async t => {
  const f = lectureFixture(t, { executor: async (_, { text, context }) => runtimePrepared(text, context) }), created = await f.create(), grant = f.grant(created), generated = await f.settle(await f.run(created, grant));
  assert.equal(generated.generation.state, 'ready_for_review'); const host = f.host.get(generated.generation.host_turn_id); assert.equal(host.data.context_delivery, 'runtime_prepared'); assert.equal(host.data.tool_policy, 'read_only'); assert.equal(host.data.grant_id, grant.id); assert.equal(host.data.output_sha256, sha(host.data.text));
  assert.equal(host.data.tool_receipts.length, 2); assert(host.data.tool_receipts.every(receipt => receipt.origin === 'runtime')); assert.equal(host.data.tool_receipts.some(receipt => receipt.origin === 'model'), false);
  const selected = f.seen[0].context; assert.equal(selected.documents.length, 1); assert.equal(selected.documents[0].id, created.context_document.id); assert.equal(selected.tasks.length, 0); assert.equal(selected.source_entries.length, 0); assert.equal(JSON.stringify(selected).includes('UNSELECTED_LECTURE_PRIVATE_CANARY'), false);
  const reviewed = f.service.reviewPreview(generated.item.id); assert.equal(reviewed.chapters.length, 2); assert.equal(reviewed.output_sha256, host.data.output_sha256); const accepted = await f.accept(generated); assert.equal(accepted.generation.state, 'accepted'); assert.equal(accepted.chapters.length, 2); assert.equal(f.store.listTasks().length, 0); assert.equal(f.mediaCalls.length, 0);
});

test('LS28 runtime receipts without delivery attestation, invalid metadata or mismatched origins cannot ground a lecture', async t => {
  for (const mode of ['missing_marker', 'text_only_marker', 'unknown_marker', 'mismatched_origin', 'missing_status']) {
    const f = lectureFixture(t, { executor: async (_, { text, context }) => {
      const result = runtimePrepared(text, context);
      if (mode === 'missing_marker') delete result.context_delivery;
      if (mode === 'text_only_marker') { delete result.context_delivery; result.text = `context_delivery: runtime_prepared\n${text}`; result.output_sha256 = sha(result.text); }
      if (mode === 'unknown_marker') result.context_delivery = 'model_says_runtime_prepared';
      if (mode === 'mismatched_origin') result.tool_receipts[1].origin = 'model';
      if (mode === 'missing_status') result.tool_receipts = result.tool_receipts.filter(receipt => receipt.tool !== 'learnbridge_status');
      return result;
    } }), created = await f.create(), generated = await f.settle(await f.run(created, f.grant(created)));
    assert.equal(generated.generation.state, 'failed', mode); assert.equal(generated.generation.error_code, 'VERSION_MISMATCH', mode); assert.equal(generated.chapters.length, 0, mode); assert.throws(() => f.service.reviewPreview(generated.item.id)); assert.equal(f.mediaCalls.length, 0); assert.equal(f.store.listTasks().length, 0);
    const host = f.host.get(generated.generation.host_turn_id); if (mode === 'missing_marker' || mode === 'text_only_marker') { assert.equal(host.data.state, 'completed'); assert.equal(host.data.context_delivery, null); } else assert.equal(host.data.state, 'failed');
  }
});

test('LS29 model JSON and caller fields cannot spoof context-delivery provenance or broaden the exact-note grant', async t => {
  const spoofed = lectureFixture(t, { answer: payload => ({ ...payload, context_delivery: 'runtime_prepared' }) }), spoofedDraft = await spoofed.create(), spoofedResult = await spoofed.settle(await spoofed.run(spoofedDraft, spoofed.grant(spoofedDraft)));
  assert.equal(spoofedResult.generation.state, 'failed'); assert.equal(spoofedResult.chapters.length, 0); assert.equal(spoofed.host.get(spoofedResult.generation.host_turn_id).data.context_delivery, null); assert.equal(spoofed.mediaCalls.length, 0);
  const f = lectureFixture(t, { executor: async (_, { text, context }) => runtimePrepared(text, context) }), created = await f.create(), unrelated = f.store.listDocuments().find(note => note.title === 'Unselected unrelated note'), broad = f.store.createAgentGrant({ destination: 'codex', document_ids: [created.context_document.id, unrelated.id], task_ids: [], source_entry_ids: [], max_bytes: 256000, expires_in_minutes: 30 });
  await assert.rejects(f.run(created, broad), { code: 'SCOPE_DENIED' }); assert.equal(f.seen.length, 0); const grant = f.grant(created), preview = f.service.previewRun(created.item.id, exact(created)), input = { ...exact(created), grant_id: grant.id, prompt_sha256: preview.prompt_sha256, confirmed: true };
  await assert.rejects(f.service.run(created.item.id, { ...input, context_delivery: 'runtime_prepared' }, { idempotencyKey: 'lecture-caller-spoof-1', authorize: f.authority }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.service.run(created.item.id, { ...input, prompt_sha256: sha('different reviewed prompt') }, { idempotencyKey: 'lecture-bad-runtime-prompt-1', authorize: f.authority }), { code: 'REVISION_CONFLICT' }); assert.equal(f.seen.length, 0); assert.equal(f.host.list().length, 0);
  const generated = await f.settle(await f.run(created, grant)), host = f.store.getWorkspaceRecord(generated.generation.host_turn_id); f.store.updateWorkspaceRecord(host.id, { expected_revision: host.revision, data: { ...host.data, prompt: 'FORGED_RUNTIME_PROMPT' } });
  assert.throws(() => f.service.reviewPreview(generated.item.id), { code: 'VERSION_MISMATCH' }); const current = await f.service.get(generated.item.id); assert.equal(current.generation.state, 'withheld'); assert.equal(current.chapters.length, 0); assert.equal(f.store.listTasks().length, 0); assert.equal(f.mediaCalls.length, 0);
});

test('LS30 lecture cancellation interrupts only its pending clarification and preserves completed/unrelated turns with exact revision checks', async t => {
  let release, aborted = false;
  const f = lectureFixture(t, { executor: async (input, { text, context }) => {
    if (input.prompt.includes('BEGIN_LEARNBRIDGE_LECTURE_V1')) return runtimePrepared(text, context);
    const response = runtimePrepared('Physical slide 2: the base case returns without another recursive call. What happens at zero?', context);
    if (!input.prompt.includes('Pending question: can you explain another recursive call?')) return response;
    return new Promise(resolve => { release = () => resolve(response); input.signal.addEventListener('abort', () => { aborted = true; resolve(response); }, { once: true }); });
  } }), { view, grant } = await f.accepted();
  const ask = async (current, question, key) => {
    const selection = { ...exact(current), chapter_id: 'p2', question }, preview = f.service.clarificationPreview(current.item.id, selection);
    return f.service.clarify(current.item.id, { ...selection, grant_id: grant.id, prompt_sha256: preview.prompt_sha256, confirmed: true }, { idempotencyKey: key, authorize: f.authority });
  };
  await ask(view, 'Previously completed question: why does the base case return?', 'lecture-completed-before-cancel-1');
  let current;
  for (let n = 0; n < 40; n++) { current = await f.service.get(view.item.id); if (current.clarifications[0]?.state === 'completed') break; await delay(2); }
  assert.equal(current.clarifications[0].state, 'completed');
  const generationBefore = f.store.getWorkspaceRecord(current.generation.host_turn_id), completedBefore = f.store.getWorkspaceRecord(current.clarifications[0].host_turn_id);
  // The runtime permits one executing host turn. This separately seeded queued
  // record proves the ownership filter without inventing a second live executor.
  const unrelated = f.store.createWorkspaceRecord({ kind: 'artifact', title: 'Unrelated queued host fixture', data: { ...completedBefore.data, state: 'queued', text: '', tool_receipts: [], idempotency_key: 'unrelated-clarification-cancel-control' } });
  f.store.createWorkspaceRecord({ kind: 'artifact', title: 'Unrelated lecture clarification fixture', data: { format: 'learnbridge_lecture_clarification.v1', lecture_id: randomUUID(), chapter_id: 'p2', question: 'An unrelated lecture question', grant_id: grant.id, prompt: unrelated.data.prompt, host_turn_id: unrelated.id } });
  await ask(current, 'Pending question: can you explain another recursive call?', 'lecture-pending-cancel-1');
  for (let n = 0; !release && n < 40; n++) await delay(2); assert(release);
  current = await f.service.get(view.item.id); const pending = current.clarifications.find(item => item.question.startsWith('Pending question')), pendingBefore = f.host.get(pending.host_turn_id); assert.equal(pendingBefore.data.state, 'running');
  const cancelled = [], cancel = f.host.cancel;
  f.host.cancel = (id, options) => { cancelled.push({ id, ...options }); return cancel(id, options); };
  await assert.rejects(f.service.cancel(current.item.id, { ...exact(current), expected_revision: current.item.revision - 1, confirmed: true }), { code: 'REVISION_CONFLICT' });
  await assert.rejects(f.service.cancel(current.item.id, { ...exact(current), confirmed: false }), { code: 'CONSENT_REQUIRED' }); assert.equal(aborted, false); assert.equal(cancelled.length, 0);
  const stopped = await f.service.cancel(current.item.id, { ...exact(current), confirmed: true });
  assert.deepEqual(cancelled, [{ id: pendingBefore.id, expected_revision: pendingBefore.revision }]); assert.equal(aborted, true); assert.equal(stopped.item.revision, current.item.revision); assert.equal(stopped.generation.state, 'accepted');
  const interrupted = f.host.get(pendingBefore.id); assert.equal(interrupted.data.state, 'interrupted'); assert.equal(interrupted.data.error_code, 'CANCELLED'); assert(interrupted.revision > pendingBefore.revision); assert.equal(interrupted.data.text, '');
  assert.throws(() => cancel(pendingBefore.id, { expected_revision: pendingBefore.revision }), { code: 'REVISION_CONFLICT' });
  release(); await delay(2); const after = await f.service.get(current.item.id); assert.equal(after.clarifications.find(item => item.id === pending.id).state, 'interrupted'); assert.equal(after.clarifications.find(item => item.id === pending.id).text, '');
  assert.deepEqual(f.store.getWorkspaceRecord(generationBefore.id), generationBefore); assert.deepEqual(f.store.getWorkspaceRecord(completedBefore.id), completedBefore); assert.deepEqual(f.store.getWorkspaceRecord(unrelated.id), unrelated); assert.equal(after.clarifications.find(item => item.host_turn_id === completedBefore.id).state, 'completed'); assert.equal(after.chapters.length, 2);
  await f.service.cancel(after.item.id, { ...exact(after), confirmed: true }); assert.equal(cancelled.length, 1); assert.equal(f.host.get(pendingBefore.id).revision, interrupted.revision); assert.equal(f.mediaCalls.length, 0); assert.equal(f.store.listTasks().length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createLecturePlaybackController, mountLecturePlayerUI } from '../apps/local/public/lecture-player.js';
import { createLectureFixtureTransport, makeLectureFixture, lectureFixtureHash } from './fixtures/lecture-ui-fixture.mjs';

class AudioFixture {
  constructor() { this.listeners = new Map(); this.src = ''; this.duration = 18.75; this.currentTime = 0; this.readyState = 1; this.paused = true; this.playbackRate = 1; this.plays = 0; this.failPlay = false; }
  addEventListener(name, callback) { this.listeners.set(name, [...this.listeners.get(name) || [], callback]); }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  pause() { this.paused = true; }
  load() {}
  async play() { if (this.failPlay) throw new Error('Browser needs a user gesture'); this.plays++; this.paused = false; }
  async fire(name) { for (const callback of this.listeners.get(name) || []) await callback(); }
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const chapters = [{ id: 'first', physical_page: 1, title: 'One', narration: 'Actual narration one.' }, { id: 'second', physical_page: 2, title: 'Two', narration: 'Actual narration two.', quiz: { id: 'quiz-2', question: 'Explain the idea.' } }, { id: 'third', physical_page: 3, title: 'Three', narration: 'Actual narration three.' }];
function harness(options = {}) {
  const audio = new AudioFixture(), shown = [], acquired = [], saves = [], quizzes = [], states = [], releases = [];
  const controller = createLecturePlaybackController({ audio, showChapter: async chapter => { shown.push(chapter.physical_page); return options.show?.(chapter); }, acquire: async chapter => { acquired.push(chapter.id); return options.acquire ? options.acquire(chapter) : { url: `blob:${chapter.id}` }; }, onProgress: async value => { saves.push(structuredClone(value)); await options.save?.(value); }, onQuiz: chapter => quizzes.push(chapter.quiz.id), onState: value => states.push(value), release: url => releases.push(url) });
  return { controller, audio, shown, acquired, saves, quizzes, states, releases };
}
test('LPLAYER01: only actual media ended advances physical slide, not metadata or time estimates', async () => {
  const h = harness(); await h.controller.open(chapters); assert.deepEqual(h.shown, [1]); assert.equal(h.controller.snapshot().state, 'paused'); await h.controller.play(); h.audio.currentTime = 18.74; await h.audio.fire('timeupdate'); assert.deepEqual(h.shown, [1]); await h.audio.fire('loadedmetadata'); assert.deepEqual(h.shown, [1]); await h.audio.fire('ended'); assert.deepEqual(h.shown, [1, 2]); assert.equal(h.controller.snapshot().state, 'playing'); assert.equal(h.audio.src, 'blob:second'); assert.deepEqual(h.saves[0].completed_chapter_ids, ['first']); assert.deepEqual(h.releases, ['blob:first']);
});
test('LPLAYER02: midpoint quiz stops autoplay and blocks forward skipping until explicit saved answer', async () => {
  const h = harness(); await h.controller.open(chapters); await h.controller.play(); await h.audio.fire('ended'); await h.audio.fire('ended'); assert.equal(h.controller.snapshot().state, 'awaiting_quiz'); assert.deepEqual(h.shown, [1, 2]); assert.deepEqual(h.quizzes, ['quiz-2']); assert.equal(h.audio.paused, true); assert.equal(await h.controller.play(), false); assert.equal(await h.controller.continue(), false); assert.equal(await h.controller.chapter(2), false); assert.equal(h.controller.snapshot().chapter_index, 1); assert.equal(await h.controller.answer('wrong-quiz'), false); assert.equal(await h.controller.answer('quiz-2'), true); assert.equal(h.controller.snapshot().state, 'paused'); assert.deepEqual(h.shown, [1, 2]); await h.controller.continue(); assert.deepEqual(h.shown, [1, 2, 3]); assert.equal(h.controller.snapshot().state, 'playing');
});
test('LPLAYER03: clarification interruption retains exact position and ignores old ended', async () => {
  const h = harness(); await h.controller.open(chapters); await h.controller.play(); h.audio.currentTime = 7.2; h.controller.interrupt(); assert.equal(h.audio.paused, true); assert.equal(h.controller.snapshot().position_seconds, 7.2); await h.audio.fire('ended'); assert.deepEqual(h.shown, [1]); assert.equal(h.controller.snapshot().state, 'paused'); await h.controller.play(); assert.equal(h.controller.snapshot().position_seconds, 7.2);
});
test('LPLAYER04: restart restores actual offset but does not autoplay', async () => {
  const h = harness(); await h.controller.open(chapters, { chapter_index: 1, position_seconds: 8.1, completed_chapter_ids: ['first'], answered_quiz_ids: [] }); assert.deepEqual(h.shown, [2]); assert.equal(h.audio.currentTime, 8.1); assert.equal(h.audio.plays, 0); assert.equal(h.controller.snapshot().state, 'paused'); await h.controller.pause(); assert.equal(h.saves.at(-1).position_seconds, 8.1);
});
test('LPLAYER05: reopening unanswered midpoint presents quiz without loading narration', async () => {
  const h = harness(); await h.controller.open(chapters, { chapter_index: 1, position_seconds: 18.75, state: 'awaiting_quiz', completed_chapter_ids: ['first', 'second'] }); assert.deepEqual(h.shown, [2]); assert.deepEqual(h.acquired, []); assert.deepEqual(h.quizzes, ['quiz-2']); assert.equal(h.controller.snapshot().state, 'awaiting_quiz'); assert.equal(h.audio.plays, 0);
});
test('LPLAYER06: reset during pending narration revokes late audio and cannot revive selected source', async () => {
  const gate = deferred(), h = harness({ acquire: () => gate.promise }); const opening = h.controller.open(chapters); await Promise.resolve(); await Promise.resolve(); h.controller.reset(); gate.resolve({ url: 'blob:late-private-audio' }); await opening; assert.equal(h.audio.src, ''); assert.equal(h.controller.snapshot().state, 'empty'); assert.deepEqual(h.releases, ['blob:late-private-audio']); assert.equal(h.audio.plays, 0);
});
test('LPLAYER07: switching source during pending image cannot acquire the prior narration', async () => {
  const gate = deferred(), h = harness({ show: chapter => chapter.id === 'first' ? gate.promise : undefined }); const opening = h.controller.open(chapters); const newer = [{ id: 'different', physical_page: 9, narration: 'Different source.' }]; await h.controller.open(newer); gate.resolve(); await opening; assert.deepEqual(h.acquired, ['different']); assert.equal(h.audio.src, 'blob:different'); assert.equal(h.controller.snapshot().chapter.physical_page, 9);
});
test('LPLAYER08: failed progress save pauses at completed chapter rather than advancing', async () => {
  const h = harness({ save: () => { throw new Error('Revision changed'); } }); await h.controller.open(chapters); await h.controller.play(); await h.audio.fire('ended'); assert.deepEqual(h.shown, [1]); assert.equal(h.controller.snapshot().state, 'paused'); assert.match(h.states.at(-1).error, /Revision changed/); assert.equal(h.audio.paused, true);
});
test('LPLAYER09: browser autoplay rejection stays paused with transcript chapter intact', async () => {
  const h = harness(); await h.controller.open(chapters); h.audio.failPlay = true; assert.equal(await h.controller.play(), false); assert.equal(h.controller.snapshot().state, 'paused'); assert.deepEqual(h.shown, [1]); assert.match(h.states.at(-1).error, /user gesture/);
});
test('LPLAYER10: speed is explicit, seek bounded by actual metadata and unavailable duration cannot seek', async () => {
  const h = harness(); await h.controller.open(chapters); h.controller.speed(1.5); assert.equal(h.audio.playbackRate, 1.5); assert.throws(() => h.controller.speed(4), /available/); assert.equal(await h.controller.seek(500), true); assert.equal(h.audio.currentTime, 18.75); assert.equal(await h.controller.seek(-10), true); assert.equal(h.audio.currentTime, 0); h.audio.duration = Number.NaN; assert.equal(await h.controller.seek(3), false); assert.equal(h.controller.snapshot().duration_seconds, null);
});
test('LPLAYER11: terminal completion is viewing evidence only and never adds quiz score or mastery', async () => {
  const h = harness(); await h.controller.open([chapters[0]]); await h.controller.play(); await h.audio.fire('ended'); assert.equal(h.controller.snapshot().state, 'finished'); assert.deepEqual(h.saves.at(-1).completed_chapter_ids, ['first']); assert.equal(Object.hasOwn(h.saves.at(-1), 'mastery'), false); assert.equal(Object.hasOwn(h.saves.at(-1), 'score'), false);
});
test('LPLAYER12: native decode failure pauses and retains transcript and completed history', async () => {
  const h = harness(); await h.controller.open(chapters); await h.controller.play(); await h.audio.fire('error'); assert.equal(h.controller.snapshot().state, 'error'); assert.equal(h.audio.paused, true); assert.match(h.states.at(-1).error, /transcript and saved answers/);
});

class DOMNode extends AudioFixture {
  constructor(tag, className = '', text = '') { super(); this.tagName = tag; this.className = className; this.text = text; this.children = []; this.hidden = false; this.disabled = false; this._value = ''; this.dataset = {}; this.attributes = new Map(); this.classList = { toggle: (name, force) => { const set = new Set(this.className.split(' ').filter(Boolean)); const chosen = force ?? !set.has(name); if (chosen) set.add(name); else set.delete(name); this.className = [...set].join(' '); } }; }
  append(...rows) { this.children.push(...rows); }
  replaceChildren(...rows) { this.children = rows; this.text = ''; this._value = ''; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'src') this.src = ''; }
  get value() { return this._value || (this.tagName === 'select' ? this.children[0]?.value || '' : ''); }
  set value(value) { this._value = String(value); }
  get options() { return this.children; }
  get textContent() { return this.text + this.children.map(row => row.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.children = []; }
  focus() { this.focused = true; }
  reset() { for (const row of walk(this)) if (['input', 'select', 'textarea'].includes(row.tagName)) row.value = ''; }
  click() { this.clicked = true; }
  remove() { this.removed = true; }
}
const walk = root => [root, ...root.children.flatMap(walk)];
const trigger = (node, type = 'click') => { for (const handler of node.listeners.get(type) || []) handler({ preventDefault() {} }); };
const studio = { item: { id: 'studio-1', revision: 3, data: { source_title: 'Recursion', studio_hash: lectureFixtureHash } }, page: { physical_page: 1, page_count: 12 } };
function uiHarness(t, options = {}) {
  const root = new DOMNode('main'), jobs = [], confirmations = [], transport = createLectureFixtureTransport(options), previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document'), urlCreate = URL.createObjectURL, urlRevoke = URL.revokeObjectURL, released = [], urls = [];
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { head: new DOMNode('head'), querySelector: () => null } });
  URL.createObjectURL = blob => { assert(blob instanceof Blob); const url = `blob:synthetic-${urls.length + 1}`; urls.push(url); return url; }; URL.revokeObjectURL = url => released.push(url);
  const ui = mountLecturePlayerUI({ root, request: transport.request, element: (tag, cls, text) => new DOMNode(tag, cls, text), busy(control, task) { control.disabled = true; const job = Promise.resolve().then(task).finally(() => { control.disabled = false; }); jobs.push(job); return job; }, confirmAction: async (...args) => { confirmations.push(args); return options.confirm ? await options.confirm(...args) : true; } });
  t.after(() => { ui.reset(); if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else delete globalThis.document; URL.createObjectURL = urlCreate; URL.revokeObjectURL = urlRevoke; });
  const find = predicate => { const node = walk(root).find(predicate); assert(node, 'Expected shipped lecture UI node'); return node; };
  return { ui, root, ...transport, jobs, confirmations, released, urls, find, get audio() { return find(row => row.tagName === 'audio'); }, button: label => find(row => row.tagName === 'button' && row.textContent === label), field: label => { const caption = find(row => row.tagName === 'label' && row.textContent === label); return find(row => row.id === caption.htmlFor); }, async settled() { await jobs.at(-1)?.catch(() => {}); await Promise.resolve(); await Promise.resolve(); }, async click(label) { const node = this.button(label); assert.equal(node.disabled, false, `${label} enabled`); trigger(node); await this.settled(); }, async submit(label) { const control = this.button(label), form = find(row => row.tagName === 'form' && walk(row).includes(control)); assert.equal(control.disabled, false); trigger(form, 'submit'); await this.settled(); }, startSubmit(label) { const control = this.button(label), form = find(row => row.tagName === 'form' && walk(row).includes(control)); trigger(form, 'submit'); return jobs.at(-1); }, async open() { await ui.open(studio); await this.click('Open saved lecture'); } };
}
function exactGrant(id = 'exact') { return { id, destination: 'codex', state: 'active', expires_at: new Date(Date.now() + 600000).toISOString(), pins: { tasks: [], source_entries: [], documents: [{ id: 'lecture-note', revision: 1 }] } }; }
test('LUI01: opening saved lecture reads exact assets and real audio without AI request, sharing or autoplay', async t => {
  const h = uiHarness(t); await h.open(); assert.match(h.root.textContent, /Why recursion works/); assert.equal(h.audio.src, 'blob:synthetic-1'); assert.equal(h.audio.plays, 0); assert.equal(h.calls.some(row => row.method === 'POST'), false); const audioRequest = h.calls.find(row => row.path.endsWith('/audio')); assert.equal(audioRequest.responseType, 'blob'); assert.equal(h.field('Narration position').max, '18.75');
});
test('LUI02: selected slide range is bounded and exact source revision recorded without model call', async t => {
  const h = uiHarness(t); await h.ui.open(studio); h.field('Slides to explain').value = '1-3'; h.field('Lecture title').value = 'Small recursion lecture'; await h.submit('Save my lecture selection'); const write = h.calls.find(row => row.method === 'POST'); assert.deepEqual(write.body.pages, [1, 2, 3]); assert.equal(write.body.expected_revision, 3); assert.equal(write.body.studio_hash, lectureFixtureHash); assert.equal(h.calls.some(row => row.path.endsWith('/run') || row.path === '/agent-grants' && row.method === 'POST'), false);
});
test('LUI03: invalid range or cancelled selection has no write', async t => {
  const h = uiHarness(t, { confirm: () => false }); await h.ui.open(studio); h.field('Slides to explain').value = '1-9'; await h.submit('Save my lecture selection'); assert.match(h.root.textContent, /at most 8 slides/); h.field('Slides to explain').value = '1, 1'; await h.submit('Save my lecture selection'); assert.match(h.root.textContent, /different slides/); h.field('Slides to explain').value = '1-2'; await h.submit('Save my lecture selection'); assert.equal(h.calls.some(row => row.method === 'POST'), false);
});
test('LUI04: editing selection while review is open invalidates its consent', async t => {
  const entered = deferred(), release = deferred(), h = uiHarness(t, { confirm: () => { entered.resolve(); return release.promise; } }); await h.ui.open(studio); h.field('Slides to explain').value = '1-2'; const working = h.startSubmit('Save my lecture selection'); await entered.promise; h.field('Slides to explain').value = '8'; release.resolve(true); await working; assert.equal(h.calls.some(row => row.method === 'POST'), false);
});
test('LUI05: only exact single-note grant is usable and explicit sharing selects its returned grant', async t => {
  const wider = exactGrant('wider'); wider.pins.documents.push({ id: 'other-note', revision: 1 }); const h = uiHarness(t, { grants: [exactGrant(), wider] }); await h.open(); assert.deepEqual(h.field('Approved lecture context').options.map(row => row.value), ['', 'exact']); assert.equal(h.field('Approved lecture context').value, ''); await h.click('Enable AI for these lecture slides'); assert.equal(h.field('Approved lecture context').value, 'grant-3'); const shared = h.calls.find(row => row.path === '/agent-grants' && row.method === 'POST'); assert.deepEqual(shared.body.document_ids, ['lecture-note']); assert.deepEqual(shared.body.task_ids, []); assert.deepEqual(shared.body.source_entry_ids, []);
});
test('LUI06: explanation generation requires exact prompt preview and a separate start', async t => {
  const view = makeLectureFixture({ generation: 'draft', audio: 'none' }), h = uiHarness(t, { view }); await h.open(); await h.click('Enable AI for these lecture slides'); await h.click('Review lecture request'); assert.match(h.root.textContent, /EXACT SYNTHETIC LECTURE PROMPT/); assert.equal(h.calls.some(row => row.path.endsWith('/run')), false); await h.click('Start this lecture explanation'); const sent = h.calls.find(row => row.path.endsWith('/run')); assert.equal(sent.body.prompt_sha256, lectureFixtureHash); assert.equal(sent.body.grant_id, 'grant-1'); assert.equal(sent.body.confirmed, true); assert.equal(h.fixture.generation.state, 'running');
});
test('LUI07: accepted script stays text-usable without native audio and chapter reads make no audio request', async t => {
  const h = uiHarness(t, { view: makeLectureFixture({ audio: 'unavailable' }) }); await h.open(); assert.match(h.root.textContent, /A recursive function solves/); assert.equal(h.button('Play lecture').disabled, true); await h.click('Next chapter →'); assert.match(h.find(row => row.className === 'lecture-transcript').textContent, /base case tells/); assert.equal(h.calls.some(row => row.path.endsWith('/audio')), false); assert.equal(h.audio.plays, 0);
});
test('LUI08: actual ended automatically changes slide and saves listened progress without scoring', async t => {
  const h = uiHarness(t); await h.open(); await h.click('Play lecture'); h.audio.currentTime = 18.75; await h.audio.fire('ended'); assert.match(h.find(row => row.className === 'lecture-transcript').textContent, /base case tells/); const progress = h.calls.filter(row => row.path.endsWith('/progress') && row.method === 'POST'); assert.equal(progress.length, 1); assert.deepEqual(progress[0].body.completed_chapter_ids, ['p1']); assert.equal(Object.hasOwn(progress[0].body, 'mastery'), false); assert.equal(h.audio.plays, 2);
});
test('LUI09: midpoint practice pauses playback and reveals reference only after literal answer is saved', async t => {
  const h = uiHarness(t); await h.open(); await h.click('Play lecture'); await h.audio.fire('ended'); await h.audio.fire('ended'); const box = h.find(row => row.className === 'lecture-quiz'); assert.equal(box.hidden, false); assert.equal(h.audio.paused, true); assert.equal(h.button('Next chapter →').disabled, true); assert.equal(h.root.textContent.includes('Each call must approach the base case.'), false); const answer = h.field('Your explanation in your own words'); answer.value = 'The argument must actually become smaller.'; trigger(answer, 'input'); await h.submit('Save answer and compare'); const saved = h.calls.find(row => row.path.endsWith('/answer')); assert.equal(saved.body.quiz_id, 'q2'); assert.equal(saved.body.response, 'The argument must actually become smaller.'); assert.match(h.root.textContent, /Each call must approach the base case/); assert.equal(h.audio.plays, 2); await h.click('Continue the lecture'); assert.equal(box.hidden, true); assert.match(h.find(row => row.className === 'lecture-transcript').textContent, /Trace one small input/); assert.equal(h.audio.plays, 3);
});
test('LUI10: unsaved midpoint answer survives refresh and never becomes an attempt automatically', async t => {
  const h = uiHarness(t); await h.open(); await h.click('Play lecture'); await h.audio.fire('ended'); await h.audio.fire('ended'); const answer = h.field('Your explanation in your own words'); answer.value = 'MY UNFINISHED ANSWER'; trigger(answer, 'input'); await h.ui.refresh(); assert.equal(answer.value, 'MY UNFINISHED ANSWER'); assert.equal(h.calls.some(row => row.path.endsWith('/answer')), false);
});
test('LUI11: clarification pauses actual narration and sends the exact active chapter after preview', async t => {
  const h = uiHarness(t); await h.open(); await h.click('Enable AI for these lecture slides'); await h.click('Play lecture'); await h.audio.fire('ended'); h.audio.currentTime = 4.2; const question = h.field('What should the tutor clarify?'); question.value = 'Give a simpler base-case example.'; trigger(question, 'input'); await h.submit('Pause and review my question'); assert.equal(h.audio.paused, true); assert.equal(h.audio.currentTime, 4.2); assert.match(h.root.textContent, /EXACT QUESTION ON p2/); assert.equal(h.calls.some(row => row.path.endsWith('/clarifications')), false); await h.click('Ask about this exact chapter'); const sent = h.calls.find(row => row.path.endsWith('/clarifications')); assert.equal(sent.body.chapter_id, 'p2'); assert.equal(sent.body.question, 'Give a simpler base-case example.'); assert.equal(sent.body.prompt_sha256, lectureFixtureHash); assert.equal(h.audio.paused, true); assert.equal(h.audio.currentTime, 4.2);
});
test('LUI12: edited clarification invalidates reviewed request and keeps the question draft', async t => {
  const h = uiHarness(t); await h.open(); await h.click('Enable AI for these lecture slides'); const question = h.field('What should the tutor clarify?'); question.value = 'Question one'; trigger(question, 'input'); await h.submit('Pause and review my question'); question.value = 'A different question'; trigger(question, 'input'); assert.equal(walk(h.root).some(row => row.tagName === 'button' && row.textContent === 'Ask about this exact chapter'), false); await h.ui.refresh(); assert.equal(question.value, 'A different question'); assert.equal(h.calls.some(row => row.path.endsWith('/clarifications')), false);
});
test('LUI13: changing/locking during delayed binary load clears media and cannot restart narration', async t => {
  const entered = deferred(), release = deferred(), h = uiHarness(t, { handle: path => path.endsWith('/audio') ? (entered.resolve(), release.promise) : undefined }); await h.ui.open(studio); const opening = h.click('Open saved lecture'); await entered.promise; h.ui.reset(); release.resolve(new Blob(['late media'], { type: 'audio/wav' })); await opening; assert.equal(h.audio.src, ''); assert.equal(h.audio.plays, 0); assert.equal(h.released.length, 1); assert.equal(h.find(row => row.className === 'lecture-transcript').textContent.includes('private'), false);
});
test('LUI14: mismatched PDF asset cannot play audio or display a previous page', async t => {
  const h = uiHarness(t, { handle: path => path.endsWith('/asset') ? { asset: { physical_page: 8, png_base64: 'WRONG PAGE' } } : undefined }); await h.open(); assert.equal(h.calls.some(row => row.path.endsWith('/audio')), false); assert.equal(h.find(row => row.tagName === 'img').src, ''); assert.match(h.root.textContent, /does not match/); assert.equal(h.audio.plays, 0);
});
test('LUI15: video download requests paired binary MP4 rather than creating a fake success', async t => {
  const view = makeLectureFixture(); view.export = { state: 'ready' }; const h = uiHarness(t, { view }); await h.open(); await h.click('Download lecture video'); const request = h.calls.find(row => row.path.endsWith('/video')); assert.equal(request.responseType, 'blob'); const anchor = h.find(row => row.tagName === 'a'); assert.equal(anchor.clicked, true); assert.match(anchor.download, /\.mp4$/); assert.match(h.root.textContent, /actual rendered lecture video/);
});
test('LUI16: read-only generation draft is reviewed completely before accepting exact output hash', async t => {
  const h = uiHarness(t, { view: makeLectureFixture({ generation: 'ready_for_review', audio: 'none' }) }); await h.open(); await h.click('Review the generated explanation'); assert.match(h.root.textContent, /The input must reach the base case/); assert.equal(h.calls.some(row => row.path.endsWith('/accept')), false); await h.click('Use this reviewed lecture'); const accepted = h.calls.find(row => row.path.endsWith('/accept')); assert.equal(accepted.body.output_sha256, 'c'.repeat(64)); assert.equal(accepted.body.pack_hash, 'b'.repeat(64)); assert.equal(h.fixture.generation.state, 'accepted');
});
test('LUI17: voiceover job records explicit installed voice/rate and does not pretend audio is immediately ready', async t => {
  const h = uiHarness(t, { view: makeLectureFixture({ audio: 'none' }) }); await h.open(); h.field('Narration pace').value = '130'; await h.click('Create voiceover'); const generated = h.calls.find(row => row.path.endsWith('/audio') && row.method === 'POST'); assert.equal(generated.body.voice, 'Samantha'); assert.equal(generated.body.rate, 130); assert.equal(generated.body.confirmed, true); assert.equal(h.fixture.audio.state, 'running'); assert.equal(h.button('Play lecture').disabled, true);
});
test('LUI18: quiz UTF-8 boundary rejection preserves student draft and performs no write', async t => {
  const h = uiHarness(t); await h.open(); await h.click('Play lecture'); await h.audio.fire('ended'); await h.audio.fire('ended'); const answer = h.field('Your explanation in your own words'); answer.value = '🙂'.repeat(2000); trigger(answer, 'input'); await h.submit('Save answer and compare'); assert.equal(answer.value, '🙂'.repeat(2000)); assert.equal(h.calls.some(row => row.path.endsWith('/answer')), false); assert.match(h.root.textContent, /6,000 UTF-8 bytes/);
});
test('LUI19: save progress and answer serialize exact optimistic revisions', async t => {
  const h = uiHarness(t); await h.open(); await h.click('Play lecture'); await h.audio.fire('ended'); await h.audio.fire('ended'); const answer = h.field('Your explanation in your own words'); answer.value = 'Reach the stopping input.'; trigger(answer, 'input'); await h.submit('Save answer and compare'); const writes = h.calls.filter(row => row.method === 'POST' && row.path.startsWith('/lectures/')); assert.deepEqual(writes.map(row => row.body.expected_revision), [1, 2, 3]);
});
test('LUI20: leaving pauses and revokes only on reset; re-entering resumes paused, without changing question draft', async t => {
  const h = uiHarness(t); await h.open(); const question = h.field('What should the tutor clarify?'); question.value = 'Explain this later.'; trigger(question, 'input'); await h.click('Play lecture'); h.ui.pause(); assert.equal(h.audio.paused, true); await h.ui.open(studio); assert.equal(question.value, 'Explain this later.'); assert.equal(h.audio.paused, true); h.ui.reset(); assert.equal(h.audio.src, ''); assert.equal(h.released.length, h.urls.length);
});
test('LUI21: fresh source revocation hides prior image/transcript and revokes narration while preserving unsent drafts', async t => {
  let revoked = false; const h = uiHarness(t, { handle: path => revoked && path === '/lectures/lecture-1' ? Promise.reject(Object.assign(new Error('Selected PDF version changed'), { code: 'VERSION_MISMATCH' })) : undefined }); await h.open(); await h.click('Play lecture'); const question = h.field('What should the tutor clarify?'); question.value = 'Keep my unsent question.'; trigger(question, 'input'); revoked = true; await assert.rejects(h.ui.refresh(), /version changed/); assert.equal(h.audio.paused, true); assert.equal(h.audio.src, ''); assert.equal(h.find(row => row.tagName === 'img').src, ''); assert.equal(h.find(row => row.className === 'lecture-transcript').textContent, ''); assert.equal(question.value, 'Keep my unsent question.'); assert.equal(h.released.length, 1);
});
test('LPLAYER13: forward manual jump stops at earlier unattempted quiz even before listening', async () => {
  const h = harness(); await h.controller.open(chapters); assert.equal(await h.controller.chapter(2), false); assert.deepEqual(h.shown, [1, 2]); assert.equal(h.controller.snapshot().state, 'awaiting_quiz'); assert.deepEqual(h.quizzes, ['quiz-2']); assert.equal(h.audio.plays, 0);
});
test('LUI22: explicit cached-media removal revokes playback but preserves transcript, saved attempts and downloaded copies', async t => {
  const view = makeLectureFixture(); view.progress.attempts.push({ id: 'prior-attempt', quiz_id: 'q2', response: 'A prior answer' }); view.progress.answered_quiz_ids.push('q2'); const h = uiHarness(t, { view }); await h.open(); await h.click('Play lecture'); await h.click('Remove downloaded media'); const write = h.calls.find(row => row.path.endsWith('/remove-media')); assert.equal(write.body.confirmed, true); assert.equal(write.body.lecture_hash, lectureFixtureHash); assert.equal(h.audio.paused, true); assert.equal(h.audio.src, ''); assert.equal(h.released.length, 1); assert.match(h.find(row => row.className === 'lecture-transcript').textContent, /A recursive function solves/); assert.equal(h.fixture.progress.attempts.length, 1); assert.match(h.confirmations.at(-1)[0], /copies already downloaded.*remain/);
});
test('LUI23: cancelled cached-media removal keeps real playback and makes no removal request', async t => {
  const h = uiHarness(t, { confirm: () => false }); await h.open(); await h.click('Play lecture'); await h.click('Remove downloaded media'); assert.equal(h.calls.some(row => row.path.endsWith('/remove-media')), false); assert.equal(h.audio.paused, false); assert.equal(h.audio.src, 'blob:synthetic-1');
});
test('LUI24: answer edited while save is pending retains its newer unsent draft', async t => {
  const entered = deferred(), release = deferred(), h = uiHarness(t, { handle: path => path.endsWith('/answer') ? (entered.resolve(), release.promise) : undefined }); await h.open(); await h.click('Play lecture'); await h.audio.fire('ended'); await h.audio.fire('ended'); const answer = h.field('Your explanation in your own words'); answer.value = 'Reviewed earlier answer'; trigger(answer, 'input'); const saving = h.startSubmit('Save answer and compare'); await entered.promise; answer.value = 'New text typed while saving'; trigger(answer, 'input'); release.resolve({ item: structuredClone(h.fixture), attempt: { id: 'attempt-fixture' }, reference_answer: 'The input must move toward stopping.', explanation: 'Small steps.' }); await saving; await h.settled(); assert.equal(answer.value, 'New text typed while saving'); assert.match(h.root.textContent, /newer text remains an unsaved draft/); assert.equal(h.calls.find(row => row.path.endsWith('/answer')).body.response, 'Reviewed earlier answer');
});
test('LUI25: Play/Pause labels reflect stable native playback rather than showing Resume while playing', async t => {
  const h = uiHarness(t); await h.open(); assert.equal(h.button('Play lecture').disabled, false); await h.click('Play lecture'); assert.equal(h.audio.paused, false); assert.equal(h.button('Playing lecture').disabled, true); assert.equal(h.button('Pause').disabled, false); h.audio.currentTime = 6; await h.audio.fire('timeupdate'); assert.equal(h.button('Playing lecture').disabled, true); await h.click('Pause'); assert.equal(h.audio.paused, true); assert.equal(h.button('Resume lecture').disabled, false); assert.equal(h.button('Pause').disabled, true);
});
test('LPLAYER14: replay after real ended completion rewinds chapter instead of finishing immediately again', async () => {
  const h = harness(); await h.controller.open([chapters[0]]); await h.controller.play(); h.audio.currentTime = h.audio.duration; await h.audio.fire('ended'); assert.equal(h.controller.snapshot().state, 'finished'); assert.equal(h.audio.currentTime, 18.75); await h.controller.play(); assert.equal(h.audio.currentTime, 0); assert.equal(h.controller.snapshot().state, 'playing'); assert.equal(h.audio.plays, 2);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mountCourseStudioUI } from '../apps/local/public/course-studio.js';

// Runs the shipped interaction handlers. This proves navigation/consent/draft
// behavior; browser layout and physical microphone quality need separate checks.
class Node {
  constructor(tag, cls = '', text = '') { this.tagName = tag; this.className = cls; this.text = text; this.children = []; this.listeners = new Map(); this.disabled = false; this.hidden = false; this._value = ''; this.dataset = {}; this.attributes = new Map(); this.classList = { toggle: (name, force) => { const rows = new Set(this.className.split(' ').filter(Boolean)); const chosen = force ?? !rows.has(name); if (chosen) rows.add(name); else rows.delete(name); this.className = [...rows].join(' '); }, remove: name => { this.className = this.className.split(' ').filter(row => row !== name).join(' '); } }; }
  append(...values) { this.children.push(...values); }
  prepend(...values) { this.children.unshift(...values); }
  replaceChildren(...values) { this.children = values; this.text = ''; this._value = ''; }
  addEventListener(name, fn) { this.listeners.set(name, [...(this.listeners.get(name) || []), fn]); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'src') delete this.src; }
  get options() { return this.children; }
  get value() { return this._value || (this.tagName === 'select' ? this.children[0]?.value || '' : ''); }
  set value(value) { this._value = String(value); }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.children = []; }
  focus() { this.focused = true; }
  reset() { for (const node of walk(this)) if (['input', 'textarea', 'select'].includes(node.tagName)) node.value = ''; }
}
const walk = node => [node, ...node.children.flatMap(walk)];
const fire = (node, type = 'click', extras = {}) => { for (const listener of node.listeners.get(type) || []) listener({ preventDefault() {}, ...extras }); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const hash = 'a'.repeat(64), sourceId = 'source-entry', course = { id: 'reviewed-course', revision: 3, session_hash: 'b'.repeat(64) };
function studio(page, overrides = {}) {
  const id = `slide-${page}`;
  return { item: { id, title: `Recursion · slide ${page}`, revision: 1, created_at: '2026-10-05T12:00:00Z', data: { source_title: 'Recursion', studio_hash: `studio-hash-${page}`, source_pin: { id: sourceId, version: 'version1', original_sha256: hash, physical_page: page }, learning_pin: null, academic_policy: { grading: 'ungraded', ai_rule: 'allowed' }, context_document: { id: `context-${page}`, revision: 1, sha256: hash } } }, page: { physical_page: page, page_count: 3, text: `Exact slide ${page} text.`, printed_label: null }, messages: [{ id: `message-${page}`, mode: 'question', question: `Question on slide ${page}`, state: 'completed', text: `Only slide ${page} answer`, pointers: [], progress: [] }], quizzes: [], attempts: [], annotations: [], ...overrides };
}
const summary = data => ({ id: data.item.id, title: data.item.title, revision: 1, created_at: data.item.created_at, stale: false, physical_page: data.page.physical_page, source_title: data.item.data.source_title, source_pin: { ...data.item.data.source_pin }, learning_pin: data.item.data.learning_pin, academic_policy: { ...data.item.data.academic_policy } });
function harness(t, options = {}) {
  const root = new Node('main'), head = new Node('head'), calls = [], jobs = [], confirmations = [], data = new Map((options.pages || [studio(1), studio(2)]).map(row => [row.item.id, row])); let grants = options.grants || [], stale = false, aborts = 0, cancels = 0, recognition;
  const previousGlobals = new Map(['document', 'speechSynthesis', 'SpeechRecognition'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const documentListeners = new Map(); let modalOpen = false;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { head, documentElement: { lang: 'en-US' }, querySelector: selector => modalOpen && selector.includes('dialog') ? new Node('dialog') : null, addEventListener: (name, handler) => documentListeners.set(name, handler), createElementNS: (namespace, tag) => { const node = new Node(tag); node.namespaceURI = namespace; return node; } } });
  Object.defineProperty(globalThis, 'speechSynthesis', { configurable: true, value: { cancel() { cancels++; }, speak() {} } });
  Object.defineProperty(globalThis, 'SpeechRecognition', { configurable: true, value: class { constructor() { recognition = this; } start() {} abort() { aborts++; this.onend?.(); } stop() { this.onend?.(); } } });
  const ui = mountCourseStudioUI({ root, element: (tag, cls, text) => new Node(tag, cls, text), request: async (path, extra = {}) => {
    calls.push({ path, ...extra }); const override = options.handle?.(path, extra); if (override !== undefined) return await override;
    if (path === '/sources') return { entries: [{ id: sourceId, title: 'Recursion', pdf: { page_count: 3 } }] };
    if (path === '/learning/sessions') return { items: [] };
    if (path === '/course-studio/sessions' && !extra.method) return { items: [...data.values()].map(row => ({ ...summary(row), stale })) };
    if (path === '/course-studio/sessions' && extra.method === 'POST') { const row = studio(extra.body.physical_page); row.item.data.learning_pin = extra.body.expected_learning_pin || null; row.item.data.academic_policy = extra.body.academic_policy; row.messages = []; data.set(row.item.id, row); return { item: row.item }; }
    if (path === '/agent-grants' && !extra.method) return { items: grants };
    if (path === '/agent-grants' && extra.method === 'POST') { const grant = { id: `grant-${extra.body.document_ids[0]}`, destination: 'codex', state: 'active', expires_at: new Date(Date.now() + 600000).toISOString(), used_bytes: 0, max_bytes: 256000, pins: { documents: extra.body.document_ids.map(id => ({ id })), tasks: [], source_entries: [] } }; grants.push(grant); return { grant }; }
    const match = /^\/course-studio\/sessions\/(slide-\d)(?:\/(asset|messages))?$/.exec(path);
    if (match && !match[2]) return structuredClone(data.get(match[1]));
    if (match?.[2] === 'asset') { const row = data.get(match[1]); return { asset: { physical_page: row.page.physical_page, source_sha256: hash, png_base64: `synthetic-page-${row.page.physical_page}` } }; }
    if (match?.[2] === 'messages' && extra.method === 'POST') return { item: { id: 'new-message' } };
    throw new Error(`Unexpected course UI route ${path}`);
  }, busy(control, task) { control.disabled = true; const job = Promise.resolve().then(task).finally(() => { control.disabled = false; }); jobs.push(job); return job; }, confirmAction: async (...args) => { confirmations.push(args); return options.confirm ? await options.confirm(...args) : true; } });
  t.after(() => { ui.reset(); for (const [name, descriptor] of previousGlobals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
  const find = predicate => { const row = walk(root).find(predicate); assert(row, 'Expected UI element'); return row; };
  return { root, ui, calls, confirmations, data, find, get recognition() { return recognition; }, get aborts() { return aborts; }, get cancels() { return cancels; }, setStale() { stale = true; }, setModal(value) { modalOpen = value; }, async key(key, target = new Node('div'), extra = {}) { documentListeners.get('keydown')?.({ key, target, preventDefault() {}, ...extra }); await jobs.at(-1)?.catch(() => {}); await Promise.resolve(); await Promise.resolve(); }, button: text => find(row => row.tagName === 'button' && row.textContent === text),
    field: label => { const caption = find(row => row.tagName === 'label' && row.textContent === label); return find(row => row.id === caption.htmlFor); },
    async click(text) { const row = this.button(text); assert.equal(row.disabled, false, `Enabled: ${text}`); fire(row); await jobs.at(-1)?.catch(() => {}); await Promise.resolve(); await Promise.resolve(); },
    start(text) { fire(this.button(text)); return jobs.at(-1); }, async open(page) { await ui.refresh(); const card = find(row => row.tagName === 'div' && row.children.some(child => child.tagName === 'h3' && child.textContent === `Recursion · slide ${page}`)); fire(card.children.find(row => row.tagName === 'button')); await jobs.at(-1); await Promise.resolve(); } };
}

test('CSUI01: saved exact slide navigation restores its draft and answer with no context/share/model mutation', async t => {
  const h = harness(t); await h.open(2); assert.match(h.root.textContent, /Slide 2 \/ 3/); const question = h.field('Your question about this slide'); question.value = 'My unfinished slide 2 question'; fire(question, 'input');
  await h.click('← Previous'); assert.match(h.root.textContent, /Only slide 1 answer/); assert.equal(h.root.textContent.includes('Only slide 2 answer'), false); assert.equal(question.value, ''); assert.equal(h.button('← Previous').disabled, true);
  question.value = 'Different slide 1 draft'; fire(question, 'input'); await h.click('Next →'); assert.equal(question.value, 'My unfinished slide 2 question'); assert.match(h.root.textContent, /Tutor · slide 2/); assert.equal(h.confirmations.length, 0); assert.equal(h.calls.some(row => row.method === 'POST'), false);
});
test('CSUI02: a new physical slide requires one context review, copies exact course pins, and never starts AI', async t => {
  const first = studio(2); first.item.data.learning_pin = { ...course }; const h = harness(t, { pages: [first] }); await h.open(2); await h.click('Next →'); const writes = h.calls.filter(row => row.method === 'POST'); assert.equal(writes.length, 1); assert.equal(writes[0].path, '/course-studio/sessions'); assert.equal(writes[0].body.physical_page, 3); assert.equal(writes[0].body.source_entry_id, sourceId); assert.deepEqual(writes[0].body.expected_learning_pin, course); assert.match(h.confirmations[0][0], /no question is sent/); assert.equal(h.button('Next →').disabled, true); assert.equal(h.button('Ask tutor').disabled, true);
  await h.click('← Previous'); assert.equal(h.confirmations.length, 1); assert.match(h.root.textContent, /Only slide 2 answer/);
});
test('CSUI03: starter only drafts current-slide support; explicit share auto-selects the new grant before exact reviewed question start', async t => {
  const h = harness(t); await h.open(2); await h.click('Walk me through it'); const question = h.field('Your question about this slide'); assert.match(question.value, /one small section at a time/); assert.equal(question.focused, true); assert.equal(h.calls.some(row => row.method === 'POST'), false);
  await h.click('Enable tutor for this slide'); assert.equal(h.field('Approved context selection').value, 'grant-context-2'); assert.equal(h.button('Ask tutor').disabled, false); assert.equal(h.calls.filter(row => row.method === 'POST').length, 1);
  await h.click('Ask tutor'); const sent = h.calls.find(row => row.path === '/course-studio/sessions/slide-2/messages'); assert.equal(sent.body.grant_id, 'grant-context-2'); assert.equal(sent.body.studio_hash, 'studio-hash-2'); assert.equal(sent.body.mode, 'question'); assert.match(sent.body.question, /wait for my reply/); assert.equal(h.confirmations.length, 2);
  await h.click('← Previous'); assert.equal(h.field('Approved context selection').value, ''); assert.equal(h.button('Ask tutor').disabled, true);
});
test('CSUI04: navigation stops optional voice and discards late recognition from the previous slide', async t => {
  const h = harness(t); await h.open(2); await h.click('Dictate question'); const old = h.recognition, before = h.cancels; await h.click('← Previous'); assert.equal(h.aborts, 1); assert(h.cancels > before); old.onresult({ results: [[{ transcript: 'OLD SLIDE VOICE CANARY' }]] }); assert.equal(h.field('Your question about this slide').value, ''); assert.equal(h.button('Stop dictation').disabled, true);
});
test('CSUI05: cancelled/reset slide review writes nothing and cannot revive its private page', async t => {
  const entered = deferred(), release = deferred(), h = harness(t, { pages: [studio(2)], confirm: () => { entered.resolve(); return release.promise; } }); await h.open(2); const running = h.start('Next →'); await entered.promise; h.ui.reset(); release.resolve(true); await running; assert.equal(h.calls.some(row => row.method === 'POST'), false); assert.equal(h.root.textContent.includes('Only slide 2 answer'), false); assert.equal(h.find(row => row.tagName === 'img').src, undefined);
});
test('CSUI06: zoom changes only CSS view scale; invalid page jump and stale source never create or share', async t => {
  const h = harness(t); await h.open(2); const zoom = h.field('Slide size'); zoom.value = '200'; fire(zoom, 'change'); assert(h.find(row => row.className.includes('course-page-stage')).className.includes('course-zoom-200')); h.field('Go to slide').value = '4'; await h.click('Go'); assert.match(h.root.textContent, /Choose a slide from 1 to 3/); assert.equal(h.calls.some(row => row.method === 'POST'), false);
  h.setStale(); await h.ui.refresh(); assert.equal(h.root.textContent.includes('Only slide 2 answer'), false); assert.equal(h.root.textContent.includes('Exact slide 2 text'), false); assert.equal(h.find(row => row.tagName === 'img').src, undefined);
});
test('CSUI07: stale/different source or recipe sessions cannot be reused for a new slide', async t => {
  const wrong = studio(1); wrong.item.data.source_pin.original_sha256 = 'c'.repeat(64); wrong.item.data.learning_pin = { ...course }; const h = harness(t, { pages: [studio(2), wrong] }); await h.open(2); await h.click('← Previous'); assert.equal(h.confirmations.length, 1); const created = h.calls.find(row => row.method === 'POST'); assert.equal(created.body.physical_page, 1); assert.equal('learning_session_id' in created.body, false); assert.equal(created.body.source_entry_id, sourceId); assert.equal(h.calls.some(row => row.path.endsWith('/messages') || row.path === '/agent-grants' && row.method === 'POST'), false);
});
test('CSUI08: selected PDF rendering failure removes the prior image and private current transcript', async t => {
  let fail = false; const h = harness(t, { handle: path => path.endsWith('/asset') && fail ? Promise.reject(new Error('Selected PDF version changed')) : undefined }); await h.open(2); fail = true; await h.click('← Previous'); assert.equal(h.root.textContent.includes('Only slide 1 answer'), false); assert.equal(h.root.textContent.includes('Only slide 2 answer'), false); assert.equal(h.find(row => row.tagName === 'img').src, undefined); assert.match(h.root.textContent, /Selected PDF version changed/);
});
test('CSUI09: practice answer drafts stay with the exact quiz across slide changes and refreshes', async t => {
  const pages = [studio(1), studio(2)]; for (const page of pages) page.quizzes = [{ id: `quiz-${page.page.physical_page}`, revision: 1, title: 'Practice check', data: { questions: [{ id: 'q1', question: `Question for ${page.page.physical_page}` }] } }];
  const h = harness(t, { pages }); await h.open(2); const response = h.field('Your actual answer'); response.value = 'My unfinished page 2 practice response'; fire(response, 'input'); await h.click('← Previous'); assert.equal(h.field('Your actual answer').value, ''); await h.click('Next →'); assert.equal(h.field('Your actual answer').value, 'My unfinished page 2 practice response'); await h.ui.refresh(); assert.equal(h.field('Your actual answer').value, 'My unfinished page 2 practice response'); assert.equal(h.calls.some(row => row.method === 'POST'), false);
});
test('CSUI10: oversized context error offers narrower reviewed context without changing the imported deck or starting AI', async t => {
  const budgetError = Object.assign(new Error('BUDGET_EXCEEDED'), { code: 'BUDGET_EXCEEDED' }), h = harness(t, { pages: [studio(2)], handle: (path, extra) => path === '/course-studio/sessions' && extra.method === 'POST' ? Promise.reject(budgetError) : undefined }); await h.open(2); await h.click('Next →'); assert.match(h.root.textContent, /This selected page only/); assert.match(h.root.textContent, /fewer reviewed passages/); assert.match(h.root.textContent, /Nothing is silently trimmed/); assert.match(h.root.textContent, /imported PDF is unchanged/); assert.equal(h.data.size, 1); assert.equal(h.calls.some(row => row.path === '/agent-grants' && row.method === 'POST' || row.path.endsWith('/messages')), false); assert.match(h.root.textContent, /Only slide 2 answer/);
});
test('CSUI11: context selector excludes wider existing grants, including unrelated notes, tasks and imported sources', async t => {
  const base = { destination: 'codex', state: 'active', expires_at: new Date(Date.now() + 600000).toISOString(), used_bytes: 0, max_bytes: 256000, pins: { documents: [{ id: 'context-2' }], tasks: [], source_entries: [] } }, grants = [{ ...base, id: 'exact' }, { ...base, id: 'extra-note', pins: { ...base.pins, documents: [...base.pins.documents, { id: 'unrelated' }] } }, { ...base, id: 'extra-task', pins: { ...base.pins, tasks: [{ id: 'other-task' }] } }, { ...base, id: 'extra-source', pins: { ...base.pins, source_entries: [{ id: 'other-source' }] } }];
  const h = harness(t, { grants }); await h.open(2); assert.deepEqual(h.field('Approved context selection').options.map(row => row.value), ['', 'exact']); assert.equal(h.calls.some(row => row.method === 'POST'), false);
});
test('CSUI12: duplicate saved slide titles are distinguished by visible creation time and unique accessible open labels', async t => {
  const first = studio(2), second = studio(2); second.item.id = 'same-page-later'; second.item.created_at = '2026-10-05T12:00:17Z'; const h = harness(t, { pages: [first, second] }); await h.ui.refresh(); const buttons = walk(h.root).filter(row => row.tagName === 'button' && row.textContent === 'Open saved slide'); assert.equal(buttons.length, 2); const labels = buttons.map(row => row.attributes.get('aria-label')); assert.equal(new Set(labels).size, 2); assert(labels.every(label => /^Open saved slide: Recursion · slide 2, slide 2, saved /.test(label))); assert.equal(h.root.textContent.includes('same-page-later'), false); assert.equal(walk(h.root).filter(row => row.tagName === 'p' && row.textContent.startsWith('Saved ')).length, 2);
});
test('CSUI13: opening a slide collapses deck setup without collapsing a user-reopened form during refresh', async t => {
  const h = harness(t); await h.ui.refresh(); const setup = h.find(row => row.className.includes('course-deck-setup')); assert.equal(setup.open, true); await h.open(2); assert.equal(setup.open, false); assert.equal(setup.children[0].textContent, 'Choose another deck'); setup.open = true; await h.ui.refresh(); assert.equal(setup.open, true); h.ui.reset(); assert.equal(setup.open, true); assert.equal(setup.children[0].textContent, 'Open your slides');
});
test('CSUI14: arrow keys navigate only the active slide outside editing controls or review dialogs', async t => {
  const h = harness(t); await h.open(2); for (const tag of ['input', 'textarea', 'select']) await h.key('ArrowLeft', new Node(tag)); await h.key('ArrowLeft', { tagName: 'span', isContentEditable: true }); h.setModal(true); await h.key('ArrowLeft'); h.setModal(false); await h.key('ArrowLeft', new Node('div'), { ctrlKey: true }); assert.match(h.root.textContent, /Slide 2 \/ 3/);
  await h.key('ArrowLeft'); assert.match(h.root.textContent, /Slide 1 \/ 3/); assert.equal(h.calls.some(row => row.method === 'POST'), false); h.ui.pause(); await h.key('ArrowRight'); assert.match(h.root.textContent, /Slide 1 \/ 3/); await h.ui.refresh(); await h.key('ArrowRight'); assert.match(h.root.textContent, /Slide 2 \/ 3/); h.ui.reset(); const before = h.calls.length; await h.key('ArrowRight'); assert.equal(h.calls.length, before);
});

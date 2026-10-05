import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { handlePracticeRoute } from '../apps/local-runtime/src/practice-routes.mjs';
import { mountPracticeUI } from '../apps/local/public/practice.js';

// Shipped event handlers run against real SQLite services. This stand-in proves
// async state and private persistence, not native browser layout.
class Node {
  constructor(tag, className = '', text = '') { this.tagName = tag; this.className = className; this.text = text; this.children = []; this.listeners = new Map(); this.hidden = false; this.disabled = false; this.checked = false; this.value = ''; this.classList = { toggle() {} }; }
  append(...children) { this.children.push(...children); if (this.tagName === 'select' && this.children.length === 1) this.value = this.children[0].value; }
  replaceChildren(...children) { this.children = []; this.text = ''; this.append(...children); }
  setAttribute() {}
  addEventListener(type, callback) { this.listeners.set(type, [...(this.listeners.get(type) || []), callback]); }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.children = []; }
}
const walk = node => [node, ...node.children.flatMap(walk)];
const visible = node => node.hidden ? '' : node.text + node.children.map(visible).join('\n');
const fire = (node, type = 'click') => { for (const callback of node.listeners.get(type) || []) callback({ preventDefault() {} }); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function harness(t, { intercept, confirm = async () => true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'learnbridge-practice-ui-')), store = LocalStore.open({ root: join(base, 'private') }), root = new Node('main'), calls = [], jobs = [];
  const doc = store.createDocument({ title: 'Synthetic recursion note', text: 'A base case returns.\n<script>SOURCE_LITERAL_CANARY</script>\nUNSELECTED_LINE_CANARY', kind: 'study' });
  const request = async (path, options = {}) => { const call = { path, ...options }; calls.push(call); const replacement = intercept?.(call, store); if (replacement !== undefined) return await replacement;
    if (path === '/documents') return { items: store.listDocuments() };
    if (path.startsWith('/documents/')) { const saved = store.getDocument(path.slice('/documents/'.length)); return { document: saved.document, content: saved.text, sha256: saved.sha256 }; }
    return (await handlePracticeRoute({ route: path, method: options.method || 'GET', store, session: { nonce: 'paired-human-fixture' }, idempotencyKey: options.idempotencyKey, privateBody: async () => options.body })).data;
  };
  const ui = mountPracticeUI({ root, request, element: (tag, className, text) => new Node(tag, className, text), busy(control, callback) { control.disabled = true; const job = Promise.resolve().then(callback).finally(() => { control.disabled = false; }); jobs.push(job); return job; }, confirmAction: confirm });
  t.after(() => { ui.reset(); store.close(); rmSync(base, { recursive: true, force: true }); });
  const control = label => { const caption = walk(root).find(node => node.tagName === 'label' && node.text === label); assert.ok(caption, label); const input = walk(root).find(node => node.id === caption.htmlFor); assert.ok(input, `${label} accessible control`); return input; };
  const button = label => { const node = walk(root).find(node => node.tagName === 'button' && node.textContent === label); assert.ok(node, label); return node; };
  const form = () => walk(root).find(node => node.tagName === 'form');
  return { root, store, doc, ui, calls, control, button, get notice() { return walk(root).find(node => node.id === 'practice-status').textContent; },
    startClick(label) { fire(button(label)); return jobs.at(-1); }, async click(label) { fire(button(label)); await jobs.at(-1)?.catch(() => {}); await Promise.resolve(); },
    startSubmit() { fire(form(), 'submit'); return jobs.at(-1); }, async submit() { await this.startSubmit()?.catch(() => {}); await Promise.resolve(); },
    async prepare() { await ui.refresh(); control('Private source note').value = doc.document.id; fire(control('Private source note'), 'change'); await this.click('Load selected note'); control('Last source line').value = '2'; fire(control('Last source line'), 'input'); control('Deck title').value = 'Synthetic deck'; control('Practice question').value = '<script>QUESTION_LITERAL_CANARY</script>'; control('Reference answer I wrote').value = 'REFERENCE_ANSWER_CANARY: A base case returns.'; },
    acknowledge() { control('I wrote and checked these reference answers. Their correctness is my responsibility.').checked = true; control('These are ungraded conceptual practice questions, not missing answers to a graded submission.').checked = true; },
  };
}

test('PUI01: complete shipped UI source selection, checked save, own answer, explicit reveal and self-rating write exactly one durable observation', async t => {
  const h = harness(t); await h.prepare(); assert.equal(h.control('I wrote and checked these reference answers. Their correctness is my responsibility.').checked, false); await h.submit(); assert.equal(h.calls.some(row => row.path === '/practice/decks' && row.method === 'POST'), false);
  h.acknowledge(); await h.submit(); assert.match(h.notice, /saved/); assert.equal(h.store.listWorkspaceRecords({ kind: 'learning_checkpoint' }).length, 1); assert.equal(walk(h.root).some(node => node.tagName === 'script'), false); assert.match(visible(h.root), /SOURCE_LITERAL_CANARY/); assert.doesNotMatch(visible(h.root), /UNSELECTED_LINE_CANARY/);
  h.control('My answer before revealing').value = 'STUDENT_RESPONSE_CANARY: a base case.'; await h.click('Save answer before reveal'); const attemptPanel = h.root.children[4]; assert.match(visible(attemptPanel), /STUDENT_RESPONSE_CANARY/); assert.doesNotMatch(visible(attemptPanel), /REFERENCE_ANSWER_CANARY/);
  await h.click('Reveal reference answer'); assert.match(visible(attemptPanel), /REFERENCE_ANSWER_CANARY/); await h.click('Good: I recalled it'); assert.equal(h.calls.some(row => row.path.endsWith('/rate')), false);
  h.control('I compared my answer with the reference. This rating is my own observation on this attempt.').checked = true; await h.click('Good: I recalled it'); assert.match(h.notice, /self-rating was saved/); const saved = h.store.listWorkspaceRecords({ kind: 'learning_checkpoint' }); assert.equal(saved.filter(row => row.data.format === 'spaced_practice_attempt').length, 1); assert.equal(saved.find(row => row.data.format === 'spaced_practice_deck').data.cards[0].schedule.repetitions, 1); assert.equal(saved.find(row => row.data.format === 'spaced_practice_attempt').data.receipt.mastery_claim, false); assert.equal(h.store.listTasks().length, 0); assert.equal(h.store.listAgentGrants().length, 0);
});
test('PUI02: editing selected source or card content while exact save confirmation waits sends no changed review', async t => {
  const entered = deferred(), release = deferred(); const h = harness(t, { confirm: () => { entered.resolve(); return release.promise; } }); await h.prepare(); h.acknowledge(); const pending = h.startSubmit(); await entered.promise; h.control('Reference answer I wrote').value = 'Changed after review'; release.resolve(true); await pending; assert.equal(h.calls.some(row => row.path === '/practice/decks' && row.method === 'POST'), false); assert.equal(h.store.listWorkspaceRecords({ kind: 'learning_checkpoint' }).length, 0);
});
test('PUI03: changed source selection discards late selected note and cannot populate reference text', async t => {
  const entered = deferred(), release = deferred(); const h = harness(t, { intercept(call) { if (call.path.startsWith('/documents/')) { entered.resolve(); return release.promise; } } }); await h.ui.refresh(); h.control('Private source note').value = h.doc.document.id; const pending = h.startClick('Load selected note'); await entered.promise; h.control('Private source note').value = ''; fire(h.control('Private source note'), 'change'); release.resolve({ document: h.doc.document, content: 'LATE_PRIVATE_SOURCE_CANARY', sha256: h.doc.sha256 }); await pending; assert.doesNotMatch(visible(h.root), /LATE_PRIVATE_SOURCE_CANARY/);
});
test('PUI04: reset during a pending queue refresh cannot restore private source or cards', async t => {
  const entered = deferred(), release = deferred(); let delay = false; const h = harness(t, { intercept(call) { if (delay && call.path === '/practice/due') { entered.resolve(); return release.promise; } } }); await h.prepare(); h.acknowledge(); await h.submit(); delay = true; const pending = h.ui.refresh(); await entered.promise; h.ui.reset(); release.resolve({ items: [{ question: 'LATE_QUESTION_PRIVATE_CANARY' }], unavailable: [] }); await pending; assert.doesNotMatch(visible(h.root), /LATE_QUESTION_PRIVATE_CANARY|QUESTION_LITERAL_CANARY|SOURCE_LITERAL_CANARY/); assert.equal(h.notice, '');
});
test('PUI05: stale-source refresh clears revealed answer and permits reviewed removal without altering the original note', async t => {
  const h = harness(t); await h.prepare(); h.acknowledge(); await h.submit(); h.control('My answer before revealing').value = 'Own attempt'; await h.click('Save answer before reveal'); await h.click('Reveal reference answer'); assert.match(visible(h.root.children[4]), /REFERENCE_ANSWER_CANARY/);
  const note = h.store.getDocument(h.doc.document.id); h.store.updateDocument(note.document.id, { text: 'Source changed independently.' }, note.document.revision); await h.ui.refresh(); assert.equal(h.root.children[4].hidden, true); assert.doesNotMatch(visible(h.root.children[4]), /REFERENCE_ANSWER_CANARY/); assert.match(visible(h.root), /selected source changed/); await h.click('Remove this deck'); assert.equal(h.store.listWorkspaceRecords({ kind: 'learning_checkpoint' }).filter(row => row.data.format === 'spaced_practice_deck').length, 0); assert.equal(h.store.getDocument(h.doc.document.id).text, 'Source changed independently.');
});
test('PUI06: source HTML stays literal, all fields have explicit labels, and module contains no alternate fetch/storage/HTML execution', t => {
  const h = harness(t); for (const node of walk(h.root).filter(row => ['input', 'textarea', 'select'].includes(row.tagName))) assert.ok(walk(h.root).some(row => row.tagName === 'label' && row.htmlFor === node.id), node.id);
  const source = readFileSync(new URL('../apps/local/public/practice.js', import.meta.url), 'utf8'); assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function|localStorage|sessionStorage|\.style\.|fetch\(/); assert.match(source, /read !== state\.refreshes/); assert.match(source, /JSON\.stringify\(reviewedBody\) !== JSON\.stringify\(body\)/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';
import { LocalStore } from '../packages/local-storage/src/index.mjs';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'learnbridge-practice-http-')), root = join(base, 'private'), runtimes = [];
  t.after(async () => { for (const runtime of runtimes.reverse()) await runtime.close(); await rm(base, { recursive: true, force: true }); });
  async function start(dataRoot = root) { const runtime = await startRuntime({ dataRoot, port: 0 }); runtimes.push(runtime); return runtime; }
  return { base, root, start, runtime: await start() };
}
async function pair(runtime) {
  const response = await fetch(`${runtime.origin}/api/local/v1/pair`, { method: 'POST', headers: { Origin: runtime.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: runtime.createPairingCode() }) }); assert.equal(response.status, 200);
  return { nonce: (await response.json()).nonce, cookie: response.headers.get('set-cookie').split(';')[0] };
}
async function call(runtime, session, path, { method = 'GET', body, key, origin = runtime.origin } = {}) {
  const response = await fetch(`${runtime.origin}/api/local/v1${path}`, { method, headers: { ...(session ? { Cookie: session.cookie, 'X-LearnBridge-Nonce': session.nonce } : {}), ...(method === 'GET' ? {} : { Origin: origin, 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json(), cache: response.headers.get('cache-control') };
}
const deckInput = doc => ({ title: 'HTTP practice fixture', sources: [{ document_id: doc.document.id, revision: doc.document.revision, sha256: doc.sha256, line_start: 1, line_end: 1 }], cards: [{ question: '<script>What terminates?</script>', answer: 'A base case terminates recursion.', source_indices: [0] }], policy: { source_grading: 'ungraded', card_grading: 'ungraded', human_authored: true, conceptual_only: true } });
async function create(t) { const f = await fixture(t), session = await pair(f.runtime); const doc = await call(f.runtime, session, '/documents', { method: 'POST', body: { title: 'Selected private note', content: 'A base case terminates recursion.\nPRIVATE_UNSELECTED_CANARY', kind: 'study', academic_policy: 'learning_support' }, key: 'http-practice-source' }); assert.equal(doc.status, 201); const input = deckInput(doc.data), response = await call(f.runtime, session, '/practice/decks', { method: 'POST', body: input, key: 'http-practice-deck' }); assert.equal(response.status, 201); return { ...f, session, doc: doc.data, deck: response.data.item, input }; }

test('PH01: shipped HTTP answer→reveal→reviewed rating persists through runtime restart and fresh backup restore', async t => {
  const f = await create(t); let runtime = f.runtime, session = f.session; const { deck } = f;
  const queue = await call(runtime, session, '/practice/due'); assert.equal(queue.status, 200); assert.equal(queue.data.items.length, 1); assert.equal(JSON.stringify(queue.data).includes(f.input.cards[0].answer), false); assert.match(queue.cache, /private, no-store/);
  const answerBody = { expected_revision: deck.revision, deck_hash: deck.deck_hash, card_id: deck.cards[0].id, student_response: 'MY_EXACT_HTTP_RESPONSE_CANARY' };
  let attempt = (await call(runtime, session, `/practice/decks/${deck.id}/answer`, { method: 'POST', body: answerBody, key: 'http-practice-answer' })).data.item; assert.equal(attempt.phase, 'answered'); assert.equal(attempt.answer, undefined);
  assert.equal((await call(runtime, session, `/practice/attempts/${attempt.id}/rate`, { method: 'POST', body: { expected_revision: 1, deck_revision: 2, deck_hash: deck.deck_hash, rating: 'good', reviewed_by_student: true } })).status, 409);
  await runtime.close(); runtime = await f.start(); session = await pair(runtime); attempt = (await call(runtime, session, `/practice/attempts/${attempt.id}`)).data.item; assert.equal(attempt.student_response, 'MY_EXACT_HTTP_RESPONSE_CANARY');
  attempt = (await call(runtime, session, `/practice/attempts/${attempt.id}/reveal`, { method: 'POST', body: { expected_revision: attempt.revision, deck_hash: deck.deck_hash } })).data.item; assert.equal(attempt.answer, f.input.cards[0].answer); assert.equal(attempt.sources[0].text, f.input.cards[0].answer);
  const rate = { expected_revision: attempt.revision, deck_revision: attempt.deck_revision, deck_hash: deck.deck_hash, rating: 'good', reviewed_by_student: true };
  const results = await Promise.all([call(runtime, session, `/practice/attempts/${attempt.id}/rate`, { method: 'POST', body: rate }), call(runtime, session, `/practice/attempts/${attempt.id}/rate`, { method: 'POST', body: rate })]); assert.deepEqual(results.map(row => row.status), [200, 200]); assert.deepEqual(results[0].data, results[1].data); assert.equal((await call(runtime, session, '/practice/due')).data.items.length, 0);
  const saved = (await call(runtime, session, `/practice/decks/${deck.id}`)).data.item; assert.equal(saved.cards[0].schedule.repetitions, 1); assert.equal(saved.cards[0].schedule.mastery_claim, false);
  await runtime.close(); const store = LocalStore.open({ root: f.root }); try { await store.backup(join(f.base, 'backup')); } finally { store.close(); } const restoredRoot = join(f.base, 'restored'); await LocalStore.restore({ backupRoot: join(f.base, 'backup'), root: restoredRoot }); runtime = await f.start(restoredRoot); session = await pair(runtime);
  assert.deepEqual((await call(runtime, session, `/practice/decks/${deck.id}`)).data.item, saved); assert.deepEqual((await call(runtime, session, `/practice/attempts/${attempt.id}/rate`, { method: 'POST', body: rate })).data, results[0].data); assert.equal((await call(runtime, session, '/tasks')).data.items.length, 0);
});
test('PH02: real authentication/origin/nonce/schema gates fail before writing; private query data stays unavailable', async t => {
  const { runtime } = await fixture(t); assert.equal((await call(runtime, null, '/practice/decks')).status, 401); const session = await pair(runtime);
  assert.equal((await call(runtime, { ...session, nonce: 'forged' }, '/practice/due')).status, 403); assert.equal((await call(runtime, session, '/practice/decks', { method: 'POST', body: {}, origin: 'https://hostile.invalid' })).status, 403);
  assert.equal((await call(runtime, session, '/practice/decks?secret=PRIVATE_QUERY_CANARY')).status, 400); assert.equal((await call(runtime, session, '/practice/decks', { method: 'POST', body: { token: 'PRIVATE_TOKEN_CANARY' } })).status, 400);
  for (const path of ['/practice/generate-with-ai', '/practice/submit-coursework', '/practice/send-mail']) assert.equal((await call(runtime, session, path, { method: 'POST', body: {} })).status, 404);
  assert.equal((await call(runtime, session, '/practice/decks')).data.items.length, 0);
});
test('PH03: actual note edit invalidates queued source pins and active attempt; metadata view never leaks retained source or answer', async t => {
  const f = await create(t); const { runtime, session, deck } = f; const attempt = await call(runtime, session, `/practice/decks/${deck.id}/answer`, { method: 'POST', body: { expected_revision: deck.revision, deck_hash: deck.deck_hash, card_id: deck.cards[0].id, student_response: 'RETAINED_PRIVATE_CANARY' }, key: 'http-stale-answer' }); assert.equal(attempt.status, 201);
  const edit = await call(runtime, session, `/documents/${f.doc.document.id}`, { method: 'PATCH', body: { expected_revision: f.doc.document.revision, content: 'Student revised the selected note.' } }); assert.equal(edit.status, 200);
  assert.equal((await call(runtime, session, `/practice/attempts/${attempt.data.item.id}/reveal`, { method: 'POST', body: { expected_revision: 1, deck_hash: deck.deck_hash } })).status, 409);
  assert.equal((await call(runtime, session, `/practice/decks/${deck.id}`)).status, 409); const summary = await call(runtime, session, '/practice/decks'); assert.equal(summary.data.items[0].stale, true); assert.doesNotMatch(JSON.stringify(summary.data), /RETAINED_PRIVATE_CANARY|PRIVATE_UNSELECTED_CANARY|base case/); assert.equal((await call(runtime, session, '/practice/due')).data.items.length, 0);
  assert.equal((await call(runtime, session, `/practice/decks/${deck.id}`, { method: 'DELETE', body: { expected_revision: 2 } })).status, 200); assert.equal((await call(runtime, session, '/practice/decks')).data.items.length, 0);
});

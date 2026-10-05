import { LearnBridgeError } from '@learnbridge/core';
import { createPracticeService } from './practice-service.mjs';

/** Human paired-browser-only; the runtime independently owns origin/cookie/nonce checks. */
export async function handlePracticeRoute({ route, method, privateBody, store, idempotencyKey, session }) {
  if (!route.startsWith('/practice/')) return null;
  if (!session || typeof session.nonce !== 'string' || !session.nonce) throw new LearnBridgeError('AUTH_REQUIRED');
  const service = createPracticeService({ store }), denied = () => { throw new LearnBridgeError('INVALID_INPUT'); };
  if (route === '/practice/decks') {
    if (method === 'GET') return { status: 200, data: { items: service.listDecks() } };
    if (method !== 'POST') denied(); const body = await privateBody(['title', 'sources', 'cards', 'policy'], ['title', 'sources', 'cards', 'policy'], 64000);
    return { status: 201, data: { item: service.createDeck(body, { idempotencyKey }) } };
  }
  if (route === '/practice/due') { if (method !== 'GET') denied(); return { status: 200, data: service.dueQueue() }; }
  const deck = /^\/practice\/decks\/([^/]+)(?:\/(answer|state))?$/.exec(route);
  if (deck) {
    if (!deck[2]) {
      if (method === 'GET') return { status: 200, data: { item: service.getDeck(deck[1]) } };
      if (method === 'DELETE') { const body = await privateBody(['expected_revision'], ['expected_revision'], 4096); return { status: 200, data: service.remove(deck[1], body) }; }
      denied();
    }
    if (method !== 'POST') denied();
    if (deck[2] === 'state') { const body = await privateBody(['expected_revision', 'deck_hash', 'state'], ['expected_revision', 'deck_hash', 'state'], 4096); return { status: 200, data: { item: service.setState(deck[1], body) } }; }
    const body = await privateBody(['expected_revision', 'deck_hash', 'card_id', 'student_response'], ['expected_revision', 'deck_hash', 'card_id', 'student_response'], 16000);
    return { status: 201, data: { item: service.begin(deck[1], body, { idempotencyKey }) } };
  }
  const attempt = /^\/practice\/attempts\/([^/]+)(?:\/(reveal|rate|skip))?$/.exec(route); if (!attempt) return null;
  if (!attempt[2]) { if (method !== 'GET') denied(); return { status: 200, data: { item: service.getAttempt(attempt[1]) } }; }
  if (method !== 'POST') denied();
  const keys = attempt[2] === 'reveal' ? ['expected_revision', 'deck_hash'] : attempt[2] === 'rate' ? ['expected_revision', 'deck_revision', 'deck_hash', 'rating', 'reviewed_by_student'] : ['expected_revision', 'deck_revision', 'deck_hash'];
  const body = await privateBody(keys, keys, 4096); return { status: 200, data: { item: service[attempt[2]](attempt[1], body) } };
}

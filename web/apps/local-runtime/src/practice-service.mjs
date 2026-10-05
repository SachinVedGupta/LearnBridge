import { createHash, randomUUID } from 'node:crypto';
import { LearnBridgeError } from '@learnbridge/core';
import { TutoringError } from '../../../packages/local-academic/src/tutoring.mjs';

const FORMAT = 'spaced_practice_deck';
const ATTEMPT = 'spaced_practice_attempt';
export const PRACTICE_RULE = 'transparent-cadence-v1';
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const fail = code => { throw new LearnBridgeError(code); };
const stale = () => { throw new TutoringError('STALE_EVIDENCE'); };
function object(value, allowed, required = allowed) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key) || !('value' in Object.getOwnPropertyDescriptor(value, key))) || required.some(key => !Object.hasOwn(value, key))) fail('INVALID_INPUT');
}
function text(value, maximum) { if (typeof value !== 'string' || !value.trim() || value.length > maximum || /\u0000/.test(value)) fail('INVALID_INPUT'); return value; }
function uuid(value) { if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) fail('INVALID_INPUT'); return value.toLowerCase(); }
function integer(value, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_INPUT'); return value; }
function digest(value) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('INVALID_INPUT'); return value; }
function safe(value) {
  const seen = new Set(); let count = 0;
  function copy(item, depth) {
    if (++count > 10000 || depth > 12) fail('BUDGET_EXCEEDED');
    if (item === null || ['string', 'boolean'].includes(typeof item) || typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object' || seen.has(item)) fail('INVALID_INPUT'); seen.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item); let result;
    if (Array.isArray(item)) {
      if (item.length > 100 || Reflect.ownKeys(descriptors).some(key => key !== 'length' && (!/^\d+$/.test(String(key)) || !('value' in descriptors[key]) || !descriptors[key].enumerable))) fail('INVALID_INPUT');
      result = Array.from({ length: item.length }, (_, index) => { if (!Object.hasOwn(descriptors, String(index))) fail('INVALID_INPUT'); return copy(descriptors[index].value, depth + 1); });
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype || Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key) || !('value' in descriptors[key]) || !descriptors[key].enumerable)) fail('INVALID_INPUT');
      result = Object.fromEntries(Object.keys(descriptors).map(key => [key, copy(descriptors[key].value, depth + 1)]));
    }
    seen.delete(item); return result;
  }
  const result = copy(value, 0); if (Buffer.byteLength(JSON.stringify(result)) > 64000) fail('BUDGET_EXCEEDED'); return result;
}
function retry(options, prefix) {
  object(options, ['idempotencyKey'], []); const key = options.idempotencyKey;
  if (key === undefined) return null;
  if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,100}$/.test(key)) fail('INVALID_INPUT'); return `${prefix}-${hash(key)}`;
}
function schedule(prior, rating, now) {
  const intervals = [1, 3, 7, 14, 30]; const stage = rating === 'again' ? 0 : rating === 'hard' ? Math.max(0, prior.stage - 1) : Math.min(5, prior.stage + (rating === 'easy' ? 2 : 1));
  const minutes = rating === 'again' ? 10 : rating === 'hard' ? 1440 : intervals[Math.max(0, stage - 1)] * 1440;
  return { rule: PRACTICE_RULE, stage, repetitions: prior.repetitions + 1, last_rating: rating, last_reviewed_at: now, due_at: new Date(Date.parse(now) + minutes * 60000).toISOString(), interval_minutes: minutes, mastery_claim: false };
}

/** Entirely human-authored local practice. No provider, inferred mastery or external actions. */
export function createPracticeService({ store, clock = () => new Date().toISOString() }) {
  if (!store || typeof clock !== 'function') fail('INVALID_INPUT');
  const now = () => { const value = clock(); if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('INVALID_INPUT'); return value; };
  function records(format) { return store.listWorkspaceRecords({ kind: 'learning_checkpoint' }).filter(row => row.data.format === format); }
  function record(recordId, format) { const row = store.getWorkspaceRecord(uuid(recordId)); if (!row || row.kind !== 'learning_checkpoint' || row.data.format !== format) fail('SCOPE_DENIED'); return row; }
  function current(deck) {
    for (const pin of deck.data.sources) {
      const actual = store.getDocument(pin.document_id);
      if (!actual || actual.document.revision !== pin.revision || actual.sha256 !== pin.sha256 || actual.document.academic_policy !== pin.academic_policy) stale();
    }
    if (hash({ title: deck.title, sources: deck.data.sources, cards: deck.data.cards.map(({ id, question, answer, source_indices }) => ({ id, question, answer, source_indices })), policy: deck.data.policy }) !== deck.data.deck_hash) fail('VERSION_MISMATCH');
    return deck;
  }
  function exact(deck, input) { if (integer(input.expected_revision, 1, Number.MAX_SAFE_INTEGER) !== deck.revision || digest(input.deck_hash) !== deck.data.deck_hash) fail('REVISION_CONFLICT'); }
  function monotonic(deck, time) { if (time < deck.data.last_activity_at) fail('REVISION_CONFLICT'); }
  function replay(format, key, requestHash) {
    if (!key) return null; const row = records(format).find(item => item.data.client_request_key === key);
    if (row && row.data.request_hash !== requestHash) fail('REVISION_CONFLICT'); return row || null;
  }
  function deckView(deck) {
    current(deck); return { id: deck.id, title: deck.title, revision: deck.revision, deck_hash: deck.data.deck_hash, state: deck.data.state, policy: deck.data.policy, sources: deck.data.sources,
      cards: deck.data.cards.map(({ answer, ...card }) => card), active_attempt_id: deck.data.active_attempt_id, created_at: deck.created_at, updated_at: deck.updated_at, mastery_claim: false };
  }
  function attemptView(attempt, deck) {
    current(deck); const card = deck.data.cards.find(row => row.id === attempt.data.card_id); if (!card || attempt.data.deck_hash !== deck.data.deck_hash) fail('VERSION_MISMATCH');
    return { id: attempt.id, revision: attempt.revision, deck_id: deck.id, deck_revision: deck.revision, deck_hash: deck.data.deck_hash, card_id: card.id, question: card.question,
      student_response: attempt.data.student_response, phase: attempt.data.phase, started_at: attempt.data.started_at, ...(attempt.data.phase !== 'answered' && attempt.data.phase !== 'skipped' ? { answer: card.answer, sources: card.source_indices.map(index => deck.data.sources[index]) } : {}),
      ...(attempt.data.receipt ? { receipt: attempt.data.receipt } : {}), mastery_claim: false };
  }
  return {
    listDecks() {
      const time = now(); return records(FORMAT).map(deck => {
        const summary = { id: deck.id, title: deck.title, revision: deck.revision, state: deck.data.state, card_count: deck.data.cards.length, active_attempt_id: deck.data.active_attempt_id, source_grading: deck.data.policy.source_grading, mastery_claim: false };
        try { current(deck); return { ...summary, stale: false, due_count: deck.data.state === 'active' ? deck.data.cards.filter(card => card.schedule.due_at <= time).length : 0 }; }
        catch (error) { if (error.code !== 'STALE_EVIDENCE') throw error; return { ...summary, stale: true, due_count: 0, reason: 'Selected note changed or was removed. Recreate the deck from its current evidence.' }; }
      });
    },
    dueQueue() {
      const time = now(), items = [], unavailable = [];
      for (const deck of records(FORMAT)) {
        try { current(deck); } catch (error) { if (error.code !== 'STALE_EVIDENCE') throw error; unavailable.push({ id: deck.id, title: deck.title, reason: 'STALE_EVIDENCE' }); continue; }
        if (deck.data.state !== 'active') continue;
        for (const card of deck.data.cards) if (card.schedule.due_at <= time) items.push({ deck_id: deck.id, deck_title: deck.title, deck_revision: deck.revision, deck_hash: deck.data.deck_hash, card_id: card.id, question: card.question, due_at: card.schedule.due_at, active_attempt_id: deck.data.active_attempt_id, source_grading: deck.data.policy.source_grading });
      }
      items.sort((a, b) => a.due_at.localeCompare(b.due_at) || a.deck_id.localeCompare(b.deck_id) || a.card_id.localeCompare(b.card_id)); return { items: items.slice(0, 200), total_due: items.length, truncated: items.length > 200, unavailable, as_of: time, rule: PRACTICE_RULE, mastery_claim: false };
    },
    createDeck(value, options = {}) {
      const input = safe(value); object(input, ['title', 'sources', 'cards', 'policy']); const title = text(input.title, 500);
      object(input.policy, ['source_grading', 'card_grading', 'human_authored', 'conceptual_only']);
      if (!['ungraded', 'graded', 'unknown'].includes(input.policy.source_grading) || input.policy.card_grading !== 'ungraded' || input.policy.human_authored !== true || input.policy.conceptual_only !== true) fail('CONSENT_REQUIRED');
      if (!Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 5 || !Array.isArray(input.cards) || input.cards.length < 1 || input.cards.length > 25) fail('INVALID_INPUT');
      const key = retry(options, 'practice-deck'), requestHash = hash(input), existing = replay(FORMAT, key, requestHash); if (existing) return deckView(existing);
      if (records(FORMAT).length >= 100) fail('BUDGET_EXCEEDED');
      const sources = input.sources.map(pin => {
        object(pin, ['document_id', 'revision', 'sha256', 'line_start', 'line_end']); const docId = uuid(pin.document_id), actual = store.getDocument(docId);
        if (!actual || actual.document.revision !== integer(pin.revision, 1, Number.MAX_SAFE_INTEGER) || actual.sha256 !== digest(pin.sha256)) stale();
        const start = integer(pin.line_start, 1, 20000), end = integer(pin.line_end, start, 20000), lines = actual.text.split('\n'); if (end > lines.length || end - start >= 100) fail('INVALID_INPUT');
        const selected = lines.slice(start - 1, end).join('\n'); text(selected, 6000);
        if (actual.document.academic_policy === 'graded_restricted' && input.policy.source_grading === 'ungraded') fail('CONSENT_REQUIRED');
        return { document_id: docId, revision: pin.revision, sha256: pin.sha256, title: actual.document.title, academic_policy: actual.document.academic_policy, line_start: start, line_end: end, text: selected };
      });
      if (new Set(sources.map(pin => `${pin.document_id}:${pin.line_start}:${pin.line_end}`)).size !== sources.length) fail('INVALID_INPUT');
      const time = now();
      const cards = input.cards.map(card => { object(card, ['question', 'answer', 'source_indices']); if (!Array.isArray(card.source_indices) || !card.source_indices.length || card.source_indices.length > 5 || new Set(card.source_indices).size !== card.source_indices.length) fail('INVALID_INPUT');
        const indices = card.source_indices.map(index => integer(index, 0, sources.length - 1)).sort((a, b) => a - b);
        return { id: randomUUID(), question: text(card.question, 1500), answer: text(card.answer, 3000), source_indices: indices, schedule: { rule: PRACTICE_RULE, stage: 0, repetitions: 0, last_rating: null, last_reviewed_at: null, due_at: time, interval_minutes: 0, mastery_claim: false } }; });
      const deckHash = hash({ title, sources, cards: cards.map(({ schedule, ...card }) => card), policy: input.policy });
      const data = { format: FORMAT, policy: input.policy, sources, cards, deck_hash: deckHash, state: 'active', active_attempt_id: null, last_activity_at: time, client_request_key: key, request_hash: requestHash };
      if (Buffer.byteLength(JSON.stringify(data)) > 120000) fail('BUDGET_EXCEEDED'); current({ title, data });
      return deckView(store.createWorkspaceRecord({ kind: 'learning_checkpoint', title, data }, { ...(key ? { idempotencyKey: key } : {}) }));
    },
    getDeck(deckId) { return deckView(record(deckId, FORMAT)); },
    begin(deckId, value, options = {}) {
      const input = safe(value); object(input, ['expected_revision', 'deck_hash', 'card_id', 'student_response']); const deck = current(record(deckId, FORMAT)), key = retry(options, 'practice-answer'), requestHash = hash({ deck_id: deck.id, ...input });
      const existing = replay(ATTEMPT, key, requestHash); if (existing) return attemptView(existing, deck);
      exact(deck, input); const time = now(); monotonic(deck, time); const card = deck.data.cards.find(row => row.id === uuid(input.card_id));
      if (!card || deck.data.state !== 'active' || deck.data.active_attempt_id || card.schedule.due_at > time) fail('REVISION_CONFLICT');
      if (records(ATTEMPT).length >= 5000 || card.schedule.repetitions >= 9999) fail('BUDGET_EXCEEDED');
      const attemptId = randomUUID(); const result = store.commitWorkspaceBatch({ creates: [{ id: attemptId, kind: 'learning_checkpoint', title: deck.title, data: { format: ATTEMPT, deck_id: deck.id, deck_hash: deck.data.deck_hash, card_id: card.id, phase: 'answered', student_response: text(input.student_response, 6000), started_at: time, client_request_key: key, request_hash: requestHash } }], updates: [{ id: deck.id, expected_revision: deck.revision, data: { ...deck.data, active_attempt_id: attemptId, last_activity_at: time } }] });
      return attemptView(result.creates[0], result.updates[0]);
    },
    getAttempt(attemptId) { const attempt = record(attemptId, ATTEMPT); return attemptView(attempt, record(attempt.data.deck_id, FORMAT)); },
    reveal(attemptId, value) {
      const input = safe(value); object(input, ['expected_revision', 'deck_hash']); const attempt = record(attemptId, ATTEMPT), deck = current(record(attempt.data.deck_id, FORMAT));
      if (digest(input.deck_hash) !== deck.data.deck_hash || integer(input.expected_revision, 1, Number.MAX_SAFE_INTEGER) !== attempt.revision) fail('REVISION_CONFLICT');
      if (attempt.data.phase !== 'answered' || deck.data.active_attempt_id !== attempt.id) fail('REVISION_CONFLICT'); const time = now(); monotonic(deck, time);
      const saved = store.updateWorkspaceRecord(attempt.id, { expected_revision: attempt.revision, data: { ...attempt.data, phase: 'revealed', revealed_at: time } }); return attemptView(saved, deck);
    },
    rate(attemptId, value) {
      const input = safe(value); object(input, ['expected_revision', 'deck_revision', 'deck_hash', 'rating', 'reviewed_by_student']);
      if (!['again', 'hard', 'good', 'easy'].includes(input.rating) || input.reviewed_by_student !== true) fail('CONSENT_REQUIRED');
      const attempt = record(attemptId, ATTEMPT), deck = current(record(attempt.data.deck_id, FORMAT)); digest(input.deck_hash); integer(input.expected_revision, 1, Number.MAX_SAFE_INTEGER); integer(input.deck_revision, 1, Number.MAX_SAFE_INTEGER);
      const requestHash = hash(input);
      if (attempt.data.phase === 'rated' && attempt.data.rating_request_hash === requestHash) return attemptView(attempt, deck);
      if (attempt.data.phase !== 'revealed' || attempt.revision !== input.expected_revision || deck.revision !== input.deck_revision || deck.data.deck_hash !== input.deck_hash || deck.data.active_attempt_id !== attempt.id) fail('REVISION_CONFLICT');
      const time = now(); monotonic(deck, time); if (time < attempt.data.revealed_at) fail('REVISION_CONFLICT');
      const cards = deck.data.cards.map(card => card.id === attempt.data.card_id ? { ...card, schedule: schedule(card.schedule, input.rating, time) } : card); const next = cards.find(card => card.id === attempt.data.card_id).schedule;
      const receipt = { rating: input.rating, reviewed_by_student: true, student_id: store.identity.student_id, reviewed_at: time, next_due_at: next.due_at, interval_minutes: next.interval_minutes, rule: PRACTICE_RULE, mastery_claim: false };
      const result = store.commitWorkspaceBatch({ creates: [], updates: [{ id: deck.id, expected_revision: deck.revision, data: { ...deck.data, cards, active_attempt_id: null, last_activity_at: time } }, { id: attempt.id, expected_revision: attempt.revision, data: { ...attempt.data, phase: 'rated', receipt, rating_request_hash: requestHash } }] }); return attemptView(result.updates[1], result.updates[0]);
    },
    skip(attemptId, value) {
      const input = safe(value); object(input, ['expected_revision', 'deck_revision', 'deck_hash']); const attempt = record(attemptId, ATTEMPT), deck = current(record(attempt.data.deck_id, FORMAT));
      if (!['answered', 'revealed'].includes(attempt.data.phase) || attempt.revision !== integer(input.expected_revision, 1, Number.MAX_SAFE_INTEGER) || deck.revision !== integer(input.deck_revision, 1, Number.MAX_SAFE_INTEGER) || deck.data.deck_hash !== digest(input.deck_hash) || deck.data.active_attempt_id !== attempt.id) fail('REVISION_CONFLICT');
      const time = now(); monotonic(deck, time); const result = store.commitWorkspaceBatch({ creates: [], updates: [{ id: deck.id, expected_revision: deck.revision, data: { ...deck.data, active_attempt_id: null, last_activity_at: time } }, { id: attempt.id, expected_revision: attempt.revision, data: { ...attempt.data, phase: 'skipped', skipped_at: time } }] }); return attemptView(result.updates[1], result.updates[0]);
    },
    setState(deckId, value) {
      const input = safe(value); object(input, ['expected_revision', 'deck_hash', 'state']); const deck = current(record(deckId, FORMAT)); exact(deck, input);
      if (!['active', 'paused'].includes(input.state)) fail('INVALID_INPUT'); if (deck.data.active_attempt_id) fail('REVISION_CONFLICT'); const time = now(); monotonic(deck, time);
      return deckView(store.updateWorkspaceRecord(deck.id, { expected_revision: deck.revision, data: { ...deck.data, state: input.state, last_activity_at: time } }));
    },
    remove(deckId, value) {
      const input = safe(value); object(input, ['expected_revision']); const deck = record(deckId, FORMAT);
      store.deleteWorkspaceRecord(deck.id, integer(input.expected_revision, 1, Number.MAX_SAFE_INTEGER));
      return { deleted: true, retention: 'Removed from active practice. Private attempt history, document copies, database revisions and backups may retain this deck; physical erasure is not implemented.' };
    },
  };
}

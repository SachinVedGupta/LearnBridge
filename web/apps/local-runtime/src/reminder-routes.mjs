import { LearnBridgeError } from '@learnbridge/core';
import { HttpError } from './policy.mjs';

/** Host must authenticate origin, paired session and nonce, reject queries and recheck privateBody. */
export async function handleRemindersRoute({ route, method, privateBody, service, session, idempotencyKey, stillAuthorized }) {
  if (!route.startsWith('/reminders/')) return null;
  const authorize = () => {
    if (!session || typeof session.nonce !== 'string' || !session.nonce) throw new LearnBridgeError('AUTH_REQUIRED');
    stillAuthorized?.();
  };
  authorize();
  const body = async (allowed, required, limit = 12000) => { const value = await privateBody(allowed, required, limit); authorize(); return value; };
  const wrongMethod = () => { throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'This reminder operation is unavailable.'); };
  for (const [path, operation, envelope] of [['context', 'context', false], ['status', 'status', false], ['inbox', 'listInbox', true]]) {
    if (route === `/reminders/${path}`) { if (method !== 'GET') wrongMethod(); const result = service[operation](); return { status: 200, data: envelope ? { items: result } : result }; }
  }
  if (route === '/reminders/schedules') {
    if (method === 'GET') return { status: 200, data: { items: service.listSchedules() } };
    if (method !== 'POST') wrongMethod();
    const input = await body(['title', 'task_ids', 'timezone', 'due_within_minutes'], ['title', 'task_ids', 'timezone', 'due_within_minutes']);
    return { status: 201, data: { item: service.createSchedule(input, { idempotencyKey }) } };
  }
  if (route === '/reminders/check') {
    if (method !== 'POST') wrongMethod(); const input = await body(['confirmed'], ['confirmed'], 4096);
    if (input.confirmed !== true) throw new LearnBridgeError('CONSENT_REQUIRED');
    return { status: 200, data: service.drain() };
  }
  const match = /^\/reminders\/schedules\/([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\/(state|ack)$/i.exec(route);
  if (match) {
    if (method !== 'POST') wrongMethod();
    const keys = match[2] === 'state' ? ['expected_revision', 'state', 'confirmed'] : ['expected_revision', 'event_id'];
    const input = await body(keys, keys, 4096), operation = match[2] === 'state' ? 'setState' : 'acknowledge';
    return { status: 200, data: { item: service[operation](match[1], input) } };
  }
  throw new HttpError(404, 'NOT_FOUND', 'Local reminder operation not found.');
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { LearnBridgeError } from '../packages/core/src/index.mjs';
import { handleDynamicTaskAIRoute } from '../apps/local-runtime/src/dynamic-task-ai-routes.mjs';

const id = '5398d7f8-9500-43db-9a17-9d2cbd169793';
const call = (route, method, service, input = {}, extras = {}) => handleDynamicTaskAIRoute({ route, method, service, session: { nonce: 'paired-extraction-fixture' }, idempotencyKey: 'selected-extraction-fixture',
  privateBody: async (allowed, required, bound) => { assert.equal(bound, 16000); assert.deepEqual(allowed, required); assert.deepEqual(Object.keys(input).sort(), [...required].sort()); return input; }, ...extras });
test('DTAIR01: paired source extraction authority is required before any service or private-body access', async () => {
  let reads = 0; await assert.rejects(call('/dynamic-task-ai/extractions', 'POST', {}, {}, { session: null, privateBody: () => { reads++; } }), { code: 'AUTH_REQUIRED' }); assert.equal(reads, 0); assert.equal(await call('/other', 'GET', {}), null);
});
test('DTAIR02: exact metadata and preview/list routes dispatch only the selected supported source operations', async () => {
  const seen = [], service = { context() { return { sources: [] }; }, list() { return []; }, preview(input) { seen.push(input); return { selected: true }; }, get(value) { return { id: value }; } };
  assert.deepEqual((await call('/dynamic-task-ai/context', 'GET', service)).data, { sources: [] }); assert.deepEqual((await call('/dynamic-task-ai/extractions', 'GET', service)).data, { items: [] });
  const input = { source_id: id, source_revision: 1, source_hash: 'a'.repeat(64) }; assert.equal((await call('/dynamic-task-ai/preview', 'POST', service, input)).data.selected, true); assert.deepEqual(seen, [input]); assert.equal((await call(`/dynamic-task-ai/extractions/${id}`, 'GET', service)).data.item.id, id);
});
test('DTAIR03: normal source start receives the exact preview hash and a revocable authority closure; session loss during body blocks start', async () => {
  const input = { source_id: id, source_revision: 1, source_hash: 'a'.repeat(64), review_hash: 'b'.repeat(64), confirmed: true }; let calls = 0, allowed = true;
  const service = { async start(value, options) { calls++; assert.deepEqual(value, input); assert.equal(options.authorize(), true); return { id }; } };
  const response = await call('/dynamic-task-ai/extractions', 'POST', service, input); assert.equal(response.status, 202); assert.equal(calls, 1);
  await assert.rejects(call('/dynamic-task-ai/extractions', 'POST', service, input, { privateBody: async () => { allowed = false; return input; }, stillAuthorized: () => { if (!allowed) throw new LearnBridgeError('AUTH_REQUIRED'); } }), { code: 'AUTH_REQUIRED' }); assert.equal(calls, 1);
});
test('DTAIR04: collect cannot send commands/body instructions; unsupported provider/auth/complete paths reject before body reads', async () => {
  let reads = 0; for (const route of ['/dynamic-task-ai/send', '/dynamic-task-ai/auth', '/dynamic-task-ai/extractions?account=other', `/dynamic-task-ai/extractions/${id}/complete`, '/dynamic-task-ai/extractions/invalid/collect']) await assert.rejects(call(route, 'POST', {}, {}, { privateBody: () => { reads++; } }), error => error.status === 404);
  assert.equal(reads, 0); assert.equal((await call(`/dynamic-task-ai/extractions/${id}/collect`, 'POST', { collect(value) { assert.equal(value, id); return { tasks_created: 0 }; } })).data.tasks_created, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { handleCalendarExportRoute } from '../apps/local-runtime/src/calendar-export-routes.mjs';
const previewId = '5e8e72a7-783c-49be-b64a-2e86da59bfd2';
function fixture() {
  const calls = [], service = Object.fromEntries(['context', 'listPreviews', 'preview', 'getPreview', 'download'].map(name => [name, (...args) => { calls.push({ name, args }); return name === 'listPreviews' ? [] : { id: previewId }; }]));
  return { calls, service, session: { nonce: 'synthetic' }, stillAuthorized() { calls.push({ name: 'authorize' }); }, privateBody: async () => ({ mode: 'tasks', task_ids: [] }) };
}
test('CER01: exact routes dispatch allowed operations and forward their selected payload/key only', async () => {
  const f = fixture(); assert.equal(await handleCalendarExportRoute({ ...f, route: '/tasks', method: 'GET' }), null);
  for (const [route, method, operation] of [['/calendar-export/context', 'GET', 'context'], ['/calendar-export/previews', 'GET', 'listPreviews'], ['/calendar-export/previews', 'POST', 'preview'], [`/calendar-export/previews/${previewId}`, 'GET', 'getPreview'], [`/calendar-export/previews/${previewId}/download`, 'POST', 'download']]) {
    const result = await handleCalendarExportRoute({ ...f, route, method, idempotencyKey: 'calendar-route-key' }); assert.equal(result.status, operation === 'preview' ? 201 : 200); assert.equal(f.calls.at(-1).name, operation);
  }
  assert.deepEqual(f.calls.find(row => row.name === 'preview').args[1], { idempotencyKey: 'calendar-route-key' });
});
test('CER02: absence of exact browser session denies private reads and downloads', async () => {
  const f = fixture(); for (const session of [null, {}, { nonce: '' }, { nonce: 42 }]) await assert.rejects(handleCalendarExportRoute({ ...f, route: '/calendar-export/context', method: 'GET', session }), { code: 'AUTH_REQUIRED' }); assert.equal(f.calls.length, 0);
});
test('CER03: revoked session while selected body awaits blocks service mutation', async () => {
  const f = fixture(); let active = true; f.stillAuthorized = () => { if (!active) { const error = new Error(); error.code = 'AUTH_REQUIRED'; throw error; } }; f.privateBody = async () => { active = false; return {}; };
  await assert.rejects(handleCalendarExportRoute({ ...f, route: '/calendar-export/previews', method: 'POST' }), { code: 'AUTH_REQUIRED' }); assert.equal(f.calls.length, 0);
});
test('CER04: body-key gates enforce mode selection and exact review fields with bounded private payload', async () => {
  const f = fixture(), bodies = []; f.privateBody = async (...args) => { bodies.push(args); return {}; };
  await handleCalendarExportRoute({ ...f, route: '/calendar-export/previews', method: 'POST' }); assert.deepEqual(bodies[0], [['mode', 'task_ids', 'plan_id', 'expected_revision', 'plan_hash'], ['mode'], 12000]);
  await handleCalendarExportRoute({ ...f, route: `/calendar-export/previews/${previewId}/download`, method: 'POST' }); assert.deepEqual(bodies[1], [['expected_revision', 'review_hash', 'confirmed'], ['expected_revision', 'review_hash', 'confirmed'], 12000]);
});
test('CER05: unsupported route/method aliases and malformed IDs cannot execute calendar or source actions', async () => {
  const f = fixture(); for (const route of ['/calendar-export/send', '/calendar-export/provider-refresh', '/calendar-export/previews/not-an-id/download', `/calendar-export/previews/${previewId}/accept`, '/calendar-export/previews?token=canary']) await assert.rejects(handleCalendarExportRoute({ ...f, route, method: 'POST' }), { code: 'NOT_FOUND' });
  for (const [route, method] of [['/calendar-export/context', 'POST'], ['/calendar-export/previews', 'PATCH'], [`/calendar-export/previews/${previewId}/download`, 'GET']]) await assert.rejects(handleCalendarExportRoute({ ...f, route, method }), { code: 'METHOD_NOT_ALLOWED' }); assert.equal(f.calls.some(row => row.name !== 'authorize'), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'learnbridge-productivity-http-')), dataRoot = join(base, 'private'), runtimes = [];
  t.after(async () => { for (const runtime of runtimes.reverse()) await runtime.close(); await rm(base, { recursive: true, force: true }); });
  async function start() { const runtime = await startRuntime({ dataRoot, port: 0 }); runtimes.push(runtime); return runtime; }
  return { start, runtime: await start() };
}
async function pair(runtime) {
  const response = await fetch(`${runtime.origin}/api/local/v1/pair`, { method: 'POST', headers: { Origin: runtime.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: runtime.createPairingCode() }) });
  assert.equal(response.status, 200); return { nonce: (await response.json()).nonce, cookie: response.headers.get('set-cookie').split(';')[0] };
}
async function call(runtime, session, path, { method = 'GET', body, origin = runtime.origin, key } = {}) {
  const response = await fetch(`${runtime.origin}/api/local/v1${path}`, { method, headers: {
    ...(session ? { Cookie: session.cookie, 'X-LearnBridge-Nonce': session.nonce } : {}),
    ...(method === 'GET' ? {} : { Origin: origin, 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json() };
}
const update = () => ({ provider: 'gmail', account: 'chosen-fixture-account', source_id: 'fixture-message-1', subject: 'A chosen project update',
  observed_at: new Date(Date.now() - 60000).toISOString(), body: 'Could someone review this project next week?', section: 'projects' });

test('paired productivity HTTP completes selected briefing/export, reviewed task, ordered project and paused/manual reminder; restart preserves exact results', async t => {
  const { runtime, start } = await fixture(t); let session = await pair(runtime);
  const note = await call(runtime, session, '/documents', { method: 'POST', body: { title: 'Chosen note', content: 'A chosen project milestone needs review.' }, key: 'http-productivity-note' }); assert.equal(note.status, 201);
  const chosen = await call(runtime, session, '/productivity/updates', { method: 'POST', body: update(), key: 'http-productivity-update' }); assert.equal(chosen.status, 201);
  const sources = [{ kind: 'inbox', id: chosen.data.item.id, expected_revision: 1, section: 'projects' }, { kind: 'document', id: note.data.document.id, expected_revision: 1, section: 'academic' }];
  const briefing = await call(runtime, session, '/productivity/briefings', { method: 'POST', body: { title: 'Selected fixture briefing', sources, coverage: [] }, key: 'http-productivity-briefing' }); assert.equal(briefing.status, 201);
  let view = (await call(runtime, session, '/productivity/briefings')).data.items[0]; assert.equal(view.data.briefing.sections.find(s => s.section === 'news').status, 'unknown');
  const exportBody = { expected_revision: view.revision, export_hash: view.export_hash }, exported = await call(runtime, session, `/productivity/briefings/${briefing.data.item.id}/export`, { method: 'POST', body: exportBody }); assert.equal(exported.status, 200);
  assert.equal((await call(runtime, session, `/productivity/briefings/${briefing.data.item.id}/export`, { method: 'POST', body: exportBody })).data.document_id, exported.data.document_id);
  assert.match((await call(runtime, session, `/documents/${exported.data.document_id}`)).data.content, /No source selected/);
  assert.equal((await call(runtime, session, '/agent-grants')).data.items.length, 0);
  const proposal = await call(runtime, session, '/productivity/proposals', { method: 'POST', body: { title: 'Review chosen milestone', sources: [sources[0]],
    evidence: [{ source_index: 0, quote: 'Could someone review this project next week?' }], deadline: null, deadline_basis: 'unresolved', owner: null, dependencies: [] }, key: 'http-productivity-proposal' }); assert.equal(proposal.status, 201);
  view = (await call(runtime, session, '/productivity/proposals')).data.items[0]; const review = { expected_revision: 1, review_hash: view.review_hash };
  assert.equal((await call(runtime, session, `/productivity/proposals/${proposal.data.item.id}/accept`, { method: 'POST', body: review })).status, 200);
  assert.equal((await call(runtime, session, `/productivity/proposals/${proposal.data.item.id}/accept`, { method: 'POST', body: review })).status, 200);
  const project = await call(runtime, session, '/productivity/projects', { method: 'POST', body: { title: 'Fixture project', goal: 'Validate a selected project workflow.', resources: [], sources: [sources[0]],
    checklist: [{ id: 'read', title: 'Read the selected update', dependency_ids: [] }, { id: 'verify', title: 'Verify the result', dependency_ids: ['read'] }] }, key: 'http-productivity-project' }); assert.equal(project.status, 201);
  const path = `/productivity/projects/${project.data.item.id}/checklist`;
  assert.equal((await call(runtime, session, path, { method: 'POST', body: { expected_revision: 1, item_id: 'verify', completed: true } })).status, 409);
  assert.equal((await call(runtime, session, path, { method: 'POST', body: { expected_revision: 1, item_id: 'read', completed: true } })).status, 200);
  assert.equal((await call(runtime, session, path, { method: 'POST', body: { expected_revision: 2, item_id: 'verify', completed: true } })).status, 200);
  const reminder = await call(runtime, session, '/productivity/schedules', { method: 'POST', body: { title: 'Review selected updates', first_due_at: new Date(Date.now() - 60 * 60000).toISOString(), every_minutes: 15, timezone: 'UTC' }, key: 'http-productivity-reminder' }); assert.equal(reminder.status, 201);
  const reminderPath = `/productivity/schedules/${reminder.data.item.id}`;
  assert.equal((await call(runtime, session, `${reminderPath}/check`, { method: 'POST', body: { expected_revision: 1 } })).status, 403);
  const active = await call(runtime, session, `${reminderPath}/state`, { method: 'POST', body: { expected_revision: 1, state: 'active' } }); assert.equal(active.status, 200);
  const dueReview = { expected_revision: active.data.item.revision }, checked = await call(runtime, session, `${reminderPath}/check`, { method: 'POST', body: dueReview }); assert.equal(checked.status, 200);
  assert.equal(checked.data.item.data.missed_occurrences, 4); assert.equal((await call(runtime, session, `${reminderPath}/check`, { method: 'POST', body: dueReview })).status, 200);
  assert.equal((await call(runtime, session, '/tasks')).data.items.length, 2); assert.equal((await call(runtime, session, '/documents')).data.items.length, 2);
  await runtime.close(); const restarted = await start(); session = await pair(restarted);
  assert.equal((await call(restarted, session, '/productivity/proposals')).data.items[0].data.state, 'accepted');
  assert((await call(restarted, session, '/productivity/projects')).data.items[0].data.project.checklist.every(item => item.completed));
  assert.equal((await call(restarted, session, '/productivity/schedules')).data.items[0].data.deliveries.length, 1);
  assert.equal((await call(restarted, session, '/tasks')).data.items.length, 2); assert.equal((await call(restarted, session, '/documents')).data.items.length, 2);
});

test('productivity HTTP blocks stale sources, forged identity, unpaired/wrong nonce/cross-origin/query/credentials and external operations', async t => {
  const { runtime } = await fixture(t); assert.equal((await call(runtime, null, '/productivity/context')).status, 401); const session = await pair(runtime);
  assert.equal((await call(runtime, { ...session, nonce: 'wrong' }, '/productivity/context')).status, 403);
  assert.equal((await call(runtime, session, '/productivity/context?private=PRIVATE_QUERY_CANARY')).status, 400);
  const body = update();
  assert.equal((await call(runtime, session, '/productivity/updates', { method: 'POST', body, origin: 'https://hostile.invalid', key: randomUUID() })).status, 403);
  assert.equal((await call(runtime, session, '/productivity/updates', { method: 'POST', body: { ...body, student_id: randomUUID() }, key: randomUUID() })).status, 400);
  assert.equal((await call(runtime, session, '/productivity/updates', { method: 'POST', body: { ...body, source_url: 'https://mail.google.com/mail?token=PRIVATE_TOKEN_CANARY' }, key: randomUUID() })).status, 400);
  const chosen = await call(runtime, session, '/productivity/updates', { method: 'POST', body, key: 'http-stale-productivity-source' }); assert.equal(chosen.status, 201);
  const source = { kind: 'inbox', id: chosen.data.item.id, expected_revision: 1, section: 'projects' };
  const draft = await call(runtime, session, '/productivity/proposals', { method: 'POST', body: { title: 'Review this chosen update', sources: [source], evidence: [{ source_index: 0, quote: body.body }],
    deadline: null, deadline_basis: 'unresolved', owner: null, dependencies: [] }, key: 'http-stale-productivity-proposal' }); assert.equal(draft.status, 201);
  const view = (await call(runtime, session, '/productivity/proposals')).data.items[0];
  assert.equal((await call(runtime, session, '/productivity/updates', { method: 'POST', body: { ...body, body: 'Source changed.', expected_revision: 1 }, key: 'http-stale-productivity-edit' })).status, 201);
  assert.equal((await call(runtime, session, `/productivity/proposals/${draft.data.item.id}/accept`, { method: 'POST', body: { expected_revision: 1, review_hash: view.review_hash } })).status, 409);
  for (const path of ['/productivity/send', '/productivity/refresh-account', '/productivity/push', '/productivity/background-run']) assert.equal((await call(runtime, session, path, { method: 'POST', body: {} })).status, 404);
  assert.equal((await call(runtime, session, '/tasks')).data.items.length, 0);
  const ui = await readFile(new URL('../apps/local/public/productivity.js', import.meta.url), 'utf8');
  assert.doesNotMatch(ui, /innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function|localStorage|sessionStorage|\.style\.|fetch\(/);
  assert.match(ui, /caption\.htmlFor = input\.id/); assert.match(ui, /generation !== state\.generation/); assert.match(ui, /text = saved\.content/);
});

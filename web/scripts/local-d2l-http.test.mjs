import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { syntheticSchool } from './fixtures/d2l-test-support.mjs';

async function fixture(t, mode = 'normal') {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-d2l-http-')), root = join(parent, 'workspace');
  const school = syntheticSchool(join(parent, 'control.json'), mode); let runtime;
  t.after(async () => { await runtime?.close(); school.assertClosed(assert); rmSync(parent, { recursive: true, force: true }); });
  async function pair() {
    const origin = runtime.origin;
    const response = await fetch(origin + '/api/local/v1/pair', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: runtime.createPairingCode() }) });
    assert.equal(response.status, 200); const session = await response.json(), cookie = response.headers.get('set-cookie').split(';')[0];
    const call = async (path, body, method = body === undefined ? 'GET' : 'POST', headers = {}) => {
      const requestHeaders = { Cookie: cookie, Origin: origin, 'X-LearnBridge-Nonce': session.nonce,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers };
      for (const key of Object.keys(requestHeaders)) if (requestHeaders[key] === undefined) delete requestHeaders[key];
      const response = await fetch(origin + '/api/local/v1' + path, { method, headers: requestHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, data: await response.json() };
    }; return call;
  }
  async function restart(dataRoot = root) { await runtime?.close(); runtime = await startRuntime({ dataRoot, port: 0, d2lBrowserFactory: () => school.factory() }); return pair(); }
  function inspect(work = db => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]))) {
    const db = new Database(join(root, 'learnbridge.sqlite'), { readonly: true, fileMustExist: true }); try { return work(db); } finally { db.close(); }
  }
  return { parent, root, school, pair, restart, inspect, get origin() { return runtime.origin; }, close: () => runtime.close(), call: await restart() };
}
async function connect(f, call = f.call) {
  const open = await call('/d2l/start', { institution_id: 'mcmaster-avenue' }); assert.equal(open.status, 201, JSON.stringify(open.data));
  assert.equal(open.data.connection.state, 'awaiting_sign_in'); const id = open.data.connection.id;
  const verified = await call('/d2l/verify', { connection_id: id }); assert.equal(verified.status, 200, JSON.stringify(verified.data)); assert.equal(verified.data.connection.state, 'ready');
  return id;
}
async function preview(f, id, categories = ['assignments', 'announcements', 'materials'], call = f.call) {
  const value = await call('/d2l/preview', { connection_id: id, selected_course_ids: ['781264'], categories }); assert.equal(value.status, 200, JSON.stringify(value.data)); return value.data;
}
const save = (call, reviewed, review_hash = reviewed.refresh.review_hash) => call('/d2l/import', { preview_id: reviewed.preview_id, review_hash });

test('D2LH01: paired actual pipe + SQLite read/verify/review/save has selected scope, precise deadlines, honest coverage and no incidental writes', async t => {
  const f = await fixture(t), before = f.inspect();
  const status = await f.call('/d2l/status'); assert.equal(status.status, 200); assert.equal(status.data.connection, null); assert.equal(f.school.launches.length, 0);
  const id = await connect(f); assert.deepEqual(f.inspect(), before); assert.equal(f.school.reads.length, 2);
  const checked = (await f.call('/d2l/status')).data; assert.equal(checked.connection.proof, 'none');
  for (const canary of ['synthetic-student@example.test', 'SYNTHETIC_UNRETURNED_ID_CANARY', 'SYNTHETIC_UNRETURNED_PATH_CANARY']) assert.equal(JSON.stringify(checked).includes(canary), false);
  const reviewed = await preview(f, id); assert.equal(reviewed.proof, 'fixture'); assert.deepEqual(f.inspect(), before);
  assert.deepEqual(f.school.reads, ['/d2l/api/versions/', '/d2l/api/lp/1.49/users/whoami', '/d2l/api/lp/1.49/users/whoami',
    '/d2l/api/lp/1.49/courses/781264', '/d2l/api/le/1.85/781264/dropbox/folders/', '/d2l/api/le/1.85/781264/news/', '/d2l/api/le/1.85/781264/content/toc', '/d2l/api/lp/1.49/users/whoami']);
  assert.equal(reviewed.snapshot.assignments[0].deadline.precision, 'instant'); assert.equal(reviewed.snapshot.assignments[0].deadline.instant, '2026-10-16T03:59:00.000Z');
  assert.equal(reviewed.snapshot.announcements[0].body, '<p>Literal synthetic announcement.</p>');
  assert.equal(reviewed.snapshot.materials.find(item => item.source_id === 'topic:20').url, 'https://avenue.cllmcmaster.ca/d2l/le/content/781264/viewContent/20/View');
  assert.equal(reviewed.snapshot.coverage.assignments.state, 'partial'); assert.equal(reviewed.snapshot.coverage.materials.state, 'partial'); assert.equal(reviewed.snapshot.coverage.announcements.state, 'complete');
  const first = await save(f.call, reviewed); assert.equal(first.status, 201, JSON.stringify(first.data)); assert.equal(first.data.status, 'imported'); assert.deepEqual(first.data.snapshot.data.snapshot, reviewed.snapshot);
  const replay = await save(f.call, reviewed); assert.equal(replay.status, 201); assert.equal(replay.data.status, 'replayed'); assert.equal(replay.data.snapshot.id, first.data.snapshot.id);
  const rows = f.inspect(); assert.equal(rows.records.length, 0); assert.equal(rows.agent_grants.length, 0); assert.equal(rows.sources.length, 0); assert.equal(rows.workspace_records.filter(row => row.kind === 'profile').length, 0);
  const baseline = f.inspect(); const reads = f.school.reads.length;
  const disconnected = await f.call('/d2l/disconnect', { connection_id: id }); assert.equal(disconnected.status, 200); f.school.assertClosed(assert);
  assert.deepEqual(f.inspect(), baseline); assert.equal(f.school.reads.length, reads); assert.equal((await f.call('/courses')).data.items[0].id, first.data.snapshot.id);
});

test('D2LH02: unpaired, nonce, origin, method, query, arbitrary institution, raw cookies, unknown fields and excessive selections are rejected before school reads', async t => {
  const f = await fixture(t); const unpaired = await fetch(f.origin + '/api/local/v1/d2l/status'); assert.equal(unpaired.status, 401);
  assert.equal((await f.call('/d2l/start', { institution_id: 'mcmaster-avenue' }, 'POST', { Origin: 'https://outside.example' })).status, 403);
  assert.equal((await f.call('/d2l/start', { institution_id: 'mcmaster-avenue' }, 'POST', { 'X-LearnBridge-Nonce': 'wrong' })).status, 403);
  assert.equal((await f.call('/d2l/start')).status, 405); assert.equal((await f.call('/d2l/status?token=bad')).status, 400);
  assert.equal((await f.call('/d2l/start', { institution_id: 'https://outside.example' })).status, 501);
  assert.equal((await f.call('/d2l/start', { institution_id: 'mcmaster-avenue', cookies: 'PRIVATE_COOKIE_CANARY' })).status, 400);
  assert.equal(f.school.launches.length, 0); const id = await connect(f), before = f.school.reads.length;
  for (const body of [
    { connection_id: id, selected_course_ids: [], categories: ['materials'] },
    { connection_id: id, selected_course_ids: ['781264', '781264'], categories: ['materials'] },
    { connection_id: id, selected_course_ids: [781264], categories: ['materials'] },
    { connection_id: id, selected_course_ids: ['1','2','3','4','5','6'], categories: ['materials'] },
    { connection_id: id, selected_course_ids: ['781264'], categories: [] },
    { connection_id: id, selected_course_ids: ['781264'], categories: ['grades'] },
    { connection_id: id, selected_course_ids: ['781264'], categories: ['materials'], token: 'PRIVATE_TOKEN_CANARY' },
    { connection_id: id, selected_course_ids: ['781264'], categories: ['materials'], path: '/d2l/api/lp/1.49/enrollments/myenrollments/' },
  ]) assert.ok([400,413].includes((await f.call('/d2l/preview', body)).status));
  assert.equal(f.school.reads.length, before); assert.equal((await f.call('/d2l/import', { preview_id: randomUUID(), review_hash: 'f'.repeat(64) })).status, 403);
});

test('D2LH03: two paired browsers never share a school identity or retained review; selected categories remain unknown when not requested', async t => {
  const f = await fixture(t), id = await connect(f), other = await f.pair(), reviewed = await preview(f, id, ['assignments']);
  assert.equal(reviewed.snapshot.announcements.length, 0); assert.equal(reviewed.snapshot.materials.length, 0); assert.equal(reviewed.snapshot.coverage.announcements.state, 'unknown');
  assert.equal(f.school.reads.some(path => /news\/|content\/toc/.test(path)), false);
  assert.equal((await other('/d2l/status')).data.connection, null);
  assert.equal((await other('/d2l/verify', { connection_id: id })).status, 403); assert.equal((await save(other, reviewed)).status, 403);
  assert.equal((await other('/d2l/disconnect', { connection_id: id })).status, 403); assert.equal((await save(f.call, reviewed)).status, 201);
});

test('D2LH04: exact reviewed hash, current head and mutation policy reject forged or superseded saves without changing manual notes and tasks', async t => {
  const f = await fixture(t), id = await connect(f);
  const task = await f.call('/tasks', { title: 'Student-owned task' }), note = await f.call('/documents', { title: 'Student-owned note', content: 'Preserve exact manual text.' });
  const one = await preview(f, id), concurrent = await preview(f, id), baseline = f.inspect();
  assert.equal((await save(f.call, one, 'a'.repeat(64))).status, 409); assert.deepEqual(f.inspect(), baseline);
  assert.equal((await f.call('/d2l/import', { preview_id: one.preview_id, review_hash: one.refresh.review_hash, snapshot: one.snapshot })).status, 400);
  const first = await save(f.call, one); assert.equal(first.status, 201); assert.equal((await save(f.call, concurrent)).status, 409);
  f.school.change({ due: '2026-10-20T23:59:00-04:00' }); const changed = await preview(f, id); assert.equal(changed.refresh.changes.changed.length, 1);
  const next = await save(f.call, changed); assert.equal(next.status, 201); assert.equal(next.data.status, 'updated');
  assert.equal((await f.call(`/tasks/${task.data.id}`)).data.id, task.data.id); assert.deepEqual((await f.call(`/documents/${note.data.document.id}`)).data, note.data);
  assert.equal(f.inspect().agent_grants.length, 0);
});

test('D2LH05: provider permission denial is partial coverage, never an auth bypass or complete claim; expired school auth preserves local pairing', async t => {
  const f = await fixture(t), id = await connect(f); f.school.change({ partial: true }); const reviewed = await preview(f, id);
  assert.equal(reviewed.snapshot.coverage.announcements.state, 'partial'); assert.deepEqual(reviewed.snapshot.errors, [{ category: 'announcements', course_id: '781264', code: 'SCOPE_DENIED' }]);
  assert.equal(JSON.stringify(reviewed).includes('SYNTHETIC_SECRET_DIAGNOSTIC_CANARY'), false); assert.equal((await save(f.call, reviewed)).status, 201);
  f.school.change({ expired: true }); const expired = await f.call('/d2l/preview', { connection_id: id, selected_course_ids: ['781264'], categories: ['materials'] });
  assert.equal(expired.status, 409); assert.equal(expired.data.error.code, 'D2L_AUTH_EXPIRED'); assert.equal((await f.call('/status')).status, 200);
  assert.equal((await f.call('/d2l/status')).data.connection.state, 'awaiting_sign_in');
  f.school.change({ expired: false }); const stale = await f.call('/d2l/verify', { connection_id: id });
  assert.equal(stale.status, 409); assert.equal(stale.data.error.code, 'D2L_AUTH_REQUIRED');
  assert.equal((await f.call('/status')).status, 200);
  assert.equal((await f.call('/d2l/disconnect', { connection_id: id })).status, 200);
  const fresh = (await f.call('/d2l/start', { institution_id: 'mcmaster-avenue' })).data.connection.id;
  f.school.change({ denied: true }); const denied = await f.call('/d2l/verify', { connection_id: fresh }); assert.equal(denied.status, 403);
  assert.equal((await f.call('/d2l/status')).data.connection.state, 'permission_denied');
});

test('D2LH06: actual whoami account change locks the connection until disconnect, and cannot save an earlier account preview', async t => {
  const f = await fixture(t), id = await connect(f), reviewed = await preview(f, id); const before = f.inspect();
  f.school.change({ account: '99999' }); assert.equal((await f.call('/d2l/verify', { connection_id: id })).status, 403);
  const state = (await f.call('/d2l/status')).data.connection; assert.equal(state.state, 'account_changed'); assert.equal(state.account, null);
  f.school.change({ account: '12345' }); assert.equal((await f.call('/d2l/verify', { connection_id: id })).status, 403); assert.equal((await save(f.call, reviewed)).status, 403); assert.deepEqual(f.inspect(), before);
  assert.equal((await f.call('/d2l/disconnect', { connection_id: id })).status, 200); await connect(f);
});

test('D2LH07: logout during actual asynchronous identity verification closes the private pipe and cannot resurrect school ownership', async t => {
  const f = await fixture(t); const opened = await f.call('/d2l/start', { institution_id: 'mcmaster-avenue' }); f.school.change({ slowIdentity: true });
  const pending = f.call('/d2l/verify', { connection_id: opened.data.connection.id }); await f.school.waitRead(reads => reads.some(path => path.endsWith('/users/whoami')));
  assert.equal((await f.call('/logout', {})).status, 200); const late = await pending; assert.ok([401,409].includes(late.status)); f.school.assertClosed(assert);
  assert.equal((await f.call('/d2l/status')).status, 401); const newCall = await f.pair(); assert.equal((await newCall('/d2l/status')).data.connection, null); assert.equal(f.inspect().workspace_records.filter(row => row.kind === 'academicSnapshot').length, 0);
  f.school.change({ slowIdentity: false }); await connect(f, newCall);
});

test('D2LH08: logout during selected read destroys retained reviews and permits no late school snapshot or import', async t => {
  const f = await fixture(t), id = await connect(f), reviewed = await preview(f, id); f.school.change({ slowIdentity: true }); const identities = f.school.reads.filter(path => path.endsWith('/users/whoami')).length;
  const pending = f.call('/d2l/preview', { connection_id: id, selected_course_ids: ['781264'], categories: ['materials'] }); await f.school.waitRead(reads => reads.filter(path => path.endsWith('/users/whoami')).length > identities);
  assert.equal((await f.call('/logout', {})).status, 200); assert.ok([401,409].includes((await pending).status));
  const newCall = await f.pair(); assert.equal((await save(newCall, reviewed)).status, 403); assert.equal((await newCall('/d2l/status')).data.connection, null);
  assert.equal(f.inspect().workspace_records.filter(row => row.kind === 'academicSnapshot').length, 0); f.school.assertClosed(assert);
});

test('D2LH09: restart and real independently restored backup retain exact reviewed course records but no school session, secret profile or pending review', async t => {
  const f = await fixture(t), id = await connect(f), reviewed = await preview(f, id), accepted = await save(f.call, reviewed); assert.equal(accepted.status, 201);
  const pending = await preview(f, id); let call = await f.restart(); f.school.assertClosed(assert);
  assert.equal((await call('/d2l/status')).data.connection, null); assert.equal((await save(call, pending)).status, 403);
  assert.deepEqual((await call('/courses')).data.items[0].data.snapshot, reviewed.snapshot);
  await f.close(); const store = LocalStore.open({ root: f.root }); try { await store.backup(join(f.parent, 'backup')); } finally { store.close(); }
  const restored = join(f.parent, 'restored'); await LocalStore.restore({ backupRoot: join(f.parent, 'backup'), root: restored }); call = await f.restart(restored);
  assert.equal((await call('/d2l/status')).data.connection, null); assert.deepEqual((await call('/courses')).data.items[0].data.snapshot, reviewed.snapshot);
  // A backed-up DB contains reviewed source facts, not a cookie jar or Chrome profile.
  const db = readFileSync(join(f.parent, 'backup', 'learnbridge.sqlite')); assert.equal(db.includes(Buffer.from('Cookies')), false);
});

test('D2LH10: logout while the actual owned browser launch is pending cannot resurrect connection ownership under a new pairing', async t => {
  const f = await fixture(t); f.school.change({ slowStart: true }); const pending = f.call('/d2l/start', { institution_id: 'mcmaster-avenue' });
  await f.school.waitCommand(commands => commands.some(value => value.method === 'Target.createTarget'));
  assert.equal((await f.call('/logout', {})).status, 200); assert.ok([401,409].includes((await pending).status)); f.school.assertClosed(assert);
  const other = await f.pair(); assert.equal((await other('/d2l/status')).data.connection, null); f.school.change({ slowStart: false }); await connect(f, other);
  assert.equal(f.inspect().workspace_records.length, 0);
});

test('D2LH11: bounded retained previews reject pressure before another school read and saving a review frees one slot', async t => {
  const f = await fixture(t), id = await connect(f); const reviews = [];
  for (let count = 0; count < 10; count++) reviews.push(await preview(f, id, ['materials']));
  const before = f.school.reads.length; const pressure = await f.call('/d2l/preview', { connection_id: id, selected_course_ids: ['781264'], categories: ['materials'] });
  assert.equal(pressure.status, 429); assert.equal(f.school.reads.length, before); assert.equal(f.inspect().workspace_records.length, 0);
  assert.equal((await save(f.call, reviews[0])).status, 201); const fresh = await preview(f, id, ['materials']); assert.equal(fresh.refresh.content_changed, false);
  assert.equal((await save(f.call, fresh)).status, 201); assert.equal((await save(f.call, reviews[0])).status, 403);
});

test('D2LH12: normal paired browser GET without an Origin header remains authorized after asynchronous D2L routing', async t => {
  const f = await fixture(t); const headers = { Origin: undefined };
  assert.equal((await f.call('/d2l/status', undefined, 'GET', headers)).status, 200); assert.equal(f.school.launches.length, 0);
  const id = await connect(f); const current = await f.call('/d2l/status', undefined, 'GET', headers); assert.equal(current.status, 200); assert.equal(current.data.connection.id, id);
  assert.equal((await f.call('/status', undefined, 'GET', headers)).status, 200);
  assert.equal((await f.call('/d2l/verify', { connection_id: id }, 'POST', headers)).status, 403);
});

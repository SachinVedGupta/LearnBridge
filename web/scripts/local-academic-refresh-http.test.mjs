import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';
import { LocalStore } from '../packages/local-storage/src/index.mjs';

const time = minute => `2026-10-03T10:${String(minute).padStart(2, '0')}:00.000Z`;
const hiddenAssignmentBody = 'SYNTHETIC_ASSIGNMENT_BODY_CANARY: explain a base case in your own words. 🧠';
const hiddenMaterialBody = 'SYNTHETIC_MATERIAL_BODY_CANARY: a local handout to retain in reviewed history.';
function exported(minute = 0) {
  return {
    schema_version: 1,
    institution: { name: 'Synthetic University', origin: 'https://synthetic.example.edu', timezone: 'America/Toronto' },
    account_ref: 'synthetic-student', retrieved_at: time(minute),
    courses: [{ source_id: 'A', title: 'Synthetic algorithms', code: 'SYN101' }],
    assignments: [{ source_id: 'assignment-1', course_id: 'A', title: 'Recursion practice', description: hiddenAssignmentBody, due: '2026-10-10' }],
    announcements: [],
    materials: [{ source_id: 'lecture-1', course_id: 'A', title: 'Synthetic retained lecture', body: hiddenMaterialBody }],
    coverage: Object.fromEntries(['courses', 'assignments', 'announcements', 'materials'].map(category => [category, { state: 'complete' }])),
  };
}
async function fixture(t, options = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-academic-http-'));
  const root = join(parent, 'workspace'); let runtime;
  t.after(async () => { await runtime?.close(); rmSync(parent, { recursive: true, force: true }); });
  async function pair() {
    const response = await fetch(runtime.origin + '/api/local/v1/pair', {
      method: 'POST', headers: { Origin: runtime.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: runtime.createPairingCode() }),
    });
    assert.equal(response.status, 200);
    const session = await response.json(); const cookie = response.headers.get('set-cookie').split(';')[0];
    const origin = runtime.origin;
    return async (path, body, method = body === undefined ? 'GET' : 'POST', headers = {}) => {
      const result = await fetch(origin + '/api/local/v1' + path, {
        method,
        headers: { Cookie: cookie, Origin: origin, 'X-LearnBridge-Nonce': session.nonce,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: result.status, data: await result.json() };
    };
  }
  async function restart(dataRoot = root) {
    await runtime?.close(); runtime = await startRuntime({ dataRoot, port: 0, ...options }); return pair();
  }
  return { parent, root, pair, restart, close: () => runtime.close(), get origin() { return runtime.origin; }, call: await restart() };
}
async function preview(call, raw = exported()) {
  const result = await call('/academic/preview', { export: raw, selected_course_ids: ['A'] });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}
const accept = (call, reviewed) => call('/academic/library-import', { preview_id: reviewed.preview_id, review_hash: reviewed.refresh.review_hash });
const scope = saved => ({ snapshot_ids: [saved.snapshot.id], course_ids: ['A'] });

test('paired review saves exact course facts; retries and later unchanged observations retain one immutable version', async t => {
  const f = await fixture(t); const reviewed = await preview(f.call);
  assert.equal(reviewed.refresh.base.head_id, null); assert.equal(reviewed.refresh.content_changed, true);
  assert.equal(reviewed.refresh.changes.added.length, 3); assert.match(reviewed.refresh.review_hash, /^[a-f0-9]{64}$/);
  const first = await accept(f.call, reviewed); assert.equal(first.status, 201); assert.equal(first.data.status, 'imported');
  assert.deepEqual(first.data.snapshot.data.snapshot, reviewed.snapshot);
  assert.equal(first.data.receipt.verification, 'atomic_private_snapshot_head_readback');
  const replay = await accept(f.call, reviewed); assert.equal(replay.status, 201); assert.equal(replay.data.status, 'replayed');
  assert.equal(replay.data.snapshot.id, first.data.snapshot.id); assert.equal(replay.data.stream.observation_count, 1);
  const later = await preview(f.call, exported(1)); assert.equal(later.refresh.content_changed, false);
  assert.equal(later.refresh.changes.unchanged.length, 3); assert.equal(later.refresh.changes.changed.length, 0);
  const same = await accept(f.call, later); assert.equal(same.status, 201); assert.equal(same.data.status, 'unchanged');
  assert.equal(same.data.snapshot.id, first.data.snapshot.id); assert.equal(same.data.stream.snapshot_count, 1);
  assert.equal(same.data.stream.observation_count, 2);
  assert.equal(same.data.snapshot.data.snapshot.retrieved_at, time(0));
  assert.equal(same.data.stream.last_observation.reported_retrieved_at, time(1));
  const listed = await f.call('/courses'); assert.deepEqual(listed.data.items.map(item => item.id), [first.data.snapshot.id]);
  const streams = await f.call('/academic/streams'); assert.equal(streams.status, 200); assert.equal(streams.data.live_access, 'requires_auth');
  assert.equal(streams.data.items.length, 1); assert.equal(JSON.stringify(streams.data).includes(hiddenAssignmentBody), false);
});

test('changed deadlines and absent source facts are reviewable, preserve manual work, and require explicit historical body reads', async t => {
  const f = await fixture(t);
  const task = await f.call('/tasks', { title: 'Student-owned deadline override', deadline: { precision: 'date', date: '2026-10-20', timezone: 'America/Toronto' } });
  assert.equal(task.status, 201);
  const note = await f.call('/documents', { title: 'Student-owned notes', content: 'Synthetic manual note. Keep me intact.' }); assert.equal(note.status, 201);
  const noteId = note.data.document.id;
  const first = (await accept(f.call, await preview(f.call))).data;
  const next = exported(1); next.assignments[0].due = '2026-10-12'; next.materials = [];
  next.coverage.materials = { state: 'unavailable' }; next.errors = [{ category: 'materials', code: 'PROVIDER_FAILURE' }];
  const reviewed = await preview(f.call, next);
  assert.equal(reviewed.refresh.changes.changed.length, 1); assert.equal(reviewed.refresh.changes.not_returned.length, 1);
  const changed = reviewed.refresh.changes.changed[0]; assert.equal(changed.category, 'assignments');
  assert.equal(changed.before.deadline.date, '2026-10-10'); assert.equal(changed.after.deadline.date, '2026-10-12');
  assert.notEqual(changed.before.source_hash, changed.after.source_hash);
  const missing = reviewed.refresh.changes.not_returned[0]; assert.equal(missing.category, 'materials');
  assert.equal(missing.reason, 'not_seen_in_this_export'); assert.equal(missing.coverage_state, 'partial'); assert.equal(missing.after, null);
  assert.deepEqual(reviewed.snapshot.errors, [{ category: 'materials', code: 'PROVIDER_FAILURE' }]);
  assert.match(reviewed.notice, /do not delete tasks/);
  const saved = await accept(f.call, reviewed); assert.equal(saved.status, 201); assert.equal(saved.data.status, 'updated');
  assert.notEqual(saved.data.snapshot.id, first.snapshot.id);
  const current = await f.call('/courses'); assert.deepEqual(current.data.items.map(item => item.id), [saved.data.snapshot.id]);
  const noOldMaterial = await f.call('/courses/search', { ...scope(saved.data), query: 'SYNTHETIC_MATERIAL_BODY_CANARY' });
  assert.equal(noOldMaterial.status, 200); assert.equal(noOldMaterial.data.results.length, 0);
  assert.equal((await f.call('/courses/search', { ...scope(first), query: 'base case' })).status, 403);
  const historyPath = `/academic/streams/${saved.data.stream.id}/history`;
  const history = await f.call(historyPath); assert.equal(history.status, 200); assert.equal(history.data.items.length, 2);
  assert.equal(history.data.items.filter(item => item.status === 'historical').length, 1);
  assert.equal(JSON.stringify(history.data).includes(hiddenMaterialBody), false);
  assert.equal(JSON.stringify(history.data).includes(hiddenAssignmentBody), false);
  assert.ok(history.data.items.every(item => !Object.hasOwn(item, 'snapshot')));
  const explicit = await f.call(historyPath + '/' + first.snapshot.id);
  assert.equal(explicit.status, 200); assert.equal(explicit.data.item.status, 'historical');
  assert.deepEqual(explicit.data.item.snapshot, first.snapshot.data.snapshot); assert.match(explicit.data.notice, /excluded from current search and tutoring/);
  assert.equal((await f.call(historyPath + '/' + randomUUID())).status, 403);
  assert.deepEqual((await f.call('/tasks/' + task.data.task.id)).data.task, task.data.task);
  assert.deepEqual((await f.call('/documents/' + noteId)).data, note.data);
  assert.equal((await f.call('/agent-grants')).data.items.length, 0);
});

test('HTTP rejects missing and forged review hashes or added authority fields before any course publication', async t => {
  const f = await fixture(t); const reviewed = await preview(f.call);
  const missing = await f.call('/academic/library-import', { preview_id: reviewed.preview_id });
  assert.equal(missing.status, 400); assert.equal(missing.data.error.code, 'INVALID_INPUT');
  const malformed = await f.call('/academic/library-import', { preview_id: reviewed.preview_id, review_hash: 'not-a-hash' });
  assert.equal(malformed.status, 400); assert.equal(malformed.data.error.code, 'INVALID_INPUT');
  const forged = await f.call('/academic/library-import', { preview_id: reviewed.preview_id, review_hash: 'a'.repeat(64) });
  assert.equal(forged.status, 409); assert.equal(forged.data.error.code, 'REVISION_CONFLICT');
  const bodyAuthority = await f.call('/academic/library-import', { preview_id: reviewed.preview_id, review_hash: reviewed.refresh.review_hash, expected_head_revision: 999, snapshot: reviewed.snapshot });
  assert.equal(bodyAuthority.status, 400); assert.equal(bodyAuthority.data.error.code, 'INVALID_INPUT');
  assert.equal((await f.call('/courses')).data.items.length, 0); assert.equal((await f.call('/academic/streams')).data.items.length, 0);
  assert.equal((await accept(f.call, reviewed)).status, 201);
});

test('competing first imports and changed refreshes fail stale HTTP compare-and-swap without an extra history version', async t => {
  const f = await fixture(t); const firstA = await preview(f.call); const firstB = await preview(f.call, exported(1));
  const initial = await accept(f.call, firstA); assert.equal(initial.status, 201);
  const staleFirst = await accept(f.call, firstB); assert.equal(staleFirst.status, 409); assert.equal(staleFirst.data.error.code, 'REVISION_CONFLICT');
  const rawA = exported(2); rawA.assignments[0].due = '2026-10-13';
  const rawB = exported(3); rawB.assignments[0].due = '2026-10-14';
  const changedA = await preview(f.call, rawA); const changedB = await preview(f.call, rawB);
  assert.equal(changedA.refresh.base.revision, changedB.refresh.base.revision);
  const saved = await accept(f.call, changedA); assert.equal(saved.status, 201);
  const staleChanged = await accept(f.call, changedB); assert.equal(staleChanged.status, 409); assert.equal(staleChanged.data.error.code, 'REVISION_CONFLICT');
  const history = await f.call(`/academic/streams/${saved.data.stream.id}/history`);
  assert.equal(history.data.items.length, 2); assert.equal(history.data.observations.length, 2);
  assert.deepEqual((await f.call('/courses')).data.items.map(item => item.id), [saved.data.snapshot.id]);
  const refreshed = await preview(f.call, rawB); assert.equal(refreshed.refresh.base.revision, saved.data.stream.revision);
  assert.equal((await accept(f.call, refreshed)).data.stream.snapshot_count, 3);
});

test('new refresh and history surfaces require pairing; previews are bound to one nonce and cannot survive logout or restart', async t => {
  const f = await fixture(t); const reviewed = await preview(f.call); const other = await f.pair();
  const wrongSession = await accept(other, reviewed); assert.equal(wrongSession.status, 403); assert.equal(wrongSession.data.error.code, 'CONSENT_REQUIRED');
  const noNonce = await f.call('/academic/preview', { export: exported(), selected_course_ids: ['A'] }, 'POST', { 'X-LearnBridge-Nonce': '' });
  assert.equal(noNonce.status, 403);
  for (const path of ['/academic/streams', `/academic/streams/${randomUUID()}/history`, `/academic/streams/${randomUUID()}/history/${randomUUID()}`]) {
    const response = await fetch(f.origin + '/api/local/v1' + path, { headers: { Origin: f.origin } });
    assert.equal(response.status, 401); const result = await response.json(); assert.equal(result.error.code, 'AUTH_REQUIRED');
    assert.equal(JSON.stringify(result).includes(hiddenAssignmentBody), false);
  }
  assert.equal((await f.call('/logout', {})).status, 200);
  assert.equal((await accept(f.call, reviewed)).status, 401);
  assert.equal((await accept(other, reviewed)).status, 403);
  const restarted = await f.restart(); const gone = await accept(restarted, reviewed);
  assert.equal(gone.status, 403); assert.equal(gone.data.error.code, 'CONSENT_REQUIRED');
  assert.equal((await restarted('/courses')).data.items.length, 0);
});

test('managed forget requires snapshot and current stream revisions, hides historical bodies, and fresh review explicitly reactivates', async t => {
  const f = await fixture(t); const first = (await accept(f.call, await preview(f.call))).data;
  const raw = exported(1); raw.assignments[0].due = '2026-10-12';
  const reviewed = await preview(f.call, raw); const current = (await accept(f.call, reviewed)).data;
  const path = '/courses/' + current.snapshot.id;
  const missing = await f.call(path, { expected_revision: current.snapshot.revision }, 'DELETE');
  assert.equal(missing.status, 409); assert.equal(missing.data.error.code, 'REVISION_CONFLICT');
  const staleStream = await f.call(path, { expected_revision: current.snapshot.revision, expected_stream_revision: first.stream.revision }, 'DELETE');
  assert.equal(staleStream.status, 409);
  const staleSnapshot = await f.call(path, { expected_revision: current.snapshot.revision + 1, expected_stream_revision: current.stream.revision }, 'DELETE');
  assert.equal(staleSnapshot.status, 409);
  assert.equal((await f.call(path, { expected_revision: current.snapshot.revision, expected_stream_revision: current.stream.revision }, 'DELETE')).status, 200);
  assert.equal((await f.call('/courses')).data.items.length, 0); assert.equal((await f.call('/academic/streams')).data.items.length, 0);
  assert.equal((await f.call('/courses/search', { ...scope(current), query: 'base case' })).status, 403);
  const history = `/academic/streams/${current.stream.id}/history`;
  for (const historyPath of [history, history + '/' + first.snapshot.id, history + '/' + current.snapshot.id]) {
    const denied = await f.call(historyPath); assert.equal(denied.status, 403); assert.equal(denied.data.error.code, 'CONSENT_REQUIRED');
    assert.equal(JSON.stringify(denied.data).includes(hiddenAssignmentBody), false);
  }
  assert.equal((await accept(f.call, reviewed)).status, 409);
  raw.retrieved_at = time(2); const restored = await accept(f.call, await preview(f.call, raw));
  assert.equal(restored.status, 201); assert.equal(restored.data.status, 'unchanged');
  assert.equal(restored.data.snapshot.id, current.snapshot.id); assert.equal(restored.data.stream.snapshot_count, 2);
  assert.equal((await f.call('/courses')).data.items.length, 1); assert.equal((await f.call(history)).status, 200);
});

test('paired readbacks remain exact across runtime restart and independently restored backup; previews do not carry into a new runtime', async t => {
  const f = await fixture(t); let call = f.call; const original = await preview(call);
  const first = (await accept(call, original)).data;
  const raw = exported(1); raw.assignments[0].due = '2026-10-18';
  const second = (await accept(call, await preview(call, raw))).data;
  const historyPath = `/academic/streams/${second.stream.id}/history`;
  const expectedHistory = (await call(historyPath)).data;
  const expectedSnapshot = (await call(historyPath + '/' + first.snapshot.id)).data;
  const expectedCurrent = (await call('/courses')).data;
  call = await f.restart();
  assert.deepEqual((await call(historyPath)).data, expectedHistory);
  assert.deepEqual((await call(historyPath + '/' + first.snapshot.id)).data, expectedSnapshot);
  assert.deepEqual((await call('/courses')).data, expectedCurrent);
  assert.equal((await accept(call, original)).status, 403);
  await f.close();
  const saved = LocalStore.open({ root: f.root });
  try { await saved.backup(join(f.parent, 'backup')); } finally { saved.close(); }
  const restored = join(f.parent, 'restored');
  await LocalStore.restore({ backupRoot: join(f.parent, 'backup'), root: restored });
  call = await f.restart(restored);
  assert.deepEqual((await call(historyPath)).data, expectedHistory);
  assert.deepEqual((await call(historyPath + '/' + first.snapshot.id)).data, expectedSnapshot);
  assert.deepEqual((await call('/courses')).data, expectedCurrent);
  assert.equal((await call('/agent-grants')).data.items.length, 0);
});

test('successful review cycles reclaim consumed preview capacity without evicting pending reviews or duplicating observations', async t => {
  const f = await fixture(t);
  const task = await f.call('/tasks', { title: 'Synthetic manual task survives preview pressure', effort_minutes: 35 });
  assert.equal(task.status, 201);
  let firstPreview; let latestPreview; let saved;
  for (let minute = 0; minute < 12; minute++) {
    latestPreview = await preview(f.call, exported(minute)); firstPreview ??= latestPreview;
    const accepted = await accept(f.call, latestPreview);
    assert.equal(accepted.status, 201, JSON.stringify(accepted.data));
    assert.equal(accepted.data.status, minute === 0 ? 'imported' : 'unchanged');
    if (saved) assert.equal(accepted.data.snapshot.id, saved.snapshot.id);
    saved = accepted.data;
    assert.equal(saved.stream.observation_count, minute + 1); assert.equal(saved.stream.snapshot_count, 1);
    if (minute === 0) {
      const stillCached = await accept(f.call, latestPreview);
      assert.equal(stillCached.status, 201); assert.equal(stillCached.data.status, 'replayed');
      assert.equal(stillCached.data.stream.observation_count, 1);
    }
  }
  const latestRetry = await accept(f.call, latestPreview);
  assert.equal(latestRetry.status, 201); assert.equal(latestRetry.data.status, 'replayed');
  assert.equal(latestRetry.data.stream.observation_count, 12);
  const evicted = await accept(f.call, firstPreview);
  assert.equal(evicted.status, 403); assert.equal(evicted.data.error.code, 'CONSENT_REQUIRED');
  assert.equal((await f.call('/academic/streams')).data.items[0].observation_count, 12);
  assert.deepEqual((await f.call('/courses')).data.items.map(item => item.id), [saved.snapshot.id]);
  assert.deepEqual((await f.call('/tasks/' + task.data.task.id)).data.task, task.data.task);

  const pending = [];
  for (let minute = 20; minute < 30; minute++) pending.push(await preview(f.call, exported(minute)));
  const refused = await f.call('/academic/preview', { export: exported(30), selected_course_ids: ['A'] });
  assert.equal(refused.status, 429); assert.equal(refused.data.error.code, 'RATE_LIMITED');
  assert.equal((await f.call('/academic/streams')).data.items[0].observation_count, 12);
  const oldestPending = await accept(f.call, pending[0]);
  assert.equal(oldestPending.status, 201); assert.equal(oldestPending.data.status, 'unchanged');
  assert.equal(oldestPending.data.stream.observation_count, 13);
  assert.equal(oldestPending.data.stream.snapshot_count, 1);
  assert.equal((await preview(f.call, exported(30))).refresh.base.revision, oldestPending.data.stream.revision);
  assert.equal((await accept(f.call, pending[0])).status, 403);
  assert.deepEqual((await f.call('/tasks/' + task.data.task.id)).data.task, task.data.task);
  assert.equal((await f.call('/documents')).data.items.length, 0);
  assert.equal((await f.call('/agent-grants')).data.items.length, 0);
});

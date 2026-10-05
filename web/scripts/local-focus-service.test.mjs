import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { createFocusService, FOCUS_LIMITS } from '../apps/local-runtime/src/focus-service.mjs';
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'learnbridge-focus-')), root = join(base, 'private'); let store = LocalStore.open({ root, timezone: 'America/Toronto' }), wall = Date.parse('2026-10-04T16:00:00.000Z'), monotonic = 10000;
  const clock = () => wall, monotonicClock = () => monotonic; let service = createFocusService({ store, clock, monotonicClock });
  t.after(() => { service.dispose(); try { store.close(); } catch {} rmSync(base, { recursive: true, force: true }); });
  return { root, get store() { return store; }, get service() { return service; }, advance(ms, monoMs = ms) { wall += ms; monotonic += monoMs; }, elapsed(ms) { for (let remaining = ms; remaining > 0;) { const chunk = Math.min(30000, remaining); wall += chunk; monotonic += chunk; service.observe(); remaining -= chunk; } },
    restart(downtime = 0, graceful = false) { if (graceful) service.dispose(); store.close(); wall += downtime; monotonic = 100; store = LocalStore.open({ root, timezone: 'America/Toronto' }); service = createFocusService({ store, clock, monotonicClock }); } };
}
const body = { title: 'Synthetic focused study', planned_minutes: 25, timezone: 'America/Toronto', confirmed: true };
const start = (f, key = 'focus-start-synthetic', extra = {}) => f.service.start({ ...body, ...extra }, { idempotencyKey: key });
const review = row => ({ expected_revision: row.revision, session_hash: row.session_hash, confirmed: true });
const code = (fn, error) => assert.throws(fn, { code: error });

test('FS01: 25-minute intention with10 running/5 paused/10 running records exactly20 minutes and one end receipt', t => {
  const f = fixture(t), initial = start(f); assert.equal(initial.data.observed_active_ms, 0); f.elapsed(600000); let row = f.service.get(initial.id); const paused = f.service.pause(row.id, review(row)); f.advance(300000); assert.equal(f.service.get(row.id).data.observed_active_ms, 600000);
  row = f.service.resume(paused.id, review(paused)); f.elapsed(600000); row = f.service.get(row.id); const completed = f.service.end(row.id, review(row)); assert.equal(completed.data.observed_active_ms, 1200000); assert.equal(completed.data.planned_minutes, 25); assert.equal(completed.data.state, 'completed'); assert.equal(f.service.end(row.id, review(row)).revision, completed.revision); assert.equal(f.service.context().open_session, null); assert.equal(f.store.listTasks().length, 0);
});
test('FS02: eight-hour observed sleep gap is wholly excluded, interrupts timer and needs exact recovery review', t => {
  const f = fixture(t), initial = start(f); f.elapsed(60000); f.advance(8 * 3600000); assert.equal(f.service.get(initial.id).needs_recovery, true); assert.equal(f.service.get(initial.id).pending_interval_ms, 0); f.service.observe(); let row = f.service.get(initial.id); assert.equal(row.data.state, 'interrupted'); assert.equal(row.data.observed_active_ms, 60000); assert.equal(row.data.last_gap.reason, 'long_unobserved_gap');
  row = f.service.resume(row.id, review(row)); f.elapsed(30000); assert.equal(f.service.get(row.id).data.observed_active_ms, 90000); assert.equal(f.service.get(row.id).needs_recovery, false);
});
test('FS03: first end/pause after an unobserved gap excludes it; a separate reviewed end is required', t => {
  for (const operation of ['end', 'pause']) { const f = fixture(t), row = start(f); f.advance(120000); const recovered = f.service[operation](row.id, review(row)); assert.equal(recovered.data.state, 'interrupted'); assert.equal(recovered.data.observed_active_ms, 0); assert.equal(recovered.data.last_receipt.outcome, 'gap_excluded_requires_review'); assert.equal(f.service[operation](row.id, review(row)).revision, recovered.revision); assert.equal(f.service.end(row.id, review(recovered)).data.state, 'completed'); }
});
test('FS04: ungraceful restart excludes downtime and unpersisted intervals, preserves prior observations and never auto resumes', t => {
  const f = fixture(t), row = start(f); f.elapsed(60000); f.advance(2000); f.restart(8 * 3600000); const resumed = f.service.get(row.id); assert.equal(resumed.data.state, 'interrupted'); assert.equal(resumed.data.observed_active_ms, 60000); assert.equal(resumed.pending_interval_ms, 0); assert.equal(resumed.data.last_gap.reason, 'runtime_restarted'); f.service.observe(); assert.equal(f.service.get(row.id).data.observed_active_ms, 60000);
});
test('FS05: graceful stop persists bounded final interval, interrupts, clears anchor and is idempotent', t => {
  const f = fixture(t), row = start(f); f.advance(2000); assert.deepEqual(f.service.dispose(), { persisted: true }); assert.deepEqual(f.service.dispose(), { persisted: true }); code(() => f.service.observe(), 'OFFLINE'); f.restart(3600000); const recovered = f.service.get(row.id); assert.equal(recovered.data.observed_active_ms, 2000); assert.equal(recovered.data.state, 'interrupted'); assert.equal(recovered.data.last_gap.reason, 'runtime_stopped');
});
test('FS06: wall/monotonic rollback or large wall-only/monotonic-only gaps award no time', t => {
  for (const [wall, monotonic, reason] of [[-1000, 30000, 'clock_rollback'], [30000, -1000, 'clock_rollback'], [8 * 3600000, 30000, 'long_unobserved_gap'], [30000, 8 * 3600000, 'long_unobserved_gap']]) { const f = fixture(t), row = start(f); f.advance(wall, monotonic); f.service.observe(); const result = f.service.get(row.id); assert.equal(result.data.observed_active_ms, 0); assert.equal(result.data.state, 'interrupted'); assert.equal(result.data.last_gap.reason, reason); }
});
test('FS07: one open session, exact start retry, changed key payload and duplicate terminal operations remain controlled', t => {
  const f = fixture(t), row = start(f); assert.equal(start(f).id, row.id); code(() => start(f, 'focus-other-start'), 'REVISION_CONFLICT'); code(() => start(f, 'focus-start-synthetic', { title: 'Different intention' }), 'REVISION_CONFLICT'); const paused = f.service.pause(row.id, review(row)); code(() => start(f, 'focus-after-paused'), 'REVISION_CONFLICT'); const ended = f.service.end(row.id, review(paused)); assert.equal(f.service.end(row.id, review(paused)).revision, ended.revision); const next = start(f, 'focus-after-ended'); assert.notEqual(next.id, row.id); assert.equal(f.service.list().length, 2);
});
test('FS08: current hash/revision/human approval deny stale or injected transitions without crediting time', t => {
  const f = fixture(t), row = start(f); for (const input of [{ ...review(row), confirmed: false }, { ...review(row), session_hash: 'a'.repeat(64) }, { ...review(row), expected_revision: 77 }, { ...review(row), auto_complete_task: true }]) code(() => f.service.end(row.id, input), input.confirmed === false ? 'CONSENT_REQUIRED' : input.auto_complete_task ? 'INVALID_INPUT' : 'REVISION_CONFLICT'); f.advance(30000); f.service.observe(); code(() => f.service.pause(row.id, review(row)), 'REVISION_CONFLICT'); assert.equal(f.service.get(row.id).data.state, 'running');
});
test('FS09: source task association never changes/completes task and reports edited/deleted linkage honestly', t => {
  const f = fixture(t), task = f.store.createTask({ title: 'Student task' }), row = start(f, 'focus-associated-task', { task_id: task.id }); f.advance(2000); const ended = f.service.end(row.id, review(row)); assert.equal(ended.data.observed_active_ms, 2000); assert.deepEqual(f.store.getTask(task.id), task); f.store.deleteTask(task.id, task.revision); assert.equal(f.service.get(row.id).task_changed, true); code(() => start(f, 'focus-missing-task', { task_id: randomUUID() }), 'SCOPE_DENIED');
});
test('FS10: discarded history stays labelled, clears open state and never becomes completed credit', t => {
  const f = fixture(t), row = start(f); f.advance(2000); const discarded = f.service.discard(row.id, review(row)); assert.equal(discarded.data.state, 'discarded'); assert.equal(discarded.data.observed_active_ms, 2000); assert.equal(f.service.context().open_session, null); assert.equal(f.service.discard(row.id, review(row)).revision, discarded.revision); assert.equal(f.service.list().filter(item => item.data.state === 'completed').length, 0);
});
test('FS11: read-only refresh neither commits per-second observations nor auto ends a planned timer', t => {
  const f = fixture(t), row = start(f); f.advance(500); for (let i = 0; i < 5; i++) { assert.equal(f.service.get(row.id).revision, 1); f.service.context(); } assert.equal(f.service.observe().sampled, 0); assert.equal(f.service.get(row.id).revision, 1); f.elapsed(26 * 60000); const current = f.service.get(row.id); assert.equal(current.data.state, 'running'); assert.equal(current.data.observed_active_ms, 26 * 60000 + 500); assert.equal(current.data.observations.length, 50);
});
test('FS12: timezone/DST changes affect labels only, not actual observed milliseconds or prior timestamps', t => {
  const f = fixture(t), row = start(f, 'focus-toronto-dst', { timezone: 'America/Toronto' }); f.advance(2000); const ended = f.service.end(row.id, review(row)); const later = start(f, 'focus-new-timezone', { timezone: 'Asia/Kolkata' }); assert.equal(f.service.get(ended.id).data.timezone, 'America/Toronto'); assert.equal(f.service.get(ended.id).data.observed_active_ms, 2000); assert.equal(f.service.get(ended.id).data.started_at, row.data.started_at); assert.equal(later.data.timezone, 'Asia/Kolkata');
});
test('FS13: actual SQLite failed observation/transition does not lose anchor or return a false success', t => {
  const f = fixture(t), row = start(f), db = new Database(join(f.root, 'learnbridge.sqlite')); db.exec("CREATE TRIGGER fail_focus_write BEFORE UPDATE ON workspace_records BEGIN SELECT RAISE(ABORT, 'synthetic'); END"); f.advance(30000); code(() => f.service.observe(), 'PROVIDER_FAILURE'); assert.equal(f.service.get(row.id).data.observed_active_ms, 0); assert.equal(f.service.get(row.id).pending_interval_ms, 30000); code(() => f.service.pause(row.id, review(row)), 'PROVIDER_FAILURE'); db.exec('DROP TRIGGER fail_focus_write'); db.close(); const paused = f.service.pause(row.id, review(row)); assert.equal(paused.data.observed_active_ms, 30000); assert.equal(paused.data.state, 'paused');
});
test('FS14: strict bounds/getters/timezone/retention and non-timer routine separation', t => {
  const f = fixture(t), malicious = { ...body }; Object.defineProperty(malicious, 'title', { get() { throw new Error('must not run'); }, enumerable: true }); code(() => f.service.start(malicious, { idempotencyKey: 'focus-malicious' }), 'INVALID_INPUT'); code(() => start(f, 'focus-invalid-zone', { timezone: 'Unknown/Zone' }), 'INVALID_INPUT'); code(() => start(f, 'focus-invalid-min', { planned_minutes: 241 }), 'INVALID_INPUT');
  f.store.createWorkspaceRecord({ kind: 'routine', title: 'Other life routine', data: { format: 'routine', routine: { title: 'Not a focus timer' } } }); assert.equal(f.service.list().length, 0);
  for (let i = 0; i < FOCUS_LIMITS.retained_sessions; i++) { const row = start(f, `focus-retention-${i}`); f.service.discard(row.id, review(row)); } code(() => start(f, 'focus-retention-next'), 'BUDGET_EXCEEDED'); assert.equal(f.service.list().length, 200);
});

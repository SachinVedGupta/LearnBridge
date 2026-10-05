import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { createReminderService, classifyReminderDeadline, REMINDER_LIMITS } from '../apps/local-runtime/src/reminder-service.mjs';

const NOW = '2026-10-04T16:00:00.000Z';
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'learnbridge-reminders-')), root = join(base, 'private'); let store = LocalStore.open({ root, timezone: 'America/Toronto' }), current = NOW;
  const clock = () => current; let service = createReminderService({ store, clock });
  t.after(() => { try { service.dispose(); store.close(); } catch {} rmSync(base, { force: true, recursive: true }); });
  return { base, root, get store() { return store; }, get service() { return service; }, clock,
    at(value) { current = value; }, restart() { service.dispose(); store.close(); store = LocalStore.open({ root, timezone: 'America/Toronto' }); service = createReminderService({ store, clock }); } };
}
const task = (f, patch = {}) => f.store.createTask({ title: 'Selected study task', deadline: { precision: 'instant', instant: '2026-10-04T17:00:00.000Z', timezone: 'America/Toronto' }, ...patch });
const input = saved => ({ title: 'Selected task due reminders', task_ids: [saved.id], timezone: 'America/Toronto', due_within_minutes: 1440 });
const create = (f, saved, key = 'reminder-fixture-key') => f.service.createSchedule(input(saved), { idempotencyKey: key });
const active = (f, row) => f.service.setState(row.id, { expected_revision: row.revision, state: 'active', confirmed: true });
const code = (fn, value) => assert.throws(fn, { code: value });

 test('REM01: actual SQLite schedule is paused by default, selection stays exact, explicit opt-in creates only a local inbox event', t => {
  const f = fixture(t), selected = task(f), unselected = task(f, { title: 'UNSELECTED_TASK_CANARY' }), row = create(f, selected);
  assert.equal(row.data.state, 'paused'); assert.equal(f.service.drain().checked, 0); assert.equal(f.service.listInbox().length, 0);
  code(() => f.service.setState(row.id, { expected_revision: 1, state: 'active', confirmed: false }), 'CONSENT_REQUIRED'); active(f, row);
  const result = f.service.drain(); assert.equal(result.checked, 1); assert.equal(result.notifications, 1); const event = f.service.listInbox()[0];
  assert.equal(event.task_id, selected.id); assert.equal(event.stage, 'due_soon'); assert.doesNotMatch(JSON.stringify(event), /UNSELECTED_TASK_CANARY/);
  assert.equal(f.store.listTasks().length, 2); assert.equal(f.store.getTask(unselected.id).revision, 1); assert.equal(f.store.listAgentGrants().length, 0);
});

test('REM02: unchanged ticks are quiet without new SQLite revisions; saved watermark survives actual restart and acknowledgement', t => {
  const f = fixture(t), saved = task(f); active(f, create(f, saved)); f.service.drain(); const row = f.service.listSchedules()[0], event = f.service.listInbox()[0];
  for (let i = 0; i < 5; i++) assert.equal(f.service.drain().notifications, 0);
  assert.equal(f.service.listSchedules()[0].revision, row.revision);
  const acked = f.service.acknowledge(row.id, { expected_revision: row.revision, event_id: event.id }); assert.equal(acked.data.inbox[0].acknowledged_at, NOW);
  assert.deepEqual(f.service.acknowledge(row.id, { expected_revision: row.revision, event_id: event.id }), acked);
  f.restart(); assert.equal(f.service.drain().notifications, 0); assert.equal(f.service.listInbox()[0].acknowledged_at, NOW);
  assert.equal(f.store.integrity().integrity, 'ok');
});

test('REM03: exact instant boundaries are inclusive; missed running time recovers once into current overdue stage', t => {
  const f = fixture(t); f.at('2026-10-04T16:00:00.000Z'); const saved = task(f), row = f.service.createSchedule({ ...input(saved), due_within_minutes: 60 }, { idempotencyKey: 'boundary-fixture-key' }); active(f, row);
  assert.equal(f.service.drain().notifications, 1); f.restart(); f.at('2026-10-07T16:00:00.000Z'); assert.equal(f.service.drain().notifications, 1);
  const events = f.service.listInbox(); assert.equal(events.length, 2); assert.equal(events[0].stage, 'overdue'); assert.equal(events[0].observed_at, '2026-10-07T16:00:00.000Z');
  assert.equal(f.service.drain().notifications, 0);
  f.at('2026-10-04T16:00:00.000Z'); assert.equal(f.service.drain().notifications, 0, 'backward clock does not repeat an earlier stage');
  const data = { due_within_minutes: 60, timezone: 'UTC' }; assert.equal(classifyReminderDeadline(saved, '2026-10-04T15:59:59.999Z', data), null);
  assert.equal(classifyReminderDeadline(saved, '2026-10-04T16:00:00.000Z', data), 'due_soon'); assert.equal(classifyReminderDeadline(saved, '2026-10-04T17:00:00.000Z', data), 'overdue');
});

test('REM04: date-only midnight and DST transitions use the recorded local calendar date without inventing due instants', t => {
  const f = fixture(t), saved = task(f, { deadline: { precision: 'date', date: '2026-11-01', timezone: 'America/Toronto' } });
  active(f, create(f, saved)); f.at('2026-11-01T03:59:59.999Z'); assert.equal(f.service.drain().notifications, 1); assert.equal(f.service.listInbox()[0].stage, 'due_soon');
  f.at('2026-11-01T04:00:00.000Z'); f.service.drain(); assert.equal(f.service.listInbox()[0].stage, 'due_today');
  f.at('2026-11-02T04:59:59.999Z'); assert.equal(f.service.drain().notifications, 0, 'fall-back day remains today for 25 hours');
  f.at('2026-11-02T05:00:00.000Z'); assert.equal(f.service.drain().notifications, 1); const overdue = f.service.listInbox()[0];
  assert.equal(overdue.stage, 'overdue'); assert.deepEqual(overdue.deadline, saved.deadline); assert.equal('instant' in overdue.deadline, false);
});

test('REM05: fallback time zone is used only for missing date zone; unknown, completed and cancelled tasks remain silent', t => {
  const f = fixture(t), date = task(f, { deadline: { precision: 'date', date: '2026-10-04' } }), unknown = task(f, { deadline: { precision: 'unknown' } }), completed = task(f, { status: 'completed' }), cancelled = task(f, { status: 'cancelled' });
  const row = f.service.createSchedule({ ...input(date), task_ids: [date.id, unknown.id, completed.id, cancelled.id] }, { idempotencyKey: 'silent-task-key' }); active(f, row);
  f.at('2026-10-04T03:59:59.999Z'); f.service.drain(); assert.equal(f.service.listInbox().length, 1); assert.equal(f.service.listInbox()[0].stage, 'due_soon');
  f.at('2026-10-04T04:00:00.000Z'); f.service.drain(); assert.equal(f.service.listInbox()[0].stage, 'due_today');
  const earliest = task(f, { deadline: { precision: 'instant', instant: '2026-10-04T04:00:00.000Z' }, status: 'completed' });
  assert.equal(classifyReminderDeadline(earliest, NOW, row.data), null);
});

test('REM06: task title edits do not repeat reminders; reviewed selected deadline changes are followed and current snapshots preserve old facts', t => {
  const f = fixture(t), saved = task(f), row = create(f, saved); active(f, row); f.service.drain();
  const edited = f.store.updateTask(saved.id, { title: 'Changed selected task title' }, saved.revision); assert.equal(f.service.drain().notifications, 0);
  const moved = f.store.updateTask(saved.id, { deadline: { precision: 'instant', instant: '2026-10-06T16:00:00.000Z', timezone: 'America/Toronto' } }, edited.revision);
  assert.equal(f.service.drain().notifications, 0); f.at('2026-10-05T16:00:00.000Z'); assert.equal(f.service.drain().notifications, 1);
  assert.equal(f.service.listInbox()[0].task_revision, moved.revision); assert.equal(f.service.listInbox()[1].task_title, saved.title);
  f.store.updateTask(saved.id, { status: 'completed' }, moved.revision); f.at('2026-10-07T16:00:00.000Z'); assert.equal(f.service.drain().notifications, 0);
});

test('REM07: pause and permanent cancellation invalidate stale expected revisions; resume preserves quiet watermark', t => {
  const f = fixture(t), saved = task(f), row = create(f, saved); const first = active(f, row); f.service.drain(); let current = f.service.listSchedules()[0];
  const paused = f.service.setState(row.id, { expected_revision: current.revision, state: 'paused', confirmed: true }); assert.equal(paused.data.epoch, first.data.epoch + 1);
  code(() => f.service.setState(row.id, { expected_revision: current.revision, state: 'active', confirmed: true }), 'REVISION_CONFLICT'); assert.equal(f.service.drain().checked, 0);
  active(f, paused); assert.equal(f.service.drain().notifications, 0); current = f.service.listSchedules()[0];
  const cancelled = f.service.setState(row.id, { expected_revision: current.revision, state: 'cancelled', confirmed: true });
  code(() => active(f, cancelled), 'CANCELLED'); assert.equal(f.service.drain().checked, 0); f.restart(); assert.equal(f.service.listSchedules()[0].data.state, 'cancelled'); assert.equal(f.service.drain().checked, 0);
});

test('REM08: atomic SQLite CAS discards a stale timer snapshot after pause; neither watermark nor inbox publish', t => {
  const f = fixture(t), saved = task(f), row = active(f, create(f, saved)); let intercepted = false;
  const proxy = new Proxy(f.store, { get(target, key) { const value = target[key];
    if (key === 'commitWorkspaceBatch') return input => {
      if (!intercepted && input.updates.length) { intercepted = true; f.service.setState(row.id, { expected_revision: row.revision, state: 'paused', confirmed: true }); }
      return value.call(target, input);
    }; return typeof value === 'function' ? value.bind(target) : value;
  } });
  const service = createReminderService({ store: proxy, clock: f.clock }); t.after(() => service.dispose());
  const result = service.drain(); assert.equal(result.conflicts, 1); assert.equal(result.notifications, 0); const current = f.service.listSchedules()[0];
  assert.equal(current.data.state, 'paused'); assert.deepEqual(current.data.watermarks, {}); assert.equal(f.service.listInbox().length, 0);
});

test('REM09: failed atomic publication leaves no partial dedup state; restart retries exactly once', t => {
  const f = fixture(t), saved = task(f); active(f, create(f, saved)); let reject = true;
  const proxy = new Proxy(f.store, { get(target, key) { const value = target[key]; if (key === 'commitWorkspaceBatch') return input => {
    if (reject) { reject = false; throw new Error('synthetic interruption before atomic publication'); } return value.call(target, input);
  }; return typeof value === 'function' ? value.bind(target) : value; } });
  const service = createReminderService({ store: proxy, clock: f.clock }); t.after(() => service.dispose()); assert.throws(() => service.drain(), /synthetic interruption/);
  assert.deepEqual(f.service.listSchedules()[0].data.watermarks, {}); assert.equal(f.service.listInbox().length, 0);
  f.restart(); assert.equal(f.service.drain().notifications, 1); f.restart(); assert.equal(f.service.drain().notifications, 0); assert.equal(f.service.listInbox().length, 1);
});

test('REM10: retained inbox is capped at 50 with explicit dropped count; dedup state does not depend on old entries', t => {
  const f = fixture(t); let saved = task(f); active(f, create(f, saved));
  for (let i = 0; i < 60; i++) {
    saved = f.store.updateTask(saved.id, { deadline: { precision: 'instant', instant: new Date(Date.parse(NOW) + (i + 1) * 60000).toISOString() } }, saved.revision);
    assert.equal(f.service.drain().notifications, 1);
  }
  const row = f.service.listSchedules()[0]; assert.equal(row.data.inbox.length, 50); assert.equal(row.data.discarded_inbox_count, 10);
  assert.equal(Object.keys(row.data.watermarks).length, 1); f.restart(); assert.equal(f.service.drain().notifications, 0); assert.equal(f.service.listInbox().length, 50);
});

test('REM11: create retries preserve identity and reject changed payload; selected IDs and input bounds are strict', t => {
  const f = fixture(t), saved = task(f), row = create(f, saved);
  assert.equal(create(f, saved).id, row.id);
  code(() => f.service.createSchedule({ ...input(saved), title: 'Different title' }, { idempotencyKey: 'reminder-fixture-key' }), 'REVISION_CONFLICT');
  for (const bad of [[], [saved.id, saved.id], [randomUUID()], Array(51).fill(saved.id)]) {
    code(() => f.service.createSchedule({ ...input(saved), task_ids: bad }, { idempotencyKey: 'bad-scope-key' }), bad.length === 1 ? 'SCOPE_DENIED' : 'INVALID_INPUT');
  }
  for (const bad of [14, 10081, 15.5, '1440']) code(() => f.service.createSchedule({ ...input(saved), due_within_minutes: bad }, { idempotencyKey: 'bad-window-key' }), 'INVALID_INPUT');
  code(() => f.service.createSchedule({ ...input(saved), timezone: 'Unknown/Zone' }, { idempotencyKey: 'bad-timezone-key' }), 'INVALID_INPUT');
  code(() => f.service.createSchedule({ ...input(saved), provider: 'gmail' }, { idempotencyKey: 'bad-input-extra' }), 'INVALID_INPUT');
});

test('REM12: bounded schedule cap permits at most 20 schedules and does not block safe idempotent retries', t => {
  const f = fixture(t), saved = task(f); const first = create(f, saved, 'schedule-cap-key-00');
  for (let i = 1; i < 20; i++) create(f, saved, `schedule-cap-key-${i}`);
  assert.equal(f.service.listSchedules().length, REMINDER_LIMITS.schedules);
  code(() => create(f, saved, 'schedule-cap-too-many'), 'BUDGET_EXCEEDED'); assert.equal(create(f, saved, 'schedule-cap-key-00').id, first.id);
});

test('REM13: acknowledgement rejects stale and foreign event selections, but retry of already acknowledged event stays idempotent', t => {
  const f = fixture(t), saved = task(f), row = active(f, create(f, saved)); f.service.drain(); const current = f.service.listSchedules()[0], event = f.service.listInbox()[0];
  code(() => f.service.acknowledge(row.id, { expected_revision: row.revision, event_id: event.id }), 'REVISION_CONFLICT');
  code(() => f.service.acknowledge(row.id, { expected_revision: current.revision, event_id: randomUUID() }), 'SCOPE_DENIED');
  const acked = f.service.acknowledge(row.id, { expected_revision: current.revision, event_id: event.id }); assert.equal(acked.data.inbox[0].acknowledged_at, NOW);
  assert.equal(f.service.acknowledge(row.id, { expected_revision: current.revision, event_id: event.id }).revision, acked.revision);
});

test('REM14: deleted selected tasks are unavailable and never replaced; disposal prevents work while active state persists for next owned runtime', t => {
  const f = fixture(t), saved = task(f), replacement = task(f, { title: 'Unselected replacement' }), row = active(f, create(f, saved));
  f.store.deleteTask(saved.id, saved.revision); assert.equal(f.service.drain().notifications, 0); assert.equal(f.service.listSchedules()[0].selected_tasks[0].unavailable, true);
  const paused = f.service.setState(row.id, { expected_revision: row.revision, state: 'paused', confirmed: true }); code(() => active(f, paused), 'SCOPE_DENIED');
  assert.equal(f.store.getTask(replacement.id).revision, 1); f.service.dispose(); assert.equal(f.service.drain().stopped, true); code(() => f.service.listSchedules(), 'CANCELLED');
});

test('REM15: ticks read only selected task IDs and have no model, source, document, provider or task-creation side effect', t => {
  const f = fixture(t), saved = task(f); active(f, create(f, saved)); const seen = [];
  const proxy = new Proxy(f.store, { get(target, key) { if (['listTasks', 'createTask', 'getDocument', 'listSources', 'listDocuments', 'createAgentGrant'].includes(key)) return () => assert.fail(`unapproved operation ${key}`);
    if (key === 'getTask') return value => { seen.push(value); return target.getTask(value); }; const value = target[key]; return typeof value === 'function' ? value.bind(target) : value; } });
  const service = createReminderService({ store: proxy, clock: f.clock }); t.after(() => service.dispose()); service.drain(); assert.deepEqual(seen, [saved.id, saved.id]);
  assert.equal(service.status().provider_reads, false); assert.equal(service.status().external_actions, false); assert.equal(service.status().os_notifications, false);
});

test('REM16: validation rejects corrupted schedule state before a timer publishes and unrelated routine records remain unchanged', t => {
  const f = fixture(t), saved = task(f), row = create(f, saved), other = f.store.createWorkspaceRecord({ kind: 'routine', title: 'Other routine', data: { category: 'other_life_recipe' } });
  f.store.updateWorkspaceRecord(row.id, { expected_revision: row.revision, data: { ...row.data, task_ids: [] } });
  code(() => f.service.drain(), 'VERSION_MISMATCH'); assert.equal(f.store.getWorkspaceRecord(other.id).revision, 1); assert.equal(f.service.status().default_state, 'paused');
});

test('REM17: provenance text changes on an unchanged deadline do not repeat a reminder', t => {
  const f = fixture(t), saved = task(f); active(f, create(f, saved)); f.service.drain(); const row = f.service.listSchedules()[0];
  f.store.updateTask(saved.id, { deadline: { ...saved.deadline, original: 'Changed source wording, same actual due instant.' } }, saved.revision);
  assert.equal(f.service.drain().notifications, 0); assert.equal(f.service.listSchedules()[0].revision, row.revision); assert.equal(f.service.listInbox().length, 1);
});

test('REM18: a selected task changed while preparing a tick blocks stale task facts before atomic publication', t => {
  const f = fixture(t), saved = task(f); active(f, create(f, saved)); let changed = false;
  const proxy = new Proxy(f.store, { get(target, key) { if (key === 'getTask') return value => {
    const snapshot = target.getTask(value); if (!changed) { changed = true; target.updateTask(value, { status: 'completed' }, snapshot.revision); } return snapshot;
  }; const value = target[key]; return typeof value === 'function' ? value.bind(target) : value; } });
  const service = createReminderService({ store: proxy, clock: f.clock }); t.after(() => service.dispose());
  assert.equal(service.drain().conflicts, 1); assert.equal(f.service.listInbox().length, 0); assert.deepEqual(f.service.listSchedules()[0].data.watermarks, {});
  assert.equal(f.service.drain().notifications, 0); assert.equal(f.store.getTask(saved.id).status, 'completed');
});

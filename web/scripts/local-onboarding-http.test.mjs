import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { describeRoot, inventorySource, readSelectedEntry, readSelectedPdf, readSelectedOffice,
  probeSourceCapability, probePdfCapability, probeOfficeCapability } from '../packages/local-sources/src/index.mjs';

const API = '/api/local/v1';
const canaries = {
  profile: 'SYNTHETIC_ONBOARDING_PROFILE_VALUE_CANARY',
  source: 'SYNTHETIC_ONBOARDING_SELECTED_FILE_BODY_CANARY',
  document: 'SYNTHETIC_ONBOARDING_DOCUMENT_BODY_CANARY',
  academic: 'SYNTHETIC_ONBOARDING_ASSIGNMENT_BODY_CANARY',
  unrelated: 'SYNTHETIC_ONBOARDING_UNSELECTED_BODY_CANARY',
};
const selection = patch => ({ purpose: 'learning', requested: ['profile', 'local_files', 'academic_exports', 'agent_bridge'],
  profile_ids: [], source_entry_ids: [], snapshot_ids: [], document_ids: [], agent_grant_ids: [], destination: null, ...patch });
function academicExport(minute = 0) {
  return { schema_version: 1,
    institution: { name: 'Synthetic University', origin: 'https://onboarding.example.edu', timezone: 'America/Toronto' },
    account_ref: 'synthetic-onboarding-student', retrieved_at: `2026-10-03T10:${String(minute).padStart(2, '0')}:00.000Z`,
    courses: [{ source_id: 'SYN', title: 'Synthetic course', code: 'SYN101' }],
    assignments: [{ source_id: 'a1', course_id: 'SYN', title: 'Synthetic exercise', description: canaries.academic, due: '2026-10-10' }],
    announcements: [], materials: [],
    coverage: Object.fromEntries(['courses', 'assignments', 'announcements', 'materials'].map(category => [category, { state: 'complete' }])),
  };
}
async function fixture(t, { sessionTtlMs } = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-onboarding-http-')); const root = join(parent, 'workspace'); let runtime;
  const calls = Object.fromEntries(['describeRoot', 'inventorySource', 'readSelectedEntry', 'readSelectedPdf', 'readSelectedOffice',
    'probeSourceCapability', 'probePdfCapability', 'probeOfficeCapability', 'hostExecute'].map(name => [name, 0]));
  const production = { describeRoot, inventorySource, readSelectedEntry, readSelectedPdf, readSelectedOffice,
    probeSourceCapability, probePdfCapability, probeOfficeCapability };
  const sourceAdapter = Object.fromEntries(Object.entries(production).map(([name, method]) => [name, async (...args) => {
    calls[name]++; return method(...args);
  }]));
  t.after(async () => { await runtime?.close(); rmSync(parent, { recursive: true, force: true }); });
  async function pair() {
    const response = await fetch(runtime.origin + API + '/pair', { method: 'POST',
      headers: { Origin: runtime.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: runtime.createPairingCode() }) });
    assert.equal(response.status, 200); const session = await response.json(); const cookie = response.headers.get('set-cookie').split(';')[0];
    const origin = runtime.origin;
    return async (path, body, method = body === undefined ? 'GET' : 'POST', headers = {}) => {
      const response = await fetch(origin + API + path, { method,
        headers: { Cookie: cookie, Origin: origin, 'X-LearnBridge-Nonce': session.nonce,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, data: await response.json(), headers: response.headers };
    };
  }
  async function restart(dataRoot = root) {
    await runtime?.close(); runtime = await startRuntime({ dataRoot, port: 0, sourceAdapter, sessionTtlMs,
      hostAdapter: { enabled: false, execute: async () => { calls.hostExecute++; throw new Error('An onboarding report must never launch a host.'); } } });
    return pair();
  }
  return { parent, root, calls, pair, restart, close: () => runtime.close(), get origin() { return runtime.origin; }, call: await restart() };
}
async function preview(call, chosen = selection()) {
  const result = await call('/onboarding/preview', chosen); assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.match(result.data.preview_id, /^[0-9a-f-]{36}$/); assert.match(result.data.preview.review_hash, /^[a-f0-9]{64}$/);
  return result.data;
}
const accept = (call, reviewed) => call('/onboarding/reports', { preview_id: reviewed.preview_id, review_hash: reviewed.preview.review_hash });
const row = (value, category) => value.coverage.find(item => item.category === category);
function metadataOnly(value, paths = []) {
  const serialized = JSON.stringify(value);
  for (const canary of [...Object.values(canaries), ...paths]) assert.equal(serialized.includes(canary), false, 'Metadata leaked a private value, body or absolute path.');
  return serialized;
}
async function importCourse(call, raw = academicExport()) {
  const reviewed = await call('/academic/preview', { export: raw, selected_course_ids: ['SYN'] }); assert.equal(reviewed.status, 200);
  const imported = await call('/academic/library-import', { preview_id: reviewed.data.preview_id, review_hash: reviewed.data.refresh.review_hash });
  assert.equal(imported.status, 201); return imported.data;
}
async function grant(call, document) {
  const result = await call('/agent-grants', { destination: 'codex', task_ids: [], document_ids: [document.id], source_entry_ids: [],
    expected_records: { tasks: [], documents: [{ id: document.id, revision: document.revision }], source_entries: [] },
    max_bytes: 48000, expires_in_minutes: 60 });
  assert.equal(result.status, 201); return result.data.grant;
}
async function seeded(f) {
  const call = f.call;
  const candidate = await call('/profile', { field: 'learning_preferences', value: canaries.profile }); assert.equal(candidate.status, 201);
  let profile = (await call('/profile')).data.items[0];
  assert.equal((await call(`/profile/${profile.id}/review`, { expected_revision: profile.revision, decision: 'confirm', fingerprint: profile.fingerprint })).status, 200);
  profile = (await call('/profile')).data.items[0];
  const folder = join(f.parent, 'SYNTHETIC_ABSOLUTE_PATH_CANARY'); mkdirSync(folder, { mode: 0o700 });
  writeFileSync(join(folder, 'selected.md'), canaries.source, { mode: 0o600 });
  writeFileSync(join(folder, 'unselected.md'), canaries.unrelated, { mode: 0o600 });
  const described = await call('/sources', { path: folder, label: 'Synthetic selected folder' }); assert.equal(described.status, 201);
  const source = described.data.source;
  const inventory = await call(`/sources/${source.id}/inventory`, {}); assert.equal(inventory.status, 200);
  const selectedFile = inventory.data.inventory.inventory.entries.find(item => item.relativePath === 'selected.md'); assert.ok(selectedFile);
  const imported = await call(`/sources/${source.id}/import`, { inventory_id: inventory.data.inventory.id, entry_id: selectedFile.id });
  assert.equal(imported.status, 201); const entry = imported.data.entry;
  const note = await call('/documents', { title: 'Synthetic reviewed note', content: canaries.document }); assert.equal(note.status, 201);
  const unselected = await call('/documents', { title: 'Synthetic unrelated note', content: canaries.unrelated }); assert.equal(unselected.status, 201);
  const course = await importCourse(call);
  const activeGrant = await grant(call, note.data.document);
  const task = await call('/tasks', { title: 'Synthetic student-owned task', effort_minutes: 35 }); assert.equal(task.status, 201);
  return { profile, source, entry, folder, note: note.data, unselected: unselected.data, course, activeGrant, task: task.data.task,
    chosen: selection({ profile_ids: [profile.id], source_entry_ids: [entry.id], snapshot_ids: [course.snapshot.id],
      document_ids: [note.data.document.id], agent_grant_ids: [activeGrant.id], destination: 'codex' }) };
}
async function privateState(call) {
  const result = {};
  for (const path of ['/profile', '/tasks', '/documents', '/courses', '/agent-grants', '/sources', '/host-turns']) result[path] = (await call(path)).data;
  return result;
}

test('ONH01: catalog and empty reviewed onboarding use saved metadata only and launch no discovery, parser or host work', async t => {
  const f = await fixture(t); const counters = { ...f.calls };
  for (let n = 0; n < 3; n++) {
    const catalog = await f.call('/onboarding/catalog'); assert.equal(catalog.status, 200);
    for (const category of ['profile', 'source_entries', 'snapshots', 'documents', 'grants']) assert.deepEqual(catalog.data[category], []);
    metadataOnly(catalog.data, [f.parent, f.root]); assert.match(catalog.headers.get('cache-control'), /no-store/);
  }
  const reviewed = await preview(f.call); assert.equal(reviewed.preview.coverage.length, 4);
  assert.ok(reviewed.preview.coverage.every(item => item.checked_count === 0 && item.state !== 'complete'));
  const result = await accept(f.call, reviewed); assert.equal(result.status, 201); assert.equal(result.data.item.needs_refresh, false);
  assert.equal(result.data.item.data.format, 'onboarding_report'); metadataOnly(result.data, [f.parent, f.root]);
  assert.deepEqual(f.calls, counters); assert.equal((await f.call('/agent-grants')).data.items.length, 0);
  assert.equal((await f.call('/tasks')).data.items.length, 0); assert.equal((await f.call('/profile')).data.items.length, 0);
});

test('ONH02: selected catalog, exact coverage review and saved report omit bodies and values while preserving all original records', async t => {
  const f = await fixture(t); const saved = await seeded(f); const before = await privateState(f.call); const counters = { ...f.calls };
  const catalog = await f.call('/onboarding/catalog'); assert.equal(catalog.status, 200);
  metadataOnly(catalog.data, [f.parent, f.root, saved.folder]);
  assert.equal(catalog.data.profile.length, 1); assert.equal(catalog.data.source_entries.length, 1);
  assert.equal(catalog.data.snapshots.length, 1); assert.equal(catalog.data.documents.length, 2); assert.equal(catalog.data.grants.length, 1);
  const reviewed = await preview(f.call, saved.chosen); metadataOnly(reviewed, [f.parent, f.root, saved.folder]);
  assert.deepEqual(reviewed.preview.selection, saved.chosen);
  assert.equal(row(reviewed.preview, 'profile').checked_count, 1); assert.equal(row(reviewed.preview, 'local_files').checked_count, 1);
  assert.equal(row(reviewed.preview, 'academic_exports').checked_count, 1);
  assert.notEqual(row(reviewed.preview, 'agent_bridge').state, 'complete', 'An active grant is not proof of an authenticated or working host.');
  const report = await accept(f.call, reviewed); assert.equal(report.status, 201); metadataOnly(report.data, [f.parent, f.root, saved.folder]);
  assert.equal(report.data.item.needs_refresh, false); assert.equal(report.data.item.data.review_hash, reviewed.preview.review_hash);
  const exact = await f.call('/onboarding/reports/' + report.data.item.id); assert.equal(exact.status, 200); assert.deepEqual(exact.data, report.data);
  assert.deepEqual((await f.call('/onboarding/reports')).data.items, [report.data.item]);
  assert.deepEqual(await privateState(f.call), before); assert.deepEqual(f.calls, counters);
});

test('ONH03: all onboarding reads and writes require pairing and nonce; previews are bound to their reviewing session', async t => {
  const f = await fixture(t); const reviewed = await preview(f.call); const other = await f.pair();
  const paths = ['/onboarding/catalog', '/onboarding/reports', '/onboarding/reports/' + randomUUID()];
  for (const path of paths) {
    const unauthenticated = await fetch(f.origin + API + path, { headers: { Origin: f.origin } }); assert.equal(unauthenticated.status, 401);
    assert.equal((await unauthenticated.json()).error.code, 'AUTH_REQUIRED');
    const absentNonce = await f.call(path, undefined, 'GET', { 'X-LearnBridge-Nonce': '' }); assert.equal(absentNonce.status, 403);
  }
  for (const [path, body, method] of [['/onboarding/preview', selection(), 'POST'],
    ['/onboarding/reports', { preview_id: reviewed.preview_id, review_hash: reviewed.preview.review_hash }, 'POST'],
    ['/onboarding/reports/' + randomUUID(), { expected_revision: 1 }, 'DELETE']]) {
    const unauthenticated = await fetch(f.origin + API + path, { method,
      headers: { Origin: f.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(unauthenticated.status, 401);
    assert.equal((await f.call(path, body, method, { 'X-LearnBridge-Nonce': '' })).status, 403);
  }
  const crossSession = await accept(other, reviewed); assert.equal(crossSession.status, 403); assert.equal(crossSession.data.error.code, 'CONSENT_REQUIRED');
  assert.equal((await f.call('/logout', {})).status, 200); assert.equal((await accept(f.call, reviewed)).status, 401);
  assert.equal((await accept(other, reviewed)).status, 403); assert.equal((await other('/onboarding/reports')).data.items.length, 0);
});

test('ONH04: strict input and exact review hash reject forged authority, oversized selections and unknown records without saving a report', async t => {
  const f = await fixture(t);
  const invalid = [
    selection({ coverage: [{ category: 'profile', state: 'complete' }] }), selection({ raw_body: canaries.document }),
    selection({ student_id: randomUUID() }), selection({ purpose: 'administrator' }), selection({ requested: ['all_files'] }),
    selection({ profile_ids: ['not-a-uuid'] }), selection({ profile_ids: Array.from({ length: 41 }, () => randomUUID()) }),
    selection({ requested: [], source_entry_ids: [randomUUID()] }), selection({ requested: ['profile'], destination: 'codex' }),
  ];
  const duplicate = randomUUID(); invalid.push(selection({ profile_ids: [duplicate, duplicate] }));
  for (const value of invalid) {
    const rejected = await f.call('/onboarding/preview', value); assert.equal(rejected.status, 400, JSON.stringify(rejected.data));
    assert.equal(rejected.data.error.code, 'INVALID_INPUT');
  }
  const tooMany = await f.call('/onboarding/preview', selection({ profile_ids: [randomUUID(), randomUUID()], document_ids: Array.from({ length: 39 }, () => randomUUID()) }));
  assert.equal(tooMany.status, 413); assert.equal(tooMany.data.error.code, 'BUDGET_EXCEEDED');
  const unknown = await f.call('/onboarding/preview', selection({ profile_ids: [randomUUID()] })); assert.equal(unknown.status, 403);
  assert.equal(unknown.data.error.code, 'SCOPE_DENIED');
  const reviewed = await preview(f.call);
  assert.equal((await f.call('/onboarding/reports', { preview_id: reviewed.preview_id })).status, 400);
  assert.equal((await f.call('/onboarding/reports', { preview_id: reviewed.preview_id, review_hash: 'not-a-hash' })).status, 400);
  const forged = await f.call('/onboarding/reports', { preview_id: reviewed.preview_id, review_hash: 'f'.repeat(64) });
  assert.equal(forged.status, 409); assert.equal(forged.data.error.code, 'REVISION_CONFLICT');
  assert.equal((await f.call('/onboarding/reports', { preview_id: reviewed.preview_id, review_hash: reviewed.preview.review_hash,
    preview: reviewed.preview, reviewer: 'forged', confirmed: true })).status, 400);
  assert.equal((await f.call('/onboarding/reports')).data.items.length, 0);
  assert.equal((await accept(f.call, reviewed)).status, 201);
  assert.equal((await f.call('/onboarding/catalog?scan=all')).status, 400);
});

test('ONH05: candidate facts remain awaiting student review and saving onboarding never confirms them', async t => {
  const f = await fixture(t);
  const created = await f.call('/profile', { field: 'learning_preferences', value: canaries.profile }); assert.equal(created.status, 201);
  const fact = (await f.call('/profile')).data.items[0]; assert.equal(fact.data.state, 'candidate');
  const reviewed = await preview(f.call, selection({ requested: ['profile'], profile_ids: [fact.id] }));
  assert.equal(row(reviewed.preview, 'profile').state, 'awaiting_student');
  const result = await accept(f.call, reviewed); assert.equal(result.status, 201); metadataOnly(result.data);
  assert.deepEqual((await f.call('/profile')).data.items, [fact]); assert.equal((await f.call('/agent-grants')).data.items.length, 0);
  for (const category of ['local_files', 'academic_exports', 'agent_bridge']) assert.equal(row(reviewed.preview, category).state, 'not_requested');
});

test('ONH06: note revisions and changed profile review invalidate exact pending coverage and mark prior reports stale', async t => {
  const f = await fixture(t); const saved = await seeded(f);
  const originalReview = await preview(f.call, saved.chosen);
  const accepted = await accept(f.call, originalReview); assert.equal(accepted.status, 201);
  const pending = await preview(f.call, saved.chosen);
  const changed = await f.call('/documents/' + saved.note.document.id, { content: 'Synthetic changed note body', expected_revision: saved.note.document.revision }, 'PATCH');
  assert.equal(changed.status, 200);
  const stale = await accept(f.call, pending); assert.equal(stale.status, 409); assert.equal(stale.data.error.code, 'REVISION_CONFLICT');
  assert.equal((await f.call('/onboarding/reports')).data.items.length, 1);
  const old = await f.call('/onboarding/reports/' + accepted.data.item.id); assert.equal(old.status, 200);
  assert.equal(old.data.item.needs_refresh, true); assert.ok(old.data.item.refresh_reasons.length > 0); metadataOnly(old.data);
  const savedRetry = await accept(f.call, originalReview); assert.equal(savedRetry.status, 201);
  assert.equal(savedRetry.data.item.id, accepted.data.item.id); assert.equal(savedRetry.data.item.revision, accepted.data.item.revision);
  assert.deepEqual(savedRetry.data.item.data, accepted.data.item.data); assert.equal(savedRetry.data.item.needs_refresh, true);
  assert.equal((await f.call('/onboarding/reports')).data.items.length, 1);
  const refreshed = await preview(f.call, saved.chosen);
  const corrected = await f.call(`/profile/${saved.profile.id}/review`, { expected_revision: saved.profile.revision,
    decision: 'correct', fingerprint: saved.profile.fingerprint, value: 'Synthetic changed learning preference' }); assert.equal(corrected.status, 200);
  assert.equal((await accept(f.call, refreshed)).status, 409); assert.equal((await f.call('/onboarding/reports')).data.items.length, 1);
});

test('ONH07: current course head advancement invalidates pending coverage and excludes retained historical snapshots from catalog and new selection', async t => {
  const f = await fixture(t); const first = await importCourse(f.call);
  const chosen = selection({ requested: ['academic_exports'], snapshot_ids: [first.snapshot.id] });
  const pending = await preview(f.call, chosen);
  const raw = academicExport(1); raw.assignments[0].due = '2026-10-12'; const next = await importCourse(f.call, raw);
  assert.notEqual(next.snapshot.id, first.snapshot.id);
  const stale = await accept(f.call, pending); assert.equal(stale.status, 409); assert.equal(stale.data.error.code, 'REVISION_CONFLICT');
  assert.equal((await f.call('/onboarding/reports')).data.items.length, 0);
  const catalog = await f.call('/onboarding/catalog'); assert.deepEqual(catalog.data.snapshots.map(item => item.id), [next.snapshot.id]); metadataOnly(catalog.data);
  const historical = await f.call('/onboarding/preview', chosen); assert.equal(historical.status, 403); assert.equal(historical.data.error.code, 'SCOPE_DENIED');
  assert.equal((await accept(f.call, await preview(f.call, { ...chosen, snapshot_ids: [next.snapshot.id] }))).status, 201);
});

test('ONH08: source and grant revocations invalidate pending review and retain a stale metadata report without executing a host', async t => {
  const f = await fixture(t); const saved = await seeded(f);
  const original = await accept(f.call, await preview(f.call, saved.chosen)); assert.equal(original.status, 201);
  const pending = await preview(f.call, saved.chosen); const counters = { ...f.calls };
  assert.equal((await f.call(`/agent-grants/${saved.activeGrant.id}/revoke`, { expected_revision: saved.activeGrant.revision })).status, 200);
  assert.equal((await accept(f.call, pending)).status, 409);
  const old = await f.call('/onboarding/reports/' + original.data.item.id); assert.equal(old.data.item.needs_refresh, true); metadataOnly(old.data);
  const withoutGrant = { ...saved.chosen, agent_grant_ids: [] }; const nextPreview = await preview(f.call, withoutGrant);
  assert.equal((await f.call(`/sources/${saved.source.id}/revoke`, { expected_revision: saved.source.revision })).status, 200);
  assert.equal((await accept(f.call, nextPreview)).status, 409);
  const revokedSource = await f.call('/onboarding/preview', withoutGrant); assert.equal(revokedSource.status, 403);
  assert.equal(revokedSource.data.error.code, 'SCOPE_DENIED'); assert.deepEqual(f.calls, counters); assert.equal(f.calls.hostExecute, 0);
  assert.equal((await f.call('/onboarding/reports')).data.items.length, 1);
});

test('ONH09: forgetting a report requires its exact revision and preserves unrelated notes, facts, tasks, grants and course state', async t => {
  const f = await fixture(t); const saved = await seeded(f); const before = await privateState(f.call);
  const report = (await accept(f.call, await preview(f.call, saved.chosen))).data.item;
  const other = (await accept(f.call, await preview(f.call, selection({ purpose: 'career', requested: [] })))).data.item;
  const path = '/onboarding/reports/' + report.id;
  assert.equal((await f.call(path, { expected_revision: report.revision + 1 }, 'DELETE')).status, 409);
  assert.equal((await f.call(path, { expected_revision: report.revision, purge_sources: true }, 'DELETE')).status, 400);
  assert.equal((await f.call(path, { expected_revision: report.revision }, 'DELETE')).status, 200);
  const forgotten = await f.call(path); assert.equal(forgotten.status, 403); assert.equal(forgotten.data.error.code, 'SCOPE_DENIED');
  assert.deepEqual((await f.call('/onboarding/reports')).data.items, [other]); assert.deepEqual(await privateState(f.call), before);
});

test('ONH10: reports persist exactly across restart and a fresh restored backup while temporary review previews do not', async t => {
  const f = await fixture(t); const saved = await seeded(f); let call = f.call;
  const accepted = await accept(call, await preview(call, saved.chosen)); assert.equal(accepted.status, 201);
  const pending = await preview(call, saved.chosen);
  const reportPath = '/onboarding/reports/' + accepted.data.item.id;
  const expectedReport = (await call(reportPath)).data; const expectedList = (await call('/onboarding/reports')).data;
  const expectedPrivate = await privateState(call);
  call = await f.restart(); assert.deepEqual((await call(reportPath)).data, expectedReport); assert.deepEqual((await call('/onboarding/reports')).data, expectedList);
  assert.deepEqual(await privateState(call), expectedPrivate);
  assert.equal((await accept(call, pending)).status, 403); assert.equal((await call('/onboarding/reports')).data.items.length, 1);
  await f.close();
  const store = LocalStore.open({ root: f.root });
  try { await store.backup(join(f.parent, 'backup')); } finally { store.close(); }
  const restored = join(f.parent, 'restored'); await LocalStore.restore({ backupRoot: join(f.parent, 'backup'), root: restored });
  call = await f.restart(restored);
  assert.deepEqual((await call(reportPath)).data, expectedReport); assert.deepEqual((await call('/onboarding/reports')).data, expectedList);
  assert.deepEqual(await privateState(call), expectedPrivate); metadataOnly((await call(reportPath)).data, [f.parent, f.root, saved.folder, restored]);
  assert.equal((await accept(call, pending)).status, 403); assert.equal(f.calls.hostExecute, 0);
});

test('ONH11: successful review cycles reclaim consumed preview capacity while preserving a still-pending exact review', async t => {
  const f = await fixture(t); const pending = await preview(f.call, selection({ purpose: 'career', requested: [] }));
  const counters = { ...f.calls }; let latest; let latestReport;
  for (let count = 0; count < 12; count++) {
    latest = await preview(f.call, selection({ purpose: 'general', requested: [] }));
    const result = await accept(f.call, latest); assert.equal(result.status, 201, JSON.stringify(result.data)); latestReport = result.data.item;
  }
  const replay = await accept(f.call, latest); assert.equal(replay.status, 201); assert.deepEqual(replay.data.item, latestReport);
  assert.equal((await f.call('/onboarding/reports')).data.items.length, 12);
  const savedPending = await accept(f.call, pending); assert.equal(savedPending.status, 201); assert.equal(savedPending.data.item.data.selection.purpose, 'career');
  assert.equal((await f.call('/onboarding/reports')).data.items.length, 13); assert.deepEqual(f.calls, counters);
});

test('ONH12: session expiry rejects a pending onboarding save without making it available to a newly paired session', async t => {
  const f = await fixture(t, { sessionTtlMs: 2000 }); const pending = await preview(f.call);
  await delay(2100);
  const expired = await accept(f.call, pending); assert.equal(expired.status, 401); assert.equal(expired.data.error.code, 'AUTH_REQUIRED');
  const renewed = await f.pair(); const transferred = await accept(renewed, pending);
  assert.equal(transferred.status, 403); assert.equal(transferred.data.error.code, 'CONSENT_REQUIRED');
  assert.equal((await renewed('/onboarding/reports')).data.items.length, 0); assert.equal(f.calls.hostExecute, 0);
});

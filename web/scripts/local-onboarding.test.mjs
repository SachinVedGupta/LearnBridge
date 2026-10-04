import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { createStudentWorkspace } from '../apps/local-runtime/src/student-workspace.mjs';
import { createOnboardingWorkspace } from '../apps/local-runtime/src/onboarding.mjs';
import { lifeHash } from '../apps/local-runtime/src/life.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const denied = (fn, code) => assert.throws(fn, error => error.code === code);
const selected = extra => ({ purpose: 'learning', requested: [], profile_ids: [], source_entry_ids: [], snapshot_ids: [], document_ids: [], agent_grant_ids: [], destination: null, ...extra });
const coverage = (preview, category) => preview.coverage.find(row => row.category === category);
function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-onboarding-')), root = join(parent, 'workspace'); let store = LocalStore.open({ root });
  let now = new Date().toISOString();
  const service = () => createStudentWorkspace(store);
  const onboarding = () => createOnboardingWorkspace(store, { studentWorkspace: service(), clock: () => now });
  t.after(() => { store.close(); rmSync(parent, { recursive: true, force: true }); });
  return { parent, root, get store() { return store; }, get student() { return service(); }, get onboarding() { return onboarding(); },
    advance(milliseconds) { now = new Date(Date.parse(now) + milliseconds).toISOString(); },
    restart() { store.close(); store = LocalStore.open({ root }); },
  };
}
function profile(f, value = 'PROFILE_VALUE_CANARY', confirmed = true) {
  const record = f.student.createProfile({ field: 'learning_preferences', value });
  if (!confirmed) return record;
  const view = f.student.listProfiles().find(item => item.id === record.id);
  return f.student.reviewProfile(record.id, { expected_revision: record.revision, decision: 'confirm', fingerprint: view.fingerprint });
}
function save(f, preview, key = randomUUID()) { return f.onboarding.save(preview, { review_hash: preview.review_hash, idempotency_key: key }); }
function academic(f, minute = 0, changed = false) {
  const raw = { schema_version: 1, institution: { name: 'Synthetic University', origin: 'https://synthetic.example.edu', timezone: 'America/Toronto' },
    account_ref: 'synthetic-student', retrieved_at: `2026-10-03T10:${String(minute).padStart(2, '0')}:00.000Z`, courses: [{ source_id: 'A', title: 'Synthetic course' }],
    assignments: [{ source_id: 'assignment-1', course_id: 'A', title: 'Reason about recursion', description: 'ACADEMIC_BODY_CANARY', due: changed ? '2026-10-14' : '2026-10-12' }],
    materials: [], announcements: [], coverage: Object.fromEntries(['courses', 'assignments', 'announcements', 'materials'].map(category => [category, { state: 'complete' }])) };
  const preview = f.student.previewAcademicExport({ export: raw, selected_course_ids: ['A'] });
  return f.student.commitAcademicRefresh(preview, { review_hash: preview.review_hash, expected_head_revision: preview.base.revision, idempotency_key: randomUUID() });
}
/** Synthetic saved-source provenance. No root is inventoried and no file is read. */
function source(f, kind = 'markdown', officeReasons = ['layout_not_preserved'], titlePadding = 0) {
  const descriptor = { schema_version: 1, kind: 'local-directory', root: '/synthetic/PATH_CANARY', label: 'Selected source',
    identity: { dev: '10', ino: '20' }, version: sha('synthetic root') };
  const id = randomUUID(), inventoryId = randomUUID(), version = sha(`synthetic ${kind}`), title = `${'x'.repeat(titlePadding)}selected.${kind}`;
  const inventory = { schema_version: 1, id: inventoryId, source_version: descriptor.version, version: sha('synthetic inventory'),
    entries: [{ id, relativePath: title, kind, title, snapshot: { dev: '10', ino: '21', size: 400, mtimeNs: '100', ctimeNs: '100', nlink: 1, version },
      directories: [{ relativePath: '', identity: { dev: '10', ino: '20', mtimeNs: '90', ctimeNs: '90' } }] }],
    counts: { entriesVisited: 1, directoriesVisited: 1, eligibleFiles: 1, excludedEntries: 0, totalBytes: 400 },
    exclusions: { secret: 0, symlink: 0, special: 0, unsupportedType: 0, hardlink: 0, depth: 0, permission: 0, changed: 0 },
    budget: { maxEntries: 100, maxFiles: 100, maxDepth: 3 }, coverage: { state: 'complete', reasons: [] }, retrieved_at: new Date().toISOString() };
  let text = 'SOURCE_BODY_CANARY'; let provenance = {};
  if (['docx', 'pptx', 'pdf'].includes(kind)) {
    const label = kind === 'pdf' ? 'PDF page' : kind === 'docx' ? 'DOCX paragraph' : 'PPTX slide';
    const body = 'SOURCE_BODY_CANARY'; text = `[${label} 1]\n${body}`;
    const record = { text: body, sha256: sha(body), byte_range: { start: Buffer.byteLength(`[${label} 1]\n`), end: Buffer.byteLength(text) } };
    if (kind === 'pdf') provenance = { pdf: { schema_version: 1, format: 'pdf_text', parser_version: 'macos_pdfkit.v1', source_sha256: sha(Buffer.alloc(400)), source_bytes: 400,
      page_count: 1, pages: [{ physical_page: 1, printed_label: null, ...record }], extraction_status: 'available', coverage: { state: 'partial', reasons: ['visual_content_not_checked'] } } };
    else provenance = { office: { schema_version: 1, format: 'office_text', parser_version: 'stdlib_ooxml.v1', document_type: kind, source_sha256: sha(Buffer.alloc(400)), source_bytes: 400,
      section_count: 1, sections: [{ position: 1, unit: kind === 'docx' ? 'paragraph' : 'slide', ...record }], extraction_status: 'available', coverage: { state: 'partial', reasons: officeReasons } } };
  }
  const root = f.store.createSource({ label: descriptor.label, descriptor }); f.store.saveSourceInventory(root.id, inventory);
  const entry = f.store.importSourceEntry({ source_id: root.id, inventory_id: inventoryId, entry_id: id, title, version, text, sha256: sha(text), ...provenance });
  return { root, entry };
}

test('empty onboarding catalogue and report perform saved-record reads only and never claim setup complete', t => {
  const f = fixture(t); const before = f.store.integrity(); const catalogue = f.onboarding.catalog();
  for (const key of ['profile', 'source_entries', 'snapshots', 'documents', 'grants']) assert.deepEqual(catalogue[key], []);
  const preview = f.onboarding.preview(selected()); assert.equal(preview.overall, 'awaiting_student');
  assert.ok(preview.coverage.every(row => row.state === 'not_requested')); assert.equal(preview.pins.length, 0);
  assert.deepEqual(f.store.integrity(), before); assert.equal(JSON.stringify(preview).includes('complete'), false);
  const expected = f.onboarding.preview(selected({ requested: ['profile', 'local_files', 'academic_exports', 'agent_bridge'] }));
  assert.ok(expected.coverage.every(row => row.state === 'awaiting_student')); assert.equal(save(f, expected).needs_refresh, false);
  assert.equal(f.store.listTasks().length, 0); assert.equal(f.store.listDocuments().length, 0); assert.equal(f.store.listAgentGrants().length, 0); assert.equal(f.store.listSources().length, 0);
});

test('profile candidates, conflicts, expiry and unrelated purposes remain unresolved without confirming facts', t => {
  const f = fixture(t); const candidate = profile(f, 'Candidate preference', false);
  let preview = f.onboarding.preview(selected({ requested: ['profile'], profile_ids: [candidate.id] }));
  assert.equal(coverage(preview, 'profile').state, 'awaiting_student'); save(f, preview); assert.equal(f.student.listProfiles()[0].data.state, 'candidate');
  const first = profile(f, 'One preference'); preview = f.onboarding.preview(selected({ requested: ['profile'], profile_ids: [first.id] })); assert.equal(preview.overall, 'review_ready');
  const second = profile(f, 'Conflicting preference'); preview = f.onboarding.preview(selected({ requested: ['profile'], profile_ids: [first.id, second.id] }));
  assert.equal(coverage(preview, 'profile').state, 'awaiting_student'); assert.ok(coverage(preview, 'profile').items.every(item => item.conflict));
  assert.equal(coverage(f.onboarding.preview(selected({ purpose: 'budget', requested: ['profile'], profile_ids: [first.id] })), 'profile').state, 'awaiting_student');
  const expiry = new Date(Date.now() + 60000).toISOString(); const expiring = f.student.createProfile({ field: 'goals', value: 'Time-limited goal', expires_at: expiry });
  const view = f.student.listProfiles().find(item => item.id === expiring.id); f.student.reviewProfile(view.id, { expected_revision: view.revision, fingerprint: view.fingerprint, decision: 'confirm' });
  f.advance(120000); assert.equal(coverage(f.onboarding.preview(selected({ requested: ['profile'], profile_ids: [expiring.id] })), 'profile').state, 'stale');
});

test('metadata catalogue and saved report omit values, source/note/course bodies, original paths and parser sections', t => {
  const f = fixture(t); const fact = profile(f), imported = source(f, 'docx'), course = academic(f);
  const note = f.store.createDocument({ title: 'Private context note', text: 'NOTE_BODY_CANARY' });
  const grant = f.store.createAgentGrant({ destination: 'codex', document_ids: [note.document.id], source_entry_ids: [imported.entry.id], max_bytes: 10000, expires_in_minutes: 5 });
  const preview = f.onboarding.preview(selected({ requested: ['profile', 'local_files', 'academic_exports', 'agent_bridge'], profile_ids: [fact.id], source_entry_ids: [imported.entry.id],
    snapshot_ids: [course.snapshot.id], document_ids: [note.document.id], agent_grant_ids: [grant.id], destination: 'codex' }));
  const saved = save(f, preview); const payload = JSON.stringify([f.onboarding.catalog(), preview, saved, f.onboarding.listReports()]);
  for (const canary of ['PROFILE_VALUE_CANARY', 'SOURCE_BODY_CANARY', 'ACADEMIC_BODY_CANARY', 'NOTE_BODY_CANARY', 'PATH_CANARY']) assert.equal(payload.includes(canary), false, canary);
  for (const key of ['"sections"', '"pages"', '"text"', '"value"', '"descriptor"']) assert.equal(payload.includes(key), false, key);
  assert.equal(coverage(preview, 'local_files').state, 'partial'); assert.equal(coverage(preview, 'agent_bridge').state, 'partial');
  assert.equal(coverage(preview, 'agent_bridge').items.find(item => item.kind === 'agent_grant').live_turn, 'not_checked'); assert.equal(f.store.getAgentGrant(grant.id).used_bytes, 0);
});

test('text, PDF, DOCX and PPTX keep exact saved-snapshot coverage without claiming original freshness', t => {
  const f = fixture(t);
  for (const kind of ['markdown', 'pdf', 'docx', 'pptx']) {
    const imported = source(f, kind); const preview = f.onboarding.preview(selected({ requested: ['local_files'], source_entry_ids: [imported.entry.id] }));
    const row = coverage(preview, 'local_files'); assert.equal(row.state, kind === 'markdown' ? 'ready' : 'partial');
    assert.equal(row.items[0].origin_freshness, 'not_checked'); assert.equal(row.items[0].coverage_claim, 'saved_text_snapshot');
    assert.match(row.limitations[0], /original file freshness.*not checked/); assert.equal(save(f, preview).needs_refresh, false);
  }
});

test('revoked local source rejects a new stale save with zero reports and is excluded from catalogue', t => {
  const f = fixture(t), imported = source(f); const chosen = selected({ requested: ['local_files'], source_entry_ids: [imported.entry.id] }); const preview = f.onboarding.preview(chosen);
  f.store.revokeSource(imported.root.id, imported.root.revision);
  denied(() => save(f, preview), 'REVISION_CONFLICT'); denied(() => f.onboarding.preview(chosen), 'SCOPE_DENIED');
  assert.equal(f.onboarding.listReports().length, 0); assert.equal(f.onboarding.catalog().source_entries.length, 0);
});

test('unchanged academic observation advances its head and invalidates an unsaved reviewed report', t => {
  const f = fixture(t); const first = academic(f); const chosen = selected({ requested: ['academic_exports'], snapshot_ids: [first.snapshot.id] }); const preview = f.onboarding.preview(chosen);
  const second = academic(f, 1); assert.equal(second.snapshot.id, first.snapshot.id); assert.equal(second.status, 'unchanged');
  denied(() => save(f, preview), 'REVISION_CONFLICT'); assert.equal(f.onboarding.listReports().length, 0);
  const fresh = f.onboarding.preview(chosen); assert.equal(fresh.pins[0].stream_revision, second.stream.revision);
  assert.equal(coverage(fresh, 'academic_exports').items[0].coverage_claim, 'source_reported'); save(f, fresh);
});

test('historical and forgotten academic selections never enter a current onboarding report', t => {
  const f = fixture(t); const first = academic(f); const second = academic(f, 1, true);
  denied(() => f.onboarding.preview(selected({ requested: ['academic_exports'], snapshot_ids: [first.snapshot.id] })), 'SCOPE_DENIED');
  const chosen = selected({ requested: ['academic_exports'], snapshot_ids: [second.snapshot.id] }); const saved = save(f, f.onboarding.preview(chosen));
  f.student.forgetSnapshot(second.snapshot.id, 1, { expected_stream_revision: second.stream.revision });
  denied(() => f.onboarding.preview(chosen), 'SCOPE_DENIED'); assert.equal(f.onboarding.getReport(saved.id).needs_refresh, true);
});

test('corrected profile and changed note reject previously unsaved reports without unrelated changes', t => {
  for (const kind of ['profile', 'note']) {
    const f = fixture(t); const fact = profile(f); const note = f.store.createDocument({ title: 'Selected note', text: 'Original private note' });
    const chosen = kind === 'profile' ? selected({ requested: ['profile'], profile_ids: [fact.id] }) : selected({ requested: ['agent_bridge'], document_ids: [note.document.id] });
    const preview = f.onboarding.preview(chosen);
    if (kind === 'profile') { const view = f.student.listProfiles()[0]; f.student.reviewProfile(view.id, { expected_revision: view.revision, fingerprint: view.fingerprint, decision: 'correct', value: 'Correction' }); }
    else f.store.updateDocument(note.document.id, { text: 'Changed private note' }, note.document.revision);
    denied(() => save(f, preview), 'REVISION_CONFLICT'); assert.equal(f.onboarding.listReports().length, 0); assert.equal(f.store.listTasks().length, 0); assert.equal(f.store.listAgentGrants().length, 0);
  }
});

test('existing grants are revalidated without context use; changed underlying records and expiry invalidate save', t => {
  for (const change of ['note', 'expiry', 'revoke']) {
    const f = fixture(t); const note = f.store.createDocument({ title: 'Shared note', text: 'Private grant content' });
    const grant = f.store.createAgentGrant({ destination: 'codex', document_ids: [note.document.id], max_bytes: 10000, expires_in_minutes: 1 });
    const chosen = selected({ requested: ['agent_bridge'], destination: 'codex', agent_grant_ids: [grant.id] }); const preview = f.onboarding.preview(chosen);
    assert.equal(coverage(preview, 'agent_bridge').state, 'partial'); assert.equal(f.store.getAgentGrant(grant.id).used_bytes, 0);
    if (change === 'note') f.store.updateDocument(note.document.id, { text: 'A changed source' }, note.document.revision);
    if (change === 'expiry') f.advance(120000);
    if (change === 'revoke') f.store.revokeAgentGrant(grant.id, grant.revision);
    denied(() => save(f, preview), 'REVISION_CONFLICT'); assert.equal(f.onboarding.listReports().length, 0);
    assert.equal(coverage(f.onboarding.preview(chosen), 'agent_bridge').state, 'stale'); assert.equal(f.store.getAgentGrant(grant.id).used_bytes, 0);
  }
});

test('strict onboarding selection rejects unknown fields, incompatible categories, duplicates and hostile input without reads', t => {
  const f = fixture(t); let getters = 0; const hostile = selected(); Object.defineProperty(hostile, 'requested', { enumerable: true, get() { getters++; return []; } });
  denied(() => f.onboarding.preview(hostile), 'INVALID_INPUT'); assert.equal(getters, 0);
  const id = randomUUID(); const invalid = [selected({ command: 'scan laptop' }), selected({ purpose: 'all' }), selected({ requested: ['profile', 'profile'] }),
    selected({ profile_ids: [id] }), selected({ profile_ids: null }), selected({ requested: ['profile'], profile_ids: [id, id.toUpperCase()] }),
    selected({ requested: ['agent_bridge'], agent_grant_ids: [id] }), selected({ destination: 'codex' }), selected({ requested: ['agent_bridge'], destination: 'unofficial' }),
    selected({ requested: ['profile'], profile_ids: new Array(2) }), Object.assign(Object.create({ inherited: true }), selected()),
    { ...selected(), [Symbol('extra')]: true }];
  for (const input of invalid) denied(() => f.onboarding.preview(input), 'INVALID_INPUT');
  const cyclic = selected(); cyclic.profile_ids = [cyclic]; denied(() => f.onboarding.preview(cyclic), 'INVALID_INPUT');
  denied(() => f.onboarding.preview(selected({ requested: ['profile', 'local_files'], profile_ids: Array.from({ length: 40 }, randomUUID), source_entry_ids: [randomUUID()] })), 'BUDGET_EXCEEDED');
  assert.equal(f.store.listWorkspaceRecords().length, 0);
});

test('forged coverage, altered exact pins and recomputed malicious review hashes cannot create reports', t => {
  const f = fixture(t); const original = f.onboarding.preview(selected({ requested: ['profile'] }));
  denied(() => f.onboarding.save(original, { review_hash: 'a'.repeat(64), idempotency_key: randomUUID() }), 'REVISION_CONFLICT');
  for (const mutate of [p => { p.coverage[0].state = 'ready'; }, p => { p.overall = 'review_ready'; }, p => { p.pins = [{ kind: 'profile_fact', id: randomUUID(), revision: 1 }]; }]) {
    const forged = structuredClone(original); mutate(forged); const { review_hash: _hash, ...payload } = forged; forged.review_hash = lifeHash(payload);
    denied(() => save(f, forged), 'REVISION_CONFLICT');
  }
  denied(() => save(f, { ...original, extra: 'injected' }), 'INVALID_INPUT');
  let calls = 0; const hostile = { ...original }; Object.defineProperty(hostile, 'coverage', { enumerable: true, get() { calls++; return original.coverage; } });
  denied(() => save(f, hostile), 'INVALID_INPUT'); assert.equal(calls, 0); assert.equal(f.onboarding.listReports().length, 0);
});

test('canonical selections and exact retries retain one report; changed-key reuse is rejected and stale history is explicit', t => {
  const f = fixture(t); const one = profile(f, 'Preference'), two = profile(f, 'Preference');
  const chosen = selected({ requested: ['profile'], profile_ids: [two.id.toUpperCase(), one.id] });
  const preview = f.onboarding.preview(chosen); assert.deepEqual(preview.selection.profile_ids, [one.id, two.id].sort());
  const key = randomUUID(); const saved = save(f, preview, key); assert.equal(save(f, preview, key).id, saved.id); assert.equal(f.onboarding.listReports().length, 1);
  denied(() => save(f, f.onboarding.preview(selected()), key), 'REVISION_CONFLICT');
  const view = f.student.listProfiles().find(item => item.id === one.id); f.student.reviewProfile(one.id, { expected_revision: view.revision, fingerprint: view.fingerprint, decision: 'correct', value: 'Changed preference' });
  const retry = save(f, preview, key); assert.equal(retry.id, saved.id); assert.equal(retry.needs_refresh, true); assert.equal(f.onboarding.listReports().length, 1);
  assert.deepEqual(retry.data, saved.data);
});

test('wrong-kind and foreign-workspace IDs cannot be selected or used to read or delete reports', t => {
  const f = fixture(t); const task = f.store.createTask({ title: 'Synthetic task' });
  denied(() => f.onboarding.preview(selected({ requested: ['profile'], profile_ids: [task.id] })), 'SCOPE_DENIED');
  denied(() => f.onboarding.getReport(task.id), 'SCOPE_DENIED'); denied(() => f.onboarding.forgetReport(task.id, 1), 'SCOPE_DENIED');
  const saved = save(f, f.onboarding.preview(selected())); const other = LocalStore.open({ root: join(f.parent, 'other') });
  try {
    const isolated = createOnboardingWorkspace(other, { studentWorkspace: createStudentWorkspace(other) });
    denied(() => isolated.getReport(saved.id), 'SCOPE_DENIED'); denied(() => isolated.preview(selected({ requested: ['profile'], profile_ids: [task.id] })), 'SCOPE_DENIED');
    assert.equal(isolated.listReports().length, 0);
  } finally { other.close(); }
});

test('restart and a real fresh backup restore preserve exact reviewed reports and computed refresh evidence', async t => {
  const f = fixture(t); const fact = profile(f); const chosen = selected({ requested: ['profile'], profile_ids: [fact.id] }); const preview = f.onboarding.preview(chosen), key = randomUUID();
  const saved = save(f, preview, key); f.restart(); assert.deepEqual(f.onboarding.getReport(saved.id), saved); assert.equal(save(f, preview, key).id, saved.id);
  const view = f.student.listProfiles()[0]; f.student.reviewProfile(view.id, { expected_revision: view.revision, fingerprint: view.fingerprint, decision: 'correct', value: 'Changed after review' });
  const expected = f.onboarding.getReport(saved.id); assert.equal(expected.needs_refresh, true);
  const backup = join(f.parent, 'backup'); await f.store.backup(backup); const restoredRoot = join(f.parent, 'restored'); await LocalStore.restore({ backupRoot: backup, root: restoredRoot });
  const restored = LocalStore.open({ root: restoredRoot });
  try {
    const onboarding = createOnboardingWorkspace(restored, { studentWorkspace: createStudentWorkspace(restored) });
    assert.deepEqual(onboarding.getReport(saved.id), expected); assert.equal(onboarding.getReport(saved.id).data.review_hash, preview.review_hash);
  } finally { restored.close(); }
});

test('forgetting a report requires its exact revision, refuses retry resurrection and leaves other records untouched', t => {
  const f = fixture(t), fact = profile(f), imported = source(f); const note = f.store.createDocument({ title: 'Preserved note', text: 'Preserved content' });
  const task = f.store.createTask({ title: 'Preserved task' }); const grant = f.store.createAgentGrant({ destination: 'codex', task_ids: [task.id], max_bytes: 10000, expires_in_minutes: 5 });
  const preview = f.onboarding.preview(selected({ requested: ['profile'], profile_ids: [fact.id] })), key = randomUUID(); const saved = save(f, preview, key);
  const before = { task: f.store.getTask(task.id), source: f.store.getSource(imported.root.id), entry: f.store.getSourceEntry(imported.entry.id), profile: f.student.listProfiles(),
    note: f.store.getDocument(note.document.id), grant: f.store.getAgentGrant(grant.id) };
  denied(() => f.onboarding.forgetReport(saved.id, 2), 'REVISION_CONFLICT'); f.onboarding.forgetReport(saved.id, saved.revision);
  denied(() => save(f, preview, key), 'REVISION_CONFLICT');
  assert.equal(f.onboarding.listReports().length, 0); denied(() => f.onboarding.getReport(saved.id), 'SCOPE_DENIED');
  assert.deepEqual({ task: f.store.getTask(task.id), source: f.store.getSource(imported.root.id), entry: f.store.getSourceEntry(imported.entry.id), profile: f.student.listProfiles(),
    note: f.store.getDocument(note.document.id), grant: f.store.getAgentGrant(grant.id) }, before);
});

test('active reports are capped before writing, and forgetting one permits a new explicit report', t => {
  const f = fixture(t); const preview = f.onboarding.preview(selected()); let first;
  for (let index = 0; index < 128; index++) { const record = save(f, preview, `synthetic-report-${index}`); first ??= record; }
  const before = f.store.integrity(); denied(() => save(f, preview), 'BUDGET_EXCEEDED'); assert.deepEqual(f.store.integrity(), before);
  assert.equal(save(f, preview, 'synthetic-report-0').id, first.id);
  f.onboarding.forgetReport(first.id, first.revision); assert.equal(f.onboarding.listReports().length, 127);
  save(f, preview, 'synthetic-report-after-forget'); assert.equal(f.onboarding.listReports().length, 128);
});

test('oversized preview data is refused before any report write', t => {
  const f = fixture(t); const preview = f.onboarding.preview(selected()); const before = f.store.integrity();
  preview.coverage[0].limitations.push('x'.repeat(64000)); const { review_hash: _hash, ...payload } = preview; preview.review_hash = lifeHash(payload);
  denied(() => save(f, preview), 'BUDGET_EXCEEDED'); assert.deepEqual(f.store.integrity(), before); assert.equal(f.onboarding.listReports().length, 0);
});

function nearLimitPreview(f, extra = {}) {
  const largeReasons = ['layout_not_preserved', ...Array.from({ length: 19 }, (_, index) => String.fromCharCode(97 + index).repeat(80))];
  const ids = []; let closest;
  for (let index = 0; index < 40; index++) {
    const imported = source(f, 'docx', largeReasons);
    try { closest = f.onboarding.preview(selected({ requested: ['local_files'], ...extra, source_entry_ids: [...ids, imported.entry.id] })); ids.push(imported.entry.id); }
    catch (error) { assert.equal(error.code, 'BUDGET_EXCEEDED'); break; }
  }
  for (let count = 0; count < 20; count++) {
    const imported = source(f, 'docx', largeReasons.slice(0, count + 1));
    try {
      const candidate = f.onboarding.preview(selected({ requested: ['local_files'], ...extra, source_entry_ids: [...ids, imported.entry.id] }));
      if (Buffer.byteLength(JSON.stringify(candidate)) > Buffer.byteLength(JSON.stringify(closest))) closest = candidate;
    } catch (error) { assert.equal(error.code, 'BUDGET_EXCEEDED'); }
  }
  const padding = 63850 - Buffer.byteLength(JSON.stringify(closest)); assert.ok(padding >= 0 && padding < 480, String(padding));
  const expanded = source(f, 'docx', largeReasons, padding);
  closest = f.onboarding.preview(selected({ requested: ['local_files'], ...extra, source_entry_ids: closest.selection.source_entry_ids.map(id => id === ids[0] ? expanded.entry.id : id) }));
  const previewBytes = Buffer.byteLength(JSON.stringify(closest)); assert.equal(previewBytes, 63850);
  return closest;
}
test('near-limit reviewed metadata saves and reads back after report receipt overhead exceeds preview byte limit', t => {
  const f = fixture(t); const closest = nearLimitPreview(f);
  const saved = save(f, closest); assert.ok(Buffer.byteLength(JSON.stringify(saved.data)) > 64000); assert.equal(saved.needs_refresh, false);
  assert.deepEqual(f.onboarding.getReport(saved.id), saved); assert.deepEqual(f.onboarding.listReports(), [saved]); f.restart(); assert.deepEqual(f.onboarding.getReport(saved.id), saved);
});

test('current metadata growing beyond preview budget marks retained reports stale without breaking their historical readback', t => {
  const f = fixture(t); const note = f.store.createDocument({ title: 'N', text: 'Private selected note' });
  const original = nearLimitPreview(f, { requested: ['local_files', 'agent_bridge'], document_ids: [note.document.id] });
  const saved = save(f, original); assert.equal(saved.needs_refresh, false);
  f.store.updateDocument(note.document.id, { title: 'N'.repeat(500) }, note.document.revision);
  denied(() => f.onboarding.preview(original.selection), 'BUDGET_EXCEEDED');
  const retained = f.onboarding.getReport(saved.id); assert.equal(retained.needs_refresh, true);
  assert.deepEqual(retained.refresh_reasons, ['selected_metadata_now_exceeds_review_budget']); assert.deepEqual(retained.data, saved.data);
  assert.deepEqual(f.onboarding.listReports(), [retained]); f.restart(); assert.deepEqual(f.onboarding.getReport(saved.id), retained);
  // Invalid historical evidence remains a hard failure outside the current-build
  // catch. The reporting fallback cannot bless a forged stored review.
  const corrupt = structuredClone(saved.data); corrupt.review_hash = 'b'.repeat(64);
  f.store.updateWorkspaceRecord(saved.id, { expected_revision: 1, data: corrupt });
  denied(() => f.onboarding.getReport(saved.id), 'VERSION_MISMATCH');
});

test('catalogue limits are explicit and never expand record selections automatically', t => {
  const f = fixture(t);
  for (let index = 0; index < 201; index++) f.store.createDocument({ title: `Private note ${index}`, text: 'PRIVATE_NOTE_BODY' });
  const catalogue = f.onboarding.catalog(); assert.equal(catalogue.documents.length, 200);
  assert.deepEqual(catalogue.catalogue_coverage, { state: 'partial', reasons: ['documents_catalogue_limit'] });
  assert.equal(JSON.stringify(catalogue).includes('PRIVATE_NOTE_BODY'), false); assert.equal(f.onboarding.preview(selected()).pins.length, 0);
});

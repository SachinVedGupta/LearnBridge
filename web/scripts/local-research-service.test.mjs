import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { createResearchService } from '../apps/local-runtime/src/research-service.mjs';
import { handleResearchRoute } from '../apps/local-runtime/src/research-routes.mjs';

function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-research-')), root = join(parent, 'workspace'); let store = LocalStore.open({ root, timezone: 'America/Toronto' });
  t.after(() => { store.close(); rmSync(parent, { recursive: true, force: true }); });
  return { root, get store() { return store; }, get service() { return createResearchService({ store }); }, restart() { store.close(); store = LocalStore.open({ root, timezone: 'America/Toronto' }); }, close() { store.close(); } };
}
const sourceInput = (excerpt = 'PRIVATE_RESEARCH_CANARY: Recursion requires a base case.') => ({ kind: 'manual_url', url: 'https://www.mcmaster.ca/research?topic=recursion#intro', title: 'Selected official passage', excerpt, official_source_declared: true, publisher: 'Student-declared publisher', published_at: '2026-10-01', section_label: 'Student-declared introduction', tags: ['algorithms'] });
const cite = (source, quote) => { const version = source.data.versions.at(-1), start = version.input.excerpt.indexOf(quote); return { source_id: source.id, source_revision: source.revision, source_hash: version.version_hash, quote, range: { start, end: start + quote.length } }; };
const reportInput = source => ({ title: 'Recursion evidence report', claims: [{ id: 'base-case', text: 'A base case is necessary.', kind: 'factual', evidence: [cite(source, 'Recursion requires a base case.')], relationship: 'supports' }], tags: ['study'], open_questions: ['Which inputs reach the base case?'] });
const reportReview = record => ({ expected_revision: record.revision, report_hash: record.data.report_hash });
const previewReview = preview => ({ preview_id: preview.id, expected_preview_revision: preview.revision, preview_hash: preview.data.preview_hash });
const code = (fn, expected) => assert.throws(fn, error => error.code === expected);

test('RS01 unchanged captures reuse one source; revised passages retain versions and replay survives a fresh process', t => {
  const f = fixture(t), first = f.service.captureSource(sourceInput(), { idempotencyKey: 'research-capture-one' }); const duplicate = f.service.captureSource(sourceInput()); assert.equal(first.id, duplicate.id); assert.equal(duplicate.revision, 1); assert.equal(f.service.captureSource(sourceInput(), { idempotencyKey: 'research-capture-one' }).id, first.id);
  const changed = f.service.captureSource(sourceInput('Recursion requires a base case. A new revision adds progress.')); assert.equal(changed.id, first.id); assert.equal(changed.revision, 2); assert.equal(changed.data.versions.length, 2); assert.equal(f.service.listSources().length, 1);
  code(() => f.service.captureSource(sourceInput(), { idempotencyKey: 'research-capture-one' }), 'REVISION_CONFLICT');
  const report = f.service.createReport(reportInput(changed), { idempotencyKey: 'research-report-one' }); assert.equal(f.service.createReport(reportInput(changed), { idempotencyKey: 'research-report-one' }).id, report.id); f.restart(); assert.equal(f.service.getSource(first.id).data.versions.length, 2); assert.equal(f.service.getReport(report.id).data.report_hash, report.data.report_hash);
  f.close(); const script = `import {LocalStore} from ${JSON.stringify(new URL('../packages/local-storage/src/index.mjs', import.meta.url).href)};import {createResearchService} from ${JSON.stringify(new URL('../apps/local-runtime/src/research-service.mjs', import.meta.url).href)};const store=LocalStore.open({root:process.argv[1],timezone:'America/Toronto'});const service=createResearchService({store});console.log(JSON.stringify({sources:service.listSources().length,reports:service.listReports().length,versions:service.getSource(${JSON.stringify(first.id)}).data.versions.length}));store.close();`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, f.root], { encoding: 'utf8', timeout: 10000 }); assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { sources: 1, reports: 1, versions: 2 }); f.restart();
});

test('RS02 manual URL capture never fetches and remains explicitly unverified/unknown freshness', t => {
  const f = fixture(t), original = globalThis.fetch; let calls = 0; globalThis.fetch = () => { calls++; throw new Error('Network forbidden'); }; t.after(() => { globalThis.fetch = original; });
  const source = f.service.captureSource(sourceInput()), report = f.service.createReport(reportInput(source)), preview = f.service.previewExport(report.id, reportReview(report));
  assert.equal(calls, 0); assert.equal(source.data.versions[0].input.independently_retrieved, false); assert.equal(source.data.versions[0].input.publisher_verified, false); assert.equal(source.data.versions[0].input.freshness, 'unknown'); assert.equal(report.data.report.factual_verification, 'not_independently_established'); assert.match(preview.data.preview.markdown, /remote freshness and publisher identity are unverified/);
  for (const url of ['http://www.mcmaster.ca/', 'https://127.0.0.1/', 'https://[::1]/', 'https://local.internal/', 'https://username:password@www.mcmaster.ca/', 'file:///private', 'https://www.mcmaster.ca/?api_key=secret', 'https://www.mcmaster.ca:9443/']) code(() => f.service.captureSource({ ...sourceInput(), url }), 'SCOPE_DENIED');
  code(() => f.service.captureSource({ ...sourceInput(), official_source_declared: false }), 'CONSENT_REQUIRED'); code(() => f.service.captureSource({ ...sourceInput(), published_at: '2026-02-31' }), 'INVALID_INPUT');
});

test('RS03 exact current local note ranges are verified without taking unrelated note content', t => {
  const f = fixture(t), note = f.store.createDocument({ title: 'My current study note', text: 'PRIVATE_UNSELECTED_PREFIX. Selected evidence is a base case. PRIVATE_UNSELECTED_SUFFIX.' }); const start = note.text.indexOf('Selected'), end = note.text.indexOf(' PRIVATE_UNSELECTED_SUFFIX');
  const input = { kind: 'local_note', document_id: note.document.id, document_revision: note.document.revision, document_sha256: note.sha256, range: { start, end } }, source = f.service.captureSource(input); assert.equal(source.data.versions[0].input.excerpt, 'Selected evidence is a base case.'); assert.equal(JSON.stringify(source).includes('PRIVATE_UNSELECTED_PREFIX'), false); assert.equal(source.data.versions[0].input.retrieval, 'verified_local_document_range');
  code(() => f.service.captureSource({ ...input, document_sha256: 'a'.repeat(64) }), 'REVISION_CONFLICT'); f.store.updateDocument(note.document.id, { text: 'The source was changed.' }, note.document.revision); code(() => f.service.getSource(source.id), 'REVISION_CONFLICT'); assert.equal(f.service.listSources()[0].stale, true); assert.equal(JSON.stringify(f.service.listSources()).includes('Selected evidence'), false);
});

test('RS04 fabricated quote, nonexistent range, foreign source and changed evidence cannot be delivered as cited', t => {
  const f = fixture(t), source = f.service.captureSource(sourceInput()), input = reportInput(source), original = input.claims[0].evidence[0];
  for (const bad of [{ ...original, quote: 'Fabricated quote.' }, { ...original, range: { start: 999, end: 1000 } }, { ...original, source_revision: 999 }, { ...original, source_hash: 'a'.repeat(64) }]) code(() => f.service.createReport({ ...input, claims: [{ ...input.claims[0], evidence: [bad] }] }), bad.source_revision === 999 || bad.source_hash !== original.source_hash ? 'REVISION_CONFLICT' : 'INVALID_INPUT');
  code(() => f.service.createReport({ ...input, claims: [{ ...input.claims[0], evidence: [] }] }), 'INVALID_INPUT'); code(() => f.service.createReport({ ...input, claims: [{ ...input.claims[0], evidence: [{ ...original, source_id: '00000000-0000-4000-8000-000000000000' }] }] }), 'SCOPE_DENIED');
  const report = f.service.createReport(input); f.service.captureSource(sourceInput('The official source supplied a newer selected passage.')); code(() => f.service.getReport(report.id), 'REVISION_CONFLICT'); code(() => f.service.previewExport(report.id, reportReview(report)), 'REVISION_CONFLICT'); assert.equal(f.service.listReports()[0].stale, true); assert.equal(JSON.stringify(f.service.listReports()).includes('PRIVATE_RESEARCH_CANARY'), false);
});

test('RS05 declared opposing claims stay unresolved; opinions do not become confirmed facts', t => {
  const f = fixture(t), source = f.service.captureSource(sourceInput()), input = reportInput(source), evidence = input.claims[0].evidence;
  const report = f.service.createReport({ title: 'Opposing source interpretations', claims: [{ ...input.claims[0], conflict_group: 'termination' }, { id: 'opposing', text: 'This contradicts my interpretation.', kind: 'factual', evidence, relationship: 'contradicts', conflict_group: 'termination' }, { id: 'opinion', text: 'I prefer iteration.', kind: 'opinion', evidence: [] }] });
  assert.equal(report.data.report.conflicts.length, 1); assert.equal(report.data.report.conflicts[0].resolution, 'unresolved_student_declared'); assert.equal(report.data.report.claims[2].kind, 'opinion'); const preview = f.service.previewExport(report.id, reportReview(report)); assert.match(preview.data.preview.markdown, /Unresolved declared conflicts/); assert.match(preview.data.preview.markdown, /student-declared|student_supplied_excerpt/); assert.match(preview.data.preview.markdown, /Factual verification: not independently established/);
});

test('RS06 exact saved preview export reads back and retries once after restart without granting AI sharing', t => {
  const f = fixture(t), source = f.service.captureSource(sourceInput()), report = f.service.createReport(reportInput(source)), preview = f.service.previewExport(report.id, reportReview(report)); assert.equal(f.service.previewExport(report.id, reportReview(report)).id, preview.id);
  code(() => f.service.exportReport(report.id, { ...previewReview(preview), preview_hash: 'b'.repeat(64) }), 'REVISION_CONFLICT'); code(() => f.service.exportReport(report.id, { ...previewReview(preview), approved: true }), 'INVALID_INPUT'); assert.equal(f.store.listDocuments().length, 0);
  const exported = f.service.exportReport(report.id, previewReview(preview)); assert.equal(exported.sharing, 'not_granted'); assert.equal(exported.verification, 'exact_local_readback'); assert.equal(f.store.getDocument(exported.document.id).text, preview.data.preview.markdown); assert.equal(createHash('sha256').update(preview.data.preview.markdown).digest('hex'), exported.text_sha256); assert.equal(f.store.listAgentGrants().length, 0); f.restart(); assert.equal(f.service.exportReport(report.id, previewReview(preview)).document.id, exported.document.id); assert.equal(f.store.listDocuments().length, 1);
  f.store.updateDocument(exported.document.id, { text: 'My subsequent edits must survive.' }, exported.document.revision); code(() => f.service.exportReport(report.id, previewReview(preview)), 'REVISION_CONFLICT'); assert.equal(f.store.getDocument(exported.document.id).text, 'My subsequent edits must survive.');
});

test('RS07 destination edited after preview blocks overwrite while the report and destination survive', t => {
  const f = fixture(t), source = f.service.captureSource(sourceInput()), report = f.service.createReport(reportInput(source)), target = f.store.createDocument({ title: 'Existing note', text: 'Original content.' });
  const destination = { document_id: target.document.id, revision: target.document.revision, sha256: target.sha256 }, preview = f.service.previewExport(report.id, { ...reportReview(report), destination, title: 'Reviewed replacement' }); f.store.updateDocument(target.document.id, { text: 'Concurrent human edit.' }, target.document.revision);
  code(() => f.service.exportReport(report.id, previewReview(preview)), 'REVISION_CONFLICT'); assert.equal(f.store.getDocument(target.document.id).text, 'Concurrent human edit.'); assert.equal(f.service.getReport(report.id).id, report.id); assert.equal(f.store.listWorkspaceRecords({ kind: 'research_item' }).filter(record => record.data.format === 'research_export_receipt').length, 0);
  const current = f.store.getDocument(target.document.id), fresh = f.service.previewExport(report.id, { ...reportReview(report), destination: { document_id: current.document.id, revision: current.document.revision, sha256: current.sha256 } }); assert.equal(f.service.exportReport(report.id, previewReview(fresh)).document.id, target.document.id);
});

test('RS08 forgotten source removes active derived reports; retained exported notes are explicitly reported', t => {
  const f = fixture(t), source = f.service.captureSource(sourceInput(), { idempotencyKey: 'forget-capture-key' }), report = f.service.createReport(reportInput(source)), preview = f.service.previewExport(report.id, reportReview(report)), exported = f.service.exportReport(report.id, previewReview(preview));
  code(() => f.service.forgetSource(source.id, 999), 'REVISION_CONFLICT'); const result = f.service.forgetSource(source.id, source.revision); assert.equal(result.removed_reports, 1); assert.deepEqual(result.retained_document_ids, [exported.document.id]); assert.match(result.retention, /Existing exported notes/); assert.deepEqual(f.service.listSources(), []); assert.deepEqual(f.service.listReports(), []); code(() => f.service.getReport(report.id), 'SCOPE_DENIED'); code(() => f.service.getSource(source.id), 'SCOPE_DENIED'); code(() => f.service.exportReport(report.id, previewReview(preview)), 'SCOPE_DENIED');
  assert.ok(f.store.getDocument(exported.document.id), 'The separately exported copy is retained as disclosed'); f.restart(); assert.deepEqual(f.service.listReports(), []); assert.equal(f.store.listWorkspaceRecords({ kind: 'research_item' }).some(record => ['research_source', 'research_report', 'research_capture', 'research_export_preview'].includes(record.data.format)), false);
});

test('RS09 removed local source invalidates export; no source can overwrite its own evidence note', t => {
  const f = fixture(t), note = f.store.createDocument({ title: 'Evidence note', text: 'Recursion requires a base case.' }), source = f.service.captureSource({ kind: 'local_note', document_id: note.document.id, document_revision: 1, document_sha256: note.sha256, range: { start: 0, end: note.text.length } }), report = f.service.createReport(reportInput(source));
  code(() => f.service.previewExport(report.id, { ...reportReview(report), destination: { document_id: note.document.id, revision: 1, sha256: note.sha256 } }), 'SCOPE_DENIED'); const preview = f.service.previewExport(report.id, reportReview(report)); f.store.deleteDocument(note.document.id, 1); code(() => f.service.exportReport(report.id, previewReview(preview)), 'REVISION_CONFLICT'); assert.equal(f.store.listDocuments().length, 0);
});

test('RS10 paired route contract rejects missing authority and forged fields, with bounded metadata-only lists', async t => {
  const f = fixture(t), params = { route: '/research/sources', method: 'GET', store: f.store, privateBody: async () => ({}) };
  await assert.rejects(handleResearchRoute(params), { code: 'AUTH_REQUIRED' }); assert.equal(await handleResearchRoute({ ...params, route: '/not-research' }), null);
  const session = { nonce: 'synthetic-paired-session' }, capture = await handleResearchRoute({ ...params, method: 'POST', session, privateBody: async () => sourceInput(), idempotencyKey: 'paired-source-fixture' }); assert.equal(capture.status, 201);
  const saved = await handleResearchRoute({ ...params, route: '/research/reports', method: 'POST', session, privateBody: async () => reportInput(capture.data.item) }); const preview = await handleResearchRoute({ ...params, route: `/research/reports/${saved.data.item.id}/export-preview`, method: 'POST', session, privateBody: async () => reportReview(saved.data.item) });
  const exported = await handleResearchRoute({ ...params, route: `/research/reports/${saved.data.item.id}/export`, method: 'POST', session, privateBody: async () => previewReview(preview.data.item) }); assert.equal(exported.data.verification, 'exact_local_readback'); const list = await handleResearchRoute({ ...params, session }); assert.equal(JSON.stringify(list).includes('PRIVATE_RESEARCH_CANARY'), false);
  code(() => f.service.captureSource({ ...sourceInput(), verified: true }), 'INVALID_INPUT'); let invoked = false; const bad = {}; Object.defineProperty(bad, 'source_id', { enumerable: true, get() { invoked = true; return capture.data.item.id; } }); const input = reportInput(capture.data.item); code(() => f.service.createReport({ ...input, claims: [{ ...input.claims[0], evidence: [bad] }] }), 'INVALID_INPUT'); assert.equal(invoked, false);
});

test('RS11 a write/readback mismatch stays unknown and never gets a verified receipt', t => {
  const f = fixture(t), source = f.service.captureSource(sourceInput()), report = f.service.createReport(reportInput(source)), preview = f.service.previewExport(report.id, reportReview(report)); const read = f.store.getDocument.bind(f.store); f.store.getDocument = recordId => { const value = read(recordId); return value ? { ...value, sha256: 'f'.repeat(64) } : value; };
  code(() => f.service.exportReport(report.id, previewReview(preview)), 'UNKNOWN_OUTCOME'); assert.equal(f.store.listDocuments().length, 1); assert.equal(f.store.listWorkspaceRecords({ kind: 'research_item' }).filter(record => record.data.format === 'research_export_receipt').length, 0); f.store.getDocument = read;
  const recovered = f.service.exportReport(report.id, previewReview(preview)); assert.equal(recovered.verification, 'exact_local_readback'); assert.equal(f.store.listDocuments().length, 1);
});

test('RS12 interrupted existing-note export never overwrites a changed destination on retry', t => {
  const f = fixture(t), source = f.service.captureSource(sourceInput()), report = f.service.createReport(reportInput(source)), target = f.store.createDocument({ title: 'Existing destination', text: 'Original' }), preview = f.service.previewExport(report.id, { ...reportReview(report), destination: { document_id: target.document.id, revision: 1, sha256: target.sha256 } });
  const create = f.store.createWorkspaceRecord.bind(f.store); f.store.createWorkspaceRecord = (input, options) => { if (input.data.format === 'research_export_receipt') throw new Error('Synthetic crash before receipt'); return create(input, options); }; assert.throws(() => f.service.exportReport(report.id, previewReview(preview)), /Synthetic crash/); f.store.createWorkspaceRecord = create; const saved = f.store.getDocument(target.document.id); assert.equal(saved.text, preview.data.preview.markdown); f.restart(); code(() => f.service.exportReport(report.id, previewReview(preview)), 'REVISION_CONFLICT'); assert.equal(f.store.getDocument(target.document.id).text, saved.text);
});

test('RS13 selected graded-note restrictions survive export and bounded source history rejects overflow', t => {
  const f = fixture(t), note = f.store.createDocument({ title: 'Graded scaffolding notes', text: 'Recursion requires a base case.', academic_policy: 'graded_restricted' }), selected = f.service.captureSource({ kind: 'local_note', document_id: note.document.id, document_revision: 1, document_sha256: note.sha256, range: { start: 0, end: note.text.length } }), report = f.service.createReport(reportInput(selected)), preview = f.service.previewExport(report.id, reportReview(report));
  assert.equal(preview.data.preview.academic_policy, 'graded_restricted'); const result = f.service.exportReport(report.id, previewReview(preview)); assert.equal(result.document.academic_policy, 'graded_restricted'); assert.equal(f.store.listAgentGrants().length, 0);
  let source; for (let i = 0; i < 8; i++) source = f.service.captureSource(sourceInput(`Bounded version ${i}.`)); assert.equal(source.data.versions.length, 8); code(() => f.service.captureSource(sourceInput('Overflow version.')), 'BUDGET_EXCEEDED'); assert.equal(f.service.getSource(source.id).data.versions.length, 8);
  code(() => f.service.captureSource(sourceInput('x'.repeat(8001))), 'INVALID_INPUT'); code(() => f.service.createReport({ title: 'Bounded', claims: Array.from({ length: 21 }, (_, i) => ({ id: `claim${i}`, text: 'Opinion', kind: 'opinion', evidence: [] })) }), 'INVALID_INPUT');
});

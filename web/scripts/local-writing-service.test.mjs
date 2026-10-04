import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { createWritingService } from '../apps/local-runtime/src/writing-service.mjs';
import { handleWritingRoute } from '../apps/local-runtime/src/writing-routes.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const code = (fn, value) => assert.throws(fn, error => error.code === value);
function fixture(t, policy = 'learning_support') {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-writing-')); const root = join(parent, 'workspace'); let store = LocalStore.open({ root });
  t.after(() => { store.close(); rmSync(parent, { recursive: true, force: true }); }); const source = store.createDocument({ title: 'Selected notes', text: 'Heading\nA😀B\nPRIVATE_WRITING_SOURCE_CANARY\n', academic_policy: policy }); store.createDocument({ title: 'Unselected notes', text: 'PRIVATE_UNSELECTED_CANARY' });
  const reference = { id: source.document.id, revision: source.document.revision, sha256: source.sha256 };
  return { parent, root, source, reference, get store() { return store; }, get service() { return createWritingService({ store }); }, restart() { store.close(); store = LocalStore.open({ root }); } };
}
function proposal(f, extra = {}, options) { return f.service.createProposal({ title: 'Reviewed draft', kind: 'revision', draft_text: 'Heading\nA😀C\nPRIVATE_WRITING_SOURCE_CANARY\n', source_documents: [f.reference], academic_policy: 'learning_support', origin: 'agent_paste', ...extra }, options); }
const review = record => ({ expected_revision: record.revision, payload_hash: record.data.payload_hash });

test('selected recipe is pinned/untrusted, excludes other documents, and exports one private note without sharing', t => {
  const f = fixture(t); const input = { title: 'Explain my note', kind: 'study_guide', request: 'Make a short outline.', source_documents: [f.reference], academic_policy: 'learning_support' };
  const created = f.service.createRecipe(input, { idempotencyKey: 'writing-recipe-fixture-1' }); assert.equal(created.data.recipe.context.length, 1); assert.equal(created.data.recipe.context[0].untrusted, true); assert.equal(JSON.stringify(created).includes('PRIVATE_UNSELECTED_CANARY'), false); assert.equal(created.data.recipe.provider_fallback, false); assert.ok(created.data.recipe.forbidden_operations.includes('shell')); assert.equal(f.service.createRecipe(input, { idempotencyKey: 'writing-recipe-fixture-1' }).id, created.id);
  const exported = f.service.exportRecipe(created.id, { expected_revision: created.revision, recipe_hash: created.data.recipe_hash }); assert.equal(exported.sharing, 'not_granted'); assert.equal(f.store.listAgentGrants().length, 0); const note = f.store.getDocument(exported.document.id); assert.equal(JSON.parse(note.text).recipe_hash, created.data.recipe_hash); assert.equal(f.service.exportRecipe(created.id, { expected_revision: created.revision, recipe_hash: created.data.recipe_hash }).document.id, exported.document.id);
  assert.equal(JSON.stringify(f.service.list()).includes('PRIVATE_WRITING_SOURCE_CANARY'), false);
});

test('unverified draft acceptance retains original and alternatives, is exact/idempotent and reopens verified Markdown', t => {
  const f = fixture(t); const created = proposal(f, {}, { idempotencyKey: 'writing-proposal-fixture-1' }); assert.equal(created.data.content_status, 'unverified_model_output'); assert.equal(proposal(f, {}, { idempotencyKey: 'writing-proposal-fixture-1' }).id, created.id);
  code(() => f.service.accept(created.id, { ...review(created), payload_hash: 'a'.repeat(64) }), 'REVISION_CONFLICT'); const accepted = f.service.accept(created.id, review(created)); assert.equal(accepted.data.state, 'accepted'); assert.equal(accepted.data.review_receipt.verification, 'exact_private_note_readback'); assert.equal(f.store.getDocument(f.source.document.id).text, f.source.text); assert.equal(f.store.listDocumentRevisions(f.source.document.id).length, 1); assert.equal(f.service.accept(created.id, review(created)).revision, 2);
  const exported = f.service.exportArtifact(created.id, review(accepted)); assert.ok(exported.filename.endsWith('.md')); assert.equal(exported.sha256, sha(exported.text)); assert.equal(exported.byte_length, Buffer.byteLength(exported.text)); assert.match(exported.text, /A😀C/); assert.match(exported.text, new RegExp(f.source.sha256)); assert.equal(exported.content_status, 'student_reviewed_model_output_facts_unverified'); f.restart(); assert.equal(f.service.accept(created.id, review(created)).revision, 2); assert.equal(f.service.exportArtifact(created.id, review(accepted)).sha256, exported.sha256);
});

test('exact reviewed revision preserves Unicode coordinates and immutable original history, without duplicate application', t => {
  const f = fixture(t); const created = proposal(f); assert.equal(created.data.diff.start_utf16, 'Heading\nA😀'.length); assert.equal(created.data.diff.original_excerpt, 'B'); assert.equal(created.data.diff.alternative_excerpt, 'C');
  const applied = f.service.acceptRevision(created.id, review(created)); assert.equal(applied.data.state, 'applied_revision'); assert.equal(f.store.getDocument(f.source.document.id).text, created.data.payload.draft_text); const history = f.store.listDocumentRevisions(f.source.document.id); assert.equal(history.length, 2); assert.equal(history[0].text, f.source.text); assert.equal(f.service.acceptRevision(created.id, review(created)).revision, 2); assert.equal(f.store.listDocumentRevisions(f.source.document.id).length, 2);
  f.restart(); assert.equal(f.service.get(created.id).data.state, 'applied_revision'); const exported = f.service.exportArtifact(created.id, review(applied)); assert.equal(exported.text, created.data.payload.draft_text); assert.equal(exported.sha256, created.data.payload.draft_sha256); assert.equal(f.service.acceptRevision(created.id, review(created)).revision, 2);
});

test('stale/removed source or an edited accepted artifact blocks approval/export and lists omit copied text', t => {
  const f = fixture(t); const created = proposal(f); f.store.updateDocument(f.source.document.id, { text: 'Student changed this source.' }, f.source.document.revision);
  code(() => f.service.accept(created.id, review(created)), 'REVISION_CONFLICT'); code(() => f.service.acceptRevision(created.id, review(created)), 'REVISION_CONFLICT'); code(() => f.service.get(created.id), 'REVISION_CONFLICT'); assert.equal(f.service.list()[0].state, 'stale'); assert.equal(JSON.stringify(f.service.list()).includes('PRIVATE_WRITING_SOURCE_CANARY'), false);
  const next = f.store.getDocument(f.source.document.id); const another = f.service.createProposal({ title: 'Fresh alternative', kind: 'outline', draft_text: 'Outline only', source_documents: [{ id: next.document.id, revision: next.document.revision, sha256: next.sha256 }], academic_policy: 'learning_support', origin: 'student' }); const accepted = f.service.accept(another.id, review(another)); f.store.updateDocument(accepted.data.accepted_note.id, { text: 'A different artifact copy.' }, accepted.data.accepted_note.revision); code(() => f.service.exportArtifact(another.id, review(accepted)), 'REVISION_CONFLICT'); assert.equal(f.service.list().find(row => row.id === another.id).state, 'stale');
});

test('graded restriction cannot be weakened and denies completed revisions while permitting clearly labelled scaffolding', t => {
  const f = fixture(t, 'graded_restricted'); code(() => proposal(f), 'SCOPE_DENIED'); code(() => proposal(f, { academic_policy: 'unrestricted', kind: 'markdown_artifact' }), 'SCOPE_DENIED'); const scaffold = proposal(f, { kind: 'outline', draft_text: 'Explain the concept, then list the questions you need to answer.', academic_policy: 'unrestricted' }); assert.equal(scaffold.data.academic_policy, 'graded_restricted'); code(() => f.service.acceptRevision(scaffold.id, review(scaffold)), 'SCOPE_DENIED'); const accepted = f.service.accept(scaffold.id, review(scaffold)); assert.equal(f.store.getDocument(accepted.data.accepted_note.id).document.academic_policy, 'graded_restricted'); assert.equal(f.store.getDocument(f.source.document.id).text, f.source.text);
});

test('failed receipt write reconciles one private alternative; exact reviewed source update resumes after restart', t => {
  const f = fixture(t); const created = proposal(f); const underlying = f.store; let failOnce = true; const failing = new Proxy(underlying, { get(target, prop) { if (prop === 'updateWorkspaceRecord') return (...args) => { if (failOnce) { failOnce = false; throw new Error('Synthetic receipt storage failure'); } return target.updateWorkspaceRecord(...args); }; const value = Reflect.get(target, prop, target); return typeof value === 'function' ? value.bind(target) : value; } });
  const service = createWritingService({ store: failing }); assert.throws(() => service.accept(created.id, review(created)), /Synthetic receipt/); assert.equal(f.store.listDocuments().length, 3); const accepted = service.accept(created.id, review(created)); assert.equal(accepted.data.state, 'accepted'); assert.equal(f.store.listDocuments().length, 3);
  const next = proposal(f, { title: 'Apply this source revision' }); failOnce = true; assert.throws(() => service.acceptRevision(next.id, review(next)), /Synthetic receipt/); assert.equal(f.store.getDocument(f.source.document.id).document.revision, 2); assert.equal(f.service.list().find(row => row.id === next.id).state, 'needs_reconciliation'); assert.throws(() => f.service.reject(next.id, review(next)), { code: 'REVISION_CONFLICT' }); f.restart(); const applied = f.service.acceptRevision(next.id, review(next)); assert.equal(applied.data.review_receipt.reconciled_existing_exact_revision, true); assert.equal(f.store.listDocumentRevisions(f.source.document.id).length, 2);
});

test('trusted host origin records grant identity; HTTP input cannot forge it and rejected drafts never apply', t => {
  const f = fixture(t); const grantId = randomUUID(); const created = proposal(f, {}, { agentOrigin: 'codex', grantId, idempotencyKey: 'codex-writing-fixture-1' }); assert.equal(created.data.agent_origin, 'codex'); assert.equal(created.data.grant_id, grantId); assert.equal(created.data.payload.origin, 'codex'); assert.equal(created.data.content_status, 'unverified_model_output');
  code(() => proposal(f, { origin: 'codex' }), 'INVALID_INPUT'); const rejected = f.service.reject(created.id, review(created)); assert.equal(rejected.data.state, 'rejected'); assert.equal(f.service.reject(created.id, review(created)).revision, 2); code(() => f.service.accept(created.id, review(rejected)), 'REVISION_CONFLICT'); assert.equal(f.store.getDocument(f.source.document.id).text, f.source.text);
});

test('route contract requires paired context; malformed fields/getters/unsupported formats do not produce artifacts', async t => {
  const f = fixture(t); const args = { route: '/writing/items', method: 'GET', privateBody: async () => ({}), store: f.store }; await assert.rejects(handleWritingRoute(args), error => error.code === 'AUTH_REQUIRED'); const listed = await handleWritingRoute({ ...args, session: { nonce: 'synthetic-paired-route' } }); assert.equal(listed.status, 200); assert.equal(listed.data.capabilities.pdf.state, 'unsupported'); assert.equal(listed.data.capabilities.docx.state, 'available'); assert.equal(listed.data.capabilities.docx.processing, 'local_literal_text'); assert.equal(listed.data.capabilities.docx.visual_review, 'pending'); assert.deepEqual(listed.data.capabilities.docx.limits, { text_bytes: 80000, paragraphs: 1000, output_bytes: 512000 }); assert.equal(listed.data.capabilities.external_writes, false);
  code(() => proposal(f, { send_email: true }), 'INVALID_INPUT'); code(() => proposal(f, { draft_text: '😀'.repeat(20000) }), 'BUDGET_EXCEEDED'); let invoked = false; const bad = {}; Object.defineProperty(bad, 'draft_text', { enumerable: true, get() { invoked = true; return 'Unexpected'; } }); code(() => f.service.createProposal(bad), 'INVALID_INPUT'); assert.equal(invoked, false); assert.equal(f.store.listWorkspaceRecords({ kind: 'artifact' }).length, 0);
});

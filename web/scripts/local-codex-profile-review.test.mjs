import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { LocalStore } from '@learnbridge/local-storage';
import { createCodexProfile } from '../apps/local-runtime/src/codex-profile.mjs';
import { createWritingService } from '../apps/local-runtime/src/writing-service.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const auth = { sessionId: 'synthetic-reviewed-browser', authorize: () => true };
/** A minimal native-adapter stand-in supplies model JSON. Its fixed client
 * tool calls use actual SQLite context/proposal and Writing services. This
 * proves the shipped profile controller's preflight and pending-review rules;
 * it does not prove native Codex, real MCP transport or model quality.
 */
function fixture(t, mutate, academicPolicy = 'learning_support') {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'learnbridge-codex-review-'))), store = LocalStore.open({ root: join(parent, 'workspace') });
  const source = store.createDocument({ title: 'Selected synthetic source', text: 'Student-authored source remains unchanged.', academic_policy: academicPolicy });
  const other = store.createDocument({ title: 'Unselected private source', text: 'UNSELECTED_PRIVATE_BODY_CANARY' });
  const grant = store.createAgentGrant({ destination: 'codex', document_ids: [source.document.id], max_bytes: 64000, expires_in_minutes: 5 });
  const output = { answer: 'This is an unverified synthetic suggestion.', task_proposals: [{ title: 'Review the selected concept', reason: 'Synthetic next learning step.' }],
    document_proposals: [{ source_document_id: source.document.id, source_revision: source.document.revision, source_sha256: source.sha256,
      title: 'Synthetic conceptual outline', draft: 'Explain the central idea in your own words.', purpose: 'outline', academic_policy: academicPolicy === 'graded_restricted' ? 'graded_scaffolding' : 'learning_support' }] };
  mutate?.(output, { source, other }); const calls = [], adapters = []; const writing = createWritingService({ store });
  const service = createCodexProfile({ store, executionMode: 'structured', profileRoot: join(parent, 'owned-codex-profile'), adapterFactory(input) {
    const adapter = { closed: false, project: input.projectRoot }; adapters.push(adapter);
    return { async initialize() { return { state: 'available' }; }, async startThread() { assert.equal(input.authorize(), true); },
      async callLearnBridgeTool(tool, args) {
        calls.push({ tool, args }); assert.equal(input.authorize(), true); let value;
        if (tool === 'learnbridge_status') value = { healthy: store.integrity().integrity === 'ok', destination: 'codex' };
        else if (tool === 'learnbridge_context') value = store.agentContext({ destination: 'codex', ...args });
        else if (tool === 'learnbridge_propose_task') value = store.proposeTask({ destination: 'codex', ...args });
        else if (tool === 'learnbridge_propose_document') {
          const pin = store.assertAgentDocumentSelection({ destination: 'codex', grant_id: args.grant_id, document_id: args.source_document_id, revision: args.source_revision, sha256: args.source_sha256 });
          value = writing.createProposal({ title: args.title, kind: { study_note: 'study_guide', outline: 'outline', revision: 'revision', general: 'markdown_artifact' }[args.purpose],
            draft_text: args.draft, source_documents: [{ id: pin.document_id, revision: pin.revision, sha256: pin.sha256 }], academic_policy: { learning_support: 'learning_support', graded_scaffolding: 'graded_restricted', not_applicable: 'unrestricted' }[args.academic_policy], origin: 'agent_paste' },
          { idempotencyKey: args.idempotency_key, agentOrigin: 'codex', grantId: args.grant_id });
        } else assert.fail('No native shell, browser, provider or other action is allowed.');
        return { value, receipt: { tool, status: 'completed', failed: false, result_hash: sha(JSON.stringify(value)), origin: 'runtime' } };
      },
      async startTurn(input) { assert.equal(input.outputSchema.additionalProperties, false); const context = JSON.parse(input.context);
        assert.deepEqual(context.documents.map(item => item.id), [source.document.id]); assert.equal(JSON.stringify(context).includes('UNSELECTED_PRIVATE_BODY_CANARY'), false);
        return { completion: Promise.resolve({ status: 'completed', turn_id: 'synthetic-reviewed-turn', text: JSON.stringify(output) }) };
      }, async close() { adapter.closed = true; } };
  } });
  t.after(async () => { await service.stop(); store.close(); rmSync(parent, { recursive: true, force: true }); });
  const originals = () => ({ documents: store.listDocuments().map(item => store.getDocument(item.id)), tasks: store.listTasks(), proposals: store.listTaskProposals(), workspace: store.listWorkspaceRecords() });
  return { service, store, grant, source, other, output, calls, adapters, originals,
    async execute() { await service.connect(auth); return service.execute({ grantId: grant.id, prompt: 'Suggest conceptual next steps and a private outline for review.', authorize: () => true }); } };
}

test('CPR01: unknown/unselected documents, invalid policy and forbidden graded purpose preflight every proposal before any pending write', async t => {
  const cases = [
    { name: 'unknown document', change: value => { value.document_proposals[0].source_document_id = randomUUID(); } },
    { name: 'unselected existing document', change: (value, { other }) => { Object.assign(value.document_proposals[0], { source_document_id: other.document.id, source_revision: other.document.revision, source_sha256: other.sha256 }); } },
    { name: 'invalid model-selected policy', change: value => { value.document_proposals[0].academic_policy = 'unrestricted'; } },
    { name: 'graded document forbids a completed revision despite weaker model policy', policy: 'graded_restricted', change: value => { value.document_proposals[0].purpose = 'revision'; value.document_proposals[0].academic_policy = 'not_applicable'; } },
  ];
  for (const item of cases) {
    const f = fixture(t, item.change, item.policy), before = f.originals(); await assert.rejects(f.execute(), error => ['SCOPE_DENIED','VERSION_MISMATCH','INVALID_INPUT'].includes(error.code), item.name);
    assert.deepEqual(f.originals(), before, item.name); assert.deepEqual(f.calls.map(call => call.tool), ['learnbridge_status','learnbridge_context'], item.name);
    assert.ok(f.adapters.every(adapter => adapter.closed)); assert.equal(f.store.listAgentGrants().length, 1);
    // The explicitly approved context read charges its existing byte budget;
    // rejection grants no new access and creates no proposal or user record.
    assert.ok(f.store.getAgentGrant(f.grant.id).used_bytes > 0);
  }
  const valid = fixture(t, undefined, 'graded_restricted'), before = valid.originals(); const result = await valid.execute();
  assert.equal(result.state, 'completed'); assert.match(result.text, /They have not been accepted/); assert.equal(valid.store.listTasks().length, 0);
  assert.equal(valid.store.listTaskProposals()[0].state, 'awaiting_review'); const writing = valid.store.listWorkspaceRecords().find(item => item.data.format === 'writing_proposal');
  assert.equal(writing.data.state, 'awaiting_review'); assert.equal(writing.data.academic_policy, 'graded_restricted'); assert.equal(writing.data.accepted_note, undefined);
  assert.deepEqual(valid.originals().documents, before.documents); assert.equal(valid.store.listDocuments().length, 2);
});

test('CPR02: invalid/extra action fields, malformed later proposals and excess action counts cannot write even an earlier valid proposal', async t => {
  const cases = [
    value => { value.send_email = { recipient: 'unselected@example.test' }; },
    value => { value.answer = 'CONTROL\u0001ANSWER'; },
    value => { value.task_proposals.push({ title: 'Invalid second task', reason: 'Synthetic', deadline: { precision: 'date', date: '2026-10-15' } }); },
    value => { value.document_proposals[0].accept = true; },
    value => { value.document_proposals[0].draft = { command: 'Never execute model source data' }; },
    value => { value.task_proposals.push({ title: 'Invalid later reason', reason: '' }); },
    value => { value.task_proposals.push({ title: 'Invalid later task', reason: 'CONTROL\u0001CHAR' }); },
    value => { value.document_proposals[0].draft = 'CONTROL\0DRAFT'; },
    value => { value.task_proposals.push(null); },
    value => { value.task_proposals.push(...Array.from({ length: 3 }, () => ({ title: 'Too many tasks', reason: 'Synthetic' }))); },
  ];
  for (const mutate of cases) {
    const f = fixture(t, mutate), before = f.originals(); await assert.rejects(f.execute(), error => ['VERSION_MISMATCH','INVALID_INPUT'].includes(error.code));
    assert.deepEqual(f.originals(), before); assert.deepEqual(f.calls.map(call => call.tool), ['learnbridge_status','learnbridge_context']); assert.ok(f.adapters.every(adapter => adapter.closed));
  }
});

test('CP08: a late account check cannot restore authority during official logout and a new connection is blocked until cleanup finishes', async t => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'learnbridge-codex-logout-review-')));
  const store = LocalStore.open({ root: join(parent, 'workspace') });
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  const accountRead = deferred(), accountStarted = deferred(), logout = deferred(), logoutStarted = deferred();
  const adapters = []; let cancelled = 0, loggedOut = 0;
  const service = createCodexProfile({ store, executionMode: 'structured', profileRoot: join(parent, 'owned-profile'), adapterFactory(input) {
    const state = { project: input.projectRoot, closed: false }; adapters.push(state);
    return {
      async initialize() { return { state: 'requires_auth' }; },
      async startLogin() { return { auth_url: 'https://auth.openai.com/synthetic-reviewed-login' }; },
      async accountStatus() { accountStarted.resolve(); await accountRead.promise; return { state: 'available' }; },
      async cancelLogin() { cancelled++; },
      async logoutAccount() { assert.equal(input.authorize(), true); logoutStarted.resolve(); await logout.promise; loggedOut++; },
      async close() { state.closed = true; },
    };
  } });
  t.after(async () => { accountRead.resolve(); logout.resolve(); await service.stop(); store.close(); rmSync(parent, { recursive: true, force: true }); });
  const before = { documents: store.listDocuments(), tasks: store.listTasks(), proposals: store.listTaskProposals(), workspace: store.listWorkspaceRecords(), grants: store.listAgentGrants() };
  await service.connect(auth);
  // A deliberately delayed synthetic native reply proves controller authority
  // independently of the real subprocess rejecting pending calls on close.
  const pendingCheck = service.check(auth); const checkRejected = assert.rejects(pendingCheck, { code: 'CONSENT_REQUIRED' });
  await accountStarted.promise;
  const pendingLogout = service.disconnect(auth); await logoutStarted.promise;
  assert.equal(service.status().state, 'requires_auth'); assert.equal(service.status().login_in_progress, false);
  await assert.rejects(service.connect(auth), { code: 'REVISION_CONFLICT' });
  assert.equal(adapters.length, 2);
  accountRead.resolve(); await checkRejected;
  assert.equal(service.status().state, 'requires_auth');
  logout.resolve(); assert.equal((await pendingLogout).state, 'requires_auth');
  assert.equal(cancelled, 1); assert.equal(loggedOut, 1);
  assert.ok(adapters.every(adapter => adapter.closed && !existsSync(adapter.project)));
  assert.deepEqual({ documents: store.listDocuments(), tasks: store.listTasks(), proposals: store.listTaskProposals(), workspace: store.listWorkspaceRecords(), grants: store.listAgentGrants() }, before);
});

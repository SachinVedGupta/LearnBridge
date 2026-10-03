import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { createInstallation } from '../packages/core/src/index.mjs';
import { LocalStore, STORAGE_SCHEMA_VERSION } from '../packages/local-storage/src/index.mjs';

const moduleUrl = new URL('../packages/local-storage/src/index.mjs', import.meta.url).href;
const source = readFileSync(new URL('../packages/local-storage/src/index.mjs', import.meta.url), 'utf8');
const v1 = /const MIGRATION = `([\s\S]*?)`;/u.exec(source)[1];
const v2 = /const MIGRATION_V2 = `([\s\S]*?)`;/u.exec(source)[1];
const sha = value => createHash('sha256').update(value).digest('hex');
const childEnv = Object.fromEntries(['PATH', 'TMPDIR', 'TEMP', 'TMP'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
const child = code => spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: new URL('..', import.meta.url), env: childEnv, encoding: 'utf8', timeout: 10000, maxBuffer: 1_000_000 });
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'learnbridge-workflow-storage-')); const root = join(base, 'data'); const store = LocalStore.open({ root });
  t.after(() => { try { store.close(); } catch {} rmSync(base, { recursive: true, force: true }); }); return { base, root, store };
}
const budget = { tool_calls: 10, model_calls: 2, bytes: 64000, max_duration_ms: 300000 };
function ready(store, input = {}) {
  let run = store.createRun({ recipe_id: 'synthetic.read', recipe_version: '1', input: { selected: 'synthetic' }, budget, ...input });
  run = store.transitionRun(run.id, { expected_revision: run.revision, state: 'validating' });
  return store.transitionRun(run.id, { expected_revision: run.revision, state: 'ready', checkpoint: { next_step: 0, resumable: true } });
}
function claim(store, run) { return store.claimRun(run.id, { expected_revision: run.revision, owner: randomUUID(), lease_ms: 300000 }); }
function mutation(run) { return { expected_revision: run.revision, owner: run.lease.owner, epoch: run.lease.epoch }; }
const verified = (id, key = 'read') => ({ status: 'passed', method: 'fixture.readback', expected_hash: sha('{"exact":"result"}'), observed_hash: sha('{"exact":"result"}'), evidence_ref: `fixture:${id}:${key}` });
function saveStep(store, run, key = 'read') {
  return store.putRunStep(run.id, { ...mutation(run), key, expected_step_revision: 0, kind: 'read', state: 'verified', input_hash: sha('input'), result: { exact: 'result' }, verification: verified(run.id, key) });
}
function proposal(store, run, extra = {}) {
  return store.proposeRunAction(run.id, { ...mutation(run), operation: 'fixture.send', account_ref: 'synthetic-account', target: { id: 'synthetic-target' }, payload: { body: 'Exact synthetic message' }, preconditions: { revision: 2 }, idempotency_key: 'synthetic_action_001', ...extra });
}

test('WF01 durable runs, steps, cumulative budgets, checkpoints and events survive a fresh process', t => {
  const { root, store } = fixture(t); let run = claim(store, ready(store, { idempotency_key: 'synthetic_run_001' }));
  run = store.chargeRunBudget(run.id, { ...mutation(run), tool_calls: 2, bytes: 100 });
  ({ run } = saveStep(store, run)); run = store.transitionRun(run.id, { ...mutation(run), state: 'running', checkpoint: { next_step: 1, resumable: true } });
  const events = store.listRunEvents(run.id); store.close(); const result = child(`import {LocalStore} from ${JSON.stringify(moduleUrl)}; const s=LocalStore.open({root:${JSON.stringify(root)}}); console.log(JSON.stringify({run:s.getRun(${JSON.stringify(run.id)}),steps:s.listRunSteps(${JSON.stringify(run.id)}),events:s.listRunEvents(${JSON.stringify(run.id)})}));s.close();`);
  assert.ifError(result.error); assert.equal(result.status, 0); const readback = JSON.parse(result.stdout); assert.deepEqual(readback.run, run); assert.equal(readback.steps.length, 1); assert.deepEqual(readback.events, events); assert.equal(readback.run.used.tool_calls, 2);
});

test('WF02 one-owner claim and stale lease/revision/epoch rejection', async t => {
  const { store } = fixture(t); const prepared = ready(store);
  const attempts = await Promise.allSettled(['first-owner', 'second-owner'].map(owner => Promise.resolve().then(() => store.claimRun(prepared.id, { expected_revision: prepared.revision, owner }))));
  assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1); assert.equal(attempts.find(a => a.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  const run = store.getRun(prepared.id); assert.throws(() => store.chargeRunBudget(run.id, { ...mutation(run), owner: 'other-owner', tool_calls: 1 }), { code: 'REVISION_CONFLICT' });
  assert.throws(() => store.chargeRunBudget(run.id, { ...mutation(run), epoch: run.lease.epoch + 1, tool_calls: 1 }), { code: 'REVISION_CONFLICT' });
  const charged = store.chargeRunBudget(run.id, { ...mutation(run), tool_calls: 1 }); assert.throws(() => store.chargeRunBudget(run.id, { ...mutation(run), tool_calls: 1 }), { code: 'REVISION_CONFLICT' }); assert.equal(charged.used.tool_calls, 1);
});

test('WF03 interrupted revalidation preserves budgets, lease epochs and immutable historical evidence', t => {
  const { root, store } = fixture(t); let run = claim(store, ready(store)); run = store.chargeRunBudget(run.id, { ...mutation(run), tool_calls: 2 }); ({ run } = saveStep(store, run));
  run = store.transitionRun(run.id, { ...mutation(run), state: 'interrupted', checkpoint: { next_step: 1, resumable: true } }); const oldEpoch = run.lease_epoch; store.close(); const reopened = LocalStore.open({ root });
  try {
    run = reopened.transitionRun(run.id, { expected_revision: run.revision, state: 'ready' }); run = claim(reopened, run); assert.equal(run.lease_epoch, oldEpoch + 1); assert.equal(run.used.tool_calls, 2);
    const original = reopened.listRunSteps(run.id)[0]; const invalidated = reopened.putRunStep(run.id, { ...mutation(run), key: original.key, expected_step_revision: original.revision, kind: original.kind, state: 'invalidated', input_hash: original.input_hash, result: original.result, verification: original.verification });
    const history = reopened.listRunStepRevisions(run.id, original.key); assert.equal(history.length, 2); assert.equal(history[0].state, 'verified'); assert.deepEqual(history[0].result, original.result); assert.equal(history[1].state, 'invalidated');
    assert.throws(() => reopened.putRunStep(run.id, { ...mutation(invalidated.run), key: 'read', expected_step_revision: 1, kind: 'read', state: 'running', input_hash: sha('new') }), { code: 'REVISION_CONFLICT' }); assert.equal(reopened.integrity().integrity, 'ok');
  } finally { reopened.close(); }
});

test('WF04 cancellation prevents new calls while saving the already in-flight verified outcome', t => {
  const { store } = fixture(t); let run = claim(store, ready(store)); const proposed = proposal(store, run); run = proposed.run;
  let action = store.reviewRunAction(proposed.action.id, { expected_revision: 1, fingerprint: proposed.action.fingerprint, decision: 'approved' });
  ({ run, action } = store.beginRunAction(action.id, { expected_revision: action.revision, run_expected_revision: run.revision, owner: run.lease.owner, epoch: run.lease.epoch, fingerprint: action.fingerprint }));
  run = store.requestRunCancel(run.id, run.revision); assert.equal(run.state, 'cancelling');
  assert.throws(() => store.chargeRunBudget(run.id, { ...mutation(run), tool_calls: 1 }), { code: 'CANCELLED' });
  assert.throws(() => store.putRunStep(run.id, { ...mutation(run), key: 'new', expected_step_revision: 0, kind: 'read', state: 'running', input_hash: sha('new') }), { code: 'CANCELLED' });
  ({ run, action } = store.finishRunAction(action.id, { expected_revision: action.revision, run_expected_revision: run.revision, owner: run.lease.owner, epoch: run.lease.epoch, state: 'verified', provider_receipt: { provider_id: 'effect-one' }, verification: verified(run.id) }));
  assert.equal(action.state, 'verified'); run = store.transitionRun(run.id, { ...mutation(run), state: 'partial', checkpoint: { effect_saved: true } }); assert.equal(run.state, 'partial'); assert.equal(run.cancel_requested, true); assert.equal(store.integrity().integrity, 'ok');
});

test('WF05 exceeded cumulative budgets stop atomically and never reset on resume', t => {
  const { root, store } = fixture(t); let run = claim(store, ready(store, { budget: { ...budget, tool_calls: 2 } }));
  run = store.chargeRunBudget(run.id, { ...mutation(run), tool_calls: 2 });
  assert.throws(() => store.chargeRunBudget(run.id, { ...mutation(run), tool_calls: 1 }), { code: 'BUDGET_EXCEEDED' }); run = store.getRun(run.id); assert.equal(run.state, 'partial'); assert.equal(run.used.tool_calls, 2); assert.equal(run.lease, null); store.close();
  const reopened = LocalStore.open({ root }); try { const readyAgain = reopened.transitionRun(run.id, { expected_revision: run.revision, state: 'ready', checkpoint: { next_step: 0, resumable: true } }); const resumed = claim(reopened, readyAgain); assert.equal(resumed.used.tool_calls, 2); assert.throws(() => reopened.chargeRunBudget(run.id, { ...mutation(resumed), tool_calls: 1 }), { code: 'BUDGET_EXCEEDED' }); } finally { reopened.close(); }
});

test('WF06 immutable action fingerprints bind target/body/base revision and human decision', t => {
  const { root, store } = fixture(t); let run = claim(store, ready(store)); const first = proposal(store, run); run = first.run; const action = first.action;
  assert.throws(() => store.reviewRunAction(action.id, { expected_revision: 1, fingerprint: sha('changed body'), decision: 'approved' }), { code: 'VERSION_MISMATCH' });
  assert.throws(() => proposal(store, run, { payload: { body: 'Changed' } }), { code: 'REVISION_CONFLICT' });
  const approved = store.reviewRunAction(action.id, { expected_revision: 1, fingerprint: action.fingerprint, decision: 'approved' });
  assert.throws(() => store.beginRunAction(action.id, { expected_revision: approved.revision, run_expected_revision: run.revision, owner: run.lease.owner, epoch: run.lease.epoch, fingerprint: sha('changed target') }), { code: 'VERSION_MISMATCH' });
  const invalidated = store.invalidateRunAction(action.id, approved.revision); assert.throws(() => store.beginRunAction(action.id, { expected_revision: invalidated.revision, run_expected_revision: run.revision, owner: run.lease.owner, epoch: run.lease.epoch, fingerprint: invalidated.fingerprint }), { code: 'CONSENT_REQUIRED' });
  const db = new Database(join(root, 'learnbridge.sqlite')); try { assert.throws(() => db.prepare('UPDATE workflow_actions SET proposal_json=?').run('{}'), /immutable action/); assert.throws(() => db.prepare('DELETE FROM workflow_reviews').run(), /immutable review/); } finally { db.close(); }
  assert.equal(store.integrity().integrity, 'ok');
});

test('WF07 provider success then SIGKILL yields unknown outcome, no blind retry, one reconciled effect', t => {
  const { root, base, store } = fixture(t); const run = ready(store); store.close(); const effect = join(base, 'synthetic-provider-effect.json');
  const result = child(`import{LocalStore}from${JSON.stringify(moduleUrl)};import{writeFileSync}from'node:fs';const s=LocalStore.open({root:${JSON.stringify(root)}});let r=s.claimRun(${JSON.stringify(run.id)},{expected_revision:${run.revision},owner:'crashing-worker',lease_ms:300000});let p=s.proposeRunAction(r.id,{expected_revision:r.revision,owner:r.lease.owner,epoch:r.lease.epoch,operation:'fixture.send',account_ref:'synthetic',target:{id:'target'},payload:{body:'exact'},idempotency_key:'crash_action_001'});r=p.run;let a=s.reviewRunAction(p.action.id,{expected_revision:1,fingerprint:p.action.fingerprint,decision:'approved'});({run:r,action:a}=s.beginRunAction(a.id,{expected_revision:a.revision,run_expected_revision:r.revision,owner:r.lease.owner,epoch:r.lease.epoch,fingerprint:a.fingerprint}));writeFileSync(${JSON.stringify(effect)},JSON.stringify({count:1,action_id:a.id,fingerprint:a.fingerprint}));process.kill(process.pid,'SIGKILL');`);
  assert.ifError(result.error); assert.equal(result.signal, 'SIGKILL'); const reopened = LocalStore.open({ root });
  try { const recovered = reopened.recoverInterruptedRuns(); assert.equal(recovered.length, 1); assert.equal(recovered[0].state, 'interrupted'); let action = reopened.listRunActions(run.id)[0]; assert.equal(action.state, 'unknown_outcome');
    const receipt = JSON.parse(readFileSync(effect, 'utf8')); assert.equal(receipt.count, 1); assert.equal(receipt.fingerprint, action.fingerprint);
    const readyAgain = reopened.transitionRun(run.id, { expected_revision: recovered[0].revision, state: 'ready', checkpoint: { reconcile_first: true } }); const active = claim(reopened, readyAgain);
    assert.throws(() => reopened.beginRunAction(action.id, { expected_revision: action.revision, run_expected_revision: active.revision, owner: active.lease.owner, epoch: active.lease.epoch, fingerprint: action.fingerprint }), { code: 'UNKNOWN_OUTCOME' });
    assert.throws(() => reopened.reconcileRunAction(action.id, { expected_revision: action.revision, state: 'verified', provider_receipt: receipt, verification: verified(run.id) }), { code: 'REVISION_CONFLICT' });
    const paused = reopened.transitionRun(run.id, { ...mutation(active), state: 'unknown_outcome', checkpoint: { reconcile_first: true } }); assert.equal(paused.state, 'unknown_outcome');
    action = reopened.reconcileRunAction(action.id, { expected_revision: action.revision, state: 'verified', provider_receipt: receipt, verification: verified(run.id) }); assert.equal(action.state, 'verified'); assert.equal(JSON.parse(readFileSync(effect)).count, 1); assert.equal(reopened.integrity().integrity, 'ok');
  } finally { reopened.close(); }
});

test('WF08 completion requires stored verification and matching evidence instead of agent text', t => {
  const { store } = fixture(t); let run = claim(store, ready(store));
  assert.throws(() => store.putRunStep(run.id, { ...mutation(run), key: 'read', expected_step_revision: 0, kind: 'read', state: 'verified', input_hash: sha('input'), result: { text: 'done' } }), { code: 'VERSION_MISMATCH' });
  assert.throws(() => store.putRunStep(run.id, { ...mutation(run), key: 'read', expected_step_revision: 0, kind: 'read', state: 'verified', input_hash: sha('input'), verification: { ...verified(run.id), observed_hash: sha('different') } }), { code: 'VERSION_MISMATCH' });
  ({ run } = saveStep(store, run)); run = store.transitionRun(run.id, { ...mutation(run), state: 'verifying' });
  assert.throws(() => store.transitionRun(run.id, { ...mutation(run), state: 'completed', evidence_refs: ['not-a-saved-evidence'] }), { code: 'VERSION_MISMATCH' });
  run = store.transitionRun(run.id, { ...mutation(run), state: 'completed', evidence_refs: [verified(run.id).evidence_ref] }); assert.equal(run.state, 'completed'); assert.equal(run.lease, null); assert.equal(store.integrity().integrity, 'ok');
});

test('WF09 generic workspace domain records are private, revisioned, bounded and retry-safe', t => {
  const { root, store } = fixture(t); const original = store.createWorkspaceRecord({ kind: 'course', title: 'Synthetic course', data: { assignments: [] } }, { idempotencyKey: 'workspace_retry_001' });
  const edited = store.updateWorkspaceRecord(original.id, { expected_revision: 1, data: { assignments: [{ id: 'synthetic-1' }] } }); assert.equal(edited.revision, 2);
  assert.throws(() => store.updateWorkspaceRecord(original.id, { expected_revision: 1, title: 'stale' }), { code: 'REVISION_CONFLICT' });
  assert.deepEqual(store.createWorkspaceRecord({ kind: 'course', title: 'Synthetic course', data: { assignments: [] } }, { idempotencyKey: 'workspace_retry_001' }), original);
  assert.throws(() => store.createWorkspaceRecord({ kind: 'secret', title: 'Bad', data: {} }), { code: 'INVALID_INPUT' }); let accessorInvoked = false;
  assert.throws(() => store.createWorkspaceRecord({ kind: 'profile_fact', title: 'Profile', data: { get private() { accessorInvoked = true; return 'value'; } } }), { code: 'INVALID_INPUT' }); assert.equal(accessorInvoked, false);
  store.close(); const reopened = LocalStore.open({ root }); try { assert.deepEqual(reopened.getWorkspaceRecord(original.id), edited); assert.equal(reopened.listWorkspaceRecords({ kind: 'course' }).length, 1); reopened.deleteWorkspaceRecord(original.id, 2); assert.equal(reopened.getWorkspaceRecord(original.id), null); assert.equal(reopened.integrity().workspace_record_count, 1); } finally { reopened.close(); }
});

function legacyV2(base) {
  const root = join(base, 'legacy'); mkdirSync(root, { mode: 0o700 }); writeFileSync(join(root, '.learnbridge-local-root'), 'learnbridge-local-data-v1\n', { mode: 0o600 });
  const installation = createInstallation({ student_id: randomUUID(), platform: process.platform, data_root_ref: 'private-local-root', edition: 'local', timezone: 'UTC', setup_version: '0.1.0' });
  const db = new Database(join(root, 'learnbridge.sqlite')); try { db.exec(v1); db.exec(v2); db.prepare('INSERT INTO installation VALUES (1,?)').run(JSON.stringify(installation)); db.prepare('INSERT INTO schema_migrations VALUES (1,?)').run(sha(v1)); db.prepare('INSERT INTO schema_migrations VALUES (2,?)').run(sha(v2)); } finally { db.close(); } return { root, installation };
}

test('WF10 additive v2→v3 migration preserves both historical checksums and identity', t => {
  const { base } = fixture(t); const { root, installation } = legacyV2(base); const store = LocalStore.open({ root });
  try { assert.deepEqual(store.identity, installation); assert.equal(store.integrity().schema_version, STORAGE_SCHEMA_VERSION); } finally { store.close(); }
  const db = new Database(join(root, 'learnbridge.sqlite')); try { const ledger = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(); assert.equal(ledger.length, STORAGE_SCHEMA_VERSION); assert.equal(ledger[0].checksum, sha(v1)); assert.equal(ledger[1].checksum, sha(v2)); } finally { db.close(); }
});

test('WF11 SIGKILL inside actual v3 migration rolls back, then stale-owner recovery retries safely', t => {
  const { base } = fixture(t); const { root, installation } = legacyV2(base);
  const result = child(`import{LocalStore}from${JSON.stringify(moduleUrl)};import Database from'better-sqlite3';const original=Database.prototype.prepare;Database.prototype.prepare=function(sql){if(sql==='INSERT INTO schema_migrations VALUES (3,?)')return{run(){process.kill(process.pid,'SIGKILL')}};return original.call(this,sql)};LocalStore.open({root:${JSON.stringify(root)}});`);
  assert.ifError(result.error); assert.equal(result.signal, 'SIGKILL'); const db = new Database(join(root, 'learnbridge.sqlite')); try { assert.equal(db.pragma('user_version', { simple: true }), 2); assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n, 2); assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='workflow_runs'").get().n, 0); } finally { db.close(); }
  const reopened = LocalStore.open({ root }); try { assert.deepEqual(reopened.identity, installation); assert.equal(reopened.integrity().schema_version, STORAGE_SCHEMA_VERSION); } finally { reopened.close(); }
});

test('WF12 v2 backups restore unchanged and only restored roots upgrade', async t => {
  const { base } = fixture(t); const { root, installation } = legacyV2(base); const backupRoot = join(base, 'legacy-backup'); mkdirSync(backupRoot); const bytes = readFileSync(join(root, 'learnbridge.sqlite')); writeFileSync(join(backupRoot, 'learnbridge.sqlite'), bytes);
  writeFileSync(join(backupRoot, 'manifest.json'), JSON.stringify({ format: 'learnbridge-local-backup', schema_version: 2, created_at: new Date().toISOString(), installation_id: installation.id, student_id: installation.student_id, database: { name: 'learnbridge.sqlite', bytes: bytes.length, sha256: sha(bytes) } }));
  const restored = join(base, 'restored-v2'); const report = await LocalStore.restore({ backupRoot, root: restored }); assert.equal(report.schema_version, 2); const upgraded = LocalStore.open({ root: restored }); try { assert.equal(upgraded.integrity().schema_version, STORAGE_SCHEMA_VERSION); } finally { upgraded.close(); } assert.equal(sha(readFileSync(join(backupRoot, 'learnbridge.sqlite'))), sha(bytes));
});

test('WF13 v3 backup/restore preserves runs, history, receipts and domain records; rehashed corruption rejects', async t => {
  const { base, store } = fixture(t); let run = claim(store, ready(store)); const p = proposal(store, run); run = p.run; store.reviewRunAction(p.action.id, { expected_revision: 1, fingerprint: p.action.fingerprint, decision: 'rejected' }); ({ run } = saveStep(store, run));
  const workspace = store.createWorkspaceRecord({ kind: 'profile_fact', title: 'Synthetic reviewed profile', data: { state: 'proposed', value: 'Synthetic' } }); const backupRoot = join(base, 'backup'); await store.backup(backupRoot);
  const restored = join(base, 'restored'); await LocalStore.restore({ backupRoot, root: restored }); const copy = LocalStore.open({ root: restored }); try { assert.deepEqual(copy.getRun(run.id), run); assert.deepEqual(copy.getWorkspaceRecord(workspace.id), workspace); assert.equal(copy.listRunActions(run.id)[0].review_receipt.decision, 'rejected'); assert.equal(copy.integrity().schema_version, STORAGE_SCHEMA_VERSION); } finally { copy.close(); }
  const db = new Database(join(backupRoot, 'learnbridge.sqlite')); try { const row = db.prepare('SELECT id,json FROM workflow_runs').get(); const forged = JSON.parse(row.json); forged.used.tool_calls = 1001; db.prepare('UPDATE workflow_runs SET json=? WHERE id=?').run(JSON.stringify(forged), row.id); } finally { db.close(); }
  const manifest = JSON.parse(readFileSync(join(backupRoot, 'manifest.json'))); const bytes = readFileSync(join(backupRoot, 'learnbridge.sqlite')); manifest.database.bytes = bytes.length; manifest.database.sha256 = sha(bytes); writeFileSync(join(backupRoot, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(LocalStore.restore({ backupRoot, root: join(base, 'forged-restore') }), { code: 'INVALID_INPUT' });
});

test('WF14 lease expiry recovery retains active-step history and never steals a live lease', t => {
  const { store } = fixture(t); const prepared = ready(store); let run = store.claimRun(prepared.id, { expected_revision: prepared.revision, owner: 'short-lease-worker', lease_ms: 1000 });
  ({ run } = store.putRunStep(run.id, { ...mutation(run), key: 'inflight', expected_step_revision: 0, kind: 'read', state: 'running', input_hash: sha('input') }));
  assert.deepEqual(store.recoverExpiredRunLeases(), []); const currentTime = Date.now; const future = Date.parse(run.lease.expires_at) + 1;
  try { Date.now = () => future; assert.throws(() => store.renewRunLease(run.id, mutation(run)), { code: 'REVISION_CONFLICT' }); const recovered = store.recoverExpiredRunLeases(); assert.equal(recovered.length, 1); assert.equal(recovered[0].state, 'interrupted'); assert.equal(recovered[0].lease, null); assert.equal(store.listRunSteps(run.id)[0].state, 'interrupted'); assert.deepEqual(store.listRunStepRevisions(run.id, 'inflight').map(step => step.state), ['running', 'interrupted']); } finally { Date.now = currentTime; }
  assert.equal(store.integrity().integrity, 'ok');
});

test('WF15 matching readback for different content cannot verify a saved step', t => {
  const { store } = fixture(t); const run = claim(store, ready(store));
  assert.throws(() => store.putRunStep(run.id, { ...mutation(run), key: 'read', expected_step_revision: 0, kind: 'read', state: 'verified', input_hash: sha('input'), result: { exact: 'tampered result' }, verification: verified(run.id) }), { code: 'VERSION_MISMATCH' }); assert.equal(store.listRunSteps(run.id).length, 0);
});

test('WF16 dropping an execution lease for budget stop keeps dispatched actions unknown', t => {
  const { store } = fixture(t); let run = claim(store, ready(store, { budget: { ...budget, tool_calls: 0 } })); let action; ({ run, action } = proposal(store, run)); action = store.reviewRunAction(action.id, { expected_revision: 1, fingerprint: action.fingerprint, decision: 'approved' });
  ({ run, action } = store.beginRunAction(action.id, { expected_revision: action.revision, run_expected_revision: run.revision, owner: run.lease.owner, epoch: run.lease.epoch, fingerprint: action.fingerprint }));
  assert.throws(() => store.chargeRunBudget(run.id, { ...mutation(run), tool_calls: 1 }), { code: 'BUDGET_EXCEEDED' }); const stopped = store.getRun(run.id); assert.equal(stopped.lease, null); assert.equal(store.getRunAction(action.id).state, 'unknown_outcome');
  const cancelled = store.requestRunCancel(run.id, stopped.revision); assert.equal(cancelled.state, 'unknown_outcome'); assert.equal(cancelled.cancel_requested, true); assert.equal(store.integrity().integrity, 'ok');
});

test('WF17 partial multi-destination progress preserves the first two receipts and retries no verified effect', t => {
  const { root, store } = fixture(t); let run = claim(store, ready(store)); const receipts = [];
  for (let index = 0; index < 3; index++) {
    let action; ({ run, action } = proposal(store, run, { target: { id: `destination-${index}` }, idempotency_key: `destination_action_00${index}` }));
    action = store.reviewRunAction(action.id, { expected_revision: 1, fingerprint: action.fingerprint, decision: 'approved' });
    ({ run, action } = store.beginRunAction(action.id, { expected_revision: action.revision, run_expected_revision: run.revision, owner: run.lease.owner, epoch: run.lease.epoch, fingerprint: action.fingerprint }));
    const state = index < 2 ? 'verified' : 'unknown_outcome'; const finished = store.finishRunAction(action.id, { expected_revision: action.revision, run_expected_revision: run.revision, owner: run.lease.owner, epoch: run.lease.epoch, state, ...(index < 2 ? { provider_receipt: { id: `effect-${index}`, count: 1 }, verification: verified(run.id, `destination-${index}`) } : {}) }); run = finished.run; receipts.push(finished.action);
  }
  run = store.transitionRun(run.id, { ...mutation(run), state: 'unknown_outcome', checkpoint: { unresolved_id: receipts[2].id, resumable: true } }); store.close(); const reopened = LocalStore.open({ root });
  try {
    assert.deepEqual(reopened.listRunActions(run.id).filter(action => action.state === 'verified').map(action => action.provider_receipt.id).sort(), ['effect-0', 'effect-1']);
    const resolved = reopened.reconcileRunAction(receipts[2].id, { expected_revision: receipts[2].revision, state: 'failed', provider_receipt: { found: false }, verification: { ...verified(run.id), status: 'unavailable', expected_hash: null, observed_hash: null } }); assert.equal(resolved.state, 'failed');
    run = reopened.transitionRun(run.id, { expected_revision: run.revision, state: 'ready' }); run = claim(reopened, run);
    assert.throws(() => reopened.beginRunAction(receipts[0].id, { expected_revision: receipts[0].revision, run_expected_revision: run.revision, owner: run.lease.owner, epoch: run.lease.epoch, fingerprint: receipts[0].fingerprint }), { code: 'CONSENT_REQUIRED' });
    assert.equal(reopened.listRunActions(run.id).filter(action => action.state === 'verified').length, 2); assert.equal(reopened.integrity().integrity, 'ok');
  } finally { reopened.close(); }
});

test('WF18 failed/unavailable provider readback cannot record a verified action', t => {
  const { store } = fixture(t); let run = claim(store, ready(store)); let action; ({ run, action } = proposal(store, run)); action = store.reviewRunAction(action.id, { expected_revision: 1, fingerprint: action.fingerprint, decision: 'approved' });
  ({ run, action } = store.beginRunAction(action.id, { expected_revision: action.revision, run_expected_revision: run.revision, owner: run.lease.owner, epoch: run.lease.epoch, fingerprint: action.fingerprint }));
  for (const status of ['failed', 'unavailable']) assert.throws(() => store.finishRunAction(action.id, { expected_revision: action.revision, run_expected_revision: run.revision, owner: run.lease.owner, epoch: run.lease.epoch, state: 'verified', provider_receipt: { provider_says: 'done' }, verification: { ...verified(run.id), status } }), { code: 'VERSION_MISMATCH' });
  ({ run, action } = store.finishRunAction(action.id, { expected_revision: action.revision, run_expected_revision: run.revision, owner: run.lease.owner, epoch: run.lease.epoch, state: 'unknown_outcome', provider_receipt: { provider_says: 'done' }, verification: { ...verified(run.id), status: 'unavailable', expected_hash: null, observed_hash: null } }));
  assert.equal(action.state, 'unknown_outcome'); assert.equal(store.getRun(run.id).state, 'running'); assert.equal(store.integrity().integrity, 'ok');
});

test('WF19 failed v3 migration releases the writer and preserves schema2 for safe retry', t => {
  const { base } = fixture(t); const { root, installation } = legacyV2(base); const original = Database.prototype.prepare;
  try { Database.prototype.prepare = function(sql) { if (sql === 'INSERT INTO schema_migrations VALUES (3,?)') return { run() { throw new Error('Synthetic v3 migration failure'); } }; return original.call(this, sql); }; assert.throws(() => LocalStore.open({ root }), /Synthetic v3 migration failure/); } finally { Database.prototype.prepare = original; }
  const db = new Database(join(root, 'learnbridge.sqlite')); try { assert.equal(db.pragma('user_version', { simple: true }), 2); assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='workflow_runs'").get().n, 0); assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n, 2); } finally { db.close(); }
  const reopened = LocalStore.open({ root }); try { assert.deepEqual(reopened.identity, installation); assert.equal(reopened.integrity().schema_version, STORAGE_SCHEMA_VERSION); } finally { reopened.close(); }
});

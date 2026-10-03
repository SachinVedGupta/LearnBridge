import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { createWorkflowRunner, workflowHash } from '../apps/local-runtime/src/workflows.mjs';

async function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-student-flow-')); const root = join(parent, 'workspace'); let runtime;
  t.after(async () => { await runtime?.close(); rmSync(parent, { recursive: true, force: true }); });
  async function restart() {
    await runtime?.close(); runtime = await startRuntime({ dataRoot: root, port: 0 });
    const response = await fetch(runtime.origin + '/api/local/v1/pair', { method: 'POST', headers: { Origin: runtime.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: runtime.createPairingCode() }) });
    assert.equal(response.status, 200); const session = await response.json(); const cookie = response.headers.get('set-cookie').split(';')[0];
    return async (path, body, method = body === undefined ? 'GET' : 'POST', headers = {}) => {
      const result = await fetch(runtime.origin + '/api/local/v1' + path, { method, headers: { Cookie: cookie, Origin: runtime.origin, 'X-LearnBridge-Nonce': session.nonce, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: result.status, data: await result.json() };
    };
  }
  return { root, parent, restart, call: await restart() };
}
test('reviewed profile persists, stale review fails, and purpose selection stays private', async t => {
  const f = await fixture(t); let call = f.call;
  const created = await call('/profile', { field: 'learning_preferences', value: 'Teach one small section at a time' }); assert.equal(created.status, 201);
  let view = (await call('/profile')).data.items[0]; assert.equal(view.data.state, 'candidate');
  assert.equal((await call(`/profile/${view.id}/review`, { expected_revision: 1, decision: 'confirm', fingerprint: 'a'.repeat(64) })).status, 409);
  const input = { expected_revision: 1, decision: 'confirm', fingerprint: view.fingerprint };
  assert.equal((await call(`/profile/${view.id}/review`, input)).status, 200);
  assert.equal((await call(`/profile/${view.id}/review`, input)).status, 409);
  call = await f.restart(); view = (await call('/profile')).data.items[0]; assert.equal(view.data.state, 'confirmed');
  assert.equal((await call('/profile/context', { purpose: 'learning', allowed_ids: [view.id] })).data.items.length, 1);
  assert.equal((await call('/profile/context', { purpose: 'budget', allowed_ids: [view.id] })).data.items.length, 0);
  assert.equal((await call(`/profile/${view.id}`, { expected_revision: view.revision }, 'DELETE')).status, 200);
  assert.equal((await call('/profile/context', { purpose: 'learning', allowed_ids: [view.id] })).data.items.length, 0);
});
test('academic library import, exact citation, restart and forget use the real paired runtime', async t => {
  const f = await fixture(t); let call = f.call;
  const raw = JSON.parse(readFileSync(new URL('../packages/local-academic/examples/academic-export.json', import.meta.url)));
  const preview = await call('/academic/preview', { export: raw, selected_course_ids: ['101'] }); assert.equal(preview.status, 200);
  const first = await call('/academic/library-import', { preview_id: preview.data.preview_id }); assert.equal(first.status, 201);
  const repeated = await call('/academic/library-import', { preview_id: preview.data.preview_id }); assert.equal(repeated.data.snapshot.id, first.data.snapshot.id);
  const record = first.data.snapshot;
  const scope = { snapshot_ids: [record.id], course_ids: ['101'] };
  const search = await call('/courses/search', { ...scope, query: 'base case' }); assert.equal(search.status, 200); assert.ok(search.data.results.length > 0);
  const reference = search.data.results[0];
  const citation = await call('/courses/citation', { ...scope, source_id: reference.source_id, version_hash: reference.version_hash, chunk_id: reference.chunk_id });
  assert.equal(citation.status, 200); assert.equal(citation.data.text, reference.excerpt); assert.equal(citation.data.untrusted, true);
  assert.equal((await call('/courses/search', { ...scope, course_ids: ['UNSELECTED'], query: 'base case' })).status, 403);
  call = await f.restart(); assert.equal((await call('/courses')).data.items.length, 1);
  assert.equal((await call(`/courses/${record.id}`, { expected_revision: record.revision }, 'DELETE')).status, 200);
  assert.equal((await call('/courses/search', { ...scope, query: 'base case' })).status, 403);
});
test('profile export is an exact reviewed local copy with idempotent readback and no implicit agent grant', async t => {
  const f = await fixture(t); let call = f.call;
  await call('/profile', { field: 'learning_preferences', value: 'Synthetic teach-back preference' });
  let fact = (await call('/profile')).data.items[0];
  await call(`/profile/${fact.id}/review`, { expected_revision: fact.revision, decision: 'confirm', fingerprint: fact.fingerprint });
  const selection = { purpose: 'learning', allowed_ids: [fact.id] };
  const preview = (await call('/profile/context', selection)).data;
  const body = { ...selection, context_hash: preview.context_hash };
  const first = await call('/profile/export', body); assert.equal(first.status, 201); assert.equal(first.data.sharing, 'not_granted');
  assert.equal((await call('/profile/export', body)).data.document.id, first.data.document.id);
  const note = (await call(`/documents/${first.data.document.id}`)).data;
  assert.ok(note.content.includes('Synthetic teach-back preference')); assert.equal(note.sha256, first.data.sha256);
  assert.equal((await call('/agent-grants')).data.items.length, 0);
  call = await f.restart(); assert.equal((await call('/profile/export', body)).data.document.id, first.data.document.id);
  fact = (await call('/profile')).data.items[0];
  await call(`/profile/${fact.id}/review`, { expected_revision: fact.revision, decision: 'correct', fingerprint: fact.fingerprint, value: 'Changed preference' });
  assert.equal((await call('/profile/export', body)).status, 409);
  assert.equal((await call('/profile/export', { purpose: 'budget', allowed_ids: [fact.id], context_hash: preview.context_hash })).status, 409);
});
test('durable study-plan flow verifies saved preview, rejects stale acceptance and persists exact accepted plan', async t => {
  const f = await fixture(t); let call = f.call;
  const task = (await call('/tasks', { title: 'Review recursion', effort_minutes: 90 })).data.task;
  const start = new Date(Date.now() + 60000).toISOString(); const end = new Date(Date.now() + 2 * 3600000).toISOString();
  const prepared = await call('/workflows', { recipe_id: 'plan.today', input: { availability: [{ start, end }], timezone: 'America/Toronto', horizonEnd: end } });
  assert.equal(prepared.status, 201); const runId = prepared.data.run.id;
  const executed = await call(`/workflows/${runId}/execute`, {}); assert.equal(executed.status, 200, JSON.stringify(executed.data)); assert.equal(executed.data.run.state, 'completed');
  const details = (await call(`/workflows/${runId}`)).data; assert.equal(details.steps.length, 2); assert.ok(details.steps.every(step => step.state === 'verified'));
  assert.equal(details.run.used.tool_calls, 4);
  let plan = (await call('/plans')).data.items[0]; assert.equal(plan.data.plan.coverage.proposed_minutes, 90); assert.equal(plan.data.plan.external_writes, 0);
  await call(`/tasks/${task.id}`, { expected_revision: task.revision, effort_minutes: 120 }, 'PATCH');
  assert.equal((await call(`/plans/${plan.id}/accept`, { expected_revision: plan.revision, plan_hash: plan.data.plan.plan_hash })).status, 409);
  const next = (await call('/workflows', { recipe_id: 'plan.today', input: { availability: [{ start, end }], timezone: 'America/Toronto', horizonEnd: end } })).data.run;
  assert.equal((await call(`/workflows/${next.id}/execute`, {})).data.run.state, 'completed');
  plan = (await call('/plans')).data.items.find(item => item.data.run_id === next.id);
  assert.ok(plan.data.plan.coverage.unscheduled_minutes > 0);
  const review = { expected_revision: plan.revision, plan_hash: plan.data.plan.plan_hash };
  assert.equal((await call(`/plans/${plan.id}/accept`, review)).status, 200);
  assert.equal((await call(`/plans/${plan.id}/accept`, review)).status, 200);
  call = await f.restart(); assert.equal((await call('/plans')).data.items.filter(item => item.data.state === 'accepted').length, 1);
});
test('all new runtime surfaces reject unpaired access and unknown executable recipes', async t => {
  const f = await fixture(t); const run = await f.call('/workflows', { recipe_id: 'shell.execute', input: { command: 'arbitrary' } }); assert.equal(run.status, 501);
  assert.equal((await f.call('/profile', { field: 'name', value: 'Fixture', reviewer: 'forged' })).status, 400);
});

function engineFixture(t, { budget = 10, grants = () => [] } = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-run-loop-')); const store = LocalStore.open({ root: join(parent, 'workspace') });
  t.after(() => { store.close(); rmSync(parent, { recursive: true, force: true }); });
  const task = store.createTask({ title: 'Synthetic input' }); const calls = []; let failOnce = true;
  const recipes = { fixture: { version: '1', budget: { tool_calls: budget, model_calls: 0, bytes: 20000, max_duration_ms: 300000 }, validate: input => input, grants,
    pins: () => { const current = store.getTask(task.id); return current ? [{ kind: 'task', id: current.id, revision: current.revision, version_hash: workflowHash(current) }] : []; },
    steps: [
      { key: 'read', kind: 'read', verification_method: 'fixture.task_readback', execute: () => { calls.push('read'); return store.getTask(task.id); }, verify: () => store.getTask(task.id) },
      { key: 'finish', kind: 'read', verification_method: 'fixture.recomputation', execute: () => { calls.push('finish'); if (failOnce) { failOnce = false; throw new Error('Synthetic interruption'); } return { verified: true }; }, verify: () => ({ verified: true }) },
    ] } };
  const runner = createWorkflowRunner({ store, recipes, resolvePin: pin => { const current = store.getTask(pin.id); return current && { revision: current.revision, version_hash: workflowHash(current) }; }, validateGrant: ref => store.getAgentGrant(ref.id)?.state === 'active' });
  return { store, task, calls, runner, recipes };
}
test('resume reuses verified unchanged reads and charges failed calls cumulatively', async t => {
  const f = engineFixture(t); const run = f.runner.prepare('fixture', {});
  const interrupted = await f.runner.execute(run.id); assert.equal(interrupted.state, 'interrupted'); assert.equal(interrupted.used.tool_calls, 3);
  const resumed = await f.runner.execute(run.id); assert.equal(resumed.state, 'completed'); assert.equal(resumed.used.tool_calls, 5);
  assert.deepEqual(f.calls, ['read', 'finish', 'finish']);
});
test('changed source invalidates historical read before resume and saves a new exact version', async t => {
  const f = engineFixture(t); const run = f.runner.prepare('fixture', {}); await f.runner.execute(run.id);
  f.store.updateTask(f.task.id, { title: 'Changed input' }, f.task.revision);
  const resumed = await f.runner.execute(run.id); assert.equal(resumed.state, 'completed'); assert.deepEqual(f.calls, ['read', 'finish', 'read', 'finish']);
  const history = f.store.listRunStepRevisions(run.id, 'read'); assert.ok(history.some(step => step.state === 'invalidated'));
  assert.equal(history.at(-1).result.title, 'Changed input');
});
test('cancelled work and exhausted budget cannot launch another step or reset usage', async t => {
  const f = engineFixture(t, { budget: 1 }); const run = f.runner.prepare('fixture', {});
  await assert.rejects(f.runner.execute(run.id), e => e.code === 'BUDGET_EXCEEDED');
  assert.deepEqual(f.calls, ['read']); assert.equal(f.store.getRun(run.id).used.tool_calls, 1);
  const next = f.runner.prepare('fixture', { distinct: true }); f.runner.cancel(next.id, next.revision);
  assert.equal((await f.runner.execute(next.id)).state, 'cancelled'); assert.deepEqual(f.calls, ['read']);
});
test('cancellation during an async read discards late content and launches no verification or next step', async t => {
  const f = engineFixture(t); let release; let entered;
  const gate = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
  f.recipes.fixture.steps[0].execute = async () => { entered(); await gate; return f.store.getTask(f.task.id); };
  const run = f.runner.prepare('fixture', {}); const pending = f.runner.execute(run.id); await started;
  f.runner.cancel(run.id, f.store.getRun(run.id).revision);
  const result = await pending; assert.equal(result.state, 'cancelled'); assert.deepEqual(f.calls, []);
  assert.equal(f.store.listRunSteps(run.id)[0].state, 'interrupted'); assert.equal(f.store.listRunSteps(run.id)[0].result, null);
  release(); await Promise.resolve(); assert.equal(f.store.getRun(run.id).state, 'cancelled');
});
test('revoked grants and expired human authorization after async work invalidate cached context', async t => {
  for (const mode of ['source_grant', 'human_session']) {
    const f = engineFixture(t); let release; let entered; let authorized = true;
    const grant = f.store.createAgentGrant({ destination: 'codex', task_ids: [f.task.id], max_bytes: 10000, expires_in_minutes: 5 });
    f.recipes.fixture.grants = () => [{ id: grant.id, revision: grant.revision, destination: 'codex' }];
    const gate = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
    f.recipes.fixture.steps[0].execute = async () => { entered(); await gate; return f.store.getTask(f.task.id); };
    const run = f.runner.prepare('fixture', {});
    const pending = f.runner.execute(run.id, { authorize: () => { if (!authorized) throw Object.assign(new Error('Session ended'), { code: 'AUTH_REQUIRED' }); } }); await started;
    if (mode === 'source_grant') f.store.revokeAgentGrant(grant.id, grant.revision); else authorized = false;
    release(); const result = await pending; assert.equal(result.state, 'interrupted');
    assert.equal(f.store.listRunSteps(run.id)[0].result, null); assert.deepEqual(f.calls, []);
  }
});
test('disagreeing readback and unbrokered model/external recipes cannot produce completed work', async t => {
  const f = engineFixture(t); f.recipes.fixture.steps[0].verify = () => ({ other: 'provider disagrees' });
  const run = f.runner.prepare('fixture', {}); const failed = await f.runner.execute(run.id);
  assert.equal(failed.state, 'interrupted'); assert.equal(failed.error.code, 'PROVIDER_FAILURE');
  for (const kind of ['model', 'external_write']) {
    f.recipes.fixture.steps[0].kind = kind;
    assert.throws(() => f.runner.prepare('fixture', {}), e => e.code === 'UNSUPPORTED');
  }
});
test('failed startup source probe closes writer ownership so the same root can start normally', async t => {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-init-failure-')); const root = join(parent, 'workspace');
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  await assert.rejects(startRuntime({ dataRoot: root, port: 0, sourceAdapter: { probeSourceCapability: async () => { throw new Error('Synthetic initialization failure'); } } }));
  const runtime = await startRuntime({ dataRoot: root, port: 0 }); await runtime.close();
});

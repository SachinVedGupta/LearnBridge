import { createHash, randomUUID } from 'node:crypto';
import { LearnBridgeError } from '@learnbridge/core';

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
export const workflowHash = value => createHash('sha256').update(canonical(value)).digest('hex');
const failure = code => { throw new LearnBridgeError(code); };
const terminal = new Set(['completed', 'cancelled', 'expired']);

/** Only trusted in-process recipe definitions can supply executable functions.
 * HTTP/MCP callers choose a registered recipe; never a script, path or tool.
 * Every input/step budget is charged before work, including failed attempts.
 */
export function createWorkflowRunner({ store, recipes, resolvePin, validateGrant = () => false, leaseMs = 30000 }) {
  const active = new Map();
  const definition = name => {
    const recipe = recipes[name];
    if (!recipe || !Array.isArray(recipe.steps) || !recipe.steps.length || recipe.steps.some(step => !['read', 'local_write', 'verify'].includes(step.kind)
      || (step.kind === 'local_write' && step.idempotent !== true))) failure('UNSUPPORTED');
    return recipe;
  };
  const pinsValid = pins => pins.every(pin => {
    const observed = resolvePin(pin);
    return observed && observed.revision === pin.revision && observed.version_hash === pin.version_hash;
  });
  const grantsValid = run => run.grant_refs.every(ref => validateGrant(ref));
  const checkStop = run => {
    if (run.cancel_requested) failure('CANCELLED');
    if (!grantsValid(run)) failure('CONSENT_REQUIRED');
  };
  function prepare(recipeId, input, { idempotencyKey } = {}) {
    const recipe = definition(recipeId);
    const parsed = recipe.validate(input);
    const pins = recipe.pins(parsed);
    const run = store.createRun({ recipe_id: recipeId, recipe_version: recipe.version,
      input: parsed, budget: recipe.budget, source_pins: pins, grant_refs: recipe.grants?.(parsed) ?? [],
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}) });
    if (run.state !== 'created') return run;
    const validating = store.transitionRun(run.id, { expected_revision: run.revision, state: 'validating' });
    return store.transitionRun(run.id, { expected_revision: validating.revision, state: 'ready', checkpoint: { next_step: 0, resumable: true } });
  }
  async function work(runId, { authorize = () => {}, signal } = {}) {
    const owner = randomUUID();
    let run = store.getRun(runId);
    if (!run) failure('INVALID_INPUT');
    const recipe = definition(run.recipe_id);
    if (recipe.version !== run.recipe_version) failure('VERSION_MISMATCH');
    if (terminal.has(run.state)) return run;
    authorize(); checkStop(run);
    if (['interrupted', 'failed', 'partial', 'unknown_outcome'].includes(run.state)) {
      run = store.transitionRun(run.id, { expected_revision: run.revision, state: 'ready', checkpoint: run.checkpoint });
    }
    run = store.claimRun(run.id, { expected_revision: run.revision, owner, lease_ms: leaseMs });
    const epoch = run.lease.epoch;
    const mutate = () => ({ expected_revision: run.revision, owner, epoch });
    const current = () => {
      authorize(); if (signal?.aborted) failure('CANCELLED');
      run = store.getRun(run.id); checkStop(run);
      if (!run.lease || run.lease.owner !== owner || run.lease.epoch !== epoch) failure('REVISION_CONFLICT');
      return run;
    };
    const results = {};
    let activeStep = null;
    let pendingResult = null;
    async function bounded(callback) {
      current();
      const remaining = Math.min(Date.parse(run.lease.expires_at) - Date.now() - 250,
        run.budget.max_duration_ms - (Date.now() - Date.parse(run.started_at)) - 250);
      if (remaining < 1) failure('BUDGET_EXCEEDED');
      let timeout; let rejectAbort;
      const stopped = new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new LearnBridgeError('BUDGET_EXCEEDED')), remaining);
        rejectAbort = () => reject(new LearnBridgeError('CANCELLED'));
        signal?.addEventListener('abort', rejectAbort, { once: true });
      });
      try { return await Promise.race([Promise.resolve().then(callback), stopped]); }
      finally { clearTimeout(timeout); signal?.removeEventListener('abort', rejectAbort); }
    }
    try {
      for (let index = 0; index < recipe.steps.length; index++) {
        current();
        const step = recipe.steps[index];
        const pins = recipe.pins(run.input);
        if (!pinsValid(pins)) failure('REVISION_CONFLICT');
        const inputHash = workflowHash({ input: run.input, pins, preceding: results });
        let prior = store.listRunSteps(run.id).find(item => item.key === step.key);
        if (prior?.state === 'verified' && prior.input_hash === inputHash && pinsValid(prior.source_pins)) {
          results[step.key] = prior.result; continue;
        }
        if (prior?.state === 'verified') {
          const invalidated = store.putRunStep(run.id, { ...mutate(), key: step.key, expected_step_revision: prior.revision,
            kind: step.kind, state: 'invalidated', input_hash: prior.input_hash, source_pins: prior.source_pins,
            result: prior.result, verification: prior.verification });
          run = invalidated.run; prior = invalidated.step;
        }
        run = store.chargeRunBudget(run.id, { ...mutate(), tool_calls: 1 });
        const started = store.putRunStep(run.id, { ...mutate(), key: step.key, expected_step_revision: prior?.revision ?? 0,
          kind: step.kind, state: 'running', input_hash: inputHash, source_pins: pins });
        run = started.run;
        activeStep = started.step; pendingResult = null;
        const result = await bounded(() => step.execute({ input: run.input, results, run_id: run.id, signal }));
        pendingResult = result;
        current();
        // Reject changed/revoked inputs after every async boundary, before saving
        // or taking a follow-up action with cached data.
        if (!pinsValid(pins)) failure('REVISION_CONFLICT');
        run = store.chargeRunBudget(run.id, { ...mutate(), bytes: Buffer.byteLength(JSON.stringify(result)), tool_calls: 1 });
        const observed = await bounded(() => step.verify({ result, input: run.input, results, run_id: run.id, signal }));
        current(); if (!pinsValid(pins)) failure('REVISION_CONFLICT');
        const expectedHash = workflowHash(result); const observedHash = workflowHash(observed);
        if (expectedHash !== observedHash) failure('PROVIDER_FAILURE');
        const saved = store.putRunStep(run.id, { ...mutate(), key: step.key, expected_step_revision: started.step.revision,
          kind: step.kind, state: 'verified', input_hash: inputHash, source_pins: pins, result,
          verification: { status: 'passed', method: step.verification_method, expected_hash: expectedHash,
            observed_hash: observedHash, evidence_ref: `local-run:${run.id}:step:${step.key}` } });
        run = saved.run; results[step.key] = result;
        activeStep = null; pendingResult = null;
        run = store.transitionRun(run.id, { ...mutate(), state: 'running', checkpoint: { next_step: index + 1, resumable: true } });
      }
      current();
      run = store.transitionRun(run.id, { ...mutate(), state: 'verifying' });
      return store.transitionRun(run.id, { ...mutate(), state: 'completed', checkpoint: { next_step: recipe.steps.length, resumable: false },
        evidence_refs: store.listRunSteps(run.id).map(step => step.verification.evidence_ref) });
    } catch (error) {
      run = store.getRun(run.id);
      // A lost lease is owned by recovery; never overwrite a newer executor.
      if (run.lease?.owner !== owner || run.lease?.epoch !== epoch || Date.parse(run.lease.expires_at) <= Date.now()) throw error;
      const stopped = run.cancel_requested || error.code === 'CANCELLED' || signal?.aborted;
      const hasResult = store.listRunSteps(run.id).some(step => step.state === 'verified');
      const uncertainWrite = activeStep?.kind === 'local_write';
      if (activeStep) {
        const saved = store.putRunStep(run.id, { ...mutate(), key: activeStep.key, expected_step_revision: activeStep.revision,
          kind: activeStep.kind, state: uncertainWrite ? 'unknown_outcome' : 'interrupted', input_hash: activeStep.input_hash,
          source_pins: activeStep.source_pins, result: uncertainWrite ? pendingResult : null });
        run = saved.run;
      }
      const state = uncertainWrite ? 'unknown_outcome' : stopped ? (hasResult ? 'partial' : 'cancelled') : error.code === 'BUDGET_EXCEEDED' ? (hasResult ? 'partial' : 'failed') : 'interrupted';
      return store.transitionRun(run.id, { ...mutate(), state, checkpoint: { next_step: Object.keys(results).length, resumable: !stopped },
        error: { code: error.code || 'PROVIDER_FAILURE', next_action: stopped ? 'Review any saved partial result.' : 'Review the failed step and changed inputs before resuming.' } });
    }
  }
  return {
    prepare,
    execute(runId, options = {}) {
      if (active.has(runId)) failure('REVISION_CONFLICT');
      const controller = new AbortController();
      const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
      const pending = work(runId, { ...options, signal }); active.set(runId, { pending, controller });
      pending.finally(() => active.delete(runId)).catch(() => {}); return pending;
    },
    cancel(runId, expectedRevision) { const run = store.requestRunCancel(runId, expectedRevision); active.get(runId)?.controller.abort(); return run; },
    isActive(runId) { return active.has(runId); },
    async drain() { for (const item of active.values()) item.controller.abort(); await Promise.allSettled([...active.values()].map(item => item.pending)); },
  };
}

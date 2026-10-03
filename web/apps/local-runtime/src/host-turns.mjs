import { randomUUID, createHash } from 'node:crypto';
import { LearnBridgeError } from '@learnbridge/core';
import { executeCodexTurn } from './codex-exec.mjs';

const FORMAT = 'learnbridge_codex_turn.v1';
const sha = text => createHash('sha256').update(text).digest('hex');
const denied = code => { throw new LearnBridgeError(code); };
const terminal = new Set(['completed', 'failed', 'unknown_outcome', 'interrupted', 'withheld']);
const plain = (value, fields) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key))) denied('INVALID_INPUT');
};

/** Browser-owned turns, fixed host and scope. The executor seam is trusted library code only. */
export function createHostTurns({ store, execute = executeCodexTurn, enabled = false }) {
  if (!store || typeof execute !== 'function' || typeof enabled !== 'boolean') denied('INVALID_INPUT');
  const active = new Map(); let stopping = false;
  const records = () => store.listWorkspaceRecords({ kind: 'artifact' }).filter(item => item.data.format === FORMAT);
  const getRecord = id => { const item = store.getWorkspaceRecord(id); if (!item || item.data.format !== FORMAT) denied('INVALID_INPUT'); return item; };
  const validGrant = item => {
    const grant = store.assertAgentGrant({ destination: 'codex', grant_id: item.data.grant_id });
    if (grant.consent_fingerprint !== item.data.grant_fingerprint) denied('CONSENT_REQUIRED');
    return true;
  };
  const view = item => {
    let allowed = true; try { validGrant(item); } catch { allowed = false; }
    const data = { ...item.data, text: allowed && item.data.state === 'completed' ? item.data.text || '' : '',
      prompt: allowed ? item.data.prompt : '', progress: item.data.progress || [],
      tool_receipts: allowed ? item.data.tool_receipts || [] : [],
      visibility: allowed ? 'selected_grant_current' : 'withheld_scope_changed' };
    return { ...item, data };
  };
  const save = (id, patch) => { const item = getRecord(id); return store.updateWorkspaceRecord(id, { expected_revision: item.revision, data: { ...item.data, ...patch } }); };
  // No model turn is replayed automatically after a restart.
  for (const item of records()) if (!terminal.has(item.data.state)) save(item.id, { state: 'unknown_outcome', error_code: 'RUNTIME_RESTARTED',
    text: '', tool_receipts: [], finished_at: new Date().toISOString(), retry_requires_new_review: true });

  return {
    capability: () => ({ id: 'codex_turns', state: enabled ? 'requires_host' : 'unavailable', mode: 'official_subscription_one_shot',
      detail: enabled ? 'A fixed Codex invocation uses a current selected grant and the official ChatGPT login. No API fallback. Proposed changes require dashboard review.'
        : 'The embedded host remains disabled until its isolated invocation passes the actual host gate. External project MCP use is available.',
      native_resume_available: false, proposals_require_review: true }),
    list: () => records().sort((a, b) => b.created_at.localeCompare(a.created_at)).map(view),
    get: id => view(getRecord(id)),
    async start(input, { idempotencyKey, authorize }) {
      plain(input, ['grant_id', 'prompt', 'confirmed']);
      if (input.confirmed !== true || typeof input.prompt !== 'string' || !input.prompt.trim() || Buffer.byteLength(input.prompt) > 16000 || input.prompt.includes('\0') || typeof authorize !== 'function') denied('INVALID_INPUT');
      if (!enabled) denied('UNSUPPORTED'); if (stopping) denied('OFFLINE');
      if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) denied('INVALID_INPUT');
      if (authorize() !== true) denied('CONSENT_REQUIRED');
      const grant = store.assertAgentGrant({ destination: 'codex', grant_id: input.grant_id });
      const request_hash = sha(JSON.stringify({ grant_id: grant.id, grant_fingerprint: grant.consent_fingerprint, prompt: input.prompt }));
      const prior = records().find(item => item.data.idempotency_key === idempotencyKey);
      if (prior) { if (prior.data.request_hash !== request_hash) denied('REVISION_CONFLICT'); return view(prior); }
      if (active.size) denied('REVISION_CONFLICT');
      const item = store.createWorkspaceRecord({ kind: 'artifact', title: 'Codex workspace conversation', data: {
        format: FORMAT, host: 'codex', grant_id: grant.id, grant_revision: grant.revision,
        grant_fingerprint: grant.consent_fingerprint, prompt: input.prompt,
        request_hash, idempotency_key: idempotencyKey, state: 'queued', text: '', tool_receipts: [], progress: [],
        created_at: new Date().toISOString(), finished_at: null, native_resume_available: false,
        proposals_require_review: true, account_mode: 'official_chatgpt_managed', instance: randomUUID(),
      } }, { idempotencyKey: `host-${idempotencyKey}` });
      const controller = new AbortController();
      const authorized = () => { if (stopping || controller.signal.aborted || authorize() !== true) return false; validGrant(getRecord(item.id)); return true; };
      const operation = Promise.resolve().then(async () => {
        if (!authorized()) denied('CONSENT_REQUIRED'); save(item.id, { state: 'running' });
        const result = await execute({ dataRoot: store.root, grantId: grant.id, prompt: input.prompt, authorize: authorized, signal: controller.signal,
          onProgress: progress => {
            if (!authorized()) denied('CONSENT_REQUIRED');
            if (!progress || progress.phase !== 'tool' || !['learnbridge_status', 'learnbridge_context', 'learnbridge_propose_task', 'learnbridge_propose_document'].includes(progress.tool) || !['running', 'finished'].includes(progress.state)) denied('VERSION_MISMATCH');
            const current = getRecord(item.id); if (current.data.progress.length < 50) save(item.id, { progress: [...current.data.progress, { tool: progress.tool, state: progress.state }] });
          } });
        let allowed = false; try { allowed = authorized(); } catch {}
        if (!allowed) { save(item.id, { state: controller.signal.aborted ? 'interrupted' : 'withheld', error_code: controller.signal.aborted ? 'CANCELLED' : 'CONSENT_REQUIRED', text: '', tool_receipts: [], finished_at: new Date().toISOString() }); return; }
        if (!result || !terminal.has(result.state) || typeof result.text !== 'string' || Buffer.byteLength(result.text) > 64000 || !Array.isArray(result.tool_receipts) || result.tool_receipts.length > 20 || result.output_sha256 !== sha(result.text) || result.complete !== (result.state === 'completed')) denied('VERSION_MISMATCH');
        const receipts = result.tool_receipts.map(receipt => {
          if (!receipt || Object.keys(receipt).some(key => !['tool', 'status', 'failed', 'result_hash'].includes(key)) || !['learnbridge_status', 'learnbridge_context', 'learnbridge_propose_task', 'learnbridge_propose_document'].includes(receipt.tool) || typeof receipt.failed !== 'boolean' || !/^[a-f0-9]{64}$/.test(receipt.result_hash)) denied('VERSION_MISMATCH');
          return { tool: receipt.tool, status: ['completed', 'failed'].includes(receipt.status) ? receipt.status : 'unknown', failed: receipt.failed, result_hash: receipt.result_hash };
        });
        if (result.state === 'completed' && (!result.text.trim() || !receipts.some(receipt => receipt.tool === 'learnbridge_context' && receipt.status === 'completed' && !receipt.failed) || receipts.some(receipt => receipt.failed))) denied('VERSION_MISMATCH');
        save(item.id, { state: result.state, text: result.state === 'completed' ? result.text : '', output_sha256: result.output_sha256,
          tool_receipts: receipts, host_version: result.host_version, error_code: result.error_code || null, finished_at: new Date().toISOString() });
      }).catch(error => {
        const current = getRecord(item.id); if (terminal.has(current.data.state)) return;
        const code = ['UNSUPPORTED', 'AUTH_REQUIRED', 'CONSENT_REQUIRED', 'SCOPE_DENIED', 'VERSION_MISMATCH', 'OFFLINE', 'BUDGET_EXCEEDED', 'CANCELLED', 'TIMEOUT'].includes(error?.code) ? error.code : 'PROVIDER_FAILURE';
        save(item.id, { state: controller.signal.aborted ? 'interrupted' : ['CONSENT_REQUIRED', 'SCOPE_DENIED'].includes(code) ? 'withheld' : 'failed',
          error_code: code, text: '', tool_receipts: [], finished_at: new Date().toISOString() });
      }).finally(() => active.delete(item.id));
      active.set(item.id, { operation, controller }); return view(item);
    },
    cancel(id, { expected_revision }) {
      const item = getRecord(id); if (item.revision !== expected_revision) denied('REVISION_CONFLICT');
      if (terminal.has(item.data.state)) return view(item);
      active.get(id)?.controller.abort(); return view(save(id, { state: 'interrupted', error_code: 'CANCELLED', text: '', tool_receipts: [], finished_at: new Date().toISOString() }));
    },
    async drain() { stopping = true; for (const value of active.values()) value.controller.abort(); await Promise.allSettled([...active.values()].map(value => value.operation)); },
  };
}

import { REMOTE_ORIGIN, remoteObject, remoteId, remoteHash, remoteFail, parseRemoteBinding } from '../../../packages/core/src/remote-companion.mjs';
import { REMOTE_RESULT_VERSION, REMOTE_RESULT_LIMITS, parseRemoteResultPolicy, parseRemoteResultUpload, parseRemoteDelivery, boundedRemoteResultBody } from '../../../packages/core/src/remote-results.mjs';
import { createRemoteCompanion, createRemoteTransport } from './remote-companion.mjs';
import { createWritingService } from './writing-service.mjs';

const FORMAT = 'learnbridge_remote_reviewed_result.v1', HOST_FORMAT = 'learnbridge_remote_host_dispatch.v1';
const fixed = params => ({ ...createRemoteTransport(params), results: params.binding_id ? createRemoteResultTransport(params).send : async () => remoteFail('REMOTE_PAIRING_REQUIRED', 403) });

/** Fixed HTTPS relay only. This is not an inbound laptop listener or an agent RPC. */
export function createRemoteResultTransport({ token, installation_instance_id, binding_id, fetchImpl = fetch }) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) || typeof fetchImpl !== 'function') remoteFail();
  remoteId(installation_instance_id); remoteId(binding_id);
  return { async send(operation, payload) {
    if (!['preflight', 'inspect', 'upload', 'status', 'claim_delivery', 'approve_delivery', 'deny_delivery', 'revoke'].includes(operation)) remoteFail();
    const body = JSON.stringify(payload); if (Buffer.byteLength(body) > REMOTE_RESULT_LIMITS.envelope_bytes) remoteFail('REMOTE_TOO_LARGE', 413);
    let response;
    try { response = await fetchImpl(`${REMOTE_ORIGIN}/api/remote/v1/results/device`, { method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-LearnBridge-Instance': installation_instance_id,
        'X-LearnBridge-Binding': binding_id, 'X-LearnBridge-Operation': operation }, body, signal: AbortSignal.timeout(10000) }); }
    catch { remoteFail('REMOTE_OFFLINE', 503); }
    if (!response.ok) { void response.body?.cancel().catch(() => {}); remoteFail('REMOTE_RESULT_RELAY_DENIED', 403); }
    return boundedRemoteResultBody(response);
  } };
}

/** Explicit foreground phone bridge. Credentials stay in memory; result sharing is a separate exact student review. */
export function createRemoteResults({ store, instance, enabled = false, authorize = () => false, transportFactory = fixed,
  clock = () => new Date().toISOString(), nativeEnabled = false, executeStudy, inspectStudy, cancelStudy }) {
  if (typeof enabled !== 'boolean' || typeof nativeEnabled !== 'boolean' || typeof authorize !== 'function' || typeof transportFactory !== 'function'
    || (nativeEnabled && [executeStudy, inspectStudy, cancelStudy].some(callback => typeof callback !== 'function'))) remoteFail();
  let channel = null, binding = null, stopped = false, busy = false, nativeConsent = false, ownBindingId = null;
  const writing = createWritingService({ store }), rows = format => store.listWorkspaceRecords({ kind: 'artifact' }).filter(row => row.data.format === format);
  const update = (row, patch) => store.updateWorkspaceRecord(row.id, { expected_revision: row.revision, data: { ...row.data, ...patch } });
  const companion = createRemoteCompanion({ store, instance, enabled, authorize, clock, transportFactory: params => {
    const value = transportFactory(params); if (params.binding_id) channel = value; return value;
  } });
  if (enabled) for (const row of rows(FORMAT)) if (row.data.state === 'uploading') update(row, { state: 'unknown_upload', recovery: 'Check relay metadata before retrying; no result was uploaded automatically after restart.' });
  if (enabled) for (const row of rows(HOST_FORMAT)) if (row.data.state === 'dispatching') update(row, { state: 'unknown_outcome', recovery: 'An uncertain native start is never repeated automatically.' });
  function gate() {
    if (!enabled || stopped) remoteFail('REMOTE_DISABLED', 503);
    if (authorize() !== true || !instance?.assertCurrent()) remoteFail('REMOTE_CONSENT_REQUIRED', 403);
    if (!binding || !channel) remoteFail('REMOTE_PAIRING_REQUIRED', 403);
    const actual = parseRemoteBinding(binding, { now: clock() });
    if (actual.installation_instance_id !== instance.installation_instance_id || actual.workspace_ref !== instance.workspace_ref) remoteFail('REMOTE_INSTANCE_CHANGED', 403);
    store.assertAgentGrant({ destination: 'codex', grant_id: actual.policy.host_grant_id }); const grant = store.getAgentGrant(actual.policy.host_grant_id);
    if (remoteHash(grant.pins) !== actual.policy.selection_hash || grant.expires_at < actual.policy.expires_at) remoteFail('REMOTE_CONSENT_REQUIRED', 403);
    return grant;
  }
  async function fresh() {
    gate(); const actual = parseRemoteBinding(await channel.send('heartbeat', {}), { now: clock() }); gate();
    if (actual.id !== binding.id || actual.account_id !== binding.account_id || actual.phone_session_ref !== binding.phone_session_ref
      || actual.revision !== binding.revision || remoteHash(actual.policy) !== remoteHash(binding.policy)) remoteFail('REMOTE_CONSENT_REQUIRED', 403);
    binding = actual; if (await channel.results('preflight', {}) !== true) remoteFail('REMOTE_CONSENT_REQUIRED', 403); return gate();
  }
  async function inspectJob(id) {
    await fresh(); const job = await channel.results('inspect', { job_id: remoteId(id) }); gate();
    remoteObject(job, ['id', 'binding_id', 'account_id', 'input_hash', 'state', 'local_run_ref', 'sequence']);
    if (job.id !== id || job.binding_id !== binding.id || job.account_id !== binding.account_id || job.state !== 'awaiting_student'
      || typeof job.local_run_ref !== 'string' || !Number.isSafeInteger(job.sequence)) remoteFail('REMOTE_RESULT_JOB_DENIED', 403);
    return job;
  }
  function currentResult(policy) {
    const grant = gate(), checked = parseRemoteResultPolicy(policy, { now: clock() });
    if (checked.binding_id !== binding.id || checked.account_id !== binding.account_id || checked.installation_instance_id !== instance.installation_instance_id
      || checked.workspace_ref !== instance.workspace_ref || checked.phone_session_ref !== binding.phone_session_ref || checked.binding_revision !== binding.revision
      || checked.binding_policy_hash !== remoteHash(binding.policy) || checked.host_grant_id !== binding.policy.host_grant_id || checked.selection_hash !== binding.policy.selection_hash
      || checked.expires_at > binding.policy.expires_at) remoteFail('REMOTE_RESULT_CONSENT_REQUIRED', 403);
    const exported = writing.exportArtifact(checked.writing_record.id, { expected_revision: checked.writing_record.revision, payload_hash: checked.writing_record.payload_hash });
    const pins = exported.source_documents.map(({ id, revision, sha256 }) => ({ id, revision, sha256 })).sort((a, b) => a.id.localeCompare(b.id));
    if (pins.some(pin => !grant.pins.documents.some(allowed => allowed.id === pin.id && allowed.revision === pin.revision)
      || store.getDocument(pin.id)?.sha256 !== pin.sha256)) remoteFail('REMOTE_RESULT_CONSENT_REQUIRED', 403);
    if (exported.document.id !== checked.document.id || exported.document.revision !== checked.document.revision || exported.sha256 !== checked.document.sha256
      || exported.byte_length !== checked.result_bytes || exported.content_status !== checked.content_status || exported.document.academic_policy !== checked.academic_policy
      || remoteHash(pins) !== remoteHash(checked.source_documents)) remoteFail('REMOTE_RESULT_CONFLICT', 409);
    return exported;
  }
  function getResult(id) { const row = store.getWorkspaceRecord(remoteId(id)); if (!row || row.data.format !== FORMAT) remoteFail('REMOTE_RESULT_NOT_FOUND', 404); return row; }
  async function exclusive(action) { if (busy) remoteFail('REMOTE_BUSY', 409); busy = true; try { return await action(); } finally { busy = false; } }
  const cancelPending = () => Promise.allSettled(rows(HOST_FORMAT).filter(row => row.data.state === 'native_queued' && row.data.binding_id === ownBindingId)
    .map(row => Promise.resolve().then(() => cancelStudy(row.data.host_run_id))));
  const resultMetadata = row => ({ id: row.id, revision: row.revision, job_id: row.data.policy.job_id, state: row.data.state, relay_result_id: row.data.relay_result_id,
    result_sha256: row.data.policy.result_sha256, result_bytes: row.data.policy.result_bytes, expires_at: row.data.policy.expires_at, review_hash: row.data.review_hash,
    content_status: row.data.policy.content_status, native_execution: false });
  return {
    status() { let current = false; if (binding && !stopped) try { gate(); current = true; } catch {}
      return { enabled, paired: !!binding && !stopped, permission_current: current, binding_id: binding?.id || null, account_id: binding?.account_id || null,
      expires_at: binding?.policy.expires_at || null, native_available: nativeEnabled, native_execution: current && nativeEnabled && nativeConsent, result_mode: 'exact_locally_reviewed_text',
      foreground_required: true, credentials_persisted: false, inbound_listener: false, telemetry: false }; },
    async pair(input) {
      remoteObject(input, ['pending_id', 'challenge', 'confirmed', 'host_grant_id', 'expires_in_minutes', 'max_requests', 'max_request_bytes', 'native_execution_confirmed']);
      if (typeof input.native_execution_confirmed !== 'boolean' || (input.native_execution_confirmed && !nativeEnabled)) remoteFail('REMOTE_NATIVE_UNAVAILABLE', 503);
      const { native_execution_confirmed, ...legacy } = input; const result = await companion.pair(legacy);
      binding = parseRemoteBinding(await channel.send('heartbeat', {}), { now: clock() }); ownBindingId = binding.id; await fresh(); nativeConsent = native_execution_confirmed;
      store.createWorkspaceRecord({ kind: 'artifact', title: 'Phone connection review', data: { format: 'learnbridge_remote_enrollment.v1', binding_id: binding.id,
        account_id: binding.account_id, instance_id: instance.installation_instance_id, selection_hash: binding.policy.selection_hash,
        policy_hash: remoteHash(binding.policy), native_execution_confirmed, reviewed_at: clock(), reviewer: store.identity.student_id,
        result_sharing: 'separate_exact_review_required', credential_persisted: false } }, { idempotencyKey: `remote-enrollment-${binding.id}` });
      return { ...result, native_execution: nativeEnabled && nativeConsent, result_sharing: 'separate_exact_review_required' };
    },
    jobs() { return rows('learnbridge_remote_dispatch.v1').map(row => ({ id: row.id, job_id: row.data.job_id, state: row.data.state, recipe_note_id: row.data.recipe_note_id,
      native: rows(HOST_FORMAT).find(host => host.data.job_id === row.data.job_id)?.data || null })).map(row => ({ ...row, native: row.native && {
        state: row.native.state, host_run_id: row.native.host_run_id, writing_record_id: row.native.writing_record_id || null } })); },
    async pollOnce() { return exclusive(async () => {
      await fresh(); const prepared = await companion.pollOnce(); gate();
      if (!nativeEnabled || !nativeConsent || !prepared.local_note_id) return prepared;
      const dispatch = rows('learnbridge_remote_dispatch.v1').find(row => row.data.recipe_note_id === prepared.local_note_id);
      if (!dispatch || rows(HOST_FORMAT).some(row => row.data.job_id === dispatch.data.job_id)) return { ...prepared, native_dispatch_repeated: false };
      const note = store.getDocument(prepared.local_note_id); let recipe; try { recipe = JSON.parse(note.text); } catch { remoteFail(); }
      let host = store.createWorkspaceRecord({ kind: 'artifact', title: 'Phone study execution', data: { format: HOST_FORMAT, job_id: dispatch.data.job_id,
        binding_id: binding.id, state: 'dispatching', host_run_id: null, writing_record_id: null } }, { idempotencyKey: `remote-native-${dispatch.data.job_id}` });
      try { const grant = gate(); const actual = await executeStudy({ job_id: dispatch.data.job_id, grant_id: grant.id, prompt: recipe.prompt,
        authorize: () => { try { gate(); return nativeConsent; } catch { return false; } }, idempotency_key: `remote-${dispatch.data.job_id}` });
        gate(); host = update(host, { state: 'native_queued', host_run_id: remoteId(actual.id) }); return { ...prepared, native_execution: true, host_run_id: host.data.host_run_id };
      } catch (error) { update(host, { state: 'unknown_outcome' }); throw error; }
    }); },
    async pollNative() { return exclusive(async () => {
      await fresh(); if (!nativeEnabled || !nativeConsent) remoteFail('REMOTE_NATIVE_UNAVAILABLE', 503);
      const pending = rows(HOST_FORMAT).find(row => row.data.state === 'native_queued'); if (!pending) return { state: 'idle' };
      try { await inspectJob(pending.data.job_id); } catch (error) { await cancelStudy(pending.data.host_run_id); update(pending, { state: 'withheld' }); throw error; }
      const actual = await inspectStudy(pending.data.host_run_id); gate();
      if (actual.id !== pending.data.host_run_id || !actual.data || actual.data.visibility !== 'selected_grant_current') remoteFail('REMOTE_NATIVE_RESULT_DENIED', 403);
      if (['queued', 'running'].includes(actual.data.state)) return { state: actual.data.state, host_run_id: actual.id };
      if (actual.data.state !== 'completed' || typeof actual.data.text !== 'string' || !actual.data.text.trim() || remoteHash(actual.data.text) !== actual.data.output_sha256) {
        update(pending, { state: 'withheld' }); return { state: 'withheld' };
      }
      const grant = gate(), sources = grant.pins.documents.map(pin => { const saved = store.getDocument(pin.id); return { id: pin.id, revision: saved.document.revision, sha256: saved.sha256 }; });
      const draft = writing.createProposal({ title: 'Phone study response — review before sharing', kind: 'study_guide', draft_text: actual.data.text,
        source_documents: sources, academic_policy: 'learning_support', origin: 'agent_paste' }, { agentOrigin: 'codex', grantId: grant.id, idempotencyKey: `remote-writing-${pending.data.job_id}` });
      update(pending, { state: 'awaiting_local_review', writing_record_id: draft.id }); return { state: 'awaiting_local_review', writing_record_id: draft.id, accepted: false, uploaded: false };
    }); },
    async previewResult(input) {
      remoteObject(input, ['job_id', 'writing_record_id', 'expected_revision', 'payload_hash', 'expires_in_minutes']);
      if (!Number.isSafeInteger(input.expires_in_minutes) || input.expires_in_minutes < 1 || input.expires_in_minutes > 60) remoteFail();
      const job = await inspectJob(remoteId(input.job_id)), exported = writing.exportArtifact(remoteId(input.writing_record_id), {
        expected_revision: input.expected_revision, payload_hash: input.payload_hash }); const grant = gate();
      const policy = parseRemoteResultPolicy({ version: REMOTE_RESULT_VERSION, binding_id: binding.id, account_id: binding.account_id,
        installation_instance_id: instance.installation_instance_id, workspace_ref: instance.workspace_ref, phone_session_ref: binding.phone_session_ref,
        binding_revision: binding.revision, binding_policy_hash: remoteHash(binding.policy), job_id: job.id, input_hash: job.input_hash,
        host_grant_id: grant.id, selection_hash: remoteHash(grant.pins), writing_record: { id: input.writing_record_id, revision: input.expected_revision, payload_hash: input.payload_hash },
        document: { id: exported.document.id, revision: exported.document.revision, sha256: exported.sha256 },
        source_documents: exported.source_documents.map(({ id, revision, sha256 }) => ({ id, revision, sha256 })), academic_policy: exported.document.academic_policy,
        content_status: exported.content_status, result_sha256: exported.sha256, result_bytes: exported.byte_length,
        expires_at: new Date(Math.min(Date.parse(binding.policy.expires_at), Date.parse(clock()) + input.expires_in_minutes * 60000)).toISOString(),
        relay_processing_confirmed: true, plaintext_notice_confirmed: true, retention_hours: 24 }, { now: clock() });
      currentResult(policy); return { policy, review_hash: remoteHash(policy), text: exported.text,
        disclosure: 'This exact reviewed text, including copied source evidence, will pass through the trusted plaintext LearnBridge relay. Separate consent; no telemetry. Relay retention: 24 hours. Already delivered copies cannot be recalled.' };
    },
    async approveResult(preview, input) {
      remoteObject(preview, ['policy', 'review_hash', 'text', 'disclosure']); remoteObject(input, ['review_hash', 'confirmed']);
      if (input.confirmed !== true || input.review_hash !== preview.review_hash || remoteHash(preview.policy) !== input.review_hash) remoteFail('REMOTE_RESULT_CONSENT_REQUIRED', 403);
      await inspectJob(preview.policy.job_id); const actual = currentResult(preview.policy);
      if (actual.text !== preview.text || remoteHash(preview.text) !== preview.policy.result_sha256) remoteFail('REMOTE_RESULT_CONFLICT', 409);
      const existing = rows(FORMAT).find(row => row.data.review_hash === input.review_hash);
      if (existing) { if (existing.data.state === 'revoked') remoteFail('REMOTE_RESULT_CONSENT_REQUIRED', 403); return resultMetadata(existing); }
      if (rows(FORMAT).length >= REMOTE_RESULT_LIMITS.retained_outboxes) remoteFail('REMOTE_RATE_LIMITED', 429);
      const row = store.createWorkspaceRecord({ kind: 'artifact', title: 'Reviewed phone response', data: { format: FORMAT, state: 'reviewed', policy: preview.policy,
        review_hash: input.review_hash, text: actual.text, relay_result_id: null, reviewer: store.identity.student_id, reviewed_at: clock(), external_copy_possible: false } },
      { idempotencyKey: `remote-result-${preview.policy.job_id}-${input.review_hash.slice(0, 32)}` }); return resultMetadata(row);
    },
    results() { return rows(FORMAT).map(resultMetadata); },
    async sendResult(id) { return exclusive(async () => {
      let row = getResult(id); if (row.data.state === 'revoked') remoteFail('REMOTE_RESULT_CONSENT_REQUIRED', 403);
      await inspectJob(row.data.policy.job_id); currentResult(row.data.policy);
      const prior = await channel.results('status', { local_result_id: row.id }); gate(); currentResult(row.data.policy);
      if (prior?.id) { if (prior.review_hash !== row.data.review_hash || prior.result_sha256 !== row.data.policy.result_sha256 || prior.local_result_id !== row.id || prior.state !== 'available') remoteFail('REMOTE_RESULT_CONFLICT', 409);
        row = update(row, { state: 'sent', relay_result_id: remoteId(prior.id), external_copy_possible: true }); return resultMetadata(row); }
      if (prior?.state !== 'not_found') remoteFail('REMOTE_RESULT_RELAY_INVALID', 503);
      row = update(row, { state: 'uploading', external_copy_possible: true });
      try { const checked = parseRemoteResultUpload({ schema_version: 1, local_result_id: row.id, policy: row.data.policy, review_hash: row.data.review_hash, text: row.data.text }, { now: clock() });
        currentResult(row.data.policy); const sent = await channel.results('upload', checked); gate();
        if (sent?.review_hash !== row.data.review_hash || sent?.result_sha256 !== row.data.policy.result_sha256 || sent?.local_result_id !== row.id || sent?.state !== 'available') remoteFail('REMOTE_RESULT_RELAY_INVALID', 503);
        row = update(row, { state: 'sent', relay_result_id: remoteId(sent.id) }); return resultMetadata(row);
      } catch (error) { update(row, { state: 'unknown_upload', recovery: 'Check relay metadata before retrying. The exact external copy may already exist.' }); throw error; }
    }); },
    async pollDeliveryOnce() { return exclusive(async () => {
      await fresh(); const raw = await channel.results('claim_delivery', {}); gate(); if (raw === null) return { state: 'idle' };
      const challenge = parseRemoteDelivery(raw, { now: clock() });
      if (challenge.binding_id !== binding.id || challenge.account_id !== binding.account_id) remoteFail('REMOTE_DELIVERY_DENIED', 403);
      const row = rows(FORMAT).find(row => row.data.relay_result_id === challenge.result_id && row.data.review_hash === challenge.review_hash && row.data.policy.result_sha256 === challenge.result_sha256);
      try { if (!row || row.data.state !== 'sent') remoteFail('REMOTE_DELIVERY_DENIED', 403); await inspectJob(row.data.policy.job_id); currentResult(row.data.policy);
        const response = await channel.results('approve_delivery', { delivery_id: challenge.id, nonce: challenge.nonce, review_hash: row.data.review_hash, result_sha256: row.data.policy.result_sha256 });
        gate(); if (response?.state !== 'ready') remoteFail('REMOTE_DELIVERY_DENIED', 403); return { state: 'ready', delivery_id: challenge.id, fresh_local_check: true };
      } catch (error) { try { await channel.results('deny_delivery', { delivery_id: challenge.id, nonce: challenge.nonce }); } catch {} throw error; }
    }); },
    async revokeResult(id) {
      let row = getResult(id); row = update(row, { state: 'revoked', text: '', revoked_at: clock(), relay_revocation_acknowledged: false });
      try { await fresh(); const response = await channel.results('revoke', { local_result_id: row.id });
        if (response?.state !== 'revoked') remoteFail('REMOTE_RESULT_RELAY_INVALID', 503); row = update(row, { relay_revocation_acknowledged: true }); }
      catch {} return { ...resultMetadata(row), relay_revocation_acknowledged: row.data.relay_revocation_acknowledged,
        retention: 'Local revision history, backups and delivered phone/browser copies may retain text. Relay deletion requires an acknowledgment or expiry/purge.' };
    },
    async unpair(input) { const result = await companion.unpair(input); channel = null; binding = null; nativeConsent = false; stopped = true;
      if (nativeEnabled) await cancelPending(); return result; },
    stop() { stopped = true; channel = null; binding = null; nativeConsent = false; const result = companion.stop();
      if (!nativeEnabled) return result;
      return cancelPending().then(() => result); },
  };
}

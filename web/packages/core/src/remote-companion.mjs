import { createHash } from 'node:crypto';

export const REMOTE_VERSION = 'remote-study-foundation-1';
export const REMOTE_ORIGIN = 'https://thelearnbridge.vercel.app';
export const REMOTE_LIMITS = Object.freeze({ request_bytes: 16384, prompt_characters: 4000, context_bytes: 48000,
  registration_ms: 300000, queued_job_ms: 900000, lease_ms: 60000, retention_hours: 24, queued_requests: 3 });
export class RemoteError extends Error { constructor(code, status = 400) { super(code); this.code = code; this.status = status; } }
export const remoteFail = (code = 'INVALID_REMOTE_INPUT', status) => { throw new RemoteError(code, status); };
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
export const remoteHash = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
export function remoteObject(value, fields, required = fields) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !fields.includes(key)
    || !('value' in Object.getOwnPropertyDescriptor(value, key)) || !Object.getOwnPropertyDescriptor(value, key).enumerable)
    || required.some(key => !Object.hasOwn(value, key))) remoteFail();
}
export function remoteId(value) { if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) remoteFail(); return value.toLowerCase(); }
export function remoteDigest(value) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) remoteFail(); return value; }
export function remoteStamp(value) { if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) remoteFail(); return value; }
export function parseRemoteStudyRequest(input) {
  remoteObject(input, ['schema_version', 'binding_id', 'client_request_id', 'recipe_id', 'recipe_version', 'prompt']);
  if (Buffer.byteLength(JSON.stringify(input)) > REMOTE_LIMITS.request_bytes) remoteFail('REMOTE_TOO_LARGE', 413);
  if (input.schema_version !== 1 || input.recipe_id !== 'study.explain' || input.recipe_version !== REMOTE_VERSION || typeof input.prompt !== 'string'
    || !input.prompt.trim() || input.prompt.length > REMOTE_LIMITS.prompt_characters || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.prompt)) remoteFail();
  return { schema_version: 1, binding_id: remoteId(input.binding_id), client_request_id: remoteId(input.client_request_id),
    recipe_id: input.recipe_id, recipe_version: input.recipe_version, prompt: input.prompt };
}
export function parseRemotePolicy(input, { now = new Date().toISOString() } = {}) {
  remoteObject(input, ['version', 'destination', 'host_grant_id', 'selection_hash', 'expires_at', 'max_requests', 'max_request_bytes',
    'recipes', 'relay_processing_confirmed', 'plaintext_notice_confirmed', 'retention_hours', 'result_scope']);
  if (input.version !== REMOTE_VERSION || input.destination !== 'codex' || input.relay_processing_confirmed !== true || input.plaintext_notice_confirmed !== true
    || input.retention_hours !== 24 || input.result_scope !== 'status_only' || !Number.isSafeInteger(input.max_requests) || input.max_requests < 1 || input.max_requests > 3
    || !Number.isSafeInteger(input.max_request_bytes) || input.max_request_bytes < 1 || input.max_request_bytes > 16384
    || !Array.isArray(input.recipes) || input.recipes.length !== 1 || input.recipes[0] !== 'study.explain') remoteFail('REMOTE_CONSENT_REQUIRED', 403);
  remoteStamp(now); remoteStamp(input.expires_at); if (input.expires_at <= now || Date.parse(input.expires_at) > Date.parse(now) + 3600000) remoteFail('REMOTE_CONSENT_REQUIRED', 403);
  return { ...input, host_grant_id: remoteId(input.host_grant_id), selection_hash: remoteDigest(input.selection_hash), recipes: ['study.explain'] };
}
export function parseRemoteBinding(input, { now = new Date().toISOString() } = {}) {
  remoteObject(input, ['id', 'account_id', 'installation_instance_id', 'workspace_ref', 'phone_session_ref', 'state', 'policy', 'revision', 'last_seen_at']);
  remoteId(input.id); remoteId(input.account_id); remoteId(input.installation_instance_id); remoteDigest(input.workspace_ref); remoteId(input.phone_session_ref);
  if (input.state !== 'active' || !Number.isSafeInteger(input.revision) || input.revision < 1) remoteFail('REMOTE_REVOKED', 403);
  if (input.last_seen_at !== null) remoteStamp(input.last_seen_at);
  return { ...input, policy: parseRemotePolicy(input.policy, { now }) };
}
export function parseRemoteLease(input) {
  remoteObject(input, ['id', 'binding_id', 'account_id', 'request', 'input_hash', 'state', 'lease_epoch', 'lease_expires_at', 'local_run_ref', 'expires_at', 'sequence']);
  remoteId(input.id); remoteId(input.binding_id); remoteId(input.account_id); remoteDigest(input.input_hash); remoteStamp(input.expires_at); remoteStamp(input.lease_expires_at);
  if (!['leased', 'local_accepted', 'cancel_requested', 'awaiting_student'].includes(input.state) || !Number.isSafeInteger(input.lease_epoch) || input.lease_epoch < 1
    || !Number.isSafeInteger(input.sequence) || input.sequence < 0) remoteFail();
  if (input.local_run_ref !== null) remoteId(input.local_run_ref); const request = parseRemoteStudyRequest(input.request);
  if (request.binding_id !== input.binding_id || remoteHash(request) !== input.input_hash) remoteFail('REMOTE_ENVELOPE_CONFLICT', 409);
  return { ...input, request };
}
/** @param {Request} request @param {number} [max] @param {number} [timeoutMs] */
export async function boundedRemoteBody(request, max = REMOTE_LIMITS.request_bytes, timeoutMs = 5000) {
  if (!Number.isSafeInteger(max) || max < 1 || max > REMOTE_LIMITS.request_bytes || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) remoteFail();
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') || '')) remoteFail('REMOTE_CONTENT_TYPE', 415);
  if (!request.body) remoteFail(); const reader = request.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }); let text = '', size = 0;
  let timer; const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new RemoteError('REMOTE_BODY_TIMEOUT', 408)), timeoutMs); });
  try { while (true) { const { done, value } = await Promise.race([reader.read(), timeout]); if (done) break; size += value.byteLength;
    if (size > max) remoteFail('REMOTE_TOO_LARGE', 413); text += decoder.decode(value, { stream: true }); } text += decoder.decode();
    return JSON.parse(text);
  } catch (error) { void reader.cancel().catch(() => {}); if (error instanceof RemoteError) throw error; remoteFail(); }
  finally { clearTimeout(timer); reader.releaseLock(); }
}

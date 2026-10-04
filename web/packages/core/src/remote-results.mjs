import { RemoteError, remoteObject, remoteId, remoteDigest, remoteStamp, remoteHash, remoteFail } from './remote-companion.mjs';

export const REMOTE_RESULT_VERSION = 'remote-reviewed-text-1';
export const REMOTE_RESULT_LIMITS = Object.freeze({ text_bytes: 48000, envelope_bytes: 128000, policy_bytes: 8192, delivery_ms: 30000, review_ms: 300000, retained_outboxes: 64 });
const revision = value => { if (!Number.isSafeInteger(value) || value < 1) remoteFail(); return value; };
const pin = value => { remoteObject(value, ['id', 'revision', 'sha256']); return { id: remoteId(value.id), revision: revision(value.revision), sha256: remoteDigest(value.sha256) }; };
function snapshot(value) {
  const seen = new Set(); let nodes = 0;
  const visit = (item, depth) => {
    if (++nodes > 10000 || depth > 12) remoteFail('REMOTE_TOO_LARGE', 413);
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return item;
    if (typeof item === 'string') { if (Buffer.byteLength(item) > REMOTE_RESULT_LIMITS.envelope_bytes) remoteFail('REMOTE_TOO_LARGE', 413); return item; }
    if (!item || typeof item !== 'object' || seen.has(item)) remoteFail(); seen.add(item);
    const props = Object.getOwnPropertyDescriptors(item); let output;
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || item.length > 100 || Reflect.ownKeys(props).some(key => key !== 'length'
        && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length || !props[key].enumerable || !Object.hasOwn(props[key], 'value')))) remoteFail();
      output = Array.from({ length: item.length }, (_, index) => { if (!Object.hasOwn(props, String(index))) remoteFail(); return visit(props[index].value, depth + 1); });
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype || Reflect.ownKeys(props).some(key => typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)
        || !props[key].enumerable || !Object.hasOwn(props[key], 'value'))) remoteFail();
      output = Object.fromEntries(Object.keys(props).map(key => [key, visit(props[key].value, depth + 1)]));
    }
    seen.delete(item); return output;
  };
  return visit(value, 0);
}
export function parseRemoteResultPolicy(value, { now = new Date().toISOString() } = {}) {
  value = snapshot(value);
  remoteObject(value, ['version', 'binding_id', 'account_id', 'installation_instance_id', 'workspace_ref', 'phone_session_ref', 'binding_revision', 'binding_policy_hash',
    'job_id', 'input_hash', 'host_grant_id', 'selection_hash', 'writing_record', 'document', 'source_documents', 'academic_policy', 'content_status',
    'result_sha256', 'result_bytes', 'expires_at', 'relay_processing_confirmed', 'plaintext_notice_confirmed', 'retention_hours']);
  if (Buffer.byteLength(JSON.stringify(value)) > REMOTE_RESULT_LIMITS.policy_bytes) remoteFail('REMOTE_TOO_LARGE', 413);
  remoteStamp(now); remoteStamp(value.expires_at);
  if (value.version !== REMOTE_RESULT_VERSION || value.expires_at <= now || Date.parse(value.expires_at) > Date.parse(now) + 3600000
    || value.relay_processing_confirmed !== true || value.plaintext_notice_confirmed !== true || value.retention_hours !== 24
    || !['unrestricted', 'learning_support', 'graded_restricted'].includes(value.academic_policy)
    || !['student_reviewed_content', 'student_reviewed_model_output_facts_unverified'].includes(value.content_status)
    || !Number.isSafeInteger(value.result_bytes) || value.result_bytes < 1 || value.result_bytes > REMOTE_RESULT_LIMITS.text_bytes
    || !Array.isArray(value.source_documents) || value.source_documents.length > 10) remoteFail('REMOTE_RESULT_CONSENT_REQUIRED', 403);
  remoteObject(value.writing_record, ['id', 'revision', 'payload_hash']);
  const source_documents = value.source_documents.map(pin);
  if (new Set(source_documents.map(source => source.id)).size !== source_documents.length) remoteFail();
  const document = pin(value.document), result_sha256 = remoteDigest(value.result_sha256);
  if (document.sha256 !== result_sha256) remoteFail('REMOTE_RESULT_CONFLICT', 409);
  return { ...value, binding_id: remoteId(value.binding_id), account_id: remoteId(value.account_id), installation_instance_id: remoteId(value.installation_instance_id),
    workspace_ref: remoteDigest(value.workspace_ref), phone_session_ref: remoteId(value.phone_session_ref), binding_revision: revision(value.binding_revision),
    binding_policy_hash: remoteDigest(value.binding_policy_hash), job_id: remoteId(value.job_id), input_hash: remoteDigest(value.input_hash),
    host_grant_id: remoteId(value.host_grant_id), selection_hash: remoteDigest(value.selection_hash), result_sha256, document,
    writing_record: { id: remoteId(value.writing_record.id), revision: revision(value.writing_record.revision), payload_hash: remoteDigest(value.writing_record.payload_hash) },
    source_documents: source_documents.sort((a, b) => a.id.localeCompare(b.id)) };
}
export function parseRemoteResultUpload(value, { now } = {}) {
  value = snapshot(value);
  remoteObject(value, ['schema_version', 'local_result_id', 'policy', 'review_hash', 'text']);
  if (Buffer.byteLength(JSON.stringify(value)) > REMOTE_RESULT_LIMITS.envelope_bytes) remoteFail('REMOTE_TOO_LARGE', 413);
  if (value.schema_version !== 1 || typeof value.text !== 'string' || !value.text.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value.text)
    || Buffer.byteLength(value.text) > REMOTE_RESULT_LIMITS.text_bytes) remoteFail();
  for (const character of value.text) if (character.codePointAt(0) >= 0xd800 && character.codePointAt(0) <= 0xdfff) remoteFail();
  const policy = parseRemoteResultPolicy(value.policy, { now }), review_hash = remoteDigest(value.review_hash);
  if (remoteHash(policy) !== review_hash || remoteHash(value.text) !== policy.result_sha256 || Buffer.byteLength(value.text) !== policy.result_bytes) remoteFail('REMOTE_RESULT_CONFLICT', 409);
  return { schema_version: 1, local_result_id: remoteId(value.local_result_id), policy, review_hash, text: value.text };
}
export function parseRemoteDelivery(value, { now = new Date().toISOString() } = {}) {
  value = snapshot(value);
  remoteObject(value, ['id', 'binding_id', 'account_id', 'result_id', 'result_sha256', 'review_hash', 'nonce', 'expires_at']);
  remoteStamp(now); remoteStamp(value.expires_at);
  if (typeof value.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(value.nonce) || value.expires_at <= now || Date.parse(value.expires_at) > Date.parse(now) + 60000) remoteFail('REMOTE_DELIVERY_DENIED', 403);
  return { ...value, id: remoteId(value.id), binding_id: remoteId(value.binding_id), account_id: remoteId(value.account_id), result_id: remoteId(value.result_id),
    result_sha256: remoteDigest(value.result_sha256), review_hash: remoteDigest(value.review_hash) };
}

/** Separate result envelope budget; no hanging cancellation or unbounded reader.
 * @param {Request|Response} request @param {number} [maximum] @param {number} [timeoutMs] */
export async function boundedRemoteResultBody(request, maximum = REMOTE_RESULT_LIMITS.envelope_bytes, timeoutMs = 5000) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > REMOTE_RESULT_LIMITS.envelope_bytes || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) remoteFail();
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') || '')) remoteFail('REMOTE_CONTENT_TYPE', 415);
  if (!request.body) remoteFail(); const reader = request.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }); let timer, size = 0, text = '';
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { try { remoteFail('REMOTE_BODY_TIMEOUT', 408); } catch (error) { reject(error); } }, timeoutMs); });
  try { while (true) { const { done, value } = await Promise.race([reader.read(), timeout]); if (done) break; size += value.byteLength;
    if (size > maximum) remoteFail('REMOTE_TOO_LARGE', 413); text += decoder.decode(value, { stream: true }); } return JSON.parse(text + decoder.decode());
  } catch (error) { void reader.cancel().catch(() => {}); if (error instanceof RemoteError) throw error; remoteFail(); }
  finally { clearTimeout(timer); reader.releaseLock(); }
}

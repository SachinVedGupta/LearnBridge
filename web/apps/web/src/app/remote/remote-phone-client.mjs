// Browser-only relay helpers. Never read host credentials or persist private text.
const id = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const encode = text => new TextEncoder().encode(text);
export async function phoneHash(value) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encode(typeof value === 'string' ? value : canonical(value))))].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
export function phoneStudyRequest(binding, prompt, clientId = crypto.randomUUID()) {
  if (!id(binding) || !id(clientId) || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(prompt)) throw Error('Enter a study question of up to 4,000 characters.');
  return { schema_version: 1, binding_id: binding, client_request_id: clientId, recipe_id: 'study.explain', recipe_version: 'remote-study-foundation-1', prompt };
}
export async function verifyPhoneResult(result, {bindingId, resultId, deliveryId, now = Date.now()}) {
  if (!object(result, ['id', 'local_result_id', 'text', 'result_sha256', 'review_hash', 'policy', 'delivery_id', 'fresh_local_check'])
    || result.id !== resultId || result.delivery_id !== deliveryId || result.fresh_local_check !== true || !id(result.local_result_id)
    || typeof result.text !== 'string' || !result.text.trim() || !digest(result.result_sha256) || !digest(result.review_hash)) throw Error('This response could not be verified.');
  const policy = result.policy, fields = ['version','binding_id','account_id','installation_instance_id','workspace_ref','phone_session_ref','binding_revision','binding_policy_hash',
    'job_id','input_hash','host_grant_id','selection_hash','writing_record','document','source_documents','academic_policy','content_status','result_sha256','result_bytes',
    'expires_at','relay_processing_confirmed','plaintext_notice_confirmed','retention_hours'];
  const pin = value => object(value, ['id','revision','sha256']) && id(value.id) && Number.isSafeInteger(value.revision) && value.revision > 0 && digest(value.sha256);
  if (!object(policy, fields) || policy.version !== 'remote-reviewed-text-1' || policy.binding_id !== bindingId || !id(bindingId)
    || ['account_id','installation_instance_id','phone_session_ref','job_id','host_grant_id'].some(key => !id(policy[key]))
    || ['workspace_ref','binding_policy_hash','input_hash','selection_hash','result_sha256'].some(key => !digest(policy[key]))
    || !Number.isSafeInteger(policy.binding_revision) || policy.binding_revision < 1 || !pin(policy.document)
    || !object(policy.writing_record, ['id','revision','payload_hash']) || !id(policy.writing_record.id) || !Number.isSafeInteger(policy.writing_record.revision) || policy.writing_record.revision < 1 || !digest(policy.writing_record.payload_hash)
    || !Array.isArray(policy.source_documents) || policy.source_documents.length > 10 || !policy.source_documents.every(pin)
    || new Set(policy.source_documents.map(pin => pin.id)).size !== policy.source_documents.length
    || !['unrestricted','learning_support','graded_restricted'].includes(policy.academic_policy)
    || !['student_reviewed_content','student_reviewed_model_output_facts_unverified'].includes(policy.content_status)
    || policy.relay_processing_confirmed !== true || policy.plaintext_notice_confirmed !== true || policy.retention_hours !== 24
    || !Number.isSafeInteger(policy.result_bytes) || policy.result_bytes < 1 || policy.result_bytes > 48000
    || typeof policy.expires_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(policy.expires_at)
    || !Number.isFinite(Date.parse(policy.expires_at)) || Date.parse(policy.expires_at) <= now || Date.parse(policy.expires_at) > now + 3600000
    || policy.result_sha256 !== result.result_sha256 || policy.document.sha256 !== result.result_sha256
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result.text) || encode(result.text).length !== policy.result_bytes) throw Error('This response no longer matches its reviewed permission.');
  for (const character of result.text) if (character.codePointAt(0) >= 0xd800 && character.codePointAt(0) <= 0xdfff) throw Error('This response contains invalid text.');
  if (await phoneHash(result.text) !== result.result_sha256 || await phoneHash(policy) !== result.review_hash) throw Error('The exact reviewed response hash did not match.');
  if (Date.parse(policy.expires_at) <= Date.now()) throw Error('The response permission expired while checking it.');
  return { text: result.text, sha256: result.result_sha256, contentStatus: policy.content_status, expiresAt: policy.expires_at };
}
export class PhoneRelayError extends Error { constructor(code) { super(code === 'REMOTE_DELIVERY_WAITING' ? 'Waiting for a fresh check on your computer.' : code?.includes('DISABLED') ? 'Phone access is awaiting its release checks.' : 'Permission changed or the relay is unavailable. Refresh before trying again.'); this.code = code; } }
/** @param {{operation?:string,body?:unknown,bindingId?:string,results?:boolean,signal?:AbortSignal,fetchImpl?:typeof fetch}} input */
export async function phoneRelay({operation, body, bindingId, results = false, signal, fetchImpl = fetch}) {
  if (bindingId && !id(bindingId)) throw Error('Choose a current paired computer.');
  const headers = {'Content-Type':'application/json',...(operation ? {'X-LearnBridge-Operation':operation} : {}),...(bindingId ? {'X-LearnBridge-Binding':bindingId} : {})};
  const response = await fetchImpl(`/api/remote/v1${results ? '/results' : ''}`, {method: operation ? 'POST' : 'GET',headers,
    ...(operation ? {body:JSON.stringify(body)} : {}),cache:'no-store',credentials:'same-origin',redirect:'error',signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000)});
  if (!response.body || !/^application\/json(?:\s*;.*)?$/i.test(response.headers.get('content-type') || '')) throw Error('The relay returned an invalid response.');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8',{fatal:true}); let size = 0, text = '';
  try { while (true) { const {done,value} = await reader.read(); if (done) break; size += value.byteLength; if (size > 128000) throw Error('The relay response was too large.'); text += decoder.decode(value,{stream:true}); }
    const value = JSON.parse(text + decoder.decode()); if (!response.ok) throw new PhoneRelayError(typeof value?.error?.code === 'string' ? value.error.code : 'REMOTE_UNAVAILABLE'); return value;
  } catch (error) { void reader.cancel().catch(() => {}); throw error; } finally { reader.releaseLock(); }
}

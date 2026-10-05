import { createHmac, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { LearnBridgeError } from '@learnbridge/core';
import { cloudCopy, cloudObject, cloudText, cloudAccount, cloudHash, createCloudBundle, validateCloudBundle, emailRecordId, emailScope } from '../../../../local-runtime/src/cloud-onboarding.mjs';

export const EMAIL_TOOL_CONTRACT = Object.freeze({ version: '20260915_00', search: 'GMAIL_FETCH_EMAILS', read: 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
  searchFields: ['query','user_id','verbose','ids_only','label_ids','max_results','include_payload','include_spam_trash'], readFields: ['format','user_id','message_id'] });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail = (code = 'INVALID_INPUT') => { throw new LearnBridgeError(code); };
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
const nullable = value => { if (value === undefined || value === null) return null; cloudText(value, 1000, true); if (/[\r\n]/.test(value)) fail('PROVIDER_FAILURE'); return value; };
const active = signal => { if (signal?.aborted) fail('CANCELLED'); };
function row(raw, scope) {
  const id = emailRecordId(raw.messageId), thread_id = emailRecordId(raw.threadId);
  if (!Array.isArray(raw.labelIds) || raw.labelIds.length > 100 || raw.labelIds.some(label => typeof label !== 'string' || label.length > 200) || !raw.labelIds.includes(scope.folder)) fail('VERSION_MISMATCH');
  const title = raw.subject === undefined || raw.subject === '' ? '(No subject)' : cloudText(raw.subject, 500);
  return { id, title, thread_id, from: nullable(raw.sender), to: nullable(raw.to), provider_timestamp: nullable(raw.messageTimestamp) };
}
function extraContentBytes(raw) {
  return ['messageText','payload','preview','attachmentList'].reduce((count,key) => raw[key] == null || raw[key] === '' || (Array.isArray(raw[key]) && !raw[key].length) ? count : count + Buffer.byteLength(JSON.stringify(raw[key])), 0);
}
function plainText(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('UNSUPPORTED');
  let nodes = 0; const parts = [];
  function walk(part, depth) {
    if (++nodes > 100 || depth > 8 || !part || typeof part !== 'object' || Array.isArray(part)) fail('BUDGET_EXCEEDED');
    if (part.filename || part.body?.attachmentId || part.mimeType === 'message/rfc822') return;
    if (part.mimeType === 'text/plain') {
      const header = Array.isArray(part.headers) ? part.headers.find(value => typeof value?.name === 'string' && value.name.toLowerCase() === 'content-type') : null;
      const charset = typeof header?.value === 'string' ? /charset\s*=\s*"?([^;\s"]+)/i.exec(header.value)?.[1].toLowerCase() : null;
      if (charset && !['utf-8','utf8','us-ascii','ascii'].includes(charset)) fail('UNSUPPORTED');
      const encoded = part.body?.data;
      if (encoded === undefined && part.body?.size === 0) { parts.push(''); return; }
      if (typeof encoded !== 'string' || encoded.length > 28000 || !/^[A-Za-z0-9_-]*={0,2}$/.test(encoded)) fail('PROVIDER_FAILURE');
      const unpadded = encoded.replace(/=+$/, ''), bytes = Buffer.from(unpadded, 'base64url');
      if (bytes.toString('base64url') !== unpadded) fail('PROVIDER_FAILURE');
      let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('UNSUPPORTED'); }
      if (charset && ['us-ascii','ascii'].includes(charset) && [...bytes].some(value => value > 127)) fail('UNSUPPORTED');
      parts.push(cloudText(text, 20000, true)); return;
    }
    if (typeof part.mimeType === 'string' && part.mimeType.startsWith('multipart/')) {
      if (!Array.isArray(part.parts) || part.parts.length > 100) fail('PROVIDER_FAILURE');
      for (const child of part.parts) walk(child, depth + 1);
    }
  }
  walk(payload, 0); if (!parts.length) fail('UNSUPPORTED');
  return cloudText(parts.join('\n\n'), 20000, true);
}
function dateHeader(payload) {
  if (!Array.isArray(payload?.headers)) return null;
  const dates = payload.headers.filter(item => typeof item?.name === 'string' && item.name.toLowerCase() === 'date');
  if (dates.length > 1) fail('PROVIDER_FAILURE'); return dates.length ? nullable(dates[0].value) : null;
}

/** Dedicated read-only acquisition. Browser fields cannot name an RPC/tool,
 * owner, user_id, thread operation, attachment, page cursor or model destination. */
export function createHostedEmailOnboarding({ transport, secret, origin, userId, clock = () => Date.now() }) {
  if (!UUID.test(userId) || typeof secret !== 'string' || secret.length < 16) fail('AUTH_REQUIRED');
  const key = createHmac('sha256', secret).update('LearnBridge.selected-email-review.v1').digest();
  function seal(kind, data) {
    const payload = Buffer.from(JSON.stringify({ kind, owner: userId, expires: clock() + 300000, nonce: randomUUID(), data })).toString('base64url');
    return `${payload}.${createHmac('sha256', key).update(payload).digest('hex')}`;
  }
  function open(kind, token) {
    if (typeof token !== 'string' || token.length > 180000 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(token)) fail('CONSENT_REQUIRED');
    const [payload, signature] = token.split('.');
    if (!timingSafeEqual(createHmac('sha256', key).update(payload).digest(), Buffer.from(signature, 'hex'))) fail('CONSENT_REQUIRED');
    let value; try { const bytes = Buffer.from(payload, 'base64url'); if (bytes.toString('base64url') !== payload) fail('CONSENT_REQUIRED'); value = cloudCopy(JSON.parse(bytes.toString('utf8')), 130000); } catch { fail('CONSENT_REQUIRED'); }
    cloudObject(value, ['kind','owner','expires','nonce','data']);
    if (value.kind !== kind || value.owner !== userId || !UUID.test(value.nonce) || !Number.isSafeInteger(value.expires) || value.expires <= clock() || value.expires > clock() + 300000) fail('CONSENT_REQUIRED');
    return value.data;
  }
  async function accounts(signal) {
    active(signal); const result = await transport.listAccounts(userId, signal); active(signal);
    if (!result || !Array.isArray(result.items) || result.items.length > 100) fail('PROVIDER_FAILURE');
    return { items: result.items.filter(item => item.owner_id === userId && item.shared === false && item.status === 'ACTIVE' && item.configured === true && item.provider === 'gmail').map(item => ({ id: cloudAccount(item.id), provider: 'gmail', label: `Gmail account ${item.id.slice(-8)}`, status: 'ACTIVE' })),
      coverage: result.partial ? 'partial' : 'account_metadata_only', limitations: ['Only configured, active Gmail accounts owned by this signed-in student are eligible.', 'No message search or model-sharing permission occurs during account listing.'] };
  }
  async function authorized(account_id, signal) {
    cloudAccount(account_id); if (!(await accounts(signal)).items.some(item => item.id === account_id)) fail('CONSENT_REQUIRED'); active(signal);
  }
  async function probe(account_id, signal) {
    await authorized(account_id, signal); const schemas = await transport.schemas(signal); active(signal);
    if (!Array.isArray(schemas) || schemas.length !== 2) fail('VERSION_MISMATCH');
    for (const [slug, fields] of [[EMAIL_TOOL_CONTRACT.search, EMAIL_TOOL_CONTRACT.searchFields], [EMAIL_TOOL_CONTRACT.read, EMAIL_TOOL_CONTRACT.readFields]]) {
      const schema = schemas.find(item => item.slug === slug); if (!schema || schema.version !== EMAIL_TOOL_CONTRACT.version || !Array.isArray(schema.input_fields) || !fields.every(field => schema.input_fields.includes(field))) fail('VERSION_MISMATCH');
    }
    await authorized(account_id, signal); return { provider: 'gmail', schema_state: 'compatible', tool_version: EMAIL_TOOL_CONTRACT.version, personal_content_read: false };
  }
  return {
    accounts,
    async probe(raw, signal) { const input = cloudCopy(raw, 4096); cloudObject(input, ['account_id']); return probe(input.account_id, signal); },
    async search(raw, signal) {
      const input = cloudCopy(raw, 4096); cloudObject(input, ['account_id','scope']); emailScope(input.scope); await probe(input.account_id, signal);
      const start = Math.floor(Date.parse(input.scope.start_date) / 1000), end = Math.floor(Date.parse(input.scope.end_date) / 1000) + 86400;
      const args = { user_id: 'me', query: `after:${start} before:${end} subject:"${input.scope.subject_phrase}"`, label_ids: [input.scope.folder], max_results: 20, verbose: false, ids_only: false, include_payload: false, include_spam_trash: false };
      const result = cloudCopy(await transport.execute(userId, input.account_id, EMAIL_TOOL_CONTRACT.search, args, signal), 200000); active(signal); await authorized(input.account_id, signal);
      if (!Array.isArray(result.messages) || result.messages.length > 20 || (result.nextPageToken !== undefined && result.nextPageToken !== null && (typeof result.nextPageToken !== 'string' || result.nextPageToken.length > 2000))) fail('PROVIDER_FAILURE');
      const seen = new Set(); let unexpected_content_bytes = 0;
      const items = result.messages.map(raw => { const selected = row(raw, input.scope); if (seen.has(selected.id)) fail('PROVIDER_FAILURE'); seen.add(selected.id); unexpected_content_bytes += extraContentBytes(raw);
        return { ...selected, selection_token: seal('message', { account_id: input.account_id, scope: input.scope, record: selected }) }; });
      return { items, scope: input.scope, coverage: 'partial', retrieved_at: new Date(clock()).toISOString(), unexpected_content_bytes,
        limitations: ['Only the first 20 matching metadata records are returned; no complete mailbox or date-window coverage is claimed.', 'The search asks for metadata only. Unexpected body/preview/attachment fields received by the server are discarded; their serialized byte count is shown.', 'UTC query boundaries are supplied as epoch seconds; before the end boundary is exclusive. Provider timestamps do not prove source modification, sent or received time.', 'Selecting results is required before any exact full-message read.'] };
    },
    async preview(raw, signal) {
      const input = cloudCopy(raw, 20000); cloudObject(input, ['account_id','selection_tokens','academic_policy']);
      if (!['unrestricted','learning_support','graded_restricted'].includes(input.academic_policy) || !Array.isArray(input.selection_tokens) || !input.selection_tokens.length || input.selection_tokens.length > 3) fail();
      const choices = input.selection_tokens.map(token => open('message', token));
      if (new Set(choices.map(item => item.record.id)).size !== choices.length || choices.some(item => item.account_id !== input.account_id || cloudHash(item.scope) !== cloudHash(choices[0].scope))) fail('CONSENT_REQUIRED');
      await probe(input.account_id, signal); const records = [];
      for (const selected of choices) {
        active(signal); await authorized(input.account_id, signal);
        const result = cloudCopy(await transport.execute(userId, input.account_id, EMAIL_TOOL_CONTRACT.read, { user_id: 'me', message_id: selected.record.id, format: 'full' }, signal), 100000); active(signal); await authorized(input.account_id, signal);
        if (cloudHash(row(result, selected.scope)) !== cloudHash(selected.record)) fail('VERSION_MISMATCH');
        const text = plainText(result.payload), date_header = dateHeader(result.payload), sent_at = date_header && Number.isFinite(Date.parse(date_header)) ? new Date(date_header).toISOString() : null;
        records.push({ id: selected.record.id, title: selected.record.title, url: null, modified_at: null, text, sha256: sha(text), coverage: 'partial_text',
          source_metadata: { kind: 'email', message_id: selected.record.id, thread_id: selected.record.thread_id, from: selected.record.from, to: selected.record.to, sent_at, received_at: null, date_header, provider_timestamp: selected.record.provider_timestamp, timestamp_semantics: 'provider_reported_unverified', selected_scope: selected.scope },
          limitations: ['Only inline UTF-8/ASCII text/plain MIME parts are decoded and joined in returned order.', 'HTML, styling, attachments, embedded emails, other thread messages and linked pages are not exported or fetched separately.', 'The selected full MIME response may contain extra fields/inline bytes; only selected plaintext and declared provenance are exported.', 'Source modification/revision and live freshness are unverified; the provider timestamp has unspecified semantics. Date-header time is sender reported, not proof of delivery.', 'Sender/recipient fields are private source assertions, not verified profile facts.'] });
      }
      const bundle = createCloudBundle({ format: 'learnbridge-selected-cloud-export', schema_version: 2, origin, owner: { student_id: userId, verification: 'supabase_session_at_fetch' }, provider: 'gmail', account_id: input.account_id, academic_policy: input.academic_policy, retrieved_at: new Date(clock()).toISOString(), records,
        limitations: ['Only explicitly selected message text and private provenance are exported.', 'Hosted account ownership was checked during fetch; this portable file does not authenticate the local student.', 'No model call, email write, attachment tool, task, profile inference or sharing grant occurred.', 'Local import, ownership confirmation and model sharing remain separate reviews.'] });
      return { bundle, review_hash: bundle.bundle_hash, preview_token: seal('email_bundle', bundle), expires_at: new Date(clock() + 300000).toISOString(), sharing: 'not_granted' };
    },
    async export(raw, signal) {
      const input = cloudCopy(raw, 180000); cloudObject(input, ['preview_token','review_hash','confirm']); if (input.confirm !== true) fail('CONSENT_REQUIRED');
      const bundle = validateCloudBundle(open('email_bundle', input.preview_token));
      if (bundle.provider !== 'gmail' || bundle.schema_version !== 2 || bundle.bundle_hash !== input.review_hash) fail('CONSENT_REQUIRED');
      await authorized(bundle.account_id, signal); active(signal);
      return { bundle, filename: 'LearnBridge-selected-gmail.json', sharing: 'not_granted', warning: 'This file contains private selected email text and sender/recipient metadata. Downloading, local import and model sharing are separate choices. Provider revocation does not erase existing copies.' };
    },
  };
}

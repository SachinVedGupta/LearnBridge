import { createHmac, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { LearnBridgeError } from '@learnbridge/core';
import { cloudCopy, cloudObject, cloudText, cloudAccount, cloudRecordId, cloudHash, createCloudBundle, validateCloudBundle, CLOUD_PROVIDERS, CLOUD_LIMITS } from '../../../../local-runtime/src/cloud-onboarding.mjs';

export const CLOUD_TOOL_CONTRACTS = Object.freeze({
  googledocs: { version: '20260826_00', search: 'GOOGLEDOCS_SEARCH_DOCUMENTS', read: 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT', searchFields: ['query', 'max_results', 'response_detail', 'include_trashed'], readFields: ['document_id', 'include_tabs_content', 'include_tables', 'include_headers', 'include_footers', 'include_footnotes'] },
  notion: { version: '20260915_00', search: 'NOTION_SEARCH_NOTION_PAGE', read: 'NOTION_GET_PAGE_MARKDOWN', searchFields: ['query', 'page_size', 'filter_value', 'filter_property'], readFields: ['page_id', 'include_transcript'] },
});
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail = (code = 'INVALID_INPUT') => { throw new LearnBridgeError(code); };
const sha = text => createHash('sha256').update(text).digest('hex');
const stamp = value => { if (value === undefined || value === null) return null; if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail('PROVIDER_FAILURE'); return new Date(value).toISOString(); };
function provider(value) { if (!CLOUD_PROVIDERS.includes(value)) fail(); return value; }
function metadata(app, raw) {
  let id, title, modified_at;
  if (app === 'googledocs') { id = raw.id; title = raw.name; modified_at = stamp(raw.modified_time ?? raw.modifiedTime); }
  else {
    if (raw.object !== 'page' || raw.archived || raw.in_trash) return null;
    id = typeof raw.id === 'string' ? raw.id.toLowerCase().replace(/^([a-f0-9]{8})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{12})$/, '$1-$2-$3-$4-$5') : raw.id;
    const titleFields = Object.values(raw.properties || {}).filter(value => value?.type === 'title');
    title = titleFields.flatMap(value => Array.isArray(value.title) ? value.title : []).map(part => part.plain_text ?? part.text?.content ?? '').join('') || 'Untitled Notion page';
    modified_at = stamp(raw.last_edited_time);
  }
  try { cloudRecordId(app, id); cloudText(title, 500); } catch { fail('PROVIDER_FAILURE'); }
  return { id, title, modified_at, url: app === 'googledocs' ? `https://docs.google.com/document/d/${id}/edit` : `https://www.notion.so/${id.replaceAll('-', '')}` };
}

/** No model involvement. The adapter is trusted; every browser choice is checked data. */
export function createHostedCloudOnboarding({ transport, secret, origin, userId, clock = () => Date.now() }) {
  if (!UUID.test(userId) || typeof secret !== 'string' || secret.length < 16) fail('AUTH_REQUIRED');
  const signingKey = createHmac('sha256', secret).update('LearnBridge.selected-cloud-review.v1').digest();
  function seal(kind, data) {
    const payload = Buffer.from(JSON.stringify({ kind, owner: userId, expires: clock() + 300000, nonce: randomUUID(), data })).toString('base64url');
    return `${payload}.${createHmac('sha256', signingKey).update(payload).digest('hex')}`;
  }
  function open(kind, token) {
    if (typeof token !== 'string' || token.length > 180000 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(token)) fail('CONSENT_REQUIRED');
    const [payload, signature] = token.split('.'), expected = createHmac('sha256', signingKey).update(payload).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) fail('CONSENT_REQUIRED');
    let envelope; try { const bytes = Buffer.from(payload, 'base64url'); if (bytes.toString('base64url') !== payload) fail('CONSENT_REQUIRED'); envelope = cloudCopy(JSON.parse(bytes.toString('utf8')), 130000); } catch { fail('CONSENT_REQUIRED'); }
    if (envelope.kind !== kind || envelope.owner !== userId || !Number.isSafeInteger(envelope.expires) || envelope.expires <= clock() || envelope.expires > clock() + 300000 || !UUID.test(envelope.nonce)) fail('CONSENT_REQUIRED');
    return envelope.data;
  }
  function active(signal) { if (signal?.aborted) fail('CANCELLED'); }
  async function accounts(signal) {
    active(signal); const result = await transport.listAccounts(userId, signal); active(signal);
    if (!result || !Array.isArray(result.items) || result.items.length > 100) fail('PROVIDER_FAILURE');
    const items = result.items.filter(account => account.owner_id === userId && account.shared === false && account.status === 'ACTIVE' && account.configured === true && CLOUD_PROVIDERS.includes(account.provider))
      .map(account => ({ id: cloudAccount(account.id), provider: account.provider, label: `${account.provider === 'googledocs' ? 'Google Docs' : 'Notion'} account ${account.id.slice(-8)}`, status: 'ACTIVE' }));
    return { items, coverage: result.partial ? 'partial' : 'account_metadata_only', limitations: ['Only configured, active accounts owned by this signed-in student are eligible.', 'Account listing is not a content scan or a model-sharing grant.'] };
  }
  async function authorized(choice, signal) {
    provider(choice.provider); cloudAccount(choice.account_id); const available = await accounts(signal);
    if (!available.items.some(account => account.id === choice.account_id && account.provider === choice.provider)) fail('CONSENT_REQUIRED'); return choice;
  }
  async function probe(choice, signal) {
    await authorized(choice, signal); const contract = CLOUD_TOOL_CONTRACTS[choice.provider], schemas = await transport.schemas(choice.provider, signal); active(signal);
    for (const [slug, fields] of [[contract.search, contract.searchFields], [contract.read, contract.readFields]]) {
      const schema = schemas.find(item => item.slug === slug); if (!schema || schema.version !== contract.version || !fields.every(field => schema.input_fields.includes(field))) fail('VERSION_MISMATCH');
    }
    await authorized(choice, signal); return { provider: choice.provider, schema_state: 'compatible', tool_version: contract.version, personal_content_read: false };
  }
  return {
    accounts,
    async probe(raw, signal) { const input = cloudCopy(raw, 4096); cloudObject(input, ['provider', 'account_id']); return probe(input, signal); },
    async search(raw, signal) {
      const input = cloudCopy(raw, 4096); cloudObject(input, ['provider', 'account_id', 'query']); cloudText(input.query, 200); await probe(input, signal);
      const contract = CLOUD_TOOL_CONTRACTS[input.provider], args = input.provider === 'googledocs' ? { query: `fullText contains '${input.query.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`, max_results: 20, response_detail: 'minimal', include_trashed: false }
        : { query: input.query, page_size: 20, filter_property: 'object', filter_value: 'page' };
      const result = cloudCopy(await transport.execute(userId, input, contract.search, args, signal), 200000); active(signal); await authorized(input, signal);
      const rows = input.provider === 'googledocs' ? result.files : result.results; if (!Array.isArray(rows) || rows.length > CLOUD_LIMITS.searchResults) fail('PROVIDER_FAILURE');
      const ids = new Set(), items = rows.map(row => metadata(input.provider, row)).filter(Boolean).map(item => { if (ids.has(item.id)) fail('PROVIDER_FAILURE'); ids.add(item.id); return { ...item, selection_token: seal('selected_record', { provider: input.provider, account_id: input.account_id, query: input.query, record: item }) }; });
      return { items, coverage: 'partial', retrieved_at: new Date(clock()).toISOString(), limitations: ['Only the first 20 matching metadata records are shown; this is not a complete account inventory.', 'Search indexing and source permissions can omit items. Select records before reading their text.'] };
    },
    async preview(raw, signal) {
      const input = cloudCopy(raw, 20000); cloudObject(input, ['provider', 'account_id', 'selection_tokens', 'academic_policy']);
      if (!['unrestricted', 'learning_support', 'graded_restricted'].includes(input.academic_policy) || !Array.isArray(input.selection_tokens) || !input.selection_tokens.length || input.selection_tokens.length > CLOUD_LIMITS.records) fail();
      const selections = input.selection_tokens.map(token => open('selected_record', token)); if (new Set(selections.map(item => item.record.id)).size !== selections.length || selections.some(item => item.provider !== input.provider || item.account_id !== input.account_id)) fail('CONSENT_REQUIRED');
      await probe(input, signal); const contract = CLOUD_TOOL_CONTRACTS[input.provider], records = [];
      for (const selected of selections) {
        await authorized(input, signal); const args = input.provider === 'googledocs' ? { document_id: selected.record.id, include_tabs_content: true, include_tables: true, include_headers: true, include_footers: true, include_footnotes: true } : { page_id: selected.record.id, include_transcript: false };
        const result = cloudCopy(await transport.execute(userId, input, contract.read, args, signal), 100000); active(signal); await authorized(input, signal);
        const returnedId = input.provider === 'googledocs' ? result.document_id : result.id?.toLowerCase().replace(/^([a-f0-9]{8})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{12})$/, '$1-$2-$3-$4-$5');
        if (returnedId !== selected.record.id) fail('PROVIDER_FAILURE');
        const text = input.provider === 'googledocs' ? result.plain_text : result.markdown; cloudText(text, CLOUD_LIMITS.textBytes, true);
        const title = input.provider === 'googledocs' ? cloudText(result.title, 500) : selected.record.title;
        const limitations = ['Partial text snapshot; original visuals, layout and factual claims require review.', 'Selected metadata modification time is source-reported; no stable upstream revision is proved.'];
        if (input.provider === 'googledocs') { if (result.warnings !== undefined && (!Array.isArray(result.warnings) || result.warnings.length > 20)) fail('PROVIDER_FAILURE'); for (const reason of (result.warnings || []).slice(0, 4)) limitations.push(cloudText(reason, 500)); }
        else { if (result.object !== 'page_markdown' || typeof result.truncated !== 'boolean' || !Array.isArray(result.unknown_block_ids) || result.unknown_block_ids.length > 200) fail('PROVIDER_FAILURE'); if (result.truncated) limitations.push('Provider reports truncated page content.'); if (result.unknown_block_ids.length) limitations.push('Provider reports blocks that could not be rendered.'); limitations.push('Transcripts, linked subpages and referenced files are not fetched.'); }
        records.push({ ...selected.record, title, text, sha256: sha(text), coverage: 'partial_text', limitations });
      }
      const bundle = createCloudBundle({ format: 'learnbridge-selected-cloud-export', schema_version: 1, origin, owner: { student_id: userId, verification: 'supabase_session_at_fetch' }, provider: input.provider, account_id: input.account_id, academic_policy: input.academic_policy,
        retrieved_at: new Date(clock()).toISOString(), records, limitations: ['Only explicitly selected returned text is exported.', 'Account ownership was checked against the signed-in hosted student at fetch; transfer files do not authenticate the local student.', 'No model call, cloud document write or sharing grant occurred.'] });
      return { bundle, review_hash: bundle.bundle_hash, preview_token: seal('reviewed_bundle', bundle), expires_at: new Date(clock() + 300000).toISOString(), sharing: 'not_granted' };
    },
    async export(raw, signal) {
      const input = cloudCopy(raw, 180000); cloudObject(input, ['preview_token', 'review_hash', 'confirm']); if (input.confirm !== true) fail('CONSENT_REQUIRED');
      const bundle = validateCloudBundle(open('reviewed_bundle', input.preview_token)); if (bundle.bundle_hash !== input.review_hash) fail('CONSENT_REQUIRED');
      await authorized({ provider: bundle.provider, account_id: bundle.account_id }, signal); active(signal);
      return { bundle, filename: `LearnBridge-selected-${bundle.provider}.json`, sharing: 'not_granted', warning: 'This downloaded bundle contains private selected text. Import and sharing are separate reviews; provider revocation cannot remove downloaded copies.' };
    },
  };
}

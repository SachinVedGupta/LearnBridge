import { createHash } from 'node:crypto';
import { LearnBridgeError } from '@learnbridge/core';

export const PUBLIC_JOB_VERSION = 'learnbridge_public_jobs.v1';
export const PUBLIC_JOB_LIMITS = Object.freeze({ responseBytes: 600000, bodyBytes: 80000, snapshotBytes: 100000, metadataBytes: 110000, recordBytes: 120000, pages: 3, pageSize: 50, metadataItems: 500, savedBoards: 20, savedRoles: 200, timeoutMs: 10000, freshnessMs: 86400000 });
const fail = code => { throw new LearnBridgeError(code); };
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
function object(value, allowed, required = allowed) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail('INVALID_INPUT');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !allowed.includes(key) || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value')) || required.some(key => !Object.hasOwn(descriptors, key))) fail('INVALID_INPUT');
}
function text(value, max = 500, empty = false) { if (typeof value !== 'string' || (!empty && !value.trim()) || !value.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || Buffer.byteLength(value) > max) fail('VERSION_MISMATCH'); return value; }
function selection(raw, read = false) {
  object(raw, read ? ['provider', 'board_slug', 'job_id'] : ['provider', 'board_slug']);
  if (!['greenhouse', 'lever'].includes(raw.provider) || typeof raw.board_slug !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(raw.board_slug)) fail('INVALID_INPUT');
  if (read && (typeof raw.job_id !== 'string' || !(raw.provider === 'greenhouse' ? /^[1-9]\d{0,11}$/ : /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/).test(raw.job_id))) fail('INVALID_INPUT');
  return { ...raw };
}
const identity = choice => sha(canonical([choice.provider, choice.board_slug, choice.job_id || null]));
const providerPage = item => item.provider === 'greenhouse' ? `https://job-boards.greenhouse.io/${item.board_slug}/jobs/${item.job_id}` : `https://jobs.lever.co/${item.board_slug}/${item.job_id}`;
function requestURL(choice, page = null) {
  if (choice.provider === 'greenhouse') return `https://boards-api.greenhouse.io/v1/boards/${choice.board_slug}/jobs${choice.job_id ? `/${choice.job_id}` : ''}`;
  return `https://api.lever.co/v0/postings/${choice.board_slug}${choice.job_id ? `/${choice.job_id}` : `?mode=json&skip=${page * PUBLIC_JOB_LIMITS.pageSize}&limit=${PUBLIC_JOB_LIMITS.pageSize}`}`;
}
function metadata(raw, choice) {
  if (!raw || Object.getPrototypeOf(raw) !== Object.prototype) fail('VERSION_MISMATCH');
  const job_id = choice.provider === 'greenhouse' ? String(raw.id) : raw.id;
  selection({ ...choice, job_id }, true);
  const title = text(raw.title ?? raw.text, 500), locations = choice.provider === 'greenhouse' ? [text(raw.location?.name ?? 'Not specified', 500)] : [text(raw.categories?.location ?? 'Not specified', 500)];
  const updated_at = typeof raw.updated_at === 'string' && Number.isFinite(Date.parse(raw.updated_at)) ? new Date(raw.updated_at).toISOString() : null;
  const item = { provider: choice.provider, board_slug: choice.board_slug, job_id, title, locations, updated_at };
  return { ...item, source_identity: identity(item), metadata_sha256: sha(canonical(item)), posting_url: providerPage(item) };
}
function htmlText(raw) {
  const decode = value => value.replace(/&(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[a-fA-F0-9]{1,6});/g, entity => {
    const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
    if (named[entity]) return named[entity]; const point = entity[2]?.toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
    return point >= 32 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : entity;
  });
  return decode(decode(raw)).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<\s*(?:br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
function snapshot(raw, choice) {
  const item = metadata(raw, choice); if (item.job_id !== choice.job_id) fail('VERSION_MISMATCH');
  let selected_content, display_text;
  if (choice.provider === 'greenhouse') { const content = text(raw.content, PUBLIC_JOB_LIMITS.bodyBytes); selected_content = { content }; display_text = htmlText(content); }
  else {
    const descriptionPlain = text(raw.descriptionPlain, PUBLIC_JOB_LIMITS.bodyBytes, true), additionalPlain = text(raw.additionalPlain ?? '', PUBLIC_JOB_LIMITS.bodyBytes, true);
    if (!Array.isArray(raw.lists ?? []) || (raw.lists ?? []).length > 30) fail('VERSION_MISMATCH');
    const lists = (raw.lists ?? []).map(list => ({ text: text(list.text, 500), content: text(list.content, PUBLIC_JOB_LIMITS.bodyBytes, true) }));
    selected_content = { descriptionPlain, lists, additionalPlain }; display_text = [descriptionPlain, ...lists.flatMap(list => [list.text, htmlText(list.content)]), additionalPlain].filter(Boolean).join('\n\n');
  }
  if (!display_text.trim() || Buffer.byteLength(canonical(selected_content)) > PUBLIC_JOB_LIMITS.bodyBytes || Buffer.byteLength(display_text) > PUBLIC_JOB_LIMITS.bodyBytes) fail('BUDGET_EXCEEDED');
  const deadline_at = typeof raw.application_deadline === 'string' && Number.isFinite(Date.parse(raw.application_deadline)) ? new Date(raw.application_deadline).toISOString() : null;
  const source = { ...item, selected_content, deadline_at };
  const result = { ...source, display_text, source_sha256: sha(canonical(source)), display_text_sha256: sha(display_text), coverage: 'selected_public_posting_fields', extraction: choice.provider === 'greenhouse' ? 'bounded_html_text_projection_original_retained' : 'provider_plaintext_plus_bounded_list_projection' };
  if (Buffer.byteLength(JSON.stringify(result)) > PUBLIC_JOB_LIMITS.snapshotBytes) fail('BUDGET_EXCEEDED'); return result;
}

/** Explicit student-selected public reads. No credentials, browser, model, submission or arbitrary URLs. */
export function createPublicJobService({ store, fetchImpl = globalThis.fetch, clock = () => Date.now() }) {
  const records = category => store.listWorkspaceRecords({ kind: 'career_item' }).filter(record => record.data.category === category && record.data.format === PUBLIC_JOB_VERSION);
  const find = (category, key) => records(category).find(record => record.data.source_identity === key);
  let closed = false, running = false; const controllers = new Set();
  const authorize = options => { if (closed) fail('CANCELLED'); if (options?.authorize && options.authorize() !== true) fail('CONSENT_REQUIRED'); };
  const at = () => { const now = clock(); if (!Number.isSafeInteger(now)) fail('INVALID_INPUT'); return new Date(now).toISOString(); };
  function save(category, key, title, data, previous) {
    const current = find(category, key); if ((current?.revision || null) !== (previous?.revision || null)) fail('REVISION_CONFLICT');
    const value = { format: PUBLIC_JOB_VERSION, category, source_identity: key, ...data };
    if (Buffer.byteLength(JSON.stringify(value)) > PUBLIC_JOB_LIMITS.recordBytes) fail('BUDGET_EXCEEDED');
    if (current) return store.updateWorkspaceRecord(current.id, { expected_revision: current.revision, title: title.slice(0, 480), data: value });
    const limit = category === 'public_board' ? PUBLIC_JOB_LIMITS.savedBoards : PUBLIC_JOB_LIMITS.savedRoles;
    if (records(category).length >= limit) fail('BUDGET_EXCEEDED');
    return store.createWorkspaceRecord({ kind: 'career_item', title: title.slice(0, 480), data: value }, { idempotencyKey: `public-job-${key}` });
  }
  async function acquire(choice, page, options) {
    authorize(options); const url = requestURL(choice, page), controller = new AbortController(); controllers.add(controller); let response, timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, PUBLIC_JOB_LIMITS.timeoutMs); timeout.unref?.();
    try {
      response = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal }); authorize(options);
      if (response.redirected || (response.url && response.url !== url)) fail('SCOPE_DENIED');
      if (response.status === 404) { await response.body?.cancel(); return { missing: true, url, status: 404 }; }
      if (response.status === 429) fail('RATE_LIMITED'); if (!response.ok || !/^application\/json\b/i.test(response.headers.get('content-type') || '')) fail('PROVIDER_FAILURE');
      if (Number(response.headers.get('content-length') || 0) > PUBLIC_JOB_LIMITS.responseBytes) fail('BUDGET_EXCEEDED');
      if (!response.body) fail('VERSION_MISMATCH'); const reader = response.body.getReader(), chunks = []; let size = 0;
      try { while (true) { const result = await reader.read(); authorize(options); if (result.done) break; size += result.value.byteLength; if (size > PUBLIC_JOB_LIMITS.responseBytes) { await reader.cancel(); fail('BUDGET_EXCEEDED'); } chunks.push(Buffer.from(result.value)); } } finally { reader.releaseLock(); }
      const bytes = Buffer.concat(chunks); let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('VERSION_MISMATCH'); }
      return { missing: false, value, url, response_sha256: sha(bytes), response_bytes: size, status: response.status };
    } catch (error) { try { await response?.body?.cancel(); } catch { /* A released reader or aborted response may already be closed. */ } if (error instanceof LearnBridgeError) throw error; fail(timedOut ? 'PROVIDER_FAILURE' : controller.signal.aborted ? 'CANCELLED' : 'PROVIDER_FAILURE'); }
    finally { clearTimeout(timeout); controllers.delete(controller); }
  }
  function roleView(record) {
    const data = record.data, body = data.snapshot, now = clock(), failed = data.last_check.status === 'failed';
    const board = find('public_board', identity({ provider: data.selection.provider, board_slug: data.selection.board_slug }));
    const observed = board?.data.items?.find(item => item.job_id === data.selection.job_id);
    const changedMetadata = observed && body && observed.metadata_sha256 !== body.metadata_sha256 && (observed.metadata_observed_at || board.data.observed_at) >= data.source_observed_at;
    const absentFromCompleteCheck = body && board?.data.last_check.status === 'complete' && board.data.observed_at > data.source_observed_at && !observed;
    const stale = failed || !body || now - Date.parse(data.last_check.checked_at) >= PUBLIC_JOB_LIMITS.freshnessMs || Boolean(changedMetadata || absentFromCompleteCheck);
    const unavailable = data.last_check.status === 'unavailable_at_source', deadline_passed = Boolean(body?.deadline_at && Date.parse(body.deadline_at) <= now);
    return { ...record, availability: unavailable ? 'unavailable_at_source' : stale ? 'stale' : 'open', verified_opening: !unavailable && !stale && !deadline_passed,
      deadline_passed, verification_notice: unavailable ? 'The selected official board returned 404 for this ID. This is not a global closure claim.' : stale ? 'This saved posting needs a fresh selected-source check.' : deadline_passed ? 'The posting is published, but its reported application deadline has passed.' : 'Observed in a current selected official public API response; eligibility is not established.' };
  }
  async function operation(callback) { if (running) fail('RATE_LIMITED'); running = true; try { return await callback(); } finally { running = false; } }
  return {
    state() { return { boards: records('public_board'), roles: records('public_role').map(record => { const view = roleView(record), saved = view.data.snapshot; return { ...view, data: { ...view.data, snapshot: saved ? Object.fromEntries(Object.entries(saved).filter(([key]) => !['selected_content', 'display_text'].includes(key))) : null } }; }), capabilities: { providers: ['greenhouse', 'lever'], discovery: 'explicit_public_board_metadata', body_reads: 'explicit_selected_ids_only', external_writes: false, credentials: false, max_saved_roles: PUBLIC_JOB_LIMITS.savedRoles, freshness_hours: 24 } }; },
    get(recordId) { const record = store.getWorkspaceRecord(recordId); if (!record || record.kind !== 'career_item' || record.data.format !== PUBLIC_JOB_VERSION || record.data.category !== 'public_role') fail('SCOPE_DENIED'); return { role: roleView(record) }; },
    async search(raw, options = {}) {
      const choice = selection(raw); return operation(async () => {
        authorize(options); const key = identity(choice), previous = find('public_board', key), items = [], requests = []; let status = 'complete', error_code = null, missing = false;
        for (let page = 0; page < (choice.provider === 'lever' ? PUBLIC_JOB_LIMITS.pages : 1); page++) {
          try {
            const response = await acquire(choice, page, options); if (response.missing) { missing = true; status = 'unavailable_at_source'; break; }
            const values = choice.provider === 'greenhouse' ? response.value?.jobs : response.value;
            if (!Array.isArray(values) || values.length > (choice.provider === 'greenhouse' ? PUBLIC_JOB_LIMITS.metadataItems : PUBLIC_JOB_LIMITS.pageSize)) fail('BUDGET_EXCEEDED');
            const selected = values.map(value => ({ ...metadata(value, choice), metadata_response_sha256: response.response_sha256 })), seen = new Set(items.map(item => item.job_id));
            for (const item of selected) { if (seen.has(item.job_id)) continue; seen.add(item.job_id); items.push(item); }
            requests.push({ source_api_url: response.url, response_sha256: response.response_sha256, response_bytes: response.response_bytes, status: response.status });
            if (choice.provider === 'greenhouse' || values.length < PUBLIC_JOB_LIMITS.pageSize) break;
            if (page === PUBLIC_JOB_LIMITS.pages - 1) status = 'partial';
          } catch (error) { authorize(options); if (error.code === 'CONSENT_REQUIRED' || error.code === 'CANCELLED') throw error; status = items.length ? 'partial_failed' : 'failed'; error_code = error instanceof LearnBridgeError ? error.code : 'PROVIDER_FAILURE'; break; }
        }
        authorize(options); const checked_at = at(); let retained = status === 'failed' || missing;
        const currentItems = items.map(item => ({ ...item, metadata_observed_at: checked_at })), incomplete = ['partial', 'partial_failed'].includes(status);
        const currentIds = new Set(currentItems.map(item => item.job_id));
        let savedItems = retained ? previous?.data.items || [] : incomplete ? [...currentItems, ...(previous?.data.items || []).filter(item => !currentIds.has(item.job_id))] : currentItems;
        if (savedItems.length > PUBLIC_JOB_LIMITS.metadataItems || Buffer.byteLength(JSON.stringify(savedItems)) > PUBLIC_JOB_LIMITS.metadataBytes) { status = 'failed'; error_code = 'BUDGET_EXCEEDED'; retained = true; savedItems = previous?.data.items || []; }
        const record = save('public_board', key, `${choice.provider}: ${choice.board_slug}`, { selection: choice,
          items: savedItems, observed_at: retained ? previous?.data.observed_at || null : checked_at,
          last_check: { status, checked_at, error_code }, requests, coverage: status, automatic_role_body_reads: false,
          limitations: ['Only this explicit board was checked. Missing metadata does not close saved roles.', ...(choice.provider === 'lever' ? ['Lever list responses include extra public fields; descriptions are discarded during metadata search.'] : [])] }, previous);
        return { board: record };
      });
    },
    async read(raw, options = {}) {
      const choice = selection(raw, true); return operation(async () => {
        authorize(options); const board = find('public_board', identity({ provider: choice.provider, board_slug: choice.board_slug })), key = identity(choice), previous = find('public_role', key);
        if (!previous && !board?.data.items.some(item => item.job_id === choice.job_id)) fail('SCOPE_DENIED');
        let current = null, request = null, status = 'observed', error_code = null;
        try { const result = await acquire(choice, null, options); request = { source_api_url: result.url, status: result.status,
          ...(result.missing ? {} : { response_sha256: result.response_sha256, response_bytes: result.response_bytes }) }; if (result.missing) status = 'unavailable_at_source'; else current = snapshot(result.value, choice); }
        catch (error) { authorize(options); if (error.code === 'CONSENT_REQUIRED' || error.code === 'CANCELLED') throw error; status = 'failed'; error_code = error instanceof LearnBridgeError ? error.code : 'PROVIDER_FAILURE'; }
        authorize(options); const checked_at = at();
        const record = save('public_role', key, current?.title || previous?.title || board.data.items.find(item => item.job_id === choice.job_id).title,
          { selection: choice, snapshot: current || previous?.data.snapshot || null, source_observed_at: current ? checked_at : previous?.data.source_observed_at || null,
            last_check: { status, checked_at, error_code }, request, source_request: current ? request : previous?.data.source_request || (previous?.data.last_check.status === 'observed' ? previous?.data.request : null), shortlist: previous?.data.shortlist || null,
            prior_source_hashes: current && previous?.data.snapshot && current.source_sha256 !== previous.data.snapshot.source_sha256
              ? [...(previous.data.prior_source_hashes || []), { source_sha256: previous.data.snapshot.source_sha256, observed_at: previous.data.source_observed_at }].slice(-20) : previous?.data.prior_source_hashes || [] }, previous);
        return { role: roleView(record) };
      });
    },
    shortlist(recordId, raw) {
      object(raw, ['expected_revision', 'state', 'note'], ['expected_revision', 'state']);
      if (typeof recordId !== 'string' || !/^[a-f0-9-]{36}$/.test(recordId) || !Number.isSafeInteger(raw.expected_revision) || raw.expected_revision < 1 || !['saved', 'investigating', 'preparing', 'dismissed'].includes(raw.state)) fail('INVALID_INPUT');
      const note = raw.note === undefined ? null : text(raw.note, 2000, true), record = store.getWorkspaceRecord(recordId);
      if (!record || record.kind !== 'career_item' || record.data.format !== PUBLIC_JOB_VERSION || record.data.category !== 'public_role') fail('SCOPE_DENIED');
      if (record.revision !== raw.expected_revision) fail('REVISION_CONFLICT');
      const updated = store.updateWorkspaceRecord(record.id, { expected_revision: record.revision, data: { ...record.data,
        shortlist: { state: raw.state, note, reviewed_at: at(), reviewer: store.identity.student_id, source_sha256: record.data.snapshot?.source_sha256 || null } } });
      return { role: roleView(updated) };
    },
    close() { closed = true; for (const controller of controllers) controller.abort(); controllers.clear(); },
  };
}

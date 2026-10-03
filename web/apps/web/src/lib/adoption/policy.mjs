export const ADOPTION_CONSENT_VERSION = 'public-setup-metrics-1';
export const ADOPTION_PROMPT_VERSION = 'local-setup-1-2026-10-03';
export const ADOPTION_EVENT_NAMES = Object.freeze(['setup_page_view', 'setup_prompt_copy_succeeded', 'setup_prompt_copy_failed']);
export const ADOPTION_FIELDS = Object.freeze(['event_id', 'event_name', 'prompt_version', 'route', 'schema_version']);
export const ADOPTION_RETENTION = Object.freeze({ raw_days: 30, aggregate_days: 366, deduplication_days: 30 });
export class AdoptionError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new AdoptionError(code, status); };
function object(value, keys) { if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) || !('value' in Object.getOwnPropertyDescriptor(value, key)) || !Object.getOwnPropertyDescriptor(value, key).enumerable) || keys.some(key => !Object.hasOwn(value, key))) fail('INVALID_EVENT'); }
export function parseAdoptionEvent(body) {
  if (typeof body !== 'string' || new TextEncoder().encode(body).byteLength > 2048) fail('EVENT_TOO_LARGE', 413);
  let input; try { input = JSON.parse(body); } catch { fail('INVALID_EVENT'); }
  object(input, ['consent', 'event']); object(input.consent, ['state', 'version']); object(input.event, ADOPTION_FIELDS);
  if (input.consent.state !== 'opted_in' || input.consent.version !== ADOPTION_CONSENT_VERSION) fail('CONSENT_REQUIRED', 403);
  const event = input.event;
  if (event.schema_version !== 1 || event.route !== '/setup' || event.prompt_version !== ADOPTION_PROMPT_VERSION || !ADOPTION_EVENT_NAMES.includes(event.event_name) || typeof event.event_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(event.event_id)) fail('INVALID_EVENT');
  return { consent: { state: 'opted_in', version: ADOPTION_CONSENT_VERSION }, event: { schema_version: 1, event_id: event.event_id, event_name: event.event_name, route: '/setup', prompt_version: ADOPTION_PROMPT_VERSION } };
}
export function parseEnrollment(body) {
  if (typeof body !== 'string' || new TextEncoder().encode(body).byteLength > 1024) fail('INVALID_ENROLLMENT');
  let input; try { input = JSON.parse(body); } catch { fail('INVALID_ENROLLMENT'); }
  object(input, ['expected_revision', 'expected_review_hash', 'enabled', 'directory_enabled', 'consent_version']);
  if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0 || typeof input.expected_review_hash !== 'string' || !/^[a-f0-9]{64}$/.test(input.expected_review_hash) || typeof input.enabled !== 'boolean' || typeof input.directory_enabled !== 'boolean' || (input.directory_enabled && !input.enabled) || input.consent_version !== ADOPTION_CONSENT_VERSION) fail('INVALID_ENROLLMENT');
  return { expected_revision: input.expected_revision, expected_review_hash: input.expected_review_hash, enabled: input.enabled, directory_enabled: input.directory_enabled, consent_version: ADOPTION_CONSENT_VERSION };
}
export function parseReportRange(start, end) {
  const day = value => { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail('INVALID_RANGE'); return value; };
  start = day(start); end = day(end); const duration = Date.parse(end) - Date.parse(start); if (duration < 0 || duration > 365 * 86400000) fail('INVALID_RANGE'); return { start, end };
}
/** Stronger coarse limit: all callers share a bounded per-process bucket. The
 * database separately enforces global quotas across server instances. No IP,
 * user agent, referrer, cookie or visitor identity is retained here. */
export function createPublicAdoptionLimiter({ clock = Date.now, maximum = 10 } = {}) {
  let minute = null, count = 0;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 10) fail('INVALID_LIMIT');
  return { accept() { const current = Math.floor(clock() / 60000); if (current !== minute) { minute = current; count = 0; } if (count >= maximum) return false; count++; return true; } };
}
export function createPublicAdoptionCollector({ enabled = false, origin, repository, limiter = createPublicAdoptionLimiter() }) {
  return { async collect({ origin: requestOrigin, contentType, path, body }) {
    if (enabled !== true) return { status: 503, data: { code: 'COLLECTION_DISABLED' } };
    if (path !== '/api/adoption/events' || requestOrigin !== origin) return { status: 403, data: { code: 'ORIGIN_DENIED' } };
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType || '')) return { status: 415, data: { code: 'CONTENT_TYPE_REQUIRED' } };
    let event; try { event = parseAdoptionEvent(body); } catch (error) { return { status: error.status ?? 400, data: { code: error.code ?? 'INVALID_EVENT' } }; }
    if (!limiter.accept()) return { status: 429, data: { code: 'RATE_LIMITED' } };
    try {
      const result = await repository.insertPublicEvent(event);
      if (result.status === 'accepted' || result.status === 'duplicate') return { status: 202, data: { status: result.status, event_id: event.event.event_id, retention: ADOPTION_RETENTION } };
      if (result.status === 'conflict') return { status: 409, data: { code: 'EVENT_CONFLICT' } };
      if (result.status === 'rate_limited' || result.status === 'quota_paused') return { status: 429, data: { code: result.status === 'rate_limited' ? 'RATE_LIMITED' : 'QUOTA_PAUSED' } };
      return { status: 503, data: { code: 'COLLECTOR_UNAVAILABLE' } };
    } catch { return { status: 503, data: { code: 'COLLECTOR_UNAVAILABLE' } }; }
  } };
}
export async function boundedAdoptionBody(request, maximum = 2048, timeoutMs = 2000) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 2048 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 2000) fail('INVALID_LIMIT');
  if (!request.body) return ''; const reader = request.body.getReader(); let size = 0, result = '', timer; const decoder = new TextDecoder('utf-8', { fatal: true });
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new AdoptionError('BODY_TIMEOUT', 408)), timeoutMs); });
  try { while (true) { const { done, value } = await Promise.race([reader.read(), timeout]); if (done) break; size += value.byteLength; if (size > maximum) fail('EVENT_TOO_LARGE', 413); result += decoder.decode(value, { stream: true }); } result += decoder.decode(); return result; }
  catch (error) { void reader.cancel().catch(() => {}); if (error instanceof AdoptionError) throw error; fail('INVALID_EVENT'); }
  finally { clearTimeout(timer); try { reader.releaseLock(); } catch {} }
}

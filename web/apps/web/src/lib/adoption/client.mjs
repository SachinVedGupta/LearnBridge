import { ADOPTION_CONSENT_VERSION, ADOPTION_PROMPT_VERSION, ADOPTION_EVENT_NAMES, ADOPTION_FIELDS } from './policy.mjs';

/** Page-session-only observations, disabled by default. Never call this observer
 * from setup/doctor/local runtime or before an actual clipboard success. */
export function createSetupAdoptionClient({ enabled = false, send = null, createId = () => globalThis.crypto.randomUUID() } = {}) {
  let optedIn = false, generation = 0, inflight = null, controller = null, accepted = 0, dropped = 0; const queue = [];
  function observe(eventName) {
    if (!enabled || !optedIn || !ADOPTION_EVENT_NAMES.includes(eventName)) return false;
    if (queue.length >= 20) { dropped++; return false; }
    let eventId; try { eventId = createId(); } catch { dropped++; return false; }
    const event = { schema_version: 1, event_id: eventId, event_name: eventName, route: '/setup', prompt_version: ADOPTION_PROMPT_VERSION };
    queue.push({ body: { consent: { state: 'opted_in', version: ADOPTION_CONSENT_VERSION }, event }, attempts: 0 }); void flush().catch(() => {}); return true;
  }
  async function flush() {
    if (!enabled || !optedIn || inflight) return inflight;
    const operationGeneration = generation;
    inflight = (async () => {
      while (queue.length && enabled && optedIn && generation === operationGeneration) {
        const entry = queue[0]; if (entry.attempts >= 3) { queue.shift(); dropped++; continue; } entry.attempts++;
        controller = new AbortController(); const timeout = setTimeout(() => controller?.abort(), 2000);
        try {
          const transport = send ?? globalThis.fetch; if (typeof transport !== 'function') return;
          const response = await transport('/api/adoption/events', { method: 'POST', body: JSON.stringify(entry.body), headers: { 'Content-Type': 'application/json' }, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', mode: 'same-origin', signal: controller.signal });
          if (generation !== operationGeneration || !optedIn) return;
          if (response.status === 202) { queue.shift(); accepted++; }
          else if ([400, 403, 409, 413, 415].includes(response.status)) { queue.shift(); dropped++; }
          else return; // No background retry. A later opted-in observation may retry.
        } catch { return; }
        finally { clearTimeout(timeout); controller = null; }
      }
    })();
    try { await inflight; } finally {
      inflight = null;
      // A fresh explicit opt-in may have queued an observation while the old
      // generation's aborted send was settling. Drain that new choice once;
      // same-generation transport failures still have no background retry.
      if (enabled && optedIn && generation !== operationGeneration && queue.length) void flush().catch(() => {});
    }
  }
  return Object.freeze({
    optIn({ consent_version, reviewed_fields }) {
      if (!enabled || consent_version !== ADOPTION_CONSENT_VERSION || !Array.isArray(reviewed_fields) || reviewed_fields.length !== ADOPTION_FIELDS.length || [...reviewed_fields].sort().join(',') !== [...ADOPTION_FIELDS].sort().join(',')) return false;
      optedIn = true; generation++; return true;
    },
    optOut() { optedIn = false; generation++; queue.length = 0; controller?.abort(); return { queued: 0, retention: 'Already received anonymous observations expire after 30 days; aggregate counts may remain for 12 months.' }; },
    observePageView: () => observe('setup_page_view'),
    observeCopySucceeded: () => observe('setup_prompt_copy_succeeded'),
    observeCopyFailed: () => observe('setup_prompt_copy_failed'),
    flush,
    status: () => ({ enabled: enabled === true, opted_in: optedIn, queued: queue.length, accepted_observations: accepted, dropped_observations: dropped, identity: 'none', local_reporting: 'off' }),
  });
}

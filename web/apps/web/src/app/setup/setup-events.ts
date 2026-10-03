import { SETUP_PROMPT_VERSION } from './setup-content';

export const SETUP_EVENT_MAX_BYTES = 2048;
export const SETUP_EVENT_NAMES = [
  'setup_page_view',
  'setup_prompt_copy_succeeded',
  'setup_prompt_copy_failed',
] as const;

export type SetupEvent = {
  schema_version: 1;
  event_id: string;
  event_name: typeof SETUP_EVENT_NAMES[number];
  route: '/setup';
  prompt_version: typeof SETUP_PROMPT_VERSION;
};

export class InvalidSetupEvent extends Error {
  constructor(readonly code: 'EVENT_TOO_LARGE' | 'INVALID_EVENT') {
    super(code);
  }
}

/** Compatibility validator for the public setup event shape. The optional
 * collector has its own consent envelope and remains disabled by default.
 * Never log the rejected body: it may contain private or forged fields. */
export function parseSetupEvent(body: string): SetupEvent {
  if (new TextEncoder().encode(body).byteLength > SETUP_EVENT_MAX_BYTES) {
    throw new InvalidSetupEvent('EVENT_TOO_LARGE');
  }
  let record: unknown;
  try { record = JSON.parse(body); } catch { throw new InvalidSetupEvent('INVALID_EVENT'); }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new InvalidSetupEvent('INVALID_EVENT');
  }
  const item = record as Record<string, unknown>;
  const keys = Object.keys(item).sort().join(',');
  if (keys !== 'event_id,event_name,prompt_version,route,schema_version'
      || item.schema_version !== 1
      || item.route !== '/setup'
      || item.prompt_version !== SETUP_PROMPT_VERSION
      || typeof item.event_id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item.event_id)
      || !SETUP_EVENT_NAMES.includes(item.event_name as SetupEvent['event_name'])) {
    throw new InvalidSetupEvent('INVALID_EVENT');
  }
  return {
    schema_version: 1,
    event_id: item.event_id,
    event_name: item.event_name as SetupEvent['event_name'],
    route: '/setup',
    prompt_version: SETUP_PROMPT_VERSION,
  };
}

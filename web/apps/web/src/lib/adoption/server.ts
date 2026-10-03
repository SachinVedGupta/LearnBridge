import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { appOrigin, AppError, requireUser } from '@/lib/server/auth';
import { ADOPTION_CONSENT_VERSION, AdoptionError, createPublicAdoptionLimiter, parseReportRange } from './policy.mjs';

export const adoptionEnabled = () => process.env.LEARNBRIDGE_ADOPTION_ENABLED === '1';
export const publicAdoptionLimiter = createPublicAdoptionLimiter();
export function adoptionResponse(status: number, data: unknown) {
  return NextResponse.json(data, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}
export function adoptionFailure(error: unknown) {
  if (error instanceof AdoptionError) return adoptionResponse(error.status, { code: error.code });
  if (error instanceof AppError) return adoptionResponse(error.status, { code: error.status === 401 ? 'AUTH_REQUIRED' : 'SERVICE_UNAVAILABLE' });
  return adoptionResponse(503, { code: 'METRICS_UNAVAILABLE' });
}
export function assertAdoptionRequest(request: Request, path: string, mutation = false) {
  const actual = new URL(request.url);
  if (actual.pathname !== path || actual.search) throw new AdoptionError('INVALID_REQUEST', 400);
  if (mutation && request.headers.get('origin') !== appOrigin()) throw new AdoptionError('ORIGIN_DENIED', 403);
  if (mutation && !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') || '')) throw new AdoptionError('CONTENT_TYPE_REQUIRED', 415);
}
export function publicAdoptionRepository() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new AdoptionError('COLLECTOR_UNAVAILABLE', 503);
  // No account cookies or service role. This anonymous client can execute only
  // the narrow bounded collector; it has no raw table read privileges.
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  return { async insertPublicEvent(input: { consent: { version: string }; event: { event_id: string; event_name: string; prompt_version: string } }) {
    const { data, error } = await db.rpc('adoption_collect_public', { p_event_id: input.event.event_id, p_event_name: input.event.event_name, p_prompt_version: input.event.prompt_version, p_consent_version: input.consent.version });
    if (error || !data || typeof data.status !== 'string') throw new AdoptionError('COLLECTOR_UNAVAILABLE', 503);
    return { status: data.status };
  } };
}
export async function requireAdoptionAdmin() {
  const auth = await requireUser();
  const { data, error } = await auth.db.rpc('adoption_is_admin');
  if (error || data !== true) throw new AdoptionError('ADMIN_REQUIRED', 403);
  if (!adoptionEnabled()) throw new AdoptionError('COLLECTION_DISABLED', 503);
  return auth;
}
export function reportRange(request: Request) {
  const actual = new URL(request.url); if ([...actual.searchParams.keys()].some(key => !['start', 'end'].includes(key)) || actual.searchParams.getAll('start').length !== 1 || actual.searchParams.getAll('end').length !== 1) throw new AdoptionError('INVALID_RANGE', 400);
  return parseReportRange(actual.searchParams.get('start'), actual.searchParams.get('end'));
}
export function enrollmentError(message: string | undefined) {
  if (message === 'REVISION_CONFLICT') throw new AdoptionError('REVISION_CONFLICT', 409);
  if (message === 'QUOTA_PAUSED') throw new AdoptionError('QUOTA_PAUSED', 429);
  throw new AdoptionError('ENROLLMENT_UNAVAILABLE', 503);
}
/** Private authenticated review binding, never an anonymous identifier or auth
 * credential. Account switches and stale settings require a fresh human view. */
export function enrollmentSnapshot(userId: string, data: unknown) {
  const value = data as { revision?: unknown; enabled?: unknown; directory_enabled?: unknown; consent_version?: unknown } | null;
  if (!value || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.enabled !== 'boolean' || typeof value.directory_enabled !== 'boolean' || (value.directory_enabled && !value.enabled) || value.consent_version !== ADOPTION_CONSENT_VERSION) throw new AdoptionError('ENROLLMENT_UNAVAILABLE', 503);
  const enrollment = { revision: value.revision, enabled: value.enabled, directory_enabled: value.directory_enabled, consent_version: ADOPTION_CONSENT_VERSION };
  const review_hash = createHash('sha256').update(JSON.stringify(['learnbridge-account-reporting-review-1', userId, enrollment])).digest('hex');
  return { enrollment, review_hash };
}
/** Optional hook AFTER a successful own state save. No read/poll/sign-in counts.
 * Disabled flag exits without an RPC; collection failure never blocks saving. */
export async function recordHostedStateSave(db: Awaited<ReturnType<typeof requireUser>>['db'], kind: string, savedRevision: number) {
  if (!adoptionEnabled() || !['tasks', 'draft'].includes(kind) || !Number.isSafeInteger(savedRevision) || savedRevision < 1) return false;
  try { const { data, error } = await db.rpc('adoption_record_state_activity', { p_kind: kind, p_revision: savedRevision }); return !error && data === true; } catch { return false; }
}

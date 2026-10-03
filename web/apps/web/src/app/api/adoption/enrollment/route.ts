import { requireUser } from '@/lib/server/auth';
import { boundedAdoptionBody, parseEnrollment, AdoptionError } from '@/lib/adoption/policy.mjs';
import { adoptionEnabled, adoptionResponse, adoptionFailure, assertAdoptionRequest, enrollmentError, enrollmentSnapshot } from '@/lib/adoption/server';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    assertAdoptionRequest(request, '/api/adoption/enrollment'); const { db, user } = await requireUser();
    if (!adoptionEnabled()) throw new AdoptionError('COLLECTION_DISABLED', 503);
    const { data, error } = await db.rpc('adoption_get_enrollment'); if (error) enrollmentError(error.message);
    return adoptionResponse(200, { ...enrollmentSnapshot(user.id, data), anonymous_attribution: 'not_joined', local_reporting: 'off' });
  } catch (error) { return adoptionFailure(error); }
}
export async function PUT(request: Request) {
  try {
    assertAdoptionRequest(request, '/api/adoption/enrollment', true); const { db, user } = await requireUser();
    if (!adoptionEnabled()) throw new AdoptionError('COLLECTION_DISABLED', 503);
    const input = parseEnrollment(await boundedAdoptionBody(request, 1024));
    const current = await db.rpc('adoption_get_enrollment'); if (current.error) enrollmentError(current.error.message);
    const viewed = enrollmentSnapshot(user.id, current.data);
    if (input.expected_revision !== viewed.enrollment.revision || input.expected_review_hash !== viewed.review_hash) throw new AdoptionError('REVISION_CONFLICT', 409);
    const { data, error } = await db.rpc('adoption_set_enrollment', { p_revision: input.expected_revision, p_enabled: input.enabled, p_directory_enabled: input.directory_enabled, p_consent_version: input.consent_version }); if (error) enrollmentError(error.message);
    const saved = enrollmentSnapshot(user.id, data);
    if (saved.enrollment.revision !== input.expected_revision + 1 || saved.enrollment.enabled !== input.enabled || saved.enrollment.directory_enabled !== input.directory_enabled) throw new AdoptionError('ENROLLMENT_READBACK_REQUIRED', 503);
    return adoptionResponse(200, { ...saved, identity: input.directory_enabled ? 'verified_account_directory_explicitly_selected' : 'no_directory_access', retention: 'Directory access stops when disabled. Consent settings remain private until account deletion; raw activity expires after 30 days or is removed on opt-out. Aggregate counts can remain for 12 months.', local_reporting: 'off' });
  } catch (error) { return adoptionFailure(error); }
}

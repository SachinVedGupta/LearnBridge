import { adoptionResponse, adoptionFailure, requireAdoptionAdmin, assertAdoptionRequest } from '@/lib/adoption/server';
import { boundedAdoptionBody, AdoptionError } from '@/lib/adoption/policy.mjs';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    assertAdoptionRequest(request, '/api/admin/adoption/purge', true); const { db } = await requireAdoptionAdmin();
    const body = await boundedAdoptionBody(request, 128); if (typeof body !== 'string' || body.trim() !== '{}') throw new AdoptionError('INVALID_REQUEST', 400);
    const { data, error } = await db.rpc('adoption_admin_purge'); if (error || !data) throw new AdoptionError('PURGE_UNAVAILABLE', 503);
    return adoptionResponse(200, { purge: data, identity_settings: 'Separate account consent lifecycle; no anonymous identity association exists.' });
  } catch (error) { return adoptionFailure(error); }
}

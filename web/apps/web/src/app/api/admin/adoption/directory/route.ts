import { adoptionResponse, adoptionFailure, requireAdoptionAdmin, assertAdoptionRequest } from '@/lib/adoption/server';
import { AdoptionError } from '@/lib/adoption/policy.mjs';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    assertAdoptionRequest(request, '/api/admin/adoption/directory'); const { db } = await requireAdoptionAdmin();
    const { data, error } = await db.rpc('adoption_admin_directory'); if (error || !Array.isArray(data)) throw new AdoptionError('DIRECTORY_UNAVAILABLE', 503);
    return adoptionResponse(200, { items: data, limit: 100, coverage: 'Only currently enabled accounts that explicitly selected directory access. Display names are provider/user supplied and not verified legal identity. No anonymous event IDs are returned.' });
  } catch (error) { return adoptionFailure(error); }
}

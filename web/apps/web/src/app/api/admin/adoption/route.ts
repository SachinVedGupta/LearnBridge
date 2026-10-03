import { adoptionResponse, adoptionFailure, requireAdoptionAdmin, reportRange } from '@/lib/adoption/server';
import { AdoptionError } from '@/lib/adoption/policy.mjs';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const { db } = await requireAdoptionAdmin(); const range = reportRange(request);
    const { data, error } = await db.rpc('adoption_admin_report', { p_start: range.start, p_end: range.end }); if (error || !data) throw new AdoptionError('REPORT_UNAVAILABLE', 503);
    return adoptionResponse(200, { report: data, collection_enabled: true, method: 'Opted-in observed interactions and separately opted-in verified account enrollments. No anonymous/account join. Copies, accounts and installations are different metrics. Client observations can be forged; visitor/person and local-installation counts are unavailable.' });
  } catch (error) { return adoptionFailure(error); }
}

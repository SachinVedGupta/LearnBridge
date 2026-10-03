import { appOrigin } from '@/lib/server/auth';
import { boundedAdoptionBody, createPublicAdoptionCollector } from '@/lib/adoption/policy.mjs';
import { adoptionEnabled, adoptionResponse, adoptionFailure, assertAdoptionRequest, publicAdoptionLimiter, publicAdoptionRepository } from '@/lib/adoption/server';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  if (!adoptionEnabled()) return adoptionResponse(503, { code: 'COLLECTION_DISABLED' });
  try {
    assertAdoptionRequest(request, '/api/adoption/events', true);
    const body = await boundedAdoptionBody(request);
    const collector = createPublicAdoptionCollector({ enabled: true, origin: appOrigin(), repository: publicAdoptionRepository(), limiter: publicAdoptionLimiter });
    const result = await collector.collect({ path: '/api/adoption/events', origin: request.headers.get('origin'), contentType: request.headers.get('content-type'), body });
    return adoptionResponse(result.status, result.data);
  } catch (error) { return adoptionFailure(error); }
}

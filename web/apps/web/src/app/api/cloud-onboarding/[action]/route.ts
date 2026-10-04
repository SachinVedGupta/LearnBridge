import { NextRequest, NextResponse } from 'next/server';
import { requireUser, useQuota, AppError } from '@/lib/server/auth';
import { sameOrigin, failure } from '@/lib/server/access';
import { hostedCloudOnboarding, cloudRequestBody, cloudOperationError } from '@/lib/server/cloud-onboarding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ action: string }> };
const headers = { 'Cache-Control': 'private, no-store' };
export async function GET(request: NextRequest, context: Context) {
  try {
    const { user } = await requireUser(); const { action } = await context.params;
    if (action !== 'accounts' || request.nextUrl.search) throw new AppError('This selected-source operation is unavailable.', 404);
    const service = hostedCloudOnboarding(user.id), signal = AbortSignal.any([request.signal, AbortSignal.timeout(25000)]);
    const result = await service.accounts(signal);
    if ((await requireUser()).user.id !== user.id) throw new AppError('Your account changed. Sign in and select sources again.', 403);
    return NextResponse.json(result, { headers });
  } catch (error) { return failure(cloudOperationError(error)); }
}
export async function POST(request: NextRequest, context: Context) {
  const denied = sameOrigin(request); if (denied) return denied;
  try {
    const { db, user } = await requireUser(); const { action } = await context.params;
    if (!['probe', 'search', 'preview', 'export'].includes(action) || request.nextUrl.search) throw new AppError('This selected-source operation is unavailable.', 404);
    await useQuota(db, 'connector');
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(25000)]);
    const body = await cloudRequestBody(request, action === 'export' ? 180000 : action === 'preview' ? 20000 : 4096);
    if ((await requireUser()).user.id !== user.id) throw new AppError('Your account changed. Sign in and select sources again.', 403);
    const service = hostedCloudOnboarding(user.id);
    const result = action === 'probe' ? await service.probe(body, signal) : action === 'search' ? await service.search(body, signal)
      : action === 'preview' ? await service.preview(body, signal) : await service.export(body, signal);
    if ((await requireUser()).user.id !== user.id) throw new AppError('Your account changed. Sign in and select sources again.', 403);
    return NextResponse.json(result, { headers });
  } catch (error) { return failure(cloudOperationError(error)); }
}

import {NextRequest, NextResponse} from 'next/server';
import {appOrigin, authClient} from '@/lib/server/auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const origin = appOrigin();
  const code = request.nextUrl.searchParams.get('code');
  const flowId = request.nextUrl.searchParams.get('sb_flow_id');
  if (code && code.length <= 4096 && (!flowId || flowId.length <= 256)) {
    try {
      const db = await authClient();
      const {error} = await db.auth.exchangeCodeForSession(code, flowId ? {flowId} : undefined);
      if (!error) return NextResponse.redirect(origin + '/', {headers: {'Cache-Control': 'private, no-store'}});
    } catch {
      // Never echo authorization codes, tokens, or provider errors into the page.
    }
  }
  return NextResponse.redirect(origin + '/login?auth_error=1', {headers: {'Cache-Control': 'private, no-store'}});
}

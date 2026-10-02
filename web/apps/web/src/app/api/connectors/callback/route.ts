import {NextRequest,NextResponse} from 'next/server';
import {requireUser,appOrigin,AppError} from '@/lib/server/auth';
import {composio} from '@/lib/server/connectors';
import {failure} from '@/lib/server/access';
export const dynamic='force-dynamic';
export async function GET(request:NextRequest){
 try{
  const {user}=await requireUser();const sessionUri=request.nextUrl.searchParams.get('session_uri');
  if(!sessionUri||sessionUri.length>4096)throw new AppError('Invalid or expired connection callback.');
  // Composio verifies the immutable pending owner against this authenticated user,
  // completes the connection once, and rejects mismatch/replay. No IDs from the browser are trusted.
  await composio().connectedAccounts.completeAuth({userId:user.id,sessionUri});
  return NextResponse.redirect(appOrigin()+'/connections');
 }catch(e){return failure(e);}
}

import {NextRequest,NextResponse} from 'next/server';
import {authClient,AppError,appOrigin} from '@/lib/server/auth';
import {sameOrigin,failure} from '@/lib/server/access';
import {z} from 'zod';
export async function POST(request:NextRequest,{params}:{params:Promise<{action:string}>}){
 const denied=sameOrigin(request);if(denied)return denied;
 try{
  const db=await authClient();
  if((await params).action==='logout'){const {error}=await db.auth.signOut();if(error)throw new AppError('Could not sign out.',502);return NextResponse.redirect(appOrigin()+'/login',303);}
  if((await params).action==='google'){
   const {data,error}=await db.auth.signInWithOAuth({provider:'google',options:{redirectTo:appOrigin()+'/auth/callback',skipBrowserRedirect:true,scopes:'openid email profile'}});
   if(error||!data.url)throw new AppError('Google sign-in is not available yet. Please try again shortly.',503);
   return NextResponse.json({url:data.url},{headers:{'Cache-Control':'private, no-store'}});
  }
  const body=z.object({email:z.string().email().max(254),password:z.string().min(8).max(128)}).safeParse(await request.json());
  if(!body.success)throw new AppError('Enter a valid email and a password with at least eight characters.');
  if((await params).action==='signup'){const {error}=await db.auth.signUp({...body.data,options:{emailRedirectTo:appOrigin()+'/login'}});if(error)throw new AppError('Account creation failed. Check your details or try again later.');return NextResponse.json({message:'Check your email to confirm your account, then sign in.'});}
  if((await params).action!=='login')throw new AppError('Unknown authentication action.');
  const {error}=await db.auth.signInWithPassword(body.data);if(error)throw new AppError('Sign-in failed. Check your email, password, and email confirmation.',401);
  return NextResponse.json({ok:true});
 }catch(e){return failure(e);}
}

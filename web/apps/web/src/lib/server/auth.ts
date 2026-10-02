import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
export class AppError extends Error {constructor(message:string,public status=400){super(message);}}
export function appOrigin(){
 const origin=process.env.APP_URL;
 if(!origin)throw new AppError('Website URL is not configured.',503);
 const u=new URL(origin);if(u.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(u.hostname))throw new AppError('The website requires HTTPS.',503);
 return u.origin;
}
export async function authClient(){
 const url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
 if(!url||!key)throw new AppError('Student accounts are not configured yet.',503);
 const jar=await cookies();
 return createServerClient(url,key,{cookieOptions:{httpOnly:true,sameSite:'lax',secure:appOrigin().startsWith('https:')},cookies:{getAll:()=>jar.getAll(),setAll:items=>{for(const {name,value,options} of items)jar.set(name,value,options);}}});
}
export async function requireUser(){
 const db=await authClient();const {data,error}=await db.auth.getUser();
 if(error||!data.user||!data.user.email_confirmed_at)throw new AppError('Sign in to your LearnBridge account.',401);
 return {db,user:data.user};
}
export async function useQuota(db:Awaited<ReturnType<typeof authClient>>,kind:'ai'|'connector'){
 const {data,error}=await db.rpc('consume_usage',{p_kind:kind});
 if(error)throw new AppError('Usage limits are not configured. Contact the site owner.',503);
 if(data!==true)throw new AppError('Hourly limit reached. Please try again later.',429);
}

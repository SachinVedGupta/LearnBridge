import {createClient} from '@supabase/supabase-js';
import {NextResponse} from 'next/server';
import {requireUser} from './auth';
import {RemoteError,remoteFail,remoteId} from '../../../../../packages/core/src/remote-companion.mjs';

export function requireRemoteEnabled(){
 if(process.env.REMOTE_COMPANION_ENABLED!=='true'||process.env.REMOTE_COMPANION_RELEASE_GATE!=='status_only_verified_policy')remoteFail('REMOTE_DISABLED',503);
}
export async function requireRemotePhone(){
 const {db,user}=await requireUser();const {data,error}=await db.auth.getClaims();const claims=data?.claims;
 if(error||!claims||claims.sub!==user.id||typeof claims.session_id!=='string')remoteFail('REMOTE_AUTH_REQUIRED',401);
 return {db,user,phoneSession:remoteId(claims!.session_id)};
}
export function remoteDeviceDatabase(){
 const url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
 if(!url||!key)remoteFail('REMOTE_UNAVAILABLE',503);
 return createClient(url!,key!,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
}
export async function remoteRpc(db:{rpc:(name:string,args:Record<string,unknown>)=>PromiseLike<{data:any;error:any}>},name:string,args:Record<string,unknown>){
 const {data,error}=await db.rpc(name,args);
 if(error){const code=typeof error.message==='string'?error.message.match(/\b(?:REMOTE_[A-Z_]+|INVALID_REMOTE_[A-Z_]+)\b/)?.[0]:null;
  const known=['REMOTE_AUTH_REQUIRED','REMOTE_DEVICE_DENIED','REMOTE_PAIRING_DENIED','REMOTE_CONSENT_REQUIRED','REMOTE_LEASE_DENIED','REMOTE_RATE_LIMITED','REMOTE_BUDGET_EXCEEDED','REMOTE_ENVELOPE_CONFLICT','REMOTE_EVENT_CONFLICT','REMOTE_TOO_LARGE','REMOTE_JOB_NOT_FOUND','REMOTE_CANCEL_FIRST','REMOTE_INSTANCE_IN_USE','INVALID_REMOTE_INPUT','INVALID_REMOTE_OPERATION'];
  if(!code||!known.includes(code))remoteFail('REMOTE_UNAVAILABLE',503);
  remoteFail(code,code.includes('CONFLICT')?409:code.includes('LIMIT')||code.includes('BUDGET')?429:code==='REMOTE_TOO_LARGE'?413:403);
 }return data;
}
export function remoteFailure(error:unknown){
 return NextResponse.json({error:{code:error instanceof RemoteError?error.code:'REMOTE_UNAVAILABLE'}},{status:error instanceof RemoteError?error.status:503,headers:{'Cache-Control':'private, no-store'}});
}
function normalizeTimes(value:any,key=''):any{
 if(typeof value==='string'&&['expires_at','lease_expires_at','last_seen_at','created_at'].includes(key)&&Number.isFinite(Date.parse(value)))return new Date(value).toISOString();
 if(Array.isArray(value))return value.map(item=>normalizeTimes(item));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([field,item])=>[field,normalizeTimes(item,field)]));
 return value;
}
export function remoteResponse(data:unknown,status=200){return NextResponse.json(normalizeTimes(data),{status,headers:{'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer'}});}

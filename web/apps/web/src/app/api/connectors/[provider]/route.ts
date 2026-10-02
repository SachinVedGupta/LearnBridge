import { NextRequest,NextResponse } from 'next/server';
import { sameOrigin,failure } from '@/lib/server/access';
import {requireUser,useQuota} from '@/lib/server/auth';
import { readConnection,linkConnection } from '@/lib/server/connectors';
export const runtime='nodejs';
export async function POST(request:NextRequest,{params}:{params:Promise<{provider:string}>}){
 const denied=sameOrigin(request);if(denied)return denied;
 try{const {db,user}=await requireUser();await useQuota(db,'connector');const body=await request.json();
  if(body.action==='link')return NextResponse.json(await linkConnection(user.id,(await params).provider));
  if(body.action!=='read'||typeof body.account!=='string'||body.account.length>200)return NextResponse.json({error:'Choose a valid account and action.'},{status:400});
  return NextResponse.json(await readConnection(user.id,(await params).provider,body.account));
 }catch(error){return failure(error);}
}

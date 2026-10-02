import {NextResponse} from 'next/server';
import {failure} from '@/lib/server/access';
import {requireUser} from '@/lib/server/auth';
import {catalog,connections} from '@/lib/server/connectors';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(){
 try{const {user}=await requireUser();let connectors:any[]=catalog.map(p=>({...p,accounts:[],configured:false})),connectorError='';
 try{connectors=await connections(user.id);}catch{connectorError='App connections need site-owner configuration.';}
 return NextResponse.json({ai:{configured:!!process.env.OPENAI_API_KEY,enabled:process.env.OPENAI_REQUESTS_ENABLED==='true'},brightspace:{configured:false},connectors,connectorError},{headers:{'Cache-Control':'private, no-store'}});
 }catch(e){return failure(e);}
}

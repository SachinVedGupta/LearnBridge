import {requireUser,useQuota} from './auth';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { generate } from './openai';
import { createTutorTools } from './connectors';
import { sameOrigin, failure } from './access';
const inputSchema = z.object({docSlice:z.string().max(30000), instructions:z.string().min(1).max(4000),courseCtx:z.string().max(20000).optional(),selectedSources:z.array(z.object({provider:z.string().max(40),accountId:z.string().min(1).max(200)})).max(5).optional(),conversation:z.array(z.object({role:z.enum(['user','assistant']),content:z.string().max(4000)})).max(8).optional()});
const editSchema = z.object({suggestions:z.array(z.object({from:z.number().int().nonnegative(),to:z.number().int().nonnegative(),replacement:z.string().max(3000),reason:z.string().max(1000)})).max(10),summary:z.string()});
const outputSchema = {type:'object',additionalProperties:false,properties:{suggestions:{type:'array',items:{type:'object',additionalProperties:false,properties:{from:{type:'integer'},to:{type:'integer'},replacement:{type:'string'},reason:{type:'string'}},required:['from','to','replacement','reason']}},summary:{type:'string'}},required:['suggestions','summary']};
export async function handleAI(request: NextRequest, mode:'ask'|'edit') {
  const denied=sameOrigin(request); if(denied) return denied;
  let user;try { const result=await requireUser();user=result.user;await useQuota(result.db,'ai'); } catch(e) {return failure(e);}
  let body; try {body=await request.json();} catch {return NextResponse.json({error:'Invalid JSON request.'},{status:400});}
  const parsed=inputSchema.safeParse(body);
  if(!parsed.success) return NextResponse.json({error:'Provide instructions and a document within the size limits.'},{status:400});
  const {docSlice,instructions,courseCtx,selectedSources=[],conversation=[]}=parsed.data;
  if(mode==='edit'&&!docSlice.trim()) return NextResponse.json({error:'Select or write text before requesting edits.'},{status:400});
  try {
    const displayName=typeof user.user_metadata?.full_name==='string'?user.user_metadata.full_name:typeof user.user_metadata?.name==='string'?user.user_metadata.name:typeof user.user_metadata?.given_name==='string'?user.user_metadata.given_name:undefined;
    const prompt=JSON.stringify({task:mode==='ask'?'Explain and guide the student.':'Suggest up to 10 minimal grammar or clarity edits to existing writing. Never fill assignment placeholders or write missing answers. from/to are UTF-16 offsets relative to document, with exclusive end.',student:{displayName},studentRequest:instructions,document:docSlice,courseContext:courseCtx||'No course context supplied.',connectedSources:selectedSources.length?'The student explicitly selected these connected accounts for this request. Search them only when relevant.':'No connected accounts were selected; use only the context included in this request.'});
    const agent=mode==='ask'&&selectedSources.length?await createTutorTools(user.id,selectedSources):undefined;
    try{
     const text=await generate([...conversation,{role:'user',content:prompt}],mode==='edit'?outputSchema:undefined,agent?.session&&agent.client?{provider:agent.client.provider as any,session:agent.session,tools:agent.tools}:undefined);
     if(mode==='ask') return NextResponse.json({assistant_text:text});
     const edits=editSchema.parse(JSON.parse(text));
     let end=0;
     const suggestions=edits.suggestions.sort((a,b)=>a.from-b.from).filter(s=>{if(s.from<end||s.to<=s.from||s.to>docSlice.length)return false;end=s.to;return true;}).map(s=>({id:randomUUID(),type:'replace',range:{from:s.from,to:s.to},original:docSlice.slice(s.from,s.to),replacement:s.replacement,reason:s.reason}));
     return NextResponse.json({suggestions,summary:edits.summary});
    } finally {await agent?.session?.delete().catch(()=>{});}
  } catch(error) { return failure(error instanceof z.ZodError || error instanceof SyntaxError ? new Error('Invalid editing response. Your document has not been changed.') : error); }
}

import {z} from 'zod';
import {NextRequest,NextResponse,after} from 'next/server';
import {requireUser,AppError} from '@/lib/server/auth';
import {sameOrigin,failure} from '@/lib/server/access';
import {recordHostedStateSave} from '@/lib/adoption/server';
const tasksSchema=z.array(z.object({id:z.string().uuid(),title:z.string().max(300),course:z.string().max(300),due:z.string().max(30),done:z.boolean()})).max(1000);
const draftSchema=z.object({title:z.string().max(500),context:z.string().max(20000),content:z.object({type:z.literal('doc'),content:z.array(z.unknown()).optional()}).passthrough()});
const valid=(kind:string)=>['tasks','draft'].includes(kind);
export async function GET(_request:NextRequest,{params}:{params:Promise<{kind:string}>}){
 try{if(!valid((await params).kind))throw new AppError('Unknown workspace data.');const {db,user}=await requireUser();const {data,error}=await db.from('student_state').select('value,revision').eq('user_id',user.id).eq('kind',(await params).kind).maybeSingle();if(error)throw new AppError('Could not load your saved workspace.',503);return NextResponse.json(data||{value:null,revision:0},{headers:{'Cache-Control':'private, no-store'}});}catch(e){return failure(e);}
}
export async function PUT(request:NextRequest,{params}:{params:Promise<{kind:string}>}){
 const denied=sameOrigin(request);if(denied)return denied;
 try{if(!valid((await params).kind))throw new AppError('Unknown workspace data.');const {db,user}=await requireUser();const text=await request.text();if(text.length>500000)throw new AppError('This document is too large.',413);const body=JSON.parse(text);if(!Number.isSafeInteger(body.revision)||body.revision<0||body.value==null)throw new AppError('Invalid save request.');
 const checked=((await params).kind==='tasks'?tasksSchema:draftSchema).safeParse(body.value);if(!checked.success)throw new AppError('Invalid workspace content.');
 const row={user_id:user.id,kind:(await params).kind,value:checked.data,revision:body.revision+1,updated_at:new Date().toISOString()};
 const query=body.revision===0?db.from('student_state').insert(row):db.from('student_state').update(row).eq('user_id',user.id).eq('kind',(await params).kind).eq('revision',body.revision);
 const {data,error}=await query.select('revision').maybeSingle();if(error||!data)throw new AppError('Your workspace changed elsewhere or could not be saved. Reload before making more changes.',409);
 after(()=>recordHostedStateSave(db,row.kind,data.revision));
 return NextResponse.json({revision:data.revision});
 }catch(e){return failure(e);}
}

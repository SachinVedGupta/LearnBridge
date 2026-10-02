import { NextRequest } from 'next/server';
import { handleAI } from '@/lib/server/ai-handler';
export const runtime='nodejs';
export const POST=(request:NextRequest)=>handleAI(request,'ask');

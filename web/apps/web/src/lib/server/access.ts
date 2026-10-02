import { NextRequest,NextResponse } from 'next/server';
import {AppError,appOrigin} from './auth';
export function sameOrigin(request:NextRequest){
 try{if(request.headers.get('origin')!==appOrigin())return NextResponse.json({error:'Request origin is not allowed.'},{status:403});}catch(e){return failure(e);}
 return null;
}
export function failure(error:unknown){
 return NextResponse.json({error:error instanceof AppError?error.message:'The request could not finish. Please retry or check your connection.'},{status:error instanceof AppError?error.status:502,headers:{'Cache-Control':'no-store'}});
}

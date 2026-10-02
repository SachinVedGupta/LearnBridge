import { NextResponse } from 'next/server';
export const dynamic='force-dynamic';
export function GET(){ return NextResponse.json({status:'ok',app:'LearnBridge',mode:process.env.VERCEL_ENV||'local'}); }

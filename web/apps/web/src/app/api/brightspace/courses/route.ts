import {NextResponse} from 'next/server';
export async function POST(){return NextResponse.json({error:'School connections require institution-supported authorization. The website does not use a shared desktop MCP session.'},{status:503});}

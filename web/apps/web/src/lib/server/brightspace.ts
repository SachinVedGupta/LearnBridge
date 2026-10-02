import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
// A deliberately small, read-only stdio MCP client. One isolated process per request.
export function courses(): Promise<unknown> {
 const entry=process.env.BRIGHTSPACE_MCP_ENTRY;
 if(!entry || !isAbsolute(entry)) throw new Error('Brightspace is not configured. Set the reviewed local MCP entry path.');
 return new Promise((resolve,reject)=>{
  const env={...process.env};
  delete env.OPENAI_API_KEY; delete env.COMPOSIO_API_KEY; delete env.GEMINI_API_KEY; delete env.GOOGLE_API_KEY;
  const child=spawn(process.execPath,[entry],{stdio:['pipe','pipe','pipe'],env});
  child.stdout.setEncoding('utf8');
  let buffer='',total=0,done=false;
  const finish=(error?:Error,result?:unknown)=>{if(done)return;done=true;clearTimeout(timer);child.kill();error?reject(error):resolve(result);};
  const timer=setTimeout(()=>finish(new Error('Brightspace did not respond in time. Reconnect through its local sign-in flow.')),25000);
  const send=(body:object)=>{if(!done)child.stdin.write(JSON.stringify({jsonrpc:'2.0',...body})+'\n');};
  child.on('error',()=>finish(new Error('Could not start the Brightspace connector.')));
  child.stdin.on('error',()=>finish(new Error('Brightspace connection closed.')));
  child.stderr.resume(); // Never forward authentication diagnostics or credentials to the browser.
  child.on('exit',()=>{if(!done)finish(new Error('Brightspace connector stopped before returning data.'));});
  child.stdout.on('data',(chunk:string)=>{
   total+=Buffer.byteLength(chunk);if(total>2000000){finish(new Error('Brightspace response exceeded the preview limit.'));return;}
   buffer+=chunk.toString();
   while(buffer.includes('\n')){
    const newline=buffer.indexOf('\n');const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
    let message;try{message=JSON.parse(line);}catch{continue;}
    if(message.error){finish(new Error('Brightspace rejected the read-only request.'));return;}
    if(message.id===1){send({method:'notifications/initialized'});send({id:2,method:'tools/call',params:{name:'get_my_courses',arguments:{activeOnly:true}}});}
    if(message.id===2){if(message.result?.isError){finish(new Error('Brightspace could not read courses. Reconnect through the local sign-in flow and retry.'));}else{finish(undefined,message.result);}}
   }
  });
  send({id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'learnbridge-local',version:'0.1.0'}}});
 });
}

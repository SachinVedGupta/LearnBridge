import { LearnBridgeError } from '@learnbridge/core';
import { HttpError } from './policy.mjs';
/** Paired UI only. Root origin, session nonce and no-query gates are mandatory. */
export async function handleCalendarImportRoute({route,method,service,session,stillAuthorized,privateBody,idempotencyKey,sourceOperation}) {
  if(!route.startsWith('/calendar-import/')) return null;
  const authorize=()=>{if(!session?.nonce || typeof session.nonce!=='string') throw new LearnBridgeError('AUTH_REQUIRED'); stillAuthorized?.();}; authorize();
  const wrong=()=>{throw new HttpError(405,'METHOD_NOT_ALLOWED','This calendar import operation is unavailable.');};
  const body=async(keys,limit=12000)=>{const value=await privateBody(keys,keys,limit);authorize();return value;};
  if(route==='/calendar-import/context') {if(method!=='GET')wrong();return{status:200,data:service.context()};}
  if(route==='/calendar-import/previews') {
    if(method==='GET') return{status:200,data:{items:service.listPreviews()}}; if(method!=='POST')wrong();
    return{status:201,data:{item:service.preview(await body(['filename','content','timezone'],100000),{idempotencyKey})}};
  }
  if(route==='/calendar-import/sources') {if(method!=='GET')wrong();return{status:200,data:{items:service.listSources()}};}
  const accepted=/^\/calendar-import\/previews\/([a-f0-9-]{36})\/accept$/i.exec(route);
  if(accepted) {if(method!=='POST')wrong();return{status:200,data:service.accept(accepted[1],await body(['expected_revision','review_hash','selected_indexes','scope','confirmed']),{idempotencyKey})};}
  const forgotten=/^\/calendar-import\/sources\/([a-f0-9-]{36})\/forget$/i.exec(route);
  if(forgotten) {if(method!=='POST')wrong();service.forget(forgotten[1],await body(['expected_revision','version_hash','confirmed']));return{status:200,data:{deleted:true,retention:'The active busy source stops being used. File previews, plan history and backups may retain private content.'}};}
  if(route==='/calendar-import/plans') {
    if(method!=='POST')wrong();const input=await body(['calendar_source','availability','timezone','horizonEnd','maxDailyMinutes','bufferMinutes','minBlockMinutes']);
    const operation=signal=>service.plan(input,{idempotencyKey,signal,authorize}); const data=sourceOperation ? await sourceOperation(operation) : await operation(); authorize();return{status:201,data};
  }
  throw new HttpError(404,'NOT_FOUND','Calendar import operation not found.');
}

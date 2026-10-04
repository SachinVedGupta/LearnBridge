import {requireRemoteEnabled} from './remote-companion';
import {remoteFail} from '../../../../../packages/core/src/remote-companion.mjs';
export function requireRemoteResultsEnabled(){
 requireRemoteEnabled();
 if(process.env.REMOTE_COMPANION_RESULT_RELEASE_GATE!=='reviewed_text_verified_policy')remoteFail('REMOTE_RESULTS_DISABLED',503);
}
export async function resultRpc(db:{rpc:(name:string,args:Record<string,unknown>)=>PromiseLike<{data:any;error:any}>},name:string,args:Record<string,unknown>){
 const {data,error}=await db.rpc(name,args);
 if(error){const code=typeof error.message==='string'?error.message.match(/\b(?:REMOTE_[A-Z_]+|INVALID_REMOTE_[A-Z_]+)\b/)?.[0]:null;
  const known=['REMOTE_AUTH_REQUIRED','REMOTE_DEVICE_DENIED','REMOTE_CONSENT_REQUIRED','REMOTE_RESULT_CONSENT_REQUIRED','REMOTE_RESULT_CONFLICT','REMOTE_RESULT_JOB_DENIED',
   'REMOTE_JOB_NOT_FOUND','REMOTE_DELIVERY_DENIED','REMOTE_DELIVERY_WAITING','REMOTE_RATE_LIMITED','INVALID_REMOTE_INPUT','INVALID_REMOTE_OPERATION'];
  if(!code||!known.includes(code))remoteFail('REMOTE_UNAVAILABLE',503);
  remoteFail(code,code==='REMOTE_DELIVERY_WAITING'?409:code.includes('CONFLICT')?409:code.includes('LIMIT')?429:403);
 }return data;
}

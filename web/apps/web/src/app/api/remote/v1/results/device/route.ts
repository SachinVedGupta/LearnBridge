import {NextRequest} from 'next/server';
import {remoteDeviceDatabase,remoteRpc,remoteFailure,remoteResponse} from '@/lib/server/remote-companion';
import {requireRemoteResultsEnabled,resultRpc} from '@/lib/server/remote-results';
import {remoteObject,remoteId,remoteDigest,remoteFail} from '../../../../../../../../../packages/core/src/remote-companion.mjs';
import {boundedRemoteResultBody,parseRemoteResultUpload} from '../../../../../../../../../packages/core/src/remote-results.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function POST(request:NextRequest){
 try{requireRemoteResultsEnabled();if(new URL(request.url).search)remoteFail('INVALID_REMOTE_INPUT');
  const token=request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];if(!token)remoteFail('REMOTE_DEVICE_DENIED',403);
  const instance=remoteId(request.headers.get('x-learnbridge-instance')),binding=remoteId(request.headers.get('x-learnbridge-binding')),operation=request.headers.get('x-learnbridge-operation');
  if(!['preflight','inspect','upload','status','claim_delivery','approve_delivery','deny_delivery','revoke'].includes(operation||''))remoteFail('INVALID_REMOTE_OPERATION');
  const db=remoteDeviceDatabase();
  // Private result bodies are not acquired without an active device credential.
  if(operation!=='revoke')await resultRpc(db,'remote_result_device',{p_binding:binding,p_token:token,p_instance:instance,p_operation:'preflight',p_payload:{}});
  const body=await boundedRemoteResultBody(request,operation==='upload'?128000:4096);
  let checked=body;
  if(operation==='upload'){checked=parseRemoteResultUpload(body);if(checked.policy.binding_id!==binding||checked.policy.installation_instance_id!==instance)remoteFail('REMOTE_DEVICE_DENIED',403);}
  else if(['preflight','claim_delivery'].includes(operation!))remoteObject(body,[]);
  else if(operation==='inspect'){remoteObject(body,['job_id']);remoteId(body.job_id);}
  else if(['status','revoke'].includes(operation!)){remoteObject(body,['local_result_id']);remoteId(body.local_result_id);}
  else{remoteObject(body,operation==='approve_delivery'?['delivery_id','nonce','review_hash','result_sha256']:['delivery_id','nonce']);remoteId(body.delivery_id);
   if(typeof body.nonce!=='string'||!/^[a-f0-9]{32}$/.test(body.nonce))remoteFail('REMOTE_DELIVERY_DENIED',403);
   if(operation==='approve_delivery'){remoteDigest(body.review_hash);remoteDigest(body.result_sha256);}}
  return remoteResponse(await resultRpc(db,'remote_result_device',{p_binding:binding,p_token:token,p_instance:instance,p_operation:operation,p_payload:checked}),operation==='upload'?201:200);
 }catch(error){return remoteFailure(error);}
}

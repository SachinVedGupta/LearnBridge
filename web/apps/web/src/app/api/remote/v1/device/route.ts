import {NextRequest} from 'next/server';
import {requireRemoteEnabled,remoteDeviceDatabase,remoteRpc,remoteFailure,remoteResponse} from '@/lib/server/remote-companion';
import {boundedRemoteBody,parseRemotePolicy,remoteId,remoteDigest,remoteObject,remoteFail} from '../../../../../../../../packages/core/src/remote-companion.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function POST(request:NextRequest){
 try{requireRemoteEnabled();if(new URL(request.url).search)remoteFail('INVALID_REMOTE_INPUT');
  const token=request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];if(!token)remoteFail('REMOTE_DEVICE_DENIED',403);
  const instance=remoteId(request.headers.get('x-learnbridge-instance')),operation=request.headers.get('x-learnbridge-operation');
  if(!['confirm','heartbeat','claim','accept','state','revoke'].includes(operation||''))remoteFail('INVALID_REMOTE_OPERATION');
  const body=await boundedRemoteBody(request,8192),db=remoteDeviceDatabase();
  if(operation==='confirm'){
   remoteObject(body,['pending_id','challenge','workspace_ref','policy']);if(typeof body.challenge!=='string'||!/^[a-f0-9]{32}$/.test(body.challenge))remoteFail('REMOTE_PAIRING_DENIED',403);
   return remoteResponse(await remoteRpc(db,'remote_confirm_pairing',{p_pending_id:remoteId(body.pending_id),p_challenge:body.challenge,p_instance:instance,
    p_workspace_ref:remoteDigest(body.workspace_ref),p_token:token,p_policy:parseRemotePolicy(body.policy)}),201);
  }
  const binding=remoteId(request.headers.get('x-learnbridge-binding'));
  if(['heartbeat','claim','revoke'].includes(operation!))remoteObject(body,[]);
  else{remoteObject(body,['job_id','lease_epoch','sequence','local_run_ref','state']);remoteId(body.job_id);remoteId(body.local_run_ref);
   if(!Number.isSafeInteger(body.lease_epoch)||body.lease_epoch<1||!Number.isSafeInteger(body.sequence)||body.sequence<1||!['local_accepted','awaiting_student','cancelled','failed','unknown_outcome'].includes(body.state))remoteFail('INVALID_REMOTE_INPUT');}
  return remoteResponse(await remoteRpc(db,'remote_device_operation',{p_binding:binding,p_token:token,p_instance:instance,p_operation:operation,p_payload:body}));
 }catch(error){return remoteFailure(error);}
}

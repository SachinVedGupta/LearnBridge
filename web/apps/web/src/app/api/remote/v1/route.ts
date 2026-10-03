import {NextRequest} from 'next/server';
import {sameOrigin} from '@/lib/server/access';
import {requireRemoteEnabled,requireRemotePhone,remoteRpc,remoteFailure,remoteResponse} from '@/lib/server/remote-companion';
import {boundedRemoteBody,parseRemoteStudyRequest,remoteHash,remoteId,remoteObject,remoteFail} from '../../../../../../../packages/core/src/remote-companion.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
const noQuery=(request:NextRequest)=>{if(new URL(request.url).search)remoteFail('INVALID_REMOTE_INPUT');};
export async function GET(request:NextRequest){
 try{requireRemoteEnabled();noQuery(request);const {db,phoneSession}=await requireRemotePhone();const binding=request.headers.get('x-learnbridge-binding');
  return remoteResponse(await remoteRpc(db,'remote_phone_status',{p_phone_session:phoneSession,p_binding:binding?remoteId(binding):null}));
 }catch(error){return remoteFailure(error);}
}
export async function POST(request:NextRequest){
 try{requireRemoteEnabled();noQuery(request);const denied=sameOrigin(request);if(denied)return denied;
  const before=await requireRemotePhone(),operation=request.headers.get('x-learnbridge-operation');
  if(!['pair','submit','cancel','revoke','delete','revoke_all'].includes(operation||''))remoteFail('INVALID_REMOTE_OPERATION');
  const binding=operation==='pair'||operation==='revoke_all'?null:remoteId(request.headers.get('x-learnbridge-binding'));
  // The phone must obtain consent/status before transmitting a prompt. The server
  // also refuses to acquire a body without a current authenticated relay grant.
  if(operation==='submit'&&await remoteRpc(before.db,'remote_phone_preflight',{p_phone_session:before.phoneSession,p_binding:binding})!==true)remoteFail('REMOTE_CONSENT_REQUIRED',403);
  const body=await boundedRemoteBody(request),after=await requireRemotePhone();
  if(after.user.id!==before.user.id||after.phoneSession!==before.phoneSession)remoteFail('REMOTE_AUTH_REQUIRED',401);
  if(operation==='pair'){remoteObject(body,[]);return remoteResponse(await remoteRpc(after.db,'remote_begin_pairing',{p_phone_session:after.phoneSession}),201);}
  if(operation==='revoke_all'){remoteObject(body,[]);return remoteResponse(await remoteRpc(after.db,'remote_phone_recover',{p_phone_session:after.phoneSession}));}
  if(operation==='submit'){const checked=parseRemoteStudyRequest(body);if(checked.binding_id!==binding)remoteFail('REMOTE_DEVICE_DENIED',403);
   return remoteResponse(await remoteRpc(after.db,'remote_submit_study',{p_phone_session:after.phoneSession,p_binding:binding,p_request:checked,p_input_hash:remoteHash(checked)}),202);}
  remoteObject(body,operation==='revoke'?[]:['job_id']);return remoteResponse(await remoteRpc(after.db,'remote_phone_control',{p_phone_session:after.phoneSession,p_binding:binding,
   p_operation:operation,p_job:operation==='revoke'?null:remoteId(body.job_id)}));
 }catch(error){return remoteFailure(error);}
}

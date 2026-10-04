import {NextRequest} from 'next/server';
import {sameOrigin} from '@/lib/server/access';
import {requireRemotePhone,remoteFailure,remoteResponse,remoteRpc} from '@/lib/server/remote-companion';
import {requireRemoteResultsEnabled,resultRpc} from '@/lib/server/remote-results';
import {remoteObject,remoteId,remoteFail} from '../../../../../../../../packages/core/src/remote-companion.mjs';
import {boundedRemoteResultBody,parseRemoteResultUpload} from '../../../../../../../../packages/core/src/remote-results.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
const noQuery=(request:NextRequest)=>{if(new URL(request.url).search)remoteFail('INVALID_REMOTE_INPUT');};
export async function GET(request:NextRequest){
 try{requireRemoteResultsEnabled();noQuery(request);const {db,phoneSession}=await requireRemotePhone();const binding=remoteId(request.headers.get('x-learnbridge-binding'));
  return remoteResponse(await resultRpc(db,'remote_result_phone',{p_phone_session:phoneSession,p_binding:binding,p_operation:'list',p_payload:{}}));
 }catch(error){return remoteFailure(error);}
}
export async function POST(request:NextRequest){
 try{requireRemoteResultsEnabled();noQuery(request);const denied=sameOrigin(request);if(denied)return denied;
  const before=await requireRemotePhone(),operation=request.headers.get('x-learnbridge-operation');
  if(!['begin_delivery','read','delete','recover'].includes(operation||''))remoteFail('INVALID_REMOTE_OPERATION');
  const binding=operation==='recover'?null:remoteId(request.headers.get('x-learnbridge-binding'));
  if(!['delete','recover'].includes(operation!)&&await remoteRpc(before.db,'remote_phone_preflight',{p_phone_session:before.phoneSession,p_binding:binding})!==true)remoteFail('REMOTE_CONSENT_REQUIRED',403);
  const body=await boundedRemoteResultBody(request,4096),after=await requireRemotePhone();
  if(before.user.id!==after.user.id||before.phoneSession!==after.phoneSession)remoteFail('REMOTE_AUTH_REQUIRED',401);
  if(operation==='recover')remoteObject(body,[]);
  else{const field=operation==='read'?'delivery_id':'result_id';remoteObject(body,[field]);remoteId(body[field]);}
  const result=await resultRpc(after.db,'remote_result_phone',{p_phone_session:after.phoneSession,p_binding:binding,p_operation:operation,p_payload:body});
  if(operation==='read'){
   remoteObject(result,['id','local_result_id','text','result_sha256','review_hash','policy','delivery_id','fresh_local_check']);remoteId(result.id);
   parseRemoteResultUpload({schema_version:1,local_result_id:result.local_result_id,policy:result.policy,review_hash:result.review_hash,text:result.text});
   if(result.policy.binding_id!==binding||result.policy.account_id!==after.user.id||result.policy.phone_session_ref!==after.phoneSession
    ||result.result_sha256!==result.policy.result_sha256||result.fresh_local_check!==true||result.delivery_id!==body.delivery_id)remoteFail('REMOTE_RESULT_CONFLICT',409);
   const final=await requireRemotePhone();if(final.user.id!==after.user.id||final.phoneSession!==after.phoneSession)remoteFail('REMOTE_AUTH_REQUIRED',401);
  }
  return remoteResponse(result,operation==='begin_delivery'?202:200);
 }catch(error){return remoteFailure(error);}
}

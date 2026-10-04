/** Actual loopback HTTP with synthetic relay identity/storage. No live Supabase,
 * account or Codex claim. Tests independently execute PostgreSQL elsewhere. */
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {REMOTE_ORIGIN,remoteHash} from '../../packages/core/src/remote-companion.mjs';
import {parseRemoteResultUpload,boundedRemoteResultBody} from '../../packages/core/src/remote-results.mjs';
import {createRemoteResultTransport} from '../../apps/local-runtime/src/remote-results.mjs';

export async function relayFixture(){
 const state={account:randomUUID(),session:randomUUID(),binding:null,token:null,jobs:[],results:[],deliveries:[],ledger:[],activeSession:true,dropUpload:false,hook:null};
 const fail=code=>{throw Object.assign(Error(code),{code});},current=()=>{if(!state.binding||state.binding.state!=='active'||!state.activeSession||Date.parse(state.binding.policy.expires_at)<=Date.now())fail('REMOTE_CONSENT_REQUIRED');};
 const meta=row=>({id:row.id,local_result_id:row.local_result_id,state:row.state,review_hash:row.review_hash,result_sha256:row.policy?.result_sha256||row.result_sha256});
 const server=createServer(async(req,res)=>{
  try{
   const path=new URL(req.url,'http://fixture').pathname,operation=req.headers['x-learnbridge-operation'];
   if(path.includes('/phone')){if(req.headers['x-fixture-account']!==state.account||req.headers['x-fixture-session']!==state.session)fail('REMOTE_AUTH_REQUIRED');}
   else if(operation!=='confirm'){current();if(req.headers.authorization!==`Bearer ${state.token}`||req.headers['x-learnbridge-instance']!==state.binding.installation_instance_id||req.headers['x-learnbridge-binding']!==state.binding.id)fail('REMOTE_DEVICE_DENIED');}
   let text='';for await(const part of req){text+=part;if(Buffer.byteLength(text)>128000)fail('REMOTE_TOO_LARGE');}const payload=JSON.parse(text||'{}');
   state.ledger.push({path,operation,payload:structuredClone(payload)});if(state.hook)await state.hook(operation,payload,path);
   let value;
   if(path==='/phone'){
    if(operation==='pair'){value={pending_id:randomUUID(),challenge:'a'.repeat(32)};state.pending=value;}
    else if(operation==='submit'){current();if(payload.binding_id!==state.binding.id)fail('REMOTE_CONSENT_REQUIRED');const existing=state.jobs.find(row=>row.request.client_request_id===payload.client_request_id);
     if(existing&&existing.input_hash!==remoteHash(payload))fail('REMOTE_ENVELOPE_CONFLICT');
     if(existing)value={id:existing.id,state:existing.state,duplicate:true};else{const row={id:randomUUID(),binding_id:state.binding.id,account_id:state.account,request:payload,input_hash:remoteHash(payload),state:'leased',lease_epoch:1,
      lease_expires_at:new Date(Date.now()+60000).toISOString(),local_run_ref:null,expires_at:new Date(Date.now()+900000).toISOString(),sequence:0};state.jobs.push(row);value={id:row.id,state:'queued'};}}
    else if(operation==='revoke_all'){if(state.binding)state.binding.state='revoked';value={state:'revoked'};}
    else if(operation==='cancel'){current();const job=state.jobs.find(row=>row.id===payload.job_id);job.state='cancel_requested';value={state:'cancel_requested'};}
    else fail('INVALID_REMOTE_OPERATION');
   }else if(path==='/phone/results'){
    current();const result=state.results.find(row=>row.id===payload.result_id),delivery=state.deliveries.find(row=>row.id===payload.delivery_id);
    if(operation==='list')value={items:state.results.map(row=>({...meta(row),job_id:row.policy.job_id,result_bytes:row.policy.result_bytes,expires_at:row.policy.expires_at,content_status:row.policy.content_status}))};
    else if(operation==='begin_delivery'){if(!result||result.state!=='available'||Date.parse(result.policy.expires_at)<=Date.now()||state.jobs.find(row=>row.id===result.policy.job_id)?.state!=='awaiting_student')fail('REMOTE_DELIVERY_DENIED');
     const existing=state.deliveries.find(row=>row.result_id===result.id&&['waiting_local','ready'].includes(row.state)&&Date.parse(row.expires_at)>Date.now());
     const row=existing||{id:randomUUID(),binding_id:state.binding.id,account_id:state.account,result_id:result.id,result_sha256:result.policy.result_sha256,review_hash:result.review_hash,
      nonce:randomUUID().replaceAll('-',''),expires_at:new Date(Date.now()+60000).toISOString(),state:'waiting_local'};if(!existing)state.deliveries.push(row);value={id:row.id,state:row.state,expires_at:row.expires_at};}
    else if(operation==='read'){if(!delivery||delivery.state!=='ready'||Date.parse(delivery.ready_expires_at)<=Date.now())fail('REMOTE_DELIVERY_WAITING');const actual=state.results.find(row=>row.id===delivery.result_id);
     if(actual.state!=='available'||Date.parse(actual.policy.expires_at)<=Date.now()||state.jobs.find(row=>row.id===actual.policy.job_id)?.state!=='awaiting_student')fail('REMOTE_DELIVERY_DENIED');delivery.state='consumed';value={id:actual.id,local_result_id:actual.local_result_id,
      text:actual.text,result_sha256:actual.policy.result_sha256,review_hash:actual.review_hash,policy:actual.policy,delivery_id:delivery.id,fresh_local_check:true};}
    else if(operation==='delete'){if(result){result.state='revoked';result.text='';for(const d of state.deliveries)if(d.result_id===result.id)d.state='denied';}value={state:'revoked',text_erased:true};}
    else fail('INVALID_REMOTE_OPERATION');
   }else if(path==='/api/remote/v1/device'){
    if(operation==='confirm'){if(payload.pending_id!==state.pending?.pending_id||payload.challenge!==state.pending?.challenge)fail('REMOTE_PAIRING_DENIED');if(state.binding?.state==='active')fail('REMOTE_INSTANCE_IN_USE');
     state.token=req.headers.authorization.slice(7);state.binding={id:randomUUID(),account_id:state.account,phone_session_ref:state.session,installation_instance_id:req.headers['x-learnbridge-instance'],workspace_ref:payload.workspace_ref,
      state:'active',policy:payload.policy,revision:1,last_seen_at:null};value=state.binding;state.pending=null;}
    else if(operation==='heartbeat')value=state.binding;
    else if(operation==='revoke'){state.binding.state='revoked';value={status:'revoked'};}
    else if(operation==='claim')value=state.jobs.find(row=>['leased','local_accepted','awaiting_student','cancel_requested'].includes(row.state))||null;
    else if(['accept','state'].includes(operation)){const job=state.jobs.find(row=>row.id===payload.job_id);if(!job||job.lease_epoch!==payload.lease_epoch)fail('REMOTE_LEASE_DENIED');if(payload.sequence===job.sequence){if(payload.state!==job.state)fail('REMOTE_EVENT_CONFLICT');value={status:'duplicate',state:job.state};}
     else{if(payload.sequence!==job.sequence+1)fail('REMOTE_EVENT_CONFLICT');Object.assign(job,{state:payload.state,sequence:payload.sequence,local_run_ref:payload.local_run_ref});value={status:'accepted',state:job.state};}}
    else fail('INVALID_REMOTE_OPERATION');
   }else if(path==='/api/remote/v1/results/device'){
    if(operation==='preflight')value=true;
    else if(operation==='inspect'){const row=state.jobs.find(row=>row.id===payload.job_id);if(!row)fail('REMOTE_JOB_NOT_FOUND');const {id,binding_id,account_id,input_hash,state:jobState,local_run_ref,sequence}=row;value={id,binding_id,account_id,input_hash,state:jobState,local_run_ref,sequence};}
    else if(operation==='status'){const row=state.results.find(row=>row.local_result_id===payload.local_result_id);value=row?meta(row):{state:'not_found'};}
    else if(operation==='upload'){const checked=parseRemoteResultUpload(payload);const job=state.jobs.find(row=>row.id===checked.policy.job_id);if(!job||job.state!=='awaiting_student')fail('REMOTE_RESULT_JOB_DENIED');
     if(checked.policy.binding_id!==state.binding.id||checked.policy.account_id!==state.account||checked.policy.binding_policy_hash!==remoteHash(state.binding.policy))fail('REMOTE_RESULT_CONSENT_REQUIRED');
     let row=state.results.find(row=>row.local_result_id===checked.local_result_id||row.policy.job_id===checked.policy.job_id);if(row&&(row.review_hash!==checked.review_hash||row.local_result_id!==checked.local_result_id||row.state!=='available'))fail('REMOTE_RESULT_CONFLICT');
     if(!row){row={...checked,id:randomUUID(),state:'available'};state.results.push(row);}value=meta(row);if(state.dropUpload){state.dropUpload=false;res.destroy();return;}}
    else if(operation==='claim_delivery'){const row=state.deliveries.find(row=>row.state==='waiting_local'&&Date.parse(row.expires_at)>Date.now());value=row?Object.fromEntries(Object.entries(row).filter(([key])=>key!=='state')):null;}
    else if(['approve_delivery','deny_delivery'].includes(operation)){const row=state.deliveries.find(row=>row.id===payload.delivery_id);if(!row||row.nonce!==payload.nonce||Date.parse(row.expires_at)<=Date.now())fail('REMOTE_DELIVERY_DENIED');
     if(operation==='deny_delivery'){row.state='denied';value={state:'denied'};}else{const result=state.results.find(result=>result.id===row.result_id);if(!result||result.state!=='available'||result.review_hash!==payload.review_hash||result.policy.result_sha256!==payload.result_sha256)fail('REMOTE_DELIVERY_DENIED');
      row.state='ready';row.ready_expires_at=new Date(Date.now()+30000).toISOString();value={state:'ready',expires_at:row.ready_expires_at};}}
    else if(operation==='revoke'){const row=state.results.find(row=>row.local_result_id===payload.local_result_id);if(row){row.state='revoked';row.text='';}for(const d of state.deliveries)d.state='denied';value={state:'revoked'};}
    else fail('INVALID_REMOTE_OPERATION');
   }else fail('INVALID_REMOTE_OPERATION');
   res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'private, no-store'});res.end(JSON.stringify(value));
  }catch(error){if(!res.destroyed){res.writeHead(error.code==='REMOTE_DELIVERY_WAITING'?409:403,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{code:error.code||'REMOTE_UNAVAILABLE'}}));}}
 });server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
 const factory=credentials=>({async send(operation,payload){const response=await fetch(`${origin}/api/remote/v1/device`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${credentials.token}`,
  'X-LearnBridge-Instance':credentials.installation_instance_id,...(credentials.binding_id?{'X-LearnBridge-Binding':credentials.binding_id}:{}),'X-LearnBridge-Operation':operation},body:JSON.stringify(payload)});
  if(!response.ok){const denied=await response.json();fail(denied.error.code);}return boundedRemoteResultBody(response);},
  results:credentials.binding_id?createRemoteResultTransport({...credentials,fetchImpl:(url,options)=>{if(url!==`${REMOTE_ORIGIN}/api/remote/v1/results/device`)fail('ARBITRARY_URL');return fetch(`${origin}/api/remote/v1/results/device`,options);}}).send:async()=>fail('REMOTE_PAIRING_REQUIRED')});
 const phone=async(operation,payload={},results=false,identity={account:state.account,session:state.session})=>{const response=await fetch(`${origin}/phone${results?'/results':''}`,{method:'POST',headers:{'Content-Type':'application/json','X-Fixture-Account':identity.account,'X-Fixture-Session':identity.session,'X-LearnBridge-Operation':operation},body:JSON.stringify(payload)});
  const value=await response.json();return {status:response.status,data:value};};
 return {state,origin,factory,phone,close:()=>new Promise(resolve=>server.close(resolve))};
}

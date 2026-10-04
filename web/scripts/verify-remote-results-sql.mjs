/** Disposable PostgreSQL/WASM execution, never a production migration runner.
 * Explicit test-only runtime: node web/scripts/verify-remote-results-sql.mjs --install-runtime
 * The existing optional SQL harness already pins this same temporary runtime.
 * Synthetic auth and one session do not prove live Supabase/JWT/concurrency. */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {REMOTE_VERSION,remoteHash} from '../packages/core/src/remote-companion.mjs';
import {REMOTE_RESULT_VERSION,parseRemoteResultUpload} from '../packages/core/src/remote-results.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),runtime={pglite:'0.5.8',pgtap:'0.0.9'};
const migrations=['202610030003_remote_companion_foundation.sql','202610040005_remote_reviewed_results.sql'];
const sha=text=>createHash('sha256').update(text).digest('hex');
const bootstrap=`create schema auth;create schema extensions;
create role anon nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
create role authenticated nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
create role service_role nologin nosuperuser nocreatedb nocreaterole noinherit bypassrls;
grant usage on schema public,auth,extensions to anon,authenticated,service_role;
create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,not_after timestamptz);
create function auth.uid() returns uuid language sql stable as $$select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid;$$;
create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb);$$;
revoke all on auth.users,auth.sessions from public,anon,authenticated;
grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;
create extension pgcrypto with schema extensions;`;

async function main(){
 if(process.argv.slice(2).join(' ')!=='--install-runtime'){console.error('Explicit test-only runtime opt-in required: --install-runtime');process.exitCode=2;return;}
 const temporary=await mkdtemp(join(tmpdir(),'learnbridge-results-sql-'));let db;
 const evidence={schema_version:1,verified_at:new Date().toISOString(),runtime,scope:'disposable_single_session_postgresql_wasm_synthetic_auth',migrations:[],checks:[],status:'failed',
  production_configuration_changed:false,live_supabase_verified:false,real_jwt_session_revocation_verified:false,concurrent_sessions_verified:false,deployed_retention_scheduler_verified:false};
 try{
  await writeFile(join(temporary,'package.json'),'{"private":true,"type":"module"}\n',{mode:0o600});
  for(const name of ['user.npmrc','global.npmrc'])await writeFile(join(temporary,name),'',{mode:0o600});
  await promisify(execFile)('npm',['install','--prefix',temporary,'--ignore-scripts','--no-audit','--no-fund','--package-lock=false','--registry=https://registry.npmjs.org',
   `--userconfig=${join(temporary,'user.npmrc')}`,`--globalconfig=${join(temporary,'global.npmrc')}`,`--cache=${join(temporary,'cache')}`,`@electric-sql/pglite@${runtime.pglite}`,`@electric-sql/pglite-pgtap@${runtime.pgtap}`],
   {cwd:temporary,env:{PATH:`${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,TMPDIR:temporary},timeout:60000,maxBuffer:65536});
  const require=createRequire(join(temporary,'package.json')),{PGlite}=require('@electric-sql/pglite'),{pgcrypto}=require('@electric-sql/pglite/contrib/pgcrypto');
  db=await PGlite.create({extensions:{pgcrypto}});await db.exec(bootstrap);
  evidence.postgres_version=(await db.query('select version() as value')).rows[0].value;
  for(const name of migrations){const sql=await readFile(join(root,'supabase/migrations',name),'utf8');await db.exec(sql);evidence.migrations.push({name,sha256:sha(sql),status:'passed'});}
  const query=async(sql,args=[])=> (await db.query(sql,args)).rows[0]?.value;
  const role=async(name,owner,session)=>{await db.exec('reset role');await query("select set_config('request.jwt.claims',$1,false) as value",[JSON.stringify({sub:owner,session_id:session,role:name})]);await db.exec(`set role ${name}`);};
  const probe=async(name,action)=>{await action();evidence.checks.push({name,status:'passed'});};
  const denied=async(promise,code)=>assert.rejects(promise,error=>error.code===code||error.message.includes(code));
  const a=randomUUID(),b=randomUUID(),sa=randomUUID(),sb=randomUUID(),newsa=randomUUID(),instance=randomUUID(),token='a'.repeat(43);
  await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now()),($3,$4,now())',[a,'result-a@example.invalid',b,'result-b@example.invalid']);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2),($3,$4),($5,$2)',[sa,a,sb,b,newsa]);
  const now=Date.now(),policy={version:REMOTE_VERSION,destination:'codex',host_grant_id:randomUUID(),selection_hash:'b'.repeat(64),expires_at:new Date(now+1800000).toISOString(),
   max_requests:3,max_request_bytes:16384,recipes:['study.explain'],relay_processing_confirmed:true,plaintext_notice_confirmed:true,retention_hours:24,result_scope:'status_only'};
  await role('authenticated',a,sa);const pending=await query('select public.remote_begin_pairing($1::uuid) as value',[sa]);
  await role('anon',a,sa);const binding=await query('select public.remote_confirm_pairing($1::uuid,$2,$3::uuid,$4,$5,$6::jsonb) as value',[pending.pending_id,pending.challenge,instance,'c'.repeat(64),token,JSON.stringify(policy)]);
  const input={schema_version:1,binding_id:binding.id,client_request_id:randomUUID(),recipe_id:'study.explain',recipe_version:REMOTE_VERSION,prompt:'SYNTHETIC_PROMPT: explain recursion.'};
  await role('authenticated',a,sa);const job=await query('select public.remote_submit_study($1::uuid,$2::uuid,$3::jsonb,$4) as value',[sa,binding.id,JSON.stringify(input),remoteHash(input)]);
  const legacy=async(op,payload)=>query('select public.remote_device_operation($1::uuid,$2,$3::uuid,$4,$5::jsonb) as value',[binding.id,token,instance,op,JSON.stringify(payload)]);
  await role('anon',a,sa);await legacy('claim',{});const localRun=randomUUID();await legacy('accept',{job_id:job.id,lease_epoch:1,sequence:1,local_run_ref:localRun,state:'local_accepted'});await legacy('state',{job_id:job.id,lease_epoch:1,sequence:2,local_run_ref:localRun,state:'awaiting_student'});
  const body='SYNTHETIC_REVIEWED_RESULT: A base case terminates recursion. 🧠\n\nLiteral <script> and Markdown remain text.';
  const resultPolicy={version:REMOTE_RESULT_VERSION,binding_id:binding.id,account_id:a,installation_instance_id:instance,workspace_ref:binding.workspace_ref,
   phone_session_ref:sa,binding_revision:binding.revision,binding_policy_hash:remoteHash(policy),job_id:job.id,input_hash:remoteHash(input),host_grant_id:policy.host_grant_id,selection_hash:policy.selection_hash,
   writing_record:{id:randomUUID(),revision:2,payload_hash:'d'.repeat(64)},document:{id:randomUUID(),revision:1,sha256:sha(body)},source_documents:[{id:randomUUID(),revision:1,sha256:'e'.repeat(64)}],
   academic_policy:'learning_support',content_status:'student_reviewed_model_output_facts_unverified',result_sha256:sha(body),result_bytes:Buffer.byteLength(body),expires_at:new Date(now+600000).toISOString(),
   relay_processing_confirmed:true,plaintext_notice_confirmed:true,retention_hours:24};
  const upload=parseRemoteResultUpload({schema_version:1,local_result_id:randomUUID(),policy:resultPolicy,review_hash:remoteHash(resultPolicy),text:body});
  const device=async(op,payload,credential=token,inst=instance)=>query('select public.remote_result_device($1::uuid,$2,$3::uuid,$4,$5::jsonb) as value',[binding.id,credential,inst,op,JSON.stringify(payload)]);
  const phone=async(op,payload={},session=sa)=>query('select public.remote_result_phone($1::uuid,$2::uuid,$3,$4::jsonb) as value',[session,binding.id,op,JSON.stringify(payload)]);
  await probe('SQL canonical policy matches actual JS review hash',async()=>{await db.exec('reset role');assert.equal(await query("select encode(extensions.digest(public.remote_result_canonical($1::jsonb),'sha256'),'hex') as value",[JSON.stringify(resultPolicy)]),upload.review_hash);await role('anon',a,sa);});
  await probe('anonymous cannot select result/delivery tables or invoke private canonical helper',async()=>{for(const table of ['remote_reviewed_results','remote_result_deliveries'])await denied(db.query(`select * from public.${table}`),'42501');await denied(query("select public.remote_result_canonical('{}') as value"),'42501');});
  await probe('wrong device credential and installation rejected',async()=>{await denied(device('preflight',{},'z'.repeat(43)),'REMOTE_DEVICE_DENIED');await denied(device('preflight',{},token,randomUUID()),'REMOTE_DEVICE_DENIED');});
  await probe('null metadata identities cannot acknowledge erasure',async()=>{for(const [op,key] of [['status','local_result_id'],['inspect','job_id'],['revoke','local_result_id']])await denied(device(op,{[key]:null}),'INVALID_REMOTE_INPUT');});
  for(const [field,value] of Object.entries({academic_policy:null,content_status:null,result_bytes:null,binding_revision:null,relay_processing_confirmed:false,source_documents:null,account_id:b})){await probe(`strict policy rejects ${field}`,async()=>{const changed={...upload,policy:{...resultPolicy,[field]:value}};changed.review_hash=remoteHash(changed.policy);await denied(device('upload',changed),field==='account_id'?'REMOTE_RESULT_CONSENT_REQUIRED':field==='academic_policy'||field==='content_status'||field==='relay_processing_confirmed'?'REMOTE_RESULT_CONSENT_REQUIRED':field==='binding_revision'?'REMOTE_RESULT_CONSENT_REQUIRED':'INVALID_REMOTE_INPUT');});}
  await probe('wrong original text bytes or review hash are not retained',async()=>{await denied(device('upload',{...upload,text:body+'changed'}),'REMOTE_RESULT_CONFLICT');await denied(device('upload',{...upload,review_hash:'f'.repeat(64)}),'REMOTE_RESULT_CONFLICT');});
  let saved;await probe('exact reviewed result upload persists and retry returns one ID',async()=>{saved=await device('upload',upload);assert.equal(saved.state,'available');assert.equal(saved.duplicate,false);const repeat=await device('upload',upload);assert.equal(repeat.id,saved.id);assert.equal(repeat.duplicate,true);});
  await probe('changed upload with same job/local receipt conflicts',async()=>{await denied(device('upload',{...upload,local_result_id:randomUUID()}),'REMOTE_RESULT_CONFLICT');});
  await role('authenticated',b,sb);await probe('cross account cannot list/begin/read or erase another result',async()=>{for(const [op,payload] of [['list',{}],['begin_delivery',{result_id:saved.id}],['read',{delivery_id:randomUUID()}],['delete',{result_id:saved.id}]])await denied(phone(op,payload,sb),'REMOTE_AUTH_REQUIRED');});
  await role('authenticated',a,newsa);await probe('new verified owner session cannot read old phone binding',async()=>{await denied(phone('list',{},newsa),'REMOTE_AUTH_REQUIRED');});
  await role('authenticated',a,sa);await probe('status list contains hashes and metadata but no text/policy',async()=>{const listed=await phone('list');assert.equal(listed.items.length,1);assert.equal(listed.items[0].result_sha256,sha(body));assert(!JSON.stringify(listed).includes('SYNTHETIC_REVIEWED_RESULT'));assert(!Object.hasOwn(listed.items[0],'policy'));});
  let delivery;await probe('phone needs a new one-use laptop delivery check before body is released',async()=>{delivery=await phone('begin_delivery',{result_id:saved.id});assert.equal(delivery.state,'waiting_local');assert.equal((await phone('begin_delivery',{result_id:saved.id})).id,delivery.id);await denied(phone('read',{delivery_id:delivery.id}),'REMOTE_DELIVERY_WAITING');});
  await role('anon',a,sa);const challenge=await device('claim_delivery',{});const approve={delivery_id:challenge.id,nonce:challenge.nonce,result_sha256:sha(body),review_hash:upload.review_hash};
  await probe('wrong delivery nonce or hash is denied',async()=>{await denied(device('approve_delivery',{...approve,nonce:'0'.repeat(32)}),'REMOTE_DELIVERY_DENIED');await denied(device('approve_delivery',{...approve,result_sha256:'0'.repeat(64)}),'REMOTE_DELIVERY_DENIED');});
  await probe('JSON null nonce/hash cannot bypass SQL comparisons',async()=>{for(const field of ['nonce','review_hash','result_sha256','delivery_id'])await denied(device('approve_delivery',{...approve,[field]:null}),'INVALID_REMOTE_INPUT');});
  await probe('fresh approval lasts at most 30 seconds; retry never extends expiry',async()=>{const ready=await device('approve_delivery',approve);assert.equal(ready.state,'ready');assert(Date.parse(ready.expires_at)<=Date.now()+30000);assert.equal((await device('approve_delivery',approve)).expires_at,ready.expires_at);});
  await role('authenticated',a,sa);await probe('one exact delivery returns body/hash/policy once; replay fails',async()=>{const read=await phone('read',{delivery_id:delivery.id});assert.equal(read.text,body);assert.equal(read.review_hash,upload.review_hash);assert.equal(read.fresh_local_check,true);await denied(phone('read',{delivery_id:delivery.id}),'REMOTE_DELIVERY_WAITING');});
  await probe('result lifetime delivery budget remains 20 after physical ticket purge',async()=>{
   for(let n=1;n<20;n++){const ticket=await phone('begin_delivery',{result_id:saved.id});await role('anon',a,sa);const check=await device('claim_delivery',{});await device('approve_delivery',{...approve,delivery_id:check.id,nonce:check.nonce});await role('authenticated',a,sa);await phone('read',{delivery_id:ticket.id});}
   await denied(phone('begin_delivery',{result_id:saved.id}),'REMOTE_RATE_LIMITED');await db.exec('reset role');await db.query("update public.remote_result_deliveries set expires_at=now()-interval '1 second'");
   await role('service_role',a,sa);await query('select public.remote_result_purge_expired() as value');await role('authenticated',a,sa);await denied(phone('begin_delivery',{result_id:saved.id}),'REMOTE_RATE_LIMITED');
   await db.exec('reset role');assert.equal(await query('select delivery_requests as value from public.remote_reviewed_results where id=$1',[saved.id]),20);
   // Test-only fixture reset isolates the next capacity cases; no public reset exists.
   await db.query('update public.remote_reviewed_results set delivery_requests=0 where id=$1',[saved.id]);await role('authenticated',a,sa);
  });
  await probe('account 200 and global 2000 retained-ticket bounds reject new insertion',async()=>{
   await db.exec('reset role');await db.query("insert into public.remote_result_deliveries(result_id,binding_id,account_id,phone_session_ref,nonce,state) select $1::uuid,$2::uuid,$3::uuid,$4::uuid,'','consumed' from generate_series(1,200)",[saved.id,binding.id,a,sa]);
   await role('authenticated',a,sa);await denied(phone('begin_delivery',{result_id:saved.id}),'REMOTE_RATE_LIMITED');await db.exec('reset role');await db.exec('delete from public.remote_result_deliveries');
   // Synthetic administrator capacity rows are never reachable by public inserts.
   await db.query("insert into public.remote_result_deliveries(result_id,binding_id,account_id,phone_session_ref,nonce,state) select $1::uuid,$2::uuid,$3::uuid,$4::uuid,'','consumed' from generate_series(1,2000)",[saved.id,binding.id,b,sb]);
   await role('authenticated',a,sa);await denied(phone('begin_delivery',{result_id:saved.id}),'REMOTE_RATE_LIMITED');await db.exec('reset role');await db.exec('delete from public.remote_result_deliveries');await role('authenticated',a,sa);
  });
  delivery=await phone('begin_delivery',{result_id:saved.id});await role('anon',a,sa);const next=await device('claim_delivery',{});await device('approve_delivery',{...approve,delivery_id:next.id,nonce:next.nonce});
  await db.exec('reset role');await db.query("update public.remote_result_deliveries set ready_expires_at=now()-interval '1 second' where id=$1",[delivery.id]);await role('authenticated',a,sa);
  await probe('expired ready ticket cannot release cached cloud text',async()=>{await denied(phone('read',{delivery_id:delivery.id}),'REMOTE_DELIVERY_WAITING');});
  await db.exec('reset role');await db.query('delete from auth.sessions where id=$1',[sa]);await role('authenticated',a,sa);
  await probe('deleted GoTrue session rejects a still matching JWT claim',async()=>{await denied(phone('list'),'REMOTE_AUTH_REQUIRED');});
  await role('anon',a,sa);await probe('device result preflight rejects deleted bound phone session before content',async()=>{await denied(device('preflight',{}),'REMOTE_AUTH_REQUIRED');});
  await db.exec('reset role');await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[sa,a]);await db.query("update public.remote_jobs set state='cancel_requested' where id=$1",[job.id]);await role('authenticated',a,sa);
  await probe('cancelled phone job cannot request or receive a result',async()=>{await denied(phone('begin_delivery',{result_id:saved.id}),'REMOTE_DELIVERY_DENIED');});
  await db.exec('reset role');await db.query("update public.remote_jobs set state='awaiting_student' where id=$1",[job.id]);await role('authenticated',a,newsa);
  await probe('fresh owner recovery erases active relay text but cannot revive it',async()=>{assert.equal((await phone('delete',{result_id:saved.id},newsa)).text_erased,true);});
  await probe('null phone result identity cannot acknowledge erasure',async()=>{await denied(phone('delete',{result_id:null},newsa),'INVALID_REMOTE_INPUT');});
  await db.exec('reset role');await probe('relay erasure physically clears text/policy and denies all pending tickets',async()=>{const row=(await db.query('select state,result_text,policy from public.remote_reviewed_results where id=$1',[saved.id])).rows[0];assert.equal(row.state,'revoked');assert.equal(row.result_text,null);assert.deepEqual(row.policy,{});assert.equal(await query("select count(*)::integer as value from public.remote_result_deliveries where result_id=$1 and state in ('waiting_local','ready')",[saved.id]),0);});
  await role('anon',a,sa);await probe('revoked result cannot be re-uploaded or re-read',async()=>{await denied(device('upload',upload),'REMOTE_RESULT_CONFLICT');});
  await role('authenticated',a,newsa);await probe('fresh owner result recovery revokes lost-credential binding and erases owned responses',async()=>{const recovered=await query("select public.remote_result_phone($1::uuid,null,'recover','{}') as value",[newsa]);assert.equal(recovered.text_erased,true);await db.exec('reset role');assert.equal(await query('select state as value from public.remote_device_bindings where id=$1',[binding.id]),'revoked');});
  await db.exec('reset role');await db.query("update public.remote_reviewed_results set purge_at=now()-interval '1 second' where id=$1",[saved.id]);
  await role('authenticated',a,sa);await probe('student cannot invoke privileged physical purge',async()=>{await denied(query('select public.remote_result_purge_expired() as value'),'42501');});
  await role('service_role',a,sa);await query('select public.remote_result_purge_expired() as value');await db.exec('reset role');await probe('service-only expired purge removes result/delivery rows',async()=>{assert.equal(await query('select count(*)::integer as value from public.remote_reviewed_results'),0);assert.equal(await query('select count(*)::integer as value from public.remote_result_deliveries'),0);});
  // Physical migration rollback is only tested in this disposable database.
  await probe('extension rollback preserves existing status-only foundation',async()=>{await db.exec(`drop function public.remote_result_device(uuid,text,uuid,text,jsonb);drop function public.remote_result_phone(uuid,uuid,text,jsonb);
   drop function public.remote_result_validate_policy(jsonb,public.remote_device_bindings,public.remote_jobs,public.remote_relay_grants);
   drop function public.remote_result_purge_expired();drop function public.remote_result_confirmed_phone(uuid);drop function public.remote_result_uuid(jsonb);drop function public.remote_result_canonical(jsonb);
   drop table public.remote_result_deliveries;drop table public.remote_reviewed_results;`);assert.equal(await query("select to_regclass('public.remote_jobs') is not null as value"),true);});
  evidence.status='passed';
 }catch(error){process.exitCode=1;evidence.failure={code:typeof error.code==='string'?error.code:'TEST_RUNTIME_ERROR',message:String(error.message).slice(0,500)};}
 finally{if(db)await db.close();await rm(temporary,{recursive:true,force:true});await mkdir(join(root,'artifacts'),{recursive:true});await writeFile(join(root,'artifacts/remote-results-sql-verification.json'),JSON.stringify(evidence,null,2)+'\n');}
 console.log(JSON.stringify({status:evidence.status,checks:evidence.checks.length,failure:evidence.failure,evidence:'artifacts/remote-results-sql-verification.json',live_supabase_verified:false,concurrent_sessions_verified:false}));
}
await main();

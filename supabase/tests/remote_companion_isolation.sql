-- Run only on a disposable Supabase database after migration 202610030003.
-- These synthetic assertions are NOT evidence until the SQL runner succeeds.
begin;
create extension if not exists pgtap with schema extensions;
set search_path=public,extensions;
set local timezone='UTC';
create temporary table remote_results(result text);
create temporary table remote_fixture(key text primary key,value jsonb);
grant select,insert on remote_results to authenticated,anon;
grant select,insert,update on remote_fixture to authenticated,anon;
insert into remote_results select plan(43);
insert into auth.users(id,email,email_confirmed_at) values
 ('11111111-1111-4111-8111-111111111111','remote-a@example.invalid',now()),
 ('22222222-2222-4222-8222-222222222222','remote-b@example.invalid',now());
insert into remote_fixture values('policy',jsonb_build_object('version','remote-study-foundation-1','destination','codex',
 'host_grant_id','99999999-9999-4999-8999-999999999999','selection_hash',repeat('b',64),
 'expires_at',to_char(now()+interval '30 minutes','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'max_requests',3,'max_request_bytes',16384,'recipes',jsonb_build_array('study.explain'),
 'relay_processing_confirmed',true,'plaintext_notice_confirmed',true,'retention_hours',24,'result_scope','status_only'));
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","session_id":"33333333-3333-4333-8333-333333333333"}',true);
insert into remote_fixture select 'challenge',public.remote_begin_pairing('33333333-3333-4333-8333-333333333333');
set local role anon;
insert into remote_fixture select 'binding',public.remote_confirm_pairing((value->>'pending_id')::uuid,value->>'challenge',
 '88888888-8888-4888-8888-888888888888',repeat('c',64),repeat('a',43),(select value from remote_fixture where key='policy')) from remote_fixture where key='challenge';
insert into remote_results select throws_ok($$select public.remote_confirm_pairing((value->>'pending_id')::uuid,value->>'challenge',
 '88888888-8888-4888-8888-888888888888',repeat('c',64),repeat('a',43),(select value from remote_fixture where key='policy')) from remote_fixture where key='challenge'$$,
 'P0001','REMOTE_PAIRING_DENIED','one-use pairing challenge cannot replay');
insert into remote_results select throws_ok($$select * from public.remote_device_bindings$$,'42501',null,'anonymous cannot read credentials or raw binding tables');
set local role authenticated;
insert into remote_fixture select 'duplicate_binding_challenge',public.remote_begin_pairing('33333333-3333-4333-8333-333333333333');
set local role anon;
insert into remote_results select throws_ok($$select public.remote_confirm_pairing((value->>'pending_id')::uuid,value->>'challenge',
 '88888888-8888-4888-8888-888888888888',repeat('c',64),repeat('d',43),(select value from remote_fixture where key='policy'))
 from remote_fixture where key='duplicate_binding_challenge'$$,'P0001','REMOTE_INSTANCE_IN_USE','one installation workspace cannot have two active bearer bindings');
reset role;
insert into remote_fixture select 'request',jsonb_build_object('schema_version',1,'binding_id',value->>'id','client_request_id','66666666-6666-4666-8666-666666666666',
 'recipe_id','study.explain','recipe_version','remote-study-foundation-1','prompt','Explain keys') from remote_fixture where key='binding';
insert into remote_fixture select 'request_hash',to_jsonb(public.remote_study_hash(value)) from remote_fixture where key='request';
insert into remote_fixture select 'changed_request',jsonb_set(value,'{prompt}','"Changed exact bytes"') from remote_fixture where key='request';
insert into remote_fixture select 'changed_hash',to_jsonb(public.remote_study_hash(value)) from remote_fixture where key='changed_request';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","session_id":"33333333-3333-4333-8333-333333333333"}',true);
insert into remote_results select is(jsonb_array_length(public.remote_phone_status('33333333-3333-4333-8333-333333333333',(value->>'id')::uuid)->'bindings'),1,'A sees only confirmed A binding') from remote_fixture where key='binding';
insert into remote_results select throws_ok($$select * from public.remote_jobs$$,'42501',null,'authenticated owner cannot read raw prompt rows directly');
select set_config('request.jwt.claims','{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","session_id":"44444444-4444-4444-8444-444444444444"}',true);
insert into remote_results select is(jsonb_array_length(public.remote_phone_status('44444444-4444-4444-8444-444444444444',(value->>'id')::uuid)->'bindings'),0,'B cannot list A binding') from remote_fixture where key='binding';
insert into remote_results select throws_ok($$select public.remote_submit_study('44444444-4444-4444-8444-444444444444',
 (select (value->>'id')::uuid from remote_fixture where key='binding'),(select value from remote_fixture where key='request'),(select value#>>'{}' from remote_fixture where key='request_hash'))$$,
 'P0001','REMOTE_CONSENT_REQUIRED','B cannot enqueue A job');
insert into remote_results select throws_ok($$select public.remote_phone_status('33333333-3333-4333-8333-333333333333',null)$$,
 'P0001','REMOTE_AUTH_REQUIRED','forged phone session fails JWT session binding');
select set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","session_id":"33333333-3333-4333-8333-333333333333"}',true);
insert into remote_results select throws_ok($$select public.remote_submit_study('33333333-3333-4333-8333-333333333333',
 (select (value->>'id')::uuid from remote_fixture where key='binding'),(select value from remote_fixture where key='request'),repeat('e',64))$$,
 'P0001','INVALID_REMOTE_INPUT','forged canonical hash cannot be retained');
insert into remote_results select throws_ok($$select public.remote_submit_study('33333333-3333-4333-8333-333333333333',
 (select (value->>'id')::uuid from remote_fixture where key='binding'),(select value||'{"command":"arbitrary shell"}'::jsonb from remote_fixture where key='request'),repeat('e',64))$$,
 'P0001','INVALID_REMOTE_INPUT','extra executable input cannot be retained');
insert into remote_results select throws_ok($$select public.remote_submit_study('33333333-3333-4333-8333-333333333333',
 (select (value->>'id')::uuid from remote_fixture where key='binding'),(select value||'{"client_request_id":null}'::jsonb from remote_fixture where key='request'),
 (select value#>>'{}' from remote_fixture where key='request_hash'))$$,'P0001','INVALID_REMOTE_INPUT','JSON null request identity fails before retention');
insert into remote_results select throws_ok($$select public.remote_submit_study('33333333-3333-4333-8333-333333333333',
 (select (value->>'id')::uuid from remote_fixture where key='binding'),(select value||jsonb_build_object('prompt',repeat(chr(128512),2001)) from remote_fixture where key='request'),
 (select value#>>'{}' from remote_fixture where key='request_hash'))$$,'P0001','INVALID_REMOTE_INPUT','astral prompt respects the same UTF-16 bound as JavaScript');
insert into remote_results select throws_ok($$select public.remote_submit_study('33333333-3333-4333-8333-333333333333',
 (select (value->>'id')::uuid from remote_fixture where key='binding'),(select value||jsonb_build_object('prompt',chr(160)||chr(65279)||chr(10)) from remote_fixture where key='request'),
 (select value#>>'{}' from remote_fixture where key='request_hash'))$$,'P0001','INVALID_REMOTE_INPUT','Unicode whitespace-only prompt is not retained');
insert into remote_fixture select 'job',public.remote_submit_study('33333333-3333-4333-8333-333333333333',(select (value->>'id')::uuid from remote_fixture where key='binding'),
 (select value from remote_fixture where key='request'),(select value#>>'{}' from remote_fixture where key='request_hash'));
insert into remote_results select is(value->>'state','queued','enqueue acknowledgement is queued, never completed') from remote_fixture where key='job';
insert into remote_results select is(public.remote_submit_study('33333333-3333-4333-8333-333333333333',(select (value->>'id')::uuid from remote_fixture where key='binding'),
 (select value from remote_fixture where key='request'),(select value#>>'{}' from remote_fixture where key='request_hash'))->>'id',(select value->>'id' from remote_fixture where key='job'),'canonical retry retains one job ID');
insert into remote_results select throws_ok($$select public.remote_submit_study('33333333-3333-4333-8333-333333333333',
 (select (value->>'id')::uuid from remote_fixture where key='binding'),(select value from remote_fixture where key='changed_request'),(select value#>>'{}' from remote_fixture where key='changed_hash'))$$,
 'P0001','REMOTE_ENVELOPE_CONFLICT','changed bytes with the same key conflict');
set local role anon;
insert into remote_fixture select 'lease',public.remote_device_operation((value->>'id')::uuid,repeat('a',43),'88888888-8888-4888-8888-888888888888','claim','{}') from remote_fixture where key='binding';
insert into remote_results select is(public.remote_device_operation((value->>'id')::uuid,repeat('a',43),'88888888-8888-4888-8888-888888888888','claim','{}')->>'lease_epoch',
 (select value->>'lease_epoch' from remote_fixture where key='lease'),'redelivery retains the current lease epoch') from remote_fixture where key='binding';
insert into remote_results select throws_ok($$select public.remote_device_operation((select (value->>'id')::uuid from remote_fixture where key='binding'),repeat('a',43),
 '88888888-8888-4888-8888-888888888888','accept',jsonb_build_object('job_id',(select value->>'id' from remote_fixture where key='job'),
 'lease_epoch',0,'sequence',1,'local_run_ref','77777777-7777-4777-8777-777777777777','state','local_accepted'))$$,
 'P0001','REMOTE_LEASE_DENIED','stale lease cannot accept local execution');
insert into remote_fixture select 'accept_payload',jsonb_build_object('job_id',value->>'id','lease_epoch',1,'sequence',1,'local_run_ref','77777777-7777-4777-8777-777777777777','state','local_accepted') from remote_fixture where key='job';
insert into remote_results select throws_ok(format($$select public.remote_device_operation((select (value->>'id')::uuid from remote_fixture where key='binding'),repeat('a',43),
 '88888888-8888-4888-8888-888888888888','accept',(select value||%L::jsonb from remote_fixture where key='accept_payload'))$$,bad.patch),
 'P0001','INVALID_REMOTE_INPUT',bad.description)
 from(values('{"lease_epoch":null}','JSON null epoch cannot bypass SQL equality'),('{"lease_epoch":"1"}','string epoch is not a numeric lease'),
 ('{"sequence":null}','JSON null sequence is rejected'),('{"sequence":1.5}','fractional sequence is rejected'),
 ('{"sequence":9007199254740992}','unsafe integer sequence is rejected')) as bad(patch,description);
insert into remote_results select is(public.remote_device_operation((select (value->>'id')::uuid from remote_fixture where key='binding'),repeat('a',43),
 '88888888-8888-4888-8888-888888888888','accept',(select value from remote_fixture where key='accept_payload'))->>'state','local_accepted','local acceptance is separate from completion');
insert into remote_results select is(public.remote_device_operation((select (value->>'id')::uuid from remote_fixture where key='binding'),repeat('a',43),
 '88888888-8888-4888-8888-888888888888','accept',(select value from remote_fixture where key='accept_payload'))->>'status','duplicate','exact event replay does not create another event');
insert into remote_results select throws_ok($$select public.remote_device_operation((select (value->>'id')::uuid from remote_fixture where key='binding'),repeat('a',43),
 '88888888-8888-4888-8888-888888888888','state',(select value||'{"sequence":2,"state":"completed"}'::jsonb from remote_fixture where key='accept_payload'))$$,
 'P0001','INVALID_REMOTE_INPUT','status-only device cannot fabricate completion');
select public.remote_device_operation((select (value->>'id')::uuid from remote_fixture where key='binding'),repeat('a',43),
 '88888888-8888-4888-8888-888888888888','state',(select value||'{"sequence":2,"state":"awaiting_student"}'::jsonb from remote_fixture where key='accept_payload'));
reset role;
update public.remote_jobs set lease_expires_at=now()-interval '2 minutes' where id=(select (value->>'id')::uuid from remote_fixture where key='job');
set local role anon;
insert into remote_fixture select 'status_lease',public.remote_device_operation((value->>'id')::uuid,repeat('a',43),
 '88888888-8888-4888-8888-888888888888','claim','{}') from remote_fixture where key='binding';
insert into remote_results select ok(value->>'state'='awaiting_student' and (value->>'lease_epoch')::integer=2
 and value->>'local_run_ref'='77777777-7777-4777-8777-777777777777','expired status lease renews control only and retains the accepted run') from remote_fixture where key='status_lease';
insert into remote_results select throws_ok($$select public.remote_device_operation((select (value->>'id')::uuid from remote_fixture where key='binding'),repeat('a',43),
 '88888888-8888-4888-8888-888888888888','state',(select value||'{"sequence":2,"state":"awaiting_student"}'::jsonb from remote_fixture where key='accept_payload'))$$,
 'P0001','REMOTE_LEASE_DENIED','old control epoch cannot replay after lease renewal');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","session_id":"33333333-3333-4333-8333-333333333333"}',true);
select public.remote_phone_control('33333333-3333-4333-8333-333333333333',(select (value->>'id')::uuid from remote_fixture where key='binding'),'cancel',(select (value->>'id')::uuid from remote_fixture where key='job'));
insert into remote_results select is((public.remote_phone_status('33333333-3333-4333-8333-333333333333',(select (value->>'id')::uuid from remote_fixture where key='binding'))->'jobs'->0)->>'state','cancel_requested','phone cancellation persists until local acknowledgement');
insert into remote_results select ok((public.remote_phone_control('33333333-3333-4333-8333-333333333333',
 (select (value->>'id')::uuid from remote_fixture where key='binding'),'cancel',(select (value->>'id')::uuid from remote_fixture where key='job'))->>'duplicate')::boolean,
 'cancellation retry while acknowledgment is pending is idempotent');
reset role;
update public.remote_jobs set lease_expires_at=now()-interval '2 minutes' where id=(select (value->>'id')::uuid from remote_fixture where key='job');
set local role anon;
insert into remote_fixture select 'cancel_lease',public.remote_device_operation((value->>'id')::uuid,repeat('a',43),
 '88888888-8888-4888-8888-888888888888','claim','{}') from remote_fixture where key='binding';
insert into remote_results select ok(value->>'state'='cancel_requested' and (value->>'lease_epoch')::integer=3,
 'expired cancellation lease renews control without a fresh execution') from remote_fixture where key='cancel_lease';
insert into remote_results select is(public.remote_device_operation((select (value->>'id')::uuid from remote_fixture where key='binding'),repeat('a',43),
 '88888888-8888-4888-8888-888888888888','state',(select value||'{"lease_epoch":3,"sequence":3,"state":"cancelled"}'::jsonb from remote_fixture where key='accept_payload'))->>'state',
 'cancelled','renewed cancellation can be acknowledged without redispatch');
set local role authenticated;
insert into remote_results select ok((public.remote_phone_control('33333333-3333-4333-8333-333333333333',
 (select (value->>'id')::uuid from remote_fixture where key='binding'),'cancel',(select (value->>'id')::uuid from remote_fixture where key='job'))->>'cancellation_acknowledged')::boolean,
 'cancellation retry after acknowledgment preserves the acknowledged outcome');
reset role;
insert into remote_fixture select 'unpair_request',value||'{"client_request_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","prompt":"UNPAIR_PROMPT_CANARY"}'::jsonb from remote_fixture where key='request';
insert into remote_fixture select 'unpair_hash',to_jsonb(public.remote_study_hash(value)) from remote_fixture where key='unpair_request';
set local role authenticated;
insert into remote_fixture select 'unpair_job',public.remote_submit_study('33333333-3333-4333-8333-333333333333',
 (select (value->>'id')::uuid from remote_fixture where key='binding'),(select value from remote_fixture where key='unpair_request'),(select value#>>'{}' from remote_fixture where key='unpair_hash'));
set local role anon;
select public.remote_device_operation((select (value->>'id')::uuid from remote_fixture where key='binding'),repeat('a',43),'88888888-8888-4888-8888-888888888888','claim','{}');
select public.remote_device_operation((select (value->>'id')::uuid from remote_fixture where key='binding'),repeat('a',43),'88888888-8888-4888-8888-888888888888','accept',
 jsonb_build_object('job_id',(select value->>'id' from remote_fixture where key='unpair_job'),'lease_epoch',1,'sequence',1,'local_run_ref','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','state','local_accepted'));
set local role authenticated;
insert into remote_results select throws_ok($$select public.remote_phone_control('33333333-3333-4333-8333-333333333333',
 (select (value->>'id')::uuid from remote_fixture where key='binding'),'delete',(select (value->>'id')::uuid from remote_fixture where key='unpair_job'))$$,
 'P0001','REMOTE_CANCEL_FIRST','active accepted request cannot be silently erased before stop or revocation');
select set_config('request.jwt.claims','{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","session_id":"44444444-4444-4444-8444-444444444444"}',true);
select public.remote_phone_recover('44444444-4444-4444-8444-444444444444');
insert into remote_results select throws_ok($$select public.remote_phone_control('44444444-4444-4444-8444-444444444444',
 (select (value->>'id')::uuid from remote_fixture where key='binding'),'delete',(select (value->>'id')::uuid from remote_fixture where key='unpair_job'))$$,
 'P0001','REMOTE_AUTH_REQUIRED','B cannot erase an A prompt or its delivery tombstone');
reset role;
insert into remote_results select is((select state from public.remote_device_bindings where id=(select (value->>'id')::uuid from remote_fixture where key='binding')),
 'active','B recovery cannot revoke A account binding');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","session_id":"55555555-5555-4555-8555-555555555555"}',true);
select public.remote_phone_recover('55555555-5555-4555-8555-555555555555');
insert into remote_fixture select 'prompt_erasure',public.remote_phone_control('55555555-5555-4555-8555-555555555555',
 (select (value->>'id')::uuid from remote_fixture where key='binding'),'delete',(select (value->>'id')::uuid from remote_fixture where key='unpair_job'));
insert into remote_results select ok((value->>'prompt_erased')::boolean and not (value->>'cancellation_acknowledged')::boolean and value->>'delivery_state'='cancel_requested',
 'fresh owner session erases revoked-device prompt without claiming stop delivery') from remote_fixture where key='prompt_erasure';
insert into remote_results select ok((public.remote_phone_control('55555555-5555-4555-8555-555555555555',
 (select (value->>'id')::uuid from remote_fixture where key='binding'),'delete',(select (value->>'id')::uuid from remote_fixture where key='unpair_job'))->>'duplicate')::boolean,
 'repeated prompt erasure preserves the delivery tombstone');
reset role;
insert into remote_results select ok(request is null and state='cancel_requested' and local_run_ref='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
 'erasure removes actual prompt bytes and retains unacknowledged state/run ownership') from public.remote_jobs where id=(select (value->>'id')::uuid from remote_fixture where key='unpair_job');
insert into remote_results select is((select state from public.remote_device_bindings where id=(select (value->>'id')::uuid from remote_fixture where key='binding')),
 'revoked','fresh A session revokes old A session bindings without exposing content');
set local role authenticated;
insert into remote_fixture select 'replacement_challenge',public.remote_begin_pairing('55555555-5555-4555-8555-555555555555');
set local role anon;
insert into remote_fixture select 'replacement_binding',public.remote_confirm_pairing((value->>'pending_id')::uuid,value->>'challenge',
 '88888888-8888-4888-8888-888888888888',repeat('c',64),repeat('b',43),(select value from remote_fixture where key='policy')) from remote_fixture where key='replacement_challenge';
reset role;
insert into remote_results select is((select count(*)::integer from public.remote_device_bindings where installation_instance_id='88888888-8888-4888-8888-888888888888'
 and workspace_ref=repeat('c',64) and state='active'),1,'explicit recovery permits one fresh binding and leaves the old bearer revoked');
set local role anon;
insert into remote_results select throws_ok($$select public.remote_device_operation((select (value->>'id')::uuid from remote_fixture where key='binding'),repeat('a',43),
 '88888888-8888-4888-8888-888888888888','claim','{}')$$,'P0001','REMOTE_DEVICE_DENIED','revoked credential cannot claim or upload');
reset role;
update public.remote_jobs set created_at=now()-interval '25 hours';
select public.remote_purge_expired();
insert into remote_results select is((select count(*)::integer from public.remote_jobs),0,'declared retention purge removes prompt rows and cascades event rows');
insert into remote_results select * from finish();
select result from remote_results;
rollback;

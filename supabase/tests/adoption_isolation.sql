-- Run after both migrations on a DISPOSABLE Supabase/Postgres project.
-- Transaction rollback keeps these synthetic accounts/events out of real data.
-- Executed with synthetic auth in disposable PGlite; live Supabase is unverified.
begin;
create extension if not exists pgtap with schema extensions;
set search_path=public,extensions;
create temporary table adoption_results(result text);
grant select,insert on adoption_results to anon,authenticated;
insert into adoption_results select plan(25);
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 ('33333333-3333-4333-8333-333333333333','adoption-admin@example.invalid',now(),'{"full_name":"Synthetic admin"}'),
 ('44444444-4444-4444-8444-444444444444','adoption-student@example.invalid',now(),'{"full_name":"Synthetic student"}'),
 ('66666666-6666-4666-8666-666666666666','adoption-unconfirmed@example.invalid',null,'{}');
insert into public.adoption_admins(user_id) values('33333333-3333-4333-8333-333333333333');
insert into public.student_state(user_id,kind,value,revision,updated_at) values('44444444-4444-4444-8444-444444444444','tasks','[]',1,now());
set local role anon;
insert into adoption_results select throws_ok('select * from public.adoption_public_events','42501',null,'anon cannot read raw public events');
insert into adoption_results select is(public.adoption_collect_public('55555555-5555-4555-8555-555555555555','setup_prompt_copy_succeeded','local-setup-1-2026-10-03','public-setup-metrics-1')->>'status','accepted','narrow valid opted-in event accepted');
insert into adoption_results select is(public.adoption_collect_public('55555555-5555-4555-8555-555555555555','setup_prompt_copy_succeeded','local-setup-1-2026-10-03','public-setup-metrics-1')->>'status','duplicate','same event ID retry is not counted again');
insert into adoption_results select is(public.adoption_collect_public('55555555-5555-4555-8555-555555555555','setup_page_view','local-setup-1-2026-10-03','public-setup-metrics-1')->>'status','conflict','event ID cannot change payload');
insert into adoption_results select throws_ok('select public.adoption_admin_report(current_date,current_date)','42501',null,'anon cannot call owner aggregate RPC');
insert into adoption_results select throws_ok('select public.adoption_get_enrollment()','42501',null,'anon cannot read enrollment settings');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','66666666-6666-4666-8666-666666666666',true);
insert into adoption_results select throws_ok('select public.adoption_set_enrollment(0,true,false,''public-setup-metrics-1'')','P0001','AUTH_REQUIRED','unconfirmed account cannot enroll reporting');
insert into adoption_results select is(public.adoption_record_state_activity('tasks',1),false,'unconfirmed account cannot record identity activity');
select set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',true);
insert into adoption_results select throws_ok('select * from public.adoption_enrollments','42501',null,'ordinary account cannot read raw identities');
insert into adoption_results select is(public.adoption_get_enrollment()->>'revision','0','own initial settings default off');
insert into adoption_results select is(public.adoption_set_enrollment(0,true,false,'public-setup-metrics-1')->>'directory_enabled','false','account counting does not grant directory access');
insert into adoption_results select throws_ok('select public.adoption_set_enrollment(0,true,true,''public-setup-metrics-1'')','P0001','REVISION_CONFLICT','stale settings cannot broaden directory sharing');
insert into adoption_results select is(public.adoption_is_admin(),false,'ordinary account cannot become admin');
insert into adoption_results select throws_ok('select public.adoption_admin_report(current_date,current_date)','P0001','ADMIN_REQUIRED','ordinary signed-in account cannot query aggregates');
insert into adoption_results select is(public.adoption_record_state_activity('tasks',999),false,'client cannot invent a successful saved revision');
insert into adoption_results select is(public.adoption_record_state_activity('tasks',1),true,'actual recent own state save counted once');
insert into adoption_results select is(public.adoption_record_state_activity('tasks',1),false,'same successful save retry not counted again');
insert into adoption_results select is(public.adoption_set_enrollment(1,true,true,'public-setup-metrics-1')->>'revision','2','directory sharing needs a separate current-revision choice');
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
insert into adoption_results select is(public.adoption_get_enrollment()->>'revision','0','student B cannot write account A settings');
insert into adoption_results select is((public.adoption_admin_report((now() at time zone 'UTC')::date,(now() at time zone 'UTC')::date)->>'successful_prompt_copies')::integer,1,'authorized admin sees exact deduplicated copy count');
insert into adoption_results select is(jsonb_array_length(public.adoption_admin_directory()),1,'directory contains only explicitly selected student');
insert into adoption_results select ok(public.adoption_admin_report(current_date,current_date)::text not like '%example.invalid%','aggregate report has no name or email');
select set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',true);
select public.adoption_set_enrollment(2,false,false,'public-setup-metrics-1');
insert into adoption_results select is(public.adoption_record_state_activity('tasks',1),false,'own activity cannot be reinserted after reporting opt-out');
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
insert into adoption_results select is(jsonb_array_length(public.adoption_admin_directory()),0,'opt-out removes future directory access immediately');
reset role;
update auth.users set email_confirmed_at=null where id='33333333-3333-4333-8333-333333333333';
set local role authenticated;
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
insert into adoption_results select is(public.adoption_is_admin(),false,'unconfirmed account cannot retain admin access');
insert into adoption_results select * from finish();
select result from adoption_results;
rollback;

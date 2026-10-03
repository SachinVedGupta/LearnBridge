-- Disposable PostgreSQL only; synthetic records and rollback. No scheduling or
-- multi-session race proof. now() is fixed for this transaction's boundary tests.
begin;
create extension if not exists pgtap with schema extensions;
set search_path=public,extensions;
set local timezone='UTC';
create temporary table adoption_bounds_results(result text);
grant select,insert on adoption_bounds_results to anon,authenticated,service_role;
insert into adoption_bounds_results select plan(12);
-- Seed capacity directly as the test owner, never through a production route.
insert into public.adoption_public_events(event_id,event_name,prompt_version,consent_version,received_at)
select gen_random_uuid(),'setup_page_view','local-setup-1-2026-10-03','public-setup-metrics-1',now()-interval '2 minutes' from generate_series(1,10000);
set local role anon;
insert into adoption_bounds_results select is(public.adoption_collect_public('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','setup_prompt_copy_succeeded','local-setup-1-2026-10-03','public-setup-metrics-1')->>'status','quota_paused','retained raw capacity pauses instead of claiming accepted');
reset role;
insert into adoption_bounds_results select is((select count(*)::integer from public.adoption_public_events),10000,'quota rejection creates no extra raw row');
insert into adoption_bounds_results select is((select quota_rejections::integer from public.adoption_daily_counts),1,'database quota loss is visible in coverage');
delete from public.adoption_public_events;
delete from public.adoption_daily_counts;
set local role anon;
select public.adoption_collect_public(gen_random_uuid(),'setup_page_view','local-setup-1-2026-10-03','public-setup-metrics-1') from generate_series(1,120);
insert into adoption_bounds_results select is(public.adoption_collect_public('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','setup_page_view','local-setup-1-2026-10-03','public-setup-metrics-1')->>'status','rate_limited','global rolling-minute cap refuses the 121st accepted observation');
reset role;
insert into adoption_bounds_results select is((select count(*)::integer from public.adoption_public_events),120,'rate-limited event does not occupy raw storage');
insert into adoption_bounds_results select is((select page_views::integer from public.adoption_daily_counts),120,'only accepted observations increment aggregate views');
insert into adoption_bounds_results select is((select rate_rejections::integer from public.adoption_daily_counts),1,'rate loss is separately visible');
delete from public.adoption_public_events;
delete from public.adoption_daily_counts;
insert into auth.users(id,email,email_confirmed_at) values('77777777-7777-4777-8777-777777777777','retention-fixture@example.invalid',now());
insert into public.adoption_enrollments(user_id,enabled,directory_enabled,consent_version) values('77777777-7777-4777-8777-777777777777',true,false,'public-setup-metrics-1');
insert into public.adoption_public_events(event_id,event_name,prompt_version,consent_version,received_at) values
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','setup_page_view','local-setup-1-2026-10-03','public-setup-metrics-1',now()-interval '30 days 1 second'),
 ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','setup_page_view','local-setup-1-2026-10-03','public-setup-metrics-1',now()-interval '29 days');
insert into public.adoption_account_activity(user_id,kind,state_revision,received_at) values
 ('77777777-7777-4777-8777-777777777777','tasks',1,now()-interval '30 days 1 second'),
 ('77777777-7777-4777-8777-777777777777','tasks',2,now()-interval '29 days');
insert into public.adoption_daily_counts(day,prompt_version,page_views) values
 ((now()-interval '12 months 1 day')::date,'local-setup-1-2026-10-03',1),
 ((now()-interval '11 months')::date,'local-setup-1-2026-10-03',1);
set local role authenticated;
insert into adoption_bounds_results select throws_ok('select public.adoption_purge_retention()','42501',null,'ordinary authenticated user cannot invoke service-owner retention cleanup');
set local role service_role;
select public.adoption_purge_retention();
reset role;
insert into adoption_bounds_results select is((select count(*)::integer from public.adoption_public_events),1,'actual fixed retention cleanup removes expired raw observations');
insert into adoption_bounds_results select is((select count(*)::integer from public.adoption_account_activity),1,'expired raw account associations are removed');
insert into adoption_bounds_results select is((select count(*)::integer from public.adoption_daily_counts),1,'older-than-twelve-month aggregates are removed');
insert into adoption_bounds_results select is((select count(*)::integer from public.adoption_enrollments),1,'private consent settings retain their separately disclosed lifecycle');
insert into adoption_bounds_results select * from finish();
select result from adoption_bounds_results;
rollback;

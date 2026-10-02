begin;
create extension if not exists pgtap with schema extensions;
set search_path=public,extensions;
create temporary table isolation_results (result text);
grant select,insert on isolation_results to authenticated;
insert into isolation_results select plan(5);
insert into auth.users(id,email) values
 ('11111111-1111-4111-8111-111111111111','isolation-a@example.invalid'),
 ('22222222-2222-4222-8222-222222222222','isolation-b@example.invalid');
insert into public.student_state(user_id,kind,value) values
 ('11111111-1111-4111-8111-111111111111','tasks','[]'),
 ('22222222-2222-4222-8222-222222222222','tasks','[]');
set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
insert into isolation_results select is((select count(*)::integer from public.student_state),1,'A sees only A state');
with changed as (update public.student_state set value='[1]' where user_id='22222222-2222-4222-8222-222222222222' returning *) insert into isolation_results select is(count(*)::integer,0,'A cannot update B') from changed;
with removed as (delete from public.student_state where user_id='22222222-2222-4222-8222-222222222222' returning *) insert into isolation_results select is(count(*)::integer,0,'A cannot delete B') from removed;
insert into isolation_results select throws_ok($$insert into public.student_state(user_id,kind,value) values('22222222-2222-4222-8222-222222222222','draft','{}')$$,'42501',null,'A cannot insert B state');
insert into isolation_results select is(public.consume_usage('unknown'),false,'unknown quota categories denied');
insert into isolation_results select * from finish();
select result from isolation_results;
rollback;

-- Optional adoption measurement. Deploying this schema does NOT enable collection.
-- Next/browser flags default off; no names, email, URLs or content in anonymous rows.
begin;
create table public.adoption_public_events (
 event_id uuid primary key check (substr(event_id::text,15,1)='4'),
 event_name text not null check (event_name in ('setup_page_view','setup_prompt_copy_succeeded','setup_prompt_copy_failed')),
 route text not null default '/setup' check (route='/setup'),
 prompt_version text not null check (prompt_version='local-setup-1-2026-10-03'),
 consent_version text not null check (consent_version='public-setup-metrics-1'),
 received_at timestamptz not null default now()
);
create index adoption_public_received on public.adoption_public_events(received_at);
create table public.adoption_daily_counts (
 day date not null, prompt_version text not null,
 page_views bigint not null default 0, copy_successes bigint not null default 0,
 copy_failures bigint not null default 0, quota_rejections bigint not null default 0,
 rate_rejections bigint not null default 0, hosted_save_operations bigint not null default 0,
 primary key(day,prompt_version),
 check (prompt_version='local-setup-1-2026-10-03'),
 check (least(page_views,copy_successes,copy_failures,quota_rejections,rate_rejections,hosted_save_operations)>=0)
);
create table public.adoption_enrollments (
 user_id uuid primary key references auth.users(id) on delete cascade,
 revision bigint not null default 1 check (revision>=1),
 enabled boolean not null, directory_enabled boolean not null,
 consent_version text not null check (consent_version='public-setup-metrics-1'),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check (not directory_enabled or enabled)
);
create table public.adoption_account_activity (
 user_id uuid not null references auth.users(id) on delete cascade,
 kind text not null check (kind in ('tasks','draft')), state_revision bigint not null check (state_revision>=1),
 received_at timestamptz not null default now(), primary key(user_id,kind,state_revision)
);
create index adoption_activity_received on public.adoption_account_activity(received_at);
create table public.adoption_admins (
 user_id uuid primary key references auth.users(id) on delete cascade
);
-- No public or ordinary-user table policies/grants, including raw identity data.
alter table public.adoption_public_events enable row level security;
alter table public.adoption_daily_counts enable row level security;
alter table public.adoption_enrollments enable row level security;
alter table public.adoption_account_activity enable row level security;
alter table public.adoption_admins enable row level security;
revoke all on public.adoption_public_events,public.adoption_daily_counts,public.adoption_enrollments,public.adoption_account_activity,public.adoption_admins from public,anon,authenticated;

create function public.adoption_is_admin() returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and exists(select 1 from public.adoption_admins a join auth.users u on u.id=a.user_id where a.user_id=auth.uid() and u.email_confirmed_at is not null);
$$;
revoke all on function public.adoption_is_admin() from public,anon;
grant execute on function public.adoption_is_admin() to authenticated;

create function public.adoption_collect_public(p_event_id uuid,p_event_name text,p_prompt_version text,p_consent_version text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare existing public.adoption_public_events; v_now timestamptz:=now(); v_day date:=(now() at time zone 'UTC')::date;
begin
 if p_event_id is null or substr(p_event_id::text,15,1)<>'4' or p_event_name is null or p_event_name not in ('setup_page_view','setup_prompt_copy_succeeded','setup_prompt_copy_failed') or p_prompt_version is distinct from 'local-setup-1-2026-10-03' or p_consent_version is distinct from 'public-setup-metrics-1' then raise exception 'INVALID_EVENT'; end if;
 -- A global transaction lock bounds storage across independent server instances.
 perform pg_catalog.pg_advisory_xact_lock(298327491);
 delete from public.adoption_public_events where received_at<v_now-interval '30 days';
 delete from public.adoption_account_activity where received_at<v_now-interval '30 days';
 delete from public.adoption_daily_counts where day<(v_now-interval '12 months')::date;
 select * into existing from public.adoption_public_events where event_id=p_event_id;
 if found then
  if existing.event_name=p_event_name and existing.prompt_version=p_prompt_version and existing.consent_version=p_consent_version then return jsonb_build_object('status','duplicate'); end if;
  return jsonb_build_object('status','conflict');
 end if;
 if (select count(*) from public.adoption_public_events where received_at>=v_now-interval '1 minute')>=120 then
  insert into public.adoption_daily_counts(day,prompt_version,rate_rejections) values(v_day,p_prompt_version,1) on conflict(day,prompt_version) do update set rate_rejections=adoption_daily_counts.rate_rejections+1;
  return jsonb_build_object('status','rate_limited');
 end if;
 if (select count(*) from public.adoption_public_events)>=10000 then
  insert into public.adoption_daily_counts(day,prompt_version,quota_rejections) values(v_day,p_prompt_version,1) on conflict(day,prompt_version) do update set quota_rejections=adoption_daily_counts.quota_rejections+1;
  return jsonb_build_object('status','quota_paused');
 end if;
 insert into public.adoption_public_events(event_id,event_name,prompt_version,consent_version,received_at) values(p_event_id,p_event_name,p_prompt_version,p_consent_version,v_now);
 insert into public.adoption_daily_counts(day,prompt_version,page_views,copy_successes,copy_failures) values(v_day,p_prompt_version,(p_event_name='setup_page_view')::int,(p_event_name='setup_prompt_copy_succeeded')::int,(p_event_name='setup_prompt_copy_failed')::int)
 on conflict(day,prompt_version) do update set page_views=adoption_daily_counts.page_views+excluded.page_views,copy_successes=adoption_daily_counts.copy_successes+excluded.copy_successes,copy_failures=adoption_daily_counts.copy_failures+excluded.copy_failures;
 return jsonb_build_object('status','accepted');
end; $$;
revoke all on function public.adoption_collect_public(uuid,text,text,text) from public;
grant execute on function public.adoption_collect_public(uuid,text,text,text) to anon,authenticated;

create function public.adoption_get_enrollment() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_enrollment public.adoption_enrollments;
begin
 if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
 select * into v_enrollment from public.adoption_enrollments where user_id=auth.uid();
 if not found then return jsonb_build_object('revision',0,'enabled',false,'directory_enabled',false,'consent_version','public-setup-metrics-1'); end if;
 return jsonb_build_object('revision',v_enrollment.revision,'enabled',v_enrollment.enabled,'directory_enabled',v_enrollment.directory_enabled,'consent_version',v_enrollment.consent_version);
end; $$;
create function public.adoption_set_enrollment(p_revision bigint,p_enabled boolean,p_directory_enabled boolean,p_consent_version text) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_enrollment public.adoption_enrollments;
begin
 if auth.uid() is null or not exists(select 1 from auth.users u where u.id=auth.uid() and u.email_confirmed_at is not null) then raise exception 'AUTH_REQUIRED'; end if;
 if p_revision is null or p_revision<0 or p_enabled is null or p_directory_enabled is null or (p_directory_enabled and not p_enabled) or p_consent_version is distinct from 'public-setup-metrics-1' then raise exception 'INVALID_ENROLLMENT'; end if;
 perform pg_catalog.pg_advisory_xact_lock(298327491);
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text,298327492));
 select * into v_enrollment from public.adoption_enrollments where user_id=auth.uid() for update;
 if (found and v_enrollment.revision<>p_revision) or (not found and p_revision<>0) then raise exception 'REVISION_CONFLICT'; end if;
 if p_revision=0 and (select count(*) from public.adoption_enrollments)>=10000 then raise exception 'QUOTA_PAUSED'; end if;
 insert into public.adoption_enrollments(user_id,revision,enabled,directory_enabled,consent_version) values(auth.uid(),p_revision+1,p_enabled,p_directory_enabled,p_consent_version)
 on conflict(user_id) do update set revision=excluded.revision,enabled=excluded.enabled,directory_enabled=excluded.directory_enabled,consent_version=excluded.consent_version,updated_at=now();
 if not p_enabled then delete from public.adoption_account_activity where user_id=auth.uid(); end if;
 return public.adoption_get_enrollment();
end; $$;
revoke all on function public.adoption_get_enrollment(),public.adoption_set_enrollment(bigint,boolean,boolean,text) from public,anon;
grant execute on function public.adoption_get_enrollment(),public.adoption_set_enrollment(bigint,boolean,boolean,text) to authenticated;

-- A client cannot create a successful operation just by sending a user ID or
-- boolean: the current own state/revision and a recent actual save must exist.
create function public.adoption_record_state_activity(p_kind text,p_revision bigint) returns boolean language plpgsql security definer set search_path='' as $$
declare inserted boolean:=false; v_day date:=(now() at time zone 'UTC')::date;
begin
 if auth.uid() is null or p_kind is null or p_kind not in ('tasks','draft') or p_revision is null or p_revision<1 then return false; end if;
 -- Take the same lock as opt-out BEFORE observing consent. Otherwise an
 -- in-flight save could reinsert identity activity after opt-out deleted it.
 perform pg_catalog.pg_advisory_xact_lock(298327491);
 if not exists(select 1 from auth.users u where u.id=auth.uid() and u.email_confirmed_at is not null) then return false; end if;
 if not exists(select 1 from public.adoption_enrollments e where e.user_id=auth.uid() and e.enabled) then return false; end if;
 if not exists(select 1 from public.student_state s where s.user_id=auth.uid() and s.kind=p_kind and s.revision=p_revision and s.updated_at>=now()-interval '5 minutes') then return false; end if;
 delete from public.adoption_account_activity where received_at<now()-interval '30 days';
 if (select count(*) from public.adoption_account_activity)>=10000 then return false; end if;
 insert into public.adoption_account_activity(user_id,kind,state_revision) values(auth.uid(),p_kind,p_revision) on conflict do nothing returning true into inserted;
 if inserted then
  insert into public.adoption_daily_counts(day,prompt_version,hosted_save_operations) values(v_day,'local-setup-1-2026-10-03',1) on conflict(day,prompt_version) do update set hosted_save_operations=adoption_daily_counts.hosted_save_operations+1;
 end if;
 return coalesce(inserted,false);
end; $$;
revoke all on function public.adoption_record_state_activity(text,bigint) from public,anon;
grant execute on function public.adoption_record_state_activity(text,bigint) to authenticated;

create function public.adoption_admin_report(p_start date,p_end date) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare counts record; enrolled bigint; active_accounts bigint;
begin
 if not public.adoption_is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
 if p_start is null or p_end is null or p_start>p_end or p_end-p_start>365 then raise exception 'INVALID_RANGE'; end if;
 select coalesce(sum(page_views),0) as views,coalesce(sum(copy_successes),0) as copies,coalesce(sum(copy_failures),0) as failures,coalesce(sum(rate_rejections),0) as rate_rejections,coalesce(sum(quota_rejections),0) as quota_rejections,coalesce(sum(hosted_save_operations),0) as saves into counts from public.adoption_daily_counts where day between p_start and p_end;
 select count(*) into enrolled from public.adoption_enrollments e join auth.users u on e.user_id=u.id where e.enabled and u.email_confirmed_at is not null and (e.created_at at time zone 'UTC')::date between p_start and p_end;
 if p_start>=(now() at time zone 'UTC')::date-29 then select count(distinct user_id) into active_accounts from public.adoption_account_activity where (received_at at time zone 'UTC')::date between p_start and p_end; else active_accounts:=null; end if;
 return jsonb_build_object('schema_version',1,'range',jsonb_build_object('start',p_start,'end',p_end,'timezone','UTC'),'observed_page_views',counts.views,'successful_prompt_copies',counts.copies,'failed_copy_observations',counts.failures,'opted_in_setup_account_enrollments',enrolled,'hosted_save_operations',counts.saves,'active_opted_in_hosted_accounts',active_accounts,'visitor_estimate',null,'setup_accounts_created',null,'local_activation_enrollments',null,'opt_in_weekly_active_installations',null,'coverage',jsonb_build_object('database_rate_rejections',counts.rate_rejections,'database_quota_rejections',counts.quota_rejections,'client_or_instance_drops','unknown','raw_days',30,'aggregate_months',12,'deduplication_days',30,'account_directory','separate_explicit_choice','local_reporting','off','person_count','not_measured'));
end; $$;
create function public.adoption_admin_directory() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not public.adoption_is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('account_id',u.id,'display_name',left(coalesce(u.raw_user_meta_data->>'full_name',u.raw_user_meta_data->>'name',''),120),'display_name_source','provider_or_user_supplied_not_verified_identity','verified_email',u.email,'email_confirmed',true,'consent_revision',e.revision)) from (select * from public.adoption_enrollments where enabled and directory_enabled order by user_id limit 100) e join auth.users u on u.id=e.user_id where u.email_confirmed_at is not null),'[]'::jsonb);
end; $$;
create function public.adoption_purge_retention() returns jsonb language plpgsql security definer set search_path='' as $$
declare events_removed bigint; activity_removed bigint; aggregates_removed bigint;
begin
 delete from public.adoption_public_events where received_at<now()-interval '30 days'; get diagnostics events_removed=row_count;
 delete from public.adoption_account_activity where received_at<now()-interval '30 days'; get diagnostics activity_removed=row_count;
 delete from public.adoption_daily_counts where day<(now()-interval '12 months')::date; get diagnostics aggregates_removed=row_count;
 return jsonb_build_object('events_removed',events_removed,'activity_removed',activity_removed,'aggregates_removed',aggregates_removed,'directory_settings','retained_privately_until_account_deletion_or_changed_consent','aggregate_limit','12 months');
end; $$;
revoke all on function public.adoption_purge_retention() from public,anon,authenticated;
grant execute on function public.adoption_purge_retention() to service_role;
create function public.adoption_admin_purge() returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not public.adoption_is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
 return public.adoption_purge_retention();
end; $$;
revoke all on function public.adoption_admin_report(date,date),public.adoption_admin_directory(),public.adoption_admin_purge() from public,anon;
grant execute on function public.adoption_admin_report(date,date),public.adoption_admin_directory(),public.adoption_admin_purge() to authenticated;
commit;

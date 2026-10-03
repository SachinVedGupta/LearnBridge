-- Optional, disabled remote-study protocol foundation. This migration is NOT applied by setup.
-- No native execution, text-result delivery, remote human task approval or telemetry is enabled.
begin;
create extension if not exists pgcrypto with schema extensions;
create table public.remote_pairing_challenges (
 id uuid primary key default gen_random_uuid(), account_id uuid not null references auth.users(id) on delete cascade,
 phone_session_ref uuid not null, challenge_hash text not null, created_at timestamptz not null default now(),
 expires_at timestamptz not null default now()+interval '5 minutes', consumed_at timestamptz
);
create table public.remote_device_bindings (
 id uuid primary key default gen_random_uuid(), account_id uuid not null references auth.users(id) on delete cascade,
 phone_session_ref uuid not null, installation_instance_id uuid not null, workspace_ref text not null check(workspace_ref ~ '^[a-f0-9]{64}$'),
 credential_hash text not null check(credential_hash ~ '^[a-f0-9]{64}$'), revision bigint not null default 1,
 state text not null default 'active' check(state in ('active','revoked')), created_at timestamptz not null default now(), last_seen_at timestamptz,
 revoked_at timestamptz
);
create table public.remote_relay_grants (
 id uuid primary key default gen_random_uuid(), binding_id uuid not null unique references public.remote_device_bindings(id) on delete cascade,
 policy jsonb not null, expires_at timestamptz not null, state text not null default 'active' check(state in ('active','revoked')),
 used_requests integer not null default 0, used_bytes bigint not null default 0,
 check(octet_length(policy::text)<=4096), check(used_requests between 0 and 3), check(used_bytes between 0 and 49152)
);
-- A restarted process must first revoke/recover the old binding or wait for
-- policy expiry. Separate bearer bindings cannot run this workspace in parallel.
create unique index remote_one_active_installation_workspace
 on public.remote_device_bindings(installation_instance_id,workspace_ref) where state='active';
create table public.remote_jobs (
 id uuid primary key default gen_random_uuid(), binding_id uuid not null references public.remote_device_bindings(id) on delete cascade,
 account_id uuid not null references auth.users(id) on delete cascade, client_request_id uuid not null,
 request jsonb, input_hash text not null check(input_hash ~ '^[a-f0-9]{64}$'),
 state text not null default 'queued' check(state in ('queued','leased','local_accepted','awaiting_student','cancel_requested','cancelled','failed','unknown_outcome','expired')),
 created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '15 minutes',
 lease_epoch bigint not null default 0, lease_expires_at timestamptz, local_run_ref uuid, sequence bigint not null default 0,
 unique(binding_id,client_request_id), check(request is null or octet_length(request::text)<=16384)
);
create table public.remote_delivery_events (
 job_id uuid not null references public.remote_jobs(id) on delete cascade, sequence bigint not null, lease_epoch bigint not null,
 state text not null, local_run_ref uuid, received_at timestamptz not null default now(), primary key(job_id,sequence)
);
alter table public.remote_pairing_challenges enable row level security;
alter table public.remote_device_bindings enable row level security;
alter table public.remote_relay_grants enable row level security;
alter table public.remote_jobs enable row level security;
alter table public.remote_delivery_events enable row level security;
-- RPCs are the only surface; even owners cannot select raw verifier/prompt rows.
revoke all on public.remote_pairing_challenges,public.remote_device_bindings,public.remote_relay_grants,public.remote_jobs,public.remote_delivery_events from public,anon,authenticated;

create function public.remote_confirmed_phone(p_session uuid) returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and p_session::text=auth.jwt()->>'session_id'
 and exists(select 1 from auth.users u where u.id=auth.uid() and u.email_confirmed_at is not null);
$$;
revoke all on function public.remote_confirmed_phone(uuid) from public,anon,authenticated;

create function public.remote_begin_pairing(p_phone_session uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare code text; challenge public.remote_pairing_challenges;
begin
 if not public.remote_confirmed_phone(p_phone_session) then raise exception 'REMOTE_AUTH_REQUIRED'; end if;
 perform pg_catalog.pg_advisory_xact_lock(298327493);
 delete from public.remote_pairing_challenges where expires_at<now();
 if (select count(*) from public.remote_pairing_challenges where account_id=auth.uid() and consumed_at is null)>=3
 or (select count(*) from public.remote_pairing_challenges)>=1000 then raise exception 'REMOTE_RATE_LIMITED'; end if;
 code:=encode(extensions.gen_random_bytes(16),'hex');
 insert into public.remote_pairing_challenges(account_id,phone_session_ref,challenge_hash)
 values(auth.uid(),p_phone_session,encode(extensions.digest(code,'sha256'),'hex')) returning * into challenge;
 return jsonb_build_object('pending_id',challenge.id,'challenge',code,'expires_at',challenge.expires_at,'version','remote-study-foundation-1');
end; $$;

create function public.remote_confirm_pairing(p_pending_id uuid,p_challenge text,p_instance uuid,p_workspace_ref text,p_token text,p_policy jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare challenge public.remote_pairing_challenges; binding public.remote_device_bindings; expiry timestamptz;
begin
 if p_challenge is null or p_challenge !~ '^[a-f0-9]{32}$' or p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$'
 or p_workspace_ref is null or p_workspace_ref !~ '^[a-f0-9]{64}$' or p_instance is null then raise exception 'REMOTE_PAIRING_DENIED'; end if;
 -- Serialize confirmations with challenge creation. Distinct challenge rows
 -- alone do not protect the shared per-account/global binding limits.
 perform pg_catalog.pg_advisory_xact_lock(298327493);
 select * into challenge from public.remote_pairing_challenges where id=p_pending_id for update;
 if not found or challenge.consumed_at is not null or challenge.expires_at<=now()
 or challenge.challenge_hash<>encode(extensions.digest(p_challenge,'sha256'),'hex') then raise exception 'REMOTE_PAIRING_DENIED'; end if;
 if p_policy is null or jsonb_typeof(p_policy)<>'object' or octet_length(p_policy::text)>4096
 or not p_policy ?& array['version','destination','host_grant_id','selection_hash','expires_at','max_requests','max_request_bytes','recipes','relay_processing_confirmed','plaintext_notice_confirmed','retention_hours','result_scope']
 or p_policy-array['version','destination','host_grant_id','selection_hash','expires_at','max_requests','max_request_bytes','recipes','relay_processing_confirmed','plaintext_notice_confirmed','retention_hours','result_scope']<>'{}'::jsonb
 or p_policy->>'version' is distinct from 'remote-study-foundation-1' or p_policy->>'destination' is distinct from 'codex'
 or jsonb_typeof(p_policy->'host_grant_id') is distinct from 'string' or jsonb_typeof(p_policy->'expires_at') is distinct from 'string'
 or jsonb_typeof(p_policy->'selection_hash') is distinct from 'string' or p_policy->>'selection_hash' !~ '^[a-f0-9]{64}$'
 or p_policy->'recipes' is distinct from '["study.explain"]'::jsonb or p_policy->'relay_processing_confirmed' is distinct from 'true'::jsonb
 or p_policy->'plaintext_notice_confirmed' is distinct from 'true'::jsonb or p_policy->'retention_hours' is distinct from '24'::jsonb
 or p_policy->>'result_scope' is distinct from 'status_only' or jsonb_typeof(p_policy->'max_requests') is distinct from 'number'
 or jsonb_typeof(p_policy->'max_request_bytes') is distinct from 'number' then raise exception 'REMOTE_CONSENT_REQUIRED'; end if;
 if p_policy->>'host_grant_id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
 or p_policy->>'expires_at' !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$'
 or p_policy->>'max_requests' !~ '^[1-3]$' or p_policy->>'max_request_bytes' !~ '^[1-9][0-9]{0,4}$'
 then raise exception 'REMOTE_CONSENT_REQUIRED'; end if;
 if (p_policy->>'max_request_bytes')::int>16384 then raise exception 'REMOTE_CONSENT_REQUIRED'; end if;
 perform (p_policy->>'host_grant_id')::uuid; expiry:=(p_policy->>'expires_at')::timestamptz;
 if expiry is null or expiry<=now() or expiry>now()+interval '1 hour' then raise exception 'REMOTE_CONSENT_REQUIRED'; end if;
 -- Expired policy has no future processing authority. Close its stale binding
 -- before applying the partial uniqueness constraint; do not claim stop delivery.
 update public.remote_device_bindings b set state='revoked',revision=revision+1,revoked_at=now(),credential_hash=repeat('0',64)
 where b.installation_instance_id=p_instance and b.workspace_ref=p_workspace_ref and b.state='active'
 and exists(select 1 from public.remote_relay_grants g where g.binding_id=b.id and g.expires_at<=now());
 if exists(select 1 from public.remote_device_bindings b where b.installation_instance_id=p_instance and b.workspace_ref=p_workspace_ref and b.state='active')
 then raise exception 'REMOTE_INSTANCE_IN_USE'; end if;
 if (select count(*) from public.remote_device_bindings b join public.remote_relay_grants g on g.binding_id=b.id where b.account_id=challenge.account_id and b.state='active' and g.state='active' and g.expires_at>now())>=3
 or (select count(*) from public.remote_device_bindings b join public.remote_relay_grants g on g.binding_id=b.id where b.state='active' and g.state='active' and g.expires_at>now())>=1000 then raise exception 'REMOTE_RATE_LIMITED'; end if;
 -- The account/session are from the authenticated challenge, never from device/model input.
 insert into public.remote_device_bindings(account_id,phone_session_ref,installation_instance_id,workspace_ref,credential_hash)
 values(challenge.account_id,challenge.phone_session_ref,p_instance,p_workspace_ref,encode(extensions.digest(p_token,'sha256'),'hex')) returning * into binding;
 insert into public.remote_relay_grants(binding_id,policy,expires_at) values(binding.id,p_policy,expiry);
 update public.remote_pairing_challenges set consumed_at=now() where id=challenge.id;
 return jsonb_build_object('id',binding.id,'account_id',binding.account_id,'phone_session_ref',binding.phone_session_ref,
 'installation_instance_id',binding.installation_instance_id,'workspace_ref',binding.workspace_ref,'state',binding.state,'revision',binding.revision,'policy',p_policy,'last_seen_at',null);
end; $$;

create function public.remote_phone_status(p_phone_session uuid,p_binding uuid default null) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not public.remote_confirmed_phone(p_phone_session) then raise exception 'REMOTE_AUTH_REQUIRED'; end if;
 return jsonb_build_object('bindings',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'state',b.state,'revision',b.revision,
 'expires_at',g.expires_at,'last_seen_at',b.last_seen_at,'result_scope','status_only','recipes',g.policy->'recipes'))
 from public.remote_device_bindings b join public.remote_relay_grants g on g.binding_id=b.id
 where b.account_id=auth.uid() and b.phone_session_ref=p_phone_session and (p_binding is null or b.id=p_binding)),'[]'::jsonb),
 'jobs',coalesce((select jsonb_agg(jsonb_build_object('id',j.id,'binding_id',j.binding_id,'state',j.state,'sequence',j.sequence,
 'created_at',j.created_at,'expires_at',j.expires_at,'text','withheld_status_only_foundation'))
 from public.remote_jobs j join public.remote_device_bindings b on b.id=j.binding_id
 where b.account_id=auth.uid() and b.phone_session_ref=p_phone_session and (p_binding is null or b.id=p_binding)),'[]'::jsonb));
end; $$;

create function public.remote_phone_preflight(p_phone_session uuid,p_binding uuid) returns boolean language plpgsql stable security definer set search_path='' as $$
begin
 return public.remote_confirmed_phone(p_phone_session) and exists(select 1 from public.remote_device_bindings b join public.remote_relay_grants g on g.binding_id=b.id
 where b.id=p_binding and b.account_id=auth.uid() and b.phone_session_ref=p_phone_session and b.state='active' and g.state='active' and g.expires_at>now());
end; $$;

-- The strict six-field request has one canonical byte representation, shared
-- with remoteHash(parseRemoteStudyRequest(...)); no browser-supplied hash is trusted.
create function public.remote_study_hash(p_request jsonb) returns text language sql immutable set search_path='' as $$
 select encode(extensions.digest(concat('{"binding_id":',to_json(p_request->>'binding_id'),',"client_request_id":',to_json(p_request->>'client_request_id'),
 ',"prompt":',to_json(p_request->>'prompt'),',"recipe_id":',to_json(p_request->>'recipe_id'),',"recipe_version":',to_json(p_request->>'recipe_version'),',"schema_version":1}'),'sha256'),'hex');
$$;
revoke all on function public.remote_study_hash(jsonb) from public,anon,authenticated;

-- Match JavaScript's UTF-16 length bound, including astral code points.
create function public.remote_utf16_length(p_text text) returns integer language sql immutable strict set search_path='' as $$
 select coalesce(sum(case when ascii(c)>65535 then 2 else 1 end),0)::integer
 from regexp_split_to_table(p_text,'') as characters(c) where c<>'';
$$;
revoke all on function public.remote_utf16_length(text) from public,anon,authenticated;

create function public.remote_submit_study(p_phone_session uuid,p_binding uuid,p_request jsonb,p_input_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare binding public.remote_device_bindings; grant_row public.remote_relay_grants; job public.remote_jobs; bytes integer;
 trim_chars text:=chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279);
begin
 if not public.remote_confirmed_phone(p_phone_session) then raise exception 'REMOTE_AUTH_REQUIRED'; end if;
 select * into binding from public.remote_device_bindings where id=p_binding and account_id=auth.uid() and phone_session_ref=p_phone_session for update;
 if not found or binding.state<>'active' then raise exception 'REMOTE_CONSENT_REQUIRED'; end if;
 select * into grant_row from public.remote_relay_grants where binding_id=binding.id for update;
 if not found or grant_row.state<>'active' or grant_row.expires_at<=now() then raise exception 'REMOTE_CONSENT_REQUIRED'; end if;
 -- All permission checks happen before retaining any prompt bytes.
 if p_request is not null and octet_length(p_request::text)>16384 then raise exception 'REMOTE_TOO_LARGE'; end if;
 if p_request is null or jsonb_typeof(p_request)<>'object' or not p_request ?& array['schema_version','binding_id','client_request_id','recipe_id','recipe_version','prompt']
 or p_request-array['schema_version','binding_id','client_request_id','recipe_id','recipe_version','prompt']<>'{}'::jsonb
 or p_request->'schema_version' is distinct from '1'::jsonb or p_request->>'binding_id' is distinct from binding.id::text
 or p_request->>'recipe_id' is distinct from 'study.explain' or p_request->>'recipe_version' is distinct from 'remote-study-foundation-1'
 or jsonb_typeof(p_request->'prompt') is distinct from 'string' or public.remote_utf16_length(p_request->>'prompt') not between 1 and 4000
 or btrim(p_request->>'prompt',trim_chars)='' or regexp_replace(p_request->>'prompt',E'[\n\r\t]','','g') ~ '[[:cntrl:]]'
 or jsonb_typeof(p_request->'client_request_id') is distinct from 'string'
 or p_input_hash is null or p_input_hash !~ '^[a-f0-9]{64}$' then raise exception 'INVALID_REMOTE_INPUT'; end if;
 if p_request->>'client_request_id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
 or p_input_hash is distinct from public.remote_study_hash(p_request) then raise exception 'INVALID_REMOTE_INPUT'; end if;
 bytes:=octet_length(p_request::text); if bytes>16384 or bytes>(grant_row.policy->>'max_request_bytes')::int then raise exception 'REMOTE_TOO_LARGE'; end if;
 select * into job from public.remote_jobs where binding_id=binding.id and client_request_id=(p_request->>'client_request_id')::uuid;
 if found then if job.request is distinct from p_request or job.input_hash<>p_input_hash then raise exception 'REMOTE_ENVELOPE_CONFLICT'; end if;
 return jsonb_build_object('id',job.id,'state',job.state,'duplicate',true); end if;
 if grant_row.used_requests>=(grant_row.policy->>'max_requests')::int or grant_row.used_bytes+bytes>49152
 or (select count(*) from public.remote_jobs where binding_id=binding.id and state='queued')>=3 then raise exception 'REMOTE_BUDGET_EXCEEDED'; end if;
 insert into public.remote_jobs(binding_id,account_id,client_request_id,request,input_hash)
 values(binding.id,binding.account_id,(p_request->>'client_request_id')::uuid,p_request,p_input_hash) returning * into job;
 update public.remote_relay_grants set used_requests=used_requests+1,used_bytes=used_bytes+bytes where id=grant_row.id;
 return jsonb_build_object('id',job.id,'state','queued','duplicate',false);
end; $$;

create function public.remote_phone_control(p_phone_session uuid,p_binding uuid,p_operation text,p_job uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare binding public.remote_device_bindings; job public.remote_jobs;
begin
 if not public.remote_confirmed_phone(p_phone_session) then raise exception 'REMOTE_AUTH_REQUIRED'; end if;
 if p_operation in ('cancel','delete') and p_job is null then raise exception 'INVALID_REMOTE_INPUT'; end if;
 -- A fresh verified session may erase its account's old revoked prompt. Other
 -- control operations remain limited to the explicitly paired phone session.
 select * into binding from public.remote_device_bindings where id=p_binding and account_id=auth.uid()
 and (phone_session_ref=p_phone_session or p_operation='delete') for update;
 if not found then raise exception 'REMOTE_AUTH_REQUIRED'; end if;
 if p_operation='revoke' then
 update public.remote_device_bindings set state='revoked',revision=revision+1,revoked_at=now(),credential_hash=repeat('0',64) where id=binding.id;
 update public.remote_relay_grants set state='revoked' where binding_id=binding.id;
 update public.remote_jobs set state=case when state='queued' then 'cancelled' else 'cancel_requested' end where binding_id=binding.id and state in ('queued','leased','local_accepted','awaiting_student');
 elsif p_operation='cancel' then
 select * into job from public.remote_jobs where id=p_job and binding_id=binding.id for update;
 if not found then raise exception 'REMOTE_JOB_NOT_FOUND'; end if;
 if job.state in ('cancel_requested','cancelled') then
 return jsonb_build_object('status','cancel','duplicate',true,'delivery_state',job.state,'cancellation_acknowledged',job.state='cancelled','text','withheld'); end if;
 update public.remote_jobs set state=case when state='queued' then 'cancelled' else 'cancel_requested' end
 where id=p_job and binding_id=binding.id and state in ('queued','leased','local_accepted','awaiting_student') returning * into job;
 if not found then raise exception 'REMOTE_JOB_NOT_FOUND'; end if;
 return jsonb_build_object('status','cancel','duplicate',false,'delivery_state',job.state,'cancellation_acknowledged',job.state='cancelled','text','withheld');
 elsif p_operation='delete' then
 select * into job from public.remote_jobs where id=p_job and binding_id=binding.id for update;
 if not found then return jsonb_build_object('status','delete','duplicate',true,'prompt_erased',true,'cancellation_acknowledged',false,'text','withheld'); end if;
 if job.state in ('cancelled','failed','expired','unknown_outcome') then
 delete from public.remote_jobs where id=job.id;
 elsif binding.state='revoked' then
 -- Erase content but retain the delivery tombstone. Revocation denies all
 -- future device claims; an unacknowledged stop stays cancel_requested.
 update public.remote_jobs set request=null where id=job.id;
 else raise exception 'REMOTE_CANCEL_FIRST'; end if;
 return jsonb_build_object('status','delete','duplicate',job.request is null,'prompt_erased',true,'delivery_state',job.state,
 'cancellation_acknowledged',job.state='cancelled','text','withheld');
 else raise exception 'INVALID_REMOTE_OPERATION'; end if;
 return jsonb_build_object('status',p_operation,'text','withheld');
end; $$;

-- Recovery is a separate owner operation: a fresh verified phone session may
-- revoke its account's old bindings without reading their prompts or tokens.
-- Logging out is not represented as immediate cross-network revocation here.
create function public.remote_phone_recover(p_phone_session uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not public.remote_confirmed_phone(p_phone_session) then raise exception 'REMOTE_AUTH_REQUIRED'; end if;
 perform pg_catalog.pg_advisory_xact_lock(298327493);
 update public.remote_pairing_challenges set consumed_at=now() where account_id=auth.uid() and consumed_at is null;
 update public.remote_device_bindings set state='revoked',revision=revision+1,revoked_at=now(),credential_hash=repeat('0',64)
 where account_id=auth.uid() and state='active';
 update public.remote_relay_grants set state='revoked' where binding_id in(select id from public.remote_device_bindings where account_id=auth.uid());
 update public.remote_jobs set state=case when state='queued' then 'cancelled' else 'cancel_requested' end
 where account_id=auth.uid() and state in ('queued','leased','local_accepted','awaiting_student');
 return jsonb_build_object('status','revoked_all_own_bindings','text','withheld');
end; $$;

create function public.remote_device_operation(p_binding uuid,p_token text,p_instance uuid,p_operation text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare binding public.remote_device_bindings; grant_row public.remote_relay_grants; job public.remote_jobs; event public.remote_delivery_events; seq bigint; target text;
begin
 if p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$' or p_payload is null or octet_length(p_payload::text)>4096 then raise exception 'REMOTE_DEVICE_DENIED'; end if;
 select * into binding from public.remote_device_bindings where id=p_binding and installation_instance_id=p_instance for update;
 if not found or binding.state<>'active' or binding.credential_hash<>encode(extensions.digest(p_token,'sha256'),'hex') then raise exception 'REMOTE_DEVICE_DENIED'; end if;
 if p_operation='revoke' then
 if p_payload<>'{}'::jsonb then raise exception 'INVALID_REMOTE_INPUT'; end if;
 update public.remote_device_bindings set state='revoked',revision=revision+1,revoked_at=now(),credential_hash=repeat('0',64) where id=binding.id;
 update public.remote_relay_grants set state='revoked' where binding_id=binding.id;
 update public.remote_jobs set state=case when state='queued' then 'cancelled' else 'cancel_requested' end where binding_id=binding.id and state in ('queued','leased','local_accepted','awaiting_student');
 return jsonb_build_object('status','revoked'); end if;
 select * into grant_row from public.remote_relay_grants where binding_id=binding.id;
 if not found or grant_row.state<>'active' or grant_row.expires_at<=now() then raise exception 'REMOTE_CONSENT_REQUIRED'; end if;
 update public.remote_device_bindings set last_seen_at=now() where id=binding.id;
 if p_operation='heartbeat' then
 if p_payload<>'{}'::jsonb then raise exception 'INVALID_REMOTE_INPUT'; end if;
 return jsonb_build_object('id',binding.id,'account_id',binding.account_id,'phone_session_ref',binding.phone_session_ref,
 'installation_instance_id',binding.installation_instance_id,'workspace_ref',binding.workspace_ref,'state',binding.state,'revision',binding.revision,'policy',grant_row.policy,'last_seen_at',now());
 elsif p_operation='claim' then
 if p_payload<>'{}'::jsonb then raise exception 'INVALID_REMOTE_INPUT'; end if;
 update public.remote_jobs set state='expired' where binding_id=binding.id and state='queued' and expires_at<=now();
 -- Expired leases are uncertain, never requeued or dispatched as a fresh native turn.
 update public.remote_jobs set state='unknown_outcome' where binding_id=binding.id and state in ('leased','local_accepted') and lease_expires_at<=now();
 select * into job from public.remote_jobs where binding_id=binding.id and state in ('leased','local_accepted','cancel_requested','awaiting_student') order by created_at limit 1 for update;
 if found and job.state in ('cancel_requested','awaiting_student') and job.lease_expires_at<=now() then
 -- Renew control ownership only. Keep the intent/run reference and never put
 -- accepted work back into the execution queue because a lease expired.
 update public.remote_jobs set lease_epoch=lease_epoch+1,lease_expires_at=now()+interval '60 seconds' where id=job.id returning * into job;
 elsif not found then select * into job from public.remote_jobs where binding_id=binding.id and state='queued' and expires_at>now() order by created_at limit 1 for update skip locked;
 if found then update public.remote_jobs set state='leased',lease_epoch=lease_epoch+1,lease_expires_at=now()+interval '60 seconds' where id=job.id returning * into job; end if; end if;
 if not found then return 'null'::jsonb; end if;
 return jsonb_build_object('id',job.id,'binding_id',job.binding_id,'account_id',job.account_id,'request',job.request,'input_hash',job.input_hash,
 'state',job.state,'lease_epoch',job.lease_epoch,'lease_expires_at',job.lease_expires_at,'local_run_ref',job.local_run_ref,'expires_at',job.expires_at,'sequence',job.sequence);
 elsif p_operation in ('accept','state') then
 if jsonb_typeof(p_payload) is distinct from 'object' or not p_payload ?& array['job_id','lease_epoch','sequence','local_run_ref','state']
 or p_payload-array['job_id','lease_epoch','sequence','local_run_ref','state']<>'{}'::jsonb
 or jsonb_typeof(p_payload->'job_id') is distinct from 'string' or jsonb_typeof(p_payload->'local_run_ref') is distinct from 'string'
 or jsonb_typeof(p_payload->'state') is distinct from 'string' or jsonb_typeof(p_payload->'lease_epoch') is distinct from 'number'
 or jsonb_typeof(p_payload->'sequence') is distinct from 'number' then raise exception 'INVALID_REMOTE_INPUT'; end if;
 if p_payload->>'job_id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
 or p_payload->>'local_run_ref' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
 or p_payload->>'lease_epoch' !~ '^(0|[1-9][0-9]{0,15})$' or p_payload->>'sequence' !~ '^[1-9][0-9]{0,15}$'
 then raise exception 'INVALID_REMOTE_INPUT'; end if;
 if (p_payload->>'lease_epoch')::bigint>9007199254740991 or (p_payload->>'sequence')::bigint>9007199254740991 then raise exception 'INVALID_REMOTE_INPUT'; end if;
 select * into job from public.remote_jobs where id=(p_payload->>'job_id')::uuid and binding_id=binding.id for update;
 if not found or job.lease_epoch is distinct from (p_payload->>'lease_epoch')::bigint or job.lease_expires_at is null or job.lease_expires_at<=now() then raise exception 'REMOTE_LEASE_DENIED'; end if;
 seq:=(p_payload->>'sequence')::bigint; target:=case when p_operation='accept' then 'local_accepted' else p_payload->>'state' end;
 if target not in ('local_accepted','awaiting_student','cancelled','failed','unknown_outcome') or target is null
 or p_payload->>'local_run_ref' is null or (p_operation='accept' and p_payload->>'state' is distinct from 'local_accepted') then raise exception 'INVALID_REMOTE_INPUT'; end if;
 select * into event from public.remote_delivery_events where job_id=job.id and sequence=seq;
 if found then if event.state<>target or event.lease_epoch<>job.lease_epoch or event.local_run_ref<>(p_payload->>'local_run_ref')::uuid then raise exception 'REMOTE_EVENT_CONFLICT'; end if;
 return jsonb_build_object('status','duplicate','state',job.state); end if;
 if seq<>job.sequence+1 or (target='local_accepted' and job.state<>'leased')
 or (target='awaiting_student' and job.state<>'local_accepted') or (target='cancelled' and job.state<>'cancel_requested') then raise exception 'REMOTE_EVENT_CONFLICT'; end if;
 if job.local_run_ref is not null and job.local_run_ref<>(p_payload->>'local_run_ref')::uuid then raise exception 'REMOTE_EVENT_CONFLICT'; end if;
 insert into public.remote_delivery_events(job_id,sequence,lease_epoch,state,local_run_ref) values(job.id,seq,job.lease_epoch,target,(p_payload->>'local_run_ref')::uuid);
 update public.remote_jobs set state=target,sequence=seq,local_run_ref=(p_payload->>'local_run_ref')::uuid where id=job.id;
 return jsonb_build_object('status','accepted','state',target);
 else raise exception 'INVALID_REMOTE_OPERATION'; end if;
end; $$;

create function public.remote_purge_expired() returns void language plpgsql security definer set search_path='' as $$
begin
 delete from public.remote_pairing_challenges where expires_at<now();
 update public.remote_jobs set state='expired' where state='queued' and expires_at<=now();
 delete from public.remote_jobs where created_at<now()-interval '24 hours';
 delete from public.remote_device_bindings where (state='revoked' and revoked_at<now()-interval '24 hours')
 or not exists(select 1 from public.remote_relay_grants g where g.binding_id=remote_device_bindings.id and g.expires_at>now()-interval '24 hours');
end; $$;
revoke all on function public.remote_begin_pairing(uuid),public.remote_phone_status(uuid,uuid),public.remote_phone_preflight(uuid,uuid),
 public.remote_submit_study(uuid,uuid,jsonb,text),public.remote_phone_control(uuid,uuid,text,uuid),public.remote_phone_recover(uuid) from public,anon;
grant execute on function public.remote_begin_pairing(uuid),public.remote_phone_status(uuid,uuid),public.remote_phone_preflight(uuid,uuid),
 public.remote_submit_study(uuid,uuid,jsonb,text),public.remote_phone_control(uuid,uuid,text,uuid),public.remote_phone_recover(uuid) to authenticated;
revoke all on function public.remote_confirm_pairing(uuid,text,uuid,text,text,jsonb),public.remote_device_operation(uuid,text,uuid,text,jsonb) from public;
grant execute on function public.remote_confirm_pairing(uuid,text,uuid,text,text,jsonb),public.remote_device_operation(uuid,text,uuid,text,jsonb) to anon,authenticated;
revoke all on function public.remote_purge_expired() from public,anon,authenticated;
grant execute on function public.remote_purge_expired() to service_role;
-- A retention scheduler and live RLS/RPC tests are required before enabling any route.
commit;

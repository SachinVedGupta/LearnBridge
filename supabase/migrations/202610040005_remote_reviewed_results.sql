-- Optional reviewed-result extension. Setup NEVER applies it or enables phone access.
-- Requires the status-only foundation, real Supabase/session checks and scheduled purge before release.
begin;
create table public.remote_reviewed_results (
 id uuid primary key default gen_random_uuid(), binding_id uuid not null references public.remote_device_bindings(id) on delete cascade,
 account_id uuid not null references auth.users(id) on delete cascade, job_id uuid not null unique references public.remote_jobs(id) on delete cascade,
 local_result_id uuid not null, policy jsonb not null, review_hash text not null check(review_hash ~ '^[a-f0-9]{64}$'),
 result_sha256 text not null check(result_sha256 ~ '^[a-f0-9]{64}$'), result_bytes integer not null check(result_bytes between 1 and 48000),
 result_text text, state text not null default 'available' check(state in ('available','revoked')),
 delivery_requests integer not null default 0 check(delivery_requests between 0 and 20),
 created_at timestamptz not null default now(), consent_expires_at timestamptz not null, purge_at timestamptz not null default now()+interval '24 hours',
 unique(binding_id,local_result_id), check(octet_length(policy::text)<=8192), check(result_text is null or octet_length(result_text)<=48000)
);
create table public.remote_result_deliveries (
 id uuid primary key default gen_random_uuid(), result_id uuid not null references public.remote_reviewed_results(id) on delete cascade,
 binding_id uuid not null references public.remote_device_bindings(id) on delete cascade, account_id uuid not null references auth.users(id) on delete cascade,
 phone_session_ref uuid not null, nonce text not null, state text not null default 'waiting_local' check(state in ('waiting_local','ready','consumed','denied')),
 created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '60 seconds', ready_expires_at timestamptz,
 check(nonce ~ '^[a-f0-9]{32}$' or nonce='')
);
create unique index remote_one_result_delivery on public.remote_result_deliveries(result_id,phone_session_ref) where state in ('waiting_local','ready');
alter table public.remote_reviewed_results enable row level security;
alter table public.remote_result_deliveries enable row level security;
revoke all on public.remote_reviewed_results,public.remote_result_deliveries from public,anon,authenticated;

-- Result delivery additionally checks the live GoTrue session row. A valid but
-- revoked JWT must not keep a phone result binding usable until token expiry.
create function public.remote_result_confirmed_phone(p_session uuid) returns boolean language sql stable security definer set search_path='' as $$
 select public.remote_confirmed_phone(p_session) and exists(select 1 from auth.sessions s
 where s.id=p_session and s.user_id=auth.uid() and (s.not_after is null or s.not_after>now()));
$$;
revoke all on function public.remote_result_confirmed_phone(uuid) from public,anon,authenticated;
create function public.remote_result_uuid(p_value jsonb) returns uuid language plpgsql immutable set search_path='' as $$
begin
 if jsonb_typeof(p_value) is distinct from 'string' or p_value#>>'{}' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' then raise exception 'INVALID_REMOTE_INPUT'; end if;
 return (p_value#>>'{}')::uuid;
end; $$;
revoke all on function public.remote_result_uuid(jsonb) from public,anon,authenticated;

create function public.remote_result_canonical(p_value jsonb) returns text language plpgsql immutable set search_path='' as $$
declare result text;
begin
 case jsonb_typeof(p_value)
 when 'object' then select '{'||coalesce(string_agg(to_jsonb(key)::text||':'||public.remote_result_canonical(value),',' order by key),'')||'}' into result from jsonb_each(p_value);
 when 'array' then select '['||coalesce(string_agg(public.remote_result_canonical(value),',' order by ordinal),'')||']' into result from jsonb_array_elements(p_value) with ordinality as items(value,ordinal);
 else result:=p_value::text;
 end case; return result;
end; $$;
revoke all on function public.remote_result_canonical(jsonb) from public,anon,authenticated;

create function public.remote_result_validate_policy(p_policy jsonb,p_binding public.remote_device_bindings,p_job public.remote_jobs,p_grant public.remote_relay_grants)
returns void language plpgsql set search_path='' as $$
declare fields text[]:=array['version','binding_id','account_id','installation_instance_id','workspace_ref','phone_session_ref','binding_revision','binding_policy_hash','job_id','input_hash','host_grant_id','selection_hash','writing_record','document','source_documents','academic_policy','content_status','result_sha256','result_bytes','expires_at','relay_processing_confirmed','plaintext_notice_confirmed','retention_hours'];
 item jsonb; field text; expiry timestamptz; ids uuid[]:=array[]::uuid[]; previous_id text:='';
begin
 if p_policy is null or jsonb_typeof(p_policy)<>'object' or not p_policy ?& fields or p_policy-fields<>'{}'::jsonb or octet_length(p_policy::text)>8192
 or p_policy->>'version' is distinct from 'remote-reviewed-text-1' or p_policy->'relay_processing_confirmed' is distinct from 'true'::jsonb
 or p_policy->'plaintext_notice_confirmed' is distinct from 'true'::jsonb or p_policy->'retention_hours' is distinct from '24'::jsonb
 or jsonb_typeof(p_policy->'academic_policy') is distinct from 'string' or p_policy->>'academic_policy' not in ('unrestricted','learning_support','graded_restricted')
 or jsonb_typeof(p_policy->'content_status') is distinct from 'string' or p_policy->>'content_status' not in ('student_reviewed_content','student_reviewed_model_output_facts_unverified') then raise exception 'REMOTE_RESULT_CONSENT_REQUIRED'; end if;
 foreach field in array array['binding_id','account_id','installation_instance_id','phone_session_ref','job_id','host_grant_id'] loop
 if jsonb_typeof(p_policy->field) is distinct from 'string' or p_policy->>field !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' then raise exception 'INVALID_REMOTE_INPUT'; end if;
 end loop;
 foreach field in array array['workspace_ref','binding_policy_hash','input_hash','selection_hash','result_sha256'] loop
 if jsonb_typeof(p_policy->field) is distinct from 'string' or p_policy->>field !~ '^[a-f0-9]{64}$' then raise exception 'INVALID_REMOTE_INPUT'; end if;
 end loop;
 if p_policy->>'binding_id' is distinct from p_binding.id::text or p_policy->>'account_id' is distinct from p_binding.account_id::text
 or p_policy->>'installation_instance_id' is distinct from p_binding.installation_instance_id::text or p_policy->>'workspace_ref' is distinct from p_binding.workspace_ref
 or p_policy->>'phone_session_ref' is distinct from p_binding.phone_session_ref::text or p_policy->'binding_revision' is distinct from to_jsonb(p_binding.revision)
 or p_policy->>'binding_policy_hash' is distinct from encode(extensions.digest(public.remote_result_canonical(p_grant.policy),'sha256'),'hex')
 or p_policy->>'job_id' is distinct from p_job.id::text or p_policy->>'input_hash' is distinct from p_job.input_hash
 or p_policy->>'host_grant_id' is distinct from p_grant.policy->>'host_grant_id' or p_policy->>'selection_hash' is distinct from p_grant.policy->>'selection_hash'
 then raise exception 'REMOTE_RESULT_CONSENT_REQUIRED'; end if;
 if jsonb_typeof(p_policy->'result_bytes') is distinct from 'number' or p_policy->>'result_bytes' !~ '^[1-9][0-9]{0,4}$' or (p_policy->>'result_bytes')::integer>48000
 or jsonb_typeof(p_policy->'source_documents') is distinct from 'array' or jsonb_array_length(p_policy->'source_documents')>10 then raise exception 'INVALID_REMOTE_INPUT'; end if;
 if jsonb_typeof(p_policy->'expires_at') is distinct from 'string' or p_policy->>'expires_at' !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$' then raise exception 'INVALID_REMOTE_INPUT'; end if;
 expiry:=(p_policy->>'expires_at')::timestamptz;
 if expiry<=now() or expiry>now()+interval '1 hour' or expiry>p_grant.expires_at then raise exception 'REMOTE_RESULT_CONSENT_REQUIRED'; end if;
 foreach field in array array['writing_record','document'] loop
 item:=p_policy->field;
 if jsonb_typeof(item) is distinct from 'object' or not item ?& array['id','revision',case when field='document' then 'sha256' else 'payload_hash' end]
 or item-array['id','revision',case when field='document' then 'sha256' else 'payload_hash' end]<>'{}'::jsonb
 or jsonb_typeof(item->'id') is distinct from 'string' or item->>'id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
 or jsonb_typeof(item->'revision') is distinct from 'number' or item->>'revision' !~ '^[1-9][0-9]{0,15}$' or (item->>'revision')::bigint>9007199254740991
 or jsonb_typeof(item->(case when field='document' then 'sha256' else 'payload_hash' end)) is distinct from 'string'
 or item->>(case when field='document' then 'sha256' else 'payload_hash' end) !~ '^[a-f0-9]{64}$' then raise exception 'INVALID_REMOTE_INPUT'; end if;
 end loop;
 if p_policy#>>'{document,sha256}' is distinct from p_policy->>'result_sha256' then raise exception 'REMOTE_RESULT_CONFLICT'; end if;
 for item in select value from jsonb_array_elements(p_policy->'source_documents') loop
 if jsonb_typeof(item)<>'object' or not item ?& array['id','revision','sha256'] or item-array['id','revision','sha256']<>'{}'::jsonb
 or jsonb_typeof(item->'id') is distinct from 'string' or item->>'id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
 or jsonb_typeof(item->'revision') is distinct from 'number' or item->>'revision' !~ '^[1-9][0-9]{0,15}$' or (item->>'revision')::bigint>9007199254740991
 or jsonb_typeof(item->'sha256') is distinct from 'string' or item->>'sha256' !~ '^[a-f0-9]{64}$' then raise exception 'INVALID_REMOTE_INPUT'; end if;
 if (item->>'id')::uuid=any(ids) or item->>'id'<=previous_id then raise exception 'INVALID_REMOTE_INPUT'; end if;
 ids:=array_append(ids,(item->>'id')::uuid); previous_id:=item->>'id';
 end loop;
end; $$;
revoke all on function public.remote_result_validate_policy(jsonb,public.remote_device_bindings,public.remote_jobs,public.remote_relay_grants) from public,anon,authenticated;

create function public.remote_result_device(p_binding uuid,p_token text,p_instance uuid,p_operation text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare binding public.remote_device_bindings; grant_row public.remote_relay_grants; job public.remote_jobs; result public.remote_reviewed_results;
 delivery public.remote_result_deliveries; policy jsonb; body text; review_hash text; field text;
begin
 if p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$' or p_payload is null or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>128000 then raise exception 'REMOTE_DEVICE_DENIED'; end if;
 select * into binding from public.remote_device_bindings where id=p_binding and installation_instance_id=p_instance for update;
 if not found or binding.state<>'active' or binding.credential_hash<>encode(extensions.digest(p_token,'sha256'),'hex') then raise exception 'REMOTE_DEVICE_DENIED'; end if;
 if p_operation='revoke' then
 if not p_payload ?& array['local_result_id'] or p_payload-array['local_result_id']<>'{}'::jsonb then raise exception 'INVALID_REMOTE_INPUT'; end if;
 perform public.remote_result_uuid(p_payload->'local_result_id');
 update public.remote_reviewed_results set state='revoked',result_text=null,policy='{}'::jsonb where binding_id=binding.id and local_result_id=(p_payload->>'local_result_id')::uuid;
 update public.remote_result_deliveries set state='denied',nonce='' where binding_id=binding.id and state in ('waiting_local','ready'); return jsonb_build_object('state','revoked');
 end if;
 if not exists(select 1 from auth.users u join auth.sessions s on s.user_id=u.id where u.id=binding.account_id and u.email_confirmed_at is not null
 and s.id=binding.phone_session_ref and (s.not_after is null or s.not_after>now())) then raise exception 'REMOTE_AUTH_REQUIRED'; end if;
 select * into grant_row from public.remote_relay_grants where binding_id=binding.id;
 if not found or grant_row.state<>'active' or grant_row.expires_at<=now() then raise exception 'REMOTE_CONSENT_REQUIRED'; end if;
 if p_operation='preflight' then
 if p_payload<>'{}'::jsonb then raise exception 'INVALID_REMOTE_INPUT'; end if; return 'true'::jsonb;
 elsif p_operation='inspect' then
 if not p_payload ?& array['job_id'] or p_payload-array['job_id']<>'{}'::jsonb then raise exception 'INVALID_REMOTE_INPUT'; end if;
 perform public.remote_result_uuid(p_payload->'job_id');
 select * into job from public.remote_jobs where id=(p_payload->>'job_id')::uuid and binding_id=binding.id;
 if not found then raise exception 'REMOTE_JOB_NOT_FOUND'; end if;
 return jsonb_build_object('id',job.id,'binding_id',job.binding_id,'account_id',job.account_id,'input_hash',job.input_hash,'state',job.state,'local_run_ref',job.local_run_ref,'sequence',job.sequence);
 elsif p_operation='status' then
 if not p_payload ?& array['local_result_id'] or p_payload-array['local_result_id']<>'{}'::jsonb then raise exception 'INVALID_REMOTE_INPUT'; end if;
 perform public.remote_result_uuid(p_payload->'local_result_id');
 select * into result from public.remote_reviewed_results where local_result_id=(p_payload->>'local_result_id')::uuid and binding_id=binding.id;
 if not found then return jsonb_build_object('state','not_found'); end if;
 return jsonb_build_object('id',result.id,'local_result_id',result.local_result_id,'state',result.state,'review_hash',result.review_hash,'result_sha256',result.result_sha256);
 elsif p_operation='upload' then
 if not p_payload ?& array['schema_version','local_result_id','policy','review_hash','text'] or p_payload-array['schema_version','local_result_id','policy','review_hash','text']<>'{}'::jsonb
 or p_payload->'schema_version' is distinct from '1'::jsonb or jsonb_typeof(p_payload->'local_result_id') is distinct from 'string'
 or p_payload->>'local_result_id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
 or jsonb_typeof(p_payload->'review_hash') is distinct from 'string' or p_payload->>'review_hash' !~ '^[a-f0-9]{64}$'
 or jsonb_typeof(p_payload->'text') is distinct from 'string' then raise exception 'INVALID_REMOTE_INPUT'; end if;
 policy:=p_payload->'policy'; body:=p_payload->>'text'; review_hash:=p_payload->>'review_hash';
 select * into job from public.remote_jobs where id=(policy->>'job_id')::uuid and binding_id=binding.id for update;
 if not found or job.state<>'awaiting_student' or job.local_run_ref is null then raise exception 'REMOTE_RESULT_JOB_DENIED'; end if;
 perform public.remote_result_validate_policy(policy,binding,job,grant_row);
 if octet_length(body)<> (policy->>'result_bytes')::integer or octet_length(body)>48000 or btrim(body)=''
 or body ~ '[\x01-\x08\x0b\x0c\x0e-\x1f]' or encode(extensions.digest(body,'sha256'),'hex')<>policy->>'result_sha256'
 or encode(extensions.digest(public.remote_result_canonical(policy),'sha256'),'hex')<>review_hash then raise exception 'REMOTE_RESULT_CONFLICT'; end if;
 select * into result from public.remote_reviewed_results where binding_id=binding.id and (local_result_id=(p_payload->>'local_result_id')::uuid or job_id=job.id) for update;
 if found then
 if result.state<>'available' or result.local_result_id<>(p_payload->>'local_result_id')::uuid or result.review_hash<>review_hash or result.result_sha256<>policy->>'result_sha256'
 or result.result_text<>body then raise exception 'REMOTE_RESULT_CONFLICT'; end if;
 return jsonb_build_object('id',result.id,'local_result_id',result.local_result_id,'state',result.state,'review_hash',result.review_hash,'result_sha256',result.result_sha256,'duplicate',true); end if;
 perform pg_catalog.pg_advisory_xact_lock(298327494);
 if (select count(*) from public.remote_reviewed_results)>=1000 then raise exception 'REMOTE_RATE_LIMITED'; end if;
 insert into public.remote_reviewed_results(binding_id,account_id,job_id,local_result_id,policy,review_hash,result_sha256,result_bytes,result_text,consent_expires_at)
 values(binding.id,binding.account_id,job.id,(p_payload->>'local_result_id')::uuid,policy,review_hash,policy->>'result_sha256',(policy->>'result_bytes')::integer,body,(policy->>'expires_at')::timestamptz) returning * into result;
 return jsonb_build_object('id',result.id,'local_result_id',result.local_result_id,'state',result.state,'review_hash',result.review_hash,'result_sha256',result.result_sha256,'duplicate',false);
 elsif p_operation='claim_delivery' then
 if p_payload<>'{}'::jsonb then raise exception 'INVALID_REMOTE_INPUT'; end if;
 update public.remote_result_deliveries set state='denied',nonce='' where binding_id=binding.id and state in ('waiting_local','ready') and expires_at<=now();
 select d.* into delivery from public.remote_result_deliveries d join public.remote_reviewed_results r on r.id=d.result_id join public.remote_jobs j on j.id=r.job_id
 where d.binding_id=binding.id and d.state='waiting_local' and d.expires_at>now() and r.state='available' and r.consent_expires_at>now() and j.state='awaiting_student' order by d.created_at limit 1 for update of d;
 if not found then return 'null'::jsonb; end if;
 select * into result from public.remote_reviewed_results where id=delivery.result_id;
 return jsonb_build_object('id',delivery.id,'binding_id',delivery.binding_id,'account_id',delivery.account_id,'result_id',delivery.result_id,
 'result_sha256',result.result_sha256,'review_hash',result.review_hash,'nonce',delivery.nonce,'expires_at',delivery.expires_at);
 elsif p_operation in ('approve_delivery','deny_delivery') then
 if p_operation='approve_delivery' then
 if not p_payload ?& array['delivery_id','nonce','review_hash','result_sha256'] or p_payload-array['delivery_id','nonce','review_hash','result_sha256']<>'{}'::jsonb then raise exception 'INVALID_REMOTE_INPUT'; end if;
 else if not p_payload ?& array['delivery_id','nonce'] or p_payload-array['delivery_id','nonce']<>'{}'::jsonb then raise exception 'INVALID_REMOTE_INPUT'; end if; end if;
 perform public.remote_result_uuid(p_payload->'delivery_id');
 if jsonb_typeof(p_payload->'nonce') is distinct from 'string' or p_payload->>'nonce' !~ '^[a-f0-9]{32}$' then raise exception 'INVALID_REMOTE_INPUT'; end if;
 if p_operation='approve_delivery' and (jsonb_typeof(p_payload->'review_hash') is distinct from 'string' or p_payload->>'review_hash' !~ '^[a-f0-9]{64}$'
 or jsonb_typeof(p_payload->'result_sha256') is distinct from 'string' or p_payload->>'result_sha256' !~ '^[a-f0-9]{64}$') then raise exception 'INVALID_REMOTE_INPUT'; end if;
 select * into delivery from public.remote_result_deliveries where id=(p_payload->>'delivery_id')::uuid and binding_id=binding.id for update;
 if not found or delivery.expires_at<=now() or delivery.nonce<>p_payload->>'nonce' then raise exception 'REMOTE_DELIVERY_DENIED'; end if;
 if p_operation='deny_delivery' then update public.remote_result_deliveries set state='denied',nonce='' where id=delivery.id; return jsonb_build_object('state','denied'); end if;
 select * into result from public.remote_reviewed_results where id=delivery.result_id;
 select * into job from public.remote_jobs where id=result.job_id;
 if result.state<>'available' or result.consent_expires_at<=now() or job.state<>'awaiting_student'
 or result.review_hash<>p_payload->>'review_hash' or result.result_sha256<>p_payload->>'result_sha256' then raise exception 'REMOTE_DELIVERY_DENIED'; end if;
 if delivery.state='ready' and delivery.ready_expires_at>now() then return jsonb_build_object('state','ready','expires_at',delivery.ready_expires_at,'duplicate',true); end if;
 if delivery.state<>'waiting_local' then raise exception 'REMOTE_DELIVERY_DENIED'; end if;
 update public.remote_result_deliveries set state='ready',ready_expires_at=least(now()+interval '30 seconds',expires_at,result.consent_expires_at,grant_row.expires_at) where id=delivery.id returning * into delivery;
 return jsonb_build_object('state','ready','expires_at',delivery.ready_expires_at,'duplicate',false);
 else raise exception 'INVALID_REMOTE_OPERATION'; end if;
end; $$;

create function public.remote_result_phone(p_phone_session uuid,p_binding uuid,p_operation text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare binding public.remote_device_bindings; result public.remote_reviewed_results; delivery public.remote_result_deliveries;
begin
 if not public.remote_result_confirmed_phone(p_phone_session) then raise exception 'REMOTE_AUTH_REQUIRED'; end if;
 if p_payload is null or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>4096 then raise exception 'INVALID_REMOTE_INPUT'; end if;
 if p_operation='recover' then
 if p_binding is not null or p_payload<>'{}'::jsonb then raise exception 'INVALID_REMOTE_INPUT'; end if;
 perform public.remote_phone_recover(p_phone_session);
 update public.remote_reviewed_results set state='revoked',result_text=null,policy='{}'::jsonb where account_id=auth.uid();
 update public.remote_result_deliveries set state='denied',nonce='' where account_id=auth.uid() and state in ('waiting_local','ready');
 return jsonb_build_object('state','revoked_all_own_bindings','text_erased',true);
 end if;
 select * into binding from public.remote_device_bindings where id=p_binding and account_id=auth.uid() and (phone_session_ref=p_phone_session or p_operation='delete') for update;
 if not found then raise exception 'REMOTE_AUTH_REQUIRED'; end if;
 if p_operation='delete' then
 if not p_payload ?& array['result_id'] or p_payload-array['result_id']<>'{}'::jsonb then raise exception 'INVALID_REMOTE_INPUT'; end if;
 perform public.remote_result_uuid(p_payload->'result_id');
 update public.remote_reviewed_results set state='revoked',result_text=null,policy='{}'::jsonb where id=(p_payload->>'result_id')::uuid and account_id=auth.uid() and binding_id=binding.id;
 update public.remote_result_deliveries set state='denied',nonce='' where result_id=(p_payload->>'result_id')::uuid and account_id=auth.uid(); return jsonb_build_object('state','revoked','text_erased',true);
 end if;
 if not public.remote_phone_preflight(p_phone_session,p_binding) then raise exception 'REMOTE_CONSENT_REQUIRED'; end if;
 if p_operation='list' then
 if p_payload<>'{}'::jsonb then raise exception 'INVALID_REMOTE_INPUT'; end if;
 return jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'job_id',r.job_id,'state',r.state,'result_sha256',r.result_sha256,
 'result_bytes',r.result_bytes,'expires_at',r.consent_expires_at,'created_at',r.created_at,'content_status',r.policy->>'content_status')) from public.remote_reviewed_results r where r.binding_id=binding.id),'[]'::jsonb));
 elsif p_operation='begin_delivery' then
 if not p_payload ?& array['result_id'] or p_payload-array['result_id']<>'{}'::jsonb then raise exception 'INVALID_REMOTE_INPUT'; end if;
 perform public.remote_result_uuid(p_payload->'result_id');
 select * into result from public.remote_reviewed_results where id=(p_payload->>'result_id')::uuid and binding_id=binding.id for update;
 if not found or result.state<>'available' or result.consent_expires_at<=now() or not exists(select 1 from public.remote_jobs where id=result.job_id and state='awaiting_student') then raise exception 'REMOTE_DELIVERY_DENIED'; end if;
 update public.remote_result_deliveries set state='denied',nonce='' where result_id=result.id and phone_session_ref=p_phone_session and state in ('waiting_local','ready') and expires_at<=now();
 select * into delivery from public.remote_result_deliveries where result_id=result.id and phone_session_ref=p_phone_session and state in ('waiting_local','ready');
 if not found then
 perform pg_catalog.pg_advisory_xact_lock(298327494);
 if result.delivery_requests>=20 or (select count(*) from public.remote_result_deliveries where account_id=auth.uid())>=200
 or (select count(*) from public.remote_result_deliveries)>=2000 then raise exception 'REMOTE_RATE_LIMITED'; end if;
 update public.remote_reviewed_results set delivery_requests=delivery_requests+1 where id=result.id;
 insert into public.remote_result_deliveries(result_id,binding_id,account_id,phone_session_ref,nonce) values(result.id,binding.id,binding.account_id,p_phone_session,encode(extensions.gen_random_bytes(16),'hex')) returning * into delivery;
 end if;
 return jsonb_build_object('id',delivery.id,'state',delivery.state,'expires_at',delivery.expires_at);
 elsif p_operation='read' then
 if not p_payload ?& array['delivery_id'] or p_payload-array['delivery_id']<>'{}'::jsonb then raise exception 'INVALID_REMOTE_INPUT'; end if;
 perform public.remote_result_uuid(p_payload->'delivery_id');
 select * into delivery from public.remote_result_deliveries where id=(p_payload->>'delivery_id')::uuid and binding_id=binding.id and phone_session_ref=p_phone_session for update;
 if not found or delivery.state<>'ready' or delivery.ready_expires_at<=now() or delivery.expires_at<=now() then raise exception 'REMOTE_DELIVERY_WAITING'; end if;
 select * into result from public.remote_reviewed_results where id=delivery.result_id;
 if result.state<>'available' or result.result_text is null or result.consent_expires_at<=now() or not exists(select 1 from public.remote_jobs where id=result.job_id and state='awaiting_student') then raise exception 'REMOTE_DELIVERY_DENIED'; end if;
 update public.remote_result_deliveries set state='consumed',nonce='' where id=delivery.id;
 return jsonb_build_object('id',result.id,'local_result_id',result.local_result_id,'text',result.result_text,'result_sha256',result.result_sha256,
 'review_hash',result.review_hash,'policy',result.policy,'delivery_id',delivery.id,'fresh_local_check',true);
 else raise exception 'INVALID_REMOTE_OPERATION'; end if;
end; $$;
revoke all on function public.remote_result_device(uuid,text,uuid,text,jsonb) from public;
grant execute on function public.remote_result_device(uuid,text,uuid,text,jsonb) to anon,authenticated;
revoke all on function public.remote_result_phone(uuid,uuid,text,jsonb) from public,anon;
grant execute on function public.remote_result_phone(uuid,uuid,text,jsonb) to authenticated;
create function public.remote_result_purge_expired() returns void language plpgsql security definer set search_path='' as $$
begin delete from public.remote_result_deliveries where expires_at<now(); delete from public.remote_reviewed_results where purge_at<=now(); end; $$;
revoke all on function public.remote_result_purge_expired() from public,anon,authenticated;
grant execute on function public.remote_result_purge_expired() to service_role;
-- Deploy a verified scheduler for BOTH purge functions; migration alone does not promise retention.
commit;

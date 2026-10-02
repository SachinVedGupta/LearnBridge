-- Private student state. No service-role key is used by normal app requests.
create table public.student_state (
 user_id uuid not null references auth.users(id) on delete cascade,
 kind text not null check (kind in ('tasks','draft')),
 value jsonb not null,
 revision bigint not null default 1,
 updated_at timestamptz not null default now(),
 primary key(user_id,kind),
 check (octet_length(value::text) <= 500000)
);
alter table public.student_state enable row level security;
revoke all on public.student_state from anon, authenticated;
grant select,insert,update,delete on public.student_state to authenticated;
create policy own_state_select on public.student_state for select to authenticated using ((select auth.uid())=user_id);
create policy own_state_insert on public.student_state for insert to authenticated with check ((select auth.uid())=user_id);
create policy own_state_update on public.student_state for update to authenticated using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);
create policy own_state_delete on public.student_state for delete to authenticated using ((select auth.uid())=user_id);

create table public.usage_windows (
 user_id uuid not null references auth.users(id) on delete cascade,
 kind text not null,
 window_start timestamptz not null,
 count integer not null,
 primary key(user_id,kind,window_start)
);
alter table public.usage_windows enable row level security;
revoke all on public.usage_windows from anon,authenticated;
create function public.consume_usage(p_kind text) returns boolean language plpgsql security definer set search_path='' as $$
declare v_count integer; v_limit integer;
begin
 if auth.uid() is null then return false; end if;
 if p_kind='ai' then v_limit:=30; elsif p_kind='connector' then v_limit:=100; else return false; end if;
 insert into public.usage_windows as u(user_id,kind,window_start,count)
 values(auth.uid(),p_kind,date_trunc('hour',now()),1)
 on conflict(user_id,kind,window_start) do update set count=u.count+1 where u.count<v_limit
 returning count into v_count;
 return v_count is not null;
end; $$;
revoke all on function public.consume_usage(text) from public,anon;
grant execute on function public.consume_usage(text) to authenticated;

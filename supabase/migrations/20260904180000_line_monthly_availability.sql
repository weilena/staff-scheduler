-- LINE 員工整月回報可上班／休假；管理員核准後才寫入 config.employees[].availX。
create table if not exists public.availability_requests (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  emp_id text not null,
  work_date date not null,
  request_kind text not null check (request_kind in ('available','leave')),
  requested jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists availability_requests_one_pending_day
  on public.availability_requests(emp_id,work_date) where status='pending';
create index if not exists availability_requests_emp_month
  on public.availability_requests(emp_id,work_date,created_at desc);

alter table public.availability_requests enable row level security;
drop policy if exists auth_admin_all on public.availability_requests;
create policy auth_admin_all on public.availability_requests for all to authenticated
  using ((auth.jwt()->'app_metadata'->>'role') in ('owner','manager'))
  with check ((auth.jwt()->'app_metadata'->>'role') in ('owner','manager'));
grant select,insert,update,delete on public.availability_requests to authenticated;
grant all on public.availability_requests to service_role;

create or replace function public.review_availability_request(p_request uuid,p_status text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.availability_requests%rowtype;
begin
  if auth.uid() is null or coalesce(auth.jwt()->'app_metadata'->>'role','') not in ('owner','manager') then
    return jsonb_build_object('ok',false,'msg','需要管理員權限');
  end if;
  if p_status not in ('approved','rejected') then return jsonb_build_object('ok',false,'msg','審核狀態錯誤'); end if;
  select * into r from public.availability_requests where id=p_request for update;
  if r.id is null or r.status<>'pending' then return jsonb_build_object('ok',false,'msg','申請不存在或已處理'); end if;
  if p_status='approved' then
    update public.config c set data=jsonb_set(c.data,'{employees}',coalesce((
      select jsonb_agg(case when e->>'id'=r.emp_id then
        jsonb_set(e,'{availX}',coalesce(e->'availX','{}'::jsonb)||jsonb_build_object(r.work_date::text,
          r.requested||jsonb_build_object('source','line_approved','approvedRequestId',r.id::text)),true)
        else e end)
      from jsonb_array_elements(coalesce(c.data->'employees','[]'::jsonb)) e
    ),'[]'::jsonb),true),updated_at=now() where c.id=1;
  end if;
  update public.availability_requests set status=p_status,reviewed_by=auth.uid(),reviewed_at=now(),updated_at=now() where id=r.id;
  insert into public.audit_log(actor_type,actor_id,action,target_type,target_id,details)
  values('supabase_admin',auth.uid()::text,'review_availability_request','availability_request',r.id::text,
    jsonb_build_object('status',p_status,'empId',r.emp_id,'date',r.work_date,'requested',r.requested));
  return jsonb_build_object('ok',true);
end $$;

create or replace function public.review_availability_batch(p_batch uuid,p_status text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare item record; n int:=0; result jsonb;
begin
  if auth.uid() is null or coalesce(auth.jwt()->'app_metadata'->>'role','') not in ('owner','manager') then
    return jsonb_build_object('ok',false,'msg','需要管理員權限');
  end if;
  for item in select id from public.availability_requests where batch_id=p_batch and status='pending' order by work_date for update loop
    result:=public.review_availability_request(item.id,p_status);
    if coalesce((result->>'ok')::boolean,false) then n:=n+1; end if;
  end loop;
  return jsonb_build_object('ok',true,'count',n);
end $$;

revoke all on function public.review_availability_request(uuid,text) from public,anon;
revoke all on function public.review_availability_batch(uuid,text) from public,anon;
grant execute on function public.review_availability_request(uuid,text) to authenticated;
grant execute on function public.review_availability_batch(uuid,text) to authenticated;

-- 每位員工每月薪資審核。保存核准當下的計算快照，來源改變後前端可要求重新核准。
create table if not exists public.payroll_month_reviews (
  emp_id text not null,
  payroll_month text not null check (payroll_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  status text not null default 'pending' check (status in ('pending','approved')),
  total_amount integer not null default 0,
  snapshot jsonb not null default '{}'::jsonb,
  note text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (emp_id,payroll_month)
);

alter table public.payroll_month_reviews enable row level security;
drop policy if exists auth_admin_all on public.payroll_month_reviews;
create policy auth_admin_all on public.payroll_month_reviews
  for all to authenticated
  using ((auth.jwt()->'app_metadata'->>'role') in ('owner','manager'))
  with check ((auth.jwt()->'app_metadata'->>'role') in ('owner','manager'));

create or replace function public.review_payroll_month(
  p_emp text,
  p_month text,
  p_status text,
  p_total integer,
  p_snapshot jsonb default '{}'::jsonb,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_before public.payroll_month_reviews%rowtype;
  v_after public.payroll_month_reviews%rowtype;
begin
  if coalesce(auth.jwt()->'app_metadata'->>'role','') not in ('owner','manager') then
    return jsonb_build_object('ok',false,'msg','只有管理員可以審核薪資');
  end if;
  if p_status not in ('pending','approved') then
    return jsonb_build_object('ok',false,'msg','薪資審核狀態錯誤');
  end if;
  if p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    return jsonb_build_object('ok',false,'msg','薪資月份格式錯誤');
  end if;
  if p_total is null or p_total < 0 then
    return jsonb_build_object('ok',false,'msg','薪資總額不正確');
  end if;

  select * into v_before from public.payroll_month_reviews
  where emp_id=p_emp and payroll_month=p_month for update;

  insert into public.payroll_month_reviews(
    emp_id,payroll_month,status,total_amount,snapshot,note,reviewed_by,reviewed_at,updated_at
  ) values (
    p_emp,p_month,p_status,p_total,coalesce(p_snapshot,'{}'::jsonb),nullif(trim(coalesce(p_note,'')),''),
    case when p_status='approved' then auth.uid() else null end,
    case when p_status='approved' then now() else null end,now()
  )
  on conflict (emp_id,payroll_month) do update set
    status=excluded.status,
    total_amount=excluded.total_amount,
    snapshot=excluded.snapshot,
    note=excluded.note,
    reviewed_by=excluded.reviewed_by,
    reviewed_at=excluded.reviewed_at,
    updated_at=now()
  returning * into v_after;

  insert into public.audit_log(actor_type,actor_id,action,target_type,target_id,details)
  values(
    'supabase_admin',auth.uid()::text,
    case when p_status='approved' then 'approve_payroll_month' else 'revert_payroll_month' end,
    'payroll_month_reviews',p_emp||':'||p_month,
    jsonb_build_object(
      'before',case when v_before.emp_id is null then null else jsonb_build_object('status',v_before.status,'total_amount',v_before.total_amount,'reviewed_at',v_before.reviewed_at) end,
      'after',jsonb_build_object('status',v_after.status,'total_amount',v_after.total_amount,'reviewed_at',v_after.reviewed_at),
      'note',v_after.note
    )
  );
  return jsonb_build_object('ok',true,'status',v_after.status,'reviewed_at',v_after.reviewed_at);
end $$;

revoke all on function public.review_payroll_month(text,text,text,integer,jsonb,text) from public,anon;
grant execute on function public.review_payroll_month(text,text,text,integer,jsonb,text) to authenticated;
revoke all on table public.payroll_month_reviews from anon;
grant select,insert,update,delete on table public.payroll_month_reviews to authenticated;

-- LINE 整月可上班／休假改為直接生效，並另存「本月已填完」狀態。
create table if not exists public.availability_month_confirmations (
  emp_id text not null,
  month text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  confirmed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (emp_id, month)
);

alter table public.availability_month_confirmations enable row level security;
drop policy if exists auth_admin_read on public.availability_month_confirmations;
create policy auth_admin_read on public.availability_month_confirmations for select to authenticated
  using ((auth.jwt()->'app_metadata'->>'role') in ('owner','manager'));
grant select on public.availability_month_confirmations to authenticated;
grant all on public.availability_month_confirmations to service_role;

-- 只開放給 Edge Function 的 service role，原子更新單一員工的 availX，避免覆蓋其他管理員同時編輯的資料。
create or replace function public.apply_line_availability(p_emp_id text, p_entries jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare changed int:=0;
begin
  if jsonb_typeof(p_entries)<>'object' then
    return jsonb_build_object('ok',false,'msg','可上班資料格式錯誤');
  end if;
  update public.config c set data=jsonb_set(c.data,'{employees}',coalesce((
    select jsonb_agg(case when e->>'id'=p_emp_id then
      jsonb_set(e,'{availX}',coalesce(e->'availX','{}'::jsonb)||p_entries,true)
    else e end)
    from jsonb_array_elements(coalesce(c.data->'employees','[]'::jsonb)) e
  ),'[]'::jsonb),true),updated_at=now() where c.id=1;
  get diagnostics changed=row_count;
  return jsonb_build_object('ok',changed=1);
end $$;

-- 舊版還在待審的回報一次性改為直接生效，不讓員工重新填寫。
do $$
declare r public.availability_requests%rowtype;
begin
  for r in select * from public.availability_requests where status='pending' order by created_at loop
    perform public.apply_line_availability(r.emp_id,jsonb_build_object(r.work_date::text,
      r.requested||jsonb_build_object('source','line_direct','updatedAt',now())));
    update public.availability_requests set status='approved',reviewed_at=now(),updated_at=now() where id=r.id;
  end loop;
end $$;

revoke all on function public.apply_line_availability(text,jsonb) from public,anon,authenticated;
grant execute on function public.apply_line_availability(text,jsonb) to service_role;

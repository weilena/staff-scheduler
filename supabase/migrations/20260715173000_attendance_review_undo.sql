-- 工時審核可單筆／批次處理，也可撤回成待審；每次變更保留前後值。
create or replace function public.review_attendance_day(
  p_emp text,
  p_date date,
  p_status text,
  p_payable integer,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_old public.attendance_daily%rowtype;
  v_new public.attendance_daily%rowtype;
begin
  if p_status not in ('approved','rejected','pending') then
    return jsonb_build_object('ok',false,'msg','審核狀態錯誤');
  end if;
  if p_status='approved' and (p_payable is null or p_payable<0 or p_payable>1440) then
    return jsonb_build_object('ok',false,'msg','計薪分鐘不正確');
  end if;

  select * into v_old
  from public.attendance_daily
  where emp_id=p_emp and work_date=p_date
  for update;

  if v_old.emp_id is null then
    return jsonb_build_object('ok',false,'msg','請先重新計算該日出勤');
  end if;

  update public.attendance_daily
  set status=p_status,
      payable_minutes=case
        when p_status='approved' then p_payable
        when p_status='pending' then actual_minutes
        else 0
      end,
      note=nullif(trim(coalesce(p_note,'')),''),
      reviewed_by=case when p_status='pending' then null else auth.uid() end,
      reviewed_at=case when p_status='pending' then null else now() end,
      updated_at=now()
  where emp_id=p_emp and work_date=p_date
  returning * into v_new;

  insert into public.audit_log(actor_type,actor_id,action,target_type,target_id,details)
  values(
    'supabase_admin',auth.uid()::text,
    case when p_status='pending' then 'revert_attendance_review' else 'review_attendance_day' end,
    'attendance_daily',p_emp||':'||p_date::text,
    jsonb_build_object(
      'before',jsonb_build_object('status',v_old.status,'payable_minutes',v_old.payable_minutes,'note',v_old.note,'reviewed_by',v_old.reviewed_by,'reviewed_at',v_old.reviewed_at),
      'after',jsonb_build_object('status',v_new.status,'payable_minutes',v_new.payable_minutes,'note',v_new.note,'reviewed_by',v_new.reviewed_by,'reviewed_at',v_new.reviewed_at)
    )
  );
  return jsonb_build_object('ok',true);
end $$;

grant execute on function public.review_attendance_day(text,date,text,integer,text) to authenticated;

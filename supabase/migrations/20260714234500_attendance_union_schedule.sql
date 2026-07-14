-- 每日排班時數以時間區間聯集計算，避免同一人同時擔任櫃台與主題場控時重複加總。
-- 所有 cancelled_* 狀態都不列入排班時數。
create or replace function public.recalculate_attendance_day(p_emp text,p_date date)
returns public.attendance_daily
language plpgsql security definer set search_path=public as $$
declare
  p record;
  v_open text;
  v_actual integer := 0;
  v_scheduled integer := 0;
  v_sched_start integer;
  v_sched_end integer;
  v_start integer;
  v_end integer;
  v_anomalies text[] := '{}';
  v_result public.attendance_daily%rowtype;
begin
  for p in
    select ts,type from public.punches
    where emp_id=p_emp and left(ts,10)=p_date::text and voided_at is null
    order by ts,id
  loop
    if p.type='in' then
      if v_open is not null then v_anomalies:=array_append(v_anomalies,'重複上班卡'); end if;
      v_open:=p.ts;
    elsif v_open is null then
      v_anomalies:=array_append(v_anomalies,'缺上班卡');
    else
      v_actual:=v_actual+greatest(0,
        (split_part(substr(p.ts,12,5),':',1)::int*60+split_part(substr(p.ts,12,5),':',2)::int)-
        (split_part(substr(v_open,12,5),':',1)::int*60+split_part(substr(v_open,12,5),':',2)::int));
      v_open:=null;
    end if;
  end loop;
  if v_open is not null then v_anomalies:=array_append(v_anomalies,'缺下班卡'); end if;

  for p in
    select
      split_part(s.data->>'start',':',1)::int*60+split_part(s.data->>'start',':',2)::int as start_min,
      split_part(s.data->>'end',':',1)::int*60+split_part(s.data->>'end',':',2)::int as end_min
    from public.shifts s
    where s.date=p_date::text
      and coalesce(s.data->>'status','active') not like 'cancelled%'
      and exists(select 1 from jsonb_array_elements(coalesce(s.data->'assignments','[]'::jsonb)) a where a->>'empId'=p_emp)
    order by start_min,end_min
  loop
    v_start:=p.start_min; v_end:=p.end_min;
    if v_sched_start is null then
      v_sched_start:=v_start; v_sched_end:=v_end;
    elsif v_start<=v_sched_end then
      v_sched_end:=greatest(v_sched_end,v_end);
    else
      v_scheduled:=v_scheduled+greatest(0,v_sched_end-v_sched_start);
      v_sched_start:=v_start; v_sched_end:=v_end;
    end if;
  end loop;
  if v_sched_start is not null then v_scheduled:=v_scheduled+greatest(0,v_sched_end-v_sched_start); end if;

  insert into public.attendance_daily(emp_id,work_date,scheduled_minutes,actual_minutes,payable_minutes,anomalies,status,updated_at)
  values(p_emp,p_date,v_scheduled,v_actual,
    case when coalesce(array_length(v_anomalies,1),0)=0 then v_actual else null end,
    v_anomalies,case when coalesce(array_length(v_anomalies,1),0)>0 then 'anomaly' else 'pending' end,now())
  on conflict(emp_id,work_date) do update set
    scheduled_minutes=excluded.scheduled_minutes,
    actual_minutes=excluded.actual_minutes,
    payable_minutes=case
      when attendance_daily.status='approved'
       and attendance_daily.scheduled_minutes=excluded.scheduled_minutes
       and attendance_daily.actual_minutes=excluded.actual_minutes
       and attendance_daily.anomalies=excluded.anomalies then attendance_daily.payable_minutes
      else excluded.payable_minutes end,
    anomalies=excluded.anomalies,
    status=case
      when attendance_daily.status='approved'
       and attendance_daily.scheduled_minutes=excluded.scheduled_minutes
       and attendance_daily.actual_minutes=excluded.actual_minutes
       and attendance_daily.anomalies=excluded.anomalies then 'approved'
      else excluded.status end,
    reviewed_by=case when attendance_daily.status='approved' and attendance_daily.actual_minutes=excluded.actual_minutes then attendance_daily.reviewed_by else null end,
    reviewed_at=case when attendance_daily.status='approved' and attendance_daily.actual_minutes=excluded.actual_minutes then attendance_daily.reviewed_at else null end,
    updated_at=now()
  returning * into v_result;
  return v_result;
end $$;

grant execute on function public.recalculate_attendance_day(text,date) to authenticated,service_role;

do $$ declare r record; begin
  for r in select distinct emp_id,left(ts,10)::date d from public.punches where voided_at is null loop
    perform public.recalculate_attendance_day(r.emp_id,r.d);
  end loop;
end $$;

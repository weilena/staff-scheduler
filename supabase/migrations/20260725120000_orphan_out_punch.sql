-- 補卡與即時打卡脫鉤:忘記上班打卡時,下班卡不再被擋,改為即時記錄真正的下班時間並標記異常,
-- 缺的上班卡由員工另外提出補卡、管理員審核補上;兩者互不影響其他打卡時間,員工不必等審核才能打卡。
create or replace function public.record_line_punch(
  p_emp text,p_type text,p_worksite text,p_lat double precision,p_lng double precision,
  p_accuracy double precision,p_verification text,p_shift_ids text[],p_raw jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_last text;
  v_last_ts text;
  v_ts text;
  v_today text;
  v_id text;
  v_orphan_out boolean := false;
  v_day public.attendance_daily%rowtype;
begin
  if p_type not in ('in','out') then raise exception '打卡類型錯誤'; end if;
  perform pg_advisory_xact_lock(hashtext(p_emp));

  v_ts:=to_char(now() at time zone 'Asia/Taipei','YYYY-MM-DD"T"HH24:MI:SS');
  v_today:=left(v_ts,10);
  select type,ts into v_last,v_last_ts
  from public.punches
  where emp_id=p_emp and voided_at is null
  order by ts desc,id desc limit 1;

  if p_type='in' then
    -- 同一天重複上班仍禁止;前一天忘記下班只保留為該日異常,不阻擋今天重新上班。
    if v_last='in' and left(v_last_ts,10)=v_today then
      raise exception '今天目前已是上班狀態';
    end if;
  else
    -- 下班卡優先結束今天的上班卡;若今天沒有上班卡(忘記上班打卡),仍即時記錄真正的下班時間,
    -- 標記為異常交由補卡補上上班時間,不阻擋員工當場打卡,也不影響其他打卡時間。
    if coalesce(v_last,'')<>'in' or left(coalesce(v_last_ts,''),10)<>v_today then
      v_orphan_out := true;
    end if;
  end if;

  v_id:=gen_random_uuid()::text;
  insert into public.punches(id,emp_id,ts,type,source,worksite_id,latitude,longitude,accuracy_m,verification,raw,review_state,shift_ids)
  values(v_id,p_emp,v_ts,p_type,'line',p_worksite,p_lat,p_lng,p_accuracy,p_verification,coalesce(p_raw,'{}'::jsonb),
    case when v_orphan_out or p_verification<>'line_location' then 'anomaly' else 'verified' end,coalesce(p_shift_ids,'{}'));
  v_day:=public.recalculate_attendance_day(p_emp,v_today::date);
  insert into public.audit_log(actor_type,actor_id,action,target_type,target_id,details)
  values('line_employee',p_emp,'punch_'||p_type,'punch',v_id,jsonb_build_object('worksite',p_worksite,'verification',p_verification,'accuracy_m',p_accuracy,'orphan_out',v_orphan_out));
  return jsonb_build_object('ok',true,'id',v_id,'ts',v_ts,'type',p_type,'orphan_out',v_orphan_out,'daily_status',v_day.status,'anomalies',v_day.anomalies);
end $$;

grant execute on function public.record_line_punch(text,text,text,double precision,double precision,double precision,text,text[],jsonb) to service_role;

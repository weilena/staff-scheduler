-- 薪資級 LINE 打卡：原始紀錄不可覆寫、每日計薪審核、補卡落實與稽核。

alter table public.punches add column if not exists voided_at timestamptz;
alter table public.punches add column if not exists voided_by uuid;
alter table public.punches add column if not exists void_reason text;
alter table public.punches add column if not exists review_state text not null default 'legacy';
alter table public.punches add column if not exists shift_ids text[] not null default '{}';

do $$ begin
  alter table public.punches add constraint punches_review_state_check
    check (review_state in ('verified','anomaly','corrected','voided','legacy'));
exception when duplicate_object then null;
end $$;

create table if not exists public.attendance_daily (
  emp_id text not null,
  work_date date not null,
  scheduled_minutes integer not null default 0,
  actual_minutes integer not null default 0,
  payable_minutes integer,
  anomalies text[] not null default '{}',
  status text not null default 'pending' check (status in ('pending','approved','rejected','anomaly')),
  note text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key(emp_id,work_date)
);
create index if not exists attendance_daily_status_idx on public.attendance_daily(status,work_date);
alter table public.attendance_daily enable row level security;
drop policy if exists auth_admin_all on public.attendance_daily;
create policy auth_admin_all on public.attendance_daily for all to authenticated using (true) with check (true);

create or replace function public.recalculate_attendance_day(p_emp text,p_date date)
returns public.attendance_daily
language plpgsql security definer set search_path=public as $$
declare
  p record;
  v_open text;
  v_actual integer := 0;
  v_scheduled integer := 0;
  v_anomalies text[] := '{}';
  v_old public.attendance_daily%rowtype;
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

  select coalesce(sum(greatest(0,
    (split_part(s.data->>'end',':',1)::int*60+split_part(s.data->>'end',':',2)::int)-
    (split_part(s.data->>'start',':',1)::int*60+split_part(s.data->>'start',':',2)::int))),0)::int
  into v_scheduled
  from public.shifts s
  where s.date=p_date::text
    and coalesce(s.data->>'status','active')<>'cancelled'
    and exists(select 1 from jsonb_array_elements(coalesce(s.data->'assignments','[]'::jsonb)) a where a->>'empId'=p_emp);

  select * into v_old from public.attendance_daily where emp_id=p_emp and work_date=p_date;
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

create or replace function public.record_line_punch(
  p_emp text,p_type text,p_worksite text,p_lat double precision,p_lng double precision,
  p_accuracy double precision,p_verification text,p_shift_ids text[],p_raw jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_last text; v_ts text; v_id text; v_day public.attendance_daily%rowtype;
begin
  if p_type not in ('in','out') then raise exception '打卡類型錯誤'; end if;
  perform pg_advisory_xact_lock(hashtext(p_emp));
  select type into v_last from public.punches where emp_id=p_emp and voided_at is null order by ts desc,id desc limit 1;
  if v_last=p_type then
    raise exception using message=case when p_type='in' then '目前已是上班狀態' else '目前已是下班狀態' end;
  end if;
  if p_type='out' and coalesce(v_last,'')<>'in' then raise exception '目前沒有上班中的紀錄，請提出補卡申請'; end if;
  v_ts:=to_char(now() at time zone 'Asia/Taipei','YYYY-MM-DD"T"HH24:MI:SS');
  v_id:=gen_random_uuid()::text;
  insert into public.punches(id,emp_id,ts,type,source,worksite_id,latitude,longitude,accuracy_m,verification,raw,review_state,shift_ids)
  values(v_id,p_emp,v_ts,p_type,'line',p_worksite,p_lat,p_lng,p_accuracy,p_verification,coalesce(p_raw,'{}'::jsonb),
    case when p_verification='line_location' then 'verified' else 'anomaly' end,coalesce(p_shift_ids,'{}'));
  v_day:=public.recalculate_attendance_day(p_emp,left(v_ts,10)::date);
  insert into public.audit_log(actor_type,actor_id,action,target_type,target_id,details)
  values('line_employee',p_emp,'punch_'||p_type,'punch',v_id,jsonb_build_object('worksite',p_worksite,'verification',p_verification,'accuracy_m',p_accuracy));
  return jsonb_build_object('ok',true,'id',v_id,'ts',v_ts,'type',p_type,'daily_status',v_day.status,'anomalies',v_day.anomalies);
end $$;

create or replace function public.guard_punch_history()
returns trigger language plpgsql set search_path=public as $$
begin
  if tg_op='DELETE' then raise exception '原始打卡不可刪除，請使用作廢功能並填寫原因'; end if;
  if new.id is distinct from old.id or new.emp_id is distinct from old.emp_id or new.ts is distinct from old.ts
    or new.type is distinct from old.type or new.source is distinct from old.source
    or new.worksite_id is distinct from old.worksite_id or new.latitude is distinct from old.latitude
    or new.longitude is distinct from old.longitude or new.accuracy_m is distinct from old.accuracy_m
    or new.verification is distinct from old.verification or new.raw is distinct from old.raw then
    raise exception '原始打卡內容不可覆寫';
  end if;
  return new;
end $$;
drop trigger if exists guard_punch_history on public.punches;
create trigger guard_punch_history before update or delete on public.punches for each row execute function public.guard_punch_history();

create or replace function public.void_punch(p_id text,p_reason text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v public.punches%rowtype;
begin
  if length(trim(coalesce(p_reason,'')))<3 then return jsonb_build_object('ok',false,'msg','請填寫作廢原因'); end if;
  select * into v from public.punches where id=p_id for update;
  if v.id is null then return jsonb_build_object('ok',false,'msg','查無打卡紀錄'); end if;
  if v.voided_at is not null then return jsonb_build_object('ok',false,'msg','此紀錄已作廢'); end if;
  update public.punches set voided_at=now(),voided_by=auth.uid(),void_reason=trim(p_reason),review_state='voided' where id=p_id;
  perform public.recalculate_attendance_day(v.emp_id,left(v.ts,10)::date);
  insert into public.audit_log(actor_type,actor_id,action,target_type,target_id,details)
  values('supabase_admin',auth.uid()::text,'void_punch','punch',p_id,jsonb_build_object('reason',trim(p_reason),'original',to_jsonb(v)));
  return jsonb_build_object('ok',true);
end $$;

create or replace function public.review_attendance_day(p_emp text,p_date date,p_status text,p_payable integer,p_note text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
  if p_status not in ('approved','rejected') then return jsonb_build_object('ok',false,'msg','審核狀態錯誤'); end if;
  if p_status='approved' and (p_payable is null or p_payable<0 or p_payable>1440) then return jsonb_build_object('ok',false,'msg','計薪分鐘不正確'); end if;
  update public.attendance_daily set status=p_status,payable_minutes=case when p_status='approved' then p_payable else 0 end,
    note=nullif(trim(coalesce(p_note,'')),''),reviewed_by=auth.uid(),reviewed_at=now(),updated_at=now()
  where emp_id=p_emp and work_date=p_date;
  if not found then return jsonb_build_object('ok',false,'msg','請先重新計算該日出勤'); end if;
  insert into public.audit_log(actor_type,actor_id,action,target_type,target_id,details)
  values('supabase_admin',auth.uid()::text,'review_attendance_day','attendance_daily',p_emp||':'||p_date::text,
    jsonb_build_object('status',p_status,'payable_minutes',p_payable,'note',p_note));
  return jsonb_build_object('ok',true);
end $$;

create or replace function public.review_attendance_request(p_request uuid,p_status text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.attendance_requests%rowtype; v_time text; v_in text; v_out text;
begin
  if p_status not in ('approved','rejected') then return jsonb_build_object('ok',false,'msg','審核狀態錯誤'); end if;
  select * into r from public.attendance_requests where id=p_request for update;
  if r.id is null or r.status<>'pending' then return jsonb_build_object('ok',false,'msg','申請不存在或已處理'); end if;
  if p_status='approved' then
    v_time:=r.requested->>'time'; v_in:=r.requested->>'inTime'; v_out:=r.requested->>'outTime';
    if r.request_type in ('missing_in','missing_out') then
      if v_time is null or v_time!~'^([01][0-9]|2[0-3]):[0-5][0-9]$' then return jsonb_build_object('ok',false,'msg','補卡時間格式不正確'); end if;
      insert into public.punches(id,emp_id,ts,type,source,verification,raw,review_state)
      values(gen_random_uuid()::text,r.emp_id,r.punch_date::text||'T'||v_time||':00',case when r.request_type='missing_in' then 'in' else 'out' end,
        'admin_correction','manager_approved',jsonb_build_object('attendance_request_id',r.id),'corrected');
    elsif r.request_type='correction' then
      if v_in is null or v_out is null then return jsonb_build_object('ok',false,'msg','更正申請缺少上下班時間'); end if;
      insert into public.punches(id,emp_id,ts,type,source,verification,raw,review_state) values
        (gen_random_uuid()::text,r.emp_id,r.punch_date::text||'T'||v_in||':00','in','admin_correction','manager_approved',jsonb_build_object('attendance_request_id',r.id),'corrected'),
        (gen_random_uuid()::text,r.emp_id,r.punch_date::text||'T'||v_out||':00','out','admin_correction','manager_approved',jsonb_build_object('attendance_request_id',r.id),'corrected');
    end if;
    perform public.recalculate_attendance_day(r.emp_id,r.punch_date);
  end if;
  update public.attendance_requests set status=p_status,reviewed_by=auth.uid(),reviewed_at=now() where id=r.id;
  insert into public.audit_log(actor_type,actor_id,action,target_type,target_id,details)
  values('supabase_admin',auth.uid()::text,'review_attendance_request','attendance_request',r.id::text,jsonb_build_object('status',p_status,'requested',r.requested));
  return jsonb_build_object('ok',true);
end $$;

revoke all on function public.record_line_punch(text,text,text,double precision,double precision,double precision,text,text[],jsonb) from public,anon,authenticated;
grant execute on function public.record_line_punch(text,text,text,double precision,double precision,double precision,text,text[],jsonb) to service_role;
grant execute on function public.recalculate_attendance_day(text,date) to authenticated,service_role;
grant execute on function public.void_punch(text,text) to authenticated;
grant execute on function public.review_attendance_day(text,date,text,integer,text) to authenticated;
grant execute on function public.review_attendance_request(uuid,text) to authenticated;

do $$ declare r record; begin
  for r in select distinct emp_id,left(ts,10)::date d from public.punches loop
    perform public.recalculate_attendance_day(r.emp_id,r.d);
  end loop;
end $$;

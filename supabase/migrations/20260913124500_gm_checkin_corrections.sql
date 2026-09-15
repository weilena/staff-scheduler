-- 詭獄／詭獄加場的既有場控若忘記按本場完成，可申請補登並由管理員審核。
alter table public.attendance_requests drop constraint if exists attendance_requests_request_type_check;
alter table public.attendance_requests add constraint attendance_requests_request_type_check
  check (request_type in ('correction','missing_in','missing_out','npc_checkin','gm_checkin','gm_assist'));

create or replace function public.review_attendance_request(p_request uuid,p_status text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  r public.attendance_requests%rowtype;
  v_time text; v_in text; v_out text; v_shift text;
  v_work_item jsonb; v_raw jsonb; v_shift_data jsonb; v_assignments jsonb; v_shift_ids text[];
begin
  if p_status not in ('approved','rejected') then return jsonb_build_object('ok',false,'msg','審核狀態錯誤'); end if;
  select * into r from public.attendance_requests where id=p_request for update;
  if r.id is null or r.status<>'pending' then return jsonb_build_object('ok',false,'msg','申請不存在或已處理'); end if;
  if p_status='approved' then
    v_time:=r.requested->>'time'; v_in:=r.requested->>'inTime'; v_out:=r.requested->>'outTime'; v_shift:=r.requested->>'shiftId';
    v_work_item:=r.requested->'workItem'; v_shift_ids:=case when coalesce(v_shift,'')='' then '{}'::text[] else array[v_shift] end;
    if v_work_item is null or jsonb_array_length(coalesce(v_work_item->'labels','[]'::jsonb))=0 then return jsonb_build_object('ok',false,'msg','補卡缺少主題或工作項目'); end if;
    if r.request_type='gm_assist' then
      if v_time is null or v_time!~'^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(v_shift,'')='' then return jsonb_build_object('ok',false,'msg','協助場控缺少場次或時間'); end if;
      if coalesce(r.requested->>'themeName','') not like '詭獄%' then return jsonb_build_object('ok',false,'msg','這筆申請不是詭獄場控協助'); end if;
      select data into v_shift_data from public.shifts where id=v_shift and date=r.punch_date::text for update;
      if v_shift_data is null or coalesce(v_shift_data->>'status','active') like 'cancelled%' then return jsonb_build_object('ok',false,'msg','原場次不存在或已取消'); end if;
      v_assignments:=coalesce(v_shift_data->'assignments','[]'::jsonb);
      if not exists(select 1 from jsonb_array_elements(v_assignments) a where a->>'empId'=r.emp_id and a->>'role'='場控') then
        v_assignments:=v_assignments||jsonb_build_array(jsonb_build_object('role','場控','empId',r.emp_id,'assisted',true,'approvedRequestId',r.id::text));
        v_shift_data:=jsonb_set(jsonb_set(v_shift_data,'{assignments}',v_assignments,true),'{manualEdit}','true'::jsonb,true);
        update public.shifts set data=v_shift_data,updated_at=now() where id=v_shift;
      end if;
      insert into public.session_checkins(emp_id,shift_id,checked_in_at,worksite_id,latitude,longitude,accuracy_m,verification,source,note)
      values(r.emp_id,v_shift,r.punch_date::text||'T'||v_time||':00',r.requested->>'worksiteId',(r.requested->>'latitude')::double precision,
        (r.requested->>'longitude')::double precision,(r.requested->>'accuracy')::double precision,'manager_approved','line_gm_assist','正職協助詭獄場控・'||r.reason)
      on conflict(emp_id,shift_id) do update set checked_in_at=excluded.checked_in_at,worksite_id=excluded.worksite_id,latitude=excluded.latitude,
        longitude=excluded.longitude,accuracy_m=excluded.accuracy_m,verification=excluded.verification,source=excluded.source,note=excluded.note;
    elsif r.request_type in ('npc_checkin','gm_checkin') then
      if v_time is null or v_time!~'^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(v_shift,'')='' then return jsonb_build_object('ok',false,'msg','場次補登缺少場次或時間'); end if;
      insert into public.session_checkins(emp_id,shift_id,checked_in_at,verification,source,note)
      values(r.emp_id,v_shift,r.punch_date::text||'T'||v_time||':00','manager_approved','admin_correction',r.reason)
      on conflict(emp_id,shift_id) do update set checked_in_at=excluded.checked_in_at,verification=excluded.verification,source=excluded.source,note=excluded.note;
    else
      v_raw:=jsonb_build_object('attendance_request_id',r.id,'work_item',v_work_item);
      if r.request_type in ('missing_in','missing_out') then
        if v_time is null or v_time!~'^([01][0-9]|2[0-3]):[0-5][0-9]$' then return jsonb_build_object('ok',false,'msg','補卡時間格式不正確'); end if;
        insert into public.punches(id,emp_id,ts,type,source,verification,raw,review_state,shift_ids)
        values(gen_random_uuid()::text,r.emp_id,r.punch_date::text||'T'||v_time||':00',case when r.request_type='missing_in' then 'in' else 'out' end,'admin_correction','manager_approved',v_raw,'corrected',v_shift_ids);
      elsif r.request_type='correction' then
        if v_in is null or v_out is null or v_in>=v_out then return jsonb_build_object('ok',false,'msg','補卡缺少正確的上下班時間'); end if;
        insert into public.punches(id,emp_id,ts,type,source,verification,raw,review_state,shift_ids) values
          (gen_random_uuid()::text,r.emp_id,r.punch_date::text||'T'||v_in||':00','in','admin_correction','manager_approved',v_raw,'corrected',v_shift_ids),
          (gen_random_uuid()::text,r.emp_id,r.punch_date::text||'T'||v_out||':00','out','admin_correction','manager_approved',v_raw,'corrected',v_shift_ids);
      end if;
      perform public.recalculate_attendance_day(r.emp_id,r.punch_date);
    end if;
  end if;
  update public.attendance_requests set status=p_status,reviewed_by=auth.uid(),reviewed_at=now() where id=r.id;
  insert into public.audit_log(actor_type,actor_id,action,target_type,target_id,details)
  values('supabase_admin',auth.uid()::text,'review_attendance_request','attendance_request',r.id::text,jsonb_build_object('status',p_status,'requested',r.requested));
  return jsonb_build_object('ok',true);
end $$;

grant execute on function public.review_attendance_request(uuid,text) to authenticated;

-- 管理員替已結束但原本未排場控的詭獄場次指定實際執行者；班表與完成紀錄同一交易寫入。
create or replace function public.resolve_unassigned_gm(p_shift text,p_emp text,p_checked_at timestamptz,p_actor text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_data jsonb; v_assignments jsonb;
begin
  select data into v_data from public.shifts where id=p_shift for update;
  if v_data is null then return jsonb_build_object('ok',false,'msg','找不到原場次'); end if;
  v_assignments:=coalesce(v_data->'assignments','[]'::jsonb);
  if exists(select 1 from jsonb_array_elements(v_assignments) a where coalesce(a->>'empId','')<>'' and a->>'role'='場控') then
    return jsonb_build_object('ok',false,'msg','此場已有場控，請重新整理');
  end if;
  if exists(select 1 from public.session_checkins where emp_id=p_emp and shift_id=p_shift) then
    return jsonb_build_object('ok',false,'msg','此人已有場控完成紀錄');
  end if;
  if exists(select 1 from jsonb_array_elements(v_assignments) a where coalesce(a->>'empId','')='' and a->>'role'='場控') then
    select jsonb_agg(case when coalesce(a->>'empId','')='' and a->>'role'='場控'
      then jsonb_build_object('role','場控','empId',p_emp,'managerBackfilled',true) else a end)
    into v_assignments from jsonb_array_elements(v_assignments) a;
  else
    v_assignments:=v_assignments||jsonb_build_array(jsonb_build_object('role','場控','empId',p_emp,'managerBackfilled',true));
  end if;
  v_data:=jsonb_set(jsonb_set(jsonb_set(v_data,'{assignments}',v_assignments,true),'{manualEdit}','true'::jsonb,true),
    '{managerBackfilledAt}',to_jsonb(now()),true);
  update public.shifts set data=v_data,updated_at=now() where id=p_shift;
  insert into public.session_checkins(emp_id,shift_id,checked_in_at,verification,source,note)
  values(p_emp,p_shift,p_checked_at,'manager_approved','manager_direct','管理員補排詭獄場控並確認有執行');
  insert into public.audit_log(actor_type,actor_id,action,target_type,target_id,details)
  values('line_manager',p_actor,'manager_resolve_unassigned_gm','shift',p_shift,jsonb_build_object('empId',p_emp,'checkedInAt',p_checked_at));
  return jsonb_build_object('ok',true);
end $$;

grant execute on function public.resolve_unassigned_gm(text,text,timestamptz,text) to authenticated,service_role;

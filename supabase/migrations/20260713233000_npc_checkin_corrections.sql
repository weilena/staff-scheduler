-- 過去 NPC 場次以補報到處理，不建立假的下班卡。
alter table public.attendance_requests drop constraint if exists attendance_requests_request_type_check;
alter table public.attendance_requests add constraint attendance_requests_request_type_check
  check (request_type in ('correction','missing_in','missing_out','npc_checkin'));

create or replace function public.review_attendance_request(p_request uuid,p_status text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  r public.attendance_requests%rowtype;
  v_time text; v_in text; v_out text; v_shift text;
  v_work_item jsonb; v_raw jsonb;
begin
  if p_status not in ('approved','rejected') then return jsonb_build_object('ok',false,'msg','審核狀態錯誤'); end if;
  select * into r from public.attendance_requests where id=p_request for update;
  if r.id is null or r.status<>'pending' then return jsonb_build_object('ok',false,'msg','申請不存在或已處理'); end if;
  if p_status='approved' then
    v_time:=r.requested->>'time'; v_in:=r.requested->>'inTime'; v_out:=r.requested->>'outTime'; v_shift:=r.requested->>'shiftId';
    v_work_item:=r.requested->'workItem';
    if v_work_item is null or jsonb_array_length(coalesce(v_work_item->'labels','[]'::jsonb))=0 then return jsonb_build_object('ok',false,'msg','補卡缺少主題或工作項目'); end if;
    if r.request_type='npc_checkin' then
      if v_time is null or v_time!~'^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(v_shift,'')='' then return jsonb_build_object('ok',false,'msg','NPC 補報到缺少場次或時間'); end if;
      insert into public.session_checkins(emp_id,shift_id,checked_in_at,verification,source,note)
      values(r.emp_id,v_shift,r.punch_date::text||'T'||v_time||':00','manager_approved','admin_correction',r.reason)
      on conflict(emp_id,shift_id) do update set checked_in_at=excluded.checked_in_at,verification=excluded.verification,source=excluded.source,note=excluded.note;
    else
      v_raw:=jsonb_build_object('attendance_request_id',r.id,'work_item',v_work_item);
      if r.request_type in ('missing_in','missing_out') then
        if v_time is null or v_time!~'^([01][0-9]|2[0-3]):[0-5][0-9]$' then return jsonb_build_object('ok',false,'msg','補卡時間格式不正確'); end if;
        insert into public.punches(id,emp_id,ts,type,source,verification,raw,review_state)
        values(gen_random_uuid()::text,r.emp_id,r.punch_date::text||'T'||v_time||':00',case when r.request_type='missing_in' then 'in' else 'out' end,'admin_correction','manager_approved',v_raw,'corrected');
      elsif r.request_type='correction' then
        if v_in is null or v_out is null or v_in>=v_out then return jsonb_build_object('ok',false,'msg','補卡缺少正確的上下班時間'); end if;
        insert into public.punches(id,emp_id,ts,type,source,verification,raw,review_state) values
          (gen_random_uuid()::text,r.emp_id,r.punch_date::text||'T'||v_in||':00','in','admin_correction','manager_approved',v_raw,'corrected'),
          (gen_random_uuid()::text,r.emp_id,r.punch_date::text||'T'||v_out||':00','out','admin_correction','manager_approved',v_raw,'corrected');
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

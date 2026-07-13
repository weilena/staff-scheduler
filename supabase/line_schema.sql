-- LINE 員工入口、定位打卡、換班與通知擴充
-- 既有專案請在 Supabase SQL Editor 執行本檔一次。

create extension if not exists pgcrypto;

create table if not exists line_accounts (
  emp_id text primary key,
  line_user_id text unique not null,
  display_name text,
  role text not null default 'employee' check (role in ('employee','manager')),
  active boolean not null default true,
  bound_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists line_bind_codes (
  code text primary key,
  emp_id text not null,
  role text not null default 'employee' check (role in ('employee','manager')),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists line_bind_codes_emp_idx on line_bind_codes(emp_id);

create table if not exists worksites (
  id text primary key,
  name text not null,
  latitude double precision,
  longitude double precision,
  radius_m integer not null default 200 check (radius_m between 20 and 2000),
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
insert into worksites(id,name) values ('dz','大忠店'),('ms','謎先生')
on conflict (id) do nothing;

alter table punches add column if not exists worksite_id text references worksites(id);
alter table punches add column if not exists latitude double precision;
alter table punches add column if not exists longitude double precision;
alter table punches add column if not exists accuracy_m double precision;
alter table punches add column if not exists verification text not null default 'legacy';
alter table punches add column if not exists raw jsonb not null default '{}'::jsonb;

create table if not exists attendance_requests (
  id uuid primary key default gen_random_uuid(),
  emp_id text not null,
  punch_date date not null,
  request_type text not null default 'correction' check (request_type in ('correction','missing_in','missing_out')),
  requested jsonb not null default '{}'::jsonb,
  reason text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists overtime_reviews (
  id uuid primary key default gen_random_uuid(),
  emp_id text not null,
  work_date date not null,
  scheduled_minutes integer not null default 0,
  actual_minutes integer not null default 0,
  candidate_minutes integer not null default 0,
  approved_minutes integer,
  status text not null default 'pending' check (status in ('pending','approved','rejected','anomaly')),
  note text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique(emp_id,work_date)
);

create table if not exists shift_requests (
  id uuid primary key default gen_random_uuid(),
  request_type text not null check (request_type in ('extra','give','swap')),
  shift_id text not null references shifts(id),
  requester_emp_id text,
  offered_shift_id text references shifts(id),
  target_emp_id text,
  selected_emp_id text,
  status text not null default 'open' check (status in ('open','pending_manager','completed','cancelled','expired')),
  deadline timestamptz,
  details jsonb not null default '{}'::jsonb,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists shift_requests_status_idx on shift_requests(status,deadline);

create table if not exists shift_request_responses (
  request_id uuid not null references shift_requests(id) on delete cascade,
  emp_id text not null,
  response text not null check (response in ('accept','decline')),
  reason text,
  responded_at timestamptz not null default now(),
  primary key(request_id,emp_id)
);

create table if not exists notification_outbox (
  id uuid primary key default gen_random_uuid(),
  recipient_emp_id text,
  recipient_line_user_id text,
  category text not null,
  critical boolean not null default false,
  chargeable boolean not null default true,
  payload jsonb not null default '{}'::jsonb,
  idempotency_key text unique,
  status text not null default 'pending' check (status in ('pending','sent','skipped','failed')),
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notification_outbox_pending_idx on notification_outbox(status,created_at);

create table if not exists message_usage (
  month text primary key check (month ~ '^\d{4}-\d{2}$'),
  chargeable_count integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists line_events (
  event_id text primary key,
  event_type text,
  processed_at timestamptz not null default now()
);

create table if not exists audit_log (
  id bigint generated always as identity primary key,
  actor_type text not null,
  actor_id text,
  action text not null,
  target_type text,
  target_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table line_accounts enable row level security;
alter table line_bind_codes enable row level security;
alter table worksites enable row level security;
alter table attendance_requests enable row level security;
alter table overtime_reviews enable row level security;
alter table shift_requests enable row level security;
alter table shift_request_responses enable row level security;
alter table notification_outbox enable row level security;
alter table message_usage enable row level security;
alter table line_events enable row level security;
alter table audit_log enable row level security;

-- 管理後台使用 Supabase Authentication；員工資料一律經驗證 LINE Token 的 Edge Function。
do $$
declare t text;
begin
  foreach t in array array['line_accounts','line_bind_codes','worksites','attendance_requests',
    'overtime_reviews','shift_requests','shift_request_responses','notification_outbox','message_usage','audit_log']
  loop
    execute format('drop policy if exists auth_admin_all on %I',t);
    execute format('create policy auth_admin_all on %I for all to authenticated using (true) with check (true)',t);
  end loop;
end $$;

-- 只完成資料列鎖定與人員交換；完整資格檢查由 staff-api 在呼叫前執行，函式內再驗證身分與狀態。
create or replace function accept_shift_request(p_request uuid, p_line_user_id text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  r shift_requests%rowtype;
  account line_accounts%rowtype;
  target shifts%rowtype;
  offered shifts%rowtype;
  target_data jsonb;
  offered_data jsonb;
begin
  select * into account from line_accounts where line_user_id=p_line_user_id and active=true;
  if account.emp_id is null then return jsonb_build_object('ok',false,'msg','LINE 尚未綁定或帳號已停用'); end if;

  select * into r from shift_requests where id=p_request for update;
  if r.id is null or r.status<>'open' then return jsonb_build_object('ok',false,'msg','此申請已結束'); end if;
  if r.deadline is not null and r.deadline<now() then
    update shift_requests set status='expired',updated_at=now() where id=r.id;
    return jsonb_build_object('ok',false,'msg','此申請已截止');
  end if;
  if r.target_emp_id is not null and r.target_emp_id<>account.emp_id then
    return jsonb_build_object('ok',false,'msg','這不是指定給你的申請');
  end if;

  insert into shift_request_responses(request_id,emp_id,response)
  values(r.id,account.emp_id,'accept')
  on conflict(request_id,emp_id) do update set response='accept',responded_at=now();

  if r.request_type='extra' then
    return jsonb_build_object('ok',true,'pending_manager',true,'msg','已登記願意接班，請等待管理員選人');
  end if;

  select * into target from shifts where id=r.shift_id for update;
  if target.id is null or target.data->>'status'='cancelled' then
    return jsonb_build_object('ok',false,'msg','班次不存在或已取消');
  end if;
  target_data:=target.data;
  if not exists(select 1 from jsonb_array_elements(target_data->'assignments') a where a->>'empId'=r.requester_emp_id) then
    return jsonb_build_object('ok',false,'msg','原班次人員已變更');
  end if;
  target_data:=jsonb_set(target_data,'{assignments}',(
    select jsonb_agg(case when a->>'empId'=r.requester_emp_id then jsonb_set(a,'{empId}',to_jsonb(account.emp_id)) else a end)
    from jsonb_array_elements(target_data->'assignments') a));

  if r.request_type='swap' then
    if r.offered_shift_id is null then return jsonb_build_object('ok',false,'msg','缺少交換班次'); end if;
    select * into offered from shifts where id=r.offered_shift_id for update;
    if offered.id is null or offered.data->>'status'='cancelled' then return jsonb_build_object('ok',false,'msg','交換班次不存在或已取消'); end if;
    offered_data:=offered.data;
    if not exists(select 1 from jsonb_array_elements(offered_data->'assignments') a where a->>'empId'=account.emp_id) then
      return jsonb_build_object('ok',false,'msg','你已不在交換班次中');
    end if;
    offered_data:=jsonb_set(offered_data,'{assignments}',(
      select jsonb_agg(case when a->>'empId'=account.emp_id then jsonb_set(a,'{empId}',to_jsonb(r.requester_emp_id)) else a end)
      from jsonb_array_elements(offered_data->'assignments') a));
    update shifts set data=offered_data,updated_at=now() where id=offered.id;
  end if;

  update shifts set data=target_data,updated_at=now() where id=target.id;
  update shift_requests set status='completed',selected_emp_id=account.emp_id,completed_at=now(),updated_at=now(),
    details=details||jsonb_build_object('before_target',target.data,'before_offered',case when r.request_type='swap' then offered.data else null end)
    where id=r.id;
  insert into audit_log(actor_type,actor_id,action,target_type,target_id,details)
  values('line_employee',account.emp_id,'accept_shift_request','shift_request',r.id::text,jsonb_build_object('type',r.request_type));
  return jsonb_build_object('ok',true,'msg',case when r.request_type='swap' then '換班完成' else '接班完成' end);
end $$;

revoke all on function accept_shift_request(uuid,text) from public,anon,authenticated;
grant execute on function accept_shift_request(uuid,text) to service_role;

create or replace function revert_shift_request(p_request uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r shift_requests%rowtype;
begin
  if auth.uid() is null then return jsonb_build_object('ok',false,'msg','需要管理員登入'); end if;
  select * into r from shift_requests where id=p_request for update;
  if r.id is null or r.status<>'completed' or r.request_type not in ('give','swap') then
    return jsonb_build_object('ok',false,'msg','此申請無法撤銷');
  end if;
  if r.details->'before_target' is null then return jsonb_build_object('ok',false,'msg','缺少原始班表快照'); end if;
  update shifts set data=r.details->'before_target',updated_at=now() where id=r.shift_id;
  if r.request_type='swap' and r.offered_shift_id is not null and r.details->'before_offered' is not null then
    update shifts set data=r.details->'before_offered',updated_at=now() where id=r.offered_shift_id;
  end if;
  update shift_requests set status='cancelled',updated_at=now(),details=details||jsonb_build_object('reverted_at',now(),'reverted_by',auth.uid()) where id=r.id;
  insert into audit_log(actor_type,actor_id,action,target_type,target_id,details)
  values('supabase_admin',auth.uid()::text,'revert_shift_request','shift_request',r.id::text,'{}'::jsonb);
  if r.requester_emp_id is not null then
    insert into notification_outbox(recipient_emp_id,category,critical,payload,idempotency_key)
    values(r.requester_emp_id,'shift_reverted',true,jsonb_build_object('title','換班已撤銷','text','管理員已撤銷班表異動，請重新查看班表。'),'revert:'||r.id::text||':'||r.requester_emp_id)
    on conflict(idempotency_key) do nothing;
  end if;
  if r.selected_emp_id is not null then
    insert into notification_outbox(recipient_emp_id,category,critical,payload,idempotency_key)
    values(r.selected_emp_id,'shift_reverted',true,jsonb_build_object('title','換班已撤銷','text','管理員已撤銷班表異動，請重新查看班表。'),'revert:'||r.id::text||':'||r.selected_emp_id)
    on conflict(idempotency_key) do nothing;
  end if;
  return jsonb_build_object('ok',true,'msg','已恢復原班表');
end $$;

revoke all on function revert_shift_request(uuid) from public,anon;
grant execute on function revert_shift_request(uuid) to authenticated;

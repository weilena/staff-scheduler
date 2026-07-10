-- 排班打卡系統 雲端版 資料庫結構
-- 在 Supabase Dashboard → SQL Editor 貼上全部執行一次即可

-- ============ 資料表 ============

-- 設定檔(店別/主題/員工/技能/可上班時間/店休日/規則),單列 JSONB
create table if not exists config (
  id int primary key default 1 check (id = 1),
  data jsonb not null,
  updated_at timestamptz default now()
);

-- 班次(手動排班 + SimplyBook 自動同步)
create table if not exists shifts (
  id text primary key,
  date text not null,
  source text default 'manual',       -- manual | simplybook
  data jsonb not null,                -- 完整班次物件(含 assignments)
  updated_at timestamptz default now()
);
create index if not exists shifts_date_idx on shifts(date);

-- 打卡紀錄
create table if not exists punches (
  id text primary key,
  emp_id text not null,
  ts text not null,                   -- 'YYYY-MM-DDTHH:MM:SS'(台灣時間)
  type text not null check (type in ('in','out')),
  source text default 'qr',           -- qr | admin | import
  created_at timestamptz default now()
);
create index if not exists punches_emp_idx on punches(emp_id, ts);

-- ============ 權限(RLS)============
alter table config enable row level security;
alter table shifts enable row level security;
alter table punches enable row level security;

-- 登入的管理者(老闆/店長帳號)有完整權限
create policy "auth_all_config"  on config  for all to authenticated using (true) with check (true);
create policy "auth_all_shifts"  on shifts  for all to authenticated using (true) with check (true);
create policy "auth_all_punches" on punches for all to authenticated using (true) with check (true);
-- 匿名(店員打卡頁)不能直接讀寫任何表,只能透過下面的 RPC

-- ============ QR 打卡 RPC(店員手機用,免登入,以個人 PIN 驗證)============

-- 取得打卡名單(只回傳有設 PIN 的在職員工,不外洩其他資料)
create or replace function punch_roster()
returns table(id text, name text)
language sql security definer set search_path = public as $$
  select e->>'id', e->>'name'
  from config, jsonb_array_elements(data->'employees') e
  where (e->>'active')::boolean and coalesce(e->>'pin','') <> ''
$$;

-- 打卡(驗 PIN 後寫入)
create or replace function do_punch(p_emp text, p_pin text, p_type text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_emp jsonb; v_ts text;
begin
  select e into v_emp from config, jsonb_array_elements(data->'employees') e
   where e->>'id' = p_emp;
  if v_emp is null then return jsonb_build_object('ok',false,'msg','查無員工'); end if;
  if coalesce(v_emp->>'pin','') = '' or v_emp->>'pin' <> p_pin then
    return jsonb_build_object('ok',false,'msg','PIN 錯誤');
  end if;
  if p_type not in ('in','out') then
    return jsonb_build_object('ok',false,'msg','類型錯誤');
  end if;
  v_ts := to_char(now() at time zone 'Asia/Taipei', 'YYYY-MM-DD"T"HH24:MI:SS');
  insert into punches(id, emp_id, ts, type, source)
  values (md5(random()::text || clock_timestamp()::text), p_emp, v_ts, p_type, 'qr');
  return jsonb_build_object('ok',true,'ts',v_ts,'name',v_emp->>'name','type',p_type);
end $$;

-- 查詢自己今天的打卡狀態(驗 PIN)
create or replace function punch_status(p_emp text, p_pin text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_emp jsonb; v_last record; v_today jsonb;
begin
  select e into v_emp from config, jsonb_array_elements(data->'employees') e
   where e->>'id' = p_emp;
  if v_emp is null or coalesce(v_emp->>'pin','') = '' or v_emp->>'pin' <> p_pin then
    return jsonb_build_object('ok',false,'msg','PIN 錯誤');
  end if;
  select p.type, p.ts into v_last from punches p
   where p.emp_id = p_emp order by p.ts desc limit 1;
  select coalesce(jsonb_agg(jsonb_build_object('type',p.type,'ts',p.ts) order by p.ts),'[]'::jsonb)
    into v_today
    from punches p
   where p.emp_id = p_emp
     and p.ts like to_char(now() at time zone 'Asia/Taipei','YYYY-MM-DD') || '%';
  return jsonb_build_object('ok',true,'name',v_emp->>'name',
    'last_type',v_last.type,'last_ts',v_last.ts,'today',v_today);
end $$;

grant execute on function punch_roster() to anon;
grant execute on function do_punch(text,text,text) to anon;
grant execute on function punch_status(text,text) to anon;

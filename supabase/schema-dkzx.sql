-- 打卡之星原始資料留底表(在 Supabase SQL Editor 執行一次)
create table if not exists dkzx_raw (
  id text primary key,               -- 抓取日期 YYYY-MM-DD
  fetched_at timestamptz default now(),
  payload jsonb not null             -- 報表頁完整傾印(表格+API 回應)
);
alter table dkzx_raw enable row level security;
-- 不建立任何 policy:僅 Edge Function(service role)可存取
create policy "auth_read_dkzx" on dkzx_raw for select to authenticated using (true);

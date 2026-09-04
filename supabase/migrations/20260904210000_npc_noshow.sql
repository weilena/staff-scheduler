-- NPC 放鳥(客人沒到場):LINE@ 場次確認時,NPC 可回報「客人放鳥」→ 記 1 小時放鳥時數。
-- 場控放鳥無薪,故 staff-api 只在 NPC 角色時寫入 no_show=true。
alter table public.session_checkins add column if not exists no_show boolean not null default false;

-- 放鳥每日場次 RPC:給薪資「計薪每日場次 CSV」的「放鳥場次」列使用。
create or replace function public.npc_noshow_day_counts(p_from text, p_to text)
returns table(emp_id text, store_id text, theme_id text, d text, cnt bigint)
language sql stable security definer set search_path to 'public' as $fn$
  select c.emp_id, s.data->>'storeId', s.data->>'themeId', s.date::text, count(*)::bigint
  from public.session_checkins c
  join public.shifts s on s.id = c.shift_id
  where c.no_show = true and s.date >= p_from and s.date <= p_to and s.data->>'kind' = 'theme'
  group by 1,2,3,4;
$fn$;
grant execute on function public.npc_noshow_day_counts(text,text) to anon, authenticated, service_role;

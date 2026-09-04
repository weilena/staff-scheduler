-- 計薪用「每日場次」RPC:員工 × 店 × 主題 × 角色 × 日期 的場次數。
-- 前端「主題場次統計」頁的「⬇ 計薪每日場次 CSV」用它產出可貼入薪資表的每日明細。
-- 平日/國定的拆分由前端用 config.settings.holidays(國定假日清單)判斷;詭獄加場由前端 baseThemeName 併入詭獄。
-- 放鳥場次待 LINE@ 放鳥鍵完成後另行併入。
create or replace function public.emp_payroll_day_counts(p_from text, p_to text)
returns table(emp_id text, store_id text, theme_id text, role text, d text, cnt bigint)
language sql stable security definer set search_path to 'public' as $fn$
  select a->>'empId', s.data->>'storeId', s.data->>'themeId', a->>'role', s.date::text, count(*)::bigint
  from public.shifts s
  cross join lateral jsonb_array_elements(coalesce(s.data->'assignments','[]'::jsonb)) a
  where s.date >= p_from and s.date <= p_to
    and s.data->>'kind' = 'theme'
    and coalesce(s.data->>'status','active') not like 'cancelled%'
    and coalesce(a->>'empId','') <> ''
  group by 1,2,3,4,5;
$fn$;
grant execute on function public.emp_payroll_day_counts(text,text) to anon, authenticated, service_role;

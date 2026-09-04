-- 員工 × 主題 每月場次統計 RPC
-- 前端「主題場次統計」頁用來顯示：每位員工本月在各主題各排了幾場(含 NPC／場控等所有角色)。
-- 與 theme_month_counts 一致:只算 kind='theme' 且未取消的班次;數字由資料庫直接算,避免瀏覽器抓全部班次(超過 1000 筆會被截斷)。
create or replace function public.emp_theme_month_counts(p_from text, p_to text)
returns table(emp_id text, store_id text, theme_id text, cnt bigint)
language sql stable security definer set search_path to 'public' as $fn$
  select a->>'empId', s.data->>'storeId', s.data->>'themeId', count(*)::bigint
  from public.shifts s
  cross join lateral jsonb_array_elements(coalesce(s.data->'assignments','[]'::jsonb)) a
  where s.date >= p_from and s.date <= p_to
    and s.data->>'kind' = 'theme'
    and coalesce(s.data->>'status','active') not like 'cancelled%'
    and coalesce(a->>'empId','') <> ''
  group by 1,2,3;
$fn$;
grant execute on function public.emp_theme_month_counts(text,text) to anon, authenticated, service_role;

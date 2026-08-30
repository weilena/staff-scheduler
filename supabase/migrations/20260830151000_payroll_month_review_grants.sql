-- 補強已部署之薪資審核物件權限：匿名使用者不可讀取或執行，僅管理員 JWT 可通過 RLS／函式檢查。
revoke all on function public.review_payroll_month(text,text,text,integer,jsonb,text) from public,anon;
grant execute on function public.review_payroll_month(text,text,text,integer,jsonb,text) to authenticated;
revoke all on table public.payroll_month_reviews from anon;
grant select,insert,update,delete on table public.payroll_month_reviews to authenticated;

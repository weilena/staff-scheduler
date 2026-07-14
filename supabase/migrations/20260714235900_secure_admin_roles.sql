-- LINE 員工不使用 Supabase Auth；既有 Auth 帳號皆為目前管理後台帳號。
-- 將最早建立者設為帳號擁有者，其餘既有帳號設為一般管理者。
with ranked as (
  select id, row_number() over (order by created_at, id) as seq
  from auth.users
  where deleted_at is null
)
update auth.users as users
set raw_app_meta_data = coalesce(users.raw_app_meta_data, '{}'::jsonb)
  || jsonb_build_object('role', case when ranked.seq = 1 then 'owner' else 'manager' end)
from ranked
where users.id = ranked.id
  and coalesce(users.raw_app_meta_data->>'role', '') not in ('owner', 'manager');

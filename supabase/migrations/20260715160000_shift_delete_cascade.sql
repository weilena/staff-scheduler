-- 修正:刪除班次被換班申請的外鍵擋住(shift_requests_shift_id_fkey violates)
-- 班次刪除時:其換班申請一併刪除(回覆已對 request cascade);
-- 若刪的是「被提議交換的班次」,申請保留、欄位改為 NULL。
alter table public.shift_requests
  drop constraint shift_requests_shift_id_fkey,
  add constraint shift_requests_shift_id_fkey
    foreign key (shift_id) references public.shifts(id) on delete cascade;

alter table public.shift_requests
  drop constraint shift_requests_offered_shift_id_fkey,
  add constraint shift_requests_offered_shift_id_fkey
    foreign key (offered_shift_id) references public.shifts(id) on delete set null;

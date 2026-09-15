-- 將員工場次報到與客人到場狀態拆開：員工可先提前報到，稍後再填客人是否放鳥。
alter table public.session_checkins add column if not exists guest_status text;
alter table public.session_checkins add column if not exists guest_status_at timestamptz;
alter table public.session_checkins add column if not exists guest_status_by text;

alter table public.session_checkins drop constraint if exists session_checkins_guest_status_check;
alter table public.session_checkins add constraint session_checkins_guest_status_check
  check (guest_status is null or guest_status in ('arrived', 'no_show'));

-- 舊資料只有 no_show=true 才能確定曾選「放鳥」；false 可能是未填，不能誤判成客人有來。
update public.session_checkins
set guest_status = 'no_show',
    guest_status_at = coalesce(guest_status_at, checked_in_at::timestamp at time zone 'Asia/Taipei')
where no_show = true and guest_status is null;

comment on column public.session_checkins.guest_status is '客況：arrived=無（客人有來）、no_show=放鳥；null=尚未確認';
comment on column public.session_checkins.guest_status_at is '客況最後確認時間';
comment on column public.session_checkins.guest_status_by is '最後確認客況的員工 ID';

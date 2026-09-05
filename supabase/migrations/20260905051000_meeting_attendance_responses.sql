-- 同一張確認表同時保存一般班次「已收到」與會議出席回覆。
alter table public.shift_confirmations
  drop constraint if exists shift_confirmations_status_check;

alter table public.shift_confirmations
  add constraint shift_confirmations_status_check
  check (status in ('confirmed', 'attending', 'declined'));


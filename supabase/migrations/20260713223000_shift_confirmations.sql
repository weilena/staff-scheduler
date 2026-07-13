-- 員工透過 LINE 確認已收到排班。
create table if not exists public.shift_confirmations (
  shift_id text not null,
  emp_id text not null,
  status text not null default 'confirmed' check(status in ('confirmed')),
  confirmed_at timestamptz not null default now(),
  source text not null default 'line',
  primary key(shift_id,emp_id)
);

create index if not exists shift_confirmations_emp_idx on public.shift_confirmations(emp_id,confirmed_at desc);
alter table public.shift_confirmations enable row level security;
drop policy if exists auth_admin_all on public.shift_confirmations;
create policy auth_admin_all on public.shift_confirmations for all to authenticated using (true) with check (true);
grant all on public.shift_confirmations to authenticated,service_role;

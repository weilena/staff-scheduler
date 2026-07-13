-- NPC 依場次報到，不以工時計：每位員工每場只留一筆報到紀錄。
create table if not exists public.session_checkins (
  id uuid primary key default gen_random_uuid(),
  emp_id text not null,
  shift_id text not null,
  checked_in_at text not null,
  worksite_id text,
  latitude double precision,
  longitude double precision,
  accuracy_m double precision,
  verification text not null default 'line_location',
  source text not null default 'line',
  note text,
  created_at timestamptz not null default now(),
  unique(emp_id,shift_id)
);

create index if not exists session_checkins_emp_time_idx on public.session_checkins(emp_id,checked_in_at desc);
alter table public.session_checkins enable row level security;
drop policy if exists auth_admin_all on public.session_checkins;
create policy auth_admin_all on public.session_checkins for all to authenticated using (true) with check (true);
grant all on public.session_checkins to authenticated,service_role;

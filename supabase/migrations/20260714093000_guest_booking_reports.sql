create table if not exists public.guest_booking_reports (
  id uuid primary key default gen_random_uuid(),
  emp_id text not null,
  shift_id text not null references public.shifts(id) on delete cascade,
  customer_type text not null check (customer_type in ('walk_in','reservation')),
  surname text not null,
  phone text not null,
  party_size integer not null check (party_size between 1 and 99),
  note text not null default '',
  status text not null default 'pending' check (status in ('pending','confirmed','rejected')),
  manager_reply text not null default '',
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists guest_booking_reports_status_idx
  on public.guest_booking_reports(status, created_at desc);

alter table public.guest_booking_reports enable row level security;
drop policy if exists auth_admin_all on public.guest_booking_reports;
revoke all on public.guest_booking_reports from anon, authenticated;
grant all on public.guest_booking_reports to service_role;

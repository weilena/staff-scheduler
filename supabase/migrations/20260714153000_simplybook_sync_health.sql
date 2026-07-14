create table if not exists public.integration_sync_runs (
  id bigint generated always as identity primary key,
  integration text not null,
  status text not null check (status in ('running','success','error')),
  trigger_source text not null default 'manual',
  range_from date,
  range_to date,
  fetched_count integer not null default 0,
  changed_count integer not null default 0,
  ignored_count integer not null default 0,
  error_message text,
  details jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists integration_sync_runs_latest_idx
  on public.integration_sync_runs(integration, started_at desc);

alter table public.integration_sync_runs enable row level security;
drop policy if exists integration_sync_runs_admin_read on public.integration_sync_runs;
create policy integration_sync_runs_admin_read on public.integration_sync_runs
  for select to authenticated using (true);
grant select on public.integration_sync_runs to authenticated;
grant all on public.integration_sync_runs to service_role;

-- pg_cron calls the Edge Function every minute.  The Edge Function performs a
-- second database-side time gate, so webhook/manual/cron calls cannot fan out
-- into duplicate API reads or duplicate LINE notifications.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create or replace function public.try_start_integration_sync(
  p_integration text,
  p_trigger_source text,
  p_range_from date,
  p_range_to date,
  p_min_interval_seconds integer default 45
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  perform pg_advisory_xact_lock(hashtext('integration-sync:' || p_integration));
  if exists (
    select 1 from public.integration_sync_runs
    where integration = p_integration
      and started_at > now() - make_interval(secs => p_min_interval_seconds)
  ) then
    return null;
  end if;
  insert into public.integration_sync_runs(
    integration,status,trigger_source,range_from,range_to
  ) values (
    p_integration,'running',p_trigger_source,p_range_from,p_range_to
  ) returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.try_start_integration_sync(text,text,date,date,integer) from public,anon,authenticated;
grant execute on function public.try_start_integration_sync(text,text,date,date,integer) to service_role;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'simplybook-sync-every-minute') then
    perform cron.unschedule('simplybook-sync-every-minute');
  end if;
  perform cron.schedule(
    'simplybook-sync-every-minute',
    '* * * * *',
    $job$
      select net.http_post(
        url := 'https://xrkdwdcsyzivkjankfsg.supabase.co/functions/v1/sb-sync?apply=1&source=database-cron',
        headers := jsonb_build_object('content-type','application/json','x-supabase-cron','1'),
        body := '{}'::jsonb,
        timeout_milliseconds := 50000
      );
    $job$
  );
end $$;

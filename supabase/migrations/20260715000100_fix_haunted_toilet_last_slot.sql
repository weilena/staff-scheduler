-- Correct the final 詭廁 slot in production configuration immediately.
update public.config as config
set data = jsonb_set(
  config.data,
  '{themes}',
  coalesce((
    select jsonb_agg(
      case
        when theme.value->>'id' = 'gc' or theme.value->>'name' = '詭廁' then
          jsonb_set(
            theme.value,
            '{slots}',
            coalesce((
              select jsonb_agg(
                to_jsonb(case when slot.value = '20:20' then '20:00' else slot.value end)
                order by slot.ordinality
              )
              from jsonb_array_elements_text(coalesce(theme.value->'slots', '[]'::jsonb)) with ordinality as slot(value, ordinality)
            ), '[]'::jsonb)
          )
        else theme.value
      end
      order by theme.ordinality
    )
    from jsonb_array_elements(coalesce(config.data->'themes', '[]'::jsonb)) with ordinality as theme(value, ordinality)
  ), '[]'::jsonb),
  true
)
where config.id = 1;

-- Correct only manually-created historical/future shifts. SimplyBook remains authoritative for its own bookings.
update public.shifts
set data = jsonb_set(jsonb_set(data, '{start}', '"20:00"'::jsonb), '{end}', '"21:30"'::jsonb),
    updated_at = now()
where source = 'manual'
  and data->>'themeId' = 'gc'
  and data->>'start' = '20:20';

alter table public.worksites add column if not exists address text;

insert into public.worksites(id,name,address,latitude,longitude,radius_m,enabled,updated_at) values
  ('dz','勃根地大忠店','臺中市西區大忠街21號',24.144356997751,120.656631030448,200,true,now()),
  ('ms','謎先生','臺中市西區市府路39號10樓',24.137674986449,120.677875969875,200,true,now())
on conflict (id) do update set
  name=excluded.name,
  address=excluded.address,
  latitude=excluded.latitude,
  longitude=excluded.longitude,
  radius_m=excluded.radius_m,
  enabled=true,
  updated_at=now();

update public.config
set data=jsonb_set(
  data,
  '{stores}',
  coalesce((
    select jsonb_agg(
      case
        when item->>'id'='dz' then jsonb_set(item,'{name}',to_jsonb('勃根地大忠店'::text),true)
        when item->>'id'='ms' then jsonb_set(item,'{name}',to_jsonb('謎先生'::text),true)
        else item
      end
    )
    from jsonb_array_elements(coalesce(data->'stores','[]'::jsonb)) item
  ),'[]'::jsonb),
  true
)
where id=1;

create or replace function public.get_export_players()
returns table (
  player_id uuid,
  display_name text,
  player_color text,
  home_lat double precision,
  home_lng double precision,
  home_updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $get_export_players$
declare
  v_player_id uuid = auth.uid();
begin
  if v_player_id is null then
    return;
  end if;

  return query
  select
    profile.id as player_id,
    profile.display_name,
    profile.player_color,
    home.lat as home_lat,
    home.lng as home_lng,
    home.updated_at as home_updated_at
  from public.profiles profile
  left join public.export_player_home_bases home on home.player_id = profile.id
  where profile.player_mode = 'export'
  order by profile.display_name;
end;
$get_export_players$;

do $backfill_export_physical_coordinates$
declare
  v_pin record;
  v_home_config jsonb = public.home_base_config();
  v_physical_lat double precision;
  v_physical_lng double precision;
begin
  for v_pin in
    select
      pin.id,
      pin.lat,
      pin.lng,
      home.lat as export_home_lat,
      home.lng as export_home_lng
    from public.pins pin
    join public.profiles profile on profile.id = pin.owner_id
    join public.export_player_home_bases home on home.player_id = pin.owner_id
    where profile.player_mode = 'export'
      and pin.disabled_at is null
      and pin.physical_lat is null
      and pin.physical_lng is null
  loop
    select projected.lat, projected.lng
    into v_physical_lat, v_physical_lng
    from public.project_coordinate_between_homes(
      (v_home_config ->> 'lat')::double precision,
      (v_home_config ->> 'lng')::double precision,
      v_pin.export_home_lat,
      v_pin.export_home_lng,
      v_pin.lat,
      v_pin.lng
    ) projected;

    if not (
      v_physical_lat between -90 and 90
      and v_physical_lng between -180 and 180
    ) then
      continue;
    end if;

    update public.pins
    set physical_lat = v_physical_lat,
        physical_lng = v_physical_lng
    where id = v_pin.id;
  end loop;
end;
$backfill_export_physical_coordinates$;

grant execute on function public.get_export_players() to authenticated;

notify pgrst, 'reload schema';

drop function if exists public.export_place_pin(double precision, double precision, text, text, double precision);

create or replace function public.export_place_pin(
  p_lat double precision,
  p_lng double precision,
  p_name text,
  p_pin_type text default 'standard',
  p_accuracy_m double precision default null,
  p_projected_lat double precision default null,
  p_projected_lng double precision default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $export_place_pin$
declare
  v_player_id uuid = auth.uid();
  v_now timestamptz = now();
  v_cost numeric(12, 2) = public.export_config_number('shop_cost', 100);
  v_profile public.profiles;
  v_score public.location_score_cache;
  v_pin public.pins;
  v_balance numeric(12, 2);
  v_export_home public.export_player_home_bases;
  v_home_config jsonb = public.home_base_config();
  v_projected record;
  v_projected_lat double precision;
  v_projected_lng double precision;
  v_physical_geog extensions.geography;
  v_projected_geog extensions.geography;
  v_physical_distance_m double precision;
  v_projected_distance_m double precision;
begin
  if v_player_id is null then
    raise exception 'You must be signed in.';
  end if;

  if public.profile_player_mode(v_player_id) <> 'export' then
    raise exception 'Only export players can build this way.';
  end if;

  if p_accuracy_m is not null and p_accuracy_m > 100 then
    raise exception 'Location accuracy is too low.';
  end if;

  if p_pin_type not in ('standard', 'temporary') then
    raise exception 'Unsupported pin type.';
  end if;

  if not (
    p_lat between -90 and 90
    and p_lng between -180 and 180
  ) then
    raise exception 'Choose a valid physical shop location.';
  end if;

  select * into v_export_home
  from public.export_player_home_bases
  where player_id = v_player_id;

  if not found then
    raise exception 'An admin needs to set your export home base first.';
  end if;

  if (p_projected_lat is null) <> (p_projected_lng is null) then
    raise exception 'Projected shop coordinates are incomplete.';
  end if;

  if p_projected_lat is null then
    select * into v_projected
    from public.project_coordinate_between_homes(
      v_export_home.lat,
      v_export_home.lng,
      (v_home_config ->> 'lat')::double precision,
      (v_home_config ->> 'lng')::double precision,
      p_lat,
      p_lng
    );

    v_projected_lat = v_projected.lat;
    v_projected_lng = v_projected.lng;
  else
    v_projected_lat = p_projected_lat;
    v_projected_lng = p_projected_lng;
  end if;

  if not (
    v_projected_lat between -90 and 90
    and v_projected_lng between -180 and 180
  ) then
    raise exception 'Projected shop location is invalid.';
  end if;

  v_physical_geog = extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography;
  v_projected_geog = extensions.st_setsrid(extensions.st_makepoint(v_projected_lng, v_projected_lat), 4326)::extensions.geography;
  v_physical_distance_m = extensions.st_distance(v_export_home.geog, v_physical_geog);
  v_projected_distance_m = extensions.st_distance(public.home_base_geog(), v_projected_geog);

  if abs(v_projected_distance_m - v_physical_distance_m) > greatest(250, v_physical_distance_m * 0.15) then
    raise exception 'Projected shop location does not match your travelled distance.';
  end if;

  perform public._settle_player_income(v_player_id);

  select * into v_profile
  from public.profiles
  where id = v_player_id
  for update;

  if not found then
    raise exception 'Profile was not found.';
  end if;

  if v_profile.points_balance < v_cost then
    raise exception 'Not enough tokens.';
  end if;

  v_score = public.score_location(v_projected_lat, v_projected_lng);

  insert into public.pins (
    owner_id,
    name,
    pin_type,
    lat,
    lng,
    physical_lat,
    physical_lng,
    busy_score,
    score_cell_key,
    placed_at,
    visible_at,
    last_restocked_at,
    restock_due_at,
    expires_at
  )
  values (
    v_player_id,
    left(coalesce(nullif(trim(p_name), ''), 'New Shop'), 80),
    p_pin_type,
    v_projected_lat,
    v_projected_lng,
    p_lat,
    p_lng,
    v_score.busy_score,
    v_score.score_cell_key,
    v_now,
    v_now,
    case when p_pin_type = 'standard' then v_now else null end,
    case when p_pin_type = 'standard' then v_now + interval '48 hours' else null end,
    case when p_pin_type = 'temporary' then v_now + interval '72 hours' else null end
  )
  returning * into v_pin;

  update public.profiles
  set points_balance = points_balance - v_cost
  where id = v_player_id
  returning points_balance into v_balance;

  insert into public.currency_ledger (
    player_id,
    amount_points,
    balance_after,
    reason,
    source_pin_id
  )
  values (
    v_player_id,
    -v_cost,
    v_balance,
    'export_pin_purchase',
    v_pin.id
  );

  perform public.recalculate_income_periods_near(v_pin.geog, v_now);

  return jsonb_build_object(
    'pin_id', v_pin.id,
    'balance', v_balance,
    'busy_score', v_pin.busy_score,
    'physical_lat', p_lat,
    'physical_lng', p_lng,
    'projected_lat', v_pin.lat,
    'projected_lng', v_pin.lng
  );
end;
$export_place_pin$;

do $repair_export_pin_projections$
declare
  v_pin record;
  v_home_config jsonb = public.home_base_config();
  v_now timestamptz = now();
  v_projected_lat double precision;
  v_projected_lng double precision;
  v_projected_geog extensions.geography;
  v_score public.location_score_cache;
begin
  for v_pin in
    select
      pin.*,
      home.lat as export_home_lat,
      home.lng as export_home_lng
    from public.pins pin
    join public.profiles profile on profile.id = pin.owner_id
    join public.export_player_home_bases home on home.player_id = pin.owner_id
    where profile.player_mode = 'export'
      and pin.disabled_at is null
      and pin.physical_lat is not null
      and pin.physical_lng is not null
  loop
    select projected.lat, projected.lng
    into v_projected_lat, v_projected_lng
    from public.project_coordinate_between_homes(
      v_pin.export_home_lat,
      v_pin.export_home_lng,
      (v_home_config ->> 'lat')::double precision,
      (v_home_config ->> 'lng')::double precision,
      v_pin.physical_lat,
      v_pin.physical_lng
    ) projected;

    if not (
      v_projected_lat between -90 and 90
      and v_projected_lng between -180 and 180
    ) then
      continue;
    end if;

    v_projected_geog = extensions.st_setsrid(
      extensions.st_makepoint(v_projected_lng, v_projected_lat),
      4326
    )::extensions.geography;

    if extensions.st_distance(v_pin.geog, v_projected_geog) <= 25 then
      continue;
    end if;

    perform public.recalculate_income_periods_near(v_pin.geog, v_now);
    v_score = public.score_location(v_projected_lat, v_projected_lng);

    update public.pins
    set lat = v_projected_lat,
        lng = v_projected_lng,
        busy_score = v_score.busy_score,
        score_cell_key = v_score.score_cell_key
    where id = v_pin.id;

    perform public.recalculate_income_periods_near(v_projected_geog, v_now);
  end loop;
end;
$repair_export_pin_projections$;

grant execute on function public.export_place_pin(
  double precision,
  double precision,
  text,
  text,
  double precision,
  double precision,
  double precision
) to authenticated;

notify pgrst, 'reload schema';

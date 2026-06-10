alter table public.pins
add column if not exists physical_lat double precision,
add column if not exists physical_lng double precision,
add column if not exists physical_geog extensions.geography(Point, 4326);

do $pin_physical_coordinate_constraints$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pins_physical_lat_check'
      and conrelid = 'public.pins'::regclass
  ) then
    alter table public.pins
    add constraint pins_physical_lat_check
    check (physical_lat is null or physical_lat between -90 and 90);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'pins_physical_lng_check'
      and conrelid = 'public.pins'::regclass
  ) then
    alter table public.pins
    add constraint pins_physical_lng_check
    check (physical_lng is null or physical_lng between -180 and 180);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'pins_physical_coordinate_pair_check'
      and conrelid = 'public.pins'::regclass
  ) then
    alter table public.pins
    add constraint pins_physical_coordinate_pair_check
    check ((physical_lat is null) = (physical_lng is null));
  end if;
end;
$pin_physical_coordinate_constraints$;

create or replace function public.set_pin_geog()
returns trigger
language plpgsql
set search_path = public, extensions
as $set_pin_geog$
begin
  new.geog = extensions.st_setsrid(extensions.st_makepoint(new.lng, new.lat), 4326)::extensions.geography;

  if new.physical_lat is null or new.physical_lng is null then
    new.physical_geog = null;
  else
    new.physical_geog = extensions.st_setsrid(
      extensions.st_makepoint(new.physical_lng, new.physical_lat),
      4326
    )::extensions.geography;
  end if;

  return new;
end;
$set_pin_geog$;

drop trigger if exists pins_set_geog on public.pins;
create trigger pins_set_geog
before insert or update of lat, lng, physical_lat, physical_lng on public.pins
for each row execute function public.set_pin_geog();

create or replace function public.project_coordinate_between_homes(
  p_source_home_lat double precision,
  p_source_home_lng double precision,
  p_target_home_lat double precision,
  p_target_home_lng double precision,
  p_lat double precision,
  p_lng double precision
)
returns table (
  lat double precision,
  lng double precision,
  distance_m double precision,
  bearing_radians double precision
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $project_coordinate_between_homes$
declare
  v_earth_radius_m constant double precision = 6371000.0;
  v_source_home_geog extensions.geography;
  v_point_geog extensions.geography;
  v_source_lat double precision = radians(p_source_home_lat);
  v_source_lng double precision = radians(p_source_home_lng);
  v_point_lat double precision = radians(p_lat);
  v_point_lng double precision = radians(p_lng);
  v_target_lat double precision = radians(p_target_home_lat);
  v_target_lng double precision = radians(p_target_home_lng);
  v_delta_lng double precision = radians(p_lng - p_source_home_lng);
  v_bearing double precision;
  v_distance double precision;
  v_angular_distance double precision;
  v_projected_lat double precision;
  v_projected_lng double precision;
begin
  if not (
    p_source_home_lat between -90 and 90
    and p_target_home_lat between -90 and 90
    and p_lat between -90 and 90
    and p_source_home_lng between -180 and 180
    and p_target_home_lng between -180 and 180
    and p_lng between -180 and 180
  ) then
    raise exception 'Choose valid coordinates.';
  end if;

  v_source_home_geog = extensions.st_setsrid(
    extensions.st_makepoint(p_source_home_lng, p_source_home_lat),
    4326
  )::extensions.geography;
  v_point_geog = extensions.st_setsrid(
    extensions.st_makepoint(p_lng, p_lat),
    4326
  )::extensions.geography;
  v_distance = extensions.st_distance(v_source_home_geog, v_point_geog);
  v_bearing = atan2(
    sin(v_delta_lng) * cos(v_point_lat),
    cos(v_source_lat) * sin(v_point_lat) -
      sin(v_source_lat) * cos(v_point_lat) * cos(v_delta_lng)
  );
  v_angular_distance = v_distance / v_earth_radius_m;
  v_projected_lat = asin(
    sin(v_target_lat) * cos(v_angular_distance) +
      cos(v_target_lat) * sin(v_angular_distance) * cos(v_bearing)
  );
  v_projected_lng =
    v_target_lng +
    atan2(
      sin(v_bearing) * sin(v_angular_distance) * cos(v_target_lat),
      cos(v_angular_distance) - sin(v_target_lat) * sin(v_projected_lat)
    );

  return query
  select
    degrees(v_projected_lat),
    mod((degrees(v_projected_lng) + 540)::numeric, 360)::double precision - 180,
    v_distance,
    v_bearing;
end;
$project_coordinate_between_homes$;

create or replace function public.export_place_pin(
  p_lat double precision,
  p_lng double precision,
  p_name text,
  p_pin_type text default 'standard',
  p_accuracy_m double precision default null
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

  select * into v_export_home
  from public.export_player_home_bases
  where player_id = v_player_id;

  if not found then
    raise exception 'An admin needs to set your export home base first.';
  end if;

  select * into v_projected
  from public.project_coordinate_between_homes(
    v_export_home.lat,
    v_export_home.lng,
    (v_home_config ->> 'lat')::double precision,
    (v_home_config ->> 'lng')::double precision,
    p_lat,
    p_lng
  );

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

  v_score = public.score_location(v_projected.lat, v_projected.lng);

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
    v_projected.lat,
    v_projected.lng,
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

create or replace function public.export_restock_pin(
  p_pin_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_accuracy_m double precision default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $export_restock_pin$
declare
  v_player_id uuid = auth.uid();
  v_now timestamptz = now();
  v_cost numeric(12, 2) = 25;
  v_pin public.pins;
  v_profile public.profiles;
  v_location extensions.geography;
  v_restock_target extensions.geography;
  v_distance double precision;
  v_balance numeric(12, 2);
  v_export_home public.export_player_home_bases;
  v_home_config jsonb = public.home_base_config();
  v_projected_physical record;
begin
  if v_player_id is null then
    raise exception 'You must be signed in.';
  end if;

  if public.profile_player_mode(v_player_id) <> 'export' then
    raise exception 'Only export players can restock this way.';
  end if;

  if p_accuracy_m is not null and p_accuracy_m > 100 then
    raise exception 'Location accuracy is too low.';
  end if;

  perform public._settle_player_income(v_player_id);

  select * into v_pin
  from public.pins
  where id = p_pin_id
  for update;

  if not found then
    raise exception 'Pin was not found.';
  end if;

  if v_pin.owner_id <> v_player_id then
    raise exception 'You can only restock your own pins.';
  end if;

  if v_pin.pin_type <> 'standard' then
    raise exception 'Only standard pins can be restocked.';
  end if;

  if v_pin.physical_geog is null then
    select * into v_export_home
    from public.export_player_home_bases
    where player_id = v_player_id;

    if not found then
      raise exception 'An admin needs to set your export home base first.';
    end if;

    select * into v_projected_physical
    from public.project_coordinate_between_homes(
      (v_home_config ->> 'lat')::double precision,
      (v_home_config ->> 'lng')::double precision,
      v_export_home.lat,
      v_export_home.lng,
      v_pin.lat,
      v_pin.lng
    );

    v_restock_target = extensions.st_setsrid(
      extensions.st_makepoint(v_projected_physical.lng, v_projected_physical.lat),
      4326
    )::extensions.geography;
  else
    v_restock_target = v_pin.physical_geog;
  end if;

  v_location = extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography;
  v_distance = extensions.st_distance(v_restock_target, v_location);

  if v_distance > 50 then
    raise exception 'You are too far away to restock this pin.';
  end if;

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
    'restock_purchase',
    p_pin_id
  );

  update public.pins
  set last_restocked_at = v_now,
      restock_due_at = v_now + interval '48 hours'
  where id = p_pin_id
  returning * into v_pin;

  perform public.recalculate_income_periods_near(v_pin.geog, v_now);

  return jsonb_build_object(
    'pin_id', v_pin.id,
    'restock_due_at', v_pin.restock_due_at,
    'balance', v_balance
  );
end;
$export_restock_pin$;

drop function if exists public.get_visible_pins();

create or replace function public.get_visible_pins()
returns table (
  id uuid,
  owner_id uuid,
  owner_name text,
  owner_color text,
  name text,
  pin_type text,
  radius_level integer,
  lat double precision,
  lng double precision,
  physical_lat double precision,
  physical_lng double precision,
  busy_score integer,
  busy_label text,
  placed_at timestamptz,
  visible_at timestamptz,
  last_restocked_at timestamptz,
  restock_due_at timestamptz,
  expires_at timestamptz,
  status text,
  current_hourly_rate numeric,
  competition_pressure numeric,
  lifetime_income_points numeric
)
language plpgsql
security definer
set search_path = public, extensions
as $get_visible_pins$
begin
  perform public._settle_all_income();

  return query
  select
    pin.id,
    pin.owner_id,
    profile.display_name as owner_name,
    profile.player_color as owner_color,
    pin.name,
    pin.pin_type,
    pin.radius_level,
    pin.lat,
    pin.lng,
    pin.physical_lat,
    pin.physical_lng,
    pin.busy_score,
    public.busy_label(pin.busy_score) as busy_label,
    pin.placed_at,
    pin.visible_at,
    pin.last_restocked_at,
    pin.restock_due_at,
    pin.expires_at,
    case
      when pin.disabled_at is not null then 'disabled'
      when pin.pin_type = 'temporary' and pin.expires_at <= now() then 'expired'
      when pin.pin_type = 'standard' and pin.restock_due_at <= now() then 'needs_restock'
      else 'stocked'
    end as status,
    coalesce(period.hourly_rate_points, 0) as current_hourly_rate,
    coalesce(period.competition_pressure, 0) as competition_pressure,
    public.pin_lifetime_income_points(pin.id, now()) as lifetime_income_points
  from public.pins pin
  join public.profiles profile on profile.id = pin.owner_id
  left join lateral (
    select
      income_period.hourly_rate_points,
      income_period.competition_pressure
    from public.pin_income_periods income_period
    where income_period.pin_id = pin.id
      and income_period.starts_at <= now()
      and (income_period.ends_at is null or income_period.ends_at > now())
    order by income_period.starts_at desc
    limit 1
  ) period on true
  where pin.visible_at <= now()
    and not (
      pin.pin_type = 'temporary'
      and pin.expires_at <= now()
    )
  order by pin.placed_at desc;
end;
$get_visible_pins$;

grant execute on function public.export_place_pin(double precision, double precision, text, text, double precision) to authenticated;
grant execute on function public.export_restock_pin(uuid, double precision, double precision, double precision) to authenticated;
grant execute on function public.get_visible_pins() to authenticated;
grant execute on function public.get_visible_pins() to anon;

revoke execute on function public.project_coordinate_between_homes(
  double precision,
  double precision,
  double precision,
  double precision,
  double precision,
  double precision
) from public, anon, authenticated;

notify pgrst, 'reload schema';

insert into public.game_config (key, value)
values (
  'shop_levels',
  '{"thresholds_points": [25, 50, 90, 150, 250], "bonus_points_per_level": 1}'::jsonb
)
on conflict (key) do update
set value = coalesce(public.game_config.value, excluded.value),
    updated_at = now();

create or replace function public.default_shop_level_config()
returns jsonb
language sql
immutable
as $default_shop_level_config$
  select '{"thresholds_points": [25, 50, 90, 150, 250], "bonus_points_per_level": 1}'::jsonb;
$default_shop_level_config$;

create or replace function public.shop_level_config()
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $shop_level_config$
  select coalesce(
    (select value from public.game_config where key = 'shop_levels'),
    public.default_shop_level_config()
  );
$shop_level_config$;

create or replace function public.shop_level_thresholds_points()
returns numeric[]
language plpgsql
stable
security definer
set search_path = public, extensions
as $shop_level_thresholds_points$
declare
  v_config jsonb = public.shop_level_config();
  v_thresholds numeric[];
begin
  select array_agg(threshold_value order by threshold_order)
  into v_thresholds
  from (
    select
      value::numeric as threshold_value,
      ordinality as threshold_order
    from jsonb_array_elements_text(v_config -> 'thresholds_points') with ordinality
  ) thresholds
  where threshold_value > 0;

  if coalesce(array_length(v_thresholds, 1), 0) <> 5 then
    return array[25, 50, 90, 150, 250]::numeric[];
  end if;

  return v_thresholds;
exception
  when others then
    return array[25, 50, 90, 150, 250]::numeric[];
end;
$shop_level_thresholds_points$;

create or replace function public.shop_level_bonus_points_per_hour()
returns numeric
language plpgsql
stable
security definer
set search_path = public, extensions
as $shop_level_bonus_points_per_hour$
declare
  v_bonus numeric;
begin
  v_bonus = (public.shop_level_config() ->> 'bonus_points_per_level')::numeric;
  if v_bonus <= 0 then
    return 1;
  end if;
  return v_bonus;
exception
  when others then
    return 1;
end;
$shop_level_bonus_points_per_hour$;

create or replace function public.shop_level_for_income_points(p_income_points numeric)
returns integer
language sql
stable
security definer
set search_path = public, extensions
as $shop_level_for_income_points$
  select coalesce(count(*), 0)::integer
  from unnest(public.shop_level_thresholds_points()) threshold_points
  where coalesce(p_income_points, 0) >= threshold_points;
$shop_level_for_income_points$;

create or replace function public.pin_lifetime_income_points(
  p_pin_id uuid,
  p_as_of timestamptz default now()
)
returns numeric
language sql
stable
security definer
set search_path = public, extensions
as $pin_lifetime_income_points$
  select coalesce(
    round(sum(
      period.settled_points +
      case
        when least(coalesce(period.ends_at, p_as_of), p_as_of)
             > least(coalesce(period.settled_through, period.starts_at), p_as_of)
        then (
          extract(epoch from (
            least(coalesce(period.ends_at, p_as_of), p_as_of)
            - least(coalesce(period.settled_through, period.starts_at), p_as_of)
          )) / 3600 * period.hourly_rate_points
        )::numeric
        else 0
      end
    ), 2),
    0
  )
  from public.pin_income_periods period
  where period.pin_id = p_pin_id
    and period.starts_at < p_as_of;
$pin_lifetime_income_points$;

create or replace function public.calculate_pin_rate(p_pin_id uuid, p_as_of timestamptz)
returns table (
  hourly_rate_points numeric,
  competition_pressure numeric,
  next_boundary timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $calculate_pin_rate$
declare
  v_pin public.pins;
  v_base numeric;
  v_pressure numeric;
  v_event_multiplier numeric = 1;
  v_lifetime_points numeric = 0;
  v_level integer = 0;
  v_level_bonus numeric = 0;
  v_thresholds numeric[] = public.shop_level_thresholds_points();
  v_next_level_threshold numeric;
  v_level_boundary timestamptz;
begin
  select * into v_pin
  from public.pins
  where id = p_pin_id;

  if not found or not public.is_pin_stocked(v_pin, p_as_of) then
    hourly_rate_points = 0;
    competition_pressure = 0;
    next_boundary = null;
    return next;
  end if;

  select coalesce(
    sum(power(1 - (impact.distance_m / impact.radius_m), 2)),
    0
  )::numeric
  into v_pressure
  from public.pins other_pin
  cross join lateral (
    select
      extensions.st_distance(v_pin.geog, other_pin.geog) as distance_m,
      public.pin_competition_radius_m(other_pin.radius_level) as radius_m
  ) impact
  where other_pin.id <> v_pin.id
    and public.is_pin_stocked(other_pin, p_as_of)
    and impact.distance_m < impact.radius_m;

  select coalesce(max(zone.multiplier), 1)
  into v_event_multiplier
  from public.demand_events zone
  where zone.starts_at <= p_as_of
    and zone.ends_at > p_as_of
    and zone.ended_at is null
    and extensions.st_dwithin(v_pin.geog, zone.geog, zone.radius_m);

  v_lifetime_points = public.pin_lifetime_income_points(p_pin_id, p_as_of);
  v_level = public.shop_level_for_income_points(v_lifetime_points);
  v_level_bonus = v_level * public.shop_level_bonus_points_per_hour();
  v_base = greatest(1, round((2 + v_pin.busy_score * 0.08)::numeric));

  hourly_rate_points = round(
    (((v_base * v_event_multiplier) / (1 + v_pressure)) + v_level_bonus)::numeric,
    2
  );
  competition_pressure = round(v_pressure, 4);

  if v_level < coalesce(array_length(v_thresholds, 1), 0) then
    v_next_level_threshold = v_thresholds[v_level + 1];

    if hourly_rate_points > 0 and v_next_level_threshold > v_lifetime_points then
      v_level_boundary =
        p_as_of +
        ((((v_next_level_threshold - v_lifetime_points) / hourly_rate_points)::double precision) * interval '1 hour');
    end if;
  end if;

  select min(boundary_at)
  into next_boundary
  from (
    select public.pin_next_boundary(v_pin, p_as_of) as boundary_at
    union all
    select v_level_boundary as boundary_at
    union all
    select public.pin_next_boundary(other_pin, p_as_of) as boundary_at
    from public.pins other_pin
    cross join lateral (
      select
        extensions.st_distance(v_pin.geog, other_pin.geog) as distance_m,
        public.pin_competition_radius_m(other_pin.radius_level) as radius_m
    ) impact
    where other_pin.id <> v_pin.id
      and public.is_pin_stocked(other_pin, p_as_of)
      and impact.distance_m < impact.radius_m
    union all
    select zone.ends_at as boundary_at
    from public.demand_events zone
    where zone.starts_at <= p_as_of
      and zone.ends_at > p_as_of
      and zone.ended_at is null
      and extensions.st_dwithin(v_pin.geog, zone.geog, zone.radius_m)
    union all
    select zone.starts_at as boundary_at
    from public.demand_events zone
    where zone.starts_at > p_as_of
      and zone.ended_at is null
      and extensions.st_dwithin(v_pin.geog, zone.geog, zone.radius_m)
  ) boundaries
  where boundary_at is not null
    and boundary_at > p_as_of;

  return next;
end;
$calculate_pin_rate$;

create or replace function public.recalculate_all_income_periods(p_as_of timestamptz)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $recalculate_all_income_periods$
declare
  v_pin record;
begin
  for v_pin in
    select *
    from public.pins
    where disabled_at is null
  loop
    perform public.settle_pin_income_to(v_pin.id, p_as_of);

    update public.pin_income_periods
    set ends_at = p_as_of,
        ending_reason = coalesce(ending_reason, 'recalculated'),
        settled_through = greatest(coalesce(settled_through, starts_at), p_as_of)
    where pin_id = v_pin.id
      and starts_at < p_as_of
      and (ends_at is null or ends_at > p_as_of);

    perform public.open_income_period(v_pin.id, p_as_of);
  end loop;
end;
$recalculate_all_income_periods$;

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

drop function if exists public.get_shop_level_config();

create or replace function public.get_shop_level_config()
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $get_shop_level_config$
  select jsonb_build_object(
    'thresholds_points', public.shop_level_thresholds_points(),
    'bonus_points_per_level', public.shop_level_bonus_points_per_hour()
  );
$get_shop_level_config$;

drop function if exists public.update_shop_level_config(numeric[]);

create or replace function public.update_shop_level_config(p_thresholds_points numeric[])
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $update_shop_level_config$
declare
  v_player_id uuid = auth.uid();
  v_thresholds numeric[];
  v_index integer;
  v_config jsonb;
  v_now timestamptz = now();
begin
  if v_player_id is null then
    raise exception 'You must be signed in.';
  end if;

  if not public.is_admin(v_player_id) then
    raise exception 'Only admins can edit shop levels.';
  end if;

  select array_agg(round(threshold_value, 2) order by threshold_order)
  into v_thresholds
  from unnest(p_thresholds_points) with ordinality as input_thresholds(threshold_value, threshold_order);

  if coalesce(array_length(v_thresholds, 1), 0) <> 5 then
    raise exception 'Enter exactly five shop level thresholds.';
  end if;

  for v_index in 1..5 loop
    if v_thresholds[v_index] <= 0 then
      raise exception 'Shop level thresholds must be positive.';
    end if;

    if v_index > 1 and v_thresholds[v_index] <= v_thresholds[v_index - 1] then
      raise exception 'Shop level thresholds must increase.';
    end if;
  end loop;

  v_config = jsonb_build_object(
    'thresholds_points', v_thresholds,
    'bonus_points_per_level', public.shop_level_bonus_points_per_hour()
  );

  insert into public.game_config (key, value)
  values ('shop_levels', v_config)
  on conflict (key) do update
  set value = excluded.value,
      updated_at = now();

  perform public.recalculate_all_income_periods(v_now);

  return public.get_shop_level_config();
end;
$update_shop_level_config$;

do $$
begin
  perform public.recalculate_all_income_periods(now());
end;
$$;

grant execute on function public.get_visible_pins() to authenticated;
grant execute on function public.get_visible_pins() to anon;
grant execute on function public.get_shop_level_config() to authenticated;
grant execute on function public.get_shop_level_config() to anon;
grant execute on function public.update_shop_level_config(numeric[]) to authenticated;

revoke execute on function public.default_shop_level_config() from public, anon, authenticated;
revoke execute on function public.shop_level_config() from public, anon, authenticated;
revoke execute on function public.shop_level_thresholds_points() from public, anon, authenticated;
revoke execute on function public.shop_level_bonus_points_per_hour() from public, anon, authenticated;
revoke execute on function public.shop_level_for_income_points(numeric) from public, anon, authenticated;
revoke execute on function public.pin_lifetime_income_points(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.recalculate_all_income_periods(timestamptz) from public, anon, authenticated;

notify pgrst, 'reload schema';

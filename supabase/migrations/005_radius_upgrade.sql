insert into public.game_config (key, value)
values
  ('pin_costs', '{"standard": 200, "temporary": 100, "restock": 25, "radius_upgrade": 300}'::jsonb),
  ('competition_radius', '{"base_m": 150, "max_upgrade_level": 1}'::jsonb)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();

alter table public.pins
add column if not exists radius_level integer not null default 0;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pins_radius_level_check'
      and conrelid = 'public.pins'::regclass
  ) then
    alter table public.pins
    add constraint pins_radius_level_check check (radius_level between 0 and 1);
  end if;
end;
$$;

create or replace function public.pin_competition_radius_m(p_radius_level integer)
returns double precision
language sql
immutable
as $$
  select 150.0 * power(2.0, least(greatest(coalesce(p_radius_level, 0), 0), 1));
$$;

create or replace function public.max_competition_radius_m()
returns double precision
language sql
immutable
as $$
  select public.pin_competition_radius_m(1);
$$;

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

  v_base = greatest(1, round((2 + v_pin.busy_score * 0.08)::numeric));

  hourly_rate_points = round((v_base / (1 + v_pressure))::numeric, 2);
  competition_pressure = round(v_pressure, 4);

  select min(boundary_at)
  into next_boundary
  from (
    select public.pin_next_boundary(v_pin, p_as_of) as boundary_at
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
  ) boundaries
  where boundary_at is not null
    and boundary_at > p_as_of;

  return next;
end;
$calculate_pin_rate$;

create or replace function public.recalculate_income_periods_near(p_center extensions.geography, p_as_of timestamptz)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $recalculate_income_periods_near$
declare
  v_pin record;
begin
  for v_pin in
    select *
    from public.pins
    where disabled_at is null
      and extensions.st_dwithin(geog, p_center, public.max_competition_radius_m())
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
$recalculate_income_periods_near$;

create or replace function public.upgrade_pin_radius(p_pin_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $upgrade_pin_radius$
declare
  v_player_id uuid = auth.uid();
  v_now timestamptz = now();
  v_cost numeric(12, 2) = 300;
  v_pin public.pins;
  v_profile public.profiles;
  v_balance numeric(12, 2);
begin
  if v_player_id is null then
    raise exception 'You must be signed in.';
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
    raise exception 'You can only upgrade your own pins.';
  end if;

  if v_pin.disabled_at is not null then
    raise exception 'This shop cannot be upgraded.';
  end if;

  if v_pin.radius_level >= 1 then
    raise exception 'This shop''s radius is already fully upgraded.';
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

  update public.pins
  set radius_level = radius_level + 1
  where id = p_pin_id
  returning * into v_pin;

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
    'radius_upgrade',
    p_pin_id
  );

  perform public.recalculate_income_periods_near(v_pin.geog, v_now);

  return jsonb_build_object(
    'pin_id', v_pin.id,
    'radius_level', v_pin.radius_level,
    'balance', v_balance
  );
end;
$upgrade_pin_radius$;

do $$
declare
  v_now timestamptz = now();
  v_pin record;
begin
  for v_pin in
    select geog
    from public.pins
    where disabled_at is null
  loop
    perform public.recalculate_income_periods_near(v_pin.geog, v_now);
  end loop;
end;
$$;

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
  competition_pressure numeric
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
    coalesce(period.competition_pressure, 0) as competition_pressure
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

grant execute on function public.get_visible_pins() to authenticated;
grant execute on function public.get_visible_pins() to anon;
grant execute on function public.upgrade_pin_radius(uuid) to authenticated;

notify pgrst, 'reload schema';

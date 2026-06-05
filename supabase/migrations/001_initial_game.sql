begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists postgis with schema extensions;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  points_balance numeric(12, 2) not null default 300,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.game_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

insert into public.game_config (key, value)
values
  ('currency', '{"token_unit": 100, "starting_points": 300}'::jsonb),
  ('pin_costs', '{"standard": 200, "temporary": 100}'::jsonb),
  ('competition', '{"radius_m": 300, "restock_radius_m": 50}'::jsonb),
  ('restock', '{"standard_hours": 72}'::jsonb),
  ('income_formula', '{"base": "max(1, round(2 + busy_score * 0.08))", "competition": "1 / (1 + pressure)"}'::jsonb)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();

create table if not exists public.location_score_cache (
  score_cell_key text primary key,
  center_lat double precision not null,
  center_lng double precision not null,
  busy_score integer not null check (busy_score between 0 and 100),
  poi_density_score integer not null check (poi_density_score between 0 and 100),
  transit_density_score integer not null check (transit_density_score between 0 and 100),
  population_density_score integer not null check (population_density_score between 0 and 100),
  source_details jsonb not null default '{}',
  scoring_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.pins (
  id uuid primary key default extensions.gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  pin_type text not null check (pin_type in ('standard', 'temporary')),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  geog extensions.geography(Point, 4326) not null,
  busy_score integer not null check (busy_score between 0 and 100),
  score_cell_key text not null references public.location_score_cache(score_cell_key),
  placed_at timestamptz not null default now(),
  visible_at timestamptz not null default now(),
  last_restocked_at timestamptz,
  restock_due_at timestamptz,
  expires_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists pins_geog_idx on public.pins using gist (geog);
create index if not exists pins_owner_idx on public.pins (owner_id);
create index if not exists pins_visible_idx on public.pins (visible_at);
create index if not exists pins_restock_due_idx on public.pins (restock_due_at);

create table if not exists public.pin_income_periods (
  id uuid primary key default extensions.gen_random_uuid(),
  pin_id uuid not null references public.pins(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz,
  hourly_rate_points numeric(10, 2) not null,
  busy_score integer not null,
  competition_pressure numeric(10, 4) not null,
  ending_reason text,
  settled_through timestamptz,
  settled_points numeric(12, 2) not null default 0,
  created_at timestamptz not null default now(),
  constraint pin_income_periods_time_check check (ends_at is null or ends_at >= starts_at)
);

create index if not exists pin_income_periods_pin_idx on public.pin_income_periods (pin_id, starts_at);
create index if not exists pin_income_periods_open_idx on public.pin_income_periods (pin_id) where ends_at is null;

create table if not exists public.currency_ledger (
  id uuid primary key default extensions.gen_random_uuid(),
  player_id uuid not null references public.profiles(id) on delete cascade,
  amount_points numeric(12, 2) not null,
  balance_after numeric(12, 2) not null,
  reason text not null,
  source_pin_id uuid references public.pins(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists currency_ledger_player_idx on public.currency_ledger (player_id, created_at desc);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
before update on public.profiles
for each row execute function public.touch_updated_at();

drop trigger if exists pins_touch_updated_at on public.pins;
create trigger pins_touch_updated_at
before update on public.pins
for each row execute function public.touch_updated_at();

create or replace function public.set_pin_geog()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  new.geog = extensions.st_setsrid(extensions.st_makepoint(new.lng, new.lat), 4326)::extensions.geography;
  return new;
end;
$$;

drop trigger if exists pins_set_geog on public.pins;
create trigger pins_set_geog
before insert or update of lat, lng on public.pins
for each row execute function public.set_pin_geog();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_display_name text;
begin
  v_display_name = coalesce(
    nullif(new.raw_user_meta_data ->> 'display_name', ''),
    split_part(new.email, '@', 1),
    'Player'
  );

  insert into public.profiles (id, display_name, points_balance)
  values (new.id, v_display_name, 300)
  on conflict (id) do nothing;

  insert into public.currency_ledger (player_id, amount_points, balance_after, reason)
  values (new.id, 300, 300, 'starting_grant')
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.busy_label(p_score integer)
returns text
language sql
immutable
as $$
  select case
    when p_score >= 76 then 'Packed'
    when p_score >= 51 then 'Busy'
    when p_score >= 26 then 'Steady'
    else 'Quiet'
  end;
$$;

create or replace function public.is_pin_stocked(p_pin public.pins, p_as_of timestamptz)
returns boolean
language sql
stable
as $$
  select p_pin.disabled_at is null
    and case
      when p_pin.pin_type = 'standard' then p_pin.restock_due_at is not null and p_pin.restock_due_at > p_as_of
      when p_pin.pin_type = 'temporary' then p_pin.expires_at is not null and p_pin.expires_at > p_as_of
      else false
    end;
$$;

create or replace function public.pin_next_boundary(p_pin public.pins, p_as_of timestamptz)
returns timestamptz
language sql
stable
as $$
  select case
    when p_pin.pin_type = 'standard' and p_pin.restock_due_at > p_as_of then p_pin.restock_due_at
    when p_pin.pin_type = 'temporary' and p_pin.expires_at > p_as_of then p_pin.expires_at
    else null
  end;
$$;

create or replace function public.score_location(p_lat double precision, p_lng double precision)
returns public.location_score_cache
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_cell_lat numeric(8, 3);
  v_cell_lng numeric(8, 3);
  v_cell_key text;
  v_hash integer;
  v_dist_m double precision;
  v_poi integer;
  v_transit integer;
  v_population integer;
  v_busy integer;
  v_result public.location_score_cache;
begin
  v_cell_lat = round(p_lat::numeric, 3);
  v_cell_lng = round(p_lng::numeric, 3);
  v_cell_key = v_cell_lat::text || ':' || v_cell_lng::text;

  select * into v_result
  from public.location_score_cache
  where score_cell_key = v_cell_key;

  if found then
    return v_result;
  end if;

  v_hash = abs(hashtext(v_cell_key));
  v_poi = 20 + (v_hash % 61);
  v_transit = 10 + ((v_hash / 17) % 51);
  v_population = 15 + ((v_hash / 29) % 61);

  v_dist_m = extensions.st_distance(
    extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography,
    extensions.st_setsrid(extensions.st_makepoint(-3.1883, 55.9533), 4326)::extensions.geography
  );

  if v_dist_m < 7500 then
    v_poi = greatest(v_poi, greatest(25, round((95 - v_dist_m / 120)::numeric)::integer));
    v_transit = greatest(v_transit, greatest(20, round((78 - v_dist_m / 170)::numeric)::integer));
    v_population = greatest(v_population, greatest(28, round((74 - v_dist_m / 190)::numeric)::integer));
  end if;

  v_poi = least(100, greatest(0, v_poi));
  v_transit = least(100, greatest(0, v_transit));
  v_population = least(100, greatest(0, v_population));
  v_busy = round((0.55 * v_poi + 0.25 * v_transit + 0.20 * v_population)::numeric)::integer;
  v_busy = least(100, greatest(0, v_busy));

  insert into public.location_score_cache (
    score_cell_key,
    center_lat,
    center_lng,
    busy_score,
    poi_density_score,
    transit_density_score,
    population_density_score,
    source_details
  )
  values (
    v_cell_key,
    v_cell_lat::double precision,
    v_cell_lng::double precision,
    v_busy,
    v_poi,
    v_transit,
    v_population,
    jsonb_build_object('source', 'deterministic_mvp_placeholder')
  )
  returning * into v_result;

  return v_result;
end;
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
as $$
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
    sum(power(1 - (extensions.st_distance(v_pin.geog, other_pin.geog) / 300), 2)),
    0
  )::numeric
  into v_pressure
  from public.pins other_pin
  where other_pin.id <> v_pin.id
    and public.is_pin_stocked(other_pin, p_as_of)
    and extensions.st_dwithin(v_pin.geog, other_pin.geog, 300);

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
    where other_pin.id <> v_pin.id
      and public.is_pin_stocked(other_pin, p_as_of)
      and extensions.st_dwithin(v_pin.geog, other_pin.geog, 300)
  ) boundaries
  where boundary_at is not null
    and boundary_at > p_as_of;

  return next;
end;
$$;

create or replace function public.open_income_period(p_pin_id uuid, p_starts_at timestamptz)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_pin public.pins;
  v_rate record;
begin
  select * into v_pin
  from public.pins
  where id = p_pin_id;

  if not found or not public.is_pin_stocked(v_pin, p_starts_at) then
    return;
  end if;

  if exists (
    select 1
    from public.pin_income_periods
    where pin_id = p_pin_id
      and starts_at = p_starts_at
  ) then
    return;
  end if;

  select * into v_rate
  from public.calculate_pin_rate(p_pin_id, p_starts_at);

  insert into public.pin_income_periods (
    pin_id,
    starts_at,
    ends_at,
    hourly_rate_points,
    busy_score,
    competition_pressure
  )
  values (
    p_pin_id,
    p_starts_at,
    v_rate.next_boundary,
    v_rate.hourly_rate_points,
    v_pin.busy_score,
    v_rate.competition_pressure
  );
end;
$$;

create or replace function public.refresh_pin_periods(p_pin_id uuid, p_as_of timestamptz)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_latest public.pin_income_periods;
  v_latest_after uuid;
  v_guard integer = 0;
begin
  if not exists (select 1 from public.pin_income_periods where pin_id = p_pin_id) then
    perform public.open_income_period(p_pin_id, p_as_of);
    return;
  end if;

  loop
    v_guard = v_guard + 1;
    exit when v_guard > 40;

    select * into v_latest
    from public.pin_income_periods
    where pin_id = p_pin_id
    order by starts_at desc
    limit 1;

    exit when not found;
    exit when v_latest.ends_at is null;
    exit when v_latest.ends_at > p_as_of;

    perform public.open_income_period(p_pin_id, v_latest.ends_at);

    select id into v_latest_after
    from public.pin_income_periods
    where pin_id = p_pin_id
    order by starts_at desc
    limit 1;

    exit when v_latest_after = v_latest.id;
  end loop;
end;
$$;

create or replace function public.settle_pin_income_to(p_pin_id uuid, p_as_of timestamptz)
returns numeric
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_period record;
  v_settle_start timestamptz;
  v_settle_end timestamptz;
  v_amount numeric(12, 2);
  v_total numeric(12, 2) = 0;
  v_owner_id uuid;
  v_balance numeric(12, 2);
begin
  perform public.refresh_pin_periods(p_pin_id, p_as_of);

  select owner_id into v_owner_id
  from public.pins
  where id = p_pin_id;

  for v_period in
    select *
    from public.pin_income_periods
    where pin_id = p_pin_id
      and starts_at < p_as_of
    order by starts_at
  loop
    v_settle_start = coalesce(v_period.settled_through, v_period.starts_at);
    v_settle_end = least(coalesce(v_period.ends_at, p_as_of), p_as_of);

    if v_settle_end > v_settle_start then
      v_amount = round(
        (extract(epoch from (v_settle_end - v_settle_start)) / 3600 * v_period.hourly_rate_points)::numeric,
        2
      );

      if v_amount > 0 then
        update public.pin_income_periods
        set settled_through = v_settle_end,
            settled_points = settled_points + v_amount
        where id = v_period.id;

        v_total = v_total + v_amount;
      end if;
    end if;
  end loop;

  if v_total > 0 then
    update public.profiles
    set points_balance = points_balance + v_total
    where id = v_owner_id
    returning points_balance into v_balance;

    insert into public.currency_ledger (
      player_id,
      amount_points,
      balance_after,
      reason,
      source_pin_id
    )
    values (
      v_owner_id,
      v_total,
      v_balance,
      'income_settlement',
      p_pin_id
    );
  end if;

  return v_total;
end;
$$;

create or replace function public.recalculate_income_periods_near(p_center extensions.geography, p_as_of timestamptz)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_pin record;
begin
  for v_pin in
    select *
    from public.pins
    where disabled_at is null
      and extensions.st_dwithin(geog, p_center, 300)
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
$$;

create or replace function public._settle_player_income(p_player_id uuid)
returns numeric
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_pin record;
  v_total numeric(12, 2) = 0;
begin
  for v_pin in
    select id
    from public.pins
    where owner_id = p_player_id
      and disabled_at is null
  loop
    v_total = v_total + public.settle_pin_income_to(v_pin.id, now());
  end loop;

  return v_total;
end;
$$;

create or replace function public._settle_all_income()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_profile record;
begin
  for v_profile in select id from public.profiles loop
    perform public._settle_player_income(v_profile.id);
  end loop;
end;
$$;

create or replace function public.settle_player_income()
returns numeric
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_player_id uuid = auth.uid();
begin
  if v_player_id is null then
    raise exception 'You must be signed in.';
  end if;

  return public._settle_player_income(v_player_id);
end;
$$;

create or replace function public.place_pin(
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
as $$
declare
  v_player_id uuid = auth.uid();
  v_now timestamptz = now();
  v_cost numeric(12, 2);
  v_profile public.profiles;
  v_score public.location_score_cache;
  v_pin public.pins;
  v_balance numeric(12, 2);
begin
  if v_player_id is null then
    raise exception 'You must be signed in.';
  end if;

  if p_accuracy_m is not null and p_accuracy_m > 100 then
    raise exception 'Location accuracy is too low.';
  end if;

  if p_pin_type not in ('standard', 'temporary') then
    raise exception 'Unsupported pin type.';
  end if;

  perform public._settle_player_income(v_player_id);

  select * into v_profile
  from public.profiles
  where id = v_player_id
  for update;

  if not found then
    raise exception 'Profile was not found.';
  end if;

  v_cost = case when p_pin_type = 'temporary' then 100 else 200 end;

  if v_profile.points_balance < v_cost then
    raise exception 'Not enough tokens.';
  end if;

  v_score = public.score_location(p_lat, p_lng);

  insert into public.pins (
    owner_id,
    name,
    pin_type,
    lat,
    lng,
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
    p_lat,
    p_lng,
    v_score.busy_score,
    v_score.score_cell_key,
    v_now,
    v_now,
    case when p_pin_type = 'standard' then v_now else null end,
    case when p_pin_type = 'standard' then v_now + interval '72 hours' else null end,
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
    'pin_purchase',
    v_pin.id
  );

  perform public.recalculate_income_periods_near(v_pin.geog, v_now);

  return jsonb_build_object(
    'pin_id', v_pin.id,
    'balance', v_balance,
    'busy_score', v_pin.busy_score
  );
end;
$$;

create or replace function public.restock_pin(
  p_pin_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_accuracy_m double precision default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_player_id uuid = auth.uid();
  v_now timestamptz = now();
  v_pin public.pins;
  v_location extensions.geography;
  v_distance double precision;
begin
  if v_player_id is null then
    raise exception 'You must be signed in.';
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

  v_location = extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography;
  v_distance = extensions.st_distance(v_pin.geog, v_location);

  if v_distance > 50 then
    raise exception 'You are too far away to restock this pin.';
  end if;

  update public.pins
  set last_restocked_at = v_now,
      restock_due_at = v_now + interval '72 hours'
  where id = p_pin_id
  returning * into v_pin;

  perform public.recalculate_income_periods_near(v_pin.geog, v_now);

  return jsonb_build_object(
    'pin_id', v_pin.id,
    'restock_due_at', v_pin.restock_due_at
  );
end;
$$;

create or replace function public.get_visible_pins()
returns table (
  id uuid,
  owner_id uuid,
  owner_name text,
  name text,
  pin_type text,
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
as $$
begin
  perform public._settle_all_income();

  return query
  select
    pin.id,
    pin.owner_id,
    profile.display_name as owner_name,
    pin.name,
    pin.pin_type,
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
$$;

create or replace function public.get_leaderboard()
returns table (
  player_id uuid,
  display_name text,
  points_balance numeric,
  active_pins bigint,
  lifetime_income numeric
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
begin
  perform public._settle_all_income();

  return query
  select
    profile.id as player_id,
    profile.display_name,
    profile.points_balance,
    coalesce(pin_stats.active_pins, 0) as active_pins,
    coalesce(ledger_stats.lifetime_income, 0) as lifetime_income
  from public.profiles profile
  left join lateral (
    select count(*) as active_pins
    from public.pins pin
    where pin.owner_id = profile.id
      and public.is_pin_stocked(pin, now())
  ) pin_stats on true
  left join lateral (
    select coalesce(sum(ledger.amount_points), 0) as lifetime_income
    from public.currency_ledger ledger
    where ledger.player_id = profile.id
      and ledger.reason = 'income_settlement'
  ) ledger_stats on true
  order by profile.points_balance desc, coalesce(pin_stats.active_pins, 0) desc;
end;
$$;

alter table public.profiles enable row level security;
alter table public.game_config enable row level security;
alter table public.location_score_cache enable row level security;
alter table public.pins enable row level security;
alter table public.pin_income_periods enable row level security;
alter table public.currency_ledger enable row level security;

drop policy if exists "profiles are readable" on public.profiles;
create policy "profiles are readable"
on public.profiles for select
using (true);

drop policy if exists "players can update their profile" on public.profiles;
create policy "players can update their profile"
on public.profiles for update
using (id = auth.uid())
with check (id = auth.uid());

drop policy if exists "game config is readable" on public.game_config;
create policy "game config is readable"
on public.game_config for select
using (true);

drop policy if exists "score cache is readable" on public.location_score_cache;
create policy "score cache is readable"
on public.location_score_cache for select
using (true);

drop policy if exists "visible pins are readable" on public.pins;
create policy "visible pins are readable"
on public.pins for select
using (visible_at <= now());

drop policy if exists "players can read own income periods" on public.pin_income_periods;
create policy "players can read own income periods"
on public.pin_income_periods for select
using (
  exists (
    select 1
    from public.pins
    where pins.id = pin_income_periods.pin_id
      and pins.owner_id = auth.uid()
  )
);

drop policy if exists "players can read own ledger" on public.currency_ledger;
create policy "players can read own ledger"
on public.currency_ledger for select
using (player_id = auth.uid());

grant execute on function public.settle_player_income() to authenticated;
grant execute on function public.place_pin(double precision, double precision, text, text, double precision) to authenticated;
grant execute on function public.restock_pin(uuid, double precision, double precision, double precision) to authenticated;
grant execute on function public.get_visible_pins() to authenticated;
grant execute on function public.get_leaderboard() to authenticated;

revoke execute on function public._settle_player_income(uuid) from public, anon, authenticated;
revoke execute on function public._settle_all_income() from public, anon, authenticated;
revoke execute on function public.settle_pin_income_to(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.refresh_pin_periods(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.open_income_period(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.recalculate_income_periods_near(extensions.geography, timestamptz) from public, anon, authenticated;

commit;

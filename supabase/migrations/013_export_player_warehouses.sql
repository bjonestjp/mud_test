alter table public.profiles
add column if not exists player_mode text not null default 'local';

do $profiles_player_mode_check$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_player_mode_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
    add constraint profiles_player_mode_check
    check (player_mode in ('local', 'export'));
  end if;
end;
$profiles_player_mode_check$;

insert into public.game_config (key, value)
values (
  'export',
  '{
    "warehouse_cost": 100,
    "warehouse_restock_cost": 100,
    "shop_cost": 100,
    "warehouse_restock_hours": 48,
    "tiers": [
      { "tier": "small", "radius_m": 100 },
      { "tier": "medium", "radius_m": 200 },
      { "tier": "large", "radius_m": 300 }
    ]
  }'::jsonb
), (
  'home_base',
  '{"lat": 55.9533, "lng": -3.1883}'::jsonb
)
on conflict (key) do update
set value = coalesce(public.game_config.value, excluded.value),
    updated_at = now();

create or replace function public.profile_player_mode(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public, extensions
as $profile_player_mode$
  select coalesce(
    (select profile.player_mode from public.profiles profile where profile.id = p_user_id),
    'local'
  );
$profile_player_mode$;

drop policy if exists "players can update their profile" on public.profiles;
create policy "players can update their profile"
on public.profiles for update
using (id = auth.uid())
with check (
  id = auth.uid()
  and account_role = public.profile_account_role(auth.uid())
  and player_mode = public.profile_player_mode(auth.uid())
);

create table if not exists public.export_warehouses (
  id uuid primary key default extensions.gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  tier text not null check (tier in ('small', 'medium', 'large')),
  radius_m integer not null check (radius_m in (100, 200, 300)),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  geog extensions.geography(Point, 4326) not null,
  placed_at timestamptz not null default now(),
  last_used_at timestamptz,
  available_at timestamptz,
  credit_available boolean not null default true,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists export_warehouses_geog_idx
on public.export_warehouses using gist (geog);

create index if not exists export_warehouses_owner_idx
on public.export_warehouses (owner_id);

create or replace function public.set_export_warehouse_geog()
returns trigger
language plpgsql
as $set_export_warehouse_geog$
begin
  new.geog = extensions.st_setsrid(extensions.st_makepoint(new.lng, new.lat), 4326)::extensions.geography;
  return new;
end;
$set_export_warehouse_geog$;

drop trigger if exists export_warehouses_set_geog on public.export_warehouses;
create trigger export_warehouses_set_geog
before insert or update of lat, lng on public.export_warehouses
for each row execute function public.set_export_warehouse_geog();

drop trigger if exists export_warehouses_touch_updated_at on public.export_warehouses;
create trigger export_warehouses_touch_updated_at
before update on public.export_warehouses
for each row execute function public.touch_updated_at();

alter table public.export_warehouses enable row level security;

drop policy if exists "warehouses are readable" on public.export_warehouses;
create policy "warehouses are readable"
on public.export_warehouses for select
using (disabled_at is null);

create or replace function public.export_config()
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $export_config$
  select coalesce(
    (select value from public.game_config where key = 'export'),
    '{
      "warehouse_cost": 100,
      "warehouse_restock_cost": 100,
      "shop_cost": 100,
      "warehouse_restock_hours": 48
    }'::jsonb
  );
$export_config$;

create or replace function public.export_config_number(p_key text, p_fallback numeric)
returns numeric
language plpgsql
stable
security definer
set search_path = public, extensions
as $export_config_number$
declare
  v_value numeric;
begin
  v_value = (public.export_config() ->> p_key)::numeric;
  if v_value is null or v_value <= 0 then
    return p_fallback;
  end if;
  return v_value;
exception
  when others then
    return p_fallback;
end;
$export_config_number$;

create or replace function public.warehouse_radius_m(p_tier text)
returns integer
language sql
immutable
as $warehouse_radius_m$
  select case
    when p_tier = 'large' then 300
    when p_tier = 'medium' then 200
    else 100
  end;
$warehouse_radius_m$;

create or replace function public.home_base_config()
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $home_base_config$
  select coalesce(
    (select value from public.game_config where key = 'home_base'),
    '{"lat": 55.9533, "lng": -3.1883}'::jsonb
  );
$home_base_config$;

create or replace function public.home_base_geog()
returns extensions.geography
language sql
stable
security definer
set search_path = public, extensions
as $home_base_geog$
  select extensions.st_setsrid(
    extensions.st_makepoint(
      (public.home_base_config() ->> 'lng')::double precision,
      (public.home_base_config() ->> 'lat')::double precision
    ),
    4326
  )::extensions.geography;
$home_base_geog$;

create or replace function public.get_home_base()
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $get_home_base$
  select jsonb_build_object(
    'lat', (public.home_base_config() ->> 'lat')::double precision,
    'lng', (public.home_base_config() ->> 'lng')::double precision,
    'updated_at', (select updated_at from public.game_config where key = 'home_base')
  );
$get_home_base$;

create or replace function public.update_home_base(
  p_lat double precision,
  p_lng double precision
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $update_home_base$
declare
  v_player_id uuid = auth.uid();
  v_config jsonb;
begin
  if v_player_id is null then
    raise exception 'You must be signed in.';
  end if;

  if not public.is_admin(v_player_id) then
    raise exception 'Only admins can set the home base.';
  end if;

  if not (
    p_lat between -90 and 90
    and p_lng between -180 and 180
  ) then
    raise exception 'Choose a valid home base location.';
  end if;

  v_config = jsonb_build_object('lat', p_lat, 'lng', p_lng);

  insert into public.game_config (key, value)
  values ('home_base', v_config)
  on conflict (key) do update
  set value = excluded.value,
      updated_at = now();

  return public.get_home_base();
end;
$update_home_base$;

create or replace function public.assert_warehouse_not_overlapping(
  p_geog extensions.geography,
  p_radius_m integer,
  p_ignore_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $assert_warehouse_not_overlapping$
declare
  v_overlap record;
begin
  select warehouse.id, warehouse.name
  into v_overlap
  from public.export_warehouses warehouse
  where warehouse.disabled_at is null
    and (p_ignore_id is null or warehouse.id <> p_ignore_id)
    and extensions.st_dwithin(
      warehouse.geog,
      p_geog,
      warehouse.radius_m + p_radius_m
    )
  limit 1;

  if found then
    raise exception 'Warehouse radius overlaps with %.', v_overlap.name;
  end if;
end;
$assert_warehouse_not_overlapping$;

create or replace function public.get_visible_warehouses()
returns table (
  id uuid,
  owner_id uuid,
  owner_name text,
  owner_color text,
  name text,
  tier text,
  radius_m integer,
  lat double precision,
  lng double precision,
  placed_at timestamptz,
  last_used_at timestamptz,
  available_at timestamptz,
  credit_available boolean,
  status text
)
language plpgsql
security definer
set search_path = public, extensions
as $get_visible_warehouses$
begin
  return query
  select
    warehouse.id,
    warehouse.owner_id,
    profile.display_name as owner_name,
    profile.player_color as owner_color,
    warehouse.name,
    warehouse.tier,
    warehouse.radius_m,
    warehouse.lat,
    warehouse.lng,
    warehouse.placed_at,
    warehouse.last_used_at,
    warehouse.available_at,
    warehouse.credit_available,
    case
      when warehouse.credit_available then 'available'
      when warehouse.available_at is not null and warehouse.available_at > now() then 'cooldown'
      else 'empty'
    end as status
  from public.export_warehouses warehouse
  join public.profiles profile on profile.id = warehouse.owner_id
  where warehouse.disabled_at is null
  order by warehouse.placed_at desc;
end;
$get_visible_warehouses$;

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
as $place_pin$
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

  if public.profile_player_mode(v_player_id) <> 'local' then
    raise exception 'Export players must build shops through warehouses.';
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
$place_pin$;

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
as $restock_pin$
declare
  v_player_id uuid = auth.uid();
  v_now timestamptz = now();
  v_cost numeric(12, 2) = 25;
  v_pin public.pins;
  v_profile public.profiles;
  v_location extensions.geography;
  v_distance double precision;
  v_balance numeric(12, 2);
begin
  if v_player_id is null then
    raise exception 'You must be signed in.';
  end if;

  if public.profile_player_mode(v_player_id) <> 'local' then
    raise exception 'Export players must restock shops through warehouses.';
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
$restock_pin$;

create or replace function public.place_warehouse(
  p_lat double precision,
  p_lng double precision,
  p_name text,
  p_tier text default 'small',
  p_accuracy_m double precision default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $place_warehouse$
declare
  v_player_id uuid = auth.uid();
  v_now timestamptz = now();
  v_radius_m integer = public.warehouse_radius_m(p_tier);
  v_cost numeric(12, 2) = public.export_config_number('warehouse_cost', 100);
  v_profile public.profiles;
  v_warehouse public.export_warehouses;
  v_geog extensions.geography;
  v_balance numeric(12, 2);
begin
  if v_player_id is null then
    raise exception 'You must be signed in.';
  end if;

  if public.profile_player_mode(v_player_id) <> 'export' then
    raise exception 'Only export players can build warehouses.';
  end if;

  if p_accuracy_m is not null and p_accuracy_m > 100 then
    raise exception 'Location accuracy is too low.';
  end if;

  v_geog = extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography;
  perform public.assert_warehouse_not_overlapping(v_geog, v_radius_m, null);

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

  insert into public.export_warehouses (
    owner_id,
    name,
    tier,
    radius_m,
    lat,
    lng,
    placed_at,
    credit_available
  )
  values (
    v_player_id,
    left(coalesce(nullif(trim(p_name), ''), 'Warehouse'), 80),
    case when p_tier in ('small', 'medium', 'large') then p_tier else 'small' end,
    v_radius_m,
    p_lat,
    p_lng,
    v_now,
    true
  )
  returning * into v_warehouse;

  update public.profiles
  set points_balance = points_balance - v_cost
  where id = v_player_id
  returning points_balance into v_balance;

  insert into public.currency_ledger (
    player_id,
    amount_points,
    balance_after,
    reason
  )
  values (
    v_player_id,
    -v_cost,
    v_balance,
    'warehouse_purchase'
  );

  return jsonb_build_object(
    'warehouse_id', v_warehouse.id,
    'balance', v_balance
  );
end;
$place_warehouse$;

create or replace function public.restock_warehouse(
  p_warehouse_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_accuracy_m double precision default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $restock_warehouse$
declare
  v_player_id uuid = auth.uid();
  v_now timestamptz = now();
  v_cost numeric(12, 2) = public.export_config_number('warehouse_restock_cost', 100);
  v_profile public.profiles;
  v_warehouse public.export_warehouses;
  v_location extensions.geography;
  v_distance double precision;
  v_balance numeric(12, 2);
begin
  if v_player_id is null then
    raise exception 'You must be signed in.';
  end if;

  if public.profile_player_mode(v_player_id) <> 'export' then
    raise exception 'Only export players can restock warehouses.';
  end if;

  if p_accuracy_m is not null and p_accuracy_m > 100 then
    raise exception 'Location accuracy is too low.';
  end if;

  select * into v_warehouse
  from public.export_warehouses
  where id = p_warehouse_id
    and disabled_at is null
  for update;

  if not found then
    raise exception 'Warehouse was not found.';
  end if;

  if v_warehouse.owner_id <> v_player_id then
    raise exception 'You can only restock your own warehouses.';
  end if;

  if v_warehouse.credit_available then
    raise exception 'This warehouse already has an export credit.';
  end if;

  if v_warehouse.available_at is not null and v_warehouse.available_at > v_now then
    raise exception 'This warehouse is still cooling down.';
  end if;

  v_location = extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography;
  v_distance = extensions.st_distance(v_warehouse.geog, v_location);

  if v_distance > 50 then
    raise exception 'You are too far away to restock this warehouse.';
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

  update public.profiles
  set points_balance = points_balance - v_cost
  where id = v_player_id
  returning points_balance into v_balance;

  insert into public.currency_ledger (
    player_id,
    amount_points,
    balance_after,
    reason
  )
  values (
    v_player_id,
    -v_cost,
    v_balance,
    'warehouse_restock'
  );

  update public.export_warehouses
  set credit_available = true
  where id = p_warehouse_id
  returning * into v_warehouse;

  return jsonb_build_object(
    'warehouse_id', v_warehouse.id,
    'balance', v_balance
  );
end;
$restock_warehouse$;

create or replace function public.export_place_pin(
  p_warehouse_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_name text,
  p_pin_type text default 'standard'
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
  v_cooldown_hours numeric = public.export_config_number('warehouse_restock_hours', 48);
  v_profile public.profiles;
  v_warehouse public.export_warehouses;
  v_score public.location_score_cache;
  v_pin public.pins;
  v_target_geog extensions.geography;
  v_balance numeric(12, 2);
begin
  if v_player_id is null then
    raise exception 'You must be signed in.';
  end if;

  if public.profile_player_mode(v_player_id) <> 'export' then
    raise exception 'Only export players can use warehouses.';
  end if;

  if p_pin_type not in ('standard', 'temporary') then
    raise exception 'Unsupported pin type.';
  end if;

  select * into v_warehouse
  from public.export_warehouses
  where id = p_warehouse_id
    and disabled_at is null
  for update;

  if not found then
    raise exception 'Warehouse was not found.';
  end if;

  if v_warehouse.owner_id <> v_player_id then
    raise exception 'You can only use your own warehouses.';
  end if;

  if not v_warehouse.credit_available then
    raise exception 'This warehouse needs to be restocked.';
  end if;

  v_target_geog = extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography;

  if not extensions.st_dwithin(public.home_base_geog(), v_target_geog, v_warehouse.radius_m) then
    raise exception 'Shop is outside this warehouse''s home-base reach.';
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

  update public.export_warehouses
  set credit_available = false,
      last_used_at = v_now,
      available_at = v_now + (v_cooldown_hours::double precision * interval '1 hour')
  where id = v_warehouse.id;

  perform public.recalculate_income_periods_near(v_pin.geog, v_now);

  return jsonb_build_object(
    'pin_id', v_pin.id,
    'warehouse_id', v_warehouse.id,
    'balance', v_balance
  );
end;
$export_place_pin$;

create or replace function public.export_restock_pin(
  p_warehouse_id uuid,
  p_pin_id uuid
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
  v_cooldown_hours numeric = public.export_config_number('warehouse_restock_hours', 48);
  v_profile public.profiles;
  v_warehouse public.export_warehouses;
  v_pin public.pins;
  v_balance numeric(12, 2);
begin
  if v_player_id is null then
    raise exception 'You must be signed in.';
  end if;

  if public.profile_player_mode(v_player_id) <> 'export' then
    raise exception 'Only export players can restock through warehouses.';
  end if;

  select * into v_warehouse
  from public.export_warehouses
  where id = p_warehouse_id
    and disabled_at is null
  for update;

  if not found then
    raise exception 'Warehouse was not found.';
  end if;

  if v_warehouse.owner_id <> v_player_id then
    raise exception 'You can only use your own warehouses.';
  end if;

  if not v_warehouse.credit_available then
    raise exception 'This warehouse needs to be restocked.';
  end if;

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

  if not extensions.st_dwithin(public.home_base_geog(), v_pin.geog, v_warehouse.radius_m) then
    raise exception 'Shop is outside this warehouse''s home-base reach.';
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
    'export_restock_purchase',
    p_pin_id
  );

  update public.pins
  set last_restocked_at = v_now,
      restock_due_at = v_now + interval '48 hours'
  where id = p_pin_id
  returning * into v_pin;

  update public.export_warehouses
  set credit_available = false,
      last_used_at = v_now,
      available_at = v_now + (v_cooldown_hours::double precision * interval '1 hour')
  where id = v_warehouse.id;

  perform public.recalculate_income_periods_near(v_pin.geog, v_now);

  return jsonb_build_object(
    'pin_id', v_pin.id,
    'warehouse_id', v_warehouse.id,
    'restock_due_at', v_pin.restock_due_at,
    'balance', v_balance
  );
end;
$export_restock_pin$;

grant execute on function public.profile_player_mode(uuid) to authenticated;
grant execute on function public.get_home_base() to authenticated;
grant execute on function public.get_home_base() to anon;
grant execute on function public.update_home_base(double precision, double precision) to authenticated;
grant execute on function public.get_visible_warehouses() to authenticated;
grant execute on function public.get_visible_warehouses() to anon;
grant execute on function public.place_warehouse(double precision, double precision, text, text, double precision) to authenticated;
grant execute on function public.restock_warehouse(uuid, double precision, double precision, double precision) to authenticated;
grant execute on function public.export_place_pin(uuid, double precision, double precision, text, text) to authenticated;
grant execute on function public.export_restock_pin(uuid, uuid) to authenticated;

revoke execute on function public.export_config() from public, anon, authenticated;
revoke execute on function public.export_config_number(text, numeric) from public, anon, authenticated;
revoke execute on function public.warehouse_radius_m(text) from public, anon, authenticated;
revoke execute on function public.home_base_config() from public, anon, authenticated;
revoke execute on function public.home_base_geog() from public, anon, authenticated;
revoke execute on function public.assert_warehouse_not_overlapping(extensions.geography, integer, uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';

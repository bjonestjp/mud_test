insert into public.game_config (key, value)
values (
  'export',
  '{
    "warehouse_cost": 100,
    "warehouse_restock_cost": 100,
    "shop_cost": 100,
    "warehouse_restock_hours": 48,
    "distance_multiplier": 0.6,
    "warehouse_footprint_m": 50
  }'::jsonb
)
on conflict (key) do update
set value = coalesce(public.game_config.value, '{}'::jsonb) || excluded.value,
    updated_at = now();

create table if not exists public.export_player_home_bases (
  player_id uuid primary key references public.profiles(id) on delete cascade,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  geog extensions.geography(Point, 4326) not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

create or replace function public.set_export_player_home_base_geog()
returns trigger
language plpgsql
as $set_export_player_home_base_geog$
begin
  new.geog = extensions.st_setsrid(extensions.st_makepoint(new.lng, new.lat), 4326)::extensions.geography;
  return new;
end;
$set_export_player_home_base_geog$;

drop trigger if exists export_player_home_bases_set_geog on public.export_player_home_bases;
create trigger export_player_home_bases_set_geog
before insert or update of lat, lng on public.export_player_home_bases
for each row execute function public.set_export_player_home_base_geog();

alter table public.export_player_home_bases enable row level security;

drop policy if exists "export home bases are readable" on public.export_player_home_bases;
create policy "export home bases are readable"
on public.export_player_home_bases for select
using (
  player_id = auth.uid()
  or public.is_admin(auth.uid())
);

do $export_warehouse_constraints$
declare
  v_constraint record;
begin
  for v_constraint in
    select conname
    from pg_constraint
    where conrelid = 'public.export_warehouses'::regclass
      and contype = 'c'
      and (
        pg_get_constraintdef(oid) like '%radius_m%'
        or pg_get_constraintdef(oid) like '%tier%'
      )
  loop
    execute format('alter table public.export_warehouses drop constraint if exists %I', v_constraint.conname);
  end loop;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'export_warehouses_tier_check'
      and conrelid = 'public.export_warehouses'::regclass
  ) then
    alter table public.export_warehouses
    add constraint export_warehouses_tier_check
    check (tier in ('small', 'medium', 'large', 'distance'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'export_warehouses_radius_m_check'
      and conrelid = 'public.export_warehouses'::regclass
  ) then
    alter table public.export_warehouses
    add constraint export_warehouses_radius_m_check
    check (radius_m >= 0);
  end if;
end;
$export_warehouse_constraints$;

create or replace function public.export_distance_multiplier()
returns numeric
language sql
stable
security definer
set search_path = public, extensions
as $export_distance_multiplier$
  select public.export_config_number('distance_multiplier', 0.6);
$export_distance_multiplier$;

create or replace function public.warehouse_footprint_m()
returns integer
language sql
stable
security definer
set search_path = public, extensions
as $warehouse_footprint_m$
  select public.export_config_number('warehouse_footprint_m', 50)::integer;
$warehouse_footprint_m$;

create or replace function public.export_home_base_geog(p_player_id uuid)
returns extensions.geography
language plpgsql
stable
security definer
set search_path = public, extensions
as $export_home_base_geog$
declare
  v_geog extensions.geography;
begin
  select home.geog
  into v_geog
  from public.export_player_home_bases home
  where home.player_id = p_player_id;

  if not found then
    raise exception 'Export home base has not been set.';
  end if;

  return v_geog;
end;
$export_home_base_geog$;

create or replace function public.export_reach_m(
  p_player_id uuid,
  p_geog extensions.geography
)
returns integer
language sql
stable
security definer
set search_path = public, extensions
as $export_reach_m$
  select greatest(
    0,
    round(
      extensions.st_distance(public.export_home_base_geog(p_player_id), p_geog)
      * public.export_distance_multiplier()
    )::integer
  );
$export_reach_m$;

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
    and (
      profile.id = v_player_id
      or public.is_admin(v_player_id)
    )
  order by profile.display_name;
end;
$get_export_players$;

create or replace function public.update_export_home_base(
  p_player_id uuid,
  p_lat double precision,
  p_lng double precision
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $update_export_home_base$
declare
  v_admin_id uuid = auth.uid();
begin
  if v_admin_id is null then
    raise exception 'You must be signed in.';
  end if;

  if not public.is_admin(v_admin_id) then
    raise exception 'Only admins can set export home bases.';
  end if;

  if not exists (
    select 1
    from public.profiles profile
    where profile.id = p_player_id
      and profile.player_mode = 'export'
  ) then
    raise exception 'Export player was not found.';
  end if;

  if not (
    p_lat between -90 and 90
    and p_lng between -180 and 180
  ) then
    raise exception 'Choose a valid export home location.';
  end if;

  insert into public.export_player_home_bases (player_id, lat, lng, updated_by)
  values (p_player_id, p_lat, p_lng, v_admin_id)
  on conflict (player_id) do update
  set lat = excluded.lat,
      lng = excluded.lng,
      updated_by = excluded.updated_by,
      updated_at = now();

  return jsonb_build_object(
    'player_id', p_player_id,
    'lat', p_lat,
    'lng', p_lng
  );
end;
$update_export_home_base$;

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
  where (p_ignore_id is null or warehouse.id <> p_ignore_id)
    and (
      warehouse.disabled_at is null
      or (
        warehouse.disabled_at is not null
        and warehouse.available_at is not null
        and warehouse.available_at > now()
      )
    )
    and extensions.st_dwithin(
      warehouse.geog,
      p_geog,
      public.warehouse_footprint_m() + p_radius_m
    )
  limit 1;

  if found then
    raise exception 'Warehouse footprint overlaps with %.', v_overlap.name;
  end if;
end;
$assert_warehouse_not_overlapping$;

create or replace function public.place_warehouse(
  p_lat double precision,
  p_lng double precision,
  p_name text,
  p_tier text default 'distance',
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
  v_cost numeric(12, 2) = public.export_config_number('warehouse_cost', 100);
  v_profile public.profiles;
  v_warehouse public.export_warehouses;
  v_geog extensions.geography;
  v_radius_m integer;
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
  v_radius_m = public.export_reach_m(v_player_id, v_geog);
  perform public.assert_warehouse_not_overlapping(v_geog, public.warehouse_footprint_m(), null);

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
    'distance',
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
    'radius_m', v_warehouse.radius_m,
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
  v_radius_m integer;
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

  v_radius_m = public.export_reach_m(v_player_id, v_warehouse.geog);

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
  set credit_available = true,
      tier = 'distance',
      radius_m = v_radius_m
  where id = p_warehouse_id
  returning * into v_warehouse;

  return jsonb_build_object(
    'warehouse_id', v_warehouse.id,
    'radius_m', v_warehouse.radius_m,
    'balance', v_balance
  );
end;
$restock_warehouse$;

grant execute on function public.get_export_players() to authenticated;
grant execute on function public.update_export_home_base(uuid, double precision, double precision) to authenticated;
grant execute on function public.place_warehouse(double precision, double precision, text, text, double precision) to authenticated;
grant execute on function public.restock_warehouse(uuid, double precision, double precision, double precision) to authenticated;

revoke execute on function public.export_distance_multiplier() from public, anon, authenticated;
revoke execute on function public.warehouse_footprint_m() from public, anon, authenticated;
revoke execute on function public.export_home_base_geog(uuid) from public, anon, authenticated;
revoke execute on function public.export_reach_m(uuid, extensions.geography) from public, anon, authenticated;
revoke execute on function public.assert_warehouse_not_overlapping(extensions.geography, integer, uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';

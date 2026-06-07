create table if not exists public.demand_events (
  id uuid primary key default extensions.gen_random_uuid(),
  created_by uuid not null references public.profiles(id) on delete cascade,
  label text not null default 'double demand zone' check (length(label) between 1 and 80),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  geog extensions.geography(Point, 4326) not null,
  radius_m double precision not null check (radius_m between 25 and 5000),
  multiplier numeric(6, 2) not null default 2 check (multiplier >= 1 and multiplier <= 10),
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint demand_events_time_check check (ends_at > starts_at)
);

create index if not exists demand_events_geog_idx
on public.demand_events using gist (geog);

create index if not exists demand_events_active_idx
on public.demand_events (starts_at, ends_at)
where ended_at is null;

drop trigger if exists demand_events_touch_updated_at on public.demand_events;
create trigger demand_events_touch_updated_at
before update on public.demand_events
for each row execute function public.touch_updated_at();

alter table public.demand_events enable row level security;

drop policy if exists "demand events are readable" on public.demand_events;
create policy "demand events are readable"
on public.demand_events for select
using (true);

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

  v_base = greatest(1, round((2 + v_pin.busy_score * 0.08)::numeric));

  hourly_rate_points = round(((v_base * v_event_multiplier) / (1 + v_pressure))::numeric, 2);
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

create or replace function public.recalculate_income_periods_in_demand_event(
  p_event_id uuid,
  p_as_of timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $recalculate_income_periods_in_demand_event$
declare
  v_event public.demand_events;
  v_pin record;
begin
  select * into v_event
  from public.demand_events
  where id = p_event_id;

  if not found then
    raise exception 'Event was not found.';
  end if;

  for v_pin in
    select *
    from public.pins
    where disabled_at is null
      and extensions.st_dwithin(geog, v_event.geog, v_event.radius_m)
  loop
    perform public.settle_pin_income_to(v_pin.id, p_as_of);

    update public.pin_income_periods
    set ends_at = p_as_of,
        ending_reason = coalesce(ending_reason, 'event_recalculated'),
        settled_through = greatest(coalesce(settled_through, starts_at), p_as_of)
    where pin_id = v_pin.id
      and starts_at < p_as_of
      and (ends_at is null or ends_at > p_as_of);

    perform public.open_income_period(v_pin.id, p_as_of);
  end loop;
end;
$recalculate_income_periods_in_demand_event$;

drop function if exists public.get_demand_events();

create or replace function public.get_demand_events()
returns table (
  id uuid,
  label text,
  lat double precision,
  lng double precision,
  radius_m double precision,
  multiplier numeric,
  starts_at timestamptz,
  ends_at timestamptz,
  ended_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $get_demand_events$
begin
  return query
  select
    zone.id,
    zone.label,
    zone.lat,
    zone.lng,
    zone.radius_m,
    zone.multiplier,
    zone.starts_at,
    zone.ends_at,
    zone.ended_at
  from public.demand_events zone
  where zone.starts_at <= now()
    and zone.ends_at > now()
    and zone.ended_at is null
  order by zone.ends_at asc;
end;
$get_demand_events$;

drop function if exists public.begin_demand_event(double precision, double precision, double precision, double precision);

create or replace function public.begin_demand_event(
  p_lat double precision,
  p_lng double precision,
  p_radius_m double precision,
  p_duration_hours double precision
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $begin_demand_event$
declare
  v_player_id uuid = auth.uid();
  v_now timestamptz = now();
  v_radius_m double precision = round(coalesce(p_radius_m, 0)::numeric, 1)::double precision;
  v_duration_hours double precision = coalesce(p_duration_hours, 0);
  v_event_id uuid;
begin
  if v_player_id is null then
    raise exception 'You must be signed in.';
  end if;

  if not public.is_admin(v_player_id) then
    raise exception 'Only admins can begin events.';
  end if;

  if p_lat is null or p_lng is null or p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180 then
    raise exception 'Choose a valid event location.';
  end if;

  if v_radius_m < 25 or v_radius_m > 5000 then
    raise exception 'Event radius must be between 25m and 5000m.';
  end if;

  if v_duration_hours < 0.25 or v_duration_hours > 168 then
    raise exception 'Event duration must be between 0.25 and 168 hours.';
  end if;

  insert into public.demand_events (
    created_by,
    label,
    lat,
    lng,
    geog,
    radius_m,
    multiplier,
    starts_at,
    ends_at
  )
  values (
    v_player_id,
    'double demand zone',
    p_lat,
    p_lng,
    extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography,
    v_radius_m,
    2,
    v_now,
    v_now + (interval '1 hour' * v_duration_hours)
  )
  returning id into v_event_id;

  perform public.recalculate_income_periods_in_demand_event(v_event_id, v_now);

  return v_event_id;
end;
$begin_demand_event$;

drop function if exists public.end_demand_event(uuid);

create or replace function public.end_demand_event(p_event_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $end_demand_event$
declare
  v_player_id uuid = auth.uid();
  v_now timestamptz = now();
  v_event public.demand_events;
begin
  if v_player_id is null then
    raise exception 'You must be signed in.';
  end if;

  if not public.is_admin(v_player_id) then
    raise exception 'Only admins can end events.';
  end if;

  select * into v_event
  from public.demand_events
  where id = p_event_id
  for update;

  if not found then
    raise exception 'Event was not found.';
  end if;

  if v_event.ended_at is not null or v_event.ends_at <= v_now then
    raise exception 'This event has already ended.';
  end if;

  update public.demand_events
  set ended_at = v_now,
      ends_at = v_now
  where id = p_event_id;

  perform public.recalculate_income_periods_in_demand_event(p_event_id, v_now);

  return p_event_id;
end;
$end_demand_event$;

grant execute on function public.get_demand_events() to authenticated;
grant execute on function public.get_demand_events() to anon;
grant execute on function public.begin_demand_event(double precision, double precision, double precision, double precision) to authenticated;
grant execute on function public.end_demand_event(uuid) to authenticated;

revoke execute on function public.recalculate_income_periods_in_demand_event(uuid, timestamptz) from public, anon, authenticated;

notify pgrst, 'reload schema';

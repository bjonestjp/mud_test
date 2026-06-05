begin;

create or replace function public.player_color_for_text(p_text text)
returns text
language sql
immutable
as $$
  select (array[
    '#21745c',
    '#2f5f9f',
    '#ba3c3a',
    '#8a5b20',
    '#7a4ab8',
    '#d36b2c',
    '#0f766e',
    '#be185d',
    '#4338ca',
    '#0891b2',
    '#4d7c0f',
    '#b45309',
    '#e11d48',
    '#475569',
    '#6d28d9',
    '#047857',
    '#0369a1',
    '#db2777',
    '#6b8e23',
    '#9f1239'
  ])[1 + ((abs(hashtext(coalesce(nullif(p_text, ''), 'player'))::bigint) % 20)::integer)];
$$;

alter table public.profiles
add column if not exists player_color text;

update public.profiles
set player_color = public.player_color_for_text(id::text)
where player_color is null
   or player_color !~ '^#[0-9A-Fa-f]{6}$';

alter table public.profiles
alter column player_color set default '#21745c',
alter column player_color set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_player_color_hex_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
    add constraint profiles_player_color_hex_check
    check (player_color ~ '^#[0-9A-Fa-f]{6}$');
  end if;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_display_name text;
  v_player_color text;
begin
  v_display_name = coalesce(
    nullif(new.raw_user_meta_data ->> 'display_name', ''),
    split_part(new.email, '@', 1),
    'Player'
  );

  v_player_color = coalesce(
    nullif(new.raw_user_meta_data ->> 'player_color', ''),
    public.player_color_for_text(new.id::text)
  );

  if v_player_color !~ '^#[0-9A-Fa-f]{6}$' then
    v_player_color = public.player_color_for_text(new.id::text);
  end if;

  insert into public.profiles (id, display_name, player_color, points_balance)
  values (new.id, v_display_name, v_player_color, 300)
  on conflict (id) do nothing;

  insert into public.currency_ledger (player_id, amount_points, balance_after, reason)
  values (new.id, 300, 300, 'starting_grant')
  on conflict do nothing;

  return new;
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
    profile.player_color as owner_color,
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

drop function if exists public.get_leaderboard();

create or replace function public.get_leaderboard()
returns table (
  player_id uuid,
  display_name text,
  player_color text,
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
    profile.player_color,
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

grant execute on function public.get_visible_pins() to authenticated;
grant execute on function public.get_leaderboard() to authenticated;

commit;

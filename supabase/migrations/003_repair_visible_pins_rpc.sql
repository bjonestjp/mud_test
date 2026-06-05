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
as $get_leaderboard$
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
$get_leaderboard$;

grant execute on function public.get_visible_pins() to authenticated;
grant execute on function public.get_visible_pins() to anon;
grant execute on function public.get_leaderboard() to authenticated;
grant execute on function public.get_leaderboard() to anon;

notify pgrst, 'reload schema';

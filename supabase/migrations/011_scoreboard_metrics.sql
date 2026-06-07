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
      and pin.visible_at <= now()
      and pin.disabled_at is null
      and not (
        pin.pin_type = 'temporary'
        and pin.expires_at <= now()
      )
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

drop function if exists public.get_score_history();

create or replace function public.get_score_history()
returns table (
  player_id uuid,
  display_name text,
  player_color text,
  points_balance numeric,
  lifetime_income numeric,
  active_pins bigint,
  recorded_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $get_score_history$
begin
  perform public._settle_all_income();

  return query
  with score_times as (
    select
      profile.id as player_id,
      now() as recorded_at
    from public.profiles profile
    union
    select
      ledger.player_id,
      ledger.created_at as recorded_at
    from public.currency_ledger ledger
    union
    select
      pin.owner_id as player_id,
      pin.visible_at as recorded_at
    from public.pins pin
    union
    select
      pin.owner_id as player_id,
      pin.expires_at as recorded_at
    from public.pins pin
    where pin.pin_type = 'temporary'
      and pin.expires_at is not null
    union
    select
      pin.owner_id as player_id,
      pin.disabled_at as recorded_at
    from public.pins pin
    where pin.disabled_at is not null
  )
  select
    profile.id as player_id,
    profile.display_name,
    profile.player_color,
    coalesce(balance_at.points_balance, profile.points_balance) as points_balance,
    coalesce(lifetime_at.lifetime_income, 0) as lifetime_income,
    coalesce(pins_at.active_pins, 0) as active_pins,
    score.recorded_at
  from score_times score
  join public.profiles profile on profile.id = score.player_id
  left join lateral (
    select ledger.balance_after as points_balance
    from public.currency_ledger ledger
    where ledger.player_id = profile.id
      and ledger.created_at <= score.recorded_at
    order by ledger.created_at desc
    limit 1
  ) balance_at on true
  left join lateral (
    select coalesce(sum(ledger.amount_points), 0) as lifetime_income
    from public.currency_ledger ledger
    where ledger.player_id = profile.id
      and ledger.reason = 'income_settlement'
      and ledger.created_at <= score.recorded_at
  ) lifetime_at on true
  left join lateral (
    select count(*) as active_pins
    from public.pins pin
    where pin.owner_id = profile.id
      and pin.visible_at <= score.recorded_at
      and (pin.disabled_at is null or pin.disabled_at > score.recorded_at)
      and not (
        pin.pin_type = 'temporary'
        and pin.expires_at <= score.recorded_at
      )
  ) pins_at on true
  where score.recorded_at is not null
  order by score.recorded_at asc, profile.display_name asc;
end;
$get_score_history$;

grant execute on function public.get_leaderboard() to authenticated;
grant execute on function public.get_leaderboard() to anon;
grant execute on function public.get_score_history() to authenticated;
grant execute on function public.get_score_history() to anon;

notify pgrst, 'reload schema';

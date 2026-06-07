drop function if exists public.get_score_history();

create or replace function public.get_score_history()
returns table (
  player_id uuid,
  display_name text,
  player_color text,
  points_balance numeric,
  recorded_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $get_score_history$
begin
  return query
  with ledger_points as (
    select
      ledger.player_id,
      ledger.balance_after as points_balance,
      ledger.created_at as recorded_at
    from public.currency_ledger ledger
  ),
  current_points as (
    select
      profile.id as player_id,
      profile.points_balance,
      now() as recorded_at
    from public.profiles profile
  ),
  score_points as (
    select * from ledger_points
    union all
    select * from current_points
  )
  select
    profile.id as player_id,
    profile.display_name,
    profile.player_color,
    score.points_balance,
    score.recorded_at
  from score_points score
  join public.profiles profile on profile.id = score.player_id
  order by score.recorded_at asc, profile.display_name asc;
end;
$get_score_history$;

grant execute on function public.get_score_history() to authenticated;
grant execute on function public.get_score_history() to anon;

notify pgrst, 'reload schema';

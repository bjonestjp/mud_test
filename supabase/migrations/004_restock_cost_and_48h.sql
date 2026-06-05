insert into public.game_config (key, value)
values
  ('pin_costs', '{"standard": 200, "temporary": 100, "restock": 25}'::jsonb),
  ('restock', '{"standard_hours": 48}'::jsonb)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();

update public.pins
set restock_due_at = last_restocked_at + interval '48 hours'
where pin_type = 'standard'
  and last_restocked_at is not null
  and restock_due_at is not null
  and restock_due_at > last_restocked_at + interval '48 hours';

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

grant execute on function public.place_pin(double precision, double precision, text, text, double precision) to authenticated;
grant execute on function public.restock_pin(uuid, double precision, double precision, double precision) to authenticated;

notify pgrst, 'reload schema';

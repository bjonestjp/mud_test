insert into public.game_config (key, value)
values (
  'pin_costs',
  '{"rename": 25}'::jsonb
)
on conflict (key) do update
set value = coalesce(public.game_config.value, '{}'::jsonb) || excluded.value,
    updated_at = now();

create or replace function public.rename_pin(
  p_pin_id uuid,
  p_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $rename_pin$
declare
  v_player_id uuid = auth.uid();
  v_cost numeric(12, 2) = 25;
  v_pin public.pins;
  v_profile public.profiles;
  v_name text = left(coalesce(nullif(trim(p_name), ''), ''), 80);
  v_balance numeric(12, 2);
begin
  if v_player_id is null then
    raise exception 'You must be signed in.';
  end if;

  if v_name = '' then
    raise exception 'Add a shop name.';
  end if;

  perform public._settle_player_income(v_player_id);

  select * into v_pin
  from public.pins
  where id = p_pin_id
    and disabled_at is null
  for update;

  if not found then
    raise exception 'Shop was not found.';
  end if;

  if v_pin.owner_id <> v_player_id then
    raise exception 'You can only rename your own shops.';
  end if;

  if v_pin.name = v_name then
    raise exception 'Choose a new shop name.';
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
    'pin_rename',
    p_pin_id
  );

  update public.pins
  set name = v_name
  where id = v_pin.id
  returning * into v_pin;

  return jsonb_build_object(
    'pin_id', v_pin.id,
    'name', v_pin.name,
    'balance', v_balance
  );
end;
$rename_pin$;

grant execute on function public.rename_pin(uuid, text) to authenticated;

notify pgrst, 'reload schema';

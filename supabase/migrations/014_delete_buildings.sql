create or replace function public.delete_pin(p_pin_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $delete_pin$
declare
  v_player_id uuid = auth.uid();
  v_now timestamptz = now();
  v_pin public.pins;
begin
  if v_player_id is null then
    raise exception 'You must be signed in.';
  end if;

  perform public._settle_player_income(v_player_id);

  select * into v_pin
  from public.pins
  where id = p_pin_id
  for update;

  if not found then
    raise exception 'Shop was not found.';
  end if;

  if v_pin.owner_id <> v_player_id then
    raise exception 'You can only delete your own shops.';
  end if;

  if v_pin.disabled_at is not null then
    raise exception 'This shop has already been deleted.';
  end if;

  perform public.settle_pin_income_to(v_pin.id, v_now);

  update public.pin_income_periods
  set ends_at = v_now,
      ending_reason = coalesce(ending_reason, 'deleted'),
      settled_through = greatest(coalesce(settled_through, starts_at), v_now)
  where pin_id = v_pin.id
    and starts_at < v_now
    and (ends_at is null or ends_at > v_now);

  update public.pins
  set disabled_at = v_now
  where id = v_pin.id;

  perform public.recalculate_income_periods_near(v_pin.geog, v_now);

  return jsonb_build_object(
    'pin_id', v_pin.id,
    'deleted_at', v_now
  );
end;
$delete_pin$;

create or replace function public.delete_warehouse(p_warehouse_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $delete_warehouse$
declare
  v_player_id uuid = auth.uid();
  v_now timestamptz = now();
  v_warehouse public.export_warehouses;
begin
  if v_player_id is null then
    raise exception 'You must be signed in.';
  end if;

  select * into v_warehouse
  from public.export_warehouses
  where id = p_warehouse_id
  for update;

  if not found then
    raise exception 'Warehouse was not found.';
  end if;

  if v_warehouse.owner_id <> v_player_id then
    raise exception 'You can only delete your own warehouses.';
  end if;

  if v_warehouse.disabled_at is not null then
    raise exception 'This warehouse has already been deleted.';
  end if;

  update public.export_warehouses
  set disabled_at = v_now,
      credit_available = false
  where id = v_warehouse.id;

  return jsonb_build_object(
    'warehouse_id', v_warehouse.id,
    'deleted_at', v_now
  );
end;
$delete_warehouse$;

grant execute on function public.delete_pin(uuid) to authenticated;
grant execute on function public.delete_warehouse(uuid) to authenticated;

notify pgrst, 'reload schema';

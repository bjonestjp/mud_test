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
      warehouse.radius_m + p_radius_m
    )
  limit 1;

  if found then
    raise exception 'Warehouse radius overlaps with %.', v_overlap.name;
  end if;
end;
$assert_warehouse_not_overlapping$;

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
  v_available_at timestamptz;
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

  v_available_at = case
    when v_warehouse.available_at is not null and v_warehouse.available_at > v_now then v_warehouse.available_at
    else v_now
  end;

  update public.export_warehouses
  set disabled_at = v_now,
      credit_available = false,
      available_at = v_available_at
  where id = v_warehouse.id;

  return jsonb_build_object(
    'warehouse_id', v_warehouse.id,
    'deleted_at', v_now,
    'blocked_until', v_available_at
  );
end;
$delete_warehouse$;

grant execute on function public.delete_warehouse(uuid) to authenticated;

revoke execute on function public.assert_warehouse_not_overlapping(extensions.geography, integer, uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';

drop function if exists public.update_bulletin(uuid, text, text, text);

create or replace function public.update_bulletin(
  p_bulletin_id uuid,
  p_title text,
  p_body text,
  p_image_path text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $update_bulletin$
declare
  v_player_id uuid = auth.uid();
  v_title text = trim(coalesce(p_title, ''));
  v_body text = trim(coalesce(p_body, ''));
  v_new_image_path text = nullif(trim(coalesce(p_image_path, '')), '');
  v_bulletin public.bulletins;
begin
  if v_player_id is null then
    raise exception 'You must be signed in.';
  end if;

  if not public.is_admin(v_player_id) then
    raise exception 'Only admins can edit bulletins.';
  end if;

  if length(v_title) < 1 or length(v_title) > 120 then
    raise exception 'Bulletin title must be between 1 and 120 characters.';
  end if;

  if length(v_body) < 1 or length(v_body) > 5000 then
    raise exception 'Bulletin body must be between 1 and 5000 characters.';
  end if;

  select * into v_bulletin
  from public.bulletins
  where id = p_bulletin_id
  for update;

  if not found then
    raise exception 'Bulletin was not found.';
  end if;

  if v_new_image_path is not null and length(v_new_image_path) > 500 then
    raise exception 'Bulletin image path is too long.';
  end if;

  update public.bulletins
  set title = v_title,
      body = v_body,
      image_path = coalesce(v_new_image_path, v_bulletin.image_path)
  where id = p_bulletin_id;

  return jsonb_build_object(
    'bulletin_id', p_bulletin_id,
    'image_path', coalesce(v_new_image_path, v_bulletin.image_path),
    'previous_image_path', v_bulletin.image_path
  );
end;
$update_bulletin$;

drop function if exists public.delete_bulletin(uuid);

create or replace function public.delete_bulletin(p_bulletin_id uuid)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $delete_bulletin$
declare
  v_player_id uuid = auth.uid();
  v_image_path text;
begin
  if v_player_id is null then
    raise exception 'You must be signed in.';
  end if;

  if not public.is_admin(v_player_id) then
    raise exception 'Only admins can delete bulletins.';
  end if;

  delete from public.bulletins
  where id = p_bulletin_id
  returning image_path into v_image_path;

  if v_image_path is null then
    raise exception 'Bulletin was not found.';
  end if;

  return v_image_path;
end;
$delete_bulletin$;

grant execute on function public.update_bulletin(uuid, text, text, text) to authenticated;
grant execute on function public.delete_bulletin(uuid) to authenticated;

notify pgrst, 'reload schema';

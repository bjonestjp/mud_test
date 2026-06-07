alter table public.profiles
add column if not exists account_role text not null default 'player';

do $profiles_account_role_check$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_account_role_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
    add constraint profiles_account_role_check
    check (account_role in ('player', 'admin'));
  end if;
end;
$profiles_account_role_check$;

create or replace function public.profile_account_role(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public, extensions
as $profile_account_role$
  select coalesce(
    (select profile.account_role from public.profiles profile where profile.id = p_user_id),
    'player'
  );
$profile_account_role$;

create or replace function public.is_admin(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $is_admin$
  select public.profile_account_role(p_user_id) = 'admin';
$is_admin$;

drop policy if exists "players can update their profile" on public.profiles;
create policy "players can update their profile"
on public.profiles for update
using (id = auth.uid())
with check (
  id = auth.uid()
  and account_role = public.profile_account_role(auth.uid())
);

create table if not exists public.bulletins (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (length(title) between 1 and 120),
  body text not null check (length(body) between 1 and 5000),
  image_path text not null check (length(image_path) between 1 and 500),
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists bulletins_published_idx
on public.bulletins (published_at desc);

alter table public.bulletins enable row level security;

drop policy if exists "bulletins are readable" on public.bulletins;
create policy "bulletins are readable"
on public.bulletins for select
using (published_at <= now());

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'bulletin-images',
  'bulletin-images',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']::text[]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "bulletin images are readable" on storage.objects;
create policy "bulletin images are readable"
on storage.objects for select
using (bucket_id = 'bulletin-images');

drop policy if exists "admins can upload bulletin images" on storage.objects;
create policy "admins can upload bulletin images"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'bulletin-images'
  and public.is_admin(auth.uid())
);

drop policy if exists "admins can update bulletin images" on storage.objects;
create policy "admins can update bulletin images"
on storage.objects for update
to authenticated
using (
  bucket_id = 'bulletin-images'
  and public.is_admin(auth.uid())
)
with check (
  bucket_id = 'bulletin-images'
  and public.is_admin(auth.uid())
);

drop policy if exists "admins can delete bulletin images" on storage.objects;
create policy "admins can delete bulletin images"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'bulletin-images'
  and public.is_admin(auth.uid())
);

drop function if exists public.get_bulletins();

create or replace function public.get_bulletins()
returns table (
  id uuid,
  title text,
  body text,
  image_path text,
  author_id uuid,
  author_name text,
  published_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $get_bulletins$
begin
  return query
  select
    bulletin.id,
    bulletin.title,
    bulletin.body,
    bulletin.image_path,
    bulletin.author_id,
    profile.display_name as author_name,
    bulletin.published_at
  from public.bulletins bulletin
  join public.profiles profile on profile.id = bulletin.author_id
  where bulletin.published_at <= now()
  order by bulletin.published_at desc;
end;
$get_bulletins$;

drop function if exists public.create_bulletin(text, text, text);

create or replace function public.create_bulletin(
  p_title text,
  p_body text,
  p_image_path text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $create_bulletin$
declare
  v_player_id uuid = auth.uid();
  v_title text = trim(coalesce(p_title, ''));
  v_body text = trim(coalesce(p_body, ''));
  v_image_path text = trim(coalesce(p_image_path, ''));
  v_bulletin_id uuid;
begin
  if v_player_id is null then
    raise exception 'You must be signed in.';
  end if;

  if not public.is_admin(v_player_id) then
    raise exception 'Only admins can send bulletins.';
  end if;

  if length(v_title) < 1 or length(v_title) > 120 then
    raise exception 'Bulletin title must be between 1 and 120 characters.';
  end if;

  if length(v_body) < 1 or length(v_body) > 5000 then
    raise exception 'Bulletin body must be between 1 and 5000 characters.';
  end if;

  if length(v_image_path) < 1 or length(v_image_path) > 500 then
    raise exception 'Bulletin image is required.';
  end if;

  insert into public.bulletins (
    author_id,
    title,
    body,
    image_path
  )
  values (
    v_player_id,
    v_title,
    v_body,
    v_image_path
  )
  returning id into v_bulletin_id;

  return v_bulletin_id;
end;
$create_bulletin$;

grant execute on function public.get_bulletins() to authenticated;
grant execute on function public.get_bulletins() to anon;
grant execute on function public.create_bulletin(text, text, text) to authenticated;
grant execute on function public.is_admin(uuid) to authenticated;
grant execute on function public.profile_account_role(uuid) to authenticated;

notify pgrst, 'reload schema';

-- K8 Return Processing System V8
-- Run this entire file once in Supabase Dashboard -> SQL Editor.

begin;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.return_batches (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists return_batches_user_updated_idx
  on public.return_batches (user_id, updated_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists set_return_batches_updated_at on public.return_batches;
create trigger set_return_batches_updated_at
before update on public.return_batches
for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.return_batches enable row level security;

drop policy if exists "Users read own profile" on public.profiles;
create policy "Users read own profile"
on public.profiles for select
to authenticated
using ((select auth.uid()) = id);

drop policy if exists "Users update own profile" on public.profiles;
create policy "Users update own profile"
on public.profiles for update
to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

drop policy if exists "Users read own return batches" on public.return_batches;
create policy "Users read own return batches"
on public.return_batches for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users insert own return batches" on public.return_batches;
create policy "Users insert own return batches"
on public.return_batches for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Users update own return batches" on public.return_batches;
create policy "Users update own return batches"
on public.return_batches for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Users delete own return batches" on public.return_batches;
create policy "Users delete own return batches"
on public.return_batches for delete
to authenticated
using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.return_batches to authenticated;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'return-photos',
  'return-photos',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users read own return photos" on storage.objects;
create policy "Users read own return photos"
on storage.objects for select
to authenticated
using (
  bucket_id = 'return-photos'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "Users upload own return photos" on storage.objects;
create policy "Users upload own return photos"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'return-photos'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "Users update own return photos" on storage.objects;
create policy "Users update own return photos"
on storage.objects for update
to authenticated
using (
  bucket_id = 'return-photos'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
)
with check (
  bucket_id = 'return-photos'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "Users delete own return photos" on storage.objects;
create policy "Users delete own return photos"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'return-photos'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

alter table public.return_batches replica identity full;

do $$
begin
  alter publication supabase_realtime add table public.return_batches;
exception
  when duplicate_object then null;
end
$$;

commit;

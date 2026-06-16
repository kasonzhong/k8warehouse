-- K8 Return Processing System V9: cloud accounts + sharing permissions
-- Run this entire script in Supabase Dashboard -> SQL Editor.

begin;

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.profiles add column if not exists email text;

create table if not exists public.return_batches (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.return_batch_shares (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  batch_id text not null,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  permission text not null check (permission in ('view','edit')),
  status text not null default 'pending' check (status in ('pending','accepted','rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  responded_at timestamptz,
  unique (owner_id, batch_id, recipient_id),
  foreign key (owner_id, batch_id) references public.return_batches(user_id, id) on delete cascade
);

create index if not exists return_batches_user_updated_idx on public.return_batches(user_id, updated_at desc);
create index if not exists return_batch_shares_recipient_idx on public.return_batch_shares(recipient_id, status);
create index if not exists return_batch_shares_owner_idx on public.return_batch_shares(owner_id, batch_id);

create or replace function public.set_updated_at()
returns trigger language plpgsql security invoker set search_path = public as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at before update on public.profiles for each row execute function public.set_updated_at();
drop trigger if exists set_return_batches_updated_at on public.return_batches;
create trigger set_return_batches_updated_at before update on public.return_batches for each row execute function public.set_updated_at();
drop trigger if exists set_return_batch_shares_updated_at on public.return_batch_shares;
create trigger set_return_batch_shares_updated_at before update on public.return_batch_shares for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id, display_name, email)
  values(new.id, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email,'@',1)), new.email)
  on conflict(id) do update set email=excluded.email;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert or update of email on auth.users for each row execute function public.handle_new_user();

insert into public.profiles(id, display_name, email)
select id, coalesce(raw_user_meta_data ->> 'display_name', split_part(email,'@',1)), email from auth.users
on conflict(id) do update set email=excluded.email;

alter table public.profiles enable row level security;
alter table public.return_batches enable row level security;
alter table public.return_batch_shares enable row level security;

-- Profiles remain private; sharing RPCs reveal only connected users.
drop policy if exists "Users read own profile" on public.profiles;
create policy "Users read own profile" on public.profiles for select to authenticated using ((select auth.uid())=id);
drop policy if exists "Users update own profile" on public.profiles;
create policy "Users update own profile" on public.profiles for update to authenticated using ((select auth.uid())=id) with check ((select auth.uid())=id);

-- A user may select a batch they own or an accepted batch shared with them.
drop policy if exists "Users read accessible return batches" on public.return_batches;
create policy "Users read accessible return batches" on public.return_batches for select to authenticated using (
  (select auth.uid()) = user_id or exists (
    select 1 from public.return_batch_shares s
    where s.owner_id=return_batches.user_id and s.batch_id=return_batches.id
      and s.recipient_id=(select auth.uid()) and s.status='accepted'
  )
);

-- Writes happen only through checked RPC functions below.
drop policy if exists "Users insert own return batches" on public.return_batches;
drop policy if exists "Users update own return batches" on public.return_batches;
drop policy if exists "Users delete own return batches" on public.return_batches;

-- Share rows are visible only to owner and recipient.
drop policy if exists "Participants read return shares" on public.return_batch_shares;
create policy "Participants read return shares" on public.return_batch_shares for select to authenticated using (
  (select auth.uid())=owner_id or (select auth.uid())=recipient_id
);

revoke all on public.return_batches from anon, authenticated;
revoke all on public.return_batch_shares from anon, authenticated;
grant select on public.return_batches to authenticated;
grant select on public.return_batch_shares to authenticated;
grant select, update on public.profiles to authenticated;

create or replace function public.list_accessible_return_batches()
returns table(user_id uuid,id text,payload jsonb,created_at timestamptz,updated_at timestamptz,access_role text,owner_name text,owner_email text)
language sql stable security definer set search_path = '' as $$
  select b.user_id,b.id,b.payload,b.created_at,b.updated_at,
    case when b.user_id=auth.uid() then 'owner' else coalesce(s.permission,'view') end,
    coalesce(p.display_name, split_part(p.email,'@',1)), p.email
  from public.return_batches b
  left join public.return_batch_shares s on s.owner_id=b.user_id and s.batch_id=b.id
    and s.recipient_id=auth.uid() and s.status='accepted'
  left join public.profiles p on p.id=b.user_id
  where b.user_id=auth.uid() or s.id is not null
  order by b.updated_at desc;
$$;

create or replace function public.save_return_batch(p_owner_id uuid,p_batch_id text,p_payload jsonb,p_created_at timestamptz,p_updated_at timestamptz)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if p_owner_id=auth.uid() then
    insert into public.return_batches(user_id,id,payload,created_at,updated_at)
    values(p_owner_id,p_batch_id,p_payload,coalesce(p_created_at,now()),coalesce(p_updated_at,now()))
    on conflict(user_id,id) do update set payload=excluded.payload, updated_at=excluded.updated_at;
  elsif exists(select 1 from public.return_batch_shares s where s.owner_id=p_owner_id and s.batch_id=p_batch_id and s.recipient_id=auth.uid() and s.status='accepted' and s.permission='edit') then
    update public.return_batches set payload=p_payload, updated_at=coalesce(p_updated_at,now()) where user_id=p_owner_id and id=p_batch_id;
  else
    raise exception 'edit_permission_required';
  end if;
end; $$;

create or replace function public.delete_return_batch(p_owner_id uuid,p_batch_id text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid()<>p_owner_id then raise exception 'owner_only'; end if;
  delete from public.return_batches where user_id=p_owner_id and id=p_batch_id;
end; $$;

create or replace function public.invite_return_batch(p_batch_id text,p_recipient_email text,p_permission text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_recipient uuid; v_id uuid;
begin
  if p_permission not in ('view','edit') then raise exception 'invalid_permission'; end if;
  if not exists(select 1 from public.return_batches b where b.user_id=auth.uid() and b.id=p_batch_id) then raise exception 'not_owner'; end if;
  select u.id into v_recipient from auth.users u where lower(u.email)=lower(trim(p_recipient_email)) limit 1;
  if v_recipient is null then raise exception 'recipient_not_found'; end if;
  if v_recipient=auth.uid() then raise exception 'cannot_share_with_self'; end if;
  insert into public.return_batch_shares(owner_id,batch_id,recipient_id,permission,status,responded_at)
  values(auth.uid(),p_batch_id,v_recipient,p_permission,'pending',null)
  on conflict(owner_id,batch_id,recipient_id) do update set permission=excluded.permission,status='pending',responded_at=null,updated_at=now()
  returning id into v_id;
  return v_id;
end; $$;

create or replace function public.list_return_batch_shares(p_batch_id text)
returns table(id uuid,recipient_id uuid,recipient_name text,recipient_email text,permission text,status text,created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select s.id,s.recipient_id,coalesce(p.display_name,split_part(p.email,'@',1)),p.email,s.permission,s.status,s.created_at
  from public.return_batch_shares s join public.profiles p on p.id=s.recipient_id
  where s.owner_id=auth.uid() and s.batch_id=p_batch_id order by s.created_at desc;
$$;

create or replace function public.list_pending_return_batch_invitations()
returns table(id uuid,owner_id uuid,owner_name text,owner_email text,batch_id text,batch_name text,permission text,created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select s.id,s.owner_id,coalesce(p.display_name,split_part(p.email,'@',1)),p.email,s.batch_id,coalesce(b.payload->>'name',s.batch_id),s.permission,s.created_at
  from public.return_batch_shares s join public.return_batches b on b.user_id=s.owner_id and b.id=s.batch_id join public.profiles p on p.id=s.owner_id
  where s.recipient_id=auth.uid() and s.status='pending' order by s.created_at desc;
$$;

create or replace function public.respond_to_return_batch_share(p_share_id uuid,p_accept boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.return_batch_shares set status=case when p_accept then 'accepted' else 'rejected' end,responded_at=now()
  where id=p_share_id and recipient_id=auth.uid();
  if not found then raise exception 'invitation_not_found'; end if;
end; $$;

create or replace function public.set_return_batch_share_permission(p_share_id uuid,p_permission text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_permission not in ('view','edit') then raise exception 'invalid_permission'; end if;
  update public.return_batch_shares set permission=p_permission where id=p_share_id and owner_id=auth.uid();
  if not found then raise exception 'share_not_found'; end if;
end; $$;

create or replace function public.revoke_return_batch_share(p_share_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.return_batch_shares where id=p_share_id and owner_id=auth.uid();
  if not found then raise exception 'share_not_found'; end if;
end; $$;

revoke all on function public.list_accessible_return_batches() from public;
revoke all on function public.save_return_batch(uuid,text,jsonb,timestamptz,timestamptz) from public;
revoke all on function public.delete_return_batch(uuid,text) from public;
revoke all on function public.invite_return_batch(text,text,text) from public;
revoke all on function public.list_return_batch_shares(text) from public;
revoke all on function public.list_pending_return_batch_invitations() from public;
revoke all on function public.respond_to_return_batch_share(uuid,boolean) from public;
revoke all on function public.set_return_batch_share_permission(uuid,text) from public;
revoke all on function public.revoke_return_batch_share(uuid) from public;
grant execute on function public.list_accessible_return_batches() to authenticated;
grant execute on function public.save_return_batch(uuid,text,jsonb,timestamptz,timestamptz) to authenticated;
grant execute on function public.delete_return_batch(uuid,text) to authenticated;
grant execute on function public.invite_return_batch(text,text,text) to authenticated;
grant execute on function public.list_return_batch_shares(text) to authenticated;
grant execute on function public.list_pending_return_batch_invitations() to authenticated;
grant execute on function public.respond_to_return_batch_share(uuid,boolean) to authenticated;
grant execute on function public.set_return_batch_share_permission(uuid,text) to authenticated;
grant execute on function public.revoke_return_batch_share(uuid) to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('return-photos','return-photos',false,10485760,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

-- Replace V8 storage policies with owner/shared policies.
drop policy if exists "Users read own return photos" on storage.objects;
drop policy if exists "Users upload own return photos" on storage.objects;
drop policy if exists "Users update own return photos" on storage.objects;
drop policy if exists "Users delete own return photos" on storage.objects;
drop policy if exists "Users read accessible return photos" on storage.objects;
drop policy if exists "Users write editable return photos" on storage.objects;
drop policy if exists "Users update editable return photos" on storage.objects;
drop policy if exists "Users delete editable return photos" on storage.objects;

create policy "Users read accessible return photos" on storage.objects for select to authenticated using (
  bucket_id='return-photos' and (
    (storage.foldername(name))[1]=auth.uid()::text or exists(
      select 1 from public.return_batch_shares s where s.owner_id::text=(storage.foldername(name))[1]
        and s.batch_id=(storage.foldername(name))[2] and s.recipient_id=auth.uid() and s.status='accepted'
    )
  )
);
create policy "Users write editable return photos" on storage.objects for insert to authenticated with check (
  bucket_id='return-photos' and (
    (storage.foldername(name))[1]=auth.uid()::text or exists(
      select 1 from public.return_batch_shares s where s.owner_id::text=(storage.foldername(name))[1]
        and s.batch_id=(storage.foldername(name))[2] and s.recipient_id=auth.uid() and s.status='accepted' and s.permission='edit'
    )
  )
);
create policy "Users update editable return photos" on storage.objects for update to authenticated using (
  bucket_id='return-photos' and ((storage.foldername(name))[1]=auth.uid()::text or exists(select 1 from public.return_batch_shares s where s.owner_id::text=(storage.foldername(name))[1] and s.batch_id=(storage.foldername(name))[2] and s.recipient_id=auth.uid() and s.status='accepted' and s.permission='edit'))
) with check (
  bucket_id='return-photos' and ((storage.foldername(name))[1]=auth.uid()::text or exists(select 1 from public.return_batch_shares s where s.owner_id::text=(storage.foldername(name))[1] and s.batch_id=(storage.foldername(name))[2] and s.recipient_id=auth.uid() and s.status='accepted' and s.permission='edit'))
);
create policy "Users delete editable return photos" on storage.objects for delete to authenticated using (
  bucket_id='return-photos' and ((storage.foldername(name))[1]=auth.uid()::text or exists(select 1 from public.return_batch_shares s where s.owner_id::text=(storage.foldername(name))[1] and s.batch_id=(storage.foldername(name))[2] and s.recipient_id=auth.uid() and s.status='accepted' and s.permission='edit'))
);

alter table public.return_batches replica identity full;
alter table public.return_batch_shares replica identity full;
do $$ begin alter publication supabase_realtime add table public.return_batches; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.return_batch_shares; exception when duplicate_object then null; end $$;

commit;

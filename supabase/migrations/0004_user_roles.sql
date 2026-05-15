-- User roles: admin / editor / readonly.
--
-- Design notes:
--   • `public.user_profiles` is a 1-to-1 shadow of auth.users keyed by user_id.
--     We denormalise `email` for the admin UI so it can list users without the
--     service_role key (Supabase doesn't expose auth.users to anon/authenticated).
--   • A trigger on auth.users auto-creates a profile row on signup with role
--     'readonly' — access is opt-in; an admin promotes users from there.
--   • is_editor() / is_admin() are SECURITY DEFINER helpers safe to call in RLS.
--   • tracking_records INSERT/UPDATE now require is_editor() — readonly users
--     can browse but not mutate. SELECT stays open to any authenticated user.
--
-- Safe to re-run (idempotent).

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. ROLE ENUM
-- ─────────────────────────────────────────────────────────────────────────────
do $$ begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type public.user_role as enum ('admin', 'editor', 'readonly');
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. PROFILES TABLE
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.user_profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  role        public.user_role not null default 'readonly',
  email       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.user_profiles enable row level security;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. AUTO-CREATE PROFILE ON SIGNUP (+ backfill existing users)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (user_id, email)
  values (new.id, new.email)
  on conflict (user_id) do update set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill anyone who signed up before this migration
insert into public.user_profiles (user_id, email)
select id, email from auth.users
on conflict (user_id) do update set email = excluded.email;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. HELPER FUNCTIONS (SECURITY DEFINER so they see auth.uid() cleanly in RLS)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.current_user_role()
returns public.user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.user_profiles where user_id = auth.uid();
$$;

create or replace function public.is_editor()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role from public.user_profiles where user_id = auth.uid()) in ('admin','editor'),
    false
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role from public.user_profiles where user_id = auth.uid()) = 'admin',
    false
  );
$$;

grant execute on function public.current_user_role() to anon, authenticated;
grant execute on function public.is_editor()          to anon, authenticated;
grant execute on function public.is_admin()           to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. RLS POLICIES ON user_profiles
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists "self read profile"   on public.user_profiles;
drop policy if exists "admin read all"      on public.user_profiles;
drop policy if exists "admin update role"   on public.user_profiles;

-- Anyone authenticated can read their own profile (to learn their role).
-- Admins can read every row (for the Manage Users modal).
create policy "self read profile" on public.user_profiles
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- Only admins can change a role. No one can insert/delete directly — the
-- trigger on auth.users handles row creation; account removal cascades.
create policy "admin update role" on public.user_profiles
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. TIGHTEN tracking_records POLICIES — writes require editor or admin
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists "authenticated insert" on public.tracking_records;
create policy "authenticated insert" on public.tracking_records
  for insert to authenticated
  with check (created_by = auth.uid() and public.is_editor());

drop policy if exists "authenticated update" on public.tracking_records;
create policy "authenticated update" on public.tracking_records
  for update to authenticated
  using (public.is_editor())
  with check (updated_by = auth.uid() and public.is_editor());
-- SELECT / READ policy stays untouched — any authenticated user can browse.

commit;

-- ─────────────────────────────────────────────────────────────────────────────
-- AFTER APPLYING: promote the first admin
-- ─────────────────────────────────────────────────────────────────────────────
-- Run once in the SQL editor, substituting your email:
--
--   update public.user_profiles
--      set role = 'admin'
--    where email = 'pawel@powernaturally.co.uk';
--
-- From then on, that user can promote/demote others from the Manage Users UI.

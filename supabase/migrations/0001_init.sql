-- SimPro Materials Tracker — initial schema
-- Design notes:
--   Single-tenant (PowerNaturally only). All authenticated users read/write everything.
--   Row identity: (job_id, cost_centre_id, section_id, material_id, location_id, occurrence_index)
--     → synthetic UUID PK for FK convenience; natural composite has a UNIQUE index
--   Audit log is append-only, populated by trigger — the client cannot bypass it
--   Realtime is enabled on tracking_records so clients subscribed to a cost-centre
--     see live updates from other users
--
-- Apply order: run this file in the Supabase SQL editor. It is idempotent —
-- safe to re-run during development (re-creates enums/tables/views cleanly).

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. ENUMS
-- ─────────────────────────────────────────────────────────────────────────────

do $$ begin
  if not exists (select 1 from pg_type where typname = 'delivery_route') then
    create type public.delivery_route as enum (
      'WH_ST',      -- Warehouse → Site
      'SU_WH_ST',   -- Supplier → Warehouse → Site
      'SU_ST'       -- Supplier → Site
    );
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'delivery_status') then
    create type public.delivery_status as enum (
      'not_actioned',         -- default
      'ordered',
      'confirmed',
      'shipped',
      'collected_engineer',
      'collected_customer',
      'delivered',
      'receipt_confirmed',    -- counts toward 100% progress
      'returned'
    );
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. CORE TABLE: tracking_records (one row per SimPro allocation line)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.tracking_records (
  id                uuid primary key default gen_random_uuid(),
  -- Natural key components
  job_id            bigint not null,
  cost_centre_id    bigint not null,
  section_id        bigint not null,
  material_id       bigint not null,
  location_id       bigint not null,
  occurrence_index  smallint not null default 0,
  -- Display metadata (denormalised from SimPro for offline / list-page use)
  material_code     text,
  material_name     text,
  location_name     text,
  required_qty      numeric(14, 4),
  assigned_qty      numeric(14, 4),
  -- Tracked state
  route             public.delivery_route,
  tracking_no       text,
  status            public.delivery_status not null default 'not_actioned',
  notes             text,
  -- Audit fields
  created_at        timestamptz not null default now(),
  created_by        uuid references auth.users(id) on delete set null,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references auth.users(id) on delete set null
);

-- Unique natural key
create unique index if not exists tracking_records_natural_key
  on public.tracking_records (job_id, cost_centre_id, section_id, material_id, location_id, occurrence_index);

-- Helpful indexes
create index if not exists tracking_records_job_idx         on public.tracking_records (job_id);
create index if not exists tracking_records_cost_centre_idx on public.tracking_records (cost_centre_id);
create index if not exists tracking_records_status_idx      on public.tracking_records (status);

-- Enable Row-Level Security
alter table public.tracking_records enable row level security;

-- RLS policies: any authenticated user in the project can read/write.
-- (Single-tenant; access gated by Supabase Auth membership.)
drop policy if exists "authenticated read"   on public.tracking_records;
drop policy if exists "authenticated insert" on public.tracking_records;
drop policy if exists "authenticated update" on public.tracking_records;

create policy "authenticated read"
  on public.tracking_records for select
  to authenticated
  using (true);

create policy "authenticated insert"
  on public.tracking_records for insert
  to authenticated
  with check (created_by = auth.uid());

create policy "authenticated update"
  on public.tracking_records for update
  to authenticated
  using (true)
  with check (updated_by = auth.uid());

-- Deliberately NO delete policy — records are immutable once created.
-- (If a user needs to remove a line, they set status='returned' or we add a soft-delete later.)

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. AUDIT LOG
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.tracking_audit (
  id           bigserial primary key,
  record_id    uuid not null references public.tracking_records(id) on delete cascade,
  changed_by   uuid references auth.users(id) on delete set null,
  changed_at   timestamptz not null default now(),
  op           text not null check (op in ('INSERT','UPDATE')),
  field        text,           -- null for INSERT rows
  old_value    text,
  new_value    text
);

create index if not exists tracking_audit_record_idx on public.tracking_audit (record_id, changed_at desc);

alter table public.tracking_audit enable row level security;

drop policy if exists "authenticated read audit" on public.tracking_audit;
create policy "authenticated read audit"
  on public.tracking_audit for select
  to authenticated
  using (true);
-- INSERT only via trigger (security definer), no direct-write policy.

-- Trigger 1 — stamp updated_at / updated_by on UPDATE (BEFORE so NEW is mutable)
create or replace function public.tracking_records_stamp_fn()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end;
$$;

drop trigger if exists tracking_records_stamp on public.tracking_records;
create trigger tracking_records_stamp
  before update on public.tracking_records
  for each row execute function public.tracking_records_stamp_fn();

-- Trigger 2 — audit (AFTER INSERT OR UPDATE so the FK can resolve the new record)
create or replace function public.tracking_records_audit_fn()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    insert into public.tracking_audit(record_id, changed_by, op, field, old_value, new_value)
    values (new.id, v_actor, 'INSERT', null, null, null);
  elsif tg_op = 'UPDATE' then
    if new.route is distinct from old.route then
      insert into public.tracking_audit(record_id, changed_by, op, field, old_value, new_value)
      values (new.id, v_actor, 'UPDATE', 'route', old.route::text, new.route::text);
    end if;
    if new.tracking_no is distinct from old.tracking_no then
      insert into public.tracking_audit(record_id, changed_by, op, field, old_value, new_value)
      values (new.id, v_actor, 'UPDATE', 'tracking_no', old.tracking_no, new.tracking_no);
    end if;
    if new.status is distinct from old.status then
      insert into public.tracking_audit(record_id, changed_by, op, field, old_value, new_value)
      values (new.id, v_actor, 'UPDATE', 'status', old.status::text, new.status::text);
    end if;
    if new.notes is distinct from old.notes then
      insert into public.tracking_audit(record_id, changed_by, op, field, old_value, new_value)
      values (new.id, v_actor, 'UPDATE', 'notes', old.notes, new.notes);
    end if;
  end if;
  return null; -- AFTER trigger return value is ignored
end;
$$;

drop trigger if exists tracking_records_audit on public.tracking_records;
create trigger tracking_records_audit
  after insert or update on public.tracking_records
  for each row execute function public.tracking_records_audit_fn();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. PROGRESS VIEW — drives cost-centre list-page bars
-- ─────────────────────────────────────────────────────────────────────────────

create or replace view public.cost_centre_progress as
select
  job_id,
  cost_centre_id,
  count(*)                                              as total_lines,
  count(*) filter (where status = 'receipt_confirmed')  as confirmed_lines,
  count(*) filter (where status = 'returned')           as returned_lines,
  case when count(*) = 0 then 0
       else round(100.0 * count(*) filter (where status = 'receipt_confirmed') / count(*), 2)
  end as progress_pct
from public.tracking_records
group by job_id, cost_centre_id;

-- Expose the view through PostgREST
grant select on public.cost_centre_progress to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. REALTIME — multi-user sync
-- ─────────────────────────────────────────────────────────────────────────────

-- Add tracking_records to the realtime publication if not already included.
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tracking_records'
  ) then
    execute 'alter publication supabase_realtime add table public.tracking_records';
  end if;
end $$;

commit;

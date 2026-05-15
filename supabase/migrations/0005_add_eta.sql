-- Add ETA (estimated time of arrival) column to tracking_records.
--
-- Why a separate column (not a note or status):
--   Staff want to see at-a-glance which deliveries are about to slip or
--   already have. A typed date lets the UI light up red past the due date
--   and amber when it's ≤3 days out.
--
-- Nullable on purpose — rows without an ETA stay null; we never guess one.
--
-- Also replaces the audit trigger so eta changes appear in the per-row
-- change history modal alongside route / tracking_no / status / notes.
-- The function is SECURITY DEFINER so the trigger keeps running under the
-- same privilege as the owning role, unaffected by the RLS tightening that
-- migration 0004 introduced.
--
-- Safe to re-run (idempotent): `ADD COLUMN IF NOT EXISTS` + `CREATE OR
-- REPLACE FUNCTION` cover both fresh and re-applied runs.

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. COLUMN
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.tracking_records
  add column if not exists eta date;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. AUDIT TRIGGER — extend to cover `eta`
-- ─────────────────────────────────────────────────────────────────────────────
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
    if new.eta is distinct from old.eta then
      insert into public.tracking_audit(record_id, changed_by, op, field, old_value, new_value)
      values (new.id, v_actor, 'UPDATE', 'eta', old.eta::text, new.eta::text);
    end if;
  end if;
  return null;
end;
$$;

commit;

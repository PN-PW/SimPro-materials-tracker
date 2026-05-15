-- Fix: the combined BEFORE INSERT OR UPDATE trigger violated the audit FK,
-- because the audit row is inserted before the tracking_records row is committed.
-- Split into two triggers:
--   BEFORE UPDATE → stamp updated_at / updated_by (can modify NEW)
--   AFTER  INSERT OR UPDATE → write audit rows (record already exists, FK satisfied)

begin;

-- Remove the old combined trigger and function
drop trigger  if exists tracking_records_audit on public.tracking_records;
drop function if exists public.tracking_records_audit_fn();

-- Trigger 1 — stamp on UPDATE only
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

-- Trigger 2 — audit log (AFTER so the FK can resolve)
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

commit;

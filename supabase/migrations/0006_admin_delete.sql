-- Admin delete policy for tracking_records.
--
-- By default RLS has no DELETE policy, so even authenticated admins get a
-- permission-denied error when the UI tries to remove a tracking record.
-- This migration adds a single policy: only users whose profile row has
-- role = 'admin' may delete tracking records.
--
-- The ON DELETE CASCADE on tracking_audit means the associated audit log
-- entries are removed automatically when the parent record is deleted.
-- If you want to preserve audit history for deleted records in future,
-- add cost_centre_id / material_name to tracking_audit and change the FK
-- to ON DELETE SET NULL.
--
-- Safe to re-run (idempotent via drop-if-exists).

begin;

drop policy if exists "admin delete tracking" on public.tracking_records;

create policy "admin delete tracking"
  on public.tracking_records
  for delete
  to authenticated
  using (public.is_admin());

commit;

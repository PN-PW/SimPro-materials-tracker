-- Security hardening: fix all Security Advisor findings.
--
-- Addresses three categories of issues:
--   1. cost_centre_progress view was SECURITY DEFINER (runs as owner, bypasses RLS).
--      An unauthenticated caller could query /rest/v1/cost_centre_progress without
--      logging in and read job progress data. Fixed by switching to SECURITY INVOKER.
--   2. Helper functions (current_user_role, is_admin, is_editor) were callable by anon.
--      They return null/false for anon (auth.uid() is null) so no data leak, but
--      there's no reason to expose them publicly.
--   3. Trigger functions (stamp, audit, handle_new_user, rls_auto_enable) were callable
--      via the REST API. They only make sense inside a trigger context; revoking PUBLIC
--      closes the REST endpoint without affecting trigger execution.
--
-- Safe to re-run (CREATE OR REPLACE + REVOKE IF EXISTS behaviour).

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Recreate cost_centre_progress as SECURITY INVOKER
--    Requires PostgreSQL 15+ (Supabase default). The view body is identical to
--    migration 0001; only the security mode changes.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.cost_centre_progress
  with (security_invoker = true)
as
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

-- Re-grant after recreation (some PG versions drop view grants on CREATE OR REPLACE)
grant select on public.cost_centre_progress to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Revoke anon execute from helper functions
--    Migration 0004 granted these to both anon and authenticated. Authenticated
--    still needs them (the script calls sb.rpc('current_user_role')).
-- ─────────────────────────────────────────────────────────────────────────────
revoke execute on function public.current_user_role() from anon;
revoke execute on function public.is_editor()          from anon;
revoke execute on function public.is_admin()           from anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Revoke PUBLIC execute from trigger-only functions
--    PostgreSQL grants EXECUTE to PUBLIC by default on new functions. These
--    functions are invoked by DB triggers only — not by the REST API. Revoking
--    from PUBLIC removes the /rest/v1/rpc/* endpoint without affecting triggers.
-- ─────────────────────────────────────────────────────────────────────────────
revoke execute on function public.tracking_records_stamp_fn() from public;
revoke execute on function public.tracking_records_audit_fn() from public;
revoke execute on function public.handle_new_user()            from public;

-- rls_auto_enable is a Supabase-generated helper; guard with existence check
-- in case it has been removed in a future Supabase version.
do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on p.pronamespace = n.oid
    where n.nspname = 'public' and p.proname = 'rls_auto_enable'
  ) then
    execute 'revoke execute on function public.rls_auto_enable() from public';
  end if;
end $$;

commit;

-- ─────────────────────────────────────────────────────────────────────────────
-- AFTER APPLYING THIS MIGRATION
-- ─────────────────────────────────────────────────────────────────────────────
-- Enable Leaked Password Protection (cannot be done via SQL):
--   Supabase Dashboard → Authentication → Settings → Password Protection
--   → toggle "Prevent use of leaked passwords" ON

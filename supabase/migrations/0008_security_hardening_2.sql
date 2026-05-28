-- Security hardening part 2: clear remaining Security Advisor warnings.
--
-- Migration 0007 revoked EXECUTE from PUBLIC on trigger functions and from
-- anon on helper functions. However Supabase also holds explicit per-role
-- grants (anon, authenticated) that are separate from the PUBLIC grant and
-- survived the 0007 revokes. This migration removes those explicit grants.
--
-- After this migration, expected remaining warnings (intentional — cannot remove):
--   • current_user_role / is_admin / is_editor callable by authenticated
--     → intentional: script calls rpc('current_user_role'), RLS policies call
--       is_admin() and is_editor(). Removing would break the app.
--   • auth_leaked_password_protection → Pro plan feature, not actionable on free tier.
--
-- Safe to re-run.

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Helper functions: revoke anon (also revoke PUBLIC as belt-and-braces,
--    since we only revoked per-role in 0007).
--    authenticated keeps its explicit grant from migration 0004 — app needs it.
-- ─────────────────────────────────────────────────────────────────────────────
revoke execute on function public.current_user_role() from anon, public;
revoke execute on function public.is_editor()          from anon, public;
revoke execute on function public.is_admin()           from anon, public;

-- Re-confirm authenticated grant (PUBLIC revoke can implicitly affect it
-- in some PostgreSQL versions if no explicit grant exists).
grant execute on function public.current_user_role() to authenticated;
grant execute on function public.is_editor()          to authenticated;
grant execute on function public.is_admin()           to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Trigger functions: revoke explicit anon + authenticated grants.
--    These functions are only ever called by DB triggers, not via the REST API.
-- ─────────────────────────────────────────────────────────────────────────────
revoke execute on function public.tracking_records_stamp_fn() from anon, authenticated, public;
revoke execute on function public.tracking_records_audit_fn() from anon, authenticated, public;
revoke execute on function public.handle_new_user()            from anon, authenticated, public;

-- rls_auto_enable: Supabase-generated helper, guarded in case it disappears.
do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on p.pronamespace = n.oid
    where n.nspname = 'public' and p.proname = 'rls_auto_enable'
  ) then
    execute 'revoke execute on function public.rls_auto_enable() from anon, authenticated, public';
  end if;
end $$;

commit;

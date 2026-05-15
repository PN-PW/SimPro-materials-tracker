-- Add new enum values:
--   • route 'VAN_ST'   — Van Stock → Site
--   • status 'issue'   — something went wrong, needs attention (red)
--
-- Notes:
--   ALTER TYPE ... ADD VALUE cannot run inside the same transaction that CREATEs the type,
--   but it is fine to run as a standalone statement on an existing type. It is idempotent
--   via `IF NOT EXISTS` (Postgres 12+, Supabase uses 15 so we're safe).
--   We deliberately do NOT wrap in begin/commit, because `ADD VALUE` is committed at
--   statement time and should not share a tx with anything that uses the new value.

alter type public.delivery_route   add value if not exists 'VAN_ST';
alter type public.delivery_status  add value if not exists 'issue' before 'returned';

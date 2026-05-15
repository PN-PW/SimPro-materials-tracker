# SimPro Materials Tracker — Claude Code Context

## Project overview

Multi-user Tampermonkey userscript + Supabase backend that adds material delivery tracking to SimPro cost-centre pages. SimPro has no native per-allocation tracking; this injects it via DOM manipulation with Supabase (Postgres + Auth + RLS) as the store.

**SimPro instance**: https://powernaturally.simprosuite.com  
**Supabase project**: https://gspkrnqjzabcrufgitdk.supabase.co  
**GitHub**: https://github.com/PN-PW/SimPro-materials-tracker

---

## Key files

| Path | Purpose |
|---|---|
| `userscripts/simpro-materials-tracker.user.js` | Main Tampermonkey userscript (all UI + Supabase calls) |
| `supabase/migrations/` | Ordered SQL migration files (apply in order) |
| `supabase/README.md` | Supabase setup notes |
| `.env.local` | Local secrets — never committed |

---

## Supabase DB objects (Data API tables/views)

The script accesses the following objects via the Supabase Data API (`supabase-js`):

| Object | Type | Operations |
|---|---|---|
| `public.tracking_records` | table | SELECT, INSERT, UPDATE, DELETE |
| `public.tracking_audit` | table | SELECT, INSERT |
| `public.user_profiles` | table | SELECT, UPDATE |
| `public.cost_centre_progress` | view | SELECT |
| `public.current_user_role()` | function | EXECUTE |

All access is under the `authenticated` role (app requires login; `anon` role gets no grants).

---

## Supabase Data API permission grants

Supabase is removing implicit `public` schema grants. Run this **once** in the SQL Editor if you hit 42501 errors, or when setting up a new project:

```sql
-- tracking_records
grant select, insert, update, delete
  on public.tracking_records
  to authenticated;

-- tracking_audit
grant select, insert
  on public.tracking_audit
  to authenticated;

-- user_profiles
grant select, update
  on public.user_profiles
  to authenticated;

-- cost_centre_progress (view)
grant select
  on public.cost_centre_progress
  to authenticated;

-- current_user_role (function)
grant execute
  on function public.current_user_role()
  to authenticated;
```

**For any new table**, include grants inline with the CREATE TABLE:

```sql
CREATE TABLE public.new_table ( ... );

grant select, insert, update, delete
  on public.new_table
  to authenticated;

alter table public.new_table enable row level security;
-- add RLS policy here
```

### Verify grants are in place

Run this in the Supabase SQL Editor to confirm all tables have the correct grants:

```sql
select grantee, table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('tracking_records', 'tracking_audit', 'user_profiles', 'cost_centre_progress')
order by table_name, grantee;
```

Expected: `authenticated` appears for each table with the appropriate privilege types.

**Rollout dates** (Supabase announcement May 2026):
- May 30, 2026 — default for new projects
- October 30, 2026 — enforced on all existing projects

---

## PostgreSQL enum types

Both `delivery_route` and `delivery_status` are **PostgreSQL ENUM types** (not CHECK constraints). Adding new values requires:

```sql
ALTER TYPE delivery_route ADD VALUE IF NOT EXISTS 'NEW_VALUE' AFTER 'EXISTING_VALUE';
ALTER TYPE delivery_status ADD VALUE IF NOT EXISTS 'new_value' AFTER 'existing_value';
```

These must be run in separate transactions before any DML using the new value.

---

## Script version history (recent)

| Version | Key changes |
|---|---|
| v1.8.0 | Route `SU_WH_ST` → `SU_WH` (SUP→WH). New status `delivered_wh` (Delivered to WH, 70%, transit chip). `delivered` label → "Delivered to site". |
| v1.7.9 | BI progress % sync fix, above-header overlay fix, row dimming fix. |

---

## Pending SQL migrations (v1.8.0)

Run these **in order, separately** in Supabase SQL Editor before installing v1.8.0:

```sql
-- 1. Add new route enum value
ALTER TYPE delivery_route ADD VALUE IF NOT EXISTS 'SU_WH' AFTER 'SU_WH_ST';

-- 2. Add new status enum value
ALTER TYPE delivery_status ADD VALUE IF NOT EXISTS 'delivered_wh' AFTER 'shipped';

-- 3. Migrate existing SUP→WH→ST records to SUP→WH
UPDATE tracking_records SET route = 'SU_WH' WHERE route = 'SU_WH_ST';
```

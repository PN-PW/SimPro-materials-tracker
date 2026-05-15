# Supabase setup

## 1. Apply the migrations (in order)

Open your Supabase project → **SQL Editor** (left sidebar, database icon). For **each** file below: **New query**, paste the file's contents, click **Run**. You should see `Success. No rows returned.`

1. [`migrations/0001_init.sql`](migrations/0001_init.sql) — initial schema (tables, enums, audit trigger, progress view, realtime).
2. [`migrations/0002_fix_audit_trigger.sql`](migrations/0002_fix_audit_trigger.sql) — splits the audit trigger so INSERTs don't fail the FK.
3. [`migrations/0003_add_route_and_status_values.sql`](migrations/0003_add_route_and_status_values.sql) — adds `VAN_ST` route + `issue` status. **If this is missing, picking "Issue" will fail to save** and the tracker will show "status value not in database" in a toast.
4. [`migrations/0004_user_roles.sql`](migrations/0004_user_roles.sql) — adds `user_profiles`, roles (`admin` / `editor` / `readonly`) and RLS that gates writes to editors+admins. **Without this migration everyone is effectively read-only**.
5. [`migrations/0005_add_eta.sql`](migrations/0005_add_eta.sql) — adds an `eta` date column + audit-trigger support for it. **Without this migration the ETA column in the tracker will fail to save** and the row will flash red with "Could not find the 'eta' column".

Verify: left sidebar → **Table Editor** — you should see `tracking_records`, `tracking_audit`, and `user_profiles`.

## 2. Promote your first admin

After `0004` runs, every existing user is a `readonly`. Promote yourself once in the SQL editor:

```sql
update public.user_profiles
   set role = 'admin'
 where email = 'pawel@powernaturally.co.uk';
```

Reload SimPro; your user chip should now say **Admin** and a **Manage users** button appears in the Materials Tracker bar.

## 3. Add more users

Two options — either works:

### A. Admin adds from Supabase (recommended)

1. Left sidebar → **Authentication** → **Users** → **Add user** → **Create new user**.
2. Enter their work email + temporary password, tick **Auto Confirm User**.
3. Next time they open SimPro and sign in, a `user_profiles` row is auto-created with role `readonly`.
4. Back in SimPro: click **Manage users** in the Materials Tracker bar → change their role to `editor` (or `admin`).

### B. They sign up themselves

1. **Authentication → Providers → Email** — enabled with **Confirm email** on.
2. Tell each user to sign up the first time the script loads; the script will offer a sign-in / sign-up modal.
3. Promote them to `editor` in the Manage users modal.

## 4. Verify Realtime is on

1. Left sidebar → **Database → Replication**.
2. Confirm `tracking_records` is ticked under the `supabase_realtime` publication. (Migration `0001` adds it automatically, but if Realtime was disabled when it ran you may need to toggle it manually.)

## 5. Never expose the service_role key

- The userscript uses the **anon** key only — RLS does the access control.
- The service_role key (in Project Settings → API) bypasses RLS — keep it out of the userscript, out of commits, out of browser storage.

## 6. Role summary

| Role       | Read tracking | Edit tracking | Manage users |
|------------|:-------------:|:-------------:|:------------:|
| `readonly` |       ✓       |               |              |
| `editor`   |       ✓       |       ✓       |              |
| `admin`    |       ✓       |       ✓       |       ✓      |

New users default to `readonly`. An admin must explicitly promote.

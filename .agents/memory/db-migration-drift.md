---
name: DB migration drift (dev)
description: How the dev Postgres can fall behind the migration files and how to recover safely
---

# Dev DB migration drift

The hand-rolled SQL migration runner (`lib/db/src/migrate.ts`) tracks applied
files in a `schema_migrations` journal table. The dev DB was historically built
with `drizzle-kit push`, so tables existed but **no journal row did**. Running
the runner from empty would re-apply ALL files from 0001.

**Why that's dangerous:** not every migration is idempotent. `0003_drop_replit_auth.sql`
renames/recreates the `auth_provider` enum and compares `auth_provider = 'replit'`
— re-running it after the enum no longer has `replit` throws "invalid input value
for enum". Most other migrations use `IF NOT EXISTS`/`DO NOTHING` and are safe.

**Recovery recipe when the journal is missing/behind:**
1. Inspect real schema to determine which migrations are *actually* applied
   (check for the columns/tables/enum values each migration introduces).
2. Create `schema_migrations` and `INSERT ... ON CONFLICT DO NOTHING` the
   filenames that are already applied (so non-idempotent ones get skipped).
3. Run `pnpm --filter @workspace/db run migrate` to apply only the genuinely
   pending files.

**Prevention:** the api-server dev workflow now sets `KAX_AUTO_MIGRATE=1`
(in `artifacts/api-server/.replit-artifact/artifact.toml` under
`[services.development.env]`) so pending migrations auto-apply on dev boot.
Dev migration failures are non-fatal; production gates on `REPLIT_DEPLOYMENT=1`.

**Opposite failure — over-backfilled journal (prod, Aug 2026):** journal rows
can exist for migrations that never executed (July recovery backfilled too
many). The runner then skips them forever and routes 500 on missing columns
even though the journal looks complete. Diagnose by checking the *effect*
(column/table) not the journal. Recover via `POST /admin/db/journal-unmark`
(admin/service token) to delete the lying rows, then `POST /admin/db/migrate`
— only safe because migrations 0004+ are idempotent.

**Migrations dir resolution:** `migrate.ts` walks upward from cwd and the
bundle location for `lib/db/migrations`; the dev workflow's cwd is inside
`artifacts/api-server`, which used to ENOENT the admin migration endpoints.

**How to apply:** any time the main page / a route 500s with
`relation "..." does not exist` or `column "..." does not exist`, suspect drift
first — check `schema_migrations` vs `lib/db/migrations/*.sql` before touching code.

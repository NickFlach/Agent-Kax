# Database Migrations

KAX uses hand-written SQL migrations under `lib/db/migrations/`, applied in
lexicographic order by the small runner at `src/migrate.ts`. Applied
migrations are tracked in a `schema_migrations` table so the runner is
idempotent — running it twice is a no-op.

## Apply migrations

```bash
# from workspace root
pnpm --filter @workspace/db migrate

# or with the env scoped per-shell
DATABASE_URL=postgres://… pnpm --filter @workspace/db migrate
```

The runner prints which files it applied vs. which were already present.
First run on a fresh DB applies everything; subsequent runs only apply
new files.

## Auto-apply at api-server boot

The api-server runs `runMigrations` before any scheduler / bridge
starts and before `app.listen()`. A failure here is **fatal** — the
process exits non-zero rather than serving requests against a
half-migrated schema.

Enablement rules:

| Env                                 | Auto-migrate? |
| ----------------------------------- | ------------- |
| `KAX_AUTO_MIGRATE=1`                | yes (force on)  |
| `KAX_AUTO_MIGRATE=0`                | no  (force off) |
| unset, `REPLIT_DEPLOYMENT=1`        | yes (deploy default) |
| unset, no `REPLIT_DEPLOYMENT`       | no  (local dev default) |

This means production / preview deploys on Replit auto-apply pending
migrations on every boot (so a deploy that ships a new
`lib/db/migrations/*.sql` reaches the prod DB without manual
intervention), while local dev stays opt-in so `pnpm dev` doesn't
touch your DB unless you ask. Set `KAX_AUTO_MIGRATE=0` on a deploy to
suppress it if you want to gate migrations on a separate ops step.

## Add a new migration

1. Create `lib/db/migrations/000N_<descriptive_name>.sql` (next number
   in sequence — `ls migrations/` to find it).
2. Write `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … ADD COLUMN IF
   NOT EXISTS` style SQL so re-runs against a slightly-ahead DB don't
   fail.
3. Update the matching schema file in `src/schema/` so drizzle types
   stay in sync.
4. Add the new schema to `src/schema/index.ts` if it lives in a new file.
5. Run the migration locally: `pnpm --filter @workspace/db migrate`.
6. Verify by re-running it — should report "up to date".

## Rollback

There is no automated rollback today. Rolls are SQL files written by
hand to inverse the change, then applied directly (`psql …`). If we
need DR-grade rollback automation, file an issue against the runner.

## Why not drizzle-kit's migrator?

The existing migrations are not drizzle-generated; they were written by
hand alongside the schema. Adopting drizzle-kit's journal format
retroactively would require either rewriting every migration or
maintaining two parallel journals. A 60-line PG-only runner is easier
to reason about for this codebase's scale and stays out of the way of
direct SQL when we need it.

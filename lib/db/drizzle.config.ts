// ⚠️  DO NOT run `drizzle-kit push` (nor `pnpm --filter db push`) against the
// production database. Prod's schema is managed exclusively by the hand-rolled,
// idempotent runner (`src/migrate.ts`, i.e. `pnpm --filter db run migrate`),
// which applies `migrations/*.sql` and tracks them in `schema_migrations`.
//
// `push` diffs this schema against the live DB and, because it cannot express
// the `ALTER TYPE ... ADD VALUE 'prediction'` that migration 0009 applied, it
// tries to REBUILD the floor_deal_kind enum via a column cast and fails with
// `invalid input value for enum floor_deal_kind: "prediction"` on rows that
// already, correctly, use that value. It broke the 2026-07-14 deploy from the
// post-merge hook. This config is for `drizzle-kit generate`/introspection in
// development only.
import { defineConfig } from "drizzle-kit";
import path from "path";

// The warning above has been true since 2026-07-14 and was still only a
// comment, which is why `push` kept happening: Replit's deploy step
// auto-detects this config and offers a schema sync at publish time, and on
// 2026-08-15 that offer was to DELETE bsky_handle and bsky_verified_at "with
// 2 items", drop the auth_challenge_kind type, and recreate it without
// bsky_bind_challenge — reconciling production DOWN to a stale workspace's
// idea of the schema, data included.
//
// A comment cannot stop that. This can: drizzle-kit puts its subcommand in
// argv, so a config asked to serve `push` refuses to load at all. The command
// fails loudly and destroys nothing.
//
// A blocked deploy is a far better outcome than a dropped column: the deploy
// can be retried in a minute, the column's data cannot.
const isPush = process.argv.some((a) => a === "push");
if (isPush) {
  throw new Error(
    [
      "drizzle-kit push is not allowed against this project.",
      "",
      "Prod's schema is managed by lib/db/migrations/*.sql through the",
      "idempotent runner: pnpm --filter db run migrate (also run automatically",
      "at boot when REPLIT_DEPLOYMENT=1).",
      "",
      "push diffs a WORKSPACE against the live database and offers to delete",
      "whatever the workspace does not declare — so a workspace behind main",
      "proposes dropping the newest columns, data and all. It also cannot",
      "express ALTER TYPE ... ADD VALUE, and rebuilding an enum fails on rows",
      "already using the value (the 2026-07-14 deploy).",
      "",
      "If a deploy brought you here: the workspace is behind. Pull the latest",
      "main into it and deploy again — the schema diff will then be empty.",
    ].join("\n"),
  );
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});

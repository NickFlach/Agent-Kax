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

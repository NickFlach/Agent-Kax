import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// connectionTimeoutMillis is load-bearing for the deploy path: without it
// the pg client hangs indefinitely on a TLS handshake / DNS hiccup against
// the production DB and the api-server never gets to call app.listen(),
// burning the entire 60s autoscale port-open window. 10s is generous for
// a managed-Postgres connect.
//
// ssl: deploy logs showed pg-connection-string warning that the new pg
// version treats `sslmode=require` (which Replit's managed Postgres URL
// uses) as `verify-full` — which then requires Replit's DB CA to be in
// Node's default trust store. For our 1-of-1 managed-DB topology we
// want the old behavior: encrypt the wire, but don't try to verify the
// CA chain. We mirror what pg + Neon clients use by default.
const sslConfig: pg.PoolConfig["ssl"] =
  process.env.DATABASE_URL?.includes("sslmode=")
    ? { rejectUnauthorized: false }
    : false;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10_000,
  ssl: sslConfig,
});
export const db = drizzle(pool, { schema });

export * from "./schema";
export { runMigrations, listMigrationFiles, listAppliedMigrations, backfillJournal } from "./migrate";

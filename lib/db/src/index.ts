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
// a managed-Postgres connect and still leaves plenty of headroom for the
// migration runner to finish before the port-open deadline.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10_000,
});
export const db = drizzle(pool, { schema });

export * from "./schema";
export { runMigrations } from "./migrate";

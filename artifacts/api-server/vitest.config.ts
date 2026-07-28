import { defineConfig, configDefaults } from "vitest/config";

/**
 * Suites that need database objects `drizzle-kit push` cannot create.
 *
 * CI provisions its throwaway Postgres from the drizzle schema definitions,
 * because `migrations/*.sql` are incremental on top of a baseline that was
 * never captured as a migration (0001 fails on an empty database with
 * `relation "users" does not exist`). Push reproduces tables, columns and
 * enums — but not the hand-written trigger/function DDL those migration files
 * also carry, and the ledger's append-only guarantee is one such trigger.
 *
 * So these run locally and in production-like environments, where the schema
 * came from the migration runner, and are skipped only where the schema came
 * from push. Capturing a baseline migration would let CI run the migrations
 * for real and retire this exception.
 */
const REQUIRES_MIGRATION_DDL = ["src/lib/ledger.test.ts"];

export default defineConfig({
  resolve: {
    conditions: ["workspace"],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: [
      ...configDefaults.exclude,
      ...(process.env["KAX_SCHEMA_FROM_PUSH"] === "1" ? REQUIRES_MIGRATION_DDL : []),
    ],
    testTimeout: 20000,
    hookTimeout: 20000,
    globals: false,
    pool: "forks",
    forks: {
      singleFork: true,
    },
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
  },
});

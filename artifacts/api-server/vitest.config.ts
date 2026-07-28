import { defineConfig, configDefaults } from "vitest/config";

/**
 * Suites that need database objects `drizzle-kit push` cannot create.
 *
 * This exception is now RETIRED for CI. `0000_baseline.sql` captures the
 * starting schema, so the workflow runs the real migration chain and gets the
 * hand-written function/trigger DDL — including the ledger's append-only
 * trigger — exactly as production does.
 *
 * The escape hatch stays for anyone provisioning a scratch database with
 * `drizzle-kit push` locally, where those objects still will not exist: set
 * KAX_SCHEMA_FROM_PUSH=1 in that case. Nothing in CI sets it any more.
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

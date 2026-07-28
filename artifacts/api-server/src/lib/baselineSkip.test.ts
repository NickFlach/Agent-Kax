/**
 * baselineSkip.test.ts — the baseline must NEVER execute against a database
 * that already has a migration history (#126).
 *
 * `0000_baseline.sql` is production's captured schema. A database with
 * migrations already recorded predates it — its schema IS the baseline — so
 * running the file there would `CREATE TABLE` over live tables, fail the run,
 * and under `KAX_AUTO_MIGRATE=1` take the boot down with it.
 *
 * `runMigrations()` therefore journals it without executing whenever the
 * journal is non-empty. That is what makes deploying the baseline safe with no
 * operator step and no ordering hazard between deploy and migrate.
 *
 * CI naturally exercises the OTHER path — a blank database applying the file
 * for real — so this test covers the one that would actually break production.
 * It reproduces the prod shape by removing just the baseline's journal row,
 * leaving every later migration recorded, then re-running.
 */

import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, runMigrations } from "@workspace/db";

/** A table that exists only because the baseline created it. */
const BASELINE_TABLE = "users";

async function journalled(): Promise<string[]> {
  const res = await db.execute<{ filename: string }>(
    sql`SELECT filename FROM schema_migrations ORDER BY filename`,
  );
  const rows = (res as unknown as { rows?: { filename: string }[] }).rows ?? [];
  return rows.map((r) => r.filename);
}

describe("baseline is never re-applied to an existing database (#126)", () => {
  it("records the baseline without executing it when a history exists", async () => {
    const before = await journalled();
    expect(before, "migrations should have run before this suite").toContain("0000_baseline.sql");
    expect(before.length, "a real history is required for this scenario").toBeGreaterThan(1);

    // Reproduce production: later migrations recorded, baseline not.
    await db.execute(sql`DELETE FROM schema_migrations WHERE filename = '0000_baseline.sql'`);

    try {
      const result = await runMigrations();

      // The whole point: it must not have been executed. Had it been, this
      // would have thrown "relation \"users\" already exists" and the run
      // would have failed.
      expect(result.applied).not.toContain("0000_baseline.sql");
      expect(result.skipped).toContain("0000_baseline.sql");

      // ...and it must be recorded, so it is not reconsidered every boot.
      expect(await journalled()).toContain("0000_baseline.sql");

      // The pre-existing schema is untouched — no table was dropped/recreated.
      const probe = await db.execute(
        sql`SELECT to_regclass(${BASELINE_TABLE}) IS NOT NULL AS present`,
      );
      const rows = (probe as unknown as { rows?: { present: boolean }[] }).rows ?? [];
      expect(rows[0]?.present, `${BASELINE_TABLE} should still exist`).toBe(true);
    } finally {
      // Restore the journal even if an assertion failed, so a failure here
      // cannot leave the database in a state that confuses a later run.
      await db.execute(sql`
        INSERT INTO schema_migrations (filename) VALUES ('0000_baseline.sql')
        ON CONFLICT (filename) DO NOTHING
      `);
    }
  });

  it("is idempotent once everything is recorded", async () => {
    const result = await runMigrations();
    expect(result.applied).toEqual([]);
  });
});

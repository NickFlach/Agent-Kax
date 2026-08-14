/**
 * ensureCriticalSchema.test.ts — it has to rebuild a table that is really gone.
 *
 * The deploy's schema diff drops `residence_units` on every publish, and
 * migrations cannot help because an applied migration never re-runs. This step
 * is the thing standing between that and a dead endpoint, so the test drops the
 * table for real and requires it back, seeded, with its indexes.
 */

import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { ensureCriticalSchema } from "./ensureCriticalSchema";

async function unitCount(): Promise<number> {
  const r = await db.execute(sql`SELECT count(*)::int AS n FROM residence_units`);
  return (r.rows[0] as { n: number }).n;
}

describe("ensureCriticalSchema", () => {
  afterAll(async () => { await ensureCriticalSchema(); });

  it("is a no-op when everything is present", async () => {
    await ensureCriticalSchema();
    const before = await unitCount();
    const r = await ensureCriticalSchema();
    expect(r.error).toBeUndefined();
    expect(r.repaired).toBe(false);
    expect(await unitCount()).toBe(before); // seed must not duplicate
  });

  it("rebuilds and re-seeds a table that has been dropped", async () => {
    await db.execute(sql`DROP TABLE IF EXISTS residence_units`);
    const r = await ensureCriticalSchema();
    expect(r.error).toBeUndefined();
    expect(r.repaired).toBe(true);
    expect(r.unitsAfter).toBe(80);
  });

  it("restores the uniqueness rules, not just the rows", async () => {
    await ensureCriticalSchema();
    // A duplicate door must still be impossible after a rebuild.
    await expect(
      db.execute(sql`INSERT INTO residence_units (floor, letter, tier) VALUES (5, 'A', 2)`),
    ).rejects.toThrow();
  });
});

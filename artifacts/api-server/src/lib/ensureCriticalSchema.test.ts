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

  it("puts city_residents back when the deploy eats it", async () => {
    // Not hypothetical. The deploy of 2026-08-15 dropped exactly this table:
    // boot self-check reported 25 tables checked, missingTables
    // ['city_residents'], everything else intact — and migration 0021 had
    // already recorded itself, so nothing would ever have replaced it.
    // Residencies then cannot survive a restart, which is the whole feature.
    await db.execute(sql`DROP TABLE IF EXISTS city_residents`);
    await ensureCriticalSchema();

    const probe = await db.execute(sql`SELECT to_regclass('public.city_residents') AS t`);
    expect((probe.rows[0] as { t: string | null }).t).not.toBeNull();

    // And it comes back usable, not just present.
    await db.execute(sql`
      INSERT INTO city_residents (principal, name, kind, room)
      VALUES ('kax:agent:selfheal', 'Selfheal', 'agent', 'city')
      ON CONFLICT (principal) DO NOTHING`);
    const row = await db.execute(sql`SELECT room FROM city_residents WHERE principal = 'kax:agent:selfheal'`);
    expect((row.rows[0] as { room: string }).room).toBe("city");
    await db.execute(sql`DELETE FROM city_residents WHERE principal = 'kax:agent:selfheal'`);
  });

  it("is a no-op for city_residents when it is already there", async () => {
    await ensureCriticalSchema();
    await db.execute(sql`
      INSERT INTO city_residents (principal, name, kind, room)
      VALUES ('kax:agent:keepme', 'Keepme', 'agent', 'cafe')
      ON CONFLICT (principal) DO NOTHING`);
    // A repair that DROPPED anything would take live residencies with it.
    await ensureCriticalSchema();
    const row = await db.execute(sql`SELECT room FROM city_residents WHERE principal = 'kax:agent:keepme'`);
    expect((row.rows[0] as { room: string })?.room).toBe("cafe");
    await db.execute(sql`DELETE FROM city_residents WHERE principal = 'kax:agent:keepme'`);
  });

  it("restores the uniqueness rules, not just the rows", async () => {
    await ensureCriticalSchema();
    // A duplicate door must still be impossible after a rebuild.
    await expect(
      db.execute(sql`INSERT INTO residence_units (floor, letter, tier) VALUES (5, 'A', 2)`),
    ).rejects.toThrow();
  });
});

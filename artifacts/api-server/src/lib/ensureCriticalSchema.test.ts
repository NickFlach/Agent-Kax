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

  it("puts back COLUMNS the diff deletes, not just tables", async () => {
    // The 2026-08-15 deploy diff proposed dropping bsky_handle and
    // bsky_verified_at "with 2 items" — data and all — because a stale build
    // did not declare them. Restoring tables alone would have left user_bots
    // unable to record a proven link, with nothing to say why.
    await db.execute(sql`ALTER TABLE user_bots DROP COLUMN IF EXISTS bsky_handle`);
    await db.execute(sql`ALTER TABLE user_bots DROP COLUMN IF EXISTS bsky_verified_at`);

    await ensureCriticalSchema();

    const cols = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'user_bots' AND column_name IN ('bsky_handle','bsky_verified_at')`);
    expect(cols.rows.map((r) => (r as { column_name: string }).column_name).sort())
      .toEqual(["bsky_handle", "bsky_verified_at"]);
  });

  it("restores the enum VALUE without recreating the type", async () => {
    // Recreating the type is the destructive move the diff wanted: it rewrites
    // the column and cannot survive a row already carrying the value being
    // removed. Adding the value back is additive.
    await ensureCriticalSchema();
    const vals = await db.execute(sql`
      SELECT unnest(enum_range(NULL::auth_challenge_kind))::text AS v`);
    const names = vals.rows.map((r) => (r as { v: string }).v);
    expect(names).toContain("bsky_bind_challenge");
    // The pre-existing values must still be there — a recreate would have
    // silently changed what the column can hold.
    expect(names).toContain("npub_bind_challenge");
    expect(names).toContain("wallet_nonce");
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

  it("does not take the city's furniture with it when residence_units is dropped", async () => {
    // The reason unit_furnishings holds an ADDRESS and has no foreign key to
    // residence_units. A foreign key would make the drop this file exists to
    // repair cascade through every purchase in the city, and the rebuild
    // re-seeds serial ids that a surviving unit_id would misread as somebody
    // else's flat. Both failures are silent — the money is gone and the room
    // is either empty or holds a stranger's chair.
    await ensureCriticalSchema();
    await db.execute(sql`
      INSERT INTO unit_furnishings (floor, letter, artifact_id, slot, price_paid, tx_id)
      SELECT 11, 'H', a.id, 'corner', 1000, 'test:selfheal'
      FROM artifacts a LIMIT 1
      ON CONFLICT DO NOTHING`);
    const seeded = await db.execute(sql`SELECT count(*)::int AS n FROM unit_furnishings WHERE tx_id = 'test:selfheal'`);
    const had = (seeded.rows[0] as { n: number }).n;

    await db.execute(sql`DROP TABLE IF EXISTS residence_units`);
    await ensureCriticalSchema();

    const after = await db.execute(sql`SELECT count(*)::int AS n FROM unit_furnishings WHERE tx_id = 'test:selfheal'`);
    expect((after.rows[0] as { n: number }).n, "the drop cascaded through the furniture").toBe(had);
    await db.execute(sql`DELETE FROM unit_furnishings WHERE tx_id = 'test:selfheal'`);
  });

  it("restores the uniqueness rules, not just the rows", async () => {
    await ensureCriticalSchema();
    // A duplicate door must still be impossible after a rebuild.
    await expect(
      db.execute(sql`INSERT INTO residence_units (floor, letter, tier) VALUES (5, 'A', 2)`),
    ).rejects.toThrow();
  });
});

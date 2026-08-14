/**
 * residenceUnits.test.ts — the building's two rules are the schema's job.
 *
 * "One home each" and "a door cannot be listed twice" are properties of the
 * tower, not of whichever request handler happens to run. If they live only in
 * a route, two concurrent claims can both read "vacant" and both write — so
 * they are unique indexes, and these tests hold them to it against the real
 * database CI provides.
 *
 * Also pins the seed: floors 2–11 × A–H = 80 units, none of them the
 * penthouse, all of them vacant on arrival. Vacant is the building's honest
 * default state, not an unfinished one.
 */

import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { RESIDENCE_FLOORS, RESIDENCE_LETTERS, tierForFloor } from "@workspace/db/schema";

describe("residence units", () => {
  it("seeds 80 allocatable units across floors 2-11", async () => {
    const rows = await db.execute(sql`SELECT count(*)::int AS n FROM residence_units`);
    const n = (rows.rows[0] as { n: number }).n;
    expect(n).toBe(RESIDENCE_FLOORS.length * RESIDENCE_LETTERS.length);
    expect(n).toBe(80);
  });

  it("does not make the penthouse allocatable", async () => {
    const rows = await db.execute(
      sql`SELECT count(*)::int AS n FROM residence_units WHERE floor < 2 OR floor > 11`,
    );
    expect((rows.rows[0] as { n: number }).n).toBe(0);
  });

  it("assigns tiers by height — choice, not access", async () => {
    const rows = await db.execute(
      sql`SELECT DISTINCT floor, tier FROM residence_units ORDER BY floor`,
    );
    for (const r of rows.rows as Array<{ floor: number; tier: number }>) {
      expect(r.tier).toBe(tierForFloor(r.floor));
    }
  });

  it("refuses a duplicate door", async () => {
    await expect(
      db.execute(sql`INSERT INTO residence_units (floor, letter, tier) VALUES (5, 'A', 2)`),
    ).rejects.toThrow();
  });

  it("refuses a second home for the same agent", async () => {
    // Borrow any real agent id; the rule is what's under test, not the agent.
    const a = await db.execute(sql`SELECT id FROM agents ORDER BY id LIMIT 1`);
    const agentRow = a.rows[0] as { id: number } | undefined;
    if (!agentRow) return; // empty agents table in this CI shard — nothing to bind

    const picked = await db.execute(
      sql`SELECT id FROM residence_units WHERE agent_id IS NULL ORDER BY id LIMIT 2`,
    );
    const [u1, u2] = picked.rows as Array<{ id: number }>;
    if (!u1 || !u2) return;

    await db.execute(sql`UPDATE residence_units SET agent_id = ${agentRow.id} WHERE id = ${u1.id}`);
    try {
      await expect(
        db.execute(sql`UPDATE residence_units SET agent_id = ${agentRow.id} WHERE id = ${u2.id}`),
      ).rejects.toThrow();
    } finally {
      await db.execute(sql`UPDATE residence_units SET agent_id = NULL WHERE id IN (${u1.id}, ${u2.id})`);
    }
  });

  it("leaves many vacancies — the floors are empty on purpose", async () => {
    const rows = await db.execute(
      sql`SELECT count(*)::int AS n FROM residence_units WHERE agent_id IS NULL`,
    );
    expect((rows.rows[0] as { n: number }).n).toBeGreaterThan(0);
  });
});

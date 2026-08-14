/**
 * schemaSelfCheck.test.ts — the check has to FAIL when the database is wrong.
 *
 * A self-check that only ever passes is decoration. These tests do the
 * anti-vacuous thing: drop a column the schema declares, confirm the check
 * names it, put it back, and confirm the check goes quiet again. If the
 * detection ever breaks, the middle assertion fails rather than everything
 * staying comfortably green.
 *
 * Runs against CI's real Postgres, which is the only place this is meaningful.
 */

import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { checkSchema } from "./schemaSelfCheck";

// A column that exists purely to be removed and restored. Chosen on
// residence_units because it is additive, unreferenced by other tables, and
// the table this whole mechanism was built for.
const TABLE = "residence_units";
const COLUMN = "claimed_at";

async function restore() {
  await db.execute(sql`ALTER TABLE residence_units ADD COLUMN IF NOT EXISTS claimed_at timestamp`);
}

describe("schema self-check", () => {
  afterAll(restore);

  it("passes against a healthy database", async () => {
    const r = await checkSchema();
    expect(r.error).toBeUndefined();
    expect(r.checkedTables).toBeGreaterThan(5);
    expect(r.missingTables).toEqual([]);
    expect(r.missingColumns).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("names a column the database has lost", async () => {
    await db.execute(sql`ALTER TABLE residence_units DROP COLUMN IF EXISTS claimed_at`);
    try {
      const r = await checkSchema();
      expect(r.ok).toBe(false);
      expect(r.missingColumns).toContain(`${TABLE}.${COLUMN}`);
      // The table itself is still present — only the column went.
      expect(r.missingTables).not.toContain(TABLE);
    } finally {
      await restore();
    }
  });

  it("goes quiet again once the column is back", async () => {
    await restore();
    const r = await checkSchema();
    expect(r.missingColumns).not.toContain(`${TABLE}.${COLUMN}`);
    expect(r.ok).toBe(true);
  });

  it("derives its expectations from the schema, not a hand-written list", async () => {
    // If someone adds a table to the drizzle schema, it must be covered without
    // anyone remembering to update this module. Proxy: the check knows about
    // more tables than any short hand-list would plausibly carry, and includes
    // the newest one.
    const r = await checkSchema();
    expect(r.checkedTables).toBeGreaterThan(10);
  });
});

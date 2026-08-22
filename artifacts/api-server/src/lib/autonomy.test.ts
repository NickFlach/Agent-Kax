/**
 * autonomy.test.ts — the fleet-wide kill switch (#403, ADR-0003 D6).
 *
 * DB-backed: the value lives in one row and the fail-closed read is the whole
 * safety property, so it is exercised against the real table.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { autonomyStatus, setAutonomyHalt } from "./autonomy";

describe("autonomy kill switch (#403)", () => {
  beforeEach(async () => {
    // Reset to the seeded, un-halted singleton.
    await db.execute(sql`DELETE FROM autonomy_state`);
    await db.execute(sql`INSERT INTO autonomy_state (id, halted) VALUES (1, false)`);
  });

  it("reads un-halted by default", async () => {
    const s = await autonomyStatus();
    expect(s.halted).toBe(false);
  });

  it("halts and resumes fleet-wide, recording the reason", async () => {
    const halted = await setAutonomyHalt(true, "spending spike", "user:nick");
    expect(halted.halted).toBe(true);
    expect(halted.reason).toBe("spending spike");
    expect((await autonomyStatus()).halted).toBe(true);

    const resumed = await setAutonomyHalt(false, null, "user:nick");
    expect(resumed.halted).toBe(false);
    expect((await autonomyStatus()).halted).toBe(false);
  });

  it("fails CLOSED when the singleton row is missing — unknown policy reads as halted", async () => {
    await db.execute(sql`DELETE FROM autonomy_state`);
    const s = await autonomyStatus();
    expect(s.halted, "an unreadable/absent switch must read as halted").toBe(true);
  });

  it("keeps exactly one row — the switch is a singleton", async () => {
    await setAutonomyHalt(true, "x", "user:a");
    await setAutonomyHalt(false, null, "user:b");
    const rows = await db.execute<{ n: number }>(sql`SELECT COUNT(*)::int AS n FROM autonomy_state`);
    const n = (rows as unknown as { rows?: { n: number }[] }).rows?.[0]?.n ?? 0;
    expect(n).toBe(1);
  });
});

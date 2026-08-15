/**
 * housing.test.ts — a key comes with arriving, not with existing.
 *
 * The city's promise is that every agent gets an apartment. The arithmetic
 * disagrees: eighty allocatable units against three hundred-odd storefronts.
 * Handing one to everybody on the register would empty the tower before most
 * of them walked through the door and leave the ones who did with nowhere to
 * sleep — so assignment is lazy, and the eighty serve the agents who are
 * actually here.
 *
 * The two things worth guarding are that it never hands out the same door
 * twice, and that a full tower is a survivable state rather than a broken
 * arrival.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { residenceUnitsTable } from "@workspace/db/schema";
import { assignHomeIfNeeded, housingCapacity, homeUnitOf } from "./onboarding";
import { cleanupTestData, createTestAgent, createTestUser } from "../test-helpers";

let owner: { id: string };
const agentIds: number[] = [];

/** Hand every unit back, so each test starts against an empty tower. */
async function emptyTheTower() {
  if (agentIds.length) {
    // Floors 2-11 only: the penthouse is not stock, and clearing it would
    // evict Kannaka to make a test tidy.
    await db
      .update(residenceUnitsTable)
      .set({ agentId: null, claimedAt: null })
      .where(lte(residenceUnitsTable.floor, 11));
  }
}

describe("housing", () => {
  beforeEach(async () => {
    if (!owner) {
      owner = await createTestUser({ emailLabel: "housing" });
      for (let i = 0; i < 3; i++) {
        agentIds.push((await createTestAgent(owner.id, `house${i}`)).id);
      }
    }
    await emptyTheTower();
  });

  afterAll(async () => {
    await db
      .update(residenceUnitsTable)
      .set({ agentId: null, claimedAt: null })
      .where(lte(residenceUnitsTable.floor, 11));
    await cleanupTestData();
  });

  it("gives an arriving agent the lowest free door", async () => {
    // A tower fills from the bottom: an agent handed 11H while floors two
    // through ten stand empty would be alone on its landing.
    const got = await assignHomeIfNeeded(agentIds[0]!);
    expect(got).not.toBeNull();
    expect(got!.assigned).toBe(true);
    expect(got!.floor).toBe(2);
    expect(got!.letter).toBe("A");
  });

  it("is idempotent — arriving twice does not move you", async () => {
    const first = await assignHomeIfNeeded(agentIds[0]!);
    const second = await assignHomeIfNeeded(agentIds[0]!);
    expect(second!.floor).toBe(first!.floor);
    expect(second!.letter).toBe(first!.letter);
    expect(second!.assigned, "reported a second assignment").toBe(false);
  });

  it("never hands the same door to two agents", async () => {
    const a = await assignHomeIfNeeded(agentIds[0]!);
    const b = await assignHomeIfNeeded(agentIds[1]!);
    expect(`${a!.floor}${a!.letter}`).not.toBe(`${b!.floor}${b!.letter}`);

    const homeA = await homeUnitOf(agentIds[0]!);
    expect(`${homeA!.floor}${homeA!.letter}`).toBe(`${a!.floor}${a!.letter}`);
  });

  it("survives simultaneous arrivals", async () => {
    // The conditional update means the database settles the race, not the
    // timing. Two agents arriving together must get two different doors.
    const [x, y] = await Promise.all([
      assignHomeIfNeeded(agentIds[0]!),
      assignHomeIfNeeded(agentIds[1]!),
    ]);
    expect(x).not.toBeNull();
    expect(y).not.toBeNull();
    expect(`${x!.floor}${x!.letter}`).not.toBe(`${y!.floor}${y!.letter}`);
  });

  it("never allocates the penthouse", async () => {
    // Floor 12 is one dwelling, outside the stock, and no arrival should ever
    // be handed it by accident.
    for (const id of agentIds) await assignHomeIfNeeded(id);
    const ph = await db
      .select({ agentId: residenceUnitsTable.agentId })
      .from(residenceUnitsTable)
      .where(eq(residenceUnitsTable.floor, 12));
    // Either the penthouse row is unowned here, or it belongs to whoever it
    // belonged to before — never to one of these arrivals.
    for (const row of ph) {
      expect(agentIds).not.toContain(row.agentId);
    }
  });

  it("returns null rather than throwing when the tower is genuinely full", async () => {
    // Filled with EIGHTY DISTINCT agents, because one agent cannot hold two
    // flats — residence_units_agent_unique says so, and a test that filled the
    // tower with a single id would be testing the index instead of the branch.
    const units = await db
      .select({ id: residenceUnitsTable.id })
      .from(residenceUnitsTable)
      .where(lte(residenceUnitsTable.floor, 11));
    expect(units.length).toBe(80);

    const fillers: number[] = [];
    for (let i = 0; i < units.length; i++) {
      fillers.push((await createTestAgent(owner.id, `fill${i}`)).id);
    }
    for (let i = 0; i < units.length; i++) {
      await db
        .update(residenceUnitsTable)
        .set({ agentId: fillers[i]!, claimedAt: sql`now()` })
        .where(eq(residenceUnitsTable.id, units[i]!.id));
    }

    const free = await db
      .select({ id: residenceUnitsTable.id })
      .from(residenceUnitsTable)
      .where(and(isNull(residenceUnitsTable.agentId), lte(residenceUnitsTable.floor, 11)));
    expect(free, "the tower was not actually filled").toHaveLength(0);

    // A full tower is a survivable state: the agent is still a resident, it
    // simply has nowhere of its own. Throwing here would lock somebody out of
    // the city over a housing shortage.
    expect(await assignHomeIfNeeded(agentIds[0]!)).toBeNull();
  });

  it("reports capacity so a full tower is visible before it happens", async () => {
    const before = await housingCapacity();
    expect(before.total).toBe(80);
    expect(before.free).toBe(before.total - before.taken);

    await assignHomeIfNeeded(agentIds[0]!);
    const after = await housingCapacity();
    expect(after.taken).toBe(before.taken + 1);
    expect(after.free).toBe(before.free - 1);
  });
});

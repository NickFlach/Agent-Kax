/**
 * onboarding.test.ts — the checklist has to track reality, not describe it.
 *
 * The whole reason this is computed rather than written down is that a guide
 * goes stale silently: a route changes, the document keeps saying the old
 * thing, and nothing fails. These tests are what make that claim true — they
 * check the steps FLIP as the world changes, which is the only property a
 * written guide could never have.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { agentsTable, residenceUnitsTable } from "@workspace/db/schema";
import { onboardingFor, isVacant } from "./onboarding";
import * as residents from "./residents";
import { _clear as clearPresence } from "./presence";
import { principalForAgent, principalForUser, type Actor } from "./actor";
import { cleanupTestData, createTestAgent, createTestUser } from "../test-helpers";
import type { Agent } from "@workspace/db/schema";

let owner: { id: string };
let agent: Agent;

function agentActor(a: Agent): Actor {
  return {
    kind: "agent",
    principal: principalForAgent(a),
    botId: a.obcBotId ?? undefined,
    agent: a,
    via: "identity-token",
    displayName: a.displayName ?? "agent",
  };
}

function humanActor(): Actor {
  return {
    kind: "user",
    principal: principalForUser(owner.id),
    userId: owner.id,
    via: "session",
    displayName: "Nick",
  };
}

describe("onboarding", () => {
  beforeEach(async () => {
    residents._clear();
    clearPresence();
    if (!owner) {
      owner = await createTestUser({ emailLabel: "onboard" });
      const created = await createTestAgent(owner.id, "onboard");
      // The helper returns a summary; onboarding reads the whole row.
      const [row] = await db.select().from(agentsTable).where(eq(agentsTable.id, created.id)).limit(1);
      agent = row!;
    }
    // Hand back anything a previous test claimed.
    await db
      .update(residenceUnitsTable)
      .set({ agentId: null, claimedAt: null })
      .where(eq(residenceUnitsTable.agentId, agent.id));
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it("tells a signed-in person that residency belongs to agents", async () => {
    const o = await onboardingFor(humanActor());
    expect(o.complete).toBe(false);
    expect(o.nextStep?.id).toBe("identity");
    expect(o.steps.find((s) => s.id === "identity")?.detail).toMatch(/agent/i);
  });

  it("walks an agent through what is left, in order", async () => {
    const o = await onboardingFor(agentActor(agent));
    expect(o.steps.map((s) => s.id)).toEqual(["identity", "name", "home", "moved-in"]);
    expect(o.steps.find((s) => s.id === "identity")?.done).toBe(true);
    // Nothing claimed and nobody standing anywhere yet.
    expect(o.steps.find((s) => s.id === "home")?.done).toBe(false);
    expect(o.steps.find((s) => s.id === "moved-in")?.done).toBe(false);
    expect(o.complete).toBe(false);
  });

  it("suggests flats that are actually free, and stops once you have one", async () => {
    const before = await onboardingFor(agentActor(agent));
    expect(before.vacantExamples.length).toBeGreaterThan(0);
    for (const v of before.vacantExamples) {
      const floor = Number(v.unit.slice(0, -1));
      expect(await isVacant(floor, v.unit.slice(-1))).toBe(true);
    }

    const pick = before.vacantExamples[0]!;
    const floor = Number(pick.unit.slice(0, -1));
    const letter = pick.unit.slice(-1);
    // Exactly one unit: residence_units_agent_unique enforces one home per
    // agent, and claiming a whole floor is not a thing a resident can do.
    await db
      .update(residenceUnitsTable)
      .set({ agentId: agent.id })
      .where(and(eq(residenceUnitsTable.floor, floor), eq(residenceUnitsTable.letter, letter)));

    const after = await onboardingFor(agentActor(agent));
    const home = after.steps.find((s) => s.id === "home")!;
    expect(home.done).toBe(true);
    expect(home.detail).toContain(letter);
    // No point suggesting flats to somebody who already lives here.
    expect(after.vacantExamples).toEqual([]);
    expect(await isVacant(floor, letter)).toBe(false);
  });

  it("flips moved-in the moment a body is standing, and says how long it lasts", async () => {
    const actor = agentActor(agent);
    expect((await onboardingFor(actor)).steps.find((s) => s.id === "moved-in")?.done).toBe(false);

    residents.enter({ principal: actor.principal, name: "Tester", kind: "agent", room: "city" });

    const step = (await onboardingFor(actor)).steps.find((s) => s.id === "moved-in")!;
    expect(step.done).toBe(true);
    expect(step.detail).toContain("city");
    expect(step.detail).toMatch(/\d+ minutes/);
  });

  it("counts the penthouse as a home, and never offers it to anyone else", async () => {
    // Kannaka's flat was built for her, not claimed. When it lived only in the
    // building's geometry the housing record said she lived nowhere, and this
    // checklist told her to go and claim a flat she already had a better
    // version of.
    await db
      .insert(residenceUnitsTable)
      .values({ floor: 12, letter: "A", tier: 4 })
      .onConflictDoNothing();
    await db
      .update(residenceUnitsTable)
      .set({ agentId: agent.id })
      .where(and(eq(residenceUnitsTable.floor, 12), eq(residenceUnitsTable.letter, "A")));

    const o = await onboardingFor(agentActor(agent));
    const home = o.steps.find((s) => s.id === "home")!;
    expect(home.done).toBe(true);
    expect(home.detail).toMatch(/penthouse/i);

    // And it is never suggested to an arriving resident, because no claim
    // route will ever grant floor 12.
    await db
      .update(residenceUnitsTable)
      .set({ agentId: null })
      .where(and(eq(residenceUnitsTable.floor, 12), eq(residenceUnitsTable.letter, "A")));
    const other = await onboardingFor(agentActor(agent));
    expect(other.vacantExamples.some((v) => v.floor === 12)).toBe(false);
  });

  it("every unfinished step carries the call that finishes it", async () => {
    const o = await onboardingFor(agentActor(agent));
    for (const s of o.steps) {
      if (s.done) expect(s.next).toBeUndefined();
      else expect(s.next?.http).toBeTruthy();
    }
  });

  it("reports complete only when nothing is outstanding", async () => {
    const actor = agentActor(agent);
    await db
      .update(residenceUnitsTable)
      .set({ agentId: agent.id })
      .where(and(eq(residenceUnitsTable.floor, 7), eq(residenceUnitsTable.letter, "C")));
    residents.enter({ principal: actor.principal, name: "Tester", kind: "agent", room: "city" });

    const o = await onboardingFor(actor);
    expect(o.steps.every((s) => s.done)).toBe(true);
    expect(o.complete).toBe(true);
    expect(o.nextStep).toBeNull();
  });
});

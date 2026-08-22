/**
 * observatory.test.ts — the Observatory reads REAL constellation data (#407).
 *
 * DB-backed: the room's whole point is that its exhibits are the actual stream,
 * not a fixture, so the read model is exercised against the mirror tables the
 * bridge writes.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  constellationAgentsTable,
  constellationExemplarsTable,
  constellationDreamsTable,
} from "@workspace/db/schema";
import { observatoryView, SWARM_FRESH_MS } from "./observatory";

describe("observatory read model (#407)", () => {
  beforeEach(async () => {
    await db.execute(sql`DELETE FROM constellation_exemplars`);
    await db.execute(sql`DELETE FROM constellation_dreams`);
    await db.execute(sql`DELETE FROM constellation_agents`);
  });

  it("shows the live swarm with real metrics and hides the stale", async () => {
    const now = Date.now();
    await db.insert(constellationAgentsTable).values([
      { agentId: "kannaka-prime", displayName: "Kannaka Prime", source: "KANNAKA.consciousness", phi: 0.42, consciousnessLevel: "aware", lastSeenAt: new Date(now - 5_000) },
      { agentId: "gone", displayName: "Gone", source: "KANNAKA.consciousness", phi: 0.1, consciousnessLevel: "stirring", lastSeenAt: new Date(now - SWARM_FRESH_MS - 60_000) },
    ]);
    const v = await observatoryView(now);
    const names = v.swarm.map((s) => s.agentId);
    expect(names).toContain("kannaka-prime");
    expect(names).not.toContain("gone");
    expect(v.swarm.find((s) => s.agentId === "kannaka-prime")?.phi).toBeCloseTo(0.42, 2);
  });

  it("renders exemplars as exhibits, newest first", async () => {
    await db.insert(constellationExemplarsTable).values([
      { agentId: "0xSCADA-QE", cluster: "3", theme: "the ledger as a wavefront", content: "an approval is a claim that has not collapsed until settlement", exemplarKey: "0xSCADA-QE:3", broadcastAt: new Date(Date.now() - 1000) },
      { agentId: "kannaka", cluster: "1", theme: "attention is gravity", content: "recall is the memories that pull hardest on the prompt", exemplarKey: "kannaka:1", broadcastAt: new Date() },
    ]);
    const v = await observatoryView();
    expect(v.exemplars.length).toBe(2);
    expect(v.exemplars[0].agentId).toBe("kannaka"); // newest first
    expect(v.exemplars[0].theme).toBe("attention is gravity");
  });

  it("surfaces recent dream-ends as events with the consolidation counts", async () => {
    await db.insert(constellationDreamsTable).values({
      agentId: "kannaka-prime", memoriesStrengthened: 12, memoriesFaded: 4, eventKey: "kannaka-prime:t1", endedAt: new Date(),
    });
    const v = await observatoryView();
    expect(v.dreams.length).toBe(1);
    expect(v.dreams[0]).toMatchObject({ agentId: "kannaka-prime", strengthened: 12, faded: 4 });
  });
});

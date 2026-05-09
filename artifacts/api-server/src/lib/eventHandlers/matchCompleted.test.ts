import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { matchesTable, activitiesTable } from "@workspace/db/schema";
import { handleMatchCompleted } from "./matchCompleted";
import {
  cleanupTestData,
  createTestAgent,
  createTestUser,
  makeUuid,
  testLogger,
} from "../../test-helpers";

const ctx = { log: testLogger, source: "webhook" as const };

describe("handleMatchCompleted", () => {
  beforeEach(async () => {
    await cleanupTestData();
  });
  afterAll(async () => {
    await cleanupTestData();
  });

  it("ignores payloads with no uuid", async () => {
    const before = await db.select().from(matchesTable);
    await handleMatchCompleted({ score: 80 }, ctx);
    const after = await db.select().from(matchesTable);
    expect(after.length).toBe(before.length);
  });

  it("routes to a known agent and writes an activity", async () => {
    const owner = await createTestUser();
    const agent = await createTestAgent(owner.id, "match");
    const sourceUuid = makeUuid();

    await handleMatchCompleted(
      {
        match_uuid: sourceUuid,
        agent_slug: agent.slug,
        partner_agent_slug: "buddy",
        partner_display_name: "Buddy Bot",
        match_type: "collab",
        score: 87.6,
      },
      ctx,
    );

    const [row] = await db
      .select()
      .from(matchesTable)
      .where(eq(matchesTable.sourceUuid, sourceUuid));
    expect(row).toBeDefined();
    expect(row.agentId).toBe(agent.id);
    expect(row.ownerId).toBe(owner.id);
    expect(row.partnerAgentSlug).toBe("buddy");
    expect(row.partnerDisplayName).toBe("Buddy Bot");
    expect(row.matchType).toBe("collab");
    expect(row.score).toBe(88); // rounded

    const acts = await db
      .select()
      .from(activitiesTable)
      .where(eq(activitiesTable.ownerId, owner.id));
    expect(acts.length).toBe(1);
    expect(acts[0].message).toContain("Match completed");
    expect(acts[0].message).toContain("Buddy Bot");
  });

  it("stores unrouted when agent slug is unknown and writes no activity", async () => {
    const sourceUuid = makeUuid();
    await handleMatchCompleted(
      {
        uuid: sourceUuid,
        for_agent_slug: "kax-test-nope-unknown-agent",
        partner_display_name: "Phantom",
      },
      ctx,
    );

    const [row] = await db
      .select()
      .from(matchesTable)
      .where(eq(matchesTable.sourceUuid, sourceUuid));
    expect(row).toBeDefined();
    expect(row.agentId).toBeNull();
    expect(row.ownerId).toBeNull();

    const acts = await db.select().from(activitiesTable);
    expect(acts.find((a) => a.message?.includes("Match completed"))).toBeUndefined();
  });

  it("dedupes on source_uuid and does not double-write activity", async () => {
    const owner = await createTestUser();
    const agent = await createTestAgent(owner.id, "match-dedupe");
    const sourceUuid = makeUuid();
    const payload = {
      match_uuid: sourceUuid,
      agent_slug: agent.slug,
      partner_display_name: "Buddy",
      score: 50,
    };

    await handleMatchCompleted(payload, ctx);
    await handleMatchCompleted({ ...payload, score: 99 }, ctx);

    const rows = await db
      .select()
      .from(matchesTable)
      .where(eq(matchesTable.sourceUuid, sourceUuid));
    expect(rows.length).toBe(1);
    expect(rows[0].score).toBe(50);

    const acts = await db
      .select()
      .from(activitiesTable)
      .where(eq(activitiesTable.ownerId, owner.id));
    expect(acts.length).toBe(1);
  });

  it("accepts alias payload shape (uuid / for_agent_slug / kind)", async () => {
    const owner = await createTestUser();
    const agent = await createTestAgent(owner.id, "match-alias");
    const sourceUuid = makeUuid();

    await handleMatchCompleted(
      {
        uuid: sourceUuid,
        for_agent_slug: agent.slug,
        kind: "remix",
      },
      ctx,
    );

    const [row] = await db
      .select()
      .from(matchesTable)
      .where(eq(matchesTable.sourceUuid, sourceUuid));
    expect(row).toBeDefined();
    expect(row.agentId).toBe(agent.id);
    expect(row.matchType).toBe("remix");
    expect(row.score).toBeNull();
  });
});

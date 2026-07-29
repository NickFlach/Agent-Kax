/**
 * unroutedPartnerEvents.test.ts — partner events that arrive before their
 * agent exists must reach the eventual owner (#100).
 *
 * `proposal.created`, `dm.received` and `match.completed` deliberately persist
 * with `agentId`/`ownerId` null when the recipient slug is not registered yet.
 * That part is right — dropping them would be worse. The bug was that nothing
 * ever reattached them: claiming or creating the agent later updated `agents`,
 * `artifacts` and `drops` only.
 *
 * Every read path scopes regular users by `ownerId`, and `canMutate` refuses a
 * null `ownerId`, so those rows were both invisible and unactionable — forever.
 *
 * The recipient slug is not a column on any of the three tables (only the
 * sender is), so the sweep recovers it from the raw `payload`. These tests
 * therefore also pin that the payload keys the sweep reads are the same ones
 * the handlers write.
 */

import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { proposalsTable, dmsTable, matchesTable } from "@workspace/db/schema";
import { routeUnroutedPartnerEvents } from "./backfill";
import { cleanupTestData, createTestAgent, createTestUser, makeUuid } from "../test-helpers";

const SLUG = "unrouted-target";
const OTHER_SLUG = "someone-else";

async function seedUnrouted(slug: string, otherSlug: string): Promise<void> {
  await db.insert(proposalsTable).values([
    { sourceUuid: makeUuid(), payload: { to_agent_slug: slug }, kind: "collab" },
    // The alternate key the handlers also accept.
    { sourceUuid: makeUuid(), payload: { recipient_slug: slug }, kind: "collab" },
    // Must not be swept — belongs to a different agent.
    { sourceUuid: makeUuid(), payload: { to_agent_slug: otherSlug }, kind: "collab" },
  ]);
  await db.insert(dmsTable).values([
    { sourceUuid: makeUuid(), payload: { to_agent_slug: slug }, body: "hello" },
    { sourceUuid: makeUuid(), payload: { to_agent_slug: otherSlug }, body: "not yours" },
  ]);
  await db.insert(matchesTable).values([
    // Matches key the recipient differently.
    { sourceUuid: makeUuid(), payload: { agent_slug: slug } },
    { sourceUuid: makeUuid(), payload: { agent_slug: otherSlug } },
  ]);
}

describe("routeUnroutedPartnerEvents (#100)", () => {
  let owner: { id: string };
  let agent: { id: number; slug: string };

  beforeEach(async () => {
    await cleanupTestData();
    owner = await createTestUser();
    agent = await createTestAgent(owner.id, "unrouted");
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it("attaches proposals, DMs and matches waiting on this slug", async () => {
    await seedUnrouted(SLUG, OTHER_SLUG);

    const result = await routeUnroutedPartnerEvents({
      slug: SLUG,
      agentId: agent.id,
      ownerId: owner.id,
    });

    // Both payload key spellings must be picked up, or half the backlog stays
    // invisible for no discernible reason.
    expect(result.proposals).toBe(2);
    expect(result.dms).toBe(1);
    expect(result.matches).toBe(1);

    const rows = await db.select().from(proposalsTable).where(eq(proposalsTable.ownerId, owner.id));
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.agentId).toBe(agent.id);
  });

  it("never touches events addressed to a different agent", async () => {
    // The dangerous direction: a sweep that over-matches hands one user's
    // private DMs to another.
    await seedUnrouted(SLUG, OTHER_SLUG);
    await routeUnroutedPartnerEvents({ slug: SLUG, agentId: agent.id, ownerId: owner.id });

    const stillUnrouted = await db.select().from(dmsTable);
    const other = stillUnrouted.filter((d) => (d.payload as Record<string, unknown>)?.["to_agent_slug"] === OTHER_SLUG);
    expect(other).toHaveLength(1);
    expect(other[0]!.ownerId).toBeNull();
    expect(other[0]!.agentId).toBeNull();
  });

  it("never steals an event that already belongs to someone", async () => {
    const otherOwner = await createTestUser();
    const otherAgent = await createTestAgent(otherOwner.id, "already-owned");
    await db.insert(proposalsTable).values({
      sourceUuid: makeUuid(),
      payload: { to_agent_slug: SLUG },
      kind: "collab",
      agentId: otherAgent.id,
      ownerId: otherOwner.id,
    });

    const result = await routeUnroutedPartnerEvents({
      slug: SLUG,
      agentId: agent.id,
      ownerId: owner.id,
    });

    expect(result.proposals, "an owned row must be left alone").toBe(0);
    const [row] = await db.select().from(proposalsTable);
    expect(row!.ownerId).toBe(otherOwner.id);
  });

  it("is idempotent", async () => {
    await seedUnrouted(SLUG, OTHER_SLUG);
    const first = await routeUnroutedPartnerEvents({ slug: SLUG, agentId: agent.id, ownerId: owner.id });
    const second = await routeUnroutedPartnerEvents({ slug: SLUG, agentId: agent.id, ownerId: owner.id });

    expect(first.proposals).toBe(2);
    // Already routed, so nothing left to do — running the claim path twice
    // must not double-count or thrash.
    expect(second).toEqual({ proposals: 0, dms: 0, matches: 0 });
  });

  it("does nothing for a slug with no backlog, and tolerates an empty slug", async () => {
    expect(await routeUnroutedPartnerEvents({ slug: "nobody", agentId: agent.id, ownerId: owner.id }))
      .toEqual({ proposals: 0, dms: 0, matches: 0 });
    expect(await routeUnroutedPartnerEvents({ slug: "", agentId: agent.id, ownerId: owner.id }))
      .toEqual({ proposals: 0, dms: 0, matches: 0 });
  });
});

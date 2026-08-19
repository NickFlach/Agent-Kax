/**
 * commerceEligibility.test.ts — #256's acceptance criteria, behavioural and
 * DB-backed on purpose.
 *
 * The issue's own words: the existing publication gates are protected only by
 * source-string tests that pass on a rename or on a predicate constructed but
 * never applied. This file is the demanded alternative — every assertion here
 * inserts real rows and reads real query results, so a predicate that stops
 * being applied stops passing.
 *
 * Needs a real DATABASE_URL (CI provides postgres). Both API surfaces are
 * exercised: the WHERE form against a live select, and the single-artifact
 * check with its per-failure reasons.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@workspace/db";
import { artifactsTable, userBotsTable } from "@workspace/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { commerceEligibleWhere, isCommerceEligible } from "./visibility";
import { cleanupTestData, createTestAgent, createTestUser, makeTestId } from "../test-helpers";

let userA: { id: string };
let userB: { id: string };
let agentId: number;

const BOT_ATTACHED = makeTestId("bot-attached");
const BOT_UNATTACHED = makeTestId("bot-unattached");

let artAttached: number; // creator bot attached to A
let artUnattached: number; // creator bot attached to nobody
let artNoBot: number; // creator bot NULL

async function insertArtifact(label: string, creatorBotId: string | null): Promise<number> {
  const [row] = await db
    .insert(artifactsTable)
    .values({
      externalId: makeTestId(`ext-${label}`),
      title: `commerce eligibility test ${label}`,
      creatorName: "kax-test-creator",
      creatorBotId,
      publicUrl: "https://example.invalid/w",
      artifactType: "image",
      agentId,
    })
    .returning({ id: artifactsTable.id });
  return row!.id;
}

beforeAll(async () => {
  userA = await createTestUser({ emailLabel: "commerce-a" });
  userB = await createTestUser({ emailLabel: "commerce-b" });
  const agent = await createTestAgent(userA.id, "commerce");
  agentId = agent.id;

  await db.insert(userBotsTable).values({ userId: userA.id, obcBotId: BOT_ATTACHED });

  artAttached = await insertArtifact("attached", BOT_ATTACHED);
  artUnattached = await insertArtifact("unattached", BOT_UNATTACHED);
  artNoBot = await insertArtifact("nobot", null);
});

afterAll(async () => {
  await db
    .delete(userBotsTable)
    .where(inArray(userBotsTable.obcBotId, [BOT_ATTACHED, BOT_UNATTACHED]));
  await db
    .delete(artifactsTable)
    .where(inArray(artifactsTable.id, [artAttached, artUnattached, artNoBot]));
  await cleanupTestData();
});

describe("isCommerceEligible — one artifact, distinct reasons", () => {
  it("eligible for the user who controls the creator bot, not for another user", async () => {
    expect(await isCommerceEligible(artAttached, userA.id)).toEqual({ ok: true });
    const forB = await isCommerceEligible(artAttached, userB.id);
    expect(forB.ok).toBe(false);
    if (!forB.ok) expect(forB.reason).toMatch(/not attached to the requesting principal/);
  });

  it("a NULL creator bot is eligible for nobody, with its own reason", async () => {
    for (const u of [userA.id, userB.id]) {
      const r = await isCommerceEligible(artNoBot, u);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/no creator bot on record/);
    }
  });

  it("revoking the attachment kills eligibility immediately, with its own reason", async () => {
    await db
      .update(userBotsTable)
      .set({ revokedAt: new Date(), revokedReason: "test revocation" })
      .where(eq(userBotsTable.obcBotId, BOT_ATTACHED));
    try {
      const r = await isCommerceEligible(artAttached, userA.id);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/revoked/);
    } finally {
      await db
        .update(userBotsTable)
        .set({ revokedAt: null, revokedReason: null })
        .where(eq(userBotsTable.obcBotId, BOT_ATTACHED));
    }
    // And the un-revoke restores eligibility — revocation is reversible on
    // purpose (schema comment on revoked_at), so the predicate must follow
    // the row, not remember the event.
    expect(await isCommerceEligible(artAttached, userA.id)).toEqual({ ok: true });
  });

  it("storefront visibility and commerce eligibility are separate predicates", async () => {
    // artUnattached is exactly the storefront case: agentWorksWhere applies
    // no publication predicate ("the storefront IS the agent's harvested
    // body of work"), so this artifact is publicly browsable — and still not
    // sellable by ANYONE, because no principal controls its creator bot.
    for (const u of [userA.id, userB.id]) {
      const r = await isCommerceEligible(artUnattached, u);
      expect(r.ok).toBe(false);
    }
  });

  it("a missing artifact is its own reason, never a rights denial", async () => {
    const r = await isCommerceEligible(-1, userA.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not found/);
  });
});

describe("commerceEligibleWhere — the same predicate, pushed into SQL", () => {
  it("returns exactly the eligible artifact for A, and nothing for B", async () => {
    const mine = [artAttached, artUnattached, artNoBot];
    const forA = await db
      .select({ id: artifactsTable.id })
      .from(artifactsTable)
      .where(and(inArray(artifactsTable.id, mine), commerceEligibleWhere(userA.id)));
    expect(forA.map((r) => r.id)).toEqual([artAttached]);

    const forB = await db
      .select({ id: artifactsTable.id })
      .from(artifactsTable)
      .where(and(inArray(artifactsTable.id, mine), commerceEligibleWhere(userB.id)));
    expect(forB).toEqual([]);
  });

  it("agrees with isCommerceEligible on every fixture — two surfaces, one predicate", async () => {
    // The whole reason #256 exists is that three visibility answers drifted
    // apart. Pin the two forms of THIS predicate to each other so a future
    // edit to one that misses the other fails here, behaviourally.
    for (const [artifact, user] of [
      [artAttached, userA.id],
      [artAttached, userB.id],
      [artUnattached, userA.id],
      [artNoBot, userA.id],
    ] as const) {
      const single = await isCommerceEligible(artifact, user);
      const viaWhere = await db
        .select({ id: artifactsTable.id })
        .from(artifactsTable)
        .where(and(eq(artifactsTable.id, artifact), commerceEligibleWhere(user)));
      expect(
        viaWhere.length === 1,
        `WHERE and single-check disagree for artifact ${artifact}, user ${user}`,
      ).toBe(single.ok);
    }
  });
});

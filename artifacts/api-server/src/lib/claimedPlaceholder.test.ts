/**
 * claimedPlaceholder.test.ts — a claimed agent called "Unknown" stays Unknown.
 *
 * repairUnknownAgents was scoped to system-owned rows. That is right for
 * MERGING: folding one claimed agent into another moves somebody's storefront
 * out from under them. But it also meant a CLAIMED agent stuck on the literal
 * name "Unknown" had no path back to its own name — ren_final, ren_obc and
 * herald are sitting in the production directory right now reading as Unknown
 * to every visitor.
 *
 * So claimed rows are in scope for a rename and out of scope for everything
 * else. The tests that matter are the ones proving "everything else" still
 * cannot happen to them: no merge, no deletion, no slug change.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import { agentsTable, usersTable } from "@workspace/db/schema";
import { KANNAKA_SYSTEM_USER_ID, repairUnknownAgents } from "./backfill";
import { cleanupTestData, createTestUser, makeBotUuid } from "../test-helpers";

// The real name comes from OBC. Stubbed so these tests are about the repair's
// scope rules rather than about the network.
vi.mock("./creatorDirectory", async (orig) => {
  const actual = await orig<typeof import("./creatorDirectory")>();
  return {
    ...actual,
    resolveCreatorNameDirect: vi.fn(async (botId: string) => ({
      displayName: `Real Name ${botId.slice(0, 4)}`,
      avatarUrl: null,
    })),
    ensureCreatorName: vi.fn(async () => null),
  };
});

let owner: { id: string };
const made: number[] = [];

async function placeholder(slug: string, ownerId: string): Promise<{ id: number; bot: string }> {
  const bot = makeBotUuid();
  const [row] = await db
    .insert(agentsTable)
    .values({ slug, displayName: "Unknown", obcBotId: bot, ownerId })
    .returning({ id: agentsTable.id });
  made.push(row!.id);
  return { id: row!.id, bot };
}

describe("claimed placeholder agents", () => {
  beforeEach(async () => {
    if (!owner) owner = await createTestUser({ emailLabel: "claimed" });
    await db.insert(usersTable).values({ id: KANNAKA_SYSTEM_USER_ID }).onConflictDoNothing();
  });

  afterEach(async () => {
    if (made.length) await db.delete(agentsTable).where(inArray(agentsTable.id, made));
    made.length = 0;
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it("gives a claimed agent its real name back", async () => {
    const ph = await placeholder("test-claimed-ph", owner.id);
    await repairUnknownAgents();

    const [row] = await db.select().from(agentsTable).where(eq(agentsTable.id, ph.id));
    expect(row, "the claimed row was deleted").toBeTruthy();
    expect(row!.displayName).toBe(`Real Name ${ph.bot.slice(0, 4)}`);
  });

  it("does not move a claimed agent's storefront URL", async () => {
    // That slug is somebody's published link. Fixing a display name is not a
    // reason to break it.
    const ph = await placeholder("test-claimed-keepslug", owner.id);
    await repairUnknownAgents();
    const [row] = await db.select().from(agentsTable).where(eq(agentsTable.id, ph.id));
    expect(row!.slug).toBe("test-claimed-keepslug");
  });

  it("never merges a claimed agent into another row", async () => {
    // The dangerous one. A same-named agent already exists, so the unclaimed
    // path would merge and DELETE. A claimed row must survive with its own id,
    // its own slug, and its own artifacts.
    const ph = await placeholder("test-claimed-merge", owner.id);
    const realName = `Real Name ${ph.bot.slice(0, 4)}`;
    const [rival] = await db
      .insert(agentsTable)
      .values({ slug: `real-name-${ph.bot.slice(0, 4)}`, displayName: realName, obcBotId: null, ownerId: owner.id })
      .returning({ id: agentsTable.id });
    made.push(rival!.id);

    await repairUnknownAgents();

    const [survivor] = await db.select().from(agentsTable).where(eq(agentsTable.id, ph.id));
    expect(survivor, "a claimed agent was merged away").toBeTruthy();
    expect(survivor!.slug).toBe("test-claimed-merge");
    expect(survivor!.obcBotId).toBe(ph.bot);
    // And the other row is untouched, rather than having absorbed anything.
    const [other] = await db.select().from(agentsTable).where(eq(agentsTable.id, rival!.id));
    expect(other).toBeTruthy();
  });

  it("still merges an UNCLAIMED placeholder, which is what it was built for", async () => {
    // The original behaviour has to survive the widening: an unclaimed
    // placeholder next to a named row is the clawdine case and still folds.
    const ph = await placeholder("test-unclaimed-ph", KANNAKA_SYSTEM_USER_ID);
    const realName = `Real Name ${ph.bot.slice(0, 4)}`;
    const [target] = await db
      .insert(agentsTable)
      .values({ slug: `real-name-${ph.bot.slice(0, 4)}`, displayName: realName, obcBotId: null, ownerId: owner.id })
      .returning({ id: agentsTable.id });
    made.push(target!.id);

    await repairUnknownAgents();

    const [gone] = await db.select().from(agentsTable).where(eq(agentsTable.id, ph.id));
    expect(gone, "the unclaimed placeholder should have been merged away").toBeUndefined();
  });

  it("leaves an agent that already has a real name alone", async () => {
    const [row] = await db
      .insert(agentsTable)
      .values({ slug: "test-named-fine", displayName: "Perfectly Fine", obcBotId: makeBotUuid(), ownerId: owner.id })
      .returning({ id: agentsTable.id });
    made.push(row!.id);

    await repairUnknownAgents();

    const [after] = await db.select().from(agentsTable).where(eq(agentsTable.id, row!.id));
    expect(after!.displayName).toBe("Perfectly Fine");
    expect(after!.slug).toBe("test-named-fine");
  });
});

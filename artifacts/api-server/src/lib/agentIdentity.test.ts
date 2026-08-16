/**
 * agentIdentity.test.ts — one agent must not exist twice.
 *
 * Kannaka has two rows in production: agent 1 holds the slug `kannaka` and
 * zero works, agent 62 holds her bot uuid, 1909 artifacts and the penthouse.
 * Everything that finds her by name gets the empty row; everything that finds
 * her by bot gets the full one. Her storefront shows none of her work and she
 * cannot sell any of it, and nothing anywhere throws.
 *
 * These tests build that exact shape and require the repair to fix it — and,
 * more importantly, require it to REFUSE the cases where merging would hand
 * one agent another's work. A repair that is eager is worse than the fault.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import { agentsTable, artifactsTable, residenceUnitsTable } from "@workspace/db/schema";
import { findSplitIdentities, mergeSplitIdentities } from "./agentIdentity";
import { cleanupTestData, createTestUser, makeBotUuid } from "../test-helpers";

const NAME = "Test Split Identity";
let owner: { id: string };
const agentIds: number[] = [];
const artifactIds: number[] = [];

async function agent(slug: string, displayName: string, botId: string | null): Promise<number> {
  const [row] = await db
    .insert(agentsTable)
    .values({ slug, displayName, obcBotId: botId, ownerId: owner.id })
    .returning({ id: agentsTable.id });
  agentIds.push(row!.id);
  return row!.id;
}

async function work(agentId: number, title: string): Promise<number> {
  const [row] = await db
    .insert(artifactsTable)
    .values({
      externalId: `test-split-${Math.random().toString(36).slice(2)}`,
      title,
      creatorName: NAME,
      publicUrl: "https://example.invalid/w",
      artifactType: "furniture",
      agentId,
    })
    .returning({ id: artifactsTable.id });
  artifactIds.push(row!.id);
  return row!.id;
}

describe("split agent identity", () => {
  beforeEach(async () => {
    if (!owner) owner = await createTestUser({ emailLabel: "split" });
  });

  afterEach(async () => {
    if (artifactIds.length) await db.delete(artifactsTable).where(inArray(artifactsTable.id, artifactIds));
    if (agentIds.length) await db.delete(agentsTable).where(inArray(agentsTable.id, agentIds));
    artifactIds.length = 0;
    agentIds.length = 0;
  });

  // cleanupTestData removes the owning user, so it runs once at the end —
  // between cases it would delete the user the next case inserts against.
  afterAll(async () => {
    await cleanupTestData();
  });

  it("finds the empty row that owns the good slug", async () => {
    const bot = makeBotUuid();
    const empty = await agent("test-split", NAME, null);
    const full = await agent(`test-split-${bot.slice(0, 6)}`, NAME, bot);
    await work(full, "A Chair Nobody Can Find");

    const splits = (await findSplitIdentities()).filter((s) => s.drop.id === empty);
    expect(splits).toHaveLength(1);
    // The row with the bot uuid survives — it is the one the harvester will
    // keep writing to, so merging the other way re-splits on the next ingest.
    expect(splits[0]!.keep.id).toBe(full);
    expect(splits[0]!.keep.works).toBe(1);
    expect(splits[0]!.drop.works).toBe(0);
    expect(splits[0]!.slugTransfer, "the good slug should move to the survivor").toBe(true);
  });

  it("reports before it moves anything", async () => {
    const bot = makeBotUuid();
    const empty = await agent("test-split", NAME, null);
    const full = await agent(`test-split-${bot.slice(0, 6)}`, NAME, bot);
    await work(full, "Still Here Afterwards");

    const plan = await mergeSplitIdentities({ dryRun: true });
    expect(plan.dryRun).toBe(true);
    expect(plan.merged).toBeGreaterThanOrEqual(1);

    // The whole point of a dry run.
    const [still] = await db.select({ id: agentsTable.id }).from(agentsTable).where(eq(agentsTable.id, empty));
    expect(still, "the dry run deleted a row").toBeTruthy();
    const [survivor] = await db.select({ slug: agentsTable.slug }).from(agentsTable).where(eq(agentsTable.id, full));
    expect(survivor!.slug).toBe(`test-split-${bot.slice(0, 6)}`);
  });

  it("merges the two into the one that holds the bot uuid", async () => {
    const bot = makeBotUuid();
    const empty = await agent("test-split", NAME, null);
    const full = await agent(`test-split-${bot.slice(0, 6)}`, NAME, bot);
    const w = await work(full, "Findable At Last");
    const orphan = await work(empty, "Was On The Wrong Row");

    await mergeSplitIdentities({ dryRun: false });

    // The empty row is gone and its slug has moved to the survivor, so the
    // public storefront URL now resolves to the agent with the work.
    const [gone] = await db.select({ id: agentsTable.id }).from(agentsTable).where(eq(agentsTable.id, empty));
    expect(gone).toBeUndefined();
    const [survivor] = await db.select({ slug: agentsTable.slug, obcBotId: agentsTable.obcBotId }).from(agentsTable).where(eq(agentsTable.id, full));
    expect(survivor!.slug).toBe("test-split");
    expect(survivor!.obcBotId).toBe(bot);

    // Both works answer to the surviving agent — including the one that was
    // stranded on the row being deleted.
    for (const id of [w, orphan]) {
      const [a] = await db.select({ agentId: artifactsTable.agentId }).from(artifactsTable).where(eq(artifactsTable.id, id));
      expect(a!.agentId).toBe(full);
    }
  });

  it("is idempotent — a second run finds nothing left to do", async () => {
    const bot = makeBotUuid();
    await agent("test-split", NAME, null);
    const full = await agent(`test-split-${bot.slice(0, 6)}`, NAME, bot);
    await work(full, "Once Is Enough");

    await mergeSplitIdentities({ dryRun: false });
    const again = await mergeSplitIdentities({ dryRun: false });
    expect(again.details.some((d) => d.displayName === NAME)).toBe(false);
  });

  it("refuses to merge two agents that both have bot uuids", async () => {
    // Genuine namesakes. Merging them would hand one agent the other's work,
    // which is worse than the split it would be fixing — and irreversible.
    const a = await agent("test-split-a", NAME, makeBotUuid());
    const b = await agent("test-split-b", NAME, makeBotUuid());
    await work(a, "Mine");
    await work(b, "Also Mine, Different Person");

    const splits = (await findSplitIdentities()).filter((s) => s.keep.id === a || s.keep.id === b);
    expect(splits, "two bot-bearing namesakes were offered as a merge").toHaveLength(0);
  });

  it("refuses when both rows hold a home", async () => {
    // residence_units allows one home per agent. A merge here would be
    // rejected by the index partway through, after moving other tables.
    const bot = makeBotUuid();
    const empty = await agent("test-split", NAME, null);
    const full = await agent(`test-split-${bot.slice(0, 6)}`, NAME, bot);

    const units = await db
      .select({ id: residenceUnitsTable.id })
      .from(residenceUnitsTable)
      .where(eq(residenceUnitsTable.floor, 10));
    await db.update(residenceUnitsTable).set({ agentId: empty }).where(eq(residenceUnitsTable.id, units[0]!.id));
    await db.update(residenceUnitsTable).set({ agentId: full }).where(eq(residenceUnitsTable.id, units[1]!.id));

    const split = (await findSplitIdentities()).find((s) => s.drop.id === empty);
    expect(split!.conflicts.join(" ")).toMatch(/home/i);

    const res = await mergeSplitIdentities({ dryRun: false });
    expect(res.details.find((d) => d.droppedSlug === "test-split")!.action).toBe("skipped");

    await db
      .update(residenceUnitsTable)
      .set({ agentId: null, claimedAt: null })
      .where(inArray(residenceUnitsTable.id, [units[0]!.id, units[1]!.id]));
  });
});

/**
 * agentAdoption.test.ts — the split must stop happening, not just get repaired.
 *
 * mergeSplitIdentities fixes Kannaka and Rex. Nothing stopped the third one.
 * The cause is in findOrCreateAgentByBotUuid: it slugifies the display name,
 * finds the slug taken by a row that predates bot ids, and mints
 * `name-<uuid6>` beside it — so one agent ends up as two rows, everything that
 * looks her up by name finds the empty one, and nothing errors.
 *
 * A row on that slug with the same name and NO bot id is not a namesake. It is
 * this agent, from before KAX recorded bot ids, meeting its own identifier for
 * the first time. It should be adopted.
 *
 * The dangerous direction is the other one, and it gets more tests than the
 * happy path: adopting a row that belongs to somebody ELSE hands one agent
 * another's work, which is worse than the split and cannot be undone.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import { agentsTable, usersTable } from "@workspace/db/schema";
import { KANNAKA_SYSTEM_USER_ID, findOrCreateAgentByBotUuid } from "./backfill";
import { cleanupTestData, createTestUser, makeBotUuid } from "../test-helpers";

let owner: { id: string };
const made: number[] = [];

/** A pre-existing row on a slug, as the city had before bot ids. */
async function seat(slug: string, displayName: string, botId: string | null): Promise<number> {
  const [row] = await db
    .insert(agentsTable)
    .values({ slug, displayName, obcBotId: botId, ownerId: owner.id })
    .returning({ id: agentsTable.id });
  made.push(row!.id);
  return row!.id;
}

describe("adopting a name-holding agent row", () => {
  beforeEach(async () => {
    if (!owner) owner = await createTestUser({ emailLabel: "adopt" });
    // Newly minted agents are owned by the harvester's system user. In
    // production it is created at boot; here it has to exist before the
    // no-adoption paths can insert anything.
    await db
      .insert(usersTable)
      .values({ id: KANNAKA_SYSTEM_USER_ID })
      .onConflictDoNothing();
  });

  afterEach(async () => {
    if (made.length) await db.delete(agentsTable).where(inArray(agentsTable.id, made));
    made.length = 0;
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it("adopts the botless row that already holds the name", async () => {
    // The Kannaka case. `Adoptable Agent` slugifies to `adoptable-agent`,
    // which is already taken by a row with no bot id.
    const bot = makeBotUuid();
    const seated = await seat("adoptable-agent", "Adoptable Agent", null);

    const resolved = await findOrCreateAgentByBotUuid(bot, { name: "Adoptable Agent" });

    expect(resolved.id, "minted a second row instead of adopting").toBe(seated);
    expect(resolved.slug).toBe("adoptable-agent");
    expect(resolved.obcBotId).toBe(bot);

    // And exactly one row bears the name afterwards.
    const rows = await db
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(eq(agentsTable.displayName, "Adoptable Agent"));
    expect(rows).toHaveLength(1);
  });

  it("returns the same row on a second sighting", async () => {
    const bot = makeBotUuid();
    const seated = await seat("adoptable-agent", "Adoptable Agent", null);
    const first = await findOrCreateAgentByBotUuid(bot, { name: "Adoptable Agent" });
    const second = await findOrCreateAgentByBotUuid(bot, { name: "Adoptable Agent" });
    expect(first.id).toBe(seated);
    expect(second.id).toBe(seated);
  });

  it("refuses to adopt a row that already has a bot id", async () => {
    // A genuine namesake. Two different bots, one display name — adopting here
    // would give one agent the other's entire body of work.
    const theirs = makeBotUuid();
    const mine = makeBotUuid();
    const seated = await seat("adoptable-agent", "Adoptable Agent", theirs);

    const resolved = await findOrCreateAgentByBotUuid(mine, { name: "Adoptable Agent" });

    expect(resolved.id, "stole a namesake's row").not.toBe(seated);
    expect(resolved.slug).toBe(`adoptable-agent-${mine.slice(0, 6)}`);
    made.push(resolved.id);

    // The original keeps its identity untouched.
    const [orig] = await db.select().from(agentsTable).where(eq(agentsTable.id, seated));
    expect(orig!.obcBotId).toBe(theirs);
  });

  it("refuses to adopt a row whose name does not match", async () => {
    // Slugs can collide across different names once punctuation is stripped.
    // The name is the evidence that it is the same agent; without it, this is
    // just a slug clash.
    const bot = makeBotUuid();
    const seated = await seat("adoptable-agent", "Somebody Else Entirely", null);

    const resolved = await findOrCreateAgentByBotUuid(bot, { name: "Adoptable Agent" });

    expect(resolved.id).not.toBe(seated);
    made.push(resolved.id);
    const [orig] = await db.select().from(agentsTable).where(eq(agentsTable.id, seated));
    expect(orig!.obcBotId, "took over an unrelated agent's row").toBeNull();
  });

  it("adopts across a difference of case, since a name is not a password", async () => {
    // The seated row was written by an older path that cased the name
    // differently. Refusing over that would leave the split in place for the
    // exact rows most likely to have one.
    const bot = makeBotUuid();
    const seated = await seat("adoptable-agent", "adoptable agent", null);

    const resolved = await findOrCreateAgentByBotUuid(bot, { name: "Adoptable Agent" });

    expect(resolved.id, "refused to adopt over a difference of case").toBe(seated);
    expect(resolved.obcBotId).toBe(bot);
  });

  it("still mints a fresh row when nothing holds the slug", async () => {
    const bot = makeBotUuid();
    const resolved = await findOrCreateAgentByBotUuid(bot, { name: `Fresh Adopt ${bot.slice(0, 4)}` });
    made.push(resolved.id);
    expect(resolved.obcBotId).toBe(bot);
  });
});

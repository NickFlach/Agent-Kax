/**
 * identityLinks.test.ts — resolve only what was proved.
 *
 * This is the guard that lets non-OBC channels be auto-funded. The prediction
 * hub stops a proposer trading their own market by collapsing `obc:<id>` and
 * `kax:agent:<id>` to one key; a `nostr:<npub>` collapses to nothing, so until
 * it can be resolved to a bot, auto-funding it hands somebody both sides of a
 * market the house paid for.
 *
 * Which makes the dangerous failure here a FALSE POSITIVE, not a false
 * negative. Failing to resolve a real link costs a proposal a curation step.
 * Resolving a link that was never proved silently disarms the anti-self-dealing
 * guard, and nothing downstream will notice or complain. So most of these
 * tests are about refusing.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { userBotsTable } from "@workspace/db/schema";
import { resolvePrincipal, resolveNpub, isResolvablePrefix } from "./identityLinks";
import { cleanupTestData, createTestUser } from "../test-helpers";

const NPUB = "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsx7ttyn";
const BOT = "aaaaaaaa-1111-2222-3333-444444444444";

let userId: string;

async function putBot(over: Partial<typeof userBotsTable.$inferInsert> = {}) {
  await db.delete(userBotsTable).where(eq(userBotsTable.obcBotId, BOT));
  await db.insert(userBotsTable).values({
    userId,
    obcBotId: BOT,
    displayName: "Linked Bot",
    ...over,
  });
}

describe("identity links", () => {
  beforeEach(async () => {
    if (!userId) userId = (await createTestUser({ emailLabel: "links" })).id;
    await db.delete(userBotsTable).where(eq(userBotsTable.obcBotId, BOT));
  });

  afterAll(async () => {
    await db.delete(userBotsTable).where(eq(userBotsTable.obcBotId, BOT));
    await cleanupTestData();
  });

  it("resolves an npub whose proof completed", async () => {
    const when = new Date("2026-08-01T00:00:00Z");
    await putBot({ npub: NPUB, npubVerifiedAt: when });

    const r = await resolvePrincipal(`nostr:${NPUB}`);
    expect(r).not.toBeNull();
    expect(r!.principal).toBe(`obc:${BOT}`);
    expect(r!.botId).toBe(BOT);
    expect(r!.via).toBe("npub");
    expect(r!.verifiedAt.toISOString()).toBe(when.toISOString());
  });

  it("REFUSES an npub that was claimed but never proved", async () => {
    // The row carries the npub and no verified-at: the binding was started and
    // never finished. Resolving this would let an unproven claim inherit a
    // bot's identity — and the guard it disarms is silent, so nothing would
    // ever tell us.
    await putBot({ npub: NPUB, npubVerifiedAt: null });

    expect(await resolvePrincipal(`nostr:${NPUB}`)).toBeNull();
    expect(await resolveNpub(NPUB)).toBeNull();
  });

  it("refuses an npub nobody has bound", async () => {
    await putBot();
    expect(await resolvePrincipal(`nostr:${NPUB}`)).toBeNull();
  });

  it("refuses a near-miss npub rather than matching loosely", async () => {
    await putBot({ npub: NPUB, npubVerifiedAt: new Date() });
    // One character different is a different key, not a typo to be helpful about.
    expect(await resolvePrincipal(`nostr:${NPUB.slice(0, -1)}x`)).toBeNull();
  });

  it("refuses channels that have no link flow yet", async () => {
    await putBot({ npub: NPUB, npubVerifiedAt: new Date() });
    for (const p of [`bsky:${NPUB}`, `mcp:${BOT}`, `nats:${BOT}`, `obc:${BOT}`, BOT, "", "nostr:"]) {
      expect(await resolvePrincipal(p), `resolved "${p}"`).toBeNull();
    }
  });

  it("says which prefixes can be resolved at all", () => {
    // Channels WITH a proof flow. This list grows as flows are built — it
    // said bsky was unresolvable until the Bluesky flow existed, and the PR
    // that built it duly failed this line, which is the test working.
    expect(isResolvablePrefix(`nostr:${NPUB}`)).toBe(true);
    expect(isResolvablePrefix("bsky:someone.bsky.social")).toBe(true);
    // Channels WITHOUT one. A door can then refuse with "no link flow for
    // this channel yet" rather than the less useful "not found".
    expect(isResolvablePrefix(`mcp:${BOT}`)).toBe(false);
    expect(isResolvablePrefix(`nats:${BOT}`)).toBe(false);
  });

  it("is not confused by case in the prefix", async () => {
    await putBot({ npub: NPUB, npubVerifiedAt: new Date() });
    const r = await resolvePrincipal(`NOSTR:${NPUB}`);
    expect(r?.botId).toBe(BOT);
  });
});

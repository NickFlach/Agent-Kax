/**
 * joinery.test.ts — the money and the chair must agree.
 *
 * joinery-core covers the arithmetic. What this covers is the part that can
 * only go wrong against a database: that credits actually leave the buyer and
 * land on the seller and the maker, that a retried request does not buy the
 * same chair twice, and that every refusal happens BEFORE the money moves
 * rather than after.
 *
 * The last one is the one worth the setup. A purchase that debits an account
 * and then discovers the buyer has no flat leaves a hole nobody is watching
 * for — the ledger is correct, the room is empty, and no error survives.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  agentsTable,
  artifactsTable,
  residenceUnitsTable,
  storeListingsTable,
  unitFurnishingsTable,
} from "@workspace/db/schema";
import { HOUSE_ACCOUNT } from "./ledger-core";
import { balance, postTransaction } from "./ledger";
import { saleTxId } from "./joinery-core";
import {
  AlreadyOwned,
  ListingNotForSale,
  NoHomeToFurnish,
  SlotTaken,
  catalog,
  furnishingsOfUnit,
  purchase,
} from "./joinery";
import { cleanupTestData, createTestAgent, createTestUser, makeBotUuid } from "../test-helpers";

const ASSET = "play_credit";
const MAKER_NAME = "Test Maker Of Chairs";
// A maker who exists as an agent, so the royalty has somewhere real to land.
let maker: { id: number; botId: string; account: string };

let owner: { id: string };
let buyer: { id: number; botId: string; account: string };
let seller: { id: number; botId: string; account: string };
let home: { floor: number; letter: string };
let artifactIds: number[] = [];
let listingId: number;
let ownListingId: number;
let strangerListingId: number;

/** A furniture artifact by `creator`, listed by `seller` at `price`. */
async function stock(title: string, creator: string, price: number | null): Promise<number> {
  const [art] = await db
    .insert(artifactsTable)
    .values({
      externalId: `test-joinery-${title}-${Math.random().toString(36).slice(2)}`,
      title,
      creatorName: creator,
      publicUrl: "https://example.invalid/piece",
      thumbnailUrl: "https://example.invalid/piece.jpg",
      artifactType: "furniture",
    })
    .returning({ id: artifactsTable.id });
  artifactIds.push(art!.id);
  const [listing] = await db
    .insert(storeListingsTable)
    .values({ storeAgentId: seller.id, artifactId: art!.id, price })
    .returning({ id: storeListingsTable.id });
  return listing!.id;
}

/** Empty the test flat between cases. */
async function clearFlat() {
  if (!home) return;
  await db
    .delete(unitFurnishingsTable)
    .where(and(eq(unitFurnishingsTable.floor, home.floor), eq(unitFurnishingsTable.letter, home.letter)));
}

/** Put credits in an account, the same way a signup grant does. */
async function fund(account: string, amount: bigint, tag: string) {
  await postTransaction({
    txId: `test-joinery-fund-${tag}`,
    asset: ASSET,
    postings: [
      { account: HOUSE_ACCOUNT, amount: -amount, kind: "grant", ref: "test" },
      { account, amount, kind: "grant", ref: "test" },
    ],
  });
}

describe("joinery purchase", () => {
  beforeEach(async () => {
    if (!owner) {
      owner = await createTestUser({ emailLabel: "joinery" });

      const b = await createTestAgent(owner.id, "buyer");
      const s = await createTestAgent(owner.id, "seller");
      const m = await createTestAgent(owner.id, "maker");
      const buyerBot = makeBotUuid();
      const sellerBot = makeBotUuid();
      await db.update(agentsTable).set({ obcBotId: buyerBot }).where(eq(agentsTable.id, b.id));
      await db
        .update(agentsTable)
        .set({ obcBotId: sellerBot, displayName: MAKER_NAME })
        .where(eq(agentsTable.id, s.id));
      // A per-run display name, because the royalty is resolved by name to an
      // agent: a fixed one would collide with a previous run's maker and the
      // balances would drift upward every time the suite ran.
      const makerBot = makeBotUuid();
      const makerName = `Test Maker ${makerBot.slice(0, 8)}`;
      await db
        .update(agentsTable)
        .set({ obcBotId: makerBot, displayName: makerName })
        .where(eq(agentsTable.id, m.id));
      buyer = { id: b.id, botId: buyerBot, account: `trader:kax:agent:${buyerBot}` };
      seller = { id: s.id, botId: sellerBot, account: `trader:kax:agent:${sellerBot}` };
      maker = { id: m.id, botId: makerBot, account: `trader:kax:agent:${makerBot}` };

      // Give the buyer somewhere to put things: a real unit, held directly so
      // the test does not depend on the allocation order.
      const [unit] = await db
        .select({ floor: residenceUnitsTable.floor, letter: residenceUnitsTable.letter })
        .from(residenceUnitsTable)
        .where(eq(residenceUnitsTable.floor, 11))
        .limit(1);
      home = { floor: unit!.floor, letter: unit!.letter };

      listingId = await stock("Test Chair", makerName, 1000);
      ownListingId = await stock("Test Bench", MAKER_NAME, 500);
      strangerListingId = await stock("Test Import", "Nobody In This City", 1000);
      await stock("Test Display Only", "Somebody Else Entirely", null);

      await fund(buyer.account, 100_000n, buyerBot);
    }

    await clearFlat();
    await db
      .update(residenceUnitsTable)
      .set({ agentId: buyer.id, claimedAt: sql`now()` })
      .where(and(eq(residenceUnitsTable.floor, home.floor), eq(residenceUnitsTable.letter, home.letter)));
  });

  afterAll(async () => {
    await clearFlat();
    await db
      .update(residenceUnitsTable)
      .set({ agentId: null, claimedAt: null })
      .where(and(eq(residenceUnitsTable.floor, home.floor), eq(residenceUnitsTable.letter, home.letter)));
    for (const id of artifactIds) await db.delete(artifactsTable).where(eq(artifactsTable.id, id));
    artifactIds = [];
    await cleanupTestData();
  });

  it("moves the credits and puts the piece in the room", async () => {
    const before = await balance(buyer.account, ASSET);
    const sellerBefore = await balance(seller.account, ASSET);

    const r = await purchase({
      buyerAgentId: buyer.id,
      buyerAccount: buyer.account,
      listingId,
      slot: "corner",
    });

    expect(r.price).toBe(1000);
    expect(r.floor).toBe(home.floor);
    expect(r.letter).toBe(home.letter);
    expect(r.replayed).toBe(false);

    // 1000 out of the buyer; 800 to the seller, who did not make it.
    expect(await balance(buyer.account, ASSET)).toBe(before - 1000n);
    expect(await balance(seller.account, ASSET)).toBe(sellerBefore + 800n);
    expect(await balance(maker.account, ASSET)).toBe(100n);

    const inRoom = await furnishingsOfUnit(home.floor, home.letter);
    expect(inRoom).toHaveLength(1);
    expect(inRoom[0]!.slot).toBe("corner");
    expect(inRoom[0]!.title).toBe("Test Chair");
    // The receipt, on the row: the chair and the transaction that paid for it
    // cannot drift apart.
    expect(r.txId).toBe(saleTxId(listingId, buyer.account));
  });

  it("does not pay the maker twice when the seller made it", async () => {
    const sellerBefore = await balance(seller.account, ASSET);
    await purchase({ buyerAgentId: buyer.id, buyerAccount: buyer.account, listingId: ownListingId, slot: "bedside" });
    // 500 - 50 house = 450, all of it to the seller. No royalty line.
    expect(await balance(seller.account, ASSET)).toBe(sellerBefore + 450n);
    // The seller IS the maker here (same display name), so there is no second
    // line at all — not a zero one.
    expect(await balance(`trader:kax:agent:${seller.botId}`, ASSET)).toBe(sellerBefore + 450n);
  });

  it("charges once when the same request arrives twice", async () => {
    // A dropped response, an agent that fires twice, a double-submitted form.
    // The deterministic txId means the ledger replays and the money moves once.
    const before = await balance(buyer.account, ASSET);
    const first = await purchase({ buyerAgentId: buyer.id, buyerAccount: buyer.account, listingId, slot: "corner" });
    const spentOnce = before - (await balance(buyer.account, ASSET));

    // Re-running hits AlreadyOwned before it reaches the ledger, which is the
    // fast path. Clearing the row and retrying exercises the ledger's own
    // idempotency — the case where the row write is what failed last time.
    await expect(
      purchase({ buyerAgentId: buyer.id, buyerAccount: buyer.account, listingId, slot: "wall_left" }),
    ).rejects.toBeInstanceOf(AlreadyOwned);

    await db.delete(unitFurnishingsTable).where(eq(unitFurnishingsTable.id, first.furnishingId));
    const second = await purchase({
      buyerAgentId: buyer.id,
      buyerAccount: buyer.account,
      listingId,
      slot: "corner",
    });
    expect(second.replayed, "the ledger applied the same sale twice").toBe(true);
    expect(before - (await balance(buyer.account, ASSET))).toBe(spentOnce);
  });

  it("refuses the second thing in a slot", async () => {
    await purchase({ buyerAgentId: buyer.id, buyerAccount: buyer.account, listingId, slot: "corner" });
    await expect(
      purchase({ buyerAgentId: buyer.id, buyerAccount: buyer.account, listingId: ownListingId, slot: "corner" }),
    ).rejects.toBeInstanceOf(SlotTaken);
  });

  it("takes no money from a buyer with nowhere to put it", async () => {
    // The refusal that matters most: a debit followed by a discovery leaves a
    // hole nobody is watching for.
    await db
      .update(residenceUnitsTable)
      .set({ agentId: null, claimedAt: null })
      .where(and(eq(residenceUnitsTable.floor, home.floor), eq(residenceUnitsTable.letter, home.letter)));
    const before = await balance(buyer.account, ASSET);

    await expect(
      purchase({ buyerAgentId: buyer.id, buyerAccount: buyer.account, listingId, slot: "corner" }),
    ).rejects.toBeInstanceOf(NoHomeToFurnish);

    expect(await balance(buyer.account, ASSET), "charged a buyer with no flat").toBe(before);
  });

  it("gives the royalty to the seller when the maker is not an agent here", async () => {
    // A name on an imported piece is not an account. Parking credits in
    // `maker:nobody in this city` would look right in the ledger and be
    // unspendable forever, so the seller takes it — and the total still
    // balances, which is the only property the chain will accept.
    const buyerBefore = await balance(buyer.account, ASSET);
    const sellerBefore = await balance(seller.account, ASSET);
    await purchase({
      buyerAgentId: buyer.id,
      buyerAccount: buyer.account,
      listingId: strangerListingId,
      slot: "window",
    });
    expect(buyerBefore - (await balance(buyer.account, ASSET))).toBe(1000n);
    expect(await balance(seller.account, ASSET)).toBe(sellerBefore + 900n);
  });

  it("will not sell what is only on display", async () => {
    // An unpriced listing is in the showroom, not for sale. Reading a NULL
    // price as free would give away another agent's work on a missing field.
    const rows = await db
      .select({ id: storeListingsTable.id, price: storeListingsTable.price })
      .from(storeListingsTable)
      .where(eq(storeListingsTable.storeAgentId, seller.id));
    const unpriced = rows.find((r) => r.price === null);
    expect(unpriced, "the unpriced listing was not created").toBeTruthy();

    const before = await balance(buyer.account, ASSET);
    await expect(
      purchase({ buyerAgentId: buyer.id, buyerAccount: buyer.account, listingId: unpriced!.id, slot: "corner" }),
    ).rejects.toBeInstanceOf(ListingNotForSale);
    expect(await balance(buyer.account, ASSET)).toBe(before);
  });

  it("keeps display-only pieces out of the catalog entirely", async () => {
    const items = await catalog(200);
    const mine = items.filter((i) => i.sellerAgentId === seller.id);
    expect(mine.length).toBeGreaterThanOrEqual(3);
    expect(mine.every((i) => i.price > 0), "an unpriced piece reached the catalogue").toBe(true);
    expect(mine.some((i) => i.title === "Test Display Only")).toBe(false);
  });
});

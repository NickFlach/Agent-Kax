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
import { balance, getTransaction, postTransaction } from "./ledger";
import { MAX_LIST_PRICE_MINOR, saleTxId } from "./joinery-core";
import {
  AlreadyOwned,
  BadListPrice,
  NotFurniture,
  SellerCannotBePaid,
  list,
  listingsOfAgent,
  worksForSale,
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
let buyer: { id: number; botId: string; principal: string; account: string };
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
  await postTransaction({ actor: "test:suite",
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
      buyer = {
        id: b.id,
        botId: buyerBot,
        principal: `kax:agent:${buyerBot}`,
        account: `trader:kax:agent:${buyerBot}`,
      };
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
      buyerAccount: buyer.account, buyerPrincipal: buyer.principal,
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

    // #245 AC: the recorded actor for a joinery purchase is the BUYER'S
    // principal — passed explicitly from the route, never re-derived by
    // stripping the trader: prefix off an account name.
    const rec = await getTransaction(r.txId);
    expect(rec?.actor).toBe(buyer.principal);

    // #248 AC, joinery path: the same purchase produced exactly one authority
    // decision, attributed to the buyer with the commerce capability.
    const decisions = await db.execute(
      sql`SELECT actor, capability FROM authority_decisions WHERE tx_id = ${r.txId}`,
    );
    expect(decisions.rows).toHaveLength(1);
    expect((decisions.rows[0] as { actor: string }).actor).toBe(buyer.principal);
    expect((decisions.rows[0] as { capability: string }).capability).toBe("commerce.purchase");
  });

  it("does not pay the maker twice when the seller made it", async () => {
    const sellerBefore = await balance(seller.account, ASSET);
    await purchase({ buyerAgentId: buyer.id, buyerAccount: buyer.account, buyerPrincipal: buyer.principal, listingId: ownListingId, slot: "bedside" });
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
    const first = await purchase({ buyerAgentId: buyer.id, buyerAccount: buyer.account, buyerPrincipal: buyer.principal, listingId, slot: "corner" });
    const spentOnce = before - (await balance(buyer.account, ASSET));

    // Re-running hits AlreadyOwned before it reaches the ledger, which is the
    // fast path. Clearing the row and retrying exercises the ledger's own
    // idempotency — the case where the row write is what failed last time.
    await expect(
      purchase({ buyerAgentId: buyer.id, buyerAccount: buyer.account, buyerPrincipal: buyer.principal, listingId, slot: "wall_left" }),
    ).rejects.toBeInstanceOf(AlreadyOwned);

    await db.delete(unitFurnishingsTable).where(eq(unitFurnishingsTable.id, first.furnishingId));
    const second = await purchase({
      buyerAgentId: buyer.id,
      buyerAccount: buyer.account, buyerPrincipal: buyer.principal,
      listingId,
      slot: "corner",
    });
    expect(second.replayed, "the ledger applied the same sale twice").toBe(true);
    expect(before - (await balance(buyer.account, ASSET))).toBe(spentOnce);
  });

  it("refuses the second thing in a slot", async () => {
    await purchase({ buyerAgentId: buyer.id, buyerAccount: buyer.account, buyerPrincipal: buyer.principal, listingId, slot: "corner" });
    await expect(
      purchase({ buyerAgentId: buyer.id, buyerAccount: buyer.account, buyerPrincipal: buyer.principal, listingId: ownListingId, slot: "corner" }),
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
      purchase({ buyerAgentId: buyer.id, buyerAccount: buyer.account, buyerPrincipal: buyer.principal, listingId, slot: "corner" }),
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
      buyerAccount: buyer.account, buyerPrincipal: buyer.principal,
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
      purchase({ buyerAgentId: buyer.id, buyerAccount: buyer.account, buyerPrincipal: buyer.principal, listingId: unpriced!.id, slot: "corner" }),
    ).rejects.toBeInstanceOf(ListingNotForSale);
    expect(await balance(buyer.account, ASSET)).toBe(before);
  });

  it("lets an agent price its own work, which is why the shelves are not empty", async () => {
    // The Joinery could be STOCKED only by a signed-in human who owned the
    // store. Eighteen pieces of agent-made furniture sat in the production
    // showroom and none could be sold by whoever made it — a counter in front
    // of empty shelves, and nothing about it looked broken.
    const [art] = await db
      .insert(artifactsTable)
      .values({
        externalId: `test-joinery-sell-${Math.random().toString(36).slice(2)}`,
        title: "Test Stool",
        creatorName: "Somebody Else Entirely",
        publicUrl: "https://example.invalid/stool",
        thumbnailUrl: "https://example.invalid/stool.jpg",
        artifactType: "furniture",
      })
      .returning({ id: artifactsTable.id });
    artifactIds.push(art!.id);

    const listed = await list({ sellerAgentId: seller.id, artifactId: art!.id, price: 250 });
    expect(listed.repriced).toBe(false);
    expect(listed.price).toBe(250);
    expect((await catalog(200)).items.some((i) => i.artifactId === art!.id)).toBe(true);

    // Repricing is the same call, not a second listing.
    const again = await list({ sellerAgentId: seller.id, artifactId: art!.id, price: 400 });
    expect(again.repriced).toBe(true);
    expect(again.listingId).toBe(listed.listingId);

    // And it can actually be bought at the price the seller set.
    const r = await purchase({
      buyerAgentId: buyer.id,
      buyerAccount: buyer.account, buyerPrincipal: buyer.principal,
      listingId: listed.listingId,
      slot: "wall_right",
    });
    expect(r.price).toBe(400);
  });

  it("takes a piece off sale without erasing that the store offers it", async () => {
    // Delisting by deletion would lose "this store carries this piece", which
    // is what a listing has always meant here. A null price keeps the curation
    // and withdraws the offer.
    const mine = await listingsOfAgent(seller.id);
    const target = mine.find((l) => l.price !== null);
    expect(target, "the seller had nothing priced to withdraw").toBeTruthy();

    await list({ sellerAgentId: seller.id, artifactId: target!.artifactId, price: null });
    expect((await catalog(200)).items.some((i) => i.listingId === target!.listingId)).toBe(false);
    expect((await listingsOfAgent(seller.id)).some((l) => l.listingId === target!.listingId)).toBe(true);

    await list({ sellerAgentId: seller.id, artifactId: target!.artifactId, price: target!.price });
  });

  it("refuses prices and wares that would not survive the till", async () => {
    const mine = await listingsOfAgent(seller.id);
    const any = mine[0]!;
    await expect(list({ sellerAgentId: seller.id, artifactId: any.artifactId, price: 0 })).rejects.toBeInstanceOf(BadListPrice);
    await expect(list({ sellerAgentId: seller.id, artifactId: any.artifactId, price: -5 })).rejects.toBeInstanceOf(BadListPrice);
    await expect(list({ sellerAgentId: seller.id, artifactId: any.artifactId, price: 1.5 })).rejects.toBeInstanceOf(BadListPrice);
    // A ceiling so a fat-fingered price is a refusal rather than a transfer.
    await expect(
      list({ sellerAgentId: seller.id, artifactId: any.artifactId, price: MAX_LIST_PRICE_MINOR + 1 }),
    ).rejects.toBeInstanceOf(BadListPrice);

    // And the refusal has to name the unit it is counting. A listing price is
    // posted to the ledger verbatim as minor units, so a message that calls
    // the ceiling "credits" tells a seller the limit is a million credits when
    // it is one — a factor of a million in the direction of underpricing your
    // own work, stated by the only text an agent ever reads about the limit.
    const refusalFor = async (price: number): Promise<string> => {
      try {
        await list({ sellerAgentId: seller.id, artifactId: any.artifactId, price });
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error(`list() accepted price ${price} instead of refusing it`);
    };

    const overCeiling = await refusalFor(MAX_LIST_PRICE_MINOR + 1);
    expect(overCeiling).toContain("minor units");
    expect(overCeiling).not.toMatch(new RegExp(`${MAX_LIST_PRICE_MINOR}\\s+credits`));

    const notWhole = await refusalFor(1.5);
    expect(notWhole).toContain("minor units");
    expect(notWhole).not.toContain("number of credits");

    // The Joinery sells furniture. A song listed here would be bought and then
    // stood in the corner of somebody's flat.
    const [song] = await db
      .insert(artifactsTable)
      .values({
        externalId: `test-joinery-song-${Math.random().toString(36).slice(2)}`,
        title: "Test Song",
        creatorName: "Somebody Else Entirely",
        publicUrl: "https://example.invalid/song",
        artifactType: "music",
      })
      .returning({ id: artifactsTable.id });
    artifactIds.push(song!.id);
    await expect(
      list({ sellerAgentId: seller.id, artifactId: song!.id, price: 100 }),
    ).rejects.toBeInstanceOf(NotFurniture);
  });

  it("will not let an unpayable agent open a shop", async () => {
    // Same refusal as the sale itself: a seller with no account would learn
    // it only after somebody had paid.
    const stranger = await createTestAgent(owner.id, "unpayable");
    const mine = await listingsOfAgent(seller.id);
    await expect(
      list({ sellerAgentId: stranger.id, artifactId: mine[0]!.artifactId, price: 100 }),
    ).rejects.toBeInstanceOf(SellerCannotBePaid);
  });

  it("tells an agent the artifact ids it needs to sell anything", async () => {
    // joinery_sell takes an artifactId, and before this nothing in the city
    // would tell an agent what its own artifact ids were. The tool validated
    // its input and could not be called correctly by anybody without a
    // browser — a dead end that every test passed straight through.
    const [art] = await db
      .insert(artifactsTable)
      .values({
        externalId: `test-joinery-mine-${Math.random().toString(36).slice(2)}`,
        title: "Test Own Cabinet",
        creatorName: "Whoever",
        creatorBotId: seller.botId,
        publicUrl: "https://example.invalid/cab",
        artifactType: "furniture",
      })
      .returning({ id: artifactsTable.id });
    artifactIds.push(art!.id);

    const works = (await worksForSale({ id: seller.id, obcBotId: seller.botId })).works;
    const found = works.find((w) => w.artifactId === art!.id);
    expect(found, "an agent cannot see its own work").toBeTruthy();
    expect(found!.price, "an unlisted work should not claim a price").toBeNull();

    // And what it is already asking, so a seller can reprice without guessing.
    await list({ sellerAgentId: seller.id, artifactId: art!.id, price: 300 });
    const after = (await worksForSale({ id: seller.id, obcBotId: seller.botId })).works.find(
      (w) => w.artifactId === art!.id,
    );
    expect(after!.price).toBe(300);
    expect(after!.listingId).not.toBeNull();
  });

  it("pays the royalty by bot id, which a rename cannot break", async () => {
    // creator_bot_id is on the artifact and is what the storefront already
    // uses to decide whose work something is. Matching display names was the
    // earlier fallback and is fragile exactly where it matters — "Mosi Ī˹" is
    // a real maker in this city, and a royalty that depends on reproducing
    // that string is one that will quietly not be paid.
    const [art] = await db
      .insert(artifactsTable)
      .values({
        externalId: `test-joinery-botid-${Math.random().toString(36).slice(2)}`,
        title: "Test Renamed Maker Chair",
        // The NAME does not match the maker agent at all; only the id does.
        creatorName: "A Name Nobody Here Has",
        creatorBotId: maker.botId,
        publicUrl: "https://example.invalid/renamed",
        artifactType: "furniture",
      })
      .returning({ id: artifactsTable.id });
    artifactIds.push(art!.id);
    const listed = await list({ sellerAgentId: seller.id, artifactId: art!.id, price: 1000 });

    const makerBefore = await balance(maker.account, ASSET);
    await purchase({
      buyerAgentId: buyer.id,
      buyerAccount: buyer.account, buyerPrincipal: buyer.principal,
      listingId: listed.listingId,
      slot: "corner",
    });
    expect(await balance(maker.account, ASSET), "the maker was not paid").toBe(makerBefore + 100n);
  });

  it("says how much work there is, not how much it returned", async () => {
    // A hundred was a number I picked without checking. Kannaka has 282
    // pieces of furniture, so the tool answered "here is your work" with a bit
    // under two fifths of it and nothing to say the rest existed.
    const before = await worksForSale({ id: seller.id, obcBotId: seller.botId });
    for (let i = 0; i < 6; i++) {
      const [a] = await db
        .insert(artifactsTable)
        .values({
          externalId: `test-joinery-page-${i}-${Math.random().toString(36).slice(2)}`,
          title: `Test Paged ${i}`,
          creatorName: "Whoever",
          creatorBotId: seller.botId,
          publicUrl: "https://example.invalid/p",
          artifactType: "furniture",
        })
        .returning({ id: artifactsTable.id });
      artifactIds.push(a!.id);
    }

    const all = await worksForSale({ id: seller.id, obcBotId: seller.botId });
    expect(all.total).toBe(before.total + 6);

    // A page smaller than the total must say so.
    const page = await worksForSale({ id: seller.id, obcBotId: seller.botId }, { limit: 3 });
    expect(page.works).toHaveLength(3);
    expect(page.total, "a page reported itself as the whole").toBe(all.total);
    expect(page.truncated).toBe(true);

    // And the offset actually moves, rather than returning the same three.
    const second = await worksForSale({ id: seller.id, obcBotId: seller.botId }, { limit: 3, offset: 3 });
    const firstIds = page.works.map((w) => w.artifactId);
    expect(second.works.some((w) => firstIds.includes(w.artifactId)), "offset returned the same page").toBe(false);

    // The other direction: a page that holds everything must not cry wolf.
    const whole = await worksForSale({ id: seller.id, obcBotId: seller.botId }, { limit: 500 });
    expect(whole.truncated).toBe(false);
  });

  it("says how much is on sale, not how much the page holds", async () => {
    const wide = await catalog(500);
    const narrow = await catalog(2);
    expect(narrow.items).toHaveLength(Math.min(2, wide.total));
    expect(narrow.total).toBe(wide.total);
    expect(narrow.truncated).toBe(wide.total > 2);
    expect(wide.truncated).toBe(false);
  });

  it("keeps display-only pieces out of the catalog entirely", async () => {
    const items = (await catalog(200)).items;
    const mine = items.filter((i) => i.sellerAgentId === seller.id);
    expect(mine.length).toBeGreaterThanOrEqual(3);
    expect(mine.every((i) => i.price > 0), "an unpriced piece reached the catalogue").toBe(true);
    expect(mine.some((i) => i.title === "Test Display Only")).toBe(false);
  });
});

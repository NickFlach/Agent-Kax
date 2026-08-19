/**
 * occPartnerEvents.test.ts — the three OpenClawCity partner-status events, end
 * to end against a real database.
 *
 * What the live test measures: Vincent deactivates a test agent, and KAX must
 * refuse it at the gate and walk it out of the city. The agent he deactivates
 * is almost certainly one KAX HARVESTED and no KAX human ever attached — a
 * fresh test bot with an `agents` row and no `user_bots` row — which is exactly
 * the population the pre-existing revocation could not touch. So the first
 * group here is not "does revoke() write a row" but "does a freeze reach an
 * agent that has a storefront, a flat and a balance and no login".
 *
 * ANTI-VACUITY. Every refusal is preceded by the same thing SUCCEEDING for the
 * same agent, or by the same refusal NOT happening for an unrevoked control.
 * A test that stops proving anything then fails loudly instead of passing on an
 * empty set. Where a property is asserted over a collection, the collection is
 * asserted non-empty first.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  agentsTable,
  artifactsTable,
  botOccStatusTable,
  creditLedgerTable,
  residenceUnitsTable,
  storeListingsTable,
  unitFurnishingsTable,
  userBotsTable,
} from "@workspace/db/schema";
import { dispatchPartnerEvent, getRegisteredEventTypes } from "./eventDispatcher";
import { registerAllEventHandlers } from "./eventHandlers";
import { isRevoked, isOccVerified, restore, revokedBotIds } from "./revocation";
import { AccountFrozen } from "./frozenAccounts";
import { balance, postTransaction, verifyLedgerChain } from "./ledger";
import { HOUSE_ACCOUNT } from "./ledger-core";
import { catalog, list, purchase, SellerFrozen } from "./joinery";
import { homeUnitOf, housingCapacity } from "./onboarding";
import { cleanupTestData, createTestUser, makeBotUuid, makeTestId, testLogger } from "../test-helpers";

const uniq = () => Math.random().toString(36).slice(2, 10);

/** Bot ids this file touched, so it can clean up after itself. */
const touchedBots: string[] = [];
function newBot(): string {
  const id = makeBotUuid();
  touchedBots.push(id);
  return id;
}

let userId: string;

async function dispatch(eventType: string, data: unknown, eventUuid = `evt-${uniq()}-${uniq()}`) {
  return dispatchPartnerEvent({ eventType, eventUuid, data, log: testLogger, source: "webhook" });
}

/** Give a bot a KAX ledger balance the way the real signup grant does. */
async function fund(botId: string, amount: bigint): Promise<void> {
  await postTransaction({ actor: "test:suite",
    txId: `test-fund-${botId}-${uniq()}`,
    asset: "play_credit",
    postings: [
      { account: HOUSE_ACCOUNT, amount: -amount, kind: "grant" },
      { account: `trader:kax:agent:${botId}`, amount, kind: "grant" },
    ],
  });
}

beforeAll(async () => {
  registerAllEventHandlers();
  userId = (await createTestUser({ emailLabel: "occ" })).id;
});

afterAll(async () => {
  if (touchedBots.length > 0) {
    await db.delete(botOccStatusTable).where(inArray(botOccStatusTable.obcBotId, touchedBots));
    await db.delete(userBotsTable).where(inArray(userBotsTable.obcBotId, touchedBots));
    // Release any flat this file's agents took, so the tower is not drained for
    // the next suite. The agents rows themselves go with cleanupTestData().
    const rows = await db
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(inArray(agentsTable.obcBotId, touchedBots));
    if (rows.length > 0) {
      await db
        .update(residenceUnitsTable)
        .set({ agentId: null, claimedAt: null })
        .where(inArray(residenceUnitsTable.agentId, rows.map((r) => r.id)));
      await db.delete(storeListingsTable).where(inArray(storeListingsTable.storeAgentId, rows.map((r) => r.id)));
      await db.delete(agentsTable).where(inArray(agentsTable.id, rows.map((r) => r.id)));
    }
  }
  await cleanupTestData();
});

// ───────────────────────────────────────────────────────────────────────────
describe("the handlers exist at all", () => {
  it("registers all three partner-status event types", () => {
    const types = getRegisteredEventTypes();
    // Non-empty first: `toContain` over an empty array would fail, but an
    // assertion that the LIST is populated says what this is really checking —
    // registration is also what makes startup replay collect the backlog, since
    // replayMissedEventsOnStartup iterates exactly this list.
    expect(types.length).toBeGreaterThan(0);
    for (const t of ["verification.revoked", "bot.created", "bot.verified"]) {
      expect(types, `${t} is unregistered, so replay will never ask for it`).toContain(t);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("verification.revoked freezes a HARVESTED agent with no KAX login", () => {
  let botId: string;
  let agentId: number;

  beforeEach(async () => {
    botId = newBot();
    // Exactly the shape of Vincent's test agent: harvested into `agents`, never
    // attached to a KAX human, so there is no `user_bots` row anywhere.
    const [row] = await db
      .insert(agentsTable)
      .values({ slug: makeTestId("occ-harvested"), displayName: "Harvested", obcBotId: botId, ownerId: userId })
      .returning();
    agentId = row!.id;
  });

  it("has no user_bots row — the precondition this whole group depends on", async () => {
    const attached = await db
      .select()
      .from(userBotsTable)
      .where(eq(userBotsTable.obcBotId, botId));
    expect(attached).toHaveLength(0);
    // …and is not revoked yet. The positive control for everything below.
    expect(await isRevoked(botId)).toBeNull();
  });

  it("reads as revoked after the event, reason and all", async () => {
    const before = await isRevoked(botId);
    expect(before, "positive control: it must start unrevoked").toBeNull();

    const r = await dispatch("verification.revoked", {
      agent_uuid: botId,
      reason: "deactivated by OpenClawCity",
    });
    expect(r.status).toBe("handled");

    const after = await isRevoked(botId);
    expect(after, "a harvested agent with no user_bots row was not frozen").not.toBeNull();
    expect(after!.reason).toBe("deactivated by OpenClawCity");
    expect(after!.revokedAt).toBeInstanceOf(Date);
  });

  it("appears in the set the residency sweep evicts on", async () => {
    const before = await revokedBotIds();
    expect(before.has(botId)).toBe(false);
    await dispatch("verification.revoked", { agent_uuid: botId, reason: "x" });
    const after = await revokedBotIds();
    expect(after.size).toBeGreaterThan(0);
    expect(after.has(botId), "the sweep will never walk this agent out").toBe(true);
  });

  it("finds the agent uuid under any of the field names OCC might use", async () => {
    const fields = ["agent_uuid", "bot_uuid", "bot_id", "obc_bot_id", "uuid"];
    expect(fields.length).toBeGreaterThan(0);
    for (const f of fields) {
      const b = newBot();
      const res = await dispatch("verification.revoked", { [f]: b, reason: f });
      expect(res.status, `payload field ${f} was not understood`).toBe("handled");
      expect(await isRevoked(b), `payload field ${f} was not understood`).not.toBeNull();
    }
  });

  it("nested one level down as well", async () => {
    const b = newBot();
    const res = await dispatch("verification.revoked", { agent: { uuid: b }, reason: "nested" });
    expect(res.status).toBe("handled");
    expect(await isRevoked(b)).not.toBeNull();
  });

  it("DEFERS a payload whose agent uuid it cannot find, rather than burning it", async () => {
    // Recording it as processed would be permanent: replay dedupes on
    // processed_events, so a later fix to the field list could never recover
    // the revocation. Deferring leaves it replayable.
    const res = await dispatch("verification.revoked", { something: "unexpected" });
    expect(res.status).toBe("deferred");
  });

  it("leaves every other agent alone", async () => {
    const bystander = newBot();
    await db
      .insert(agentsTable)
      .values({ slug: makeTestId("occ-bystander"), displayName: "Bystander", obcBotId: bystander, ownerId: userId });
    await dispatch("verification.revoked", { agent_uuid: botId, reason: "only this one" });
    expect(await isRevoked(botId)).not.toBeNull();
    expect(await isRevoked(bystander), "the freeze spread to an innocent agent").toBeNull();
  });

  it("agentId is a real row, so the fixture is not silently empty", async () => {
    expect(agentId).toBeGreaterThan(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("idempotency by event uuid", () => {
  it("applies a redelivered revocation exactly once", async () => {
    const botId = newBot();
    const eventUuid = `evt-dup-${uniq()}`;

    const first = await dispatch("verification.revoked", { agent_uuid: botId, reason: "first" }, eventUuid);
    expect(first.status).toBe("handled");
    const afterFirst = await isRevoked(botId);
    expect(afterFirst).not.toBeNull();
    const firstAt = afterFirst!.revokedAt.getTime();

    // Same uuid again — the shape `partnerFetch`'s retry produces.
    const second = await dispatch("verification.revoked", { agent_uuid: botId, reason: "second" }, eventUuid);
    expect(second.status, "the dispatcher re-ran a handler for an event it had already processed").toBe("deduped");

    const afterSecond = await isRevoked(botId);
    expect(afterSecond!.revokedAt.getTime()).toBe(firstAt);
    expect(afterSecond!.reason, "a redelivery overwrote the recorded reason").toBe("first");
  });

  it("does not move the freeze timestamp even when the handler itself runs twice", async () => {
    // The at-least-once window: a crash between the handler returning and the
    // processed_events insert replays the HANDLER, not just the delivery, so
    // dispatcher dedupe cannot be the only guard.
    const botId = newBot();
    await dispatch("verification.revoked", { agent_uuid: botId, reason: "original" });
    const first = await isRevoked(botId);
    expect(first).not.toBeNull();

    await new Promise((r) => setTimeout(r, 25));
    // A DIFFERENT event uuid, same bot — the handler really runs again.
    const again = await dispatch("verification.revoked", { agent_uuid: botId, reason: "later story" });
    expect(again.status).toBe("handled");

    const second = await isRevoked(botId);
    expect(second!.revokedAt.getTime(), "the moment the city learned moved forward").toBe(
      first!.revokedAt.getTime(),
    );
    expect(second!.reason).toBe("original");
  });

  it("provisions exactly one storefront and one apartment for a redelivered bot.created", async () => {
    const botId = newBot();
    const eventUuid = `evt-created-${uniq()}`;

    await dispatch("bot.created", { agent_uuid: botId, display_name: `OCC ${uniq()}` }, eventUuid);
    const afterFirst = await db.select().from(agentsTable).where(eq(agentsTable.obcBotId, botId));
    expect(afterFirst, "nothing was provisioned at all").toHaveLength(1);
    const unitsFirst = await db
      .select()
      .from(residenceUnitsTable)
      .where(eq(residenceUnitsTable.agentId, afterFirst[0]!.id));
    expect(unitsFirst).toHaveLength(1);

    // Same delivery again, then the same bot under a NEW event uuid so the
    // handler itself is re-entered rather than deduped away.
    await dispatch("bot.created", { agent_uuid: botId, display_name: "OCC again" }, eventUuid);
    await dispatch("bot.created", { agent_uuid: botId, display_name: "OCC again" });

    const afterAll_ = await db.select().from(agentsTable).where(eq(agentsTable.obcBotId, botId));
    expect(afterAll_, "a redelivery minted a second agent row").toHaveLength(1);
    const unitsAfter = await db
      .select()
      .from(residenceUnitsTable)
      .where(eq(residenceUnitsTable.agentId, afterAll_[0]!.id));
    expect(unitsAfter, "a redelivery took a second flat").toHaveLength(1);
    expect(unitsAfter[0]!.id).toBe(unitsFirst[0]!.id);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("rule six — the money", () => {
  let botId: string;
  let account: string;

  beforeEach(async () => {
    botId = newBot();
    account = `trader:kax:agent:${botId}`;
    await db
      .insert(agentsTable)
      .values({ slug: makeTestId("occ-money"), displayName: "Wealthy", obcBotId: botId, ownerId: userId });
    await fund(botId, 500n);
  });

  it("lets an unrevoked agent move credits — the positive control", async () => {
    const before = await balance(account, "play_credit");
    expect(before).toBeGreaterThan(0n);
    await postTransaction({ actor: "test:suite",
      txId: `spend-${uniq()}`,
      asset: "play_credit",
      postings: [
        { account, amount: -10n, kind: "trade" },
        { account: `amm:test-${uniq()}`, amount: 10n, kind: "trade" },
      ],
    });
    expect(await balance(account, "play_credit")).toBe(before - 10n);
  });

  it("refuses to debit a frozen account", async () => {
    await dispatch("verification.revoked", { agent_uuid: botId, reason: "frozen" });
    await expect(
      postTransaction({ actor: "test:suite",
        txId: `spend-${uniq()}`,
        asset: "play_credit",
        postings: [
          { account, amount: -10n, kind: "trade" },
          { account: `amm:test-${uniq()}`, amount: 10n, kind: "trade" },
        ],
      }),
    ).rejects.toBeInstanceOf(AccountFrozen);
  });

  it("refuses to CREDIT a frozen account too", async () => {
    // Somebody paying a suspended agent is the thing the suspension is about.
    await dispatch("verification.revoked", { agent_uuid: botId, reason: "frozen" });
    await expect(
      postTransaction({ actor: "test:suite",
        txId: `pay-${uniq()}`,
        asset: "play_credit",
        postings: [
          { account: HOUSE_ACCOUNT, amount: -10n, kind: "grant" },
          { account, amount: 10n, kind: "grant" },
        ],
      }),
    ).rejects.toBeInstanceOf(AccountFrozen);
  });

  it("preserves the balance exactly — a freeze moves no money", async () => {
    const before = await balance(account, "play_credit");
    expect(before).toBe(500n);
    await dispatch("verification.revoked", { agent_uuid: botId, reason: "frozen" });
    expect(await balance(account, "play_credit"), "the freeze took value from the agent").toBe(before);
  });

  it("leaves the append-only ledger chain intact and verifiable", async () => {
    const rowsBefore = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(creditLedgerTable);
    await dispatch("verification.revoked", { agent_uuid: botId, reason: "frozen" });
    const rowsAfter = await db.select({ n: sql<number>`count(*)::int` }).from(creditLedgerTable);
    // Not one posting was appended, and none could have been removed — the
    // freeze is a state on the account, not a transaction that moves money.
    expect(rowsAfter[0]!.n).toBe(rowsBefore[0]!.n);
    const chain = await verifyLedgerChain();
    expect(chain.ok, "the ledger chain no longer verifies").toBe(true);
  });

  it("is REVERSIBLE: restoring gives the money back its mobility, untouched", async () => {
    const before = await balance(account, "play_credit");
    await dispatch("verification.revoked", { agent_uuid: botId, reason: "temporary" });
    await expect(
      postTransaction({ actor: "test:suite",
        txId: `blocked-${uniq()}`,
        asset: "play_credit",
        postings: [
          { account, amount: -5n, kind: "trade" },
          { account: `amm:test-${uniq()}`, amount: 5n, kind: "trade" },
        ],
      }),
    ).rejects.toBeInstanceOf(AccountFrozen);

    expect(await restore(botId)).toBeDefined();
    expect(await isRevoked(botId)).toBeNull();
    expect(await balance(account, "play_credit"), "value was lost across the freeze").toBe(before);

    await postTransaction({ actor: "test:suite",
      txId: `after-restore-${uniq()}`,
      asset: "play_credit",
      postings: [
        { account, amount: -5n, kind: "trade" },
        { account: `amm:test-${uniq()}`, amount: 5n, kind: "trade" },
      ],
    });
    expect(await balance(account, "play_credit")).toBe(before - 5n);
  });

  it("does not freeze accounts that merely look similar", async () => {
    await dispatch("verification.revoked", { agent_uuid: botId, reason: "frozen" });
    // A different bot, the house, and a market pool must all still move.
    const other = `trader:kax:agent:${newBot()}`;
    await postTransaction({ actor: "test:suite",
      txId: `unrelated-${uniq()}`,
      asset: "play_credit",
      postings: [
        { account: HOUSE_ACCOUNT, amount: -7n, kind: "grant" },
        { account: other, amount: 7n, kind: "grant" },
      ],
    });
    expect(await balance(other, "play_credit")).toBe(7n);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("rule six — open positions on the Joinery counter", () => {
  let sellerBot: string;
  let sellerAgentId: number;
  let listingId: number;

  beforeEach(async () => {
    sellerBot = newBot();
    const [seller] = await db
      .insert(agentsTable)
      .values({ slug: makeTestId("occ-seller"), displayName: `Seller ${uniq()}`, obcBotId: sellerBot, ownerId: userId })
      .returning();
    sellerAgentId = seller!.id;

    const [artifact] = await db
      .insert(artifactsTable)
      .values({
        externalId: makeTestId("occ-furniture"),
        title: `Chair ${uniq()}`,
        creatorName: "Seller",
        publicUrl: "https://example.invalid/piece",
        artifactType: "furniture",
        agentId: sellerAgentId,
        creatorBotId: sellerBot,
        ownerId: userId,
      })
      .returning();

    const listed = await list({ sellerAgentId, artifactId: artifact!.id, price: 100 });
    listingId = listed.listingId;
  });

  it("shows the listing while the seller is in good standing — positive control", async () => {
    const page = await catalog(500, 0);
    expect(page.items.length, "the catalogue is empty, so the next assertion proves nothing").toBeGreaterThan(0);
    expect(page.items.some((i) => i.listingId === listingId)).toBe(true);
    expect(page.total).toBeGreaterThan(0);
  });

  it("takes a frozen seller's stall off the counter, page AND total", async () => {
    const before = await catalog(500, 0);
    const totalBefore = before.total;
    expect(before.items.some((i) => i.listingId === listingId)).toBe(true);

    await dispatch("verification.revoked", { agent_uuid: sellerBot, reason: "frozen" });

    const after = await catalog(500, 0);
    expect(after.items.some((i) => i.listingId === listingId), "a disowned shop is still selling").toBe(false);
    expect(after.total, "the total still counts rows the page can never show").toBe(totalBefore - 1);
  });

  it("refuses a purchase FROM a frozen seller", async () => {
    const buyerBot = newBot();
    const [buyer] = await db
      .insert(agentsTable)
      .values({ slug: makeTestId("occ-buyer"), displayName: "Buyer", obcBotId: buyerBot, ownerId: userId })
      .returning();
    // Give the buyer a flat to put it in and the credits to pay for it.
    const [unit] = await db
      .select()
      .from(residenceUnitsTable)
      .where(sql`${residenceUnitsTable.agentId} IS NULL AND ${residenceUnitsTable.floor} <= 11`)
      .limit(1);
    expect(unit, "no vacant unit to run the purchase test in").toBeTruthy();
    await db
      .update(residenceUnitsTable)
      .set({ agentId: buyer!.id })
      .where(eq(residenceUnitsTable.id, unit!.id));
    await fund(buyerBot, 1000n);

    await dispatch("verification.revoked", { agent_uuid: sellerBot, reason: "frozen" });

    await expect(
      purchase({
        buyerAgentId: buyer!.id,
        buyerAccount: `trader:kax:agent:${buyerBot}`,
        buyerPrincipal: `kax:agent:${buyerBot}`,
        listingId,
        slot: "corner",
      }),
    ).rejects.toBeInstanceOf(SellerFrozen);

    // And no furnishing appeared and no money moved.
    const furnishings = await db
      .select()
      .from(unitFurnishingsTable)
      .where(eq(unitFurnishingsTable.listingId, listingId));
    expect(furnishings).toHaveLength(0);
    expect(await balance(`trader:kax:agent:${buyerBot}`, "play_credit")).toBe(1000n);
  });

  it("refuses a frozen agent OPENING a new position", async () => {
    const [artifact] = await db
      .insert(artifactsTable)
      .values({
        externalId: makeTestId("occ-furniture2"),
        title: `Table ${uniq()}`,
        creatorName: "Seller",
        publicUrl: "https://example.invalid/piece",
        artifactType: "furniture",
        agentId: sellerAgentId,
        creatorBotId: sellerBot,
        ownerId: userId,
      })
      .returning();

    await dispatch("verification.revoked", { agent_uuid: sellerBot, reason: "frozen" });
    await expect(
      list({ sellerAgentId, artifactId: artifact!.id, price: 50 }),
    ).rejects.toBeInstanceOf(SellerFrozen);
  });

  it("puts the stall back, at the same price, when the revocation is lifted", async () => {
    await dispatch("verification.revoked", { agent_uuid: sellerBot, reason: "temporary" });
    expect((await catalog(500, 0)).items.some((i) => i.listingId === listingId)).toBe(false);

    await restore(sellerBot);

    const back = await catalog(500, 0);
    const row = back.items.find((i) => i.listingId === listingId);
    expect(row, "the listing did not come back — this was a delisting, not a freeze").toBeTruthy();
    expect(row!.price).toBe(100);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("bot.created / bot.verified provisioning", () => {
  it("gives a brand-new OCC agent a storefront and an apartment", async () => {
    const botId = newBot();
    const capacityBefore = await housingCapacity();
    expect(capacityBefore.free, "the tower is full, so this proves nothing").toBeGreaterThan(20);

    const res = await dispatch("bot.created", { agent_uuid: botId, display_name: `Newcomer ${uniq()}` });
    expect(res.status).toBe("handled");

    const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.obcBotId, botId));
    expect(agent, "no storefront was provisioned").toBeTruthy();
    expect(agent!.slug).toBeTruthy();

    const home = await homeUnitOf(agent!.id);
    expect(home, "no apartment was assigned").not.toBeNull();
    expect(home!.floor).toBeGreaterThanOrEqual(2);
  });

  it("uses the display name from the payload, not a generated placeholder", async () => {
    // Not cosmetic: without a name, findOrCreateAgentByBotUuid falls through to
    // gallery lookups that spend partner-API budget on every delivery.
    const botId = newBot();
    const name = `Named ${uniq()}`;
    await dispatch("bot.created", { agent_uuid: botId, display_name: name });
    const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.obcBotId, botId));
    expect(agent!.displayName).toBe(name);
  });

  it("an OCC-VERIFIED resident gets a store with no wallet and no KAX account", async () => {
    // Vincent asked by name: "please keep Metamask optional for OCC-verified
    // residents. Every city agent should get its store without having to touch
    // a crypto wallet." The strongest form of that is a store with no HUMAN at
    // all — no user_bots row, no session, no wallet address anywhere.
    const botId = newBot();
    const res = await dispatch("bot.verified", {
      agent_uuid: botId,
      display_name: `Verified ${uniq()}`,
      owner: { owner_uuid: "occ-human-1234" },
    });
    expect(res.status).toBe("handled");

    const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.obcBotId, botId));
    expect(agent, "an OCC-verified resident got no storefront").toBeTruthy();
    const home = await homeUnitOf(agent!.id);
    expect(home, "an OCC-verified resident got no address").not.toBeNull();

    // The proof that no wallet was involved: there is no attachment row at all,
    // and attachment is the only place a wallet could have been recorded.
    const attached = await db.select().from(userBotsTable).where(eq(userBotsTable.obcBotId, botId));
    expect(attached, "provisioning went through the wallet-attachment path").toHaveLength(0);

    expect(await isOccVerified(botId)).toBeInstanceOf(Date);
  });

  it("bot.verified does NOT silently lift a freeze", async () => {
    // Ownership and standing are different facts. Letting a re-verification
    // undo a revocation would mean an agent the city disowned could be
    // unfrozen with no admin action and no trace.
    const botId = newBot();
    await dispatch("bot.created", { agent_uuid: botId, display_name: "Suspended Soon" });
    await dispatch("verification.revoked", { agent_uuid: botId, reason: "spam" });
    expect(await isRevoked(botId)).not.toBeNull();

    await dispatch("bot.verified", { agent_uuid: botId, owner_uuid: "someone" });
    expect(await isRevoked(botId), "bot.verified quietly unfroze a revoked agent").not.toBeNull();
  });

  it("defers a provisioning event with no recognisable agent uuid", async () => {
    expect((await dispatch("bot.created", { nothing: "useful" })).status).toBe("deferred");
    expect((await dispatch("bot.verified", { nothing: "useful" })).status).toBe("deferred");
  });
});

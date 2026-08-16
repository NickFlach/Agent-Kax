import { and, desc, eq, isNotNull, or, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  agentsTable,
  artifactsTable,
  residenceUnitsTable,
  storeListingsTable,
  unitFurnishingsTable,
} from "@workspace/db/schema";
import { HOUSE_ACCOUNT } from "./ledger-core";
import { LedgerInsufficientFunds, postTransaction } from "./ledger";
import { InvalidSalePrice, MAX_LIST_PRICE, isSlot, saleTxId, splitSale, type Slot } from "./joinery-core";

/**
 * The Joinery, trading.
 *
 * Until now the showroom displayed real furniture made by real agents and
 * there was nothing you could do about it — a shop you cannot buy from is a
 * gallery, and the credits in the ledger had no sink outside the prediction
 * markets. This is the counter.
 *
 * The order of operations is the whole design. Money moves FIRST, through the
 * ledger, with a deterministic txId; the furnishing row is written after. If
 * the row insert fails, a retry replays the same txId — the ledger returns the
 * original result and applies nothing — and the row is written on the second
 * pass. The reverse order would be much worse: a chair in the room with no
 * receipt, and no way afterwards to tell an unpaid one from a paid one whose
 * transaction was lost.
 */

/** Everything a shopper needs, without a second round trip per piece. */
export interface CatalogItem {
  listingId: number;
  artifactId: number;
  title: string;
  thumbnailUrl: string | null;
  /** Whoever made it. Provenance lives on the artifact and is never rewritten. */
  makerName: string | null;
  /** Whoever is selling it — often, but not always, the maker. */
  sellerAgentId: number;
  sellerName: string;
  /** Minor units. */
  price: number;
  note: string | null;
}

export class ListingNotForSale extends Error {
  readonly code = "not_for_sale";
}
export class NoHomeToFurnish extends Error {
  readonly code = "no_home";
}
export class SlotTaken extends Error {
  readonly code = "slot_taken";
}
export class AlreadyOwned extends Error {
  readonly code = "already_owned";
}
export class SellerCannotBePaid extends Error {
  readonly code = "seller_unpayable";
}
export class NotFurniture extends Error {
  readonly code = "not_furniture";
}
export class BadListPrice extends Error {
  readonly code = "bad_price";
}

/**
 * Furniture listed for sale.
 *
 * A listing with a NULL price is on display, not on sale — the showroom shows
 * it, this does not. Treating unpriced as free would give away other agents'
 * work on the strength of a missing field.
 */
export interface CatalogPage {
  items: CatalogItem[];
  /** Everything on sale, not just this page. */
  total: number;
  truncated: boolean;
}

export async function catalog(limit = 40, offset = 0): Promise<CatalogPage> {
  const rows = await db
    .select({
      listingId: storeListingsTable.id,
      artifactId: artifactsTable.id,
      title: artifactsTable.title,
      thumbnailUrl: artifactsTable.thumbnailUrl,
      makerName: artifactsTable.creatorName,
      sellerAgentId: agentsTable.id,
      sellerName: agentsTable.displayName,
      price: storeListingsTable.price,
      note: storeListingsTable.note,
    })
    .from(storeListingsTable)
    .innerJoin(artifactsTable, eq(storeListingsTable.artifactId, artifactsTable.id))
    .innerJoin(agentsTable, eq(storeListingsTable.storeAgentId, agentsTable.id))
    .where(
      and(
        eq(artifactsTable.artifactType, "furniture"),
        isNotNull(storeListingsTable.price),
        sql`${storeListingsTable.price} > 0`,
      ),
    )
    .orderBy(desc(storeListingsTable.id))
    .limit(Math.min(Math.max(limit, 1), 500))
    .offset(Math.max(offset, 0));

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(storeListingsTable)
    .innerJoin(artifactsTable, eq(storeListingsTable.artifactId, artifactsTable.id))
    .where(
      and(
        eq(artifactsTable.artifactType, "furniture"),
        isNotNull(storeListingsTable.price),
        sql`${storeListingsTable.price} > 0`,
      ),
    );

  return {
    items: rows.map((r) => ({
      ...r,
      // store_listings.price is a real; the ledger deals in integer minor
      // units. Rounding here rather than at the till means the price a buyer
      // is quoted is the price they are charged.
      price: Math.round(r.price ?? 0),
    })),
    total,
    truncated: Math.max(offset, 0) + rows.length < total,
  };
}

export interface ListingInput {
  sellerAgentId: number;
  artifactId: number;
  /** Minor units. Null takes it off sale without unlisting it. */
  price: number | null;
  note?: string | null;
}

export interface ListingResult {
  listingId: number;
  artifactId: number;
  title: string;
  price: number | null;
  /** True when the store was already offering this piece and only the price moved. */
  repriced: boolean;
}

/**
 * Put a piece on sale — or take it off.
 *
 * This exists because the Joinery could be STOCKED only by a signed-in human
 * who owned the store. Eighteen pieces of furniture made by agents were on
 * display in the showroom and not one of them could be sold by the agent that
 * made it, which made the counter a till in front of empty shelves. The city
 * belongs to the agents in it, so an agent prices its own work.
 *
 * A NULL price means on display, not on sale: the showroom keeps showing it
 * and the catalogue stops offering it. Delisting that way rather than deleting
 * the row keeps "this store offers this piece" true, which is what a store
 * listing has always meant here — the piece is still curated, just not priced.
 *
 * A store may list work it did not make. That is what store_listings is for
 * and is why the sale pays a maker's royalty; consignment is a real thing a
 * joinery does. Provenance is never rewritten — the maker stays on the
 * artifact.
 */
export async function list(input: ListingInput): Promise<ListingResult> {
  if (input.price !== null) {
    if (!Number.isInteger(input.price) || input.price <= 0) {
      throw new BadListPrice("price must be a positive whole number of credits, or null to take it off sale");
    }
    if (input.price > MAX_LIST_PRICE) {
      throw new BadListPrice(`price may not exceed ${MAX_LIST_PRICE} credits`);
    }
  }

  const [artifact] = await db
    .select({ id: artifactsTable.id, title: artifactsTable.title, type: artifactsTable.artifactType })
    .from(artifactsTable)
    .where(eq(artifactsTable.id, input.artifactId))
    .limit(1);
  if (!artifact) throw new NotFurniture(`artifact ${input.artifactId} does not exist`);
  if (artifact.type !== "furniture") {
    // The Joinery sells furniture. A song listed here would be bought and then
    // placed in a corner of somebody's flat, which is nobody's intention.
    throw new NotFurniture(`"${artifact.title}" is a ${artifact.type}, and the Joinery sells furniture`);
  }

  // Refused for the same reason a sale is: a seller with no payable account
  // would accumulate a balance nobody can spend, and would find that out only
  // after somebody had paid for something.
  const [seller] = await db
    .select({ obcBotId: agentsTable.obcBotId, displayName: agentsTable.displayName })
    .from(agentsTable)
    .where(eq(agentsTable.id, input.sellerAgentId))
    .limit(1);
  if (!seller) throw new SellerCannotBePaid("no such seller");
  if (!seller.obcBotId) {
    throw new SellerCannotBePaid(`${seller.displayName} has no account to receive credits`);
  }

  const [existing] = await db
    .select({ id: storeListingsTable.id })
    .from(storeListingsTable)
    .where(
      and(
        eq(storeListingsTable.storeAgentId, input.sellerAgentId),
        eq(storeListingsTable.artifactId, input.artifactId),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(storeListingsTable)
      .set({ price: input.price, ...(input.note === undefined ? {} : { note: input.note }) })
      .where(eq(storeListingsTable.id, existing.id));
    return {
      listingId: existing.id,
      artifactId: artifact.id,
      title: artifact.title,
      price: input.price,
      repriced: true,
    };
  }

  const [row] = await db
    .insert(storeListingsTable)
    .values({
      storeAgentId: input.sellerAgentId,
      artifactId: input.artifactId,
      price: input.price,
      note: input.note ?? null,
    })
    .returning({ id: storeListingsTable.id });

  return {
    listingId: row!.id,
    artifactId: artifact.id,
    title: artifact.title,
    price: input.price,
    repriced: false,
  };
}

/**
 * The furniture this agent has made, with the ids needed to sell it.
 *
 * joinery_sell takes an artifactId and nothing in the city would tell an agent
 * what its own artifact ids ARE. The tool validated its input, refused
 * politely, and could not be called correctly by anybody without a browser —
 * which is the one thing the MCP surface exists to prevent. This is the
 * missing first step: what have I made, and what am I already asking for it.
 *
 * Attribution matches the storefront's own rule — the artifact's agent_id, or
 * its creator_bot_id, which survives a rename in a way a display name does not.
 */
export interface WorksPage {
  works: Array<{
    artifactId: number;
    title: string;
    thumbnailUrl: string | null;
    /** What you are currently asking, or null if it is on display only. */
    price: number | null;
    listingId: number | null;
  }>;
  /** Every furniture work this agent has, not just the page returned. */
  total: number;
  /** True when there are more beyond this page. */
  truncated: boolean;
}

export async function worksForSale(
  agent: { id: number; obcBotId: string | null },
  opts: { limit?: number; offset?: number } = {},
): Promise<WorksPage> {
  // A hundred was a number I picked without checking. Kannaka has 282 pieces
  // of furniture, so the tool answered "here is your work" with a bit under
  // two fifths of it and no indication of the rest — the same silent
  // truncation I had just finished fixing in the showroom, reintroduced in the
  // tool I wrote to fix it. A count that looks complete invites no checking,
  // which is exactly why it keeps happening.
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const mine = agent.obcBotId
    ? or(eq(artifactsTable.agentId, agent.id), eq(artifactsTable.creatorBotId, agent.obcBotId))
    : eq(artifactsTable.agentId, agent.id);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(artifactsTable)
    .where(and(mine, eq(artifactsTable.artifactType, "furniture")));

  const rows = await db
    .select({
      artifactId: artifactsTable.id,
      title: artifactsTable.title,
      thumbnailUrl: artifactsTable.thumbnailUrl,
      price: storeListingsTable.price,
      listingId: storeListingsTable.id,
    })
    .from(artifactsTable)
    .leftJoin(
      storeListingsTable,
      and(
        eq(storeListingsTable.artifactId, artifactsTable.id),
        eq(storeListingsTable.storeAgentId, agent.id),
      ),
    )
    .where(and(mine, eq(artifactsTable.artifactType, "furniture")))
    .orderBy(desc(artifactsTable.id))
    .limit(limit)
    .offset(offset);

  return {
    works: rows.map((r) => ({ ...r, price: r.price === null ? null : Math.round(r.price) })),
    total,
    truncated: offset + rows.length < total,
  };
}

/** What this store currently offers, priced or not, so a seller can see it. */
export async function listingsOfAgent(agentId: number): Promise<Array<{
  listingId: number;
  artifactId: number;
  title: string;
  price: number | null;
  note: string | null;
}>> {
  const rows = await db
    .select({
      listingId: storeListingsTable.id,
      artifactId: artifactsTable.id,
      title: artifactsTable.title,
      price: storeListingsTable.price,
      note: storeListingsTable.note,
    })
    .from(storeListingsTable)
    .innerJoin(artifactsTable, eq(storeListingsTable.artifactId, artifactsTable.id))
    .where(eq(storeListingsTable.storeAgentId, agentId))
    .orderBy(desc(storeListingsTable.id));
  return rows.map((r) => ({ ...r, price: r.price === null ? null : Math.round(r.price) }));
}

export interface PurchaseInput {
  /** The buying agent's row id — they must have a home to put it in. */
  buyerAgentId: number;
  /** The ledger account the credits come from. */
  buyerAccount: string;
  listingId: number;
  slot: Slot;
}

export interface PurchaseResult {
  furnishingId: number;
  txId: string;
  price: number;
  slot: Slot;
  /** Where it now stands — the address, which is the stable identity. */
  floor: number;
  letter: string;
  /** True when the ledger replayed rather than moved money again. */
  replayed: boolean;
}

/**
 * Buy a listed piece and put it in the buyer's flat.
 *
 * Refuses, in this order and for these reasons:
 *   - not furniture, or not priced  → nothing to sell
 *   - the buyer has no home         → nowhere to put it; the city should say
 *                                     so plainly rather than take the money
 *   - the slot is occupied          → checked here for a clear error, and
 *                                     again by the unique index for the race
 *   - insufficient funds            → the ledger's own guard, surfaced as-is
 */
export async function purchase(input: PurchaseInput): Promise<PurchaseResult> {
  if (!isSlot(input.slot)) throw new InvalidSalePrice(`unknown slot ${input.slot}`);

  const [listing] = await db
    .select({
      listingId: storeListingsTable.id,
      artifactId: artifactsTable.id,
      price: storeListingsTable.price,
      artifactType: artifactsTable.artifactType,
      makerName: artifactsTable.creatorName,
      makerBotId: artifactsTable.creatorBotId,
      sellerAgentId: agentsTable.id,
      sellerName: agentsTable.displayName,
      sellerObcBotId: agentsTable.obcBotId,
    })
    .from(storeListingsTable)
    .innerJoin(artifactsTable, eq(storeListingsTable.artifactId, artifactsTable.id))
    .innerJoin(agentsTable, eq(storeListingsTable.storeAgentId, agentsTable.id))
    .where(eq(storeListingsTable.id, input.listingId))
    .limit(1);

  if (!listing) throw new ListingNotForSale(`listing ${input.listingId} does not exist`);
  if (listing.artifactType !== "furniture") {
    throw new ListingNotForSale(`listing ${input.listingId} is not furniture`);
  }
  const price = Math.round(listing.price ?? 0);
  if (!(price > 0)) throw new ListingNotForSale(`listing ${input.listingId} is on display, not on sale`);

  // A furnishing is a fact about a ROOM. No room, no purchase — and saying so
  // before the money moves is the difference between a clear refusal and a
  // refund nobody knows to ask for.
  const [home] = await db
    .select({ floor: residenceUnitsTable.floor, letter: residenceUnitsTable.letter })
    .from(residenceUnitsTable)
    .where(eq(residenceUnitsTable.agentId, input.buyerAgentId))
    .limit(1);
  if (!home) throw new NoHomeToFurnish("the buyer has no unit to furnish");

  const existing = await db
    .select({ slot: unitFurnishingsTable.slot, artifactId: unitFurnishingsTable.artifactId })
    .from(unitFurnishingsTable)
    .where(and(eq(unitFurnishingsTable.floor, home.floor), eq(unitFurnishingsTable.letter, home.letter)));
  if (existing.some((f) => f.artifactId === listing.artifactId)) {
    throw new AlreadyOwned("that piece is already in this flat");
  }
  if (existing.some((f) => f.slot === input.slot)) {
    throw new SlotTaken(`${input.slot} already holds something`);
  }

  // Who made it, as an ACCOUNT rather than as a name.
  //
  // creator_name is the only link an artifact keeps to its maker, and it is
  // free text. Paying a royalty to `maker:<that text>` would look right in the
  // ledger and be worthless: a balance keyed on a display name that no
  // principal can ever spend from, and that two agents sharing a name would
  // share. That is the same mistake refused below for the seller, so it is
  // refused here too — the royalty is paid only to a maker the city can
  // actually identify.
  //
  // By BOT ID first. creator_bot_id is on the artifact and is the same
  // identifier the storefront uses to decide whose work something is; matching
  // display names was the fallback written before I noticed the column, and it
  // is fragile exactly where it matters — "Mosi Ī˹" is a real maker in this
  // city, and a royalty that depends on reproducing that string is a royalty
  // that will one day quietly not be paid.
  const makerAgent =
    (listing.makerBotId
      ? (
          await db
            .select({ id: agentsTable.id, obcBotId: agentsTable.obcBotId })
            .from(agentsTable)
            .where(eq(agentsTable.obcBotId, listing.makerBotId))
            .limit(1)
        )[0]
      : undefined) ??
    (listing.makerName
      ? (
          await db
            .select({ id: agentsTable.id, obcBotId: agentsTable.obcBotId })
            .from(agentsTable)
            .where(sql`lower(${agentsTable.displayName}) = ${listing.makerName.trim().toLowerCase()}`)
            .limit(1)
        )[0] ?? null
      : null);

  // Resolving by row id when we can beats comparing names: a store that
  // renamed itself would otherwise start paying itself a royalty.
  const sellerIsMaker = makerAgent
    ? makerAgent.id === listing.sellerAgentId
    : !!listing.makerName &&
      listing.makerName.trim().toLowerCase() === (listing.sellerName ?? "").trim().toLowerCase();

  // An agent with no OBC bot id has no canonical principal, so there is no
  // account to credit. Refusing is the only honest option: the alternative is
  // paying "trader:kax:agent:null", which is a real account balance nobody can
  // ever spend and which no error would mention.
  if (!listing.sellerObcBotId) {
    throw new SellerCannotBePaid(`${listing.sellerName} has no account to receive credits`);
  }

  const split = splitSale(BigInt(price), sellerIsMaker);
  const txId = saleTxId(listing.listingId, input.buyerAccount);
  const ref = `joinery sale: listing ${listing.listingId}`;

  const postings = [
    { account: input.buyerAccount, amount: -split.price, kind: "joinery", ref },
    { account: `trader:kax:agent:${listing.sellerObcBotId}`, amount: split.seller, kind: "joinery", ref },
    { account: HOUSE_ACCOUNT, amount: split.house, kind: "joinery_fee", ref },
  ];
  // A zero posting is not a payment and clutters the chain — the maker's line
  // only exists when there is a royalty AND somebody real to receive it.
  if (split.maker > 0n && makerAgent?.obcBotId) {
    postings.push({
      account: `trader:kax:agent:${makerAgent.obcBotId}`,
      amount: split.maker,
      kind: "joinery_royalty",
      ref,
    });
  } else if (split.maker > 0n) {
    // The maker is not an agent here — a name on an imported piece, or one
    // that has never been seen in OBC. The royalty cannot be parked in an
    // account nobody can spend, and it cannot vanish without unbalancing the
    // transaction, so it goes to the seller, who at least sold it.
    postings[1]!.amount += split.maker;
  }
  // The house cut can round to zero on a very cheap piece. An empty posting
  // helps nobody and the ledger requires every amount to be meaningful.
  const live = postings.filter((p) => p.amount !== 0n);

  const posted = await postTransaction({ txId, asset: "play_credit", postings: live });

  const [row] = await db
    .insert(unitFurnishingsTable)
    .values({
      floor: home.floor,
      letter: home.letter,
      artifactId: listing.artifactId,
      listingId: listing.listingId,
      slot: input.slot,
      pricePaid: price,
      txId,
    })
    .onConflictDoNothing()
    .returning({ id: unitFurnishingsTable.id });

  // onConflictDoNothing returns nothing when a concurrent request won the
  // slot. The money is already posted under a txId that will not double-spend,
  // so read back what is actually there rather than inventing a row id.
  let furnishingId = row?.id ?? null;
  if (furnishingId === null) {
    const [mine] = await db
      .select({ id: unitFurnishingsTable.id })
      .from(unitFurnishingsTable)
      .where(
        and(
          eq(unitFurnishingsTable.floor, home.floor),
          eq(unitFurnishingsTable.letter, home.letter),
          eq(unitFurnishingsTable.artifactId, listing.artifactId),
        ),
      )
      .limit(1);
    if (!mine) throw new SlotTaken(`${input.slot} was taken while the sale was settling`);
    furnishingId = mine.id;
  }

  return {
    furnishingId,
    txId: posted.txId,
    price,
    slot: input.slot,
    floor: home.floor,
    letter: home.letter,
    replayed: posted.idempotentReplay,
  };
}

export interface Furnishing {
  id: number;
  artifactId: number;
  slot: string;
  title: string;
  thumbnailUrl: string | null;
  makerName: string | null;
  pricePaid: number;
  acquiredAt: Date;
}

/** What is standing in a flat. Public — a room is seen by whoever is in it. */
export async function furnishingsOfUnit(floor: number, letter: string): Promise<Furnishing[]> {
  const rows = await db
    .select({
      id: unitFurnishingsTable.id,
      artifactId: unitFurnishingsTable.artifactId,
      slot: unitFurnishingsTable.slot,
      title: artifactsTable.title,
      thumbnailUrl: artifactsTable.thumbnailUrl,
      makerName: artifactsTable.creatorName,
      pricePaid: unitFurnishingsTable.pricePaid,
      acquiredAt: unitFurnishingsTable.acquiredAt,
    })
    .from(unitFurnishingsTable)
    .innerJoin(artifactsTable, eq(unitFurnishingsTable.artifactId, artifactsTable.id))
    .where(and(eq(unitFurnishingsTable.floor, floor), eq(unitFurnishingsTable.letter, letter)))
    .orderBy(unitFurnishingsTable.slot);
  return rows;
}

export { LedgerInsufficientFunds };

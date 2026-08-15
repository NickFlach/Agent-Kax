import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
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
import { InvalidSalePrice, isSlot, saleTxId, splitSale, type Slot } from "./joinery-core";

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

/**
 * Furniture listed for sale.
 *
 * A listing with a NULL price is on display, not on sale — the showroom shows
 * it, this does not. Treating unpriced as free would give away other agents'
 * work on the strength of a missing field.
 */
export async function catalog(limit = 40): Promise<CatalogItem[]> {
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
    .limit(limit);

  return rows.map((r) => ({
    ...r,
    // store_listings.price is a real; the ledger deals in integer minor units.
    // Rounding here rather than at the till means the price a buyer is quoted
    // is the price they are charged.
    price: Math.round(r.price ?? 0),
  }));
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
  const makerAgent = listing.makerName
    ? (
        await db
          .select({ id: agentsTable.id, obcBotId: agentsTable.obcBotId })
          .from(agentsTable)
          .where(sql`lower(${agentsTable.displayName}) = ${listing.makerName.trim().toLowerCase()}`)
          .limit(1)
      )[0] ?? null
    : null;

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

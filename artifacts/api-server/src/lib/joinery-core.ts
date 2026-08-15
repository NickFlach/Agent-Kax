/**
 * Pure, DB-free core of a Joinery sale.
 *
 * A piece of furniture in this city has two people behind it and they are
 * often not the same person: whoever MADE it, and whoever is SELLING it. A
 * storefront may stock another agent's work — that is the whole point of
 * store_listings — so a sale that paid only the seller would quietly make
 * reselling somebody else's chair more profitable than making one.
 *
 * So a sale splits three ways: the house takes its cut, the maker takes a
 * royalty when the seller is not the maker, and the seller takes the rest.
 * When seller and maker are the same agent the royalty is not paid to a second
 * account — it stays with them, which is the same number by a shorter route.
 *
 * The arithmetic lives here, alone, because the invariant that matters is not
 * "the percentages look right" but "the parts sum to the price, exactly, at
 * every price including the small awkward ones". Integer division sheds
 * remainders; three roundings at 1 credit would pay out zero and post an
 * unbalanced transaction that the ledger would reject at the door. The seller
 * takes the remainder rather than the house, because the alternative is a fee
 * that silently exceeds its own rate on small sales.
 */

/** The house's cut, in basis points. Matches the market's residual fee. */
export const HOUSE_BPS = 1000;
/** The maker's royalty when the seller did not make the piece. */
export const MAKER_ROYALTY_BPS = 1000;

const BPS = 10_000n;

export interface SaleSplit {
  /** What the buyer pays, in minor units. */
  price: bigint;
  /** The house's cut. */
  house: bigint;
  /** The maker's royalty. Zero when the seller made the piece. */
  maker: bigint;
  /** Everything left over. */
  seller: bigint;
}

export class InvalidSalePrice extends Error {
  readonly code = "invalid_price";
}

/**
 * Split a sale price. `sellerIsMaker` collapses the royalty rather than paying
 * an agent twice.
 *
 * Throws on a price that is not a positive integer: a free piece is a gift and
 * should not travel through a payment path, and a negative one is a refund
 * wearing a sale's clothes. Both deserve their own route if the city ever
 * wants them.
 */
export function splitSale(price: bigint, sellerIsMaker: boolean): SaleSplit {
  if (typeof price !== "bigint") throw new InvalidSalePrice("price must be a bigint of minor units");
  if (price <= 0n) throw new InvalidSalePrice(`price must be positive, got ${price}`);

  const house = (price * BigInt(HOUSE_BPS)) / BPS;
  const maker = sellerIsMaker ? 0n : (price * BigInt(MAKER_ROYALTY_BPS)) / BPS;
  const seller = price - house - maker;

  // Not an assertion about rates — an assertion about conservation. If this
  // ever fires the ledger would have rejected the transaction anyway, but it
  // would have done so from inside a request with a half-written furnishing.
  if (house + maker + seller !== price) {
    throw new Error(`sale split does not conserve: ${house}+${maker}+${seller} != ${price}`);
  }
  if (seller <= 0n) {
    throw new InvalidSalePrice(`price ${price} is too small to pay the seller anything`);
  }

  return { price, house, maker, seller };
}

/**
 * The ledger txId for a sale.
 *
 * Deterministic in the listing and the buyer so a retried request — a dropped
 * response, an agent that fires twice, a browser that double-submits — replays
 * idempotently instead of buying the same chair a second time. The furnishing
 * row's unique index says the same thing at the other end; this says it before
 * any money moves.
 */
export function saleTxId(listingId: number, buyerAccount: string): string {
  return `joinery:${listingId}:${buyerAccount}`;
}

/** Where a piece can stand in a studio flat. */
export const SLOTS = ["wall_left", "wall_right", "corner", "bedside", "window"] as const;
export type Slot = (typeof SLOTS)[number];

export function isSlot(v: unknown): v is Slot {
  return typeof v === "string" && (SLOTS as readonly string[]).includes(v);
}

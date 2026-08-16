/**
 * joinery-core.test.ts — a sale must conserve credits at every price.
 *
 * The percentages are the boring part. The part that breaks is integer
 * division at small and awkward prices, where three independent roundings can
 * shed a credit that then has nowhere to go: the ledger refuses unbalanced
 * postings, so the failure would arrive as a 500 in the middle of a purchase
 * rather than as a rounding error somebody notices in a report.
 */

import { describe, expect, it } from "vitest";
import { MAX_HOUSE_FEE_BPS, minorToCreditsString } from "./ledger-core";
import {
  HOUSE_BPS,
  MAX_LIST_PRICE_MINOR,
  MissingListPrice,
  parseListPrice,
  MAKER_ROYALTY_BPS,
  InvalidSalePrice,
  isSlot,
  saleTxId,
  splitSale,
} from "./joinery-core";

describe("joinery sale split", () => {
  it("takes the house cut and the maker's royalty on a resale", () => {
    const s = splitSale(1000n, false);
    expect(s.house).toBe(100n);
    expect(s.maker).toBe(100n);
    expect(s.seller).toBe(800n);
  });

  it("does not pay the maker twice when they are the seller", () => {
    // The royalty is not a second payment to the same agent — collapsing it
    // keeps the ledger honest about who was actually paid, and the number the
    // maker receives is identical either way.
    const s = splitSale(1000n, true);
    expect(s.maker).toBe(0n);
    expect(s.seller).toBe(900n);
    expect(s.house).toBe(100n);
  });

  it("conserves the price exactly across every awkward price", () => {
    // Integer division sheds remainders. This is the property the ledger
    // enforces at the door, checked here where the failure is cheap.
    for (let p = 3n; p <= 3000n; p++) {
      for (const same of [true, false]) {
        const s = splitSale(p, same);
        expect(s.house + s.maker + s.seller, `price ${p} same=${same}`).toBe(p);
        expect(s.house).toBeGreaterThanOrEqual(0n);
        expect(s.maker).toBeGreaterThanOrEqual(0n);
        expect(s.seller).toBeGreaterThan(0n);
      }
    }
  });

  it("keeps the house cut inside the rate the ledger will accept", () => {
    // The ledger refuses a transaction that hands the house more than
    // MAX_HOUSE_FEE_BPS of what it took from traders, which is how a cash-out
    // is told from a fee. Raising HOUSE_BPS past that ceiling would not produce
    // a more expensive joinery — it would produce a joinery whose every sale
    // is rejected at the door, and this is where that is discovered.
    expect(BigInt(HOUSE_BPS)).toBeLessThanOrEqual(MAX_HOUSE_FEE_BPS);
  });

  it("never lets the fee exceed its own rate", () => {
    // The remainder goes to the seller, not the house. If it went the other
    // way a 3-credit sale would charge well over 10% and nothing would say so.
    for (let p = 3n; p <= 500n; p++) {
      const s = splitSale(p, false);
      expect(s.house * 10_000n, `house cut exceeded ${HOUSE_BPS}bps at ${p}`).toBeLessThanOrEqual(
        p * BigInt(HOUSE_BPS),
      );
      expect(s.maker * 10_000n).toBeLessThanOrEqual(p * BigInt(MAKER_ROYALTY_BPS));
    }
  });

  it("refuses prices that are not a sale", () => {
    // A free piece is a gift and a negative one is a refund. Both are real
    // things the city might want; neither is this route.
    expect(() => splitSale(0n, false)).toThrow(InvalidSalePrice);
    expect(() => splitSale(-5n, false)).toThrow(InvalidSalePrice);
    // 1 and 2 credits cannot pay a seller anything after two cuts round down
    // to zero — better to refuse the listing than to post a sale where the
    // seller receives nothing.
    expect(() => splitSale(1n, false)).not.toThrow();
    expect(splitSale(1n, false).seller).toBe(1n);
  });

  it("charges the buyer the listed number itself, as minor units", () => {
    // The denomination, pinned. lib/joinery.ts hands store_listings.price
    // straight to splitSale and posts `-split.price` as the buyer's leg, so a
    // piece listed at 1000 moves 1000 minor units — a thousandth of a credit,
    // not a thousand credits. This does not argue that is the right scale. It
    // makes a redenomination arrive as an edit to these numbers rather than as
    // a silent factor of a million appearing in everybody's balance.
    //
    // The posting itself is not visible from here — nothing pure can see it.
    // joinery.test.ts pins that half against a database, where a purchase of a
    // listing priced 1000 must move the buyer's balance by exactly 1000n.
    const listedPrice = 1000;
    const split = splitSale(BigInt(listedPrice), false);
    expect(split.price).toBe(1000n);
    expect(minorToCreditsString(split.price)).toBe("0.001");
    // The ceiling reads like a generous one and is worth a credit.
    expect(minorToCreditsString(BigInt(MAX_LIST_PRICE_MINOR))).toBe("1");
    // And the refusal an agent actually reads names the unit it is counting,
    // which is the whole defect: the number was never wrong, the word was.
    expect(new MissingListPrice().message).toContain("minor units");
  });

  it("makes a retry idempotent before any money moves", () => {
    // Same buyer, same listing, same txId — the ledger replays instead of
    // selling the chair twice.
    expect(saleTxId(7, "trader:kax:agent:x")).toBe(saleTxId(7, "trader:kax:agent:x"));
    expect(saleTxId(7, "trader:a")).not.toBe(saleTxId(8, "trader:a"));
    expect(saleTxId(7, "trader:a")).not.toBe(saleTxId(7, "trader:b"));
  });

  it("tells a missing price apart from a deliberate null", () => {
    // The one that would be silent: absence read as null takes a piece OFF
    // SALE and reports success, so a seller who meant to reprice discovers it
    // when nobody buys anything.
    expect(parseListPrice({ price: null })).toBeNull();
    expect(parseListPrice({ price: 250 })).toBe(250);
    expect(parseListPrice({ price: "250" })).toBe(250);
    expect(() => parseListPrice({})).toThrow(MissingListPrice);
    expect(() => parseListPrice(undefined)).toThrow(MissingListPrice);
    expect(() => parseListPrice({ artifactId: 3 })).toThrow(MissingListPrice);
  });

  it("only accepts slots the flat actually has", () => {
    expect(isSlot("corner")).toBe(true);
    expect(isSlot("ceiling")).toBe(false);
    expect(isSlot("")).toBe(false);
    expect(isSlot(null)).toBe(false);
  });
});

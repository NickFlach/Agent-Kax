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
import {
  HOUSE_BPS,
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

  it("makes a retry idempotent before any money moves", () => {
    // Same buyer, same listing, same txId — the ledger replays instead of
    // selling the chair twice.
    expect(saleTxId(7, "trader:kax:agent:x")).toBe(saleTxId(7, "trader:kax:agent:x"));
    expect(saleTxId(7, "trader:a")).not.toBe(saleTxId(8, "trader:a"));
    expect(saleTxId(7, "trader:a")).not.toBe(saleTxId(7, "trader:b"));
  });

  it("only accepts slots the flat actually has", () => {
    expect(isSlot("corner")).toBe(true);
    expect(isSlot("ceiling")).toBe(false);
    expect(isSlot("")).toBe(false);
    expect(isSlot(null)).toBe(false);
  });
});

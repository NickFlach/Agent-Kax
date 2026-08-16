/**
 * ledger-core.test.ts — the peg, pinned.
 *
 * These constants are the denomination of every balance the ledger has ever
 * recorded. No migration can reinterpret history, so this file exists to make
 * a change to them arrive as a failing test that has to be argued for, rather
 * than as a quiet edit that passes CI.
 *
 * Needs no DATABASE_URL: ledger-core imports nothing from @workspace/db.
 */

import { describe, expect, it } from "vitest";
import {
  CREDITS_PER_USDC,
  HOUSE_ACCOUNT,
  MINOR_UNITS_PER_CREDIT,
  MINOR_UNITS_PER_USDC,
  accountClass,
  creditsToMinor,
  minorToCreditsString,
  validatePostings,
  type Posting,
} from "./ledger-core";
import { splitSale } from "./joinery-core";

describe("the peg", () => {
  it("is exactly 1 USDC = 100 credits = 100,000,000 minor units", () => {
    // Changing any of these three literals is a DECISION, not a refactor: it
    // redenominates every existing balance. See issue #181 decision 3, which
    // locks the peg for the lifetime of the ledger.
    expect(MINOR_UNITS_PER_CREDIT).toBe(1_000_000n);
    expect(CREDITS_PER_USDC).toBe(100n);
    expect(MINOR_UNITS_PER_USDC).toBe(100_000_000n);
  });

  it("keeps the derived USDC scale consistent with its two factors", () => {
    expect(MINOR_UNITS_PER_USDC).toBe(MINOR_UNITS_PER_CREDIT * CREDITS_PER_USDC);
    expect(creditsToMinor(CREDITS_PER_USDC)).toBe(MINOR_UNITS_PER_USDC);
  });
});

describe("creditsToMinor", () => {
  it("scales whole credits up to minor units", () => {
    expect(creditsToMinor(0n)).toBe(0n);
    expect(creditsToMinor(1n)).toBe(1_000_000n);
    // The signup grant, which routes/identity.ts states this same way.
    expect(creditsToMinor(100n)).toBe(100_000_000n);
  });

  it("scales negative amounts, because the house account funds grants", () => {
    expect(creditsToMinor(-100n)).toBe(-100_000_000n);
  });
});

describe("minorToCreditsString", () => {
  it("renders a whole number of credits without a fractional part", () => {
    expect(minorToCreditsString(100_000_000n)).toBe("100");
    expect(minorToCreditsString(1_000_000n)).toBe("1");
    expect(minorToCreditsString(0n)).toBe("0");
  });

  it("renders the smallest representable amount exactly", () => {
    expect(minorToCreditsString(1n)).toBe("0.000001");
    expect(minorToCreditsString(999_999n)).toBe("0.999999");
  });

  it("trims trailing zeros but never significant ones", () => {
    expect(minorToCreditsString(1_500_000n)).toBe("1.5");
    expect(minorToCreditsString(1_000_001n)).toBe("1.000001");
    expect(minorToCreditsString(1_000_010n)).toBe("1.00001");
  });

  it("keeps the sign on a negative balance", () => {
    expect(minorToCreditsString(-100_000_000n)).toBe("-100");
    expect(minorToCreditsString(-1n)).toBe("-0.000001");
  });

  it("stays exact above Number.MAX_SAFE_INTEGER", () => {
    // 2^53 + 1 minor units: the first magnitude at which a float division by
    // 1e6 cannot represent the input, let alone the quotient. If the
    // implementation ever reaches for Number(), this is where it shows.
    const minor = 9_007_199_254_740_993n;
    expect(minor).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));

    const rendered = minorToCreditsString(minor);
    expect(rendered).toBe("9007199254.740993");
    // Round-trip: reassembling the digits recovers the input byte for byte,
    // which a lossy conversion could not survive.
    expect(BigInt(rendered.replace(".", ""))).toBe(minor);

    // And the float field the API keeps for backwards compatibility does NOT
    // survive it — the reason creditsExact exists at all.
    expect(String(Number(minor) / Number(MINOR_UNITS_PER_CREDIT))).not.toBe(rendered);
  });
});

// ---------------------------------------------------------------------------
// Permitted posting topology (issue #244).
//
// The first block is the load-bearing half: it reproduces every posting shape
// the server actually builds, so a topology rule that is too strict fails here
// rather than in production. A rule that refuses a shape the code posts today
// is a wrong rule, not a caught bug — the tests below are what says so.
// ---------------------------------------------------------------------------

const BUYER = "trader:kax:agent:8e2f1c4a";
const SELLER = "trader:kax:agent:1d7b93f0";
const MAKER = "trader:kax:agent:c05a6e21";
const POOL = "amm:m_1a2b3c";
const REF = "joinery sale: listing 42";

/**
 * The postings lib/joinery.ts builds for a sale, including its filter of the
 * zero legs. Derived from splitSale rather than transcribed, so a change to
 * the split arrives here as a different shape instead of a stale copy.
 */
function joinerySale(price: bigint, makerAccount: string | null): Posting[] {
  const split = splitSale(price, makerAccount === null);
  const postings: Posting[] = [
    { account: BUYER, amount: -split.price, kind: "joinery", ref: REF },
    { account: SELLER, amount: split.seller, kind: "joinery", ref: REF },
    { account: HOUSE_ACCOUNT, amount: split.house, kind: "joinery_fee", ref: REF },
  ];
  if (split.maker > 0n && makerAccount) {
    postings.push({ account: makerAccount, amount: split.maker, kind: "joinery_royalty", ref: REF });
  }
  return postings.filter((p) => p.amount !== 0n);
}

describe("permitted posting topology: the shapes the server really posts", () => {
  it("permits the signup grant (routes/identity.ts)", () => {
    const amount = creditsToMinor(100n);
    expect(() =>
      validatePostings(
        [
          { account: HOUSE_ACCOUNT, amount: -amount, kind: "grant", ref: "signup grant" },
          { account: "trader:kax:agent:8e2f1c4a", amount, kind: "grant", ref: "signup grant" },
        ],
        "play_credit",
      ),
    ).not.toThrow();
  });

  it("permits /ledger/grant and /ledger/escrow", () => {
    expect(() =>
      validatePostings(
        [
          { account: HOUSE_ACCOUNT, amount: -500n, kind: "grant", ref: null },
          { account: BUYER, amount: 500n, kind: "grant", ref: null },
        ],
        "play_credit",
      ),
    ).not.toThrow();
    expect(() =>
      validatePostings(
        [
          { account: HOUSE_ACCOUNT, amount: -500n, kind: "escrow", ref: null },
          { account: POOL, amount: 500n, kind: "escrow", ref: null },
        ],
        "play_credit",
      ),
    ).not.toThrow();
  });

  it("permits /ledger/trade in both directions", () => {
    expect(() =>
      validatePostings(
        [
          { account: BUYER, amount: -120n, kind: "trade", ref: null },
          { account: POOL, amount: 120n, kind: "trade", ref: null },
        ],
        "play_credit",
      ),
    ).not.toThrow();
    expect(() =>
      validatePostings(
        [
          { account: POOL, amount: -120n, kind: "trade", ref: null },
          { account: BUYER, amount: 120n, kind: "trade", ref: null },
        ],
        "play_credit",
      ),
    ).not.toThrow();
  });

  it("permits /ledger/payout with winners and a residual sweep", () => {
    expect(() =>
      validatePostings(
        [
          { account: POOL, amount: -1000n, kind: "payout", ref: null },
          { account: BUYER, amount: 600n, kind: "payout", ref: null },
          { account: SELLER, amount: 300n, kind: "payout", ref: null },
          { account: HOUSE_ACCOUNT, amount: 100n, kind: "payout", ref: null },
        ],
        "play_credit",
      ),
    ).not.toThrow();
  });

  it("permits the residual-only sweep with NO winners", () => {
    // An upset market can resolve to a side nobody held. The whole pool goes
    // to the house and not one trader is credited — the exact shape rule 1
    // refuses when a TRADER is the one being debited, which is why that rule
    // has to key on who is debited rather than on house being credited.
    expect(() =>
      validatePostings(
        [
          { account: POOL, amount: -1000n, kind: "payout", ref: null },
          { account: HOUSE_ACCOUNT, amount: 1000n, kind: "payout", ref: null },
        ],
        "play_credit",
      ),
    ).not.toThrow();
  });

  it("permits the 3-leg joinery sale (the seller made the piece)", () => {
    const postings = joinerySale(1000n, null);
    expect(postings).toHaveLength(3);
    expect(() => validatePostings(postings, "play_credit")).not.toThrow();
  });

  it("permits the 4-leg joinery sale (a royalty to a different maker)", () => {
    const postings = joinerySale(1000n, MAKER);
    expect(postings).toHaveLength(4);
    expect(() => validatePostings(postings, "play_credit")).not.toThrow();
  });

  it("permits a sale so cheap the house fee rounds away, leaving trader->trader only", () => {
    // At 9 minor units the house's 1000bps is 0 after integer division, so
    // lib/joinery.ts filters the fee leg out entirely. What is left is two
    // traders and nothing else — indistinguishable in shape from the P2P
    // transfer decision 5 forbids, and legitimate anyway.
    const split = splitSale(9n, true);
    expect(split.house, "pick a price whose house cut actually rounds to zero").toBe(0n);

    const postings = joinerySale(9n, null);
    expect(postings).toHaveLength(2);
    expect(postings.every((p) => accountClass(p.account) === "trader")).toBe(true);
    expect(() => validatePostings(postings, "play_credit")).not.toThrow();
  });
});

describe("permitted posting topology: what it refuses", () => {
  it("refuses a redemption: a trader debited, the house credited", () => {
    expect(() =>
      validatePostings(
        [
          { account: BUYER, amount: -100n, kind: "redeem", ref: null },
          { account: HOUSE_ACCOUNT, amount: 100n, kind: "redeem", ref: null },
        ],
        "play_credit",
      ),
    ).toThrow(/kind 'redeem' is not a permitted posting kind/);
  });

  it("refuses a cash-out wearing a joinery sale's kinds", () => {
    // The sharper version of the same attack: every kind here is permitted and
    // every account class is on a side the table allows, so ONLY the
    // no-redemption rule stands between a trader and the house's value. A
    // 100%-fee "sale" pays no seller, which is what makes it a redemption.
    expect(() =>
      validatePostings(
        [
          { account: BUYER, amount: -100n, kind: "joinery", ref: REF },
          { account: HOUSE_ACCOUNT, amount: 100n, kind: "joinery_fee", ref: REF },
        ],
        "play_credit",
      ),
    ).toThrow(/no redemption/);
  });

  it("refuses a cash-out that pays the debited trader a token unit back", () => {
    // The sharpest version. Asking "was any trader credited?" is satisfied by
    // one minor unit returned to the very account being drained, so the shape
    // below moves 99 of every 100 to the house while looking like a sale with
    // an unusually generous fee. Only the rate says otherwise.
    expect(() =>
      validatePostings(
        [
          { account: BUYER, amount: -100n, kind: "joinery", ref: REF },
          { account: BUYER, amount: 1n, kind: "joinery", ref: REF },
          { account: HOUSE_ACCOUNT, amount: 99n, kind: "joinery_fee", ref: REF },
        ],
        "play_credit",
      ),
    ).toThrow(/no redemption: 99 to account class 'house' out of 100/);

    // Routing the kickback to a SECOND trader does not help either — it is the
    // house's share of the debit that is bounded, not who received the rest.
    expect(() =>
      validatePostings(
        [
          { account: BUYER, amount: -100n, kind: "joinery", ref: REF },
          { account: SELLER, amount: 1n, kind: "joinery", ref: REF },
          { account: HOUSE_ACCOUNT, amount: 99n, kind: "joinery_fee", ref: REF },
        ],
        "play_credit",
      ),
    ).toThrow(/no redemption/);
  });

  it("refuses a fee one basis point over the rate, and permits one exactly on it", () => {
    // The boundary, because a ceiling nobody tests is a ceiling that gets an
    // off-by-one. 1000 out of 10000 is exactly MAX_HOUSE_FEE_BPS and is what
    // every joinery sale posts; 1001 is not a fee.
    expect(() =>
      validatePostings(
        [
          { account: BUYER, amount: -10_000n, kind: "joinery", ref: REF },
          { account: SELLER, amount: 9_000n, kind: "joinery", ref: REF },
          { account: HOUSE_ACCOUNT, amount: 1_000n, kind: "joinery_fee", ref: REF },
        ],
        "play_credit",
      ),
    ).not.toThrow();
    expect(() =>
      validatePostings(
        [
          { account: BUYER, amount: -10_000n, kind: "joinery", ref: REF },
          { account: SELLER, amount: 8_999n, kind: "joinery", ref: REF },
          { account: HOUSE_ACCOUNT, amount: 1_001n, kind: "joinery_fee", ref: REF },
        ],
        "play_credit",
      ),
    ).toThrow(/no redemption/);
  });

  it("refuses a P2P transfer outright: `transfer` is not a posting kind", () => {
    expect(() =>
      validatePostings(
        [
          { account: BUYER, amount: -100n, kind: "transfer", ref: null },
          { account: SELLER, amount: 100n, kind: "transfer", ref: null },
        ],
        "play_credit",
      ),
    ).toThrow(/kind 'transfer' is not a permitted posting kind/);
  });

  it("refuses a P2P transfer that calls itself a trade", () => {
    // The kind IS permitted here, and trader is on both sides of its row
    // because either side may be the debited one. Refusing this needs the
    // whole-transaction rule: a trade without a pool in it is two agents
    // moving a balance sideways with a market's name on the paperwork.
    expect(() =>
      validatePostings(
        [
          { account: BUYER, amount: -100n, kind: "trade", ref: null },
          { account: SELLER, amount: 100n, kind: "trade", ref: null },
        ],
        "play_credit",
      ),
    ).toThrow(/kind 'trade' must exchange value between a trader and a market pool/);

    // And a pool cannot be smuggled in as a rounding leg: the classes on each
    // side are what is checked, so one unit to the AMM does not make it a trade.
    expect(() =>
      validatePostings(
        [
          { account: BUYER, amount: -100n, kind: "trade", ref: null },
          { account: SELLER, amount: 99n, kind: "trade", ref: null },
          { account: POOL, amount: 1n, kind: "trade", ref: null },
        ],
        "play_credit",
      ),
    ).toThrow(/kind 'trade' must exchange value between a trader and a market pool/);
  });

  it("still permits a joinery sale between two traders, because that one is real", () => {
    // The counterpart to the rule above, and the reason it is stated for
    // `trade` alone. A piece cheap enough for the house cut to round to zero
    // posts trader -> trader and nothing else. It is indistinguishable in
    // shape from a P2P transfer and it is a legitimate sale, so decision 5 is
    // enforced on `trade` and on the ABSENCE of a `transfer` kind — not on the
    // shape of a two-trader posting in general.
    expect(() =>
      validatePostings(
        [
          { account: BUYER, amount: -9n, kind: "joinery", ref: REF },
          { account: SELLER, amount: 9n, kind: "joinery", ref: REF },
        ],
        "play_credit",
      ),
    ).not.toThrow();
  });

  it("refuses an account class that is not in the table", () => {
    // `merchant:1` is not a hostile string — it is the shape of the next
    // account class somebody adds. Until it is added here it is refused, which
    // is also what stops a typo becoming a balance nobody can spend.
    expect(accountClass("merchant:1")).toBe("unknown");
    expect(() =>
      validatePostings(
        [
          { account: HOUSE_ACCOUNT, amount: -100n, kind: "grant", ref: null },
          { account: "merchant:1", amount: 100n, kind: "grant", ref: null },
        ],
        "play_credit",
      ),
    ).toThrow(/merchant:1.*'unknown'/);
  });

  it("names the offending kind and account class when a side is wrong", () => {
    // A grant may only credit a trader, so minting straight into a pool is
    // refused even though both classes are known and both kinds are permitted.
    expect(() =>
      validatePostings(
        [
          { account: HOUSE_ACCOUNT, amount: -100n, kind: "grant", ref: null },
          { account: POOL, amount: 100n, kind: "grant", ref: null },
        ],
        "play_credit",
      ),
    ).toThrow(/kind 'grant' may not credit account class 'amm'/);

    // And a payout may only be drawn from a pool, never out of a trader.
    expect(() =>
      validatePostings(
        [
          { account: BUYER, amount: -100n, kind: "payout", ref: null },
          { account: SELLER, amount: 100n, kind: "payout", ref: null },
        ],
        "play_credit",
      ),
    ).toThrow(/kind 'payout' may not debit account class 'trader'/);
  });
});

describe("accountClass", () => {
  it("recognises exactly the three classes the ledger has", () => {
    expect(accountClass(HOUSE_ACCOUNT)).toBe("house");
    expect(accountClass("trader:kax:agent:8e2f1c4a")).toBe("trader");
    expect(accountClass("amm:m_1a2b3c")).toBe("amm");
  });

  it("does not accept a bare prefix as a member of its class", () => {
    // "trader:" with nothing after it is not an identity, and accepting it
    // would give every caller a shared account with a plausible-looking name.
    expect(accountClass("trader:")).toBe("unknown");
    expect(accountClass("amm:")).toBe("unknown");
    // `house` is an exact match, matching the overdraft guard in lib/ledger.ts
    // — a `house:` prefix is NOT exempt there and must not be a house here.
    expect(accountClass("house:reserve")).toBe("unknown");
  });
});

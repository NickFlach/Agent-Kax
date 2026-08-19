/**
 * exchange.test.ts — #181's exchange window.
 *
 * The properties: the quote speaks ledger-core's frozen peg; the settle
 * path refuses unconfigured/unverified/out-of-bounds money loudly; a
 * verified deposit mints at the peg exactly once per settlement id; the
 * per-account daily cap (locked decision #6) holds; and the on-ramp is
 * ONE-WAY structurally — the router exposes no withdraw route, pinned here.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  DAILY_ACCOUNT_CAP_CREDITS,
  ExchangeRefused,
  MAX_DEPOSIT_USDC_MINOR,
  MIN_DEPOSIT_USDC_MINOR,
  exchangeQuote,
  settleDeposit,
  x402Challenge,
  type DepositVerifier,
} from "./exchange";
import { balance } from "./ledger";
import { CREDITS_PER_USDC } from "./ledger-core";
import { cleanupAuthTestData, createWalletUser } from "../test-helpers";

const okVerifier =
  (settlementId: string): DepositVerifier =>
  async ({ expectedUsdcMinor }) => ({ ok: true, settlementId, usdcMinor: expectedUsdcMinor });

const uniq = () => Math.random().toString(36).slice(2, 10);

describe("the quote and the challenge (pure)", () => {
  it("quotes ledger-core's frozen peg, one-way, with rail availability", () => {
    const q = exchangeQuote();
    expect(q.creditsPerUsdc).toBe("100");
    expect(q.oneWay).toBe(true);
    expect(q.rails.x402).toBe(false); // env unset here — honestly closed
  });

  it("the 402 challenge names the operator's wallet or refuses to exist", () => {
    expect(() => x402Challenge("/x", 1_000_000n)).toThrow(/KAX_X402_PAY_TO/);
    process.env["KAX_X402_PAY_TO"] = "0x000000000000000000000000000000000000dEaD";
    try {
      const c = x402Challenge("/x", 1_000_000n) as { accepts: Array<Record<string, unknown>> };
      expect(c.accepts[0]!["payTo"]).toBe("0x000000000000000000000000000000000000dEaD");
      expect(c.accepts[0]!["maxAmountRequired"]).toBe("1000000");
      expect(c.accepts[0]!["scheme"]).toBe("exact");
    } finally {
      delete process.env["KAX_X402_PAY_TO"];
    }
  });

  it("ONE-WAY is structural: no withdraw/redeem route exists, and no code path reverses a grant", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "routes", "exchange.ts"), "utf8");
    expect(src).not.toMatch(/withdraw|redeem|payout|cash.?out/i);
    const lib = fs.readFileSync(path.join(__dirname, "exchange.ts"), "utf8");
    expect(lib).not.toMatch(/function\s+(withdraw|redeem)/i);
  });
});

describe("settleDeposit (DB)", () => {
  let user: Awaited<ReturnType<typeof createWalletUser>>;
  let principal: string;

  beforeAll(async () => {
    user = await createWalletUser();
    principal = `kax:user:${user.id}`;
  });

  afterAll(async () => {
    await cleanupAuthTestData({ addresses: [user.address], userIds: [user.id], sids: [user.sid] });
  });

  it("bounds: dust and over-cap single deposits are refused before any verification", async () => {
    let verifierCalls = 0;
    const spy: DepositVerifier = async () => {
      verifierCalls++;
      return { ok: false, reason: "must not be reached" };
    };
    const base = { rail: "x402" as const, principal, paymentHeader: "x", verifier: spy, payTo: "0xdead" };
    await expect(settleDeposit({ ...base, requestedUsdcMinor: MIN_DEPOSIT_USDC_MINOR - 1n })).rejects.toThrow(ExchangeRefused);
    await expect(settleDeposit({ ...base, requestedUsdcMinor: MAX_DEPOSIT_USDC_MINOR + 1n })).rejects.toThrow(ExchangeRefused);
    expect(verifierCalls).toBe(0);
  });

  it("a verified deposit mints at the peg, exactly once per settlement id", async () => {
    const before = await balance(`trader:${principal}`, "play_credit");
    const sid = `sid-${uniq()}`;
    const five = 5_000_000n; // 5 USDC
    const first = await settleDeposit({
      rail: "x402", principal, requestedUsdcMinor: five,
      paymentHeader: "hdr", verifier: okVerifier(sid), payTo: "0xdead",
    });
    expect(first.credited).toBe((5n * CREDITS_PER_USDC).toString()); // 500 credits
    expect(first.idempotentReplay).toBe(false);
    // The replayed webhook / double-submitted header mints NOTHING more.
    const again = await settleDeposit({
      rail: "x402", principal, requestedUsdcMinor: five,
      paymentHeader: "hdr", verifier: okVerifier(sid), payTo: "0xdead",
    });
    expect(again.idempotentReplay).toBe(true);
    const after = await balance(`trader:${principal}`, "play_credit");
    expect(after - before).toBe(BigInt(first.creditedMinor));
  });

  it("an unverified or amount-drifted payment is a 402-shaped refusal, and nothing mints", async () => {
    const before = await balance(`trader:${principal}`, "play_credit");
    const bad: DepositVerifier = async () => ({ ok: false, reason: "signature invalid" });
    await expect(
      settleDeposit({ rail: "x402", principal, requestedUsdcMinor: 1_000_000n, paymentHeader: "x", verifier: bad, payTo: "0xdead" }),
    ).rejects.toMatchObject({ status: 402 });
    const drift: DepositVerifier = async () => ({ ok: true, settlementId: `sid-${uniq()}`, usdcMinor: 999n });
    await expect(
      settleDeposit({ rail: "x402", principal, requestedUsdcMinor: 1_000_000n, paymentHeader: "x", verifier: drift, payTo: "0xdead" }),
    ).rejects.toMatchObject({ codeName: "amount_mismatch" });
    expect(await balance(`trader:${principal}`, "play_credit")).toBe(before);
  });

  it("locked decision #6: the rolling-day per-account cap holds", async () => {
    // A fresh principal so earlier mints in this suite don't count.
    const u2 = await createWalletUser();
    const p2 = `kax:user:${u2.id}`;
    try {
      // 100 USDC (the daily cap at the peg) in one legal deposit…
      await settleDeposit({
        rail: "x402", principal: p2, requestedUsdcMinor: MAX_DEPOSIT_USDC_MINOR,
        paymentHeader: "x", verifier: okVerifier(`sid-${uniq()}`), payTo: "0xdead",
      });
      // …then one more cent-sized deposit must trip the cap, not mint.
      await expect(
        settleDeposit({
          rail: "x402", principal: p2, requestedUsdcMinor: MIN_DEPOSIT_USDC_MINOR,
          paymentHeader: "x", verifier: okVerifier(`sid-${uniq()}`), payTo: "0xdead",
        }),
      ).rejects.toMatchObject({ codeName: "daily_cap" });
      expect(DAILY_ACCOUNT_CAP_CREDITS).toBe(10_000n);
    } finally {
      await cleanupAuthTestData({ addresses: [u2.address], userIds: [u2.id], sids: [u2.sid] });
    }
  });
});

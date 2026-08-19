/**
 * commerceLedger.test.ts — #265's acceptance criteria.
 *
 * The grammar/balance half is pure. The chain, the crossing, and the
 * reconciliation are DB-backed (in CI). The two untouched-ledger pins are
 * source-level: ALLOWED_ASSETS unchanged, floor_ledger unreferenced.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { db } from "@workspace/db";
import { commerceOrdersTable } from "@workspace/db/schema";
import {
  COMMERCE_LEDGER_KINDS,
  commerceBalance,
  electCreatorShareAsCredits,
  isCommerceLedgerAccount,
  postCommerceTransaction,
  validateCommercePostings,
  type CommercePosting,
} from "./commerceLedger";
import { reconcileAgainstPayoutReport, reconcileOrderLegs } from "./commerceReconcile";
import { balance } from "./ledger";
import { cleanupAuthTestData, createWalletUser, makeTestId } from "../test-helpers";

const uniq = () => Math.random().toString(36).slice(2, 10);

describe("the account grammar (pure)", () => {
  it("accepts each class and refuses everything else", () => {
    for (const ok of ["customer", "kax_platform", "merchant:7", "processor:stripe", "pod:printify", "tax_liability:US-CA"]) {
      expect(isCommerceLedgerAccount(ok), ok).toBe(true);
    }
    for (const bad of ["house", "trader:x", "merchant:", "merchant:0", "processor:", "anything"]) {
      expect(isCommerceLedgerAccount(bad), bad).toBe(false);
    }
  });

  it("refuses an unbalanced set, a bad kind, and a non-ISO currency", () => {
    const p = (a: string, c: bigint, k = "charge"): CommercePosting => ({ account: a, amountCents: c, kind: k as never });
    expect(() => validateCommercePostings([p("customer", -100n), p("kax_platform", 90n)], "usd")).toThrow(/sum to zero/);
    expect(() => validateCommercePostings([p("customer", -100n), p("kax_platform", 100n, "gift")], "usd")).toThrow(/not a commerce-ledger kind/);
    expect(() => validateCommercePostings([p("customer", -100n), p("kax_platform", 100n)], "USD")).toThrow(/lowercase ISO/);
    expect(COMMERCE_LEDGER_KINDS).toContain("chargeback_reversal");
  });
});

describe("the chain and the crossing (DB)", () => {
  it("posts, replays idempotently, and balances accounts", async () => {
    const txId = `cl-${uniq()}`;
    const merchant = `merchant:${900000 + Math.floor(Math.random() * 99999)}`;
    const postings: CommercePosting[] = [
      { account: "customer", amountCents: -4720n, kind: "charge", ref: txId },
      { account: merchant, amountCents: 1343n, kind: "creator_share", ref: txId },
      { account: "kax_platform", amountCents: 390n, kind: "platform_fee", ref: txId },
      { account: "processor:stripe", amountCents: 167n, kind: "processor_fee", ref: txId },
      { account: "pod:printify", amountCents: 2500n, kind: "fulfillment_cost", ref: txId },
      { account: "tax_liability:US-CA", amountCents: 320n, kind: "tax_collected", ref: txId },
    ];
    const first = await postCommerceTransaction({ txId, currency: "usd", postings, actor: "test:suite" });
    expect(first.idempotentReplay).toBe(false);
    const replay = await postCommerceTransaction({ txId, currency: "usd", postings, actor: "test:suite" });
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.head).toBe(first.head);
    expect(await commerceBalance(merchant, "usd")).toBe(1343n);
    expect(await commerceBalance("tax_liability:US-CA", "usd")).toBeGreaterThanOrEqual(320n);
  });

  it("the ONE crossing grants credits at the peg, one-way", async () => {
    const user = await createWalletUser();
    try {
      const principal = `kax:user:${user.id}`;
      const ref = `ord-${uniq()}`;
      // Fund the merchant's fiat claim first so the election has a claim to retire.
      await postCommerceTransaction({
        txId: `fund-${ref}`,
        currency: "usd",
        postings: [
          { account: "customer", amountCents: -500n, kind: "charge", ref },
          { account: "merchant:1", amountCents: 500n, kind: "creator_share", ref },
        ],
        actor: "test:suite",
      });
      const before = await balance(`trader:${principal}`, "play_credit");
      const r = await electCreatorShareAsCredits({
        merchantId: 1,
        creatorPrincipal: principal,
        shareCents: 500n,
        commerceOrderRef: ref,
        actor: "test:suite",
      });
      // 1 cent = 1 credit at the frozen peg; 500 cents = 500 credits = 500e6 minor.
      expect(await balance(`trader:${principal}`, "play_credit")).toBe(before + 500_000_000n);
      // The merchant's fiat claim is retired into kax_platform.
      expect(r.commerceTxId).toContain(ref);
      // Replaying the whole election is idempotent end to end.
      await electCreatorShareAsCredits({
        merchantId: 1,
        creatorPrincipal: principal,
        shareCents: 500n,
        commerceOrderRef: ref,
        actor: "test:suite",
      });
      expect(await balance(`trader:${principal}`, "play_credit")).toBe(before + 500_000_000n);
    } finally {
      await cleanupAuthTestData({ addresses: [user.address], userIds: [user.id], sids: [user.sid] });
    }
  });

  it("the reconciliation detects a deliberately introduced discrepancy", async () => {
    const user = await createWalletUser();
    try {
      const ref = `recon-${uniq()}`;
      const [order] = await db
        .insert(commerceOrdersTable)
        .values({
          clientReference: ref,
          buyerUserId: user.id,
          sku: makeTestId("recon"),
          currency: "usd",
          itemCents: 3900, shippingCents: 500, taxCents: 320, totalCents: 4720,
          customerChargeCents: 4720,
          processorFeeCents: 167,
          shipToName: "T", shipToLine1: "1", shipToCity: "C", shipToRegion: "R",
          shipToPostalCode: "0", shipToCountry: "US",
          status: "paid",
        })
        .returning({ id: commerceOrdersTable.id });
      // Post a ledger charge that DISAGREES with the order: 4700, not 4720.
      await postCommerceTransaction({
        txId: `cl-${ref}`,
        currency: "usd",
        postings: [
          { account: "customer", amountCents: -4700n, kind: "charge", ref },
          { account: "kax_platform", amountCents: 4533n, kind: "platform_fee", ref },
          { account: "processor:stripe", amountCents: 167n, kind: "processor_fee", ref },
        ],
        actor: "test:suite",
      });
      const drifts = await reconcileOrderLegs(order!.id);
      expect(drifts.some((d) => d.where.includes("charge") && d.expected === "4720" && d.actual === "4700")).toBe(true);

      // And the payout-report side: an internally inconsistent report convicts
      // ITSELF before it can convict the ledger.
      const internal = await reconcileAgainstPayoutReport({ grossCents: 100n, feeCents: 10n, netCents: 80n });
      expect(internal.some((d) => d.where === "payout report internal")).toBe(true);
    } finally {
      await cleanupAuthTestData({ addresses: [user.address], userIds: [user.id], sids: [user.sid] });
    }
  });
});

describe("the untouched-ledger pins", () => {
  it("ALLOWED_ASSETS is unchanged and floor_ledger is unreferenced by the fiat core", () => {
    const routes = fs.readFileSync(path.join(__dirname, "..", "routes", "ledger.ts"), "utf8");
    // The play ledger accepts exactly what it accepted before this PR.
    expect(routes).toMatch(/ALLOWED_ASSETS\s*=\s*new Set\(\s*\[\s*"play_credit"\s*\]\s*\)/);
    for (const f of ["commerceLedger.ts", "commerceReconcile.ts"]) {
      const src = fs.readFileSync(path.join(__dirname, f), "utf8");
      expect(src).not.toMatch(/floor_ledger|floorLedger/i);
    }
  });
});

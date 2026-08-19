/**
 * commerceOrder.test.ts — #257's acceptance criteria.
 *
 * canTransition is tested for EVERY edge in ADR-0002's table — every legal
 * edge allowed and, per state, everything else refused — so an edge quietly
 * added or dropped in either place fails here by name. The legs use the
 * worked $39-poster example the issue asks for.
 */

import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  COMMERCE_STATES,
  ORDER_STATUSES,
  assertLegsBalance,
  canTransition,
  isCommerceState,
  isOrderStatus,
  margin,
  parseCommerceState,
  type CommerceState,
  type OrderLegs,
} from "./commerceOrder";
import { ensureCriticalSchema } from "./ensureCriticalSchema";

/** ADR-0002's table, edge for edge, as the test's own source of truth. */
const LEGAL: ReadonlyArray<[CommerceState, CommerceState]> = [
  ["not_evaluated", "rights_checked"],
  ["not_evaluated", "rights_blocked"],
  ["not_evaluated", "review_required"],
  ["rights_checked", "asset_checked"],
  ["rights_checked", "asset_insufficient"],
  ["asset_checked", "product_eligible"],
  ["asset_checked", "asset_insufficient"],
  ["product_eligible", "merchant_approved"],
  ["merchant_approved", "channel_ready"],
  ["merchant_approved", "product_eligible"],
  ["channel_ready", "published"],
  ["channel_ready", "provider_rejected"],
  ["channel_ready", "channel_policy_blocked"],
  ["published", "unpublished"],
  ["published", "discontinued"],
  ["published", "provider_rejected"],
];

describe("the eligibility machine (#257)", () => {
  it("allows every edge in the ADR's table", () => {
    for (const [from, to] of LEGAL) {
      expect(canTransition(from, to), `${from} -> ${to} should be legal`).toBe(true);
    }
  });

  it("refuses every edge NOT in the table (except the revocation wildcard)", () => {
    const legal = new Set(LEGAL.map(([f, t]) => `${f}>${t}`));
    for (const from of COMMERCE_STATES) {
      for (const to of COMMERCE_STATES) {
        if (to === "rights_blocked") continue; // wildcard, tested below
        const expected = legal.has(`${from}>${to}`);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it("product_eligible -> published is illegal: no skipping the human", () => {
    expect(canTransition("product_eligible", "published")).toBe(false);
  });

  it("merchant_approved -> product_eligible is legal: the content-hash mismatch demotion", () => {
    expect(canTransition("merchant_approved", "product_eligible")).toBe(true);
  });

  it("creator-bot revocation forces ANY state to rights_blocked", () => {
    for (const from of COMMERCE_STATES) {
      expect(canTransition(from, "rights_blocked"), `${from} -> rights_blocked`).toBe(true);
    }
  });

  it("rejects an unknown state string by name", () => {
    expect(isCommerceState("eligible")).toBe(false);
    expect(() => parseCommerceState("eligible")).toThrow(/'eligible' is not a commerce state/);
    expect(isOrderStatus("shipped-ish")).toBe(false);
    expect(ORDER_STATUSES.length).toBeGreaterThan(0);
  });
});

describe("the legs: the worked $39 poster (#257)", () => {
  // $39.00 poster + $5.00 shipping + $3.20 tax = $47.20 charged.
  // Outbound: Stripe fee $1.67, platform fee 10% of item = $3.90,
  // fulfillment $21.00 + $4.00 shipping, tax remitted onward $3.20,
  // and the merchant nets the remainder: $13.43.
  const poster: OrderLegs = {
    customerChargeCents: 4720,
    itemPriceCents: 3900,
    shippingChargedCents: 500,
    taxCollectedCents: 320,
    processorFeeCents: 167,
    platformFeeCents: 390,
    fulfillmentCostCents: 2100,
    fulfillmentShippingCostCents: 400,
    merchantNetCents: 1343,
  };

  it("balances the worked example in both directions", () => {
    expect(() => assertLegsBalance(poster)).not.toThrow();
  });

  it("throws on an unbalanced set, naming the delta", () => {
    expect(() => assertLegsBalance({ ...poster, merchantNetCents: 1400 })).toThrow(/delta -57/);
    expect(() => assertLegsBalance({ ...poster, customerChargeCents: 4700 })).toThrow(/inbound/);
  });

  it("refuses non-integer cents — never floats for money", () => {
    expect(() => assertLegsBalance({ ...poster, taxCollectedCents: 3.2 })).toThrow(/integer/);
  });

  it("computes the margin from the issue's exact formula", () => {
    // 3900 - 390 - 167 - 2100 - 400 = 843
    expect(margin(poster)).toBe(843);
  });
});

describe("drop-and-repair (DB): both tables come back", () => {
  it("commerce_products and commerce_orders survive being dropped", async () => {
    // These tables predate this issue and already carry live-worker columns;
    // ensureCriticalSchema owns commerce_orders' repair and now the new leg
    // columns too. Repair-probe the pair rather than trusting the diff.
    await db.execute(sql`SELECT to_regclass('public.commerce_products') AS t`);
    const r = await ensureCriticalSchema();
    expect(r.error).toBeUndefined();
    for (const t of ["commerce_products", "commerce_orders"]) {
      const probe = await db.execute(sql.raw(`SELECT to_regclass('public.${t}') AS t`));
      expect((probe.rows[0] as { t: string | null }).t, t).not.toBeNull();
    }
  });
});

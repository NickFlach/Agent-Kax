/**
 * commerceOrder.ts — the commerce eligibility machine and the money-leg
 * discipline (#257, KAX-ADR-0002).
 *
 * Pure by construction, like commerceOrderStatus.ts: nothing here imports
 * @workspace/db, so routes, workers and libs can all reach the vocabulary
 * without a cycle or a connection pool.
 *
 * States are varchar in the DB; THIS file is where the vocabulary and the
 * transition table live, transcribed from ADR-0002's table verbatim. The one
 * out-of-band rule — creator bot revoked moves ANY state to rights_blocked —
 * is encoded as a wildcard rather than 14 rows, so adding a state cannot
 * silently exempt it from revocation.
 */

export const COMMERCE_STATES = [
  "not_evaluated",
  "rights_checked",
  "rights_blocked",
  "review_required",
  "asset_checked",
  "asset_insufficient",
  "product_eligible",
  "merchant_approved",
  "channel_ready",
  "published",
  "unpublished",
  "discontinued",
  "provider_rejected",
  "channel_policy_blocked",
] as const;
export type CommerceState = (typeof COMMERCE_STATES)[number];

export function isCommerceState(s: string | null | undefined): s is CommerceState {
  return s != null && (COMMERCE_STATES as readonly string[]).includes(s);
}

export function parseCommerceState(s: string): CommerceState {
  if (!isCommerceState(s)) {
    throw new Error(`'${s}' is not a commerce state (expected one of ${COMMERCE_STATES.join(", ")})`);
  }
  return s;
}

/** ADR-0002's transition table, edge for edge. */
const TRANSITIONS: Readonly<Record<CommerceState, readonly CommerceState[]>> = {
  not_evaluated: ["rights_checked", "rights_blocked", "review_required"],
  rights_checked: ["asset_checked", "asset_insufficient"],
  rights_blocked: [],
  review_required: [],
  asset_checked: ["product_eligible", "asset_insufficient"],
  asset_insufficient: [],
  // The ONLY edge out of product_eligible is a human approving — there is no
  // automated path to merchant_approved, and product_eligible -> published
  // is illegal by omission here and pinned in the tests.
  product_eligible: ["merchant_approved"],
  // Re-check passing goes forward; a failed re-check OR a content-hash
  // mismatch goes BACK to product_eligible for fresh human eyes (#259).
  merchant_approved: ["channel_ready", "product_eligible"],
  channel_ready: ["published", "provider_rejected", "channel_policy_blocked"],
  published: ["unpublished", "discontinued", "provider_rejected"],
  unpublished: [],
  discontinued: [],
  provider_rejected: [],
  channel_policy_blocked: [],
};

/**
 * May a product move from `from` to `to`? The revocation wildcard is checked
 * first: a revoked creator bot forces ANY state to rights_blocked, and that
 * edge must never depend on someone remembering to add it per-state.
 */
export function canTransition(from: CommerceState, to: CommerceState): boolean {
  if (to === "rights_blocked") return true;
  return TRANSITIONS[from].includes(to);
}

/**
 * Order status vocabulary, aggregated from the shipped checkout rather than
 * invented: the settled/terminal and non-chargeable subsets that decide real
 * money live in commerceOrderStatus.ts and remain the operative guards.
 */
export const ORDER_STATUSES = [
  "pending",
  "paid",
  "payment_failed",
  "canceled",
  "refunded",
  "chargeback",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export function isOrderStatus(s: string | null | undefined): s is OrderStatus {
  return s != null && (ORDER_STATUSES as readonly string[]).includes(s);
}

// ---------------------------------------------------------------------------
// The approval pin (#259). Rights assertions are time-bound snapshots: the
// bytes behind artifacts.public_url live in a bucket KAX does not control and
// can change with no KAX-side write. Approval is therefore pinned to CONTENT
// — what was seen, at what spec, at what price — never to a timestamp.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";

export interface ApprovalPinInput {
  /** The URL as it was at measurement (artifact_print_assets.source_url_at_fetch). */
  sourceUrlAtFetch: string;
  /** sha256 of the measured bytes (artifact_print_assets.sha256). */
  assetSha256: string;
  productSpecId: string;
  /** The list price (commerce_products.item_cents; the issue's list_price_cents). */
  itemCents: number;
}

/**
 * The content hash a human approval is pinned to. Any of the four inputs
 * changing — the bytes, where they came from, the spec, or the price —
 * changes the hash, and a changed hash is a NEW approval decision, not a
 * stale valid one.
 */
export function approvalHash(i: ApprovalPinInput): string {
  const body = [i.sourceUrlAtFetch, i.assetSha256, i.productSpecId, String(i.itemCents)]
    .map((s) => `${s.length}:${s}`)
    .join("");
  return crypto.createHash("sha256").update(body, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// The legs. Same discipline as validatePostings: the set must balance, and a
// set that does not is refused loudly with the delta named.
// ---------------------------------------------------------------------------

export interface OrderLegs {
  /** The full authorized amount — what the customer's card was charged. */
  customerChargeCents: number;
  /** Goods subtotal, ex-tax ex-shipping (the existing item_cents column). */
  itemPriceCents: number;
  shippingChargedCents: number;
  taxCollectedCents: number;
  processorFeeCents: number;
  platformFeeCents: number;
  fulfillmentCostCents: number;
  fulfillmentShippingCostCents: number;
  merchantNetCents: number;
}

function assertIntegerCents(o: OrderLegs): void {
  for (const [k, v] of Object.entries(o)) {
    if (!Number.isInteger(v)) {
      throw new Error(`${k} must be an integer of USD cents; got ${v}`);
    }
  }
}

/**
 * Two equalities, both required:
 *
 *   inbound:  customer_charge = item_price + shipping_charged + tax_collected
 *   outbound: customer_charge = processor_fee + platform_fee
 *             + fulfillment_cost + fulfillment_shipping_cost
 *             + tax_collected (remitted onward) + merchant_net
 *
 * The same money counted twice, once by where it came from and once by where
 * it went. A gross figure can hide a missing leg; this cannot.
 */
export function assertLegsBalance(o: OrderLegs): void {
  assertIntegerCents(o);
  const inbound = o.itemPriceCents + o.shippingChargedCents + o.taxCollectedCents;
  if (inbound !== o.customerChargeCents) {
    throw new Error(
      `legs do not balance inbound: item ${o.itemPriceCents} + shipping ${o.shippingChargedCents} ` +
        `+ tax ${o.taxCollectedCents} = ${inbound}, but customer_charge is ${o.customerChargeCents}`,
    );
  }
  const outbound =
    o.processorFeeCents +
    o.platformFeeCents +
    o.fulfillmentCostCents +
    o.fulfillmentShippingCostCents +
    o.taxCollectedCents +
    o.merchantNetCents;
  if (outbound !== o.customerChargeCents) {
    throw new Error(
      `legs do not balance outbound: fees+fulfillment+tax+merchant_net = ${outbound}, ` +
        `but customer_charge is ${o.customerChargeCents} (delta ${o.customerChargeCents - outbound})`,
    );
  }
}

/**
 * Margin on an order, exactly the formula #257 specifies:
 *
 *   margin = item_price − platform_fee − processor_fee_borne
 *            − fulfillment_cost − fulfillment_shipping_cost
 *
 * Kept verbatim so the number means what the epic's models assume;
 * renegotiating the formula is an ADR edit, not a refactor.
 */
export function margin(o: OrderLegs): number {
  assertIntegerCents(o);
  return (
    o.itemPriceCents -
    o.platformFeeCents -
    o.processorFeeCents -
    o.fulfillmentCostCents -
    o.fulfillmentShippingCostCents
  );
}

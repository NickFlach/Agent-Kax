/**
 * The client half of the physical purchase path: the four calls, the words for
 * every way the server refuses, and the decisions that keep one press of Buy
 * to one charge.
 *
 * Free of React and free of Stripe, in the same way and for the same reason as
 * `lib/purchasing.ts`. The purchase panel is a rendering problem; the things
 * worth testing about it — whether a retry reuses its idempotency key, what a
 * refusal tells the buyer to do next, whether an unrecognised outcome is
 * treated as settled — are decisions, and a Node test can call them here
 * without mounting a DOM, a router or an iframe.
 *
 * ## Why these are hand-rolled `fetch` calls and not generated hooks
 *
 * `routes/commerce.ts` is deliberately off the OpenAPI contract; its own header
 * records why. The purchase is a quote / retry / poll / idempotency protocol
 * whose client has to mint a reference before it calls, reuse it across retries
 * and poll a reference it may never have received a response for, and orval's
 * generated mutation hooks model none of that. So the settings endpoints get
 * generated types (`PurchasingSnapshot`) and these four do not.
 *
 * ## One press of Buy is one `clientReference`, forever
 *
 * The reference IS the idempotency key. `POST /commerce/purchase` writes the
 * `commerce_orders` row under it BEFORE it says a word to Stripe, and derives
 * the Stripe idempotency key from it, so a retry that carries the same
 * reference finds the first attempt's charge and reports on it instead of
 * making a second one. That is the entire protection against a lost response
 * charging a card twice, and it works only if the client actually reuses the
 * value — see `shouldReuseReference`, which is where the rule lives.
 *
 * ## Nothing here is a permission
 *
 * The purchasing snapshot this module reads alongside is a UI hint. Every quote
 * and every purchase recomputes the account's state on the server and refuses
 * with `reason` set to one of the same twelve state codes, which is why
 * `refusalCopy` falls through to `purchasingCopy` rather than keeping a second
 * copy of that vocabulary.
 *
 * ## No credit ledger, ever
 *
 * play_credit cannot buy a parcel. The server guarantees that structurally —
 * nothing on the physical path imports the ledger or reads `store_listings` —
 * and the client half of the rule is that this module talks to `/api/commerce`
 * and to nothing else.
 */

import { appUrl } from "./urls";
import { purchasingCopy } from "./purchasing";

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Integer minor units as a price string.
 *
 * Every amount on this path is an INTEGER of USD cents in a field named for its
 * unit, and the division by 100 happens here, once, at the point of display.
 * Nothing upstream of this line holds a price as a float — that ambiguity is
 * `store_listings.price`, which means play_credit minor units in one file and
 * USD dollars in another, and it is why the physical path has its own columns.
 *
 * An unrecognisable currency code falls back to a plain decimal with the code
 * beside it. `Intl.NumberFormat` throws a `RangeError` on anything that is not
 * three letters, and a price list that throws is worse than one that reads
 * "20.73 XYZ".
 */
export function formatMoney(cents: number, currency: string): string {
  const code = currency.trim().toUpperCase();
  const amount = cents / 100;
  if (!/^[A-Z]{3}$/.test(code)) return `${amount.toFixed(2)} ${currency}`;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${code}`;
  }
}

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

/**
 * A commerce call that did not succeed.
 *
 * `status` is null when the request never got an answer at all — DNS, a dropped
 * connection, a closed laptop. That distinction is not cosmetic: it is exactly
 * the case in which a charge may already have been made, and it is what
 * `shouldReuseReference` switches on.
 */
export class CommerceError extends Error {
  /** The HTTP status, or null when there was no response. */
  readonly status: number | null;
  /** The server's machine-readable word, e.g. `quote_expired`. */
  readonly reason: string | null;
  /** Every blocking reason, when the refusal was an account-state one. */
  readonly reasons: string[];
  /** Stripe's own word for a refused card, e.g. `insufficient_funds`. */
  readonly declineCode: string | null;

  constructor(
    message: string,
    init: {
      status?: number | null;
      reason?: string | null;
      reasons?: string[];
      declineCode?: string | null;
    } = {},
  ) {
    super(message);
    this.name = "CommerceError";
    this.status = init.status ?? null;
    this.reason = init.reason ?? null;
    this.reasons = init.reasons ?? [];
    this.declineCode = init.declineCode ?? null;
  }
}

/**
 * The server's refusal, read off a failed response.
 *
 * Four fields and no others. In particular `issues` is NOT folded in the way
 * `lib/purchasing.ts` folds it for the address form: on this router a 400 is a
 * malformed `sku`, `quoteId` or `clientReference`, none of which a buyer can
 * act on, and the shipping address is bound as a query parameter on the order
 * insert — so the narrower the path from a server error string to a toast, the
 * fewer ways a street ends up in one.
 */
async function readCommerceError(res: Response, fallback: string): Promise<CommerceError> {
  let message = fallback;
  let reason: string | null = null;
  let reasons: string[] = [];
  let declineCode: string | null = null;
  try {
    const body = (await res.json()) as {
      error?: unknown;
      reason?: unknown;
      reasons?: unknown;
      declineCode?: unknown;
    };
    if (typeof body.error === "string" && body.error) message = body.error;
    if (typeof body.reason === "string") reason = body.reason;
    if (Array.isArray(body.reasons)) reasons = body.reasons.filter((r): r is string => typeof r === "string");
    if (typeof body.declineCode === "string") declineCode = body.declineCode;
  } catch {
    // A response with no JSON body is still a refusal; the fallback says so.
  }
  return new CommerceError(message, { status: res.status, reason, reasons, declineCode });
}

/**
 * Whether the next attempt must carry the SAME `clientReference`.
 *
 * True in exactly one situation: the last send produced no verdict. A transport
 * failure or a 5xx means the request may have reached the server, written the
 * order row and charged the card, with only the response lost — and a retry
 * under a fresh reference would be a second purchase of the same thing. Reusing
 * it makes the retry a REPORT: the handler finds the row, sees it already
 * carries a PaymentIntent, retrieves that intent and answers with its state.
 *
 * False for every answered refusal, and each of those would wedge if it were
 * not:
 *
 * - `quote_expired` on a retry means the server found the unpaid row from the
 *   earlier attempt and judged it older than the quote TTL. That row is refused
 *   for as long as it exists, so retrying under the same reference 410s
 *   forever; the buyer needs a new price AND a new reference.
 * - `card_declined` leaves a row that carries the declined intent, and
 *   `finishPurchase` RETRIEVES an intent rather than re-charging. Retrying under
 *   the same reference re-reports the decline no matter how the card is fixed.
 * - `client_reference_conflict` is the server saying this exact value belongs to
 *   somebody else's order.
 *
 * A 4xx is therefore always a decision the server has made and recorded, and a
 * fresh press is a fresh purchase.
 */
export function shouldReuseReference(err: unknown): boolean {
  if (!(err instanceof CommerceError)) return true; // Unknown failure: assume the charge may have landed.
  if (err.status === null) return true;
  return err.status >= 500;
}

/** A new idempotency key for a fresh press of Buy. */
export function newClientReference(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// What a refusal tells the buyer to do
// ---------------------------------------------------------------------------

/**
 * The one action the panel offers alongside a refusal.
 *
 * `settings` sends the buyer to `/dashboard#physical-purchasing`, which is the
 * only place an address, a card or a consent can be changed. `requote` asks for
 * a new price and is the recovery for every stale-quote refusal. `retry` is a
 * fresh press of the same purchase. `none` is a refusal this panel cannot clear
 * — saying "try again" under one of those is a loop the buyer walks twice.
 */
export type PurchaseRecourse = "settings" | "requote" | "retry" | "none";

export interface RefusalAdvice {
  /** The sentence shown to the buyer. Never a field of their address. */
  message: string;
  recourse: PurchaseRecourse;
}

/**
 * The nine ways `routes/commerce.ts` refuses, each with what to do about it.
 *
 * Keyed by the server's own `CommerceRefusal` union, which `commerce.test.ts`
 * reads out of the route as source and compares against these keys — a tenth
 * refusal added on the server with no entry here is a panel that says nothing
 * and offers no way forward, and nothing about that fails a build.
 */
export const REFUSAL_ADVICE: Record<string, RefusalAdvice> = {
  product_unavailable: {
    message: "This item isn't for sale right now.",
    recourse: "none",
  },
  unsupported_destination: {
    message: "We can't ship this to the country on your saved address yet.",
    recourse: "settings",
  },
  quote_invalid: {
    message: "That price is no longer valid. Get a new one and try again.",
    recourse: "requote",
  },
  quote_not_yours: {
    message: "That price was issued to a different account. Get a new one.",
    recourse: "requote",
  },
  quote_expired: {
    message: "That price is more than five minutes old. Get a new one.",
    recourse: "requote",
  },
  price_changed: {
    message: "The price changed while you were deciding. Get the new one before you buy.",
    recourse: "requote",
  },
  client_reference_conflict: {
    message: "Something went wrong starting that purchase. Try again.",
    recourse: "retry",
  },
  instrument_unavailable: {
    message: "Your address or card is no longer on file. Check your purchasing settings.",
    recourse: "settings",
  },
  card_declined: {
    message: "Your card was declined. Nothing was charged. Try a different card.",
    recourse: "settings",
  },
};

/**
 * What to show for a failure, whatever its shape.
 *
 * The three sources are tried in the order of how specific they are. A
 * `CommerceRefusal` has copy written for it here. An account-state refusal
 * carries one of the twelve `PurchasingStateCode`s as its reason, and the
 * sentence for those already exists in `lib/purchasing.ts` — duplicating it
 * would be a second copy of a vocabulary that has already been made to track
 * the server's. Anything else falls back to the server's own message, which is
 * written for a human and contains nothing about the buyer.
 *
 * `cap_reached` is the one state whose recourse is `none`: it clears with time
 * and there is nothing in settings to change.
 */
export function refusalAdvice(err: unknown): RefusalAdvice {
  if (!(err instanceof CommerceError)) {
    return { message: "Something went wrong. Please try again.", recourse: "retry" };
  }
  const reason = err.reason ?? "";
  const known = REFUSAL_ADVICE[reason];
  if (known) return known;

  const stateRecourse = ACCOUNT_STATE_RECOURSE[reason];
  if (stateRecourse) {
    return { message: purchasingCopy(reason).detail, recourse: stateRecourse };
  }

  // No verdict at all — the request never landed, or the server answered
  // something this client has never seen.
  return {
    message: err.message,
    recourse: shouldReuseReference(err) ? "retry" : "none",
  };
}

/**
 * The recourse for each account state a purchase can be refused with.
 *
 * Written out rather than defaulted to `settings`, because two of them are not
 * fixable there: `cap_reached` clears with the clock, and `disabled` is a
 * property of the deployment. Telling a buyer to go and change a setting that
 * cannot help is the loop this table exists to prevent.
 */
export const ACCOUNT_STATE_RECOURSE: Record<string, PurchaseRecourse> = {
  disabled: "none",
  anonymous: "none",
  not_configured: "settings",
  unsupported_destination: "settings",
  needs_address: "settings",
  needs_payment_method: "settings",
  pm_detached: "settings",
  card_expired: "settings",
  consent_stale: "settings",
  cap_reached: "none",
  card_expiring: "settings",
  ready: "retry",
};

// ---------------------------------------------------------------------------
// The shapes on the wire
// ---------------------------------------------------------------------------

/** A published physical product, from `GET /commerce/products/for-artifact/:id`. */
export interface PhysicalProduct {
  sku: string;
  title: string;
  currency: string;
  itemCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  shipToCountries: string[];
}

/** One line of a quote: the item, the shipping, and tax when there is any. */
export interface QuoteLine {
  kind: string;
  label: string;
  amountCents: number;
}

export interface CommerceQuote {
  quoteId: string;
  sku: string;
  title: string;
  lines: QuoteLine[];
  currency: string;
  totalCents: number;
  /** ISO 8601. Five minutes out; the server refuses a purchase past it. */
  expiresAt: string;
}

/**
 * What the buyer's tab should do next, from `purchaseOutcomeFor` on the server.
 *
 * Distinct from `orderStatus`, which records what happened to the order.
 * `requires_action` is the only one that comes with a client secret.
 */
export type PurchaseOutcome =
  | "processing"
  | "requires_action"
  | "paid"
  | "failed"
  | "canceled"
  | "refunded"
  | "chargeback";

export interface PurchaseResult {
  orderRef: string;
  status: PurchaseOutcome | string;
  orderStatus: string;
  totalCents: number;
  currency: string;
  /** Present only on `requires_action`. The credential for the SCA challenge. */
  clientSecret?: string;
}

/** An order as `GET /commerce/orders` and `GET /commerce/orders/:ref` report it. */
export interface PhysicalOrder {
  orderRef: string;
  status: PurchaseOutcome | string;
  orderStatus: string;
  fulfillmentState: string;
  sku: string;
  currency: string;
  itemCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  createdAt: string;
  updatedAt: string;
  /**
   * Where the parcel is, once anything knows.
   *
   * Optional because `commerce_orders` has no tracking columns yet — the
   * fulfilment states it does carry stop at `in_production`, and the shipped
   * transition that would carry a carrier and a number is #263. The field is
   * declared and rendered now so that landing it on the server is a server
   * change alone, and it is absent rather than defaulted so the page can tell
   * "not shipped" from "shipped, no number".
   */
  tracking?: { carrier?: string | null; number?: string | null; url?: string | null } | null;
}

/** A digital purchase, from the long-shipped `GET /store/my-orders`. */
export interface DigitalOrder {
  id: number;
  status: string;
  amountCents: number;
  currency: string;
  createdAt: string;
  listingId: number;
  artifactTitle: string;
}

// ---------------------------------------------------------------------------
// The calls
// ---------------------------------------------------------------------------

async function commerceRequest(path: string, init: RequestInit, fallback: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(appUrl(path), { credentials: "include", ...init });
  } catch (err) {
    // No response at all. `status` stays null, which is what tells
    // `shouldReuseReference` that a charge may already have been made.
    throw new CommerceError(err instanceof Error && err.message ? err.message : fallback, {
      status: null,
    });
  }
  if (!res.ok) throw await readCommerceError(res, fallback);
  return res.json();
}

function jsonBody(body: unknown): RequestInit {
  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/** Cache key for one artifact's physical products. */
export function physicalProductsQueryKey(artifactId: number): readonly unknown[] {
  return ["commerce", "products", artifactId];
}

/**
 * The published physical products printed from an artifact, or none.
 *
 * A 404 is answered with an empty list rather than an error, because on this
 * router 404 is what the whole surface says when `KAX_COMMERCE_ENABLED` is
 * unset. A deployment with physical commerce switched off is not a page that
 * failed to load; it is a page with nothing physical on it.
 */
export async function fetchPhysicalProducts(artifactId: number): Promise<PhysicalProduct[]> {
  const res = await fetch(appUrl(`/api/commerce/products/for-artifact/${artifactId}`), {
    credentials: "include",
  });
  if (res.status === 404) return [];
  if (!res.ok) throw await readCommerceError(res, "Could not load the print options.");
  const body = (await res.json()) as { products?: PhysicalProduct[] };
  return Array.isArray(body.products) ? body.products : [];
}

export async function fetchQuote(sku: string): Promise<CommerceQuote> {
  return (await commerceRequest(
    "/api/commerce/quote",
    { method: "POST", ...jsonBody({ sku }) },
    "Could not get a price for that.",
  )) as CommerceQuote;
}

/**
 * Buy, under a reference the caller minted and controls.
 *
 * The reference is an argument rather than something minted here, and that is
 * the whole idempotency protocol: a retry has to present the same value, and a
 * function that generated one per call could not be retried at all.
 */
export async function submitPurchase(
  quoteId: string,
  clientReference: string,
): Promise<PurchaseResult> {
  return (await commerceRequest(
    "/api/commerce/purchase",
    { method: "POST", ...jsonBody({ quoteId, clientReference }) },
    "Could not complete that purchase.",
  )) as PurchaseResult;
}

export async function fetchOrder(orderRef: string): Promise<PhysicalOrder> {
  return (await commerceRequest(
    `/api/commerce/orders/${encodeURIComponent(orderRef)}`,
    { method: "GET" },
    "Could not read that order.",
  )) as PhysicalOrder;
}

/** Cache key for the buyer's own orders, both halves. */
export const MY_ORDERS_QUERY_KEY = ["orders", "mine"] as const;

/**
 * The buyer's physical orders, or none.
 *
 * Same 404-is-empty rule as the product read, and for the same reason: with
 * commerce off there are no physical orders to have, and `/orders` should show
 * the digital half rather than an error.
 */
export async function fetchPhysicalOrders(): Promise<PhysicalOrder[]> {
  const res = await fetch(appUrl("/api/commerce/orders"), { credentials: "include" });
  if (res.status === 404) return [];
  if (!res.ok) throw await readCommerceError(res, "Could not load your physical orders.");
  const body = (await res.json()) as { orders?: PhysicalOrder[] };
  return Array.isArray(body.orders) ? body.orders : [];
}

/**
 * The buyer's digital orders.
 *
 * `GET /store/my-orders` has been on the server since the hosted-Checkout path
 * shipped and has never had a consumer. `routes/store-checkout.ts` is not
 * touched by any of this work — it is a separate table, a separate Stripe
 * object and a separate webhook branch, and the two order lists are joined
 * nowhere but on this page, for display.
 */
export async function fetchDigitalOrders(): Promise<DigitalOrder[]> {
  const res = await fetch(appUrl("/api/store/my-orders"), { credentials: "include" });
  if (res.status === 404) return [];
  if (!res.ok) throw await readCommerceError(res, "Could not load your digital orders.");
  const body = (await res.json()) as { orders?: DigitalOrder[] };
  return Array.isArray(body.orders) ? body.orders : [];
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

/** What the panel does about an outcome. */
export type PurchaseStep = "settled" | "poll" | "authenticate";

/**
 * The step for an outcome.
 *
 * Anything unrecognised polls. It is the only safe default: `settled` would
 * stop a tab watching a charge that is still in flight, and telling the buyer
 * their purchase is done when the server has not said so is the one wrong
 * answer here. The poll ends on its own when the deadline passes.
 */
export function stepFor(outcome: string): PurchaseStep {
  if (outcome === "requires_action") return "authenticate";
  if (outcome === "paid" || outcome === "failed" || outcome === "canceled") return "settled";
  if (outcome === "refunded" || outcome === "chargeback") return "settled";
  return "poll";
}

/** Whether an outcome means the buyer got what they paid for. */
export function isSuccessfulOutcome(outcome: string): boolean {
  return outcome === "paid";
}

/** How long between polls of `GET /commerce/orders/:ref`. */
export const ORDER_POLL_INTERVAL_MS = 2_000;

/**
 * How long the panel watches before it stops and points at `/orders`.
 *
 * A charge that is still `processing` after this is not a failure and must not
 * be shown as one — the webhook settles it whether or not a tab is open, which
 * is why the order list exists and why this deadline is allowed to be short.
 */
export const ORDER_POLL_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// The words on the orders page
// ---------------------------------------------------------------------------

/**
 * `commerce_orders.status`, in the buyer's language.
 *
 * Keyed by the STORED status rather than by the derived outcome, because this
 * page is a record of what happened and `refunded` and `chargeback` are things
 * that happened. `purchaseOutcomeFor` collapses several of these for the panel,
 * which needs to know what to do next; the list needs to say what occurred.
 */
export const ORDER_STATUS_LABEL: Record<string, string> = {
  pending_payment: "Payment processing",
  authenticating: "Confirming with your bank",
  paid: "Paid",
  payment_failed: "Payment failed",
  canceled: "Canceled",
  refunded: "Refunded",
  chargeback: "Charged back",
};

/**
 * `commerce_orders.fulfillment_state`, in the buyer's language.
 *
 * Six values, of which the server writes three today: `unfulfilled` on insert,
 * `submitted` and `in_production` from the two admin endpoints. `shipped` and
 * `delivered` arrive with #263. They are worded here now because a page that
 * renders a raw column value the day that lands says "in_production" to a
 * buyer.
 */
export const FULFILLMENT_LABEL: Record<string, string> = {
  unfulfilled: "Not sent to production yet",
  submitted: "Sent to the printer",
  in_production: "Being printed",
  shipped: "Shipped",
  delivered: "Delivered",
  canceled: "Canceled",
};

/**
 * A label for a stored value, or the value itself.
 *
 * Both columns are `varchar` and not `pgEnum` — deliberately, so an unknown
 * literal is a row that can still be queried rather than a 500 — which means an
 * unknown value can reach this page. Showing it raw is ugly and honest; showing
 * nothing loses a row's only description of itself.
 */
export function labelFor(table: Record<string, string>, value: string): string {
  return table[value] ?? value;
}

// ---------------------------------------------------------------------------
// The two halves of one history
// ---------------------------------------------------------------------------

/** One line of `/orders`, from whichever table it came out of. */
export type OrderRow =
  | { kind: "digital"; createdAt: string; order: DigitalOrder }
  | { kind: "physical"; createdAt: string; order: PhysicalOrder };

/**
 * Both order lists as one, newest first.
 *
 * Interleaved by time rather than grouped by kind, because a buyer remembers
 * "the thing I bought on Tuesday" and not which of two Stripe integrations
 * handled it. The two tables are joined nowhere on the server — `commerce_orders`
 * has no foreign key to `listing_orders` and they are never unioned in SQL —
 * and this display merge is deliberately the only place they meet.
 *
 * The sort is on the ISO strings' parsed time and not on the strings, because
 * the two endpoints do not serialise them the same way: `GET /store/my-orders`
 * calls `.toISOString()` explicitly and `GET /commerce/orders` lets the JSON
 * encoder do it. Both are ISO 8601 today; a lexical sort would silently
 * mis-order the day one of them stops being.
 */
export function mergeOrders(digital: DigitalOrder[], physical: PhysicalOrder[]): OrderRow[] {
  const rows: OrderRow[] = [
    ...digital.map((order): OrderRow => ({ kind: "digital", createdAt: order.createdAt, order })),
    ...physical.map((order): OrderRow => ({ kind: "physical", createdAt: order.createdAt, order })),
  ];
  return rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/**
 * Whether a physical order has gone far enough to be worth a fulfilment line.
 *
 * An order that failed or was canceled has no parcel, and printing "Not sent to
 * production yet" beside a declined card reads as a queue the buyer is waiting
 * in.
 */
export function showsFulfillment(order: Pick<PhysicalOrder, "orderStatus">): boolean {
  return order.orderStatus === "paid" || order.orderStatus === "refunded" || order.orderStatus === "chargeback";
}

/**
 * commerceFulfillmentWorker.test.ts — the timer that presses the two admin
 * buttons, attacked at the places automation can cost money that a human
 * pressing the same buttons could not.
 *
 * `printifyClient.test.ts` already proves the two steps themselves: the row
 * lock, the `paid` precondition, the double-submit guard, the address coming
 * off the order's own snapshot. The worker presses that same code, so none of
 * it is re-proved here. What is new, and what is below, is everything about
 * doing it unattended:
 *
 * **The flags.** Automation is opt-in on top of an already-opt-in surface, and
 * both halves have to be on. A worker that ran because one flag was set would
 * manufacture on a deployment whose operator had armed Printify and nothing
 * else. Each case asserts zero outbound calls AND an untouched row, because a
 * gate that skipped the log but did the work would otherwise pass.
 *
 * **The retry ladder**, which is the part with teeth. `printifyClient.ts` never
 * retries a write, because a retried submission whose first attempt landed is a
 * second parcel. So a 429 may be tried again and a 400 may not: an address
 * Printify rejected is rejected again tomorrow, and retrying it is a slow leak
 * of the error budget Printify counts against us. "Parked" is asserted the only
 * way it can be — a second tick that calls nobody.
 *
 * **Ambiguity, which is the case that actually costs money.** A 2xx that came
 * back without an order id, and a 5xx that may have been raised after the
 * backend had already created the order, are not failures — they are unknowns,
 * and posting the same order again to resolve an unknown is how one customer
 * payment becomes two parcels and two charges against the merchant's own card.
 * The cases below count the OUTBOUND SUBMITS, because that is the only number
 * the duplicate shows up in: a second submission answers 200 with a perfectly
 * good id and looks like success from every other angle. Each of them proves
 * the lookup happened first and the submit count stayed at one.
 *
 * **The `paid` gate on release.** Submission and production are a hold window
 * apart, and `charge.dispute.created` lands inside windows like that. So a
 * `chargeback` or `refunded` order with a Printify id and no `released_at` must
 * not be manufactured — asserted by zero `send_to_production` calls — and a
 * `paid` one still must be, or the gate would pass by doing nothing at all.
 *
 * **The hold window**, which is the one piece of the manual approval window
 * automation can keep. Fifteen minutes between submit and release means a
 * submitted order is NOT released one minute later; a hold of zero means it is,
 * and `0` being a real setting rather than an absent one is asserted directly
 * because `Number(v) || DEFAULT` would silently turn it into fifteen minutes.
 *
 * **What lands in `fulfillment_last_error`.** It is a column an admin listing
 * reads out, and Printify's refusal bodies quote the offending field back —
 * which on this path is the buyer's street. The provider is given every chance
 * to leak one below and the stored string is inspected for it.
 *
 * Printify is stood in for at `fetch`, so the URL and JSON body actually put on
 * the wire are what the assertions read. Postgres is real: the claim queries,
 * `SKIP LOCKED`, and the backoff arithmetic are database behaviour, and a mock
 * of them would be a mock of the thing being proven.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { commerceOrdersTable, commerceProductsTable } from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";
import {
  AUTO_RELEASE_ACTOR,
  BACKOFF_CEILING_MS,
  DEFAULT_RELEASE_HOLD_MS,
  MAX_FULFILLMENT_ATTEMPTS,
  releaseHoldMs,
  runFulfillmentTickOnce,
} from "./commerceFulfillmentWorker";
import { releaseCommerceOrder } from "./commerceFulfillment";
import { getUncachablePrintifyClient } from "./printifyClient";
import { createTestUser, deleteUsersByIds, makeTestId } from "../test-helpers";

/** A token shaped like the real one, and never the real one. */
const TEST_TOKEN = "kax-test-printify-token-9c3e";
/** A shop id that is neither the Shopify store nor the KAX store. */
const TEST_SHOP_ID = "10000002";

/** What the order was charged against. None of this may reach a stored string. */
const SNAPSHOT_ADDRESS = {
  shipToName: "Ada Test Buyer",
  shipToLine1: "1 Snapshot Way",
  shipToLine2: "Apt 4",
  shipToCity: "Portland",
  shipToRegion: "OR",
  shipToPostalCode: "97201",
  shipToCountry: "US",
  shipToPhone: "+15035550100",
} as const;

const ITEM_CENTS = 1055;
const SHIPPING_CENTS = 509;
const PRINTIFY_PRODUCT_ID = "6a81f8c84b2b4c5db504b97f";
const PRINTIFY_VARIANT_ID = "45750";

const MINUTE_MS = 60_000;

interface OutboundCall {
  url: string;
  method: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

interface StubResponse {
  status: number;
  body: string;
  /**
   * Make `res.text()` reject.
   *
   * This is the only way to get a NON-`PrintifyError` out of the adapter from
   * outside it: a transport failure is converted to `PrintifyError(0)` at the
   * `fetch` boundary and every refusal is converted by `toPrintifyError`, but
   * the body read sits past both. It stands in for the whole class of "our bug,
   * not the order's" — a driver fault, a pool exhaustion, a programming error.
   */
  textRejects?: string;
}

/**
 * One row of `GET /shops/{id}/orders.json`, in the shape a live response
 * actually has.
 *
 * Captured from the real API, and the important thing about it is what is NOT
 * here: there is **no top-level `external_id`**. Printify does not return one,
 * in this projection or in `GET /orders/{id}.json`. The value we POST as
 * `external_id` comes back inside `metadata`, as `shop_order_label`. Fixtures
 * that invented a top-level `external_id` are what let a lookup which read
 * `row.external_id` pass every test while matching nothing in production —
 * where it answered "definitively absent" and authorised a second parcel.
 *
 * `externalId` is an OPTIONAL extra here, used only by the case that proves the
 * fallback still works if a plan or an API version starts sending one.
 */
function printifyOrderRow(opts: {
  id: string;
  label: string;
  status?: string;
  externalId?: string;
}): Record<string, unknown> {
  return {
    id: opts.id,
    app_order_id: null,
    shop_id: Number(TEST_SHOP_ID),
    // A full buyer address on every row, which is why `readOrderPage` lifts
    // three fields and drops the rest at the parse boundary. On a reconcile
    // scan most of these belong to OTHER buyers.
    address_to: {
      first_name: "Someone",
      last_name: "Else",
      country: "US",
      region: "NY",
      address1: "500 Not Our Street",
      city: "New York",
      zip: "10001",
    },
    line_items: [{ variant_id: 65212, quantity: 1 }],
    metadata: {
      order_type: "external",
      shop_order_id: 987654321,
      shop_order_label: opts.label,
    },
    total_price: 354,
    total_shipping: 509,
    total_tax: 0,
    status: opts.status ?? "on-hold",
    shipping_method: 1,
    created_at: "2026-08-14 18:02:11+00:00",
    sent_to_production_at: null,
    fulfilment_type: "ordinary",
    printify_connect: { url: null, id: null },
    sales_channel_type_id: 1,
    ...(opts.externalId !== undefined ? { external_id: opts.externalId } : {}),
  };
}

/**
 * One page of the order list, envelope and all.
 *
 * The envelope is the real one: `current_page`, `last_page` and `total` are the
 * fields `readOrderPage` now requires as positive evidence that it is looking at
 * a page it understands, so a fixture that omits them is a fixture asserting the
 * unparseable-page behaviour whether it meant to or not.
 */
function orderListPage(
  rows: Array<Record<string, unknown>>,
  opts: { currentPage?: number; lastPage?: number; total?: number } = {},
): Record<string, unknown> {
  const currentPage = opts.currentPage ?? 1;
  const lastPage = opts.lastPage ?? 1;
  return {
    current_page: currentPage,
    data: rows,
    first_page_url: "https://api.printify.com/v1/shops/x/orders.json?page=1",
    from: rows.length === 0 ? null : 1,
    last_page: lastPage,
    last_page_url: `https://api.printify.com/v1/shops/x/orders.json?page=${lastPage}`,
    links: [],
    next_page_url: currentPage < lastPage ? `...page=${currentPage + 1}` : null,
    path: "https://api.printify.com/v1/shops/x/orders.json",
    per_page: 50,
    prev_page_url: currentPage > 1 ? `...page=${currentPage - 1}` : null,
    to: rows.length === 0 ? null : rows.length,
    total: opts.total ?? rows.length,
  };
}

let outbound: OutboundCall[] = [];
/** What a submit or a send-to-production (POST) is answered with. */
let nextResponse: StubResponse = { status: 200, body: "{}" };
/**
 * What a reconcile lookup (GET) is answered with. The default is a completed,
 * empty list — a definitive "Printify does not have this order" — so a case
 * that does not care answers the safe thing rather than a surprise.
 */
let nextLookupResponse: StubResponse = {
  status: 200,
  body: JSON.stringify(orderListPage([])),
};

function respondWith(status: number, body: unknown): void {
  nextResponse = { status, body: typeof body === "string" ? body : JSON.stringify(body) };
}

function respondToLookupWith(status: number, body: unknown): void {
  nextLookupResponse = { status, body: typeof body === "string" ? body : JSON.stringify(body) };
}

/** One page of Printify's order list holding exactly this order, and nothing else. */
function lookupFinds(clientReference: string, printifyOrderId: string): void {
  respondToLookupWith(
    200,
    orderListPage([printifyOrderRow({ id: printifyOrderId, label: clientReference })]),
  );
}

/** A completed page of somebody else's orders: a genuine, provable absence. */
function lookupFindsSomebodyElse(): void {
  respondToLookupWith(
    200,
    orderListPage([printifyOrderRow({ id: "printify_order_someone_else", label: randomUUID() })]),
  );
}

/** The next POST fails on the body read rather than on the wire or the status. */
function failNextBodyRead(message: string): void {
  nextResponse = { ...nextResponse, textRejects: message };
}

function installFetchStub(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init: Record<string, unknown> = {}) => {
      const headers = (init["headers"] ?? {}) as Record<string, string>;
      const method = String(init["method"] ?? "GET");
      outbound.push({
        url: String(input),
        method,
        authorization: headers["Authorization"],
        body: init["body"] ? (JSON.parse(String(init["body"])) as Record<string, unknown>) : {},
      });
      const { status, body, textRejects } = method === "GET" ? nextLookupResponse : nextResponse;
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => {
          if (textRejects !== undefined) throw new Error(textRejects);
          return body;
        },
      } as unknown as Response;
    }),
  );
}

/**
 * Submissions, and only submissions.
 *
 * This is the count that separates one parcel from two. A reconcile lookup and
 * a send-to-production both reach Printify as well, so a bare `outbound.length`
 * would go up for reasons that cost nothing and hide the one that costs $12 and
 * a customer.
 */
function submitCalls(): OutboundCall[] {
  return outbound.filter((c) => c.method === "POST" && c.url.endsWith("/orders.json"));
}

/** Reconcile lookups: the reads that make a resubmission safe or forbid it. */
function lookupCalls(): OutboundCall[] {
  return outbound.filter((c) => c.method === "GET");
}

/** The call that actually manufactures something. */
function productionCalls(): OutboundCall[] {
  return outbound.filter((c) => c.url.includes("send_to_production"));
}

const ENV_KEYS = [
  "KAX_PRINTIFY_ENABLED",
  "KAX_PRINTIFY_API_TOKEN",
  "KAX_PRINTIFY_SHOP_ID",
  "KAX_PRINTIFY_CONTACT_EMAIL",
  "KAX_PRINTIFY_AUTO_FULFILL",
  "KAX_PRINTIFY_AUTO_RELEASE_HOLD_MS",
] as const;

describe("automatic Printify fulfilment", () => {
  const priorEnv = new Map<string, string | undefined>();
  const userIds: string[] = [];
  let buyerId: string;
  let sku: string;

  beforeEach(async () => {
    outbound = [];
    respondWith(200, { id: "printify_order_1", status: "on-hold" });
    respondToLookupWith(200, orderListPage([]));
    installFetchStub();

    for (const key of ENV_KEYS) priorEnv.set(key, process.env[key]);
    process.env["KAX_PRINTIFY_ENABLED"] = "1";
    process.env["KAX_PRINTIFY_AUTO_FULFILL"] = "1";
    process.env["KAX_PRINTIFY_API_TOKEN"] = TEST_TOKEN;
    process.env["KAX_PRINTIFY_SHOP_ID"] = TEST_SHOP_ID;
    delete process.env["KAX_PRINTIFY_CONTACT_EMAIL"];
    delete process.env["KAX_PRINTIFY_AUTO_RELEASE_HOLD_MS"];

    // The worker scans the whole table rather than an id handed to it, so a
    // claimable order left behind by another file would be picked up by these
    // ticks and counted in `outbound`. Only rows owned by the test prefix are
    // ever touched.
    await db.delete(commerceOrdersTable).where(like(commerceOrdersTable.buyerUserId, "kax-test-%"));

    const buyer = await createTestUser();
    buyerId = buyer.id;
    userIds.push(buyer.id);

    sku = makeTestId("sku");
    await db.insert(commerceProductsTable).values({
      sku,
      title: "KAX Test Sticker",
      itemCents: ITEM_CENTS,
      shippingCents: SHIPPING_CENTS,
      published: true,
      printifyProductId: PRINTIFY_PRODUCT_ID,
      printifyVariantId: PRINTIFY_VARIANT_ID,
      shipToCountries: ["US"],
    });
  });

  afterEach(async () => {
    // Single-fork runner: a leaked flag decides which branch a later file takes.
    for (const key of ENV_KEYS) {
      const prior = priorEnv.get(key);
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
    vi.unstubAllGlobals();
    await deleteUsersByIds(userIds.splice(0));
    await db.delete(commerceProductsTable).where(like(commerceProductsTable.sku, "kax-test-%"));
  });

  afterAll(async () => {
    await db.delete(commerceProductsTable).where(like(commerceProductsTable.sku, "kax-test-%"));
  });

  async function makeOrder(
    overrides: Partial<typeof commerceOrdersTable.$inferInsert> = {},
  ): Promise<typeof commerceOrdersTable.$inferSelect> {
    const [order] = await db
      .insert(commerceOrdersTable)
      .values({
        clientReference: randomUUID(),
        buyerUserId: buyerId,
        sku,
        itemCents: ITEM_CENTS,
        shippingCents: SHIPPING_CENTS,
        totalCents: ITEM_CENTS + SHIPPING_CENTS,
        status: "paid",
        stripePaymentIntentId: `pi_test_${randomUUID()}`,
        ...SNAPSHOT_ADDRESS,
        ...overrides,
      })
      .returning();
    return order;
  }

  /** An order already at Printify, submitted `agoMs` ago. */
  function makeSubmittedOrder(
    agoMs: number,
    overrides: Partial<typeof commerceOrdersTable.$inferInsert> = {},
    now: Date = new Date(),
  ) {
    return makeOrder({
      printifyOrderId: "printify_order_1",
      fulfillmentState: "submitted",
      submittedAt: new Date(now.getTime() - agoMs),
      ...overrides,
    });
  }

  function reload(id: number) {
    return db
      .select()
      .from(commerceOrdersTable)
      .where(eq(commerceOrdersTable.id, id))
      .limit(1)
      .then((rows) => rows[0]);
  }

  // ── Off by default, and off means off ────────────────────────────────────

  describe("inert unless both flags are on", () => {
    it("calls nobody and touches nothing with KAX_PRINTIFY_AUTO_FULFILL unset", async () => {
      // The order used here is a perfectly submittable paid one, so a quiet tick
      // can only be the gate — and the row is re-read afterwards, because a gate
      // that logged "disabled" after doing the work would otherwise pass.
      const order = await makeOrder();
      delete process.env["KAX_PRINTIFY_AUTO_FULFILL"];

      const result = await runFulfillmentTickOnce();
      expect(result.skipped).toBe("disabled");
      expect(outbound, "an unarmed worker reached the printer").toHaveLength(0);

      const after = (await reload(order.id))!;
      expect(after.printifyOrderId).toBeNull();
      expect(after.fulfillmentState).toBe("unfulfilled");
      expect(after.fulfillmentAttempts).toBe(0);
    });

    it("calls nobody and touches nothing with KAX_PRINTIFY_ENABLED unset", async () => {
      // The other flag. Automation must not be able to arm the fulfilment
      // surface that `printifyEnabled()` is the master switch for.
      const order = await makeOrder();
      delete process.env["KAX_PRINTIFY_ENABLED"];

      const result = await runFulfillmentTickOnce();
      expect(result.skipped).toBe("disabled");
      expect(outbound).toHaveLength(0);

      const after = (await reload(order.id))!;
      expect(after.printifyOrderId).toBeNull();
      expect(after.fulfillmentAttempts).toBe(0);
    });

    it("does the work once both flags are on", async () => {
      // The other half of the two cases above. Without it they would both pass
      // against a worker that was simply broken.
      const order = await makeOrder();
      const result = await runFulfillmentTickOnce();

      expect(result.skipped).toBeNull();
      expect(result.submitted).toBe(1);
      expect((await reload(order.id))!.printifyOrderId).toBe("printify_order_1");
    });

    it("burns no attempt when the flag is on but Printify is not configured", async () => {
      // A missing token is a fact about the deployment, not about the order.
      // Parking paid orders over it would turn an unset env var into a manual
      // repair job across every order that happened to be due.
      const order = await makeOrder();
      delete process.env["KAX_PRINTIFY_API_TOKEN"];

      const result = await runFulfillmentTickOnce();
      expect(result.skipped).toBe("not_configured");
      expect(outbound).toHaveLength(0);

      const after = (await reload(order.id))!;
      expect(after.fulfillmentAttempts, "an unconfigured deployment spent the order's budget").toBe(0);
      expect(after.fulfillmentLastError).toBeNull();
      expect(after.printifyOrderId).toBeNull();
    });
  });

  // ── Charge first, then submit — unattended ───────────────────────────────

  describe("the submit pass", () => {
    it("submits a paid order to the configured shop, one line item, quantity one", async () => {
      const order = await makeOrder();
      await runFulfillmentTickOnce();

      // Two calls, in this order: the reconcile lookup that proves Printify does
      // not already have this order, and then the submission.
      expect(outbound).toHaveLength(2);
      expect(outbound[0].method).toBe("GET");
      expect(submitCalls()).toHaveLength(1);
      const call = submitCalls()[0];
      expect(call.method).toBe("POST");
      expect(call.url).toBe(`https://api.printify.com/v1/shops/${TEST_SHOP_ID}/orders.json`);
      expect(call.authorization).toBe(`Bearer ${TEST_TOKEN}`);
      // external_id is the order's own idempotency key, which is what makes a
      // submission whose response was lost findable by name at Printify rather
      // than guessed at — and unattended, nobody is watching for the loss.
      expect(call.body["external_id"]).toBe(order.clientReference);
      expect(call.body["line_items"]).toEqual([
        { product_id: PRINTIFY_PRODUCT_ID, variant_id: Number(PRINTIFY_VARIANT_ID), quantity: 1 },
      ]);

      const after = (await reload(order.id))!;
      expect(after.printifyOrderId).toBe("printify_order_1");
      expect(after.fulfillmentState).toBe("submitted");
      expect(after.submittedAt).not.toBeNull();
    });

    it("leaves an unpaid order alone", async () => {
      // The rule the whole feature is arranged around, and the one automation
      // could break silently: Printify charges the merchant's card at
      // submission, so an unpaid submission is manufacturing bought for an
      // order that may never settle. Remove `status = 'paid'` from the claim
      // and the call count below goes up.
      for (const status of ["pending_payment", "authenticating", "payment_failed", "refunded"]) {
        const order = await makeOrder({ status });
        await runFulfillmentTickOnce();
        const after = (await reload(order.id))!;
        expect(after.printifyOrderId, `status ${status}`).toBeNull();
        expect(after.fulfillmentAttempts, `status ${status} burnt an attempt`).toBe(0);
      }
      expect(outbound, "nothing unpaid reached the printer").toHaveLength(0);
    });

    it("does not resubmit an order that already has a Printify id", async () => {
      // `printify_order_id IS NOT NULL`, in the claim query and again under the
      // row lock. A second submission is a second parcel and a second charge to
      // the merchant's own card, and on a timer it would be one per minute.
      const order = await makeSubmittedOrder(0);
      // A hold long enough that the release pass cannot account for a call.
      process.env["KAX_PRINTIFY_AUTO_RELEASE_HOLD_MS"] = String(60 * MINUTE_MS);

      await runFulfillmentTickOnce();

      expect(outbound, "an already-submitted order was submitted again").toHaveLength(0);
      expect((await reload(order.id))!.printifyOrderId).toBe("printify_order_1");
    });

    it("parks a product with no Printify identifiers instead of retrying it forever", async () => {
      // A missing variant id is a configuration fact, not a transient one. It
      // will still be missing in six hours, and the order is better off in an
      // operator's hands than in a retry loop.
      await db
        .update(commerceProductsTable)
        .set({ printifyVariantId: null })
        .where(eq(commerceProductsTable.sku, sku));
      const order = await makeOrder();

      const result = await runFulfillmentTickOnce();
      expect(result.parked).toBe(1);
      // The reconcile lookup runs first and costs a GET; nothing is POSTED,
      // which is the property that matters. An unprintable order reaches the
      // printer not at all.
      expect(submitCalls()).toHaveLength(0);

      const after = (await reload(order.id))!;
      expect(after.fulfillmentAttempts).toBe(MAX_FULFILLMENT_ATTEMPTS);
      expect(after.fulfillmentLastError).toBe("product_not_printable");
    });
  });

  // ── The retry ladder ─────────────────────────────────────────────────────

  describe("what happens when Printify refuses", () => {
    it("schedules a retry for a 500, then reconciles before it resubmits", async () => {
      const order = await makeOrder();
      respondWith(500, { code: 500, message: "Internal error" });

      const first = await runFulfillmentTickOnce();
      expect(first.retryScheduled).toBe(1);
      expect(submitCalls()).toHaveLength(1);

      const afterFailure = (await reload(order.id))!;
      expect(afterFailure.fulfillmentAttempts).toBe(1);
      expect(afterFailure.fulfillmentLastError).toBe("500:500");
      // The transaction rolled back with the refusal, so the order is exactly as
      // submittable as it was before.
      expect(afterFailure.printifyOrderId).toBeNull();
      expect(afterFailure.fulfillmentState).toBe("unfulfilled");
      expect(afterFailure.fulfillmentNextAttemptAt).not.toBeNull();
      expect(
        afterFailure.fulfillmentNextAttemptAt!.getTime(),
        "a failed attempt is due again immediately, so the next tick hammers it",
      ).toBeGreaterThan(Date.now());

      // Nothing is retried before its time...
      outbound = [];
      respondWith(200, { id: "printify_order_2", status: "on-hold" });
      await runFulfillmentTickOnce();
      expect(outbound, "the backoff was not waited out").toHaveLength(0);

      // ...and after it, the retry is NOT a blind repost. A 5xx can be raised
      // by a backend that already created the order, so the order is looked up
      // by `external_id` first and posted again only because the completed
      // search proved it absent. The lookup being outbound[0] is the assertion:
      // reverse the two and the reconciliation is decoration.
      const later = new Date(Date.now() + 10 * MINUTE_MS);
      const second = await runFulfillmentTickOnce(later);
      expect(second.submitted).toBe(1);
      expect(lookupCalls(), "resubmitted without asking whether the 500 had created the order").toHaveLength(1);
      expect(outbound[0].method, "the resubmission came before the lookup").toBe("GET");
      expect(submitCalls()).toHaveLength(1);
      expect((await reload(order.id))!.printifyOrderId).toBe("printify_order_2");
    });

    it("backs off further on each successive refusal", async () => {
      // Exponential, not fixed: a provider incident that outlasts one minute
      // must not be met with one request a minute for its whole duration —
      // Printify counts an error rate above 5% of total requests as a violation
      // in its own right.
      const order = await makeOrder();
      respondWith(503, { code: 503, message: "Service unavailable" });

      const base = Date.now();
      await runFulfillmentTickOnce(new Date(base));
      const firstDelay =
        (await reload(order.id))!.fulfillmentNextAttemptAt!.getTime() - base;

      const secondAt = base + 60 * MINUTE_MS;
      await runFulfillmentTickOnce(new Date(secondAt));
      const afterSecond = (await reload(order.id))!;
      const secondDelay = afterSecond.fulfillmentNextAttemptAt!.getTime() - secondAt;

      expect(afterSecond.fulfillmentAttempts).toBe(2);
      expect(secondDelay).toBeGreaterThan(firstDelay);
    });

    it("parks a 400 immediately, and the next tick calls nobody", async () => {
      // The asymmetry that matters. A rejected address is rejected again
      // tomorrow, so there is nothing to wait for — and each pointless retry is
      // another error against the rate Printify measures us by. Parking is
      // asserted the only way it can be: by a second tick that reaches no one.
      const order = await makeOrder();
      respondWith(400, { code: 8251, message: "Order could not be published" });

      const first = await runFulfillmentTickOnce();
      expect(first.parked).toBe(1);
      expect(first.retryScheduled).toBe(0);
      expect(submitCalls()).toHaveLength(1);

      const afterFailure = (await reload(order.id))!;
      expect(afterFailure.fulfillmentAttempts).toBe(MAX_FULFILLMENT_ATTEMPTS);
      expect(afterFailure.fulfillmentLastError).toBe("400:8251");
      expect(afterFailure.printifyOrderId, "a refused order stayed submittable").toBeNull();

      outbound = [];
      // Well past any backoff a retryable failure would have set.
      await runFulfillmentTickOnce(new Date(Date.now() + 24 * 60 * MINUTE_MS));
      expect(outbound, "a parked order was picked up again").toHaveLength(0);
    });

    it("stores the provider's status and code, and nothing the provider wrote", async () => {
      // Printify's 4xx bodies quote the offending field back, which on this path
      // is the buyer's street — and `fulfillment_last_error` is a column the
      // admin listing reads out. Pass the body through instead of the status
      // pair and every `not.toContain` below fails.
      const order = await makeOrder();
      respondWith(422, {
        code: 8252,
        message: `address_to.zip "${SNAPSHOT_ADDRESS.shipToPostalCode}" is invalid for ${SNAPSHOT_ADDRESS.shipToLine1}`,
        errors: {
          reason: `${SNAPSHOT_ADDRESS.shipToName}, ${SNAPSHOT_ADDRESS.shipToCity}`,
          token: TEST_TOKEN,
        },
      });

      await runFulfillmentTickOnce();

      const stored = (await reload(order.id))!.fulfillmentLastError;
      expect(stored).toBe("422:8252");
      for (const secret of [
        TEST_TOKEN,
        SNAPSHOT_ADDRESS.shipToLine1,
        SNAPSHOT_ADDRESS.shipToPostalCode,
        SNAPSHOT_ADDRESS.shipToCity,
        SNAPSHOT_ADDRESS.shipToName,
        SNAPSHOT_ADDRESS.shipToPhone,
      ]) {
        expect(stored, `"${secret}" reached fulfillment_last_error`).not.toContain(secret);
      }
    });
  });

  // ── Ambiguity: the case where a retry is a second parcel ─────────────────

  describe("a submission whose outcome is unknown", () => {
    it("does not submit twice when Printify answers 2xx with no order id", async () => {
      // THE money case. `res.ok` was true, so Printify accepted the order and
      // it exists — the only thing missing is its name. Retrying that is not a
      // retry, it is a second order: a second parcel, a second charge to the
      // merchant's card, both against one customer payment.
      //
      // The submit count is the whole assertion. A duplicate submission answers
      // 200 with a perfectly good id and is indistinguishable from success in
      // every other observable, which is exactly why it went unnoticed.
      process.env["KAX_PRINTIFY_AUTO_RELEASE_HOLD_MS"] = String(60 * MINUTE_MS);
      const order = await makeOrder();
      respondWith(200, { status: "on-hold" });

      const first = await runFulfillmentTickOnce();
      expect(submitCalls()).toHaveLength(1);
      expect(first.submitted, "an order with no id was recorded as submitted").toBe(0);

      const afterFirst = (await reload(order.id))!;
      expect(afterFirst.printifyOrderId).toBeNull();
      expect(afterFirst.fulfillmentLastError).toBe("submission_ambiguous");
      // Not parked: the worker can resolve this one itself, and a lookup costs
      // an operator nothing.
      expect(afterFirst.fulfillmentAttempts).toBe(1);
      expect(afterFirst.fulfillmentAttempts).toBeLessThan(MAX_FULFILLMENT_ATTEMPTS);

      // The order is at Printify under the external_id we sent, which is what
      // external_id has been carrying `client_reference` for since day one.
      lookupFinds(order.clientReference, "printify_order_recovered");
      // If a second submission were made it would land on this, and it would
      // look like a clean success.
      respondWith(200, { id: "printify_order_DUPLICATE", status: "on-hold" });

      const second = await runFulfillmentTickOnce(new Date(Date.now() + 10 * MINUTE_MS));
      expect(second.reconciled).toBe(1);
      // Two lookups across two ticks: every submission is preceded by one, so
      // the first tick asked as well and was told the order was not there yet.
      expect(lookupCalls()).toHaveLength(2);
      expect(submitCalls(), "the same order was posted to Printify twice").toHaveLength(1);

      const after = (await reload(order.id))!;
      expect(after.printifyOrderId).toBe("printify_order_recovered");
      expect(after.fulfillmentState).toBe("submitted");
      expect(after.submittedAt).not.toBeNull();
      // Reconciliation costs the order nothing: the doubt is resolved, so the
      // budget is restored exactly as a clean submission would restore it.
      expect(after.fulfillmentAttempts).toBe(0);
      expect(after.fulfillmentLastError).toBeNull();

      // A third tick, well past everything, still posts nothing.
      await runFulfillmentTickOnce(new Date(Date.now() + 30 * MINUTE_MS));
      expect(submitCalls(), "a reconciled order was submitted again later").toHaveLength(1);
    });

    it("treats an empty 2xx body as the same unknown", async () => {
      // `printifyFetch` turns a zero-length body into `{}` rather than raising,
      // so this reaches `readOrderRef` by a different route and must come out
      // at the same place. A body-shaped check that only looked for a missing
      // `id` KEY would pass the case above and fail this one.
      const order = await makeOrder();
      respondWith(200, "");

      await runFulfillmentTickOnce();
      expect(submitCalls()).toHaveLength(1);
      expect((await reload(order.id))!.fulfillmentLastError).toBe("submission_ambiguous");

      lookupFinds(order.clientReference, "printify_order_recovered");
      respondWith(200, { id: "printify_order_DUPLICATE", status: "on-hold" });
      const second = await runFulfillmentTickOnce(new Date(Date.now() + 10 * MINUTE_MS));

      expect(second.reconciled).toBe(1);
      expect(submitCalls()).toHaveLength(1);
      expect((await reload(order.id))!.printifyOrderId).toBe("printify_order_recovered");
    });

    it("submits again once a completed search proves the order absent", async () => {
      // The other half, and without it every case above would pass against a
      // worker that had simply stopped submitting. "Absent" has to mean absent:
      // a lookup that reaches the end of the list without a match is the one
      // thing that makes a repost safe, and it must actually let it through.
      const order = await makeOrder();
      respondWith(200, { status: "on-hold" });
      await runFulfillmentTickOnce();
      expect(submitCalls()).toHaveLength(1);

      // A page of somebody else's orders, and the end of the list.
      lookupFindsSomebodyElse();
      respondWith(200, { id: "printify_order_2", status: "on-hold" });

      const second = await runFulfillmentTickOnce(new Date(Date.now() + 10 * MINUTE_MS));
      expect(second.reconciled).toBe(0);
      expect(second.submitted).toBe(1);
      // One per submission attempt, across both ticks.
      expect(lookupCalls()).toHaveLength(2);
      expect(submitCalls()).toHaveLength(2);
      expect((await reload(order.id))!.printifyOrderId).toBe("printify_order_2");
    });

    it("does not resubmit on the strength of a lookup that failed", async () => {
      // A failed lookup answers nothing. Treating "we could not look" as "it is
      // not there" would put the duplicate back, wearing the reconciliation as
      // a disguise — so the marker is kept, an attempt is charged, and the next
      // due tick looks again instead of posting.
      const order = await makeOrder();
      respondWith(200, { status: "on-hold" });
      await runFulfillmentTickOnce();
      expect(submitCalls()).toHaveLength(1);

      respondToLookupWith(503, { code: 503, message: "Service unavailable" });
      respondWith(200, { id: "printify_order_DUPLICATE", status: "on-hold" });

      const second = await runFulfillmentTickOnce(new Date(Date.now() + 10 * MINUTE_MS));
      expect(second.reconciled).toBe(0);
      expect(second.retryScheduled).toBe(1);
      expect(lookupCalls()).toHaveLength(2);
      expect(submitCalls(), "resubmitted after a search that answered nothing").toHaveLength(1);

      const after = (await reload(order.id))!;
      expect(after.printifyOrderId).toBeNull();
      expect(after.fulfillmentAttempts, "a failed lookup cost the order nothing").toBe(2);
      expect(after.fulfillmentLastError, "the doubt was cleared by a failure").toBe(
        "submission_ambiguous",
      );
    });

    it("does not read a search that ran out of pages as an absence", async () => {
      // The subtle version of the same mistake. A pager that gives up and
      // returns "not found" is a pager that authorises a duplicate, so hitting
      // the page budget raises instead — and the order is left unreconciled
      // rather than resubmitted.
      const order = await makeOrder();
      respondWith(200, { status: "on-hold" });
      await runFulfillmentTickOnce();
      expect(submitCalls()).toHaveLength(1);

      // Every page full of other people's orders, and the list never ends.
      respondToLookupWith(
        200,
        orderListPage(
          [printifyOrderRow({ id: "printify_order_someone_else", label: randomUUID() })],
          { lastPage: 999, total: 49_950 },
        ),
      );
      respondWith(200, { id: "printify_order_DUPLICATE", status: "on-hold" });

      const second = await runFulfillmentTickOnce(new Date(Date.now() + 10 * MINUTE_MS));
      expect(second.reconciled).toBe(0);
      expect(lookupCalls().length, "the pager gave up after one page").toBeGreaterThan(1);
      expect(submitCalls(), "an exhausted search was read as an absence").toHaveLength(1);
      expect((await reload(order.id))!.fulfillmentLastError).toBe("submission_ambiguous");
    });

    it("matches the label exactly and adopts nobody else's order", async () => {
      // The adopted id is written onto a paid customer's row and is what every
      // later step acts on. A prefix or case-insensitive match here would send
      // somebody else's parcel to production against this buyer's money.
      const order = await makeOrder();
      respondWith(200, { status: "on-hold" });
      await runFulfillmentTickOnce();

      respondToLookupWith(
        200,
        orderListPage([
          printifyOrderRow({ id: "printify_order_prefix", label: order.clientReference.slice(0, 8) }),
          printifyOrderRow({ id: "printify_order_upper", label: order.clientReference.toUpperCase() }),
          printifyOrderRow({ id: "printify_order_suffixed", label: `${order.clientReference}-2` }),
        ]),
      );
      respondWith(200, { id: "printify_order_2", status: "on-hold" });

      await runFulfillmentTickOnce(new Date(Date.now() + 10 * MINUTE_MS));

      const after = (await reload(order.id))!;
      expect(after.printifyOrderId, "adopted an order that was not ours").toBe("printify_order_2");
    });

    it("finds the order by metadata.shop_order_label, which is the only place it comes back", async () => {
      // BLOCKER 1, stated as a test. The lookup used to read `row.external_id`,
      // which no Printify response carries: every row yielded null, no page ever
      // matched, the scan reached the declared last page and the function
      // answered `null` — "definitively absent" — to the one caller whose next
      // move was to post the order again. The guard against a duplicate was the
      // thing guaranteeing one.
      //
      // The row below is built by `printifyOrderRow`, which has no top-level
      // `external_id` key at all. Read `external_id` first and this order is
      // never found; the submit count goes to two and the customer gets two
      // stickers on one payment.
      const order = await makeOrder();
      respondWith(200, { status: "on-hold" });
      await runFulfillmentTickOnce();
      expect(submitCalls()).toHaveLength(1);

      const page = orderListPage([
        printifyOrderRow({ id: "printify_order_by_label", label: order.clientReference }),
      ]);
      expect(
        (page["data"] as Array<Record<string, unknown>>)[0],
        "the fixture invented a field Printify does not send",
      ).not.toHaveProperty("external_id");
      respondToLookupWith(200, page);
      respondWith(200, { id: "printify_order_DUPLICATE", status: "on-hold" });

      const second = await runFulfillmentTickOnce(new Date(Date.now() + 10 * MINUTE_MS));
      expect(second.reconciled).toBe(1);
      expect(submitCalls(), "matched on a field Printify never returns").toHaveLength(1);
      expect((await reload(order.id))!.printifyOrderId).toBe("printify_order_by_label");
    });

    it("still matches a top-level external_id if one is ever sent", async () => {
      // The fallback. No observed response carries `external_id`, but another
      // Printify plan or a later API version might, and a lookup that ignored it
      // would miss an order that was right there. Cheap to keep, and the cost of
      // missing is a second parcel.
      const order = await makeOrder();
      respondWith(200, { status: "on-hold" });
      await runFulfillmentTickOnce();

      respondToLookupWith(
        200,
        orderListPage([
          {
            ...printifyOrderRow({ id: "printify_order_by_external_id", label: "some-other-label" }),
            external_id: order.clientReference,
          },
        ]),
      );
      respondWith(200, { id: "printify_order_DUPLICATE", status: "on-hold" });

      const second = await runFulfillmentTickOnce(new Date(Date.now() + 10 * MINUTE_MS));
      expect(second.reconciled).toBe(1);
      expect(submitCalls()).toHaveLength(1);
      expect((await reload(order.id))!.printifyOrderId).toBe("printify_order_by_external_id");
    });

    it("does not read a page it could not parse as an absence", async () => {
      // BLOCKER 2. `Array.isArray(obj.data) ? obj.data : []` turned every
      // envelope the adapter did not recognise — a bare array, a `{}`, an
      // unexpected wrapper — into a page with no entries, which the pager then
      // read as the end of the list and reported as "definitively absent".
      //
      // Note the contradiction that produced: the SAME empty `{}` raises the
      // ambiguous error on the POST ("we cannot tell, do not resubmit") and used
      // to mean "certainly not there, resubmit" on the GET.
      //
      // Each shape below is answered to the lookup and must leave the order
      // unsubmitted, because the only honest answer to a page we cannot read is
      // that we still do not know.
      for (const shape of [
        {},
        [],
        { orders: [] },
        { data: [] },
        { data: [], last_page: 1 },
        { data: "nope", current_page: 1, last_page: 1, total: 0 },
        "<html>502 Bad Gateway</html>",
      ]) {
        outbound = [];
        // A readable, empty page for the FIRST tick, so that the ambiguous
        // submission below is reached the ordinary way and the unreadable page
        // is the only thing this iteration changes.
        respondToLookupWith(200, orderListPage([]));
        const order = await makeOrder();
        respondWith(200, { status: "on-hold" });
        await runFulfillmentTickOnce();
        expect(submitCalls(), `${JSON.stringify(shape)}: the first submission`).toHaveLength(1);

        respondToLookupWith(200, shape);
        respondWith(200, { id: "printify_order_DUPLICATE", status: "on-hold" });

        const second = await runFulfillmentTickOnce(new Date(Date.now() + 10 * MINUTE_MS));
        expect(second.reconciled, `${JSON.stringify(shape)}`).toBe(0);
        expect(
          submitCalls(),
          `an unreadable page (${JSON.stringify(shape)}) was read as an absence`,
        ).toHaveLength(1);

        const after = (await reload(order.id))!;
        expect(after.printifyOrderId, `${JSON.stringify(shape)}`).toBeNull();
        expect(after.fulfillmentLastError, `${JSON.stringify(shape)}`).toBe("submission_ambiguous");
        // Cleared so the next iteration's order is the only claimable row.
        await db.delete(commerceOrdersTable).where(eq(commerceOrdersTable.id, order.id));
      }
    });

    it("reconciles before a submission even when the row looks untouched", async () => {
      // BLOCKER 3, and it is the one the marker could never cover. The ambiguity
      // marker is written AFTER the POST returns, so the failures it exists for
      // — a crash inside the POST window, an OOM, a pod replaced mid-deploy, a
      // database that blinked — are exactly the failures that stop it being
      // written. What is left behind is a row that looks like it was never
      // tried: null id, zero attempts, null error.
      //
      // This is that row, and Printify already has the order. A guard that only
      // looked when the marker said to would post a second parcel here and
      // report a clean success.
      const order = await makeOrder();
      const before = (await reload(order.id))!;
      expect(before.printifyOrderId, "the row must look pristine, or this proves nothing").toBeNull();
      expect(before.fulfillmentAttempts).toBe(0);
      expect(before.fulfillmentLastError).toBeNull();

      lookupFinds(order.clientReference, "printify_order_from_lost_post");
      respondWith(200, { id: "printify_order_DUPLICATE", status: "on-hold" });

      const result = await runFulfillmentTickOnce();
      expect(result.reconciled).toBe(1);
      expect(result.submitted).toBe(0);
      expect(lookupCalls(), "submitted without asking whether Printify already had it").toHaveLength(1);
      expect(submitCalls(), "a lost POST became a second parcel").toHaveLength(0);

      const after = (await reload(order.id))!;
      expect(after.printifyOrderId).toBe("printify_order_from_lost_post");
      expect(after.fulfillmentState).toBe("submitted");
    });

    it("still submits a clean order, having looked first", async () => {
      // The positive control for the case above: reconciling unconditionally
      // must not mean submitting nothing. A fresh paid order gets one lookup,
      // which completes and proves absence, and then exactly one submission —
      // in that order, which is the assertion.
      const order = await makeOrder();

      const result = await runFulfillmentTickOnce();

      expect(result.submitted).toBe(1);
      expect(lookupCalls()).toHaveLength(1);
      expect(submitCalls()).toHaveLength(1);
      expect(outbound[0].method, "posted before asking").toBe("GET");
      expect((await reload(order.id))!.printifyOrderId).toBe("printify_order_1");
    });

    it("does not submit a never-tried order when the lookup itself fails", async () => {
      // The cost of reconciling unconditionally, stated honestly: while
      // Printify's list endpoint is unwell, nothing is submitted at all. That is
      // the safe direction — a delayed parcel is recoverable and a duplicate one
      // is not — and the marker says so in plain words rather than claiming an
      // ambiguity that never happened, because nothing was posted.
      const order = await makeOrder();
      respondToLookupWith(503, { code: 503, message: "Service unavailable" });

      const result = await runFulfillmentTickOnce();
      expect(result.retryScheduled).toBe(1);
      expect(submitCalls()).toHaveLength(0);

      const after = (await reload(order.id))!;
      expect(after.printifyOrderId).toBeNull();
      expect(after.fulfillmentAttempts).toBe(1);
      expect(after.fulfillmentLastError).toBe("reconcile_unavailable");
    });

    it("does not let a failed lookup erase an ambiguity it cannot resolve", async () => {
      // The marker-overwrite hole, from the other side. A row that already says
      // "a submission may be sitting at Printify" must not be downgraded to
      // "we could not look" by a lookup that failed — the second is a weaker
      // claim, and an operator reading it would act on the wrong one.
      const order = await makeOrder();
      respondWith(200, { status: "on-hold" });
      await runFulfillmentTickOnce();
      expect((await reload(order.id))!.fulfillmentLastError).toBe("submission_ambiguous");

      respondToLookupWith(503, { code: 503, message: "Service unavailable" });
      await runFulfillmentTickOnce(new Date(Date.now() + 10 * MINUTE_MS));

      expect(
        (await reload(order.id))!.fulfillmentLastError,
        "a real ambiguity was overwritten by a weaker marker",
      ).toBe("submission_ambiguous");
    });
  });

  // ── The hold window, and the release ─────────────────────────────────────

  describe("the release pass", () => {
    it("holds a freshly submitted order for the whole window", async () => {
      // The only part of the manual approval window automation can keep: an
      // operator watching the admin listing has this long to cancel at Printify
      // before anything is manufactured. Drop the `submitted_at <= now - hold`
      // clause and this releases immediately.
      const order = await makeSubmittedOrder(1 * MINUTE_MS);
      process.env["KAX_PRINTIFY_AUTO_RELEASE_HOLD_MS"] = String(15 * MINUTE_MS);

      const result = await runFulfillmentTickOnce();
      expect(result.released).toBe(0);
      expect(outbound, "an order one minute old was sent to production").toHaveLength(0);
      expect((await reload(order.id))!.releasedAt).toBeNull();
    });

    it("releases the same order once the window has passed", async () => {
      // The other half. Without it the case above would pass against a release
      // pass that never released anything at all.
      const order = await makeSubmittedOrder(1 * MINUTE_MS);
      process.env["KAX_PRINTIFY_AUTO_RELEASE_HOLD_MS"] = String(15 * MINUTE_MS);
      respondWith(200, { id: "printify_order_1", status: "in-production" });

      const result = await runFulfillmentTickOnce(new Date(Date.now() + 20 * MINUTE_MS));
      expect(result.released).toBe(1);
      expect((await reload(order.id))!.releasedAt).not.toBeNull();
    });

    it("treats a hold of zero as release immediately, not as no setting at all", async () => {
      // `Number(v) || DEFAULT` turns "0" into fifteen minutes, which is the bug
      // this asserts against: with a zero hold the same one-minute-old order
      // that the case above refused to touch goes to production now.
      const order = await makeSubmittedOrder(1 * MINUTE_MS);
      process.env["KAX_PRINTIFY_AUTO_RELEASE_HOLD_MS"] = "0";
      respondWith(200, { id: "printify_order_1", status: "in-production" });

      const result = await runFulfillmentTickOnce();
      expect(result.released).toBe(1);
      expect(outbound).toHaveLength(1);
      expect(outbound[0].url).toBe(
        `https://api.printify.com/v1/shops/${TEST_SHOP_ID}/orders/printify_order_1/send_to_production.json`,
      );
      expect((await reload(order.id))!.releasedAt).not.toBeNull();
    });

    it("records that nobody pressed the button", async () => {
      // `release_actor` exists to record whose decision production was. When it
      // was not a decision at all, the column has to say so — a blank, or worse
      // a borrowed admin id, would make an automatic release indistinguishable
      // from a human one in exactly the record kept to tell them apart.
      const order = await makeSubmittedOrder(1 * MINUTE_MS);
      process.env["KAX_PRINTIFY_AUTO_RELEASE_HOLD_MS"] = "0";
      respondWith(200, { id: "printify_order_1", status: "in-production" });

      await runFulfillmentTickOnce();

      const after = (await reload(order.id))!;
      expect(after.releasedAt).not.toBeNull();
      expect(after.fulfillmentState).toBe("in_production");
      expect(after.releaseActor).toBe(AUTO_RELEASE_ACTOR);
      expect(after.releaseActor).toBe("system:auto-fulfillment");
    });

    it("does not release the same order twice", async () => {
      const order = await makeSubmittedOrder(1 * MINUTE_MS);
      process.env["KAX_PRINTIFY_AUTO_RELEASE_HOLD_MS"] = "0";
      respondWith(200, { id: "printify_order_1", status: "in-production" });

      await runFulfillmentTickOnce();
      outbound = [];
      await runFulfillmentTickOnce();

      expect(outbound, "a released order was sent to production again").toHaveLength(0);
      expect((await reload(order.id))!.releaseActor).toBe(AUTO_RELEASE_ACTOR);
    });

    it("takes a paid order to production on the tick after the one that submitted it", async () => {
      // The documented shape of a zero hold, asserted rather than assumed. Both
      // passes judge dueness against the tick's nominal `now`, and the submit
      // pass stamps `submitted_at` from its own clock a hair after that — so the
      // order it just created is not yet due when the release pass looks, and a
      // zero hold means "no approval window" rather than "done within one tick".
      const order = await makeOrder();
      process.env["KAX_PRINTIFY_AUTO_RELEASE_HOLD_MS"] = "0";

      const first = await runFulfillmentTickOnce();
      expect(first.submitted).toBe(1);
      expect(first.released, "released against a submitted_at in its own future").toBe(0);

      respondWith(200, { id: "printify_order_1", status: "in-production" });
      const second = await runFulfillmentTickOnce();
      expect(second.released).toBe(1);

      const after = (await reload(order.id))!;
      expect(after.fulfillmentState).toBe("in_production");
      expect(after.releaseActor).toBe(AUTO_RELEASE_ACTOR);
    });
  });

  // ── Money that has gone back must not be manufactured against ────────────

  describe("release refuses an order whose money has gone", () => {
    /** Past its hold, due, and carrying an id — releasable in every other way. */
    async function makeReleasableOrder(status: string) {
      process.env["KAX_PRINTIFY_AUTO_RELEASE_HOLD_MS"] = "0";
      respondWith(200, { id: "printify_order_1", status: "in-production" });
      return makeSubmittedOrder(20 * MINUTE_MS, { status });
    }

    it("leaves a refunded or charged-back order alone, and manufactures nothing", async () => {
      // The timeline this exists for: submit at T, `charge.dispute.created` at
      // T+3, hold expires at T+15, and the worker sends a parcel to production
      // against money that is already gone. Latent while a human pressed the
      // button — they could see the status — and live the moment a timer does.
      //
      // `send_to_production` is the call that spends the money, so its count is
      // the assertion. Nothing else distinguishes a refusal from a release that
      // simply failed to record itself.
      for (const status of ["refunded", "chargeback"]) {
        const order = await makeReleasableOrder(status);

        const result = await runFulfillmentTickOnce();

        expect(result.released, `status ${status}`).toBe(0);
        expect(productionCalls(), `a ${status} order was sent to production`).toHaveLength(0);
        const after = (await reload(order.id))!;
        expect(after.releasedAt, `status ${status}`).toBeNull();
        expect(after.fulfillmentState, `status ${status}`).toBe("submitted");
        expect(after.releaseActor).toBeNull();
        // Not a failure, so no attempt is charged: the order is simply not for
        // manufacturing, and a won dispute may put it back to `paid`.
        expect(after.fulfillmentAttempts, `status ${status} burnt an attempt`).toBe(0);
      }
    });

    it("still releases a paid order", async () => {
      // The positive control. Without it the case above passes against a
      // release pass that has been broken outright, which is the failure mode a
      // "does nothing" gate always has.
      const order = await makeReleasableOrder("paid");

      const result = await runFulfillmentTickOnce();

      expect(result.released).toBe(1);
      expect(productionCalls()).toHaveLength(1);
      const after = (await reload(order.id))!;
      expect(after.releasedAt).not.toBeNull();
      expect(after.releaseActor).toBe(AUTO_RELEASE_ACTOR);
    });

    it("refuses under the row lock and not merely in the claim query", async () => {
      // This is the load-bearing half. The claim predicate is an optimiser — a
      // row that turns `chargeback` between the claim and the lock has to be
      // caught by the locked read, which is the only one that sees the order as
      // it is at the moment of the press. Calling `releaseCommerceOrder`
      // directly is how that is proven: it skips the claim entirely, so a fix
      // that only touched the claim query fails here.
      //
      // The manual admin endpoint takes exactly this path, which is why the
      // same hole was in the button as well as in the timer.
      const order = await makeSubmittedOrder(0, { status: "chargeback" });

      const outcome = await releaseCommerceOrder(
        db,
        getUncachablePrintifyClient(),
        order.id,
        AUTO_RELEASE_ACTOR,
      );

      expect(outcome.kind).toBe("not_paid");
      expect(outbound, "a charged-back order reached the printer").toHaveLength(0);
      const after = (await reload(order.id))!;
      expect(after.releasedAt).toBeNull();
      expect(after.fulfillmentState).toBe("submitted");
    });
  });

  // ── A broken row must not hold the front of the queue ────────────────────

  describe("failures that are ours rather than the order's", () => {
    /** The provider's own words, holding everything that must never be stored. */
    const LEAKY_MESSAGE = `parse failed for ${SNAPSHOT_ADDRESS.shipToLine1} with ${TEST_TOKEN}`;

    it("charges an attempt for an internal failure so the row yields its slot", async () => {
      // `claimSubmittable` is ORDER BY id LIMIT 10. A row that throws a
      // non-provider error every tick and is charged nothing for it is claimed
      // first every tick, forever — and the paid orders behind it are never
      // reached. The tick logs nothing either, because it did no work, so the
      // outage is invisible as well as total.
      //
      // The second tick is the assertion: with a backoff set the row is not due
      // and reaches nobody. Remove the charge and it is claimed immediately and
      // calls Printify again.
      const order = await makeOrder();
      failNextBodyRead(LEAKY_MESSAGE);

      const first = await runFulfillmentTickOnce();
      expect(first.retryScheduled).toBe(1);
      expect(submitCalls()).toHaveLength(1);

      const afterFirst = (await reload(order.id))!;
      expect(afterFirst.fulfillmentAttempts, "an internal failure cost the order nothing").toBe(1);
      expect(afterFirst.fulfillmentNextAttemptAt, "no backoff, so the row is due again now").not.toBeNull();
      expect(afterFirst.printifyOrderId).toBeNull();

      // An internal error cannot be placed before or after the provider call it
      // wraps, so the row carries the ambiguous marker and the next tick
      // reconciles rather than reposting.
      expect(afterFirst.fulfillmentLastError).toBe("submission_ambiguous");
      // Whatever the failure said, none of it is stored. `err.message` is text
      // this code did not write.
      for (const secret of [TEST_TOKEN, SNAPSHOT_ADDRESS.shipToLine1]) {
        expect(afterFirst.fulfillmentLastError, `"${secret}" was stored`).not.toContain(secret);
      }

      outbound = [];
      await runFulfillmentTickOnce();
      expect(outbound, "the broken row was claimed again on the very next tick").toHaveLength(0);
    });

    it("charges an attempt when the release pass fails internally too", async () => {
      // `claimReleasable` is the same ORDER BY id LIMIT 10 and starves the same
      // way. Release is never ambiguous — the id is already ours — so the
      // marker is the honest internal one and not the reconcile one.
      process.env["KAX_PRINTIFY_AUTO_RELEASE_HOLD_MS"] = "0";
      const order = await makeSubmittedOrder(20 * MINUTE_MS);
      failNextBodyRead(LEAKY_MESSAGE);

      const first = await runFulfillmentTickOnce();
      expect(first.retryScheduled).toBe(1);
      expect(productionCalls()).toHaveLength(1);

      const afterFirst = (await reload(order.id))!;
      expect(afterFirst.releasedAt).toBeNull();
      expect(afterFirst.fulfillmentAttempts).toBe(1);
      expect(afterFirst.fulfillmentNextAttemptAt).not.toBeNull();
      expect(afterFirst.fulfillmentLastError).toBe("internal_error");

      outbound = [];
      await runFulfillmentTickOnce();
      expect(outbound, "the broken row was claimed again on the very next tick").toHaveLength(0);
    });
  });

  // ── The whole ladder, walked ─────────────────────────────────────────────

  describe("the backoff ladder end to end", () => {
    it("walks 2, 4, 8, 16, 32 minutes to MAX on repeated retryable refusals", async () => {
      // The other cases park in one step, by spending the whole budget at once.
      // Nothing walked the ladder rung by rung, so nothing proved that a
      // provider incident actually ENDS: that six attempts is six and not
      // sixteen, that each wait is twice the last, and that the row leaves the
      // worker's world when the budget is gone rather than retrying forever.
      //
      // 429 and not 500, deliberately: a 429 is the one retryable answer that
      // is NOT ambiguous — the provider is telling us it did not take the
      // request — so this walks the retry ladder without dragging the reconcile
      // path in with it.
      const order = await makeOrder();
      respondWith(429, { code: 429, message: "Too many requests" });

      const base = Date.now();
      const delays: number[] = [];
      let at = base;
      for (let attempt = 1; attempt <= MAX_FULFILLMENT_ATTEMPTS; attempt += 1) {
        const result = await runFulfillmentTickOnce(new Date(at));
        expect(result.retryScheduled, `attempt ${attempt}`).toBe(1);
        const row = (await reload(order.id))!;
        expect(row.fulfillmentAttempts, `attempt ${attempt}`).toBe(attempt);
        expect(row.fulfillmentLastError).toBe("429:429");
        delays.push(row.fulfillmentNextAttemptAt!.getTime() - at);
        // Jump to exactly when the worker says the row is due again, so the
        // ladder is read off the row's own arithmetic and not off a guess.
        at = row.fulfillmentNextAttemptAt!.getTime();
      }

      expect(delays.map((ms) => ms / MINUTE_MS)).toEqual([2, 4, 8, 16, 32, 64]);
      // The number the header claims. Five waits between six attempts, which is
      // 62 minutes of retrying and not the "roughly two hours" it used to say —
      // the sixth delay is written onto a row that has already left the queue.
      const spentRetrying = delays.slice(0, -1).reduce((a, b) => a + b, 0);
      expect(spentRetrying / MINUTE_MS).toBe(62);
      // Every rung is under the clamp, which is the honest statement of what
      // the clamp does at this attempt budget: nothing. It is a guard on a
      // future edit, and a test that pretended it fired would be fiction.
      for (const delay of delays) expect(delay).toBeLessThanOrEqual(BACKOFF_CEILING_MS);

      expect((await reload(order.id))!.fulfillmentAttempts).toBe(MAX_FULFILLMENT_ATTEMPTS);
      expect(submitCalls()).toHaveLength(MAX_FULFILLMENT_ATTEMPTS);

      // And the budget being spent is the end of it, asserted the only way it
      // can be: a tick far in the future that reaches nobody.
      outbound = [];
      await runFulfillmentTickOnce(new Date(base + 24 * 60 * MINUTE_MS));
      expect(outbound, "a row at MAX attempts was picked up again").toHaveLength(0);
    });
  });

  // ── The hold window's own parsing ────────────────────────────────────────

  describe("releaseHoldMs", () => {
    it("defaults when unset, honours zero, and refuses nonsense", () => {
      delete process.env["KAX_PRINTIFY_AUTO_RELEASE_HOLD_MS"];
      expect(releaseHoldMs()).toBe(DEFAULT_RELEASE_HOLD_MS);

      process.env["KAX_PRINTIFY_AUTO_RELEASE_HOLD_MS"] = "0";
      expect(releaseHoldMs(), "zero is a setting, not an absence").toBe(0);

      process.env["KAX_PRINTIFY_AUTO_RELEASE_HOLD_MS"] = "300000";
      expect(releaseHoldMs()).toBe(300_000);

      // A typo is not an instruction. Falling through to "release immediately"
      // on one would remove the hold window without anyone asking.
      for (const junk of ["", "   ", "soon", "-1", "NaN"]) {
        process.env["KAX_PRINTIFY_AUTO_RELEASE_HOLD_MS"] = junk;
        expect(releaseHoldMs(), `"${junk}"`).toBe(DEFAULT_RELEASE_HOLD_MS);
      }
    });
  });
});

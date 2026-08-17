/**
 * printifyClient.test.ts — the fulfilment adapter and the two admin endpoints
 * that drive it, attacked at the four places they can cost real money.
 *
 * **The shop.** A defaulted shop id is the quietest failure in this whole
 * feature: the account's list still contains an old Shopify-channel store, so
 * "just use the first one" would not throw — it would manufacture into a
 * storefront nobody meant to sell from. Nothing in an HTTP response can catch
 * that, so the check is made against the SOURCE — and it lives in
 * `printifyConfig.test.ts` along with every other case that needs no database,
 * because a config-validation guard that only runs when Postgres happens to be
 * up is a guard that ships on the day it is not. Only the 503 an unconfigured
 * adapter gives a real order row is here.
 *
 * **The order of the two calls.** Charge first, then submit: `submit` refuses
 * anything that is not `paid`, because a Stripe refund is one API call and
 * unwinding a print run is not — and because Printify charges the merchant's
 * own card at submission, so submitting early means paying to manufacture an
 * order that may never be paid for. `paid` is checked under the row lock, so
 * the `refunded` and `chargeback` states `webhooks.ts` writes are what stop an
 * order whose money has gone back from still being shippable.
 *
 * **Doing either step twice.** `printify_order_id` and `released_at` are the
 * guards, held under `SELECT … FOR UPDATE`. Both are asserted by the count of
 * outbound calls, which is the only artefact that distinguishes "already done"
 * from "done again" — the response body looks much the same either way. Each is
 * pressed twice sequentially AND twice simultaneously: the sequential press
 * covers the null check, and only the simultaneous one covers the lock, which
 * is the half that decides whether two operators clicking at once produce one
 * parcel or two.
 *
 * **The address.** It comes off the order's `ship_to_*` snapshot and never off
 * a live `users` / `user_shipping_addresses` join, so the case below moves the
 * buyer's live address to a different street between the charge and the
 * submission and insists the parcel still goes where they paid to send it.
 *
 * Printify is stood in for at `fetch`, not at the module boundary, so the URL,
 * the bearer header and the JSON body actually put on the wire are what the
 * assertions read. Postgres is real — CI's — because the row lock and the
 * two no-op guards are database behaviour and a mock of them would be a mock
 * of the thing being proven.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express, type Request, type Response as ExpressResponse, type NextFunction } from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import {
  commerceOrdersTable,
  commerceProductsTable,
  userShippingAddressesTable,
} from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";
import adminRouter from "../routes/admin";
import { createTestUser, deleteUsersByIds, makeTestId } from "../test-helpers";

/** A token shaped like the real one, and never the real one. */
const TEST_TOKEN = "kax-test-printify-token-4f2b";
/** A shop id that is neither the Shopify store nor the KAX store. */
const TEST_SHOP_ID = "10000001";

/** What the order was charged against. This is the address that must ship. */
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

/** Where the buyer moved to afterwards. Nothing may ship here. */
const LIVE_ADDRESS = {
  name: "Somebody Else",
  line1: "999 Moved House Road",
  line2: null,
  city: "Austin",
  region: "TX",
  postalCode: "78701",
  country: "US",
  phone: "+15125550199",
} as const;

const ITEM_CENTS = 1564;
const SHIPPING_CENTS = 509;
const PRINTIFY_PRODUCT_ID = "6a81f8c84b2b4c5db504b97f";
const PRINTIFY_VARIANT_ID = "45750";

interface OutboundCall {
  url: string;
  method: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

/**
 * One row of `GET /shops/{id}/orders.json`, in the shape a live response really
 * has — captured from the API, not imagined.
 *
 * There is deliberately **no top-level `external_id`**: Printify does not send
 * one. What we POST as `external_id` comes back as `metadata.shop_order_label`,
 * which is what the lookup matches on.
 */
function printifyOrderRow(opts: { id: string; label: string; status?: string }): Record<string, unknown> {
  return {
    id: opts.id,
    app_order_id: null,
    shop_id: Number(TEST_SHOP_ID),
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
    metadata: { order_type: "external", shop_order_id: 987654321, shop_order_label: opts.label },
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
  };
}

/** The list envelope, with the three pagination fields the adapter requires. */
function orderListPage(rows: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    current_page: 1,
    data: rows,
    first_page_url: "https://api.printify.com/v1/shops/x/orders.json?page=1",
    from: rows.length === 0 ? null : 1,
    last_page: 1,
    last_page_url: "https://api.printify.com/v1/shops/x/orders.json?page=1",
    links: [],
    next_page_url: null,
    path: "https://api.printify.com/v1/shops/x/orders.json",
    per_page: 50,
    prev_page_url: null,
    to: rows.length === 0 ? null : rows.length,
    total: rows.length,
  };
}

let outbound: OutboundCall[] = [];
let nextResponse: { status: number; body: string } = { status: 200, body: "{}" };
/**
 * What the pre-submission reconcile lookup (the only GET) is answered with.
 *
 * Answered separately from the POSTs because it is a different question with a
 * different shape, and because the default has to be the SAFE one: a completed,
 * empty page — "Printify does not have this order" — so that a case which does
 * not care about reconciliation submits exactly as it always did.
 */
let nextLookupResponse: { status: number; body: string } = {
  status: 200,
  body: JSON.stringify(orderListPage([])),
};
let lastError: string | null = null;

function respondWith(status: number, body: unknown): void {
  nextResponse = { status, body: typeof body === "string" ? body : JSON.stringify(body) };
}

function respondToLookupWith(status: number, body: unknown): void {
  nextLookupResponse = { status, body: typeof body === "string" ? body : JSON.stringify(body) };
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
      const { status, body } = method === "GET" ? nextLookupResponse : nextResponse;
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => body,
      } as unknown as Response;
    }),
  );
}

/**
 * The calls that cost money, separated from the one that does not.
 *
 * `submit` now asks Printify whether it already has the order before it posts
 * one, so a bare `outbound.length` counts a read that prints nothing. The
 * counts that decide whether a buyer gets one parcel or two are these.
 */
function submitCalls(): OutboundCall[] {
  return outbound.filter((c) => c.method === "POST" && c.url.endsWith("/orders.json"));
}

function lookupCalls(): OutboundCall[] {
  return outbound.filter((c) => c.method === "GET");
}

function productionCalls(): OutboundCall[] {
  return outbound.filter((c) => c.url.includes("send_to_production"));
}

/**
 * The admin router behind a stand-in session, the way `harvester-auth.test.ts`
 * drives its admin cases. `requireAdmin` still reads the role out of the
 * database, so the authorisation being exercised is the real one.
 */
function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: ExpressResponse, next: NextFunction) => {
    const userId = req.header("x-test-user");
    if (userId) (req as unknown as { user: { id: string } }).user = { id: userId };
    req.isAuthenticated = function (this: Request) {
      return this.user != null;
    } as Request["isAuthenticated"];
    next();
  });
  app.use(adminRouter);
  app.use((err: unknown, _req: Request, res: ExpressResponse, _next: NextFunction) => {
    lastError = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: lastError });
  });
  return app;
}

const ENV_KEYS = [
  "KAX_PRINTIFY_ENABLED",
  "KAX_PRINTIFY_API_TOKEN",
  "KAX_PRINTIFY_SHOP_ID",
  "KAX_PRINTIFY_CONTACT_EMAIL",
] as const;

describe("Printify fulfilment (#287)", () => {
  let app: Express;
  const priorEnv = new Map<string, string | undefined>();
  const userIds: string[] = [];
  let buyerId: string;
  let adminId: string;
  let plainUserId: string;
  let sku: string;

  beforeEach(async () => {
    lastError = null;
    outbound = [];
    respondWith(200, { id: "printify_order_1", status: "on-hold" });
    respondToLookupWith(200, orderListPage([]));
    installFetchStub();
    app = buildApp();

    for (const key of ENV_KEYS) priorEnv.set(key, process.env[key]);
    process.env["KAX_PRINTIFY_ENABLED"] = "1";
    process.env["KAX_PRINTIFY_API_TOKEN"] = TEST_TOKEN;
    process.env["KAX_PRINTIFY_SHOP_ID"] = TEST_SHOP_ID;
    delete process.env["KAX_PRINTIFY_CONTACT_EMAIL"];

    const buyer = await createTestUser();
    const admin = await createTestUser({ role: "admin" });
    const plain = await createTestUser();
    buyerId = buyer.id;
    adminId = admin.id;
    plainUserId = plain.id;
    userIds.push(buyer.id, admin.id, plain.id);

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
    // Orders and addresses cascade from the buyer; products belong to no one.
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

  function reload(id: number) {
    return db
      .select()
      .from(commerceOrdersTable)
      .where(eq(commerceOrdersTable.id, id))
      .limit(1)
      .then((rows) => rows[0]);
  }

  function submit(orderId: number, actorId: string = adminId) {
    return request(app)
      .post(`/admin/commerce-orders/${orderId}/submit`)
      .set("x-test-user", actorId)
      .send({});
  }

  function release(orderId: number, actorId: string = adminId) {
    return request(app)
      .post(`/admin/commerce-orders/${orderId}/release`)
      .set("x-test-user", actorId)
      .send({});
  }

  // ── The shop, at the route boundary ──────────────────────────────────────
  //
  // The source-level shop guards, the config refusals and the address mapping
  // live in `printifyConfig.test.ts`, which needs no database. Only the cases
  // that drive a real order row are here.

  describe("the shop is configuration and nothing else", () => {
    it("answers 503, and calls nothing, when the flag is on but the shop is not set", async () => {
      const order = await makeOrder();
      delete process.env["KAX_PRINTIFY_SHOP_ID"];

      const res = await submit(order.id);
      expect(res.status).toBe(503);
      expect(outbound, "an unconfigured adapter reaches nobody").toHaveLength(0);
      expect((await reload(order.id))!.printifyOrderId).toBeNull();
    });
  });

  // ── The flag and the guard ───────────────────────────────────────────────

  describe("inert until configured", () => {
    it("404s both endpoints with KAX_PRINTIFY_ENABLED unset, and touches nothing", async () => {
      // 404 rather than 401 or 403: with the flag off these routes answer as if
      // they were never mounted. The order used here is a perfectly submittable
      // paid one, so the 404 can only be the gate — and the row is re-read
      // afterwards, because a gate that answers 404 after doing the work would
      // otherwise pass.
      const order = await makeOrder();
      delete process.env["KAX_PRINTIFY_ENABLED"];

      for (const attempt of [() => submit(order.id), () => release(order.id)]) {
        const res = await attempt();
        expect(res.status).toBe(404);
        expect(res.body.error).toBe("Not found");
      }
      // Anonymous too: the gate runs ahead of requireAdmin, so an unconfigured
      // deployment does not even admit that the route is there.
      const anonymous = await request(app).post(`/admin/commerce-orders/${order.id}/submit`).send({});
      expect(anonymous.status).toBe(404);

      expect(outbound).toHaveLength(0);
      const after = (await reload(order.id))!;
      expect(after.printifyOrderId).toBeNull();
      expect(after.fulfillmentState).toBe("unfulfilled");
    });

    it("serves the same routes once the flag is on", async () => {
      // The other half. Without it the 404 case above would also pass against a
      // router that was simply broken.
      const order = await makeOrder();
      expect((await submit(order.id)).status, `reached: ${lastError}`).toBe(200);
    });

    it("refuses a caller who is not an admin, before any provider call", async () => {
      const order = await makeOrder();
      expect((await submit(order.id, plainUserId)).status).toBe(403);
      expect((await release(order.id, plainUserId)).status).toBe(403);
      expect((await request(app).post(`/admin/commerce-orders/${order.id}/submit`).send({})).status).toBe(401);
      expect(outbound).toHaveLength(0);
    });
  });

  // ── Charge first, then submit ────────────────────────────────────────────

  describe("POST /admin/commerce-orders/:id/submit", () => {
    it("refuses an order that has not been paid for, and calls Printify not at all", async () => {
      // The rule the whole endpoint is arranged around. Printify charges the
      // merchant's card at submission, so an unpaid submission is manufacturing
      // bought for an order that may never settle — and a print run is not
      // refundable the way a PaymentIntent is. Remove the status check and the
      // call count goes to 1.
      for (const status of ["pending_payment", "authenticating", "payment_failed", "refunded"]) {
        const order = await makeOrder({ status });
        const res = await submit(order.id);
        expect(res.status, `status ${status}`).toBe(409);
        expect(res.body.reason).toBe("not_paid");
        expect((await reload(order.id))!.printifyOrderId).toBeNull();
      }
      expect(outbound, "nothing unpaid reached the printer").toHaveLength(0);
    });

    it("submits a paid order to the configured shop and records the id", async () => {
      const order = await makeOrder();
      const res = await submit(order.id);

      expect(res.status, `reached: ${lastError}`).toBe(200);
      // Two calls and in this order: the reconcile lookup that proves Printify
      // does not already have this order, then the submission itself.
      expect(outbound).toHaveLength(2);
      expect(outbound[0].method, "posted before asking").toBe("GET");
      expect(submitCalls()).toHaveLength(1);
      const call = submitCalls()[0];
      expect(call.method).toBe("POST");
      expect(call.url).toBe(`https://api.printify.com/v1/shops/${TEST_SHOP_ID}/orders.json`);
      expect(call.authorization, "the token is sent, and only here").toBe(`Bearer ${TEST_TOKEN}`);

      // external_id is the order's own idempotency key, which is what makes a
      // submission whose response was lost findable by name at Printify
      // instead of guessed at.
      expect(call.body["external_id"]).toBe(order.clientReference);
      expect(call.body["line_items"]).toEqual([
        { product_id: PRINTIFY_PRODUCT_ID, variant_id: Number(PRINTIFY_VARIANT_ID), quantity: 1 },
      ]);
      // KAX is the merchant of record and the only party this buyer has heard
      // from; a second shipping mail from a manufacturer is not a service.
      expect(call.body["send_shipping_notification"]).toBe(false);

      const after = (await reload(order.id))!;
      expect(after.printifyOrderId).toBe("printify_order_1");
      expect(after.fulfillmentState).toBe("submitted");
      expect(after.submittedAt).not.toBeNull();
      expect(res.body.printifyOrderId).toBe("printify_order_1");
      expect(res.body.alreadySubmitted).toBe(false);
    });

    it("builds address_to from the order snapshot, never from the live user row", async () => {
      // The buyer moves house between the charge and the submission. The parcel
      // still goes where they paid to send it, because `address_to` is built
      // from the order's own ship_to_* columns and there is no join back to
      // user_shipping_addresses. Swap in a live lookup and every one of these
      // assertions flips to the Austin address.
      const order = await makeOrder();
      await db.insert(userShippingAddressesTable).values({ userId: buyerId, ...LIVE_ADDRESS });

      expect((await submit(order.id)).status, `reached: ${lastError}`).toBe(200);
      const addressTo = submitCalls()[0].body["address_to"] as Record<string, unknown>;

      expect(addressTo).toMatchObject({
        first_name: "Ada",
        last_name: "Test Buyer",
        address1: SNAPSHOT_ADDRESS.shipToLine1,
        address2: SNAPSHOT_ADDRESS.shipToLine2,
        city: SNAPSHOT_ADDRESS.shipToCity,
        region: SNAPSHOT_ADDRESS.shipToRegion,
        zip: SNAPSHOT_ADDRESS.shipToPostalCode,
        country: SNAPSHOT_ADDRESS.shipToCountry,
        phone: SNAPSHOT_ADDRESS.shipToPhone,
      });
      const serialized = JSON.stringify(addressTo);
      expect(serialized, "the address they moved to").not.toContain(LIVE_ADDRESS.line1);
      expect(serialized).not.toContain(LIVE_ADDRESS.city);
      expect(serialized).not.toContain(LIVE_ADDRESS.postalCode);
      expect(serialized).not.toContain(LIVE_ADDRESS.name);
    });

    it("submits once for two presses of the button", async () => {
      // `printify_order_id IS NOT NULL`. The response bodies are nearly
      // identical either way, so the call count is what actually separates
      // "already done" from "done twice" — and doing it twice is two parcels
      // printed and two merchant-card charges.
      const order = await makeOrder();
      const first = await submit(order.id);
      respondWith(200, { id: "printify_order_2", status: "on-hold" });
      const second = await submit(order.id);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(submitCalls(), "the second press posted a second order").toHaveLength(1);
      // …and it did not even look: an id already on the row answers the
      // question without a provider call of any kind.
      expect(lookupCalls(), "the second press spent a lookup on a settled question").toHaveLength(1);
      expect(second.body.printifyOrderId).toBe("printify_order_1");
      expect(second.body.alreadySubmitted).toBe(true);
      expect((await reload(order.id))!.printifyOrderId).toBe("printify_order_1");
    });

    it("submits once for two SIMULTANEOUS presses of the button", async () => {
      // The case above awaits the first response before sending the second, so
      // it covers the null check and nothing else — remove `.for("update")` and
      // it still passes. This one leaves both presses in flight, which is the
      // guarantee the file header actually claims: two operators clicking at
      // the same moment produce one parcel, and it is the row lock that decides
      // that. Without it both transactions read a null `printify_order_id` and
      // both post an order.
      const order = await makeOrder();
      const [a, b] = await Promise.all([submit(order.id), submit(order.id)]);

      expect(a.status, `reached: ${lastError}`).toBe(200);
      expect(b.status, `reached: ${lastError}`).toBe(200);
      expect(submitCalls(), "two operators, one print run").toHaveLength(1);
      expect(
        [a.body.alreadySubmitted, b.body.alreadySubmitted].filter(Boolean),
        "exactly one press did the work and the other found it done",
      ).toHaveLength(1);
      expect((await reload(order.id))!.printifyOrderId).toBe("printify_order_1");
    });

    it("refuses a product with no Printify identifiers rather than posting a broken line item", async () => {
      // The seeded sticker ships with a product id and no variant, deliberately
      // — the row is inert until an operator wires it. A line item with a NaN
      // variant is an order Printify accepts or rejects unpredictably; refusing
      // is the answer that leaves nothing half-made.
      await db
        .update(commerceProductsTable)
        .set({ printifyVariantId: null })
        .where(eq(commerceProductsTable.sku, sku));
      const order = await makeOrder();

      const res = await submit(order.id);
      expect(res.status).toBe(409);
      expect(res.body.reason).toBe("product_not_printable");
      // The order is paid and unsubmitted, so the reconcile lookup runs and
      // costs a GET. Nothing is POSTED, which is the property this case is
      // about: no half-made line item reaches the printer.
      expect(submitCalls()).toHaveLength(0);
    });

    it("leaves the order submittable when Printify refuses, and leaks neither token nor address", async () => {
      // Printify's rejection bodies quote the offending field back, which on
      // this path is the buyer's street. Only the status and Printify's own
      // code cross the boundary; the field detail is dropped in the adapter.
      // Pass the raw body through and the three `not.toContain`s below fail.
      const order = await makeOrder();
      respondWith(400, {
        code: 8251,
        message: "Order could not be published",
        errors: {
          reason: `address_to.zip "${SNAPSHOT_ADDRESS.shipToPostalCode}" is invalid for ${SNAPSHOT_ADDRESS.shipToLine1}`,
          token: TEST_TOKEN,
        },
      });

      const res = await submit(order.id);
      expect(res.status).toBe(502);
      expect(res.body.printifyStatus).toBe(400);
      expect(res.body.printifyCode).toBe(8251);
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(TEST_TOKEN);
      expect(serialized).not.toContain(SNAPSHOT_ADDRESS.shipToLine1);
      expect(serialized).not.toContain(SNAPSHOT_ADDRESS.shipToPostalCode);

      // The transaction rolled back, so the order can be submitted again once
      // whatever Printify objected to has been fixed.
      const after = (await reload(order.id))!;
      expect(after.printifyOrderId).toBeNull();
      expect(after.fulfillmentState).toBe("unfulfilled");
    });

    it("404s an order that does not exist", async () => {
      const res = await submit(2_147_483_600);
      expect(res.status).toBe(404);
      expect(res.body.reason).toBe("order_not_found");
      expect(outbound).toHaveLength(0);
    });
  });

  // ── The button, when the order may already be at Printify ────────────────
  //
  // This endpoint is where an order the worker could NOT resolve gets routed to
  // a human. That made it the most dangerous button in the system: an operator
  // told "this order needs attention" pressed submit, and submit posted blind —
  // no lookup, no look at what the row said — so the second parcel was printed
  // by the one person who had been warned about it.

  describe("submitting by hand asks Printify first", () => {
    /** The state the worker parks an unresolvable ambiguous order in. */
    async function makeAmbiguousOrder() {
      const order = await makeOrder();
      await db
        .update(commerceOrdersTable)
        .set({ fulfillmentLastError: "submission_ambiguous", fulfillmentAttempts: 6 })
        .where(eq(commerceOrdersTable.id, order.id));
      return order;
    }

    it("adopts the order Printify already has instead of posting a second one", async () => {
      // The whole point. Printify has the order, under the label we submitted it
      // with; the operator presses submit; nothing is manufactured and the id is
      // written onto the row. Without the lookup this is a 200, a second parcel
      // and a second charge to the merchant's card — indistinguishable from
      // success in every observable except the count below.
      const order = await makeAmbiguousOrder();
      respondToLookupWith(
        200,
        orderListPage([printifyOrderRow({ id: "printify_order_existing", label: order.clientReference })]),
      );
      respondWith(200, { id: "printify_order_DUPLICATE", status: "on-hold" });

      const res = await submit(order.id);

      expect(res.status, `reached: ${lastError}`).toBe(200);
      expect(submitCalls(), "the manual button printed a second parcel").toHaveLength(0);
      expect(res.body.printifyOrderId).toBe("printify_order_existing");
      expect(res.body.alreadySubmitted).toBe(true);
      expect(res.body.reconciled, "the operator was not told what happened").toBe(true);

      const after = (await reload(order.id))!;
      expect(after.printifyOrderId).toBe("printify_order_existing");
      expect(after.fulfillmentState).toBe("submitted");
      // The doubt the row recorded is the doubt that was just resolved.
      expect(after.fulfillmentLastError).toBeNull();
      expect(after.fulfillmentAttempts).toBe(0);
    });

    it("409s an ambiguous order when it cannot check, rather than posting blind", async () => {
      // "We could not look" is not "it is not there". On a row that already says
      // a submission may exist, the honest answer is to stop and let a human
      // read Printify's own UI — which is exactly the thing the operator can do
      // and this process cannot.
      const order = await makeAmbiguousOrder();
      respondToLookupWith(503, { code: 503, message: "Service unavailable" });
      respondWith(200, { id: "printify_order_DUPLICATE", status: "on-hold" });

      const res = await submit(order.id);

      expect(res.status).toBe(409);
      expect(res.body.reason).toBe("reconcile_unavailable");
      expect(submitCalls(), "posted an order that may already exist").toHaveLength(0);
      expect((await reload(order.id))!.printifyOrderId).toBeNull();
      // Nothing about the refusal quotes a provider body or an address.
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(TEST_TOKEN);
      expect(serialized).not.toContain(SNAPSHOT_ADDRESS.shipToLine1);
    });

    it("posts anyway when the operator acknowledges the risk in the request", async () => {
      // The escape hatch, and it has to exist: an operator who has just looked
      // the order up in Printify and found nothing knows something this process
      // does not, and a refusal they cannot override would strand a paid order.
      // It is an explicit `true` in the body and never a truthy string.
      const order = await makeAmbiguousOrder();
      respondToLookupWith(503, { code: 503, message: "Service unavailable" });
      respondWith(200, { id: "printify_order_after_ack", status: "on-hold" });

      const refused = await request(app)
        .post(`/admin/commerce-orders/${order.id}/submit`)
        .set("x-test-user", adminId)
        .send({ acknowledgeDuplicateRisk: "yes" });
      expect(refused.status, "a truthy string was taken for an acknowledgement").toBe(409);
      expect(submitCalls()).toHaveLength(0);

      const res = await request(app)
        .post(`/admin/commerce-orders/${order.id}/submit`)
        .set("x-test-user", adminId)
        .send({ acknowledgeDuplicateRisk: true });

      expect(res.status, `reached: ${lastError}`).toBe(200);
      expect(submitCalls()).toHaveLength(1);
      expect((await reload(order.id))!.printifyOrderId).toBe("printify_order_after_ack");
    });

    it("still submits a clean order when the lookup fails, because nothing is in doubt", async () => {
      // The other side of the 409, and it is the one that protects the ONLY
      // proven path to a fulfilled order. A row with no marker carries no
      // evidence that a submission was ever made, blind posting is what this
      // endpoint has always done in that state, and refusing would take the
      // manual path away every time Printify's list endpoint was unwell.
      const order = await makeOrder();
      respondToLookupWith(503, { code: 503, message: "Service unavailable" });

      const res = await submit(order.id);

      expect(res.status, `reached: ${lastError}`).toBe(200);
      expect(submitCalls()).toHaveLength(1);
      expect(res.body.reconciled).toBe(false);
      expect((await reload(order.id))!.printifyOrderId).toBe("printify_order_1");
    });

    it("treats a page it cannot parse as a failed lookup and not as an absence", async () => {
      // `readOrderPage` used to coerce any unexpected envelope to an empty page,
      // which the pager read as the end of the list and reported as
      // "definitively absent". Here that would mean posting an order that may
      // already exist — so an unparseable page must reach this endpoint as the
      // same refusal a 503 does.
      const order = await makeAmbiguousOrder();
      respondToLookupWith(200, { orders: [] });
      respondWith(200, { id: "printify_order_DUPLICATE", status: "on-hold" });

      const res = await submit(order.id);

      expect(res.status).toBe(409);
      expect(res.body.reason).toBe("reconcile_unavailable");
      expect(submitCalls(), "an unreadable page was read as an absence").toHaveLength(0);
    });

    it("matches metadata.shop_order_label, the only place Printify echoes it", async () => {
      // The captured response has no top-level `external_id` — not in the list
      // and not in the detail projection. Reading one gives `undefined` on every
      // row, which matches nothing, which reads as absent, which posts again.
      // The row below is the real shape; nothing else about this case changes.
      const order = await makeAmbiguousOrder();
      const row = printifyOrderRow({ id: "printify_order_labelled", label: order.clientReference });
      expect(row, "the fixture invented a field Printify does not send").not.toHaveProperty(
        "external_id",
      );
      respondToLookupWith(200, orderListPage([row]));

      const res = await submit(order.id);

      expect(res.status, `reached: ${lastError}`).toBe(200);
      expect(res.body.printifyOrderId).toBe("printify_order_labelled");
      expect(submitCalls()).toHaveLength(0);
    });

    it("does not adopt somebody else's order", async () => {
      // A page of other people's orders is a completed search that found
      // nothing, so this submits — one parcel, not a stranger's id written onto
      // a paying customer's row.
      const order = await makeAmbiguousOrder();
      respondToLookupWith(
        200,
        orderListPage([
          printifyOrderRow({ id: "printify_order_someone_else", label: randomUUID() }),
          printifyOrderRow({
            id: "printify_order_prefix",
            label: order.clientReference.slice(0, 8),
          }),
          printifyOrderRow({
            id: "printify_order_upper",
            label: order.clientReference.toUpperCase(),
          }),
        ]),
      );

      const res = await submit(order.id);

      expect(res.status, `reached: ${lastError}`).toBe(200);
      expect(submitCalls()).toHaveLength(1);
      expect(res.body.reconciled).toBe(false);
      expect((await reload(order.id))!.printifyOrderId).toBe("printify_order_1");
    });
  });

  // ── Release, the second half of a manual approval ────────────────────────

  describe("POST /admin/commerce-orders/:id/release", () => {
    it("refuses to release an order that was never submitted", async () => {
      // Two steps and not one. Releasing without a Printify order id would have
      // to invent a submission, which is exactly the single-step flow the
      // manual-approval window exists to prevent.
      const order = await makeOrder();
      const res = await release(order.id);

      expect(res.status).toBe(409);
      expect(res.body.reason).toBe("not_submitted");
      expect(outbound).toHaveLength(0);
      expect((await reload(order.id))!.releasedAt).toBeNull();
    });

    it("sends a submitted order to production and records who released it", async () => {
      const order = await makeOrder();
      await submit(order.id);
      respondWith(200, { id: "printify_order_1", status: "in-production" });

      const res = await release(order.id);
      expect(res.status, `reached: ${lastError}`).toBe(200);
      expect(productionCalls()).toHaveLength(1);
      expect(productionCalls()[0].url).toBe(
        `https://api.printify.com/v1/shops/${TEST_SHOP_ID}/orders/printify_order_1/send_to_production.json`,
      );
      // Release never reconciles: the order's name is already ours, which is the
      // one thing the reconcile exists to recover.
      expect(lookupCalls(), "release went looking for an order it already had").toHaveLength(1);

      const after = (await reload(order.id))!;
      expect(after.releasedAt).not.toBeNull();
      // Production is a human decision and the record of whose decision it was
      // is the point of the column.
      expect(after.releaseActor).toBe(adminId);
      expect(after.fulfillmentState).toBe("in_production");
    });

    it("releases once for two presses of the button", async () => {
      // `released_at IS NOT NULL`. Without it the second press is a second
      // send_to_production, and the outbound count says so.
      const order = await makeOrder();
      await submit(order.id);
      const first = await release(order.id);
      const second = await release(order.id);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.alreadyReleased).toBe(true);
      expect(productionCalls(), "the second press manufactured again").toHaveLength(1);
      expect(submitCalls()).toHaveLength(1);
      expect(second.body.releaseActor).toBe(adminId);
    });

    it("releases once for two SIMULTANEOUS presses of the button", async () => {
      // The row lock, on the second half. Sequential presses only exercise the
      // `released_at` null check; two at once are what `.for("update")` is
      // there for, and without it both transactions see a null and both send
      // the order to production.
      const order = await makeOrder();
      await submit(order.id);
      const [a, b] = await Promise.all([release(order.id), release(order.id)]);

      expect(a.status, `reached: ${lastError}`).toBe(200);
      expect(b.status, `reached: ${lastError}`).toBe(200);
      expect(productionCalls(), "two operators, one print run").toHaveLength(1);
      expect(submitCalls()).toHaveLength(1);
      expect(
        [a.body.alreadyReleased, b.body.alreadyReleased].filter(Boolean),
        "exactly one press did the work and the other found it done",
      ).toHaveLength(1);
    });

    it("refuses to release an order whose money has gone back, and calls nobody", async () => {
      // Submission checks `paid`; release did not, and the two are a hold
      // window apart. `charge.refunded` and `charge.dispute.*` land inside that
      // window and move the row — so an operator pressing release on an order
      // that was paid when they opened the page would manufacture a parcel
      // against money that is no longer there. The button is not evidence about
      // the charge, and the locked read is.
      //
      // Same 409 and same `not_paid` reason submit answers with, because it is
      // the same refusal.
      for (const status of ["refunded", "chargeback", "canceled"]) {
        const order = await makeOrder();
        await submit(order.id);
        expect(submitCalls(), `status ${status}: the submission itself`).toHaveLength(1);
        await db
          .update(commerceOrdersTable)
          .set({ status })
          .where(eq(commerceOrdersTable.id, order.id));

        const res = await release(order.id);
        expect(res.status, `status ${status}`).toBe(409);
        expect(res.body.reason).toBe("not_paid");
        expect(res.body.orderStatus).toBe(status);
        expect(productionCalls(), `a ${status} order was sent to production`).toHaveLength(0);

        const after = (await reload(order.id))!;
        expect(after.releasedAt).toBeNull();
        expect(after.fulfillmentState).toBe("submitted");
        outbound = [];
      }
    });

    it("leaves the release unrecorded when Printify refuses", async () => {
      const order = await makeOrder();
      await submit(order.id);
      respondWith(500, { code: 500, message: "Internal error" });

      const res = await release(order.id);
      expect(res.status).toBe(502);
      const after = (await reload(order.id))!;
      expect(after.releasedAt, "a failed release is not a release").toBeNull();
      expect(after.fulfillmentState).toBe("submitted");
    });
  });

});

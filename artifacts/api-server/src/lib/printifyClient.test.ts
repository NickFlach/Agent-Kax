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

let outbound: OutboundCall[] = [];
let nextResponse: { status: number; body: string } = { status: 200, body: "{}" };
let lastError: string | null = null;

function respondWith(status: number, body: unknown): void {
  nextResponse = { status, body: typeof body === "string" ? body : JSON.stringify(body) };
}

function installFetchStub(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init: Record<string, unknown> = {}) => {
      const headers = (init["headers"] ?? {}) as Record<string, string>;
      outbound.push({
        url: String(input),
        method: String(init["method"] ?? "GET"),
        authorization: headers["Authorization"],
        body: init["body"] ? (JSON.parse(String(init["body"])) as Record<string, unknown>) : {},
      });
      const { status, body } = nextResponse;
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => body,
      } as unknown as Response;
    }),
  );
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
      expect(outbound).toHaveLength(1);
      const call = outbound[0];
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
      const addressTo = outbound[0].body["address_to"] as Record<string, unknown>;

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
      expect(outbound, "the second press reached nobody").toHaveLength(1);
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
      expect(outbound, "two operators, one print run").toHaveLength(1);
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
      expect(outbound).toHaveLength(0);
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
      expect(outbound).toHaveLength(2);
      expect(outbound[1].url).toBe(
        `https://api.printify.com/v1/shops/${TEST_SHOP_ID}/orders/printify_order_1/send_to_production.json`,
      );

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
      expect(outbound, "one submit, one release, and no more").toHaveLength(2);
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
      expect(outbound, "one submit, one release, and no more").toHaveLength(2);
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
        expect(outbound, `status ${status}: the submission itself`).toHaveLength(1);
        await db
          .update(commerceOrdersTable)
          .set({ status })
          .where(eq(commerceOrdersTable.id, order.id));

        const res = await release(order.id);
        expect(res.status, `status ${status}`).toBe(409);
        expect(res.body.reason).toBe("not_paid");
        expect(res.body.orderStatus).toBe(status);
        expect(outbound, `a ${status} order was sent to production`).toHaveLength(1);

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

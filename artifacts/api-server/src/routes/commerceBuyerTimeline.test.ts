/**
 * commerceBuyerTimeline.test.ts — what the person who paid is allowed to see
 * about where their parcel got to, and everything they must not.
 *
 * The feature exists because of a real failure: a dropped column made the
 * fulfilment worker throw once a minute with no positive signal, which is
 * indistinguishable from the feature being switched off, and hours went into
 * telling those apart. The buyer's version of that failure is an order that has
 * been parked — given up on by the retry ladder, waiting for a human — rendering
 * exactly like one that is simply taking its time. So the load-bearing assertion
 * in this file is that those two payloads DIFFER.
 *
 * The other half is what the difference is allowed to be made of. `GET
 * /admin/commerce-orders` returns `fulfillment_last_error` — `"429:8251"` — and
 * the Printify order id and the provider's own status literal, because an
 * operator needs all three. None of them may be in a buyer's payload, and the
 * guarantee is structural rather than a filtering step: the buyer endpoint does
 * not SELECT `fulfillment_last_error`, it selects `fulfillment_last_error IS NOT
 * NULL`, so the string never enters that code path and cannot be restored to the
 * response by somebody widening a field. Two code paths, two payloads, and no
 * component filtering an admin body.
 *
 * Every assertion below searches the whole serialized response as substrings, so
 * a rename, a nested object or a debug field would all fail it.
 *
 * Real Postgres and the real session middleware, so the ownership scoping being
 * exercised is the one that ships.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { commerceOrdersTable } from "@workspace/db/schema";
import { like } from "drizzle-orm";
import commerceRouter from "./commerce";
import { authMiddleware } from "../middlewares/authMiddleware";
import { MAX_FULFILLMENT_ATTEMPTS } from "../lib/commerceFulfillmentStages";
import { cleanupAuthTestData, createWalletUser, makeTestId } from "../test-helpers";

/** The buyer's address. Not one character of this may reach the response. */
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

/** Every value above that says WHERE the buyer lives. */
const POSTAL_PII = [
  SNAPSHOT_ADDRESS.shipToName,
  SNAPSHOT_ADDRESS.shipToLine1,
  SNAPSHOT_ADDRESS.shipToLine2,
  SNAPSHOT_ADDRESS.shipToCity,
  SNAPSHOT_ADDRESS.shipToPostalCode,
  SNAPSHOT_ADDRESS.shipToPhone,
] as const;

/**
 * The things an ADMIN sees and a buyer must not.
 *
 * `429:8251` is what the worker actually stores after a rate-limited
 * submission — the provider's status and its numeric code — and it is the
 * literal named in the brief. `in-production` is Printify's own status word,
 * captured live. `printify_order_9` stands in for the provider's order id.
 */
const ADMIN_ONLY_VALUES = ["429:8251", "8251", "in-production", "printify_order_9"] as const;

const ITEM_CENTS = 1055;
const SHIPPING_CENTS = 509;
const MINUTE_MS = 60_000;

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authMiddleware);
  app.use(commerceRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  });
  return app;
}

describe("the buyer's fulfilment timeline", () => {
  let app: Express;
  const userIds: string[] = [];
  const sids: string[] = [];
  let priorFlag: string | undefined;
  let buyerId: string;
  let cookie: string;
  let sku: string;

  beforeEach(async () => {
    app = buildApp();
    priorFlag = process.env["KAX_COMMERCE_ENABLED"];
    process.env["KAX_COMMERCE_ENABLED"] = "1";

    await db.delete(commerceOrdersTable).where(like(commerceOrdersTable.buyerUserId, "kax-test-%"));

    const buyer = await createWalletUser();
    buyerId = buyer.id;
    cookie = `sid=${buyer.sid}`;
    userIds.push(buyer.id);
    sids.push(buyer.sid);
    sku = makeTestId("sku");
  });

  afterEach(async () => {
    if (priorFlag === undefined) delete process.env["KAX_COMMERCE_ENABLED"];
    else process.env["KAX_COMMERCE_ENABLED"] = priorFlag;
    await cleanupAuthTestData({ userIds: userIds.splice(0), sids: sids.splice(0) });
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
        ...SNAPSHOT_ADDRESS,
        ...overrides,
      })
      .returning();
    return order;
  }

  /**
   * An order the retry ladder has GIVEN UP on: the budget spent in one write,
   * the provider's refusal stored, and the failure more recent than any stage
   * the order reached. This is exactly the row `park()` produces.
   */
  function parkedOrder(overrides: Partial<typeof commerceOrdersTable.$inferInsert> = {}) {
    return makeOrder({
      fulfillmentAttempts: MAX_FULFILLMENT_ATTEMPTS,
      fulfillmentLastError: "429:8251",
      fulfillmentLastAttemptAt: new Date(Date.now() - MINUTE_MS),
      providerStatus: "in-production",
      printifyOrderId: "printify_order_9",
      ...overrides,
    });
  }

  function fetchOne(ref: string) {
    return request(app).get(`/commerce/orders/${ref}`).set("Cookie", cookie);
  }

  function fetchList() {
    return request(app).get("/commerce/orders").set("Cookie", cookie);
  }

  // ── The parked order: the case this feature was built for ────────────────

  describe("a parked order", () => {
    it("carries NO provider code, NO http status and NO address — but DOES say it stalled", async () => {
      const order = await parkedOrder();

      const res = await fetchOne(order.clientReference);
      expect(res.status).toBe(200);

      const serialized = JSON.stringify(res.body);

      // Nothing an operator is owed reaches the person who paid.
      for (const value of ADMIN_ONLY_VALUES) {
        expect(serialized, `admin-only value "${value}" reached a buyer`).not.toContain(value);
      }
      // Nor a hint of one under a different name.
      expect(serialized.toLowerCase()).not.toContain("lasterror");
      expect(serialized.toLowerCase()).not.toContain("last_error");
      expect(serialized.toLowerCase()).not.toContain("providerstatus");
      expect(serialized.toLowerCase()).not.toContain("printifyorderid");
      expect(serialized.toLowerCase()).not.toContain("attempts");

      // Nor the address, in any field, under any name.
      for (const value of POSTAL_PII) {
        expect(serialized, `"${value}" reached a buyer payload`).not.toContain(value);
      }
      expect(serialized.toLowerCase()).not.toContain("shipto");
      expect(serialized.toLowerCase()).not.toContain("ship_to");

      // And it is a real order that was fetched, not an empty body that
      // trivially contains nothing.
      expect(res.body.orderRef).toBe(order.clientReference);

      // The positive half: the buyer is told it stopped, and WHERE.
      expect(res.body.timeline.progress).toBe("stalled");
      expect(res.body.timeline.stalledAt).toBe("paid");
    });

    it("does not read the same as a healthy order at the same stage", async () => {
      // Two rows identical but for the worker's counter. If the payloads match,
      // the ambiguity that cost hours is back.
      const parked = await parkedOrder();
      const healthy = await makeOrder();

      const parkedRes = await fetchOne(parked.clientReference);
      const healthyRes = await fetchOne(healthy.clientReference);

      expect(parkedRes.body.timeline.progress).toBe("stalled");
      expect(healthyRes.body.timeline.progress).toBe("moving");
      expect(parkedRes.body.timeline.progress).not.toBe(healthyRes.body.timeline.progress);

      // Both are at the same stage, so the stage alone cannot be what tells them
      // apart — which is precisely why `progress` exists.
      expect(parkedRes.body.timeline.current).toBe(healthyRes.body.timeline.current);
    });

    it("says which stage it stopped at when the failure was at release", async () => {
      const order = await parkedOrder({
        fulfillmentState: "submitted",
        submittedAt: new Date(Date.now() - 10 * MINUTE_MS),
      });

      const res = await fetchOne(order.clientReference);
      expect(res.body.timeline.progress).toBe("stalled");
      expect(res.body.timeline.stalledAt).toBe("submitted");
    });

    it("stops calling it stalled once a human has pushed it through", async () => {
      // The manual admin endpoints never clear the worker's columns, so this row
      // keeps a spent budget and a stored error forever. It is nonetheless fine:
      // it moved AFTER the failure. Getting this wrong would put a permanent red
      // warning on every order that was ever fulfilled by hand — which is, so
      // far, the only order that has ever been fulfilled at all.
      const order = await parkedOrder({
        fulfillmentState: "in_production",
        submittedAt: new Date(),
        releasedAt: new Date(),
        fulfillmentLastAttemptAt: new Date(Date.now() - 60 * MINUTE_MS),
      });

      const res = await fetchOne(order.clientReference);
      expect(res.body.timeline.progress).toBe("moving");
      expect(res.body.timeline.stalledAt).toBeNull();
    });
  });

  // ── The healthy order ────────────────────────────────────────────────────

  describe("a healthy in-flight order", () => {
    it("shows the correct current stage, with a timestamp on every completed one", async () => {
      const submittedAt = new Date(Date.now() - 30 * MINUTE_MS);
      const releasedAt = new Date(Date.now() - 15 * MINUTE_MS);
      const order = await makeOrder({
        fulfillmentState: "in_production",
        printifyOrderId: "printify_order_9",
        submittedAt,
        releasedAt,
      });

      const res = await fetchOne(order.clientReference);
      expect(res.status).toBe(200);
      expect(res.body.timeline.progress).toBe("moving");
      expect(res.body.timeline.current).toBe("in_production");

      const stages: { id: string; reached: boolean; at: string | null; current: boolean }[] =
        res.body.timeline.stages;
      expect(stages.map((s) => s.id)).toEqual([
        "paid",
        "submitted",
        "in_production",
        "shipped",
        "delivered",
      ]);

      const byId = new Map(stages.map((s) => [s.id, s]));
      expect(byId.get("paid")!.at).not.toBeNull();
      expect(byId.get("submitted")!.at).toBe(submittedAt.toISOString());
      expect(byId.get("in_production")!.at).toBe(releasedAt.toISOString());
      expect(byId.get("in_production")!.current).toBe(true);
      expect(byId.get("shipped")!.reached).toBe(false);
      expect(byId.get("shipped")!.at).toBeNull();

      // Even here, the provider's own id and status stay out.
      const serialized = JSON.stringify(res.body);
      for (const value of ADMIN_ONLY_VALUES) {
        expect(serialized, `admin-only value "${value}" reached a buyer`).not.toContain(value);
      }
    });

    it("moves the current stage as the order climbs", async () => {
      const cases: [string, Partial<typeof commerceOrdersTable.$inferInsert>, string][] = [
        ["just paid", {}, "paid"],
        ["at the printer", { fulfillmentState: "submitted", submittedAt: new Date() }, "submitted"],
        [
          "being printed",
          { fulfillmentState: "in_production", submittedAt: new Date(), releasedAt: new Date() },
          "in_production",
        ],
        [
          "posted",
          {
            fulfillmentState: "shipped",
            submittedAt: new Date(),
            releasedAt: new Date(),
            shippedAt: new Date(),
          },
          "shipped",
        ],
        [
          "arrived",
          {
            fulfillmentState: "delivered",
            submittedAt: new Date(),
            releasedAt: new Date(),
            shippedAt: new Date(),
            deliveredAt: new Date(),
          },
          "delivered",
        ],
      ];

      for (const [label, overrides, expected] of cases) {
        const order = await makeOrder(overrides);
        const res = await fetchOne(order.clientReference);
        expect(res.body.timeline.current, label).toBe(expected);
        expect(res.body.timeline.progress, label).toBe("moving");
      }
    });

    it("returns the tracking the status sync captured, and null until there is any", async () => {
      const withoutTracking = await makeOrder({ fulfillmentState: "in_production" });
      expect((await fetchOne(withoutTracking.clientReference)).body.tracking).toBeNull();

      const shipped = await makeOrder({
        fulfillmentState: "shipped",
        submittedAt: new Date(),
        releasedAt: new Date(),
        shippedAt: new Date(),
        trackingCarrier: "usps",
        trackingNumber: "9400100000000000000000",
        trackingUrl: "https://tools.usps.com/go/TrackConfirmAction",
      });
      const res = await fetchOne(shipped.clientReference);
      expect(res.body.tracking).toEqual({
        carrier: "usps",
        number: "9400100000000000000000",
        url: "https://tools.usps.com/go/TrackConfirmAction",
      });
    });
  });

  // ── Orders with nothing to show ──────────────────────────────────────────

  describe("orders with no parcel", () => {
    it("has nothing to say about an unpaid one", async () => {
      const order = await makeOrder({ status: "payment_failed" });
      const res = await fetchOne(order.clientReference);
      expect(res.body.timeline.progress).toBe("none");
      expect(res.body.timeline.current).toBeNull();
    });

    it("reports a refunded one as stopped rather than stalled", async () => {
      const order = await makeOrder({
        status: "refunded",
        fulfillmentState: "submitted",
        submittedAt: new Date(),
      });
      const res = await fetchOne(order.clientReference);
      expect(res.body.timeline.progress).toBe("stopped");
      expect(res.body.timeline.stalledAt).toBeNull();
    });
  });

  // ── The list, which is the page a buyer actually lands on ────────────────

  describe("GET /commerce/orders", () => {
    it("carries the same timeline, and the same absences", async () => {
      // The detail route is the poll target and the list is the /orders page.
      // A guarantee proven on one of them and not the other is half a
      // guarantee — this endpoint returns EVERY order an account has.
      const order = await parkedOrder();

      const res = await fetchList();
      expect(res.status).toBe(200);
      expect(res.body.orders).toHaveLength(1);
      expect(res.body.orders[0].orderRef).toBe(order.clientReference);
      expect(res.body.orders[0].timeline.progress).toBe("stalled");

      const serialized = JSON.stringify(res.body);
      for (const value of [...ADMIN_ONLY_VALUES, ...POSTAL_PII]) {
        expect(serialized, `"${value}" reached the buyer's order list`).not.toContain(value);
      }
      expect(serialized.toLowerCase()).not.toContain("shipto");
    });

    it("does not show one account's order to another", async () => {
      const order = await parkedOrder();

      const other = await createWalletUser();
      userIds.push(other.id);
      sids.push(other.sid);

      const res = await request(app).get("/commerce/orders").set("Cookie", `sid=${other.sid}`);
      expect(res.status).toBe(200);
      expect(res.body.orders).toHaveLength(0);

      const detail = await request(app)
        .get(`/commerce/orders/${order.clientReference}`)
        .set("Cookie", `sid=${other.sid}`);
      expect(detail.status).toBe(404);
    });
  });
});

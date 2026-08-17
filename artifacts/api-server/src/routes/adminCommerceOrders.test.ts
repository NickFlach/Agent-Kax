/**
 * adminCommerceOrders.test.ts — the listing that makes fulfilment findable, and
 * the one thing it must never contain.
 *
 * `commerce_orders` is the only row in this system that holds a real person's
 * postal address, and ADR-0002's rule for it is that the address leaves this
 * server exactly once, addressed to the printer. Every other test of that rule
 * guards a path that has a reason to touch the address; this one guards the
 * path that has no reason at all and would carry it anyway, because a listing
 * endpoint is written by selecting the row and the row has the columns on it.
 *
 * So the assertion below is not "the response has the right fields". It is that
 * the buyer's street, postcode, city, name and phone appear NOWHERE in the
 * serialized body — searched as substrings of the whole response, so a rename,
 * a nested object or a debug field that carried them would all fail it. The
 * route selects its columns by name for the same reason: a projection cannot
 * forget to strip what it never asked for.
 *
 * The worker-state columns are asserted present in the same breath, because
 * that is the endpoint's other job — a retry ladder whose attempts, backoff and
 * parked orders can only be read out of a log is one nobody can answer "did
 * that order ship?" about.
 *
 * Real Postgres and the real `requireAdmin`, which reads the role out of the
 * database, so the authorisation being exercised is the one that ships.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express, { type Express, type Request, type Response as ExpressResponse, type NextFunction } from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { commerceOrdersTable } from "@workspace/db/schema";
import { like } from "drizzle-orm";
import adminRouter from "./admin";
import { createTestUser, deleteUsersByIds, makeTestId } from "../test-helpers";

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

/** Every value above that identifies WHERE the buyer lives. */
const POSTAL_PII = [
  SNAPSHOT_ADDRESS.shipToName,
  SNAPSHOT_ADDRESS.shipToLine1,
  SNAPSHOT_ADDRESS.shipToLine2,
  SNAPSHOT_ADDRESS.shipToCity,
  SNAPSHOT_ADDRESS.shipToPostalCode,
  SNAPSHOT_ADDRESS.shipToPhone,
] as const;

const ITEM_CENTS = 1055;
const SHIPPING_CENTS = 509;

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
  return app;
}

describe("GET /admin/commerce-orders", () => {
  let app: Express;
  const userIds: string[] = [];
  let buyerId: string;
  let adminId: string;
  let plainUserId: string;
  let sku: string;

  beforeEach(async () => {
    app = buildApp();
    await db.delete(commerceOrdersTable).where(like(commerceOrdersTable.buyerUserId, "kax-test-%"));

    const buyer = await createTestUser();
    const admin = await createTestUser({ role: "admin" });
    const plain = await createTestUser();
    buyerId = buyer.id;
    adminId = admin.id;
    plainUserId = plain.id;
    userIds.push(buyer.id, admin.id, plain.id);
    sku = makeTestId("sku");
  });

  afterEach(async () => {
    await deleteUsersByIds(userIds.splice(0));
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

  function list(query = "", actorId: string = adminId) {
    return request(app).get(`/admin/commerce-orders${query}`).set("x-test-user", actorId);
  }

  it("never carries the buyer's address, in any field, under any name", async () => {
    // The reason this endpoint selects columns by name. Swap the projection for
    // a `select()` over the whole row and every assertion in this loop fails at
    // once — which is the point: the guarantee is that the columns were never
    // read, not that something remembered to remove them afterwards.
    const order = await makeOrder();

    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(1);

    const serialized = JSON.stringify(res.body);
    for (const value of POSTAL_PII) {
      expect(serialized, `"${value}" reached an admin listing`).not.toContain(value);
    }
    // Field names too, not just values: a `shipTo` key carrying a masked or
    // truncated address would still be this endpoint growing an address.
    expect(serialized.toLowerCase()).not.toContain("shipto");
    expect(serialized.toLowerCase()).not.toContain("ship_to");

    // And it is a real row that was fetched, not an empty projection that
    // trivially contains nothing.
    expect(res.body.orders[0].id).toBe(order.id);
    expect(res.body.orders[0].clientReference).toBe(order.clientReference);
  });

  it("reports what the fulfilment worker did, so its retries are not log-only", async () => {
    const order = await makeOrder({
      printifyOrderId: "printify_order_7",
      fulfillmentState: "submitted",
      submittedAt: new Date(),
      fulfillmentAttempts: 3,
      fulfillmentLastError: "429:8251",
      fulfillmentNextAttemptAt: new Date(Date.now() + 60_000),
    });

    const [row] = (await list()).body.orders;
    expect(row.id).toBe(order.id);
    expect(row.sku).toBe(sku);
    expect(row.status).toBe("paid");
    expect(row.fulfillmentState).toBe("submitted");
    expect(row.printifyOrderId).toBe("printify_order_7");
    expect(row.fulfillmentAttempts).toBe(3);
    expect(row.fulfillmentLastError).toBe("429:8251");
    expect(row.fulfillmentNextAttemptAt).not.toBeNull();
    expect(row.submittedAt).not.toBeNull();
    expect(row.totalCents).toBe(ITEM_CENTS + SHIPPING_CENTS);
  });

  it("filters by status and by fulfillment state", async () => {
    const paid = await makeOrder();
    const pending = await makeOrder({ status: "pending_payment" });
    const inProduction = await makeOrder({
      fulfillmentState: "in_production",
      printifyOrderId: "printify_order_8",
    });

    const paidOnly = (await list("?status=paid")).body.orders.map((o: { id: number }) => o.id);
    expect(paidOnly).toContain(paid.id);
    expect(paidOnly).toContain(inProduction.id);
    expect(paidOnly, "a pending order answered a paid filter").not.toContain(pending.id);

    const producing = (await list("?fulfillmentState=in_production")).body.orders;
    expect(producing.map((o: { id: number }) => o.id)).toEqual([inProduction.id]);
  });

  it("answers an unrecognised filter with nothing rather than a 500", async () => {
    // The behaviour `status` and `fulfillment_state` are varchars for: an
    // unknown enum literal in a WHERE clause is a 500, not a query that matches
    // nothing. A caller typing a state that does not exist gets an empty list.
    await makeOrder();
    const res = await list("?status=no_such_status");
    expect(res.status).toBe(200);
    expect(res.body.orders).toEqual([]);
  });

  it("bounds the page, and ignores a limit that is not one", async () => {
    for (let i = 0; i < 3; i++) await makeOrder();

    expect((await list("?limit=2")).body.orders).toHaveLength(2);
    // Newest first: an operator opening this page is looking for what just came
    // in, not for the first order ever placed.
    const ids = (await list()).body.orders.map((o: { id: number }) => o.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));

    const capped = await list("?limit=99999");
    expect(capped.status).toBe(200);
    expect(capped.body.limit).toBe(200);
    for (const junk of ["?limit=0", "?limit=-5", "?limit=all"]) {
      expect((await list(junk)).body.limit, junk).toBe(50);
    }
  });

  it("is admin-only", async () => {
    await makeOrder();
    expect((await list("", plainUserId)).status).toBe(403);
    expect((await request(app).get("/admin/commerce-orders")).status).toBe(401);
  });
});

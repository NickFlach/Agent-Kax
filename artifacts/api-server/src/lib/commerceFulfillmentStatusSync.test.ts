/**
 * commerceFulfillmentStatusSync.test.ts — the half of the conversation that
 * reads, attacked where a reader can still do damage.
 *
 * The poller's whole job is to make `shipped` and `delivered` reachable, which
 * they were not: the column declared six values and the server could write
 * three. What it must never do is move an order on bad information, and every
 * case below is one way that could happen.
 *
 * **The flags.** Off is the default and off means off. Each case asserts ZERO
 * outbound calls AND an untouched row — including `fulfillment_synced_at`,
 * because a gate that skipped the log and then stamped the row as checked would
 * be reporting a healthy poller on a deployment that has none.
 *
 * **The captured shape is the fixture.** `printifyOrder()` below carries exactly
 * the sixteen keys a live `GET /shops/{id}/orders.json` row was observed to
 * have, with the real `status: "in-production"` — hyphenated, their vocabulary,
 * not ours — and the real `line_items` and `metadata` shape. Nothing is invented
 * except `shipments`, which is absent from the capture (the order it was taken
 * from had not shipped) and is therefore handled as optional and marked as such
 * where it is used.
 *
 * **The address.** Every one of those rows carries a full `address_to`, and on a
 * reconcile scan most of them are OTHER buyers'. The fixture's address is a
 * distinctive one, and the assertions search the whole stored row for it as
 * substrings — so a column widened later, a debug field, or a rename would all
 * fail. The adapter drops it at the parse boundary and there is no column here
 * it could reach.
 *
 * **A new status must not crash and must not regress.** Printify is free to add
 * a status tomorrow and we will not be told. An unrecognised one leaves the
 * state exactly where it was, records the raw literal so an operator can find
 * out what it means, and stamps the check as done.
 *
 * Printify is stood in for at `fetch`, so the URL actually put on the wire is
 * what the assertions read. Postgres is real: the claim query, `SKIP LOCKED`,
 * the partial index and the `FOR UPDATE` re-read are database behaviour, and a
 * mock of them would be a mock of the thing being proven.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { commerceOrdersTable, commerceProductsTable } from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";
import {
  STATUS_SYNC_MIN_INTERVAL_MS,
  runStatusSyncTickOnce,
  statusSyncEnabled,
} from "./commerceFulfillmentStatusSync";
import { createTestUser, deleteUsersByIds, makeTestId } from "../test-helpers";

/** A token shaped like the real one, and never the real one. */
const TEST_TOKEN = "kax-test-printify-token-9c3e";
/** Neither the Shopify store nor the KAX store. */
const TEST_SHOP_ID = "10000002";

/**
 * The buyer's address as the order snapshotted it.
 *
 * Not one character of this may reach a stored column, a log line or a response.
 */
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

/**
 * The address Printify sends BACK on every projection of every order.
 *
 * Deliberately different values from the snapshot above, so an assertion that
 * finds one of these in a stored row is finding something that came from the
 * provider's response rather than from the order's own columns.
 */
const PROVIDER_ADDRESS_PII = [
  "Somebody Else",
  "99 Provider Road",
  "Unit 7",
  "Beaverton",
  "97005",
  "+15035550199",
] as const;

const ITEM_CENTS = 1055;
const SHIPPING_CENTS = 509;
const PRINTIFY_PRODUCT_ID = "6a81f8c84b2b4c5db504b97f";
const PRINTIFY_VARIANT_ID = "45750";

const MINUTE_MS = 60_000;

/**
 * One Printify order, in EXACTLY the shape a live response was observed to have.
 *
 * The sixteen keys are the captured key set verbatim: `id, app_order_id,
 * shop_id, address_to, line_items, metadata, total_price, total_shipping,
 * total_tax, status, shipping_method, created_at, sent_to_production_at,
 * fulfilment_type, printify_connect, sales_channel_type_id`. Note what is NOT
 * among them: there is no top-level `external_id`. The value KAX submits under
 * that name comes back as `metadata.shop_order_label`, and the fixture is built
 * that way because a fixture that invented an `external_id` would prove a
 * behaviour the real API does not have.
 *
 * `total_price: 354` is the real captured figure — Printify's production cost in
 * cents against a buyer who paid 1564. Nothing in this file reads it; it is here
 * because the fixture is the captured shape and not a convenient subset of it.
 *
 * `shipments` is NOT part of the capture and is added only by the callers that
 * model a shipped order.
 */
function printifyOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "printify_order_1",
    app_order_id: null,
    shop_id: Number(TEST_SHOP_ID),
    address_to: {
      first_name: "Somebody",
      last_name: "Else",
      region: "OR",
      city: "Beaverton",
      zip: "97005",
      address1: "99 Provider Road",
      address2: "Unit 7",
      country: "US",
      phone: "+15035550199",
    },
    line_items: [{ variant_id: 65212, quantity: 1 }],
    metadata: {
      order_type: "external",
      shop_order_id: 1234567,
      shop_order_label: "ce703bd3-407c-4136-aae4-0eadac65b90f",
    },
    total_price: 354,
    total_shipping: 0,
    total_tax: 0,
    status: "in-production",
    shipping_method: 1,
    created_at: "2026-08-10 10:00:00+00:00",
    sent_to_production_at: "2026-08-10 10:30:00+00:00",
    fulfilment_type: "ordinary",
    printify_connect: null,
    sales_channel_type_id: null,
    ...overrides,
  };
}

interface OutboundCall {
  url: string;
  method: string;
  authorization: string | undefined;
}

let outbound: OutboundCall[] = [];
/** URL substring -> what Printify answers. The fallback answers everything else. */
let responses: { status: number; body: string };

function respondWith(status: number, body: unknown): void {
  responses = { status, body: typeof body === "string" ? body : JSON.stringify(body) };
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
      });
      const { status, body } = responses;
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => body,
      } as unknown as Response;
    }),
  );
}

const ENV_KEYS = [
  "KAX_PRINTIFY_ENABLED",
  "KAX_PRINTIFY_API_TOKEN",
  "KAX_PRINTIFY_SHOP_ID",
  "KAX_PRINTIFY_STATUS_SYNC",
] as const;

describe("Printify status sync", () => {
  const priorEnv = new Map<string, string | undefined>();
  const userIds: string[] = [];
  let buyerId: string;
  let sku: string;

  beforeEach(async () => {
    outbound = [];
    respondWith(200, printifyOrder());
    installFetchStub();

    for (const key of ENV_KEYS) priorEnv.set(key, process.env[key]);
    process.env["KAX_PRINTIFY_ENABLED"] = "1";
    process.env["KAX_PRINTIFY_STATUS_SYNC"] = "1";
    process.env["KAX_PRINTIFY_API_TOKEN"] = TEST_TOKEN;
    process.env["KAX_PRINTIFY_SHOP_ID"] = TEST_SHOP_ID;

    // The poller claims across the whole table rather than an id handed to it,
    // so a claimable order left behind by another file would be read by these
    // ticks and counted in `outbound`. Only rows owned by the test prefix are
    // ever touched, and they are cleared before each case rather than after, so
    // a crashed run cannot poison the next.
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
    await db.delete(commerceOrdersTable).where(like(commerceOrdersTable.buyerUserId, "kax-test-%"));
    await deleteUsersByIds(userIds.splice(0));
    await db.delete(commerceProductsTable).where(like(commerceProductsTable.sku, "kax-test-%"));
  });

  afterAll(async () => {
    await db.delete(commerceProductsTable).where(like(commerceProductsTable.sku, "kax-test-%"));
  });

  /** An order already at Printify, last looked at long enough ago to be due. */
  async function makeSubmittedOrder(
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
        printifyOrderId: "printify_order_1",
        fulfillmentState: "submitted",
        submittedAt: new Date(Date.now() - 60 * MINUTE_MS),
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

  // ── Off by default, and off means off ────────────────────────────────────

  describe("inert unless both flags are on", () => {
    it("calls nobody and touches nothing with KAX_PRINTIFY_STATUS_SYNC unset", async () => {
      const order = await makeSubmittedOrder();
      delete process.env["KAX_PRINTIFY_STATUS_SYNC"];

      const result = await runStatusSyncTickOnce();
      expect(result.skipped).toBe("disabled");
      expect(result.checked).toBe(0);
      expect(outbound, "an unarmed poller reached the printer").toHaveLength(0);

      const after = (await reload(order.id))!;
      expect(after.fulfillmentState).toBe("submitted");
      expect(after.providerStatus).toBeNull();
      // The one a "logged and returned" gate would still get wrong: an
      // unconfigured deployment must not look like a healthy one on the column
      // that exists to reveal it.
      expect(after.fulfillmentSyncedAt).toBeNull();
      expect(after.shippedAt).toBeNull();
      expect(after.deliveredAt).toBeNull();
      expect(after.trackingNumber).toBeNull();
    });

    it("calls nobody and touches nothing with KAX_PRINTIFY_ENABLED unset", async () => {
      // The master switch. The reader must not be able to arm the fulfilment
      // surface that `printifyEnabled()` is the switch for.
      const order = await makeSubmittedOrder();
      delete process.env["KAX_PRINTIFY_ENABLED"];

      const result = await runStatusSyncTickOnce();
      expect(result.skipped).toBe("disabled");
      expect(outbound).toHaveLength(0);

      const after = (await reload(order.id))!;
      expect(after.fulfillmentState).toBe("submitted");
      expect(after.fulfillmentSyncedAt).toBeNull();
    });

    it("reads both flags the same way, and defaults both to off", () => {
      for (const raw of ["1", "true"]) {
        process.env["KAX_PRINTIFY_STATUS_SYNC"] = raw;
        expect(statusSyncEnabled(), raw).toBe(true);
      }
      for (const raw of ["0", "false", "yes", "on", ""]) {
        process.env["KAX_PRINTIFY_STATUS_SYNC"] = raw;
        expect(statusSyncEnabled(), raw).toBe(false);
      }
      delete process.env["KAX_PRINTIFY_STATUS_SYNC"];
      expect(statusSyncEnabled()).toBe(false);
    });

    it("touches nothing when the flag is on but Printify is not configured", async () => {
      const order = await makeSubmittedOrder();
      delete process.env["KAX_PRINTIFY_API_TOKEN"];

      const result = await runStatusSyncTickOnce();
      expect(result.skipped).toBe("not_configured");
      expect(outbound).toHaveLength(0);

      const after = (await reload(order.id))!;
      expect(after.fulfillmentSyncedAt).toBeNull();
    });

    it("does the work once both flags are on", async () => {
      // The other half of the two gate cases above. Without it they would both
      // pass against a poller that was simply broken.
      const order = await makeSubmittedOrder();
      const result = await runStatusSyncTickOnce();

      expect(result.skipped).toBeNull();
      expect(result.checked).toBe(1);
      expect(outbound).toHaveLength(1);

      const after = (await reload(order.id))!;
      expect(after.fulfillmentSyncedAt).not.toBeNull();
    });
  });

  // ── Reading their vocabulary ─────────────────────────────────────────────

  describe("mapping Printify's statuses onto ours", () => {
    it("advances a submitted order on the captured `in-production`", async () => {
      // The status the real released order actually reported, hyphenated.
      const order = await makeSubmittedOrder();
      respondWith(200, printifyOrder({ status: "in-production" }));

      const result = await runStatusSyncTickOnce();
      expect(result.advanced).toBe(1);
      expect(result.unknownStatus).toBe(0);

      const after = (await reload(order.id))!;
      expect(after.fulfillmentState).toBe("in_production");
      // The provider's literal is kept verbatim, untranslated.
      expect(after.providerStatus).toBe("in-production");
      expect(after.providerStatusAt).not.toBeNull();
      expect(after.fulfillmentSyncedAt).not.toBeNull();
    });

    it("asks for the order by its own id, with the token, and nothing else", async () => {
      await makeSubmittedOrder();
      await runStatusSyncTickOnce();

      expect(outbound).toHaveLength(1);
      expect(outbound[0]!.method).toBe("GET");
      expect(outbound[0]!.url).toBe(
        `https://api.printify.com/v1/shops/${TEST_SHOP_ID}/orders/printify_order_1.json`,
      );
      expect(outbound[0]!.authorization).toBe(`Bearer ${TEST_TOKEN}`);
    });

    it("reaches `shipped` — a state nothing in the system could write before", async () => {
      const order = await makeSubmittedOrder({ fulfillmentState: "in_production" });
      // `shipments` is NOT in the captured response; the captured order had not
      // shipped. It is Printify's documented shipment shape and is treated as
      // optional everywhere it is read.
      respondWith(
        200,
        printifyOrder({
          status: "fulfilled",
          shipments: [
            {
              carrier: "usps",
              number: "9400100000000000000000",
              url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400100000000000000000",
            },
          ],
        }),
      );

      const result = await runStatusSyncTickOnce();
      expect(result.advanced).toBe(1);

      const after = (await reload(order.id))!;
      expect(after.fulfillmentState).toBe("shipped");
      expect(after.shippedAt).not.toBeNull();
      expect(after.trackingCarrier).toBe("usps");
      expect(after.trackingNumber).toBe("9400100000000000000000");
      expect(after.trackingUrl).toContain("tools.usps.com");
      expect(after.deliveredAt).toBeNull();
    });

    it("reaches `delivered` off a shipment's delivered_at, which is the only evidence there is", async () => {
      // Printify's order lifecycle has no `delivered` status at all.
      const order = await makeSubmittedOrder({ fulfillmentState: "shipped" });
      respondWith(
        200,
        printifyOrder({
          status: "fulfilled",
          shipments: [
            {
              carrier: "usps",
              number: "9400100000000000000000",
              url: "https://tools.usps.com/go/TrackConfirmAction",
              delivered_at: "2026-08-15 14:00:00+00:00",
            },
          ],
        }),
      );

      const result = await runStatusSyncTickOnce();
      expect(result.advanced).toBe(1);

      const after = (await reload(order.id))!;
      expect(after.fulfillmentState).toBe("delivered");
      expect(after.deliveredAt).not.toBeNull();
    });

    it("records a cancellation at the printer", async () => {
      const order = await makeSubmittedOrder({ fulfillmentState: "in_production" });
      respondWith(200, printifyOrder({ status: "canceled" }));

      await runStatusSyncTickOnce();
      const after = (await reload(order.id))!;
      expect(after.fulfillmentState).toBe("canceled");
    });
  });

  // ── The two ways a reader does damage ────────────────────────────────────

  describe("an unknown or backward status", () => {
    it("does not crash and does not move the order on a status this build has never seen", async () => {
      const order = await makeSubmittedOrder({ fulfillmentState: "in_production" });
      respondWith(200, printifyOrder({ status: "quantum-entangled-with-the-press" }));

      const result = await runStatusSyncTickOnce();
      expect(result.skipped).toBeNull();
      expect(result.unknownStatus).toBe(1);
      expect(result.advanced).toBe(0);

      const after = (await reload(order.id))!;
      // Unchanged, in either direction.
      expect(after.fulfillmentState).toBe("in_production");
      // …and RECORDED, which is how anybody ever finds out what it means.
      expect(after.providerStatus).toBe("quantum-entangled-with-the-press");
      // …and stamped, because we did look. Silence is the bug.
      expect(after.fulfillmentSyncedAt).not.toBeNull();
    });

    it("does not walk an order BACKWARDS when Printify re-reports an earlier status", async () => {
      // Printify's list is not a monotonic log: a status can be re-reported and
      // a page can be stale. A buyer watching their shipped parcel return to the
      // press has been told something false by a feature whose entire purpose is
      // telling them something true.
      const order = await makeSubmittedOrder({
        fulfillmentState: "shipped",
        shippedAt: new Date(Date.now() - 10 * MINUTE_MS),
      });
      respondWith(200, printifyOrder({ status: "on-hold" }));

      const result = await runStatusSyncTickOnce();
      expect(result.advanced).toBe(0);
      expect(result.unchanged).toBe(1);

      const after = (await reload(order.id))!;
      expect(after.fulfillmentState).toBe("shipped");
      expect(after.shippedAt).not.toBeNull();
    });

    it("does not un-deliver a delivered order on a late cancellation", async () => {
      // Only reachable while `delivered_at` is still unset — a delivered order
      // has left the claim query for good. This one is `delivered` by state
      // without the stamp, exactly as a hand-edited row would be.
      const order = await makeSubmittedOrder({ fulfillmentState: "delivered" });
      respondWith(200, printifyOrder({ status: "canceled" }));

      await runStatusSyncTickOnce();
      const after = (await reload(order.id))!;
      expect(after.fulfillmentState).toBe("delivered");
    });

    it("leaves everything alone when Printify refuses the read", async () => {
      const order = await makeSubmittedOrder();
      respondWith(429, { code: 8251, message: "Rate limit exceeded" });

      const result = await runStatusSyncTickOnce();
      expect(result.failed).toBe(1);
      expect(result.checked).toBe(0);

      const after = (await reload(order.id))!;
      expect(after.fulfillmentState).toBe("submitted");
      expect(after.providerStatus).toBeNull();
      // Stamped, so the retry is paced like everything else rather than
      // hammering one unreadable order on every tick.
      expect(after.fulfillmentSyncedAt).not.toBeNull();
      // The provider's code is NOT written into the fulfilment worker's error
      // column: a read failure must not be able to look like a submission
      // failure to an operator, or to the buyer's stall reading.
      expect(after.fulfillmentLastError).toBeNull();
      expect(after.fulfillmentAttempts).toBe(0);
    });

    it("changes nothing when Printify says it has no such order", async () => {
      const order = await makeSubmittedOrder();
      respondWith(404, { code: 404, message: "Not found" });

      const result = await runStatusSyncTickOnce();
      expect(result.vanished).toBe(1);
      expect(result.checked).toBe(0);

      const after = (await reload(order.id))!;
      // The local row is the record that we submitted it and got an id back.
      // Deciding here that it never happened would be the poller inventing news.
      expect(after.fulfillmentState).toBe("submitted");
      expect(after.printifyOrderId).toBe("printify_order_1");
      expect(after.fulfillmentSyncedAt).not.toBeNull();
    });

    it("does not infer an absence from a page it could not parse", async () => {
      // A 200 whose body is not the expected envelope. Reading "no status, no
      // shipments" out of it would be indistinguishable from a legitimately
      // unstarted order, and would be stamped as a successful check.
      const order = await makeSubmittedOrder();
      respondWith(200, { unexpected: "envelope" });

      const result = await runStatusSyncTickOnce();
      expect(result.failed).toBe(1);
      expect(result.checked).toBe(0);

      const after = (await reload(order.id))!;
      expect(after.fulfillmentState).toBe("submitted");
      expect(after.providerStatus).toBeNull();
    });
  });

  // ── What it is allowed to touch ──────────────────────────────────────────

  describe("scope", () => {
    it("never lets the provider's address_to reach the row", async () => {
      // Every projection of every Printify order carries a full address, and on
      // a reconcile most of them are other buyers'. Searched as substrings of
      // the whole serialized row, so a rename, a nested object or a debug field
      // added later would all fail this.
      const order = await makeSubmittedOrder();
      respondWith(200, printifyOrder({ status: "fulfilled", shipments: [] }));

      await runStatusSyncTickOnce();

      const after = (await reload(order.id))!;
      const serialized = JSON.stringify(after);
      for (const value of PROVIDER_ADDRESS_PII) {
        expect(serialized, `provider address value "${value}" reached the row`).not.toContain(value);
      }
    });

    it("never touches the fulfilment worker's retry budget", async () => {
      // Those columns belong to submit/release. A reader that could rewrite them
      // could un-park an order, or park a healthy one.
      const nextAttempt = new Date(Date.now() + 30 * MINUTE_MS);
      const order = await makeSubmittedOrder({
        fulfillmentAttempts: 3,
        fulfillmentLastError: "429:8251",
        fulfillmentNextAttemptAt: nextAttempt,
      });
      respondWith(200, printifyOrder({ status: "in-production" }));

      await runStatusSyncTickOnce();

      const after = (await reload(order.id))!;
      expect(after.fulfillmentState).toBe("in_production");
      expect(after.fulfillmentAttempts).toBe(3);
      expect(after.fulfillmentLastError).toBe("429:8251");
      expect(after.fulfillmentNextAttemptAt?.getTime()).toBe(nextAttempt.getTime());
    });

    it("never touches an order that was never submitted", async () => {
      // No Printify id, nothing to ask about. The claim query is what enforces
      // this, and the assertion is a tick that calls nobody.
      const order = await makeSubmittedOrder({
        printifyOrderId: null,
        fulfillmentState: "unfulfilled",
        submittedAt: null,
      });

      const result = await runStatusSyncTickOnce();
      expect(outbound).toHaveLength(0);
      expect(result.checked).toBe(0);

      const after = (await reload(order.id))!;
      expect(after.fulfillmentSyncedAt).toBeNull();
    });

    it("never touches a delivered order again", async () => {
      const order = await makeSubmittedOrder({
        fulfillmentState: "delivered",
        deliveredAt: new Date(Date.now() - 24 * 60 * MINUTE_MS),
      });

      const result = await runStatusSyncTickOnce();
      expect(outbound).toHaveLength(0);
      expect(result.checked).toBe(0);

      const after = (await reload(order.id))!;
      expect(after.fulfillmentSyncedAt).toBeNull();
    });

    it("paces itself: an order checked recently is not checked again", async () => {
      await makeSubmittedOrder({
        fulfillmentSyncedAt: new Date(Date.now() - STATUS_SYNC_MIN_INTERVAL_MS / 2),
      });

      const result = await runStatusSyncTickOnce();
      expect(outbound).toHaveLength(0);
      expect(result.checked).toBe(0);
    });

    it("checks an order whose last look is older than the interval", async () => {
      await makeSubmittedOrder({
        fulfillmentSyncedAt: new Date(Date.now() - STATUS_SYNC_MIN_INTERVAL_MS * 2),
      });

      const result = await runStatusSyncTickOnce();
      expect(outbound).toHaveLength(1);
      expect(result.checked).toBe(1);
    });
  });
});

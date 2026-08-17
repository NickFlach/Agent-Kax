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
 * second parcel. So a 500 may be tried again and a 400 may not: an address
 * Printify rejected is rejected again tomorrow, and retrying it is a slow leak
 * of the error budget Printify counts against us. "Parked" is asserted the only
 * way it can be — a second tick that calls nobody.
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
  DEFAULT_RELEASE_HOLD_MS,
  MAX_FULFILLMENT_ATTEMPTS,
  releaseHoldMs,
  runFulfillmentTickOnce,
} from "./commerceFulfillmentWorker";
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

let outbound: OutboundCall[] = [];
let nextResponse: { status: number; body: string } = { status: 200, body: "{}" };

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
  function makeSubmittedOrder(agoMs: number, now: Date = new Date()) {
    return makeOrder({
      printifyOrderId: "printify_order_1",
      fulfillmentState: "submitted",
      submittedAt: new Date(now.getTime() - agoMs),
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

      expect(outbound).toHaveLength(1);
      const call = outbound[0];
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
      expect(outbound).toHaveLength(0);

      const after = (await reload(order.id))!;
      expect(after.fulfillmentAttempts).toBe(MAX_FULFILLMENT_ATTEMPTS);
      expect(after.fulfillmentLastError).toBe("product_not_printable");
    });
  });

  // ── The retry ladder ─────────────────────────────────────────────────────

  describe("what happens when Printify refuses", () => {
    it("schedules a retry for a 500 and submits on the later tick", async () => {
      const order = await makeOrder();
      respondWith(500, { code: 500, message: "Internal error" });

      const first = await runFulfillmentTickOnce();
      expect(first.retryScheduled).toBe(1);
      expect(outbound).toHaveLength(1);

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

      // ...and everything is retried after it.
      const later = new Date(Date.now() + 10 * MINUTE_MS);
      const second = await runFulfillmentTickOnce(later);
      expect(second.submitted).toBe(1);
      expect(outbound).toHaveLength(1);
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
      expect(outbound).toHaveLength(1);

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

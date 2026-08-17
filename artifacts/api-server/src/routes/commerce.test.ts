/**
 * commerce.test.ts — the purchase path, attacked at the two places it can lose
 * money.
 *
 * The first is the ORDER of the writes. `POST /purchase` has to put the
 * `commerce_orders` row down before it says a word to Stripe, because a charge
 * whose response never arrives leaves money moved and nothing on our side that
 * names it. The retry cases below are that property stated from the client's
 * side: the same `clientReference` twice must produce exactly one row and
 * exactly one CHARGE, and the second call must come back with the first call's
 * outcome rather than a second one. Each retry is pressed both sequentially and
 * SIMULTANEOUSLY, because the two exercise different halves — the sequential
 * press stops at the step-1 pre-check and never reaches the row lock, the
 * in-transaction re-read, or the idempotency key that collapse the concurrent
 * one.
 *
 * The 24-hour cap is attacked the same way, and it is a bound on money rather
 * than a UI hint: a burst fired together has to be refused by the count taken
 * inside the transaction, not waved through by a count taken before it.
 *
 * The third is the ADDRESS. The `commerce_orders` insert binds the buyer's whole
 * postal snapshot as query parameters, and drizzle puts bound parameters in the
 * message of every failed statement, which app.ts then logs. A real failure is
 * provoked with a CHECK constraint and the escaping error is read the way pino
 * would read it.
 *
 * The second is the SHAPE of the Stripe call. `off_session: true` and
 * `error_on_requires_action` each turn a bank challenge the buyer is sitting
 * right in front of into a decline they cannot clear. Neither appears in a
 * comment's worth of assurance here — the params object actually handed to
 * Stripe is inspected, because that is the only artefact that cannot be wrong
 * about itself.
 *
 * Everything else is written against a guard rather than around it. Remove the
 * server-side state recompute, the quote expiry, the address snapshot, the
 * owner scope on the poll target, or the webhook's non-2xx on a failed write,
 * and a named test fails.
 *
 * Stripe is stood in for, and the stand-in records what it was asked: an
 * idempotency key, a params object and the number of times `create` was called
 * are none of them visible in an HTTP response, and all three are the property
 * under test. Postgres is real — CI's — because the uniqueness of
 * `client_reference` IS the idempotency mechanism, and a mock of it would be a
 * mock of the thing being proven.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import request from "supertest";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import {
  artifactsTable,
  commerceOrdersTable,
  commerceProductsTable,
  userPaymentMethodsTable,
  userPurchasingConsentsTable,
  userShippingAddressesTable,
  usersTable,
} from "@workspace/db/schema";
import { and, eq, inArray, isNull, like, sql } from "drizzle-orm";
import { authMiddleware } from "../middlewares/authMiddleware";
import { CURRENT_STORED_CARD_TERMS_VERSION } from "../lib/purchasingState";
import { STORED_CARD_TERMS_SHA256 } from "../lib/storedCardTerms";
import { cleanupAuthTestData, createWalletUser, makeTestId, testLogger } from "../test-helpers";

/**
 * The switch that makes the webhook's settlement write fail.
 *
 * Hoisted because a `vi.mock` factory runs before the module body and cannot
 * see an ordinary `let`. Only the two settlement helpers are wrapped, and only
 * while the switch is on — with it off they are the real functions, so the
 * purchase suite below runs against the genuine statements rather than against
 * a stand-in that could drift from them.
 */
const control = vi.hoisted(() => ({ settlementFailure: null as Error | null }));

vi.mock("./commerce", async (importActual) => {
  const actual = (await importActual()) as typeof import("./commerce");
  return {
    ...actual,
    settleCommerceOrderByIntent: async (intentId: string, status: string) => {
      if (control.settlementFailure) throw control.settlementFailure;
      return actual.settleCommerceOrderByIntent(intentId, status);
    },
    settleCommerceOrderById: async (orderId: number, intentId: string, status: string) => {
      if (control.settlementFailure) throw control.settlementFailure;
      return actual.settleCommerceOrderById(orderId, intentId, status);
    },
  };
});

/**
 * The Stripe webhook route verifies signatures through this module, which pulls
 * in `stripe-replit-sync`. Verification is not what these cases are about — the
 * settlement that happens AFTER a verified delivery is — so it is stood down to
 * a no-op and the events below are treated as already trusted, exactly as the
 * handler treats them.
 */
vi.mock("../lib/webhookHandlers", () => ({
  WebhookHandlers: { processWebhook: async () => undefined },
}));

// The route reaches Stripe through this accessor and nowhere else.
// `commerceEnabled` is deliberately left real: the flag gate is under test and
// a stubbed flag would prove nothing about it.
vi.mock("../lib/stripeClient", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getUncachableStripeClient: vi.fn(actual["getUncachableStripeClient"] as () => Promise<unknown>),
  };
});

const stripeClient = await import("../lib/stripeClient");
const actualStripeClient = await vi.importActual<Record<string, unknown>>("../lib/stripeClient");
const getStripeClientMock = stripeClient.getUncachableStripeClient as unknown as ReturnType<typeof vi.fn>;
const realGetStripeClient = actualStripeClient["getUncachableStripeClient"] as () => Promise<unknown>;

const commerceModule = await import("./commerce");
const commerceRouter = commerceModule.default;
const webhooksRouter = (await import("./webhooks")).default;

const COMMERCE_SOURCE = new URL("./commerce.ts", import.meta.url);
const PURCHASING_SOURCE = new URL("./purchasing.ts", import.meta.url);
const ADMIN_SOURCE = new URL("./admin.ts", import.meta.url);
const PRINTIFY_SOURCE = new URL("../lib/printifyClient.ts", import.meta.url);

/**
 * The file with its prose removed.
 *
 * `commerce.ts` names `store_listings.price`, `off_session` and
 * `error_on_requires_action` repeatedly in its comments, on purpose — the
 * reasons they are absent are the most important thing in the file. So the
 * checks below have to read the code and not the argument about the code.
 */
function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\*\/|\*|\/\/|\/\*)/.test(line))
    .join("\n");
}

/**
 * Every local module reachable from these entry points, comments removed.
 *
 * A direct-specifier scan of one file is a scan of one file: a ledger reach
 * introduced in a helper that `commerce.ts` imports is invisible to it, and
 * `purchasingFacts.ts` is exactly such a helper. So the graph is walked. Only
 * relative specifiers are followed — a package import cannot be read off disk
 * this way, and `@workspace/db` is the schema barrel rather than a policy
 * decision.
 */
async function reachableSources(entries: URL[]): Promise<Map<string, string>> {
  const seen = new Map<string, string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const key = current.pathname;
    if (seen.has(key)) continue;
    const code = stripComments(await readFile(current, "utf8"));
    seen.set(key, code);

    const specifiers = [
      ...code.matchAll(/from\s+["']([^"']+)["']/g),
      ...code.matchAll(/import\(\s*["']([^"']+)["']/g),
    ].map((m) => m[1]!);
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) continue;
      for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
        const resolved = new URL(candidate, current);
        if (await readFile(resolved, "utf8").then(() => true, () => false)) {
          queue.push(resolved);
          break;
        }
      }
    }
  }
  return seen;
}

interface FakeIntent {
  id: string;
  status: string;
  client_secret: string | null;
  amount: number;
  currency: string;
  metadata: Record<string, string>;
}

/**
 * A Stripe stand-in that remembers every call and honours idempotency keys the
 * way Stripe does.
 *
 * The dedupe matters as much as the recording. If the fake minted a fresh
 * intent per call, a route that charged twice would still look like it had
 * charged once from the database's point of view, and the count of `create`
 * calls — the assertion that actually catches a double charge — would be the
 * only thing standing. Both are kept.
 */
function makeFakeStripe() {
  const creates: Array<{ params: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const retrieved: string[] = [];
  const byKey = new Map<string, FakeIntent>();
  const intents = new Map<string, FakeIntent>();
  let seq = 0;

  /** What the next confirming create resolves to. */
  let nextStatus = "succeeded";
  /** What the next confirming create throws instead of resolving. */
  let nextError: unknown = null;

  const client = {
    paymentIntents: {
      create: async (params: Record<string, unknown>, options: Record<string, unknown>) => {
        creates.push({ params, options });
        if (nextError) {
          const err = nextError;
          nextError = null;
          throw err;
        }
        const key = String(options?.["idempotencyKey"] ?? "");
        const replayed = byKey.get(key);
        if (replayed) return replayed;
        const id = `pi_test_${++seq}`;
        const intent: FakeIntent = {
          id,
          status: nextStatus,
          client_secret: `${id}_secret`,
          amount: Number(params["amount"]),
          currency: String(params["currency"]),
          metadata: (params["metadata"] ?? {}) as Record<string, string>,
        };
        byKey.set(key, intent);
        intents.set(id, intent);
        return intent;
      },
      retrieve: async (id: string) => {
        retrieved.push(id);
        const found = intents.get(id);
        if (!found) throw Object.assign(new Error("No such payment_intent"), { code: "resource_missing" });
        return found;
      },
    },
  };

  return {
    client,
    creates,
    retrieved,
    intents,
    setNextStatus(status: string) {
      nextStatus = status;
    },
    setNextError(err: unknown) {
      nextError = err;
    },
  };
}

/** The street-level fields that must never come back out of the server. */
const ADDRESS = {
  name: "Test Buyer",
  line1: "1 Test Way",
  line2: "Apt 4",
  city: "Portland",
  region: "OR",
  postalCode: "97201",
  country: "US",
  phone: "+15035550100",
} as const;

const ITEM_CENTS = 1564;
const SHIPPING_CENTS = 509;
const TOTAL_CENTS = ITEM_CENTS + SHIPPING_CENTS;

let lastError: string | null = null;
/**
 * The error object itself, not just its message.
 *
 * `app.ts:124` logs `req.log.error({ err })` and pino's serialiser walks the
 * message, the `cause` chain and every own enumerable property — so a leak test
 * that reads only `.message` would pass against an error still carrying
 * drizzle's `params` array. This is what the log line can actually reach.
 */
let lastErrorObject: unknown = null;

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authMiddleware);
  app.use(commerceRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    lastError = err instanceof Error ? err.message : String(err);
    lastErrorObject = err;
    res.status(500).json({ error: lastError });
  });
  return app;
}

/**
 * The webhook lives on its own app because it needs the raw-body route and a
 * request logger, and neither belongs on the JSON app the purchase cases use.
 */
function buildWebhookApp(): Express {
  const app = express();
  app.use(pinoHttp({ logger: testLogger }));
  app.use(webhooksRouter);
  return app;
}

describe("physical commerce purchase (#286)", () => {
  let app: Express;
  let webhookApp: Express;
  let fake: ReturnType<typeof makeFakeStripe>;
  let priorFlag: string | undefined;
  let priorCap: string | undefined;
  let sku: string;
  const userIds: string[] = [];
  const sids: string[] = [];
  /** Artifacts seeded so a product can point at one. Cleared in afterEach. */
  const artifactIds: number[] = [];

  beforeEach(async () => {
    lastError = null;
    lastErrorObject = null;
    control.settlementFailure = null;
    app = buildApp();
    webhookApp = buildWebhookApp();
    fake = makeFakeStripe();
    getStripeClientMock.mockResolvedValue(fake.client);
    priorFlag = process.env["KAX_COMMERCE_ENABLED"];
    process.env["KAX_COMMERCE_ENABLED"] = "1";
    priorCap = process.env["KAX_COMMERCE_DAILY_ORDER_CAP"];

    sku = makeTestId("sku");
    await db.insert(commerceProductsTable).values({
      sku,
      title: "KAX Test Sticker",
      itemCents: ITEM_CENTS,
      shippingCents: SHIPPING_CENTS,
      published: true,
      shipToCountries: ["US"],
    });
  });

  afterEach(async () => {
    // Single-fork runner: a leaked flag or a leaked mock decides which branch a
    // later file takes.
    if (priorFlag === undefined) delete process.env["KAX_COMMERCE_ENABLED"];
    else process.env["KAX_COMMERCE_ENABLED"] = priorFlag;
    if (priorCap === undefined) delete process.env["KAX_COMMERCE_DAILY_ORDER_CAP"];
    else process.env["KAX_COMMERCE_DAILY_ORDER_CAP"] = priorCap;
    control.settlementFailure = null;
    vi.useRealTimers();
    getStripeClientMock.mockImplementation(realGetStripeClient);
    // Orders cascade from users; products do not belong to anyone.
    await cleanupAuthTestData({ userIds: userIds.splice(0), sids: sids.splice(0) });
    await db.delete(commerceProductsTable).where(like(commerceProductsTable.sku, "kax-test-%"));
    // After the products, though `artifact_id` is ON DELETE SET NULL either
    // way — a product row that outlived its artifact is exactly the state the
    // column is nullable for, and it must not be left behind in the dev DB.
    if (artifactIds.length > 0) {
      await db.delete(artifactsTable).where(inArray(artifactsTable.id, artifactIds.splice(0)));
    }
  });

  /** An account with everything on file: address, card, consent, Customer. */
  async function readyBuyer(): Promise<{ id: string; cookie: string }> {
    const { id, sid } = await createWalletUser();
    userIds.push(id);
    sids.push(sid);
    await db.update(usersTable).set({ stripeCustomerId: `cus_${id}` }).where(eq(usersTable.id, id));
    await db.insert(userShippingAddressesTable).values({ userId: id, ...ADDRESS });
    await db.insert(userPaymentMethodsTable).values({
      userId: id,
      stripePaymentMethodId: `pm_${id}`,
      brand: "visa",
      last4: "4242",
      expMonth: 12,
      // Far enough out that neither `card_expired` nor the advisory
      // `card_expiring` can drift into these results as the suite ages.
      expYear: new Date().getUTCFullYear() + 5,
      isDefault: true,
    });
    await db.insert(userPurchasingConsentsTable).values({
      userId: id,
      termsVersion: CURRENT_STORED_CARD_TERMS_VERSION,
      termsSha256: STORED_CARD_TERMS_SHA256,
    });
    return { id, cookie: `sid=${sid}` };
  }

  /** A signed-in account with nothing on file. */
  async function bareUser(): Promise<{ id: string; cookie: string }> {
    const { id, sid } = await createWalletUser();
    userIds.push(id);
    sids.push(sid);
    return { id, cookie: `sid=${sid}` };
  }

  async function quoteFor(cookie: string): Promise<string> {
    const res = await request(app).post("/commerce/quote").set("Cookie", cookie).send({ sku });
    expect(res.status, `quote failed: ${JSON.stringify(res.body)} / ${lastError}`).toBe(200);
    return String(res.body.quoteId);
  }

  function ordersFor(userId: string) {
    return db.select().from(commerceOrdersTable).where(eq(commerceOrdersTable.buyerUserId, userId));
  }

  /**
   * An order row written straight to the table, so a case can set the status
   * and the age the cap is supposed to read. Nothing here goes through the
   * handler — the point is to pre-load history the handler then has to count.
   */
  async function seedOrder(
    userId: string,
    overrides: Partial<typeof commerceOrdersTable.$inferInsert> = {},
  ) {
    const [row] = await db
      .insert(commerceOrdersTable)
      .values({
        clientReference: randomUUID(),
        buyerUserId: userId,
        sku,
        itemCents: ITEM_CENTS,
        shippingCents: SHIPPING_CENTS,
        totalCents: TOTAL_CENTS,
        shipToName: ADDRESS.name,
        shipToLine1: ADDRESS.line1,
        shipToCity: ADDRESS.city,
        shipToRegion: ADDRESS.region,
        shipToPostalCode: ADDRESS.postalCode,
        shipToCountry: ADDRESS.country,
        status: "paid",
        ...overrides,
      })
      .returning();
    return row!;
  }

  /** A verified Stripe delivery, as the handler sees one. */
  function deliver(body: unknown) {
    return request(webhookApp)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=1,v1=verified-by-the-stand-in")
      .send(JSON.stringify(body));
  }

  function intentEvent(type: string, intentId: string, orderId: number | null) {
    return {
      type,
      data: {
        object: {
          id: intentId,
          metadata: orderId === null ? {} : { kaxCommerceOrderId: String(orderId) },
        },
      },
    };
  }

  describe("the flag gates the whole surface", () => {
    it("404s every route when KAX_COMMERCE_ENABLED is unset, session or not", async () => {
      // 404 and not 401: with the flag off this surface answers as if it were
      // never mounted. Remove the gate and each becomes a 401 from requireAuth
      // or a real response, so the assertion fails in either direction.
      const { cookie } = await readyBuyer();
      delete process.env["KAX_COMMERCE_ENABLED"];

      const attempts = [
        () => request(app).post("/commerce/quote").send({ sku }),
        () => request(app).post("/commerce/purchase").send({ quoteId: "x", clientReference: randomUUID() }),
        () => request(app).get(`/commerce/orders/${randomUUID()}`),
        () => request(app).get("/commerce/orders"),
        // The one route with no `requireAuth` behind the gate. Without the
        // gate covering it, a deployment with commerce off would still publish
        // its price list — and this is the case that would not fail as a 401.
        () => request(app).get("/commerce/products/for-artifact/1"),
      ];
      for (const attempt of attempts) {
        expect((await attempt()).status, "anonymous caller").toBe(404);
        expect((await attempt().set("Cookie", cookie)).status, "signed-in caller").toBe(404);
      }
      expect(fake.creates, "nothing reached Stripe on the way to a 404").toHaveLength(0);
    });

    it("serves the same routes once the flag is on", async () => {
      // The other half. Without it the 404 case above would also pass against a
      // router that was simply broken.
      const { cookie } = await readyBuyer();
      const res = await request(app).post("/commerce/quote").set("Cookie", cookie).send({ sku });
      expect(res.status, `reached: ${lastError}`).toBe(200);
    });

    it("still requires a session when the flag is on", async () => {
      expect((await request(app).post("/commerce/quote").send({ sku })).status).toBe(401);
    });
  });

  describe("POST /commerce/quote", () => {
    it("prices the product in integer cents with a five-minute expiry", async () => {
      const { cookie } = await readyBuyer();
      const before = Date.now();
      const res = await request(app).post("/commerce/quote").set("Cookie", cookie).send({ sku });

      expect(res.status, `reached: ${lastError}`).toBe(200);
      expect(res.body.totalCents).toBe(TOTAL_CENTS);
      expect(Number.isInteger(res.body.totalCents), "money is never a float here").toBe(true);
      // The lines have to add up to the total, or the panel shows one number and
      // the card is charged another.
      const summed = (res.body.lines as Array<{ amountCents: number }>).reduce(
        (n, line) => n + line.amountCents,
        0,
      );
      expect(summed).toBe(res.body.totalCents);
      const expiresAt = Date.parse(res.body.expiresAt);
      expect(expiresAt).toBeGreaterThan(before);
      expect(expiresAt).toBeLessThanOrEqual(before + 5 * 60 * 1000 + 5_000);
    });

    it("refuses an account that is not ready, with the reason, and issues no quote", async () => {
      // Same vocabulary the desk and `GET /me` use, so all three say the same
      // thing about the same account. Drop the recompute and this is a 200 with
      // a price the buyer can never pay.
      const { cookie } = await bareUser();
      const res = await request(app).post("/commerce/quote").set("Cookie", cookie).send({ sku });

      expect(res.status).toBe(409);
      expect(res.body.reason).toBe("not_configured");
      expect(res.body.quoteId).toBeUndefined();
    });

    it("refuses an unpublished product without confusing it with a missing route", async () => {
      // 409 with a reason, not 404 — on this router 404 means "the surface is
      // off", and collapsing the two would make an unpublished product
      // indistinguishable from a deployment with commerce disabled.
      const { cookie } = await readyBuyer();
      await db
        .update(commerceProductsTable)
        .set({ published: false })
        .where(eq(commerceProductsTable.sku, sku));

      const res = await request(app).post("/commerce/quote").set("Cookie", cookie).send({ sku });
      expect(res.status).toBe(409);
      expect(res.body.reason).toBe("product_unavailable");
    });

    it("refuses a destination the product does not ship to", async () => {
      const { cookie } = await readyBuyer();
      await db
        .update(commerceProductsTable)
        .set({ shipToCountries: ["CA"] })
        .where(eq(commerceProductsTable.sku, sku));

      const res = await request(app).post("/commerce/quote").set("Cookie", cookie).send({ sku });
      expect(res.status).toBe(409);
      expect(res.body.reason).toBe("unsupported_destination");
    });
  });

  describe("POST /commerce/purchase", () => {
    it("writes one order and charges once for two calls with the same clientReference", async () => {
      // The headline property. The row is written first with
      // onConflictDoNothing on the unique client reference, so the second call
      // finds the first call's order instead of creating another — and finds
      // its intent instead of creating another of those. Remove either half and
      // exactly one of these two counts goes to 2.
      const { id, cookie } = await readyBuyer();
      const quoteId = await quoteFor(cookie);
      const clientReference = randomUUID();

      const first = await request(app)
        .post("/commerce/purchase")
        .set("Cookie", cookie)
        .send({ quoteId, clientReference });
      expect(first.status, `reached: ${lastError}`).toBe(200);

      const second = await request(app)
        .post("/commerce/purchase")
        .set("Cookie", cookie)
        .send({ quoteId, clientReference });
      expect(second.status, `reached: ${lastError}`).toBe(200);

      expect(await ordersFor(id), "one press of Buy, one order").toHaveLength(1);
      expect(fake.creates, "one press of Buy, one charge").toHaveLength(1);
      // The retry READ the existing intent rather than creating another, which
      // is what makes a lost response recoverable instead of expensive.
      expect(fake.retrieved).toHaveLength(1);
      expect(second.body.orderRef).toBe(clientReference);
      // Pinned to the literal rather than to `first.body.status`. Comparing two
      // outputs of the same handler holds however wrong both of them are — a
      // regression that reported "processing" for a settled charge would pass.
      expect(first.body.status).toBe("paid");
      expect(second.body.status).toBe("paid");
      expect(second.body.orderStatus).toBe("paid");
    });

    it("writes one order and charges once for two SIMULTANEOUS calls on one reference", async () => {
      // The sequential case above exercises the step-1 pre-check and nothing
      // else: the first response has already landed before the second request
      // is sent, so the handler short-circuits at `loadOrderByReference` every
      // time. This one leaves both requests in flight, which is the case the
      // file header actually claims — the same clientReference twice must
      // produce exactly one row and exactly one `paymentIntents.create`.
      //
      // What stops it is the `SELECT … FOR UPDATE` on the buyer, the re-read of
      // the reference under that lock, and the idempotency key derived from the
      // row rather than from the request.
      //
      // The charge count is asserted as the number of INTENTS MINTED and not as
      // the number of `create` CALLS, deliberately. The loser of the lock can
      // reach `create` before the winner has written its intent id back to the
      // row, and when it does it presents the winner's key and Stripe hands
      // back the winner's intent — which is exactly the collapse the key exists
      // to buy, and one charge either way. Make the key per-request and the
      // stand-in mints a second intent, which is the real double charge.
      const { id, cookie } = await readyBuyer();
      const quoteId = await quoteFor(cookie);
      const clientReference = randomUUID();

      const press = () =>
        request(app).post("/commerce/purchase").set("Cookie", cookie).send({ quoteId, clientReference });
      const [a, b] = await Promise.all([press(), press()]);

      expect(a.status, `reached: ${lastError}`).toBe(200);
      expect(b.status, `reached: ${lastError}`).toBe(200);
      expect(await ordersFor(id), "two simultaneous presses, one order").toHaveLength(1);
      expect(fake.intents.size, "two simultaneous presses, one charge").toBe(1);
      expect(
        new Set(fake.creates.map((c) => c.options["idempotencyKey"])).size,
        "every attempt on this order presented the same key",
      ).toBe(1);
      expect(a.body.orderRef).toBe(clientReference);
      expect(b.body.orderRef).toBe(clientReference);
      // Neither may be told to start again with a new reference: the buyer
      // pressed once, and a conflict here would be the server disowning its own
      // idempotency contract.
      expect([a.body.reason, b.body.reason]).toEqual([undefined, undefined]);
    });

    it("does not hand a stranger's order to a simultaneous request naming its reference", async () => {
      // The buyer comparison is made TWICE — once at step 1 and again inside
      // the transaction — and the second one is not redundant: the row lock is
      // on this account's own row, so it serialises this account's purchases
      // and nobody else's. A different buyer's order can appear under the same
      // reference between the pre-check and the locked read. Drop the second
      // comparison and this caller is handed a stranger's order.
      const owner = await readyBuyer();
      const stranger = await readyBuyer();
      const clientReference = randomUUID();

      const [ownerRes, strangerRes] = await Promise.all([
        request(app)
          .post("/commerce/purchase")
          .set("Cookie", owner.cookie)
          .send({ quoteId: await quoteFor(owner.cookie), clientReference }),
        request(app)
          .post("/commerce/purchase")
          .set("Cookie", stranger.cookie)
          .send({ quoteId: await quoteFor(stranger.cookie), clientReference }),
      ]);

      // Exactly one of them owns the reference; the other is refused and told
      // nothing about the order it collided with.
      const [winner, loser] =
        ownerRes.status === 200 ? [ownerRes, strangerRes] : [strangerRes, ownerRes];
      expect(winner.status, `reached: ${lastError}`).toBe(200);
      expect(loser.status).toBe(409);
      expect(loser.body.reason).toBe("client_reference_conflict");
      expect(loser.body.orderRef, "not even the reference is echoed back").toBeUndefined();
      expect(loser.body.totalCents, "and certainly not the total").toBeUndefined();
      const rows = [...(await ordersFor(owner.id)), ...(await ordersFor(stranger.id))];
      expect(rows, "one reference, one order, one owner").toHaveLength(1);
    });

    it("keeps the idempotency key on the row's own reference, not on anything per-request", async () => {
      // A `serial` id is unique per DATABASE; this key has to be unique per
      // STRIPE ACCOUNT. Two deployments sharing one Stripe account both mint
      // order 1, the second sends the same key with different params, Stripe
      // answers 400 idempotency_error, and the order wedges at pending_payment
      // forever. The reference is a UUID and one-to-one with the row, so it
      // buys the same collapse without the collision — and it is still the
      // ROW's identity, so deriving the key from a fresh random value fails
      // here as loudly as deriving it from the client's own body would.
      const { id, cookie } = await readyBuyer();
      const clientReference = randomUUID();
      await request(app)
        .post("/commerce/purchase")
        .set("Cookie", cookie)
        .send({ quoteId: await quoteFor(cookie), clientReference });

      const [order] = await ordersFor(id);
      expect(order!.clientReference).toBe(clientReference);
      expect(fake.creates[0]!.options).toEqual({
        idempotencyKey: `kax-commerce-pi-${order!.clientReference}`,
      });
    });

    it("writes the order row before it says anything to Stripe", async () => {
      // Stated directly rather than inferred from the retry: the create call
      // carries the id of a row that must already exist for the metadata to be
      // fillable at all. Move the insert after the charge and there is no order
      // id to name.
      const { id, cookie } = await readyBuyer();
      const quoteId = await quoteFor(cookie);
      const clientReference = randomUUID();

      await request(app)
        .post("/commerce/purchase")
        .set("Cookie", cookie)
        .send({ quoteId, clientReference });

      const [order] = await ordersFor(id);
      expect(order).toBeDefined();
      expect(fake.creates[0]!.options).toEqual({
        idempotencyKey: `kax-commerce-pi-${clientReference}`,
      });
      expect(fake.creates[0]!.params).toMatchObject({
        metadata: { kaxCommerceOrderId: String(order!.id), kaxBuyerUserId: id },
      });
    });

    it("confirms on-session and never off-session", async () => {
      // The two params that turn a challenge the buyer can complete into a
      // decline they cannot. Asserted on the params object because that is the
      // only place their absence is a fact rather than an intention — and the
      // presence of `confirm`/`use_stripe_sdk` is asserted alongside, so a
      // handler that simply stopped confirming would not pass by omission.
      const { cookie } = await readyBuyer();
      const quoteId = await quoteFor(cookie);

      await request(app)
        .post("/commerce/purchase")
        .set("Cookie", cookie)
        .send({ quoteId, clientReference: randomUUID() });

      const params = fake.creates[0]!.params;
      expect(params).toMatchObject({ confirm: true, use_stripe_sdk: true, currency: "usd" });
      expect(params).not.toHaveProperty("off_session");
      expect(params).not.toHaveProperty("error_on_requires_action");
      expect(params["amount"], "the charge is the quoted total, in cents").toBe(TOTAL_CENTS);
    });

    it("refuses an account whose state has changed since the quote, whatever the client claims", async () => {
      // The real race, not a contrived one: the quote was issued to a ready
      // account and the card went away before Buy was pressed. The client sends
      // its own cheerful view of its state alongside; it is an unread key.
      // Remove the recompute in the purchase handler and this charges a
      // detached card.
      const { id, cookie } = await readyBuyer();
      const quoteId = await quoteFor(cookie);

      await db
        .update(userPaymentMethodsTable)
        .set({ detachedAt: new Date(), isDefault: false })
        .where(eq(userPaymentMethodsTable.userId, id));

      const res = await request(app)
        .post("/commerce/purchase")
        .set("Cookie", cookie)
        .send({
          quoteId,
          clientReference: randomUUID(),
          purchasing: { state: "ready", reasons: [] },
          ready: true,
        });

      expect(res.status, `reached: ${lastError}`).toBe(409);
      expect(res.body.reason).toBe("pm_detached");
      expect(await ordersFor(id), "a refusal must not leave an order behind").toHaveLength(0);
      expect(fake.creates, "and must not have charged anything").toHaveLength(0);
    });

    it("returns 410 for an expired quote and charges nothing", async () => {
      // Only the clock is faked, so the database driver's own timers keep
      // working. Six minutes past a five-minute quote.
      const { id, cookie } = await readyBuyer();
      const quoteId = await quoteFor(cookie);

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(Date.now() + 6 * 60 * 1000));
      const res = await request(app)
        .post("/commerce/purchase")
        .set("Cookie", cookie)
        .send({ quoteId, clientReference: randomUUID() });
      vi.useRealTimers();

      expect(res.status).toBe(410);
      expect(res.body.reason).toBe("quote_expired");
      expect(await ordersFor(id)).toHaveLength(0);
      expect(fake.creates).toHaveLength(0);
    });

    it("reports the order rather than expiring a retry of a charge already made", async () => {
      // The case the retry check exists for, and the reason it is asked of the
      // database before the quote is judged. The panel POSTed, the response was
      // lost, and it retries — possibly well past the five minutes. Judging the
      // quote first would answer 410 "get a new price" to a buyer whose card has
      // already been charged, which is the one thing the panel must never be
      // told.
      const { id, cookie } = await readyBuyer();
      const quoteId = await quoteFor(cookie);
      const clientReference = randomUUID();

      const first = await request(app)
        .post("/commerce/purchase")
        .set("Cookie", cookie)
        .send({ quoteId, clientReference });
      expect(first.status, `reached: ${lastError}`).toBe(200);

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(Date.now() + 6 * 60 * 1000));
      const retry = await request(app)
        .post("/commerce/purchase")
        .set("Cookie", cookie)
        .send({ quoteId, clientReference });
      vi.useRealTimers();

      expect(retry.status, `reached: ${lastError}`).toBe(200);
      expect(retry.body.orderRef).toBe(clientReference);
      expect(retry.body.status).toBe("paid");
      expect(await ordersFor(id)).toHaveLength(1);
      expect(fake.creates).toHaveLength(1);
    });

    it("refuses a quote it did not sign", async () => {
      // Without the signature the expiry is a number in a string the caller
      // controls, and the 410 above becomes unenforceable.
      const { cookie } = await readyBuyer();
      const forged = Buffer.from(
        JSON.stringify({
          v: 1,
          sku,
          buyerUserId: "whoever",
          currency: "usd",
          itemCents: 1,
          shippingCents: 0,
          taxCents: 0,
          totalCents: 1,
          issuedAt: Date.now(),
          expiresAt: Date.now() + 86_400_000,
        }),
        "utf8",
      ).toString("base64url");

      const res = await request(app)
        .post("/commerce/purchase")
        .set("Cookie", cookie)
        .send({ quoteId: `${forged}.notasignature`, clientReference: randomUUID() });

      expect(res.status).toBe(400);
      expect(res.body.reason).toBe("quote_invalid");
      expect(fake.creates).toHaveLength(0);
    });

    it("does not surrender another account's order to whoever names its reference", async () => {
      // `client_reference` is unique across the whole table, so the retry branch
      // can be handed a reference that resolves to somebody else's purchase.
      // Drop the buyer comparison and this caller is told the state — and the
      // total — of a stranger's order.
      const owner = await readyBuyer();
      const stranger = await readyBuyer();
      const clientReference = randomUUID();
      await request(app)
        .post("/commerce/purchase")
        .set("Cookie", owner.cookie)
        .send({ quoteId: await quoteFor(owner.cookie), clientReference });

      const res = await request(app)
        .post("/commerce/purchase")
        .set("Cookie", stranger.cookie)
        .send({ quoteId: await quoteFor(stranger.cookie), clientReference });

      expect(res.status).toBe(409);
      expect(res.body.reason).toBe("client_reference_conflict");
      expect(res.body.orderRef, "not even the reference is echoed back as an order").toBeUndefined();
      expect(await ordersFor(stranger.id)).toHaveLength(0);
      expect(fake.creates, "and the stranger's request charged nothing").toHaveLength(1);
    });

    it("refuses another account's quote", async () => {
      const buyer = await readyBuyer();
      const other = await readyBuyer();
      const quoteId = await quoteFor(other.cookie);

      const res = await request(app)
        .post("/commerce/purchase")
        .set("Cookie", buyer.cookie)
        .send({ quoteId, clientReference: randomUUID() });

      expect(res.status).toBe(403);
      expect(res.body.reason).toBe("quote_not_yours");
      expect(await ordersFor(buyer.id)).toHaveLength(0);
      expect(fake.creates).toHaveLength(0);
    });

    it("refuses a quote whose price has since moved, rather than charging either one", async () => {
      const { id, cookie } = await readyBuyer();
      const quoteId = await quoteFor(cookie);
      await db
        .update(commerceProductsTable)
        .set({ itemCents: ITEM_CENTS + 500 })
        .where(eq(commerceProductsTable.sku, sku));

      const res = await request(app)
        .post("/commerce/purchase")
        .set("Cookie", cookie)
        .send({ quoteId, clientReference: randomUUID() });

      expect(res.status).toBe(409);
      expect(res.body.reason).toBe("price_changed");
      expect(await ordersFor(id)).toHaveLength(0);
      expect(fake.creates).toHaveLength(0);
    });

    it("snapshots the shipping address, and a later address edit does not rewrite it", async () => {
      // The reason there is no foreign key to user_shipping_addresses. A buyer
      // who moves house would otherwise rewrite where an already-shipped order
      // went, and take the dispute evidence with it. Replace the ship_to_*
      // columns with a join and the second half of this fails.
      const { id, cookie } = await readyBuyer();
      const quoteId = await quoteFor(cookie);

      await request(app)
        .post("/commerce/purchase")
        .set("Cookie", cookie)
        .send({ quoteId, clientReference: randomUUID() });

      const [charged] = await ordersFor(id);
      expect(charged).toMatchObject({
        shipToName: ADDRESS.name,
        shipToLine1: ADDRESS.line1,
        shipToLine2: ADDRESS.line2,
        shipToCity: ADDRESS.city,
        shipToRegion: ADDRESS.region,
        shipToPostalCode: ADDRESS.postalCode,
        shipToCountry: ADDRESS.country,
        shipToPhone: ADDRESS.phone,
      });
      // And the address goes to Stripe from the snapshot too, so the card
      // statement and the parcel agree.
      expect(fake.creates[0]!.params["shipping"]).toMatchObject({
        name: ADDRESS.name,
        address: { line1: ADDRESS.line1, postal_code: ADDRESS.postalCode, country: "US" },
      });

      // The buyer moves: archive the live row and insert a new one, exactly as
      // PUT /me/purchasing/address does.
      await db
        .update(userShippingAddressesTable)
        .set({ archivedAt: new Date() })
        .where(
          and(
            eq(userShippingAddressesTable.userId, id),
            isNull(userShippingAddressesTable.archivedAt),
          ),
        );
      await db.insert(userShippingAddressesTable).values({
        userId: id,
        ...ADDRESS,
        line1: "999 Somewhere Else",
        postalCode: "10001",
        city: "New York",
        region: "NY",
      });

      const [after] = await ordersFor(id);
      expect(after!.shipToLine1, "the shipped-to address is history, not a pointer").toBe(ADDRESS.line1);
      expect(after!.shipToPostalCode).toBe(ADDRESS.postalCode);
    });

    it("returns the client secret only when the bank wants something", async () => {
      const { id, cookie } = await readyBuyer();

      const settled = await request(app)
        .post("/commerce/purchase")
        .set("Cookie", cookie)
        .send({ quoteId: await quoteFor(cookie), clientReference: randomUUID() });
      expect(settled.status, `reached: ${lastError}`).toBe(200);
      expect(settled.body.status).toBe("paid");
      // A secret handed out on a payment that is already done is a capability
      // the tab has no use for on every single purchase.
      expect(settled.body.clientSecret).toBeUndefined();

      fake.setNextStatus("requires_action");
      const challenged = await request(app)
        .post("/commerce/purchase")
        .set("Cookie", cookie)
        .send({ quoteId: await quoteFor(cookie), clientReference: randomUUID() });

      expect(challenged.status, `reached: ${lastError}`).toBe(200);
      expect(challenged.body.status).toBe("requires_action");
      expect(challenged.body.clientSecret, "there is nothing to complete without it").toMatch(/_secret$/);

      const rows = await ordersFor(id);
      expect(rows.map((r) => r.status).sort()).toEqual(["authenticating", "paid"]);
    });

    it("hands the same challenge back on a retry rather than starting a second one", async () => {
      // The panel's "network lost after POST" case: it does not know whether
      // the charge landed, so it retries with the same reference and must be
      // able to finish the challenge that is already open.
      const { cookie } = await readyBuyer();
      const quoteId = await quoteFor(cookie);
      const clientReference = randomUUID();
      fake.setNextStatus("requires_action");

      const first = await request(app)
        .post("/commerce/purchase")
        .set("Cookie", cookie)
        .send({ quoteId, clientReference });
      const retry = await request(app)
        .post("/commerce/purchase")
        .set("Cookie", cookie)
        .send({ quoteId, clientReference });

      expect(retry.status, `reached: ${lastError}`).toBe(200);
      expect(retry.body.status).toBe("requires_action");
      expect(retry.body.clientSecret).toBe(first.body.clientSecret);
      expect(fake.creates, "the retry must not have started a second payment").toHaveLength(1);
    });

    it("records a declined card on the order instead of raising", async () => {
      // A decline is an answer. Left to throw, the order would sit at
      // pending_payment beside a 500 — the state a later reconciliation cannot
      // tell apart from a response that was simply lost.
      const { id, cookie } = await readyBuyer();
      fake.setNextError(
        Object.assign(new Error("Your card was declined."), {
          type: "StripeCardError",
          code: "card_declined",
          decline_code: "generic_decline",
          payment_intent: { id: "pi_declined_1", status: "requires_payment_method" },
        }),
      );

      const res = await request(app)
        .post("/commerce/purchase")
        .set("Cookie", cookie)
        .send({ quoteId: await quoteFor(cookie), clientReference: randomUUID() });

      expect(res.status, `reached: ${lastError}`).toBe(402);
      expect(res.body.reason).toBe("card_declined");
      const [order] = await ordersFor(id);
      expect(order!.status).toBe("payment_failed");
      expect(order!.stripePaymentIntentId).toBe("pi_declined_1");
    });

    it("refuses a clientReference that is not a UUID before touching anything", async () => {
      const { id, cookie } = await readyBuyer();
      const res = await request(app)
        .post("/commerce/purchase")
        .set("Cookie", cookie)
        .send({ quoteId: await quoteFor(cookie), clientReference: "buy-button" });

      expect(res.status).toBe(400);
      expect(await ordersFor(id)).toHaveLength(0);
      expect(fake.creates).toHaveLength(0);
    });

    it("charges a retry of an intent-less row only if the account may still buy", async () => {
      // The row was written and never got a PaymentIntent — reachable in
      // production, because `finishPurchase` commits the row and only then
      // refuses with `instrument_unavailable`, and because a non-card error out
      // of `paymentIntents.create` re-throws and leaves the row at
      // pending_payment with a null intent. Handed to `finishPurchase`
      // unconditionally, such a row is chargeable forever with every
      // account-level control skipped. The one control the consent table exists
      // to enforce before a stored card is charged is the one asserted here.
      const { id, cookie } = await readyBuyer();
      const stale = await seedOrder(id, { status: "pending_payment", stripePaymentIntentId: null });
      await db
        .update(userPurchasingConsentsTable)
        .set({ termsVersion: "v0-superseded" })
        .where(eq(userPurchasingConsentsTable.userId, id));

      // No quote is sent, and that is the point: step 1 resolves the reference
      // against the database before it looks at the body at all, so a refusal
      // here can only have come from the account recompute this branch was
      // missing.
      const res = await request(app)
        .post("/commerce/purchase")
        .set("Cookie", cookie)
        .send({ quoteId: "unused", clientReference: stale.clientReference });

      expect(res.status, `reached: ${lastError}`).toBe(409);
      expect(res.body.reason).toBe("consent_stale");
      expect(fake.creates, "a retry of an uncharged row is a purchase, and it was refused").toHaveLength(0);
    });

    it("refuses a retry of an intent-less row once the cap is reached", async () => {
      // Same branch, the other control. The row being retried is deliberately
      // left OUT of the count — it is the purchase being retried, not a second
      // one — so this account is over the cap on its OTHER orders alone.
      process.env["KAX_COMMERCE_DAILY_ORDER_CAP"] = "2";
      const { id, cookie } = await readyBuyer();
      await seedOrder(id, { status: "paid" });
      await seedOrder(id, { status: "paid" });
      const stale = await seedOrder(id, { status: "pending_payment", stripePaymentIntentId: null });

      const res = await request(app)
        .post("/commerce/purchase")
        .set("Cookie", cookie)
        .send({ quoteId: "unused", clientReference: stale.clientReference });

      expect(res.status).toBe(409);
      expect(res.body.reason).toBe("cap_reached");
      expect(fake.creates).toHaveLength(0);
    });

    it("still reports a retry of a row that already carries an intent, unconditionally", async () => {
      // The other half of the split, and the one that must NOT acquire a gate:
      // this is a report on a charge already made, and refusing it would tell a
      // buyer whose card has been charged that they cannot buy. The account is
      // put in a state that would refuse a fresh purchase, and the retry still
      // answers with the order.
      const { id, cookie } = await readyBuyer();
      const clientReference = randomUUID();
      const first = await request(app)
        .post("/commerce/purchase")
        .set("Cookie", cookie)
        .send({ quoteId: await quoteFor(cookie), clientReference });
      expect(first.status, `reached: ${lastError}`).toBe(200);

      await db
        .update(userPaymentMethodsTable)
        .set({ detachedAt: new Date(), isDefault: false })
        .where(eq(userPaymentMethodsTable.userId, id));

      const retry = await request(app)
        .post("/commerce/purchase")
        .set("Cookie", cookie)
        .send({ quoteId: "unused", clientReference });

      expect(retry.status, `reached: ${lastError}`).toBe(200);
      expect(retry.body.orderRef).toBe(clientReference);
      expect(retry.body.orderStatus).toBe("paid");
      expect(fake.creates, "and it charged nothing a second time").toHaveLength(1);
    });

    it("refuses a retry of an intent-less row that has gone stale, rather than charging an old price", async () => {
      // The row's price and its address snapshot were current when it was
      // written. Past the quote's own TTL neither is, and a buyer who moved
      // house in between would get the parcel sent to the old street — which
      // inverts what the snapshot is for. Re-quote instead.
      const { id, cookie } = await readyBuyer();
      const stale = await seedOrder(id, {
        status: "pending_payment",
        stripePaymentIntentId: null,
        createdAt: new Date(Date.now() - 6 * 60 * 1000),
      });

      const res = await request(app)
        .post("/commerce/purchase")
        .set("Cookie", cookie)
        .send({ quoteId: "unused", clientReference: stale.clientReference });

      expect(res.status).toBe(410);
      expect(res.body.reason).toBe("quote_expired");
      expect(fake.creates).toHaveLength(0);
    });

    it("never returns the shipping address it just used", async () => {
      const { cookie } = await readyBuyer();
      const res = await request(app)
        .post("/commerce/purchase")
        .set("Cookie", cookie)
        .send({ quoteId: await quoteFor(cookie), clientReference: randomUUID() });

      const body = JSON.stringify(res.body);
      for (const secret of [ADDRESS.name, ADDRESS.line1, ADDRESS.line2, ADDRESS.city, ADDRESS.phone]) {
        expect(body, `${secret} must not leave the server`).not.toContain(secret);
      }
    });
  });

  describe("the 24-hour cap counts real rows and bounds real charges", () => {
    it("counts this buyer's recent orders and nobody else's, settled or not", async () => {
      // The cap is derived from a live query — buyer scope, a 24-hour window,
      // and a status filter — and until now nothing reached that query through
      // real rows at all. Drop the buyer filter and the stranger's order counts;
      // drop the window and the old one does; count only `paid` and the pending
      // one stops counting. Each of those makes one half of this fail.
      process.env["KAX_COMMERCE_DAILY_ORDER_CAP"] = "2";
      const { id, cookie } = await readyBuyer();
      const stranger = await readyBuyer();

      await seedOrder(id, { status: "paid" });
      await seedOrder(id, { status: "paid", createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });
      await seedOrder(stranger.id, { status: "paid" });

      const belowCap = await request(app).post("/commerce/quote").set("Cookie", cookie).send({ sku });
      expect(belowCap.status, `one in-window order is below a cap of two: ${lastError}`).toBe(200);

      // An unsettled order is a card already charged and a webhook still to
      // arrive. Counting only `paid` is what lets a burst pass the cap once per
      // request in the seconds before any of them settles.
      await seedOrder(id, { status: "pending_payment" });

      const atCap = await request(app).post("/commerce/quote").set("Cookie", cookie).send({ sku });
      expect(atCap.status).toBe(409);
      expect(atCap.body.reason).toBe("cap_reached");
      expect(atCap.body.quoteId).toBeUndefined();
    });

    it("refuses a purchase at the cap and charges nothing", async () => {
      process.env["KAX_COMMERCE_DAILY_ORDER_CAP"] = "1";
      const { id, cookie } = await readyBuyer();
      const quoteId = await quoteFor(cookie);
      await seedOrder(id, { status: "paid" });

      const res = await request(app)
        .post("/commerce/purchase")
        .set("Cookie", cookie)
        .send({ quoteId, clientReference: randomUUID() });

      expect(res.status).toBe(409);
      expect(res.body.reason).toBe("cap_reached");
      // Only the seeded order. A refusal must not leave a row of its own behind.
      expect(await ordersFor(id)).toHaveLength(1);
      expect(fake.creates).toHaveLength(0);
    });

    it("bounds a simultaneous burst, not just a sequential one", async () => {
      // The failure the cap had. `requireReady` counts outside any transaction,
      // so N presses fired together all observe the same pre-charge count, all
      // pass, and all reach `paymentIntents.create` under distinct idempotency
      // keys Stripe has no reason to collapse — the limit bounds nothing and the
      // number of cards charged in a burst is decided by the network.
      //
      // What bounds it is the `SELECT … FOR UPDATE` on the buyer plus the count
      // retaken inside that transaction. Remove either and `fake.creates` runs
      // to the number of presses.
      const cap = 2;
      const presses = cap + 2;
      process.env["KAX_COMMERCE_DAILY_ORDER_CAP"] = String(cap);
      const { id, cookie } = await readyBuyer();

      const quotes = await Promise.all(Array.from({ length: presses }, () => quoteFor(cookie)));
      const results = await Promise.all(
        quotes.map((quoteId) =>
          request(app)
            .post("/commerce/purchase")
            .set("Cookie", cookie)
            .send({ quoteId, clientReference: randomUUID() }),
        ),
      );

      expect(fake.creates.length, "the cap bounded the number of cards charged").toBeLessThanOrEqual(cap);
      expect((await ordersFor(id)).length, "and the number of order rows with it").toBeLessThanOrEqual(cap);
      // The brake has to actually let the allowed ones through, or a cap of two
      // that refused everything would also satisfy the bound above.
      expect(results.filter((r) => r.status === 200).length).toBeGreaterThan(0);
      expect(results.filter((r) => r.body.reason === "cap_reached").length).toBeGreaterThan(0);
    });
  });

  describe("a failed order write does not put the address in the log", () => {
    it("scrubs the query and its bound parameters off the commerce_orders insert", async () => {
      // The one statement in the whole feature that binds the buyer's entire
      // postal address as query parameters. drizzle wraps a failed statement in
      // a `DrizzleQueryError` whose OWN message is "Failed query: <sql>\nparams:
      // <values>" and which carries `params` as an own enumerable property, and
      // app.ts:124 logs whatever reaches it with `req.log.error({ err })` —
      // pino's serialiser emits the message, the cause chain and the own props
      // alike. So an unwrapped failure here writes a real buyer's street and
      // phone number into the production log from a handler that logs nothing.
      //
      // The failure is provoked for real rather than synthesised: a CHECK
      // constraint that this exact address violates, so the INSERT raises the
      // way a deadlock, a statement timeout or a dropped connection would.
      // Remove the try/catch in commerce.ts and the assertions below see
      // drizzle's raw message with "1 Test Way" in it.
      const { id, cookie } = await readyBuyer();
      const quoteId = await quoteFor(cookie);
      // DDL takes no bind parameters, and `NOT VALID` so the constraint judges
      // the write about to be made rather than any row already in the table.
      await db.execute(
        sql.raw(
          `ALTER TABLE commerce_orders ADD CONSTRAINT kax_test_reject_line1
           CHECK (ship_to_line1 <> '${ADDRESS.line1}') NOT VALID`,
        ),
      );

      try {
        const res = await request(app)
          .post("/commerce/purchase")
          .set("Cookie", cookie)
          .send({ quoteId, clientReference: randomUUID() });
        expect(res.status).toBe(500);
      } finally {
        await db.execute(sql`
          ALTER TABLE commerce_orders DROP CONSTRAINT IF EXISTS kax_test_reject_line1`);
      }

      // Everything a log line can reach off the error that escaped the handler.
      const err = lastErrorObject as Record<string, unknown> & { message?: string };
      const reachable = JSON.stringify({
        message: err?.message ?? null,
        cause: err?.["cause"] ?? null,
        params: err?.["params"] ?? null,
        query: err?.["query"] ?? null,
        own: Object.fromEntries(Object.entries(err ?? {})),
      });
      for (const secret of [
        ADDRESS.name,
        ADDRESS.line1,
        ADDRESS.line2,
        ADDRESS.city,
        ADDRESS.postalCode,
        ADDRESS.phone,
      ]) {
        expect(reachable, `${secret} must not survive into a loggable error`).not.toContain(secret);
      }
      expect(reachable).not.toContain("commerce_orders");
      // And it still says enough to diagnose: which write, and the SQLSTATE.
      expect(err?.message).toContain("commerce order write");
      expect(err?.message).toContain("23514");

      // The transaction rolled back and nothing was charged against a row that
      // does not exist.
      expect(await ordersFor(id)).toHaveLength(0);
      expect(fake.creates).toHaveLength(0);
    });
  });

  describe("the fail-closed schema probe", () => {
    it("503s while the schema is gone and recovers by itself once it is back", async () => {
      // This branch exists so a purchase cannot fail halfway, after a card has
      // been charged — and it was unreachable from any test, because the probe
      // cached its verdict in a module-level flag with no way back.
      //
      // The second half is the one that matters most. A `catch` cannot tell an
      // unmigrated deployment from a connection reset, so caching the NEGATIVE
      // would take a working shop dark for the life of the process on one
      // transient fault. Cache it and the recovery assertion below fails.
      const { cookie } = await readyBuyer();
      commerceModule.resetCommerceSchemaProbeForTests();
      await db.execute(sql`ALTER TABLE commerce_products RENAME TO commerce_products_probe_test`);

      try {
        const blocked = await request(app).post("/commerce/quote").set("Cookie", cookie).send({ sku });
        expect(blocked.status).toBe(503);
        expect(blocked.body.error).toContain("0026");
        expect(fake.creates, "nothing reached Stripe on the way to a 503").toHaveLength(0);
      } finally {
        await db.execute(sql`ALTER TABLE commerce_products_probe_test RENAME TO commerce_products`);
      }

      const recovered = await request(app).post("/commerce/quote").set("Cookie", cookie).send({ sku });
      expect(recovered.status, `the surface stayed dark after the schema came back: ${lastError}`).toBe(200);
    });
  });

  describe("GET /commerce/orders/:ref", () => {
    it("answers the owner and denies everyone else the same way it denies a stranger", async () => {
      // Owner-scoped by the WHERE clause that finds the row, so another
      // account's reference is indistinguishable from one that never existed.
      // Drop `buyer_user_id` from that clause and the second case becomes a 200
      // that names somebody else's purchase.
      const buyer = await readyBuyer();
      const other = await readyBuyer();
      const clientReference = randomUUID();
      await request(app)
        .post("/commerce/purchase")
        .set("Cookie", buyer.cookie)
        .send({ quoteId: await quoteFor(buyer.cookie), clientReference });

      const mine = await request(app)
        .get(`/commerce/orders/${clientReference}`)
        .set("Cookie", buyer.cookie);
      expect(mine.status, `reached: ${lastError}`).toBe(200);
      expect(mine.body).toMatchObject({
        orderRef: clientReference,
        status: "paid",
        orderStatus: "paid",
        totalCents: TOTAL_CENTS,
        fulfillmentState: "unfulfilled",
      });

      const theirs = await request(app)
        .get(`/commerce/orders/${clientReference}`)
        .set("Cookie", other.cookie);
      expect(theirs.status).toBe(404);
    });

    it("returns nothing about where the parcel is going", async () => {
      // The poll target is the endpoint a client hits repeatedly and logs
      // liberally. A `SELECT *` here would publish the whole address snapshot.
      const buyer = await readyBuyer();
      const clientReference = randomUUID();
      await request(app)
        .post("/commerce/purchase")
        .set("Cookie", buyer.cookie)
        .send({ quoteId: await quoteFor(buyer.cookie), clientReference });

      const res = await request(app)
        .get(`/commerce/orders/${clientReference}`)
        .set("Cookie", buyer.cookie);
      const body = JSON.stringify(res.body);
      for (const secret of [ADDRESS.name, ADDRESS.line1, ADDRESS.line2, ADDRESS.city, ADDRESS.phone]) {
        expect(body, `${secret} must not leave the server`).not.toContain(secret);
      }
    });
  });

  describe("GET /commerce/orders", () => {
    /**
     * The list `/orders` reads. `GET /commerce/orders/:ref` can only answer
     * about a reference the caller already holds, and a buyer who closed the
     * tab holds none — so without this endpoint a settled physical order is
     * unreachable from the application that placed it.
     */
    it("lists the caller's own orders, newest first, and nobody else's", async () => {
      // Owner scope is the whole security property of a list endpoint: the
      // WHERE clause is the only thing between this response and every order in
      // the table. Drop it and the second expectation below becomes a body
      // containing the stranger's reference.
      const buyer = await readyBuyer();
      const other = await readyBuyer();

      const older = await seedOrder(buyer.id, {
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      });
      const newer = await seedOrder(buyer.id, { status: "payment_failed" });
      const strangers = await seedOrder(other.id);

      const res = await request(app).get("/commerce/orders").set("Cookie", buyer.cookie);
      expect(res.status, `reached: ${lastError}`).toBe(200);

      const refs = (res.body.orders as Array<{ orderRef: string }>).map((o) => o.orderRef);
      expect(refs).toEqual([newer.clientReference, older.clientReference]);
      expect(refs, "another account's order").not.toContain(strangers.clientReference);

      // Both vocabularies, because the page renders one and switches on the
      // other: `orderStatus` is what happened, `status` is what the tab does.
      expect(res.body.orders[0]).toMatchObject({
        orderStatus: "payment_failed",
        status: "failed",
        fulfillmentState: "unfulfilled",
        totalCents: TOTAL_CENTS,
      });
    });

    it("returns nothing about where any parcel is going", async () => {
      // The widest read on this router — every order an account has ever
      // placed. A `SELECT *` here publishes the whole address snapshot of all
      // of them at once, which is why the columns are named one at a time.
      const buyer = await readyBuyer();
      await seedOrder(buyer.id);

      const res = await request(app).get("/commerce/orders").set("Cookie", buyer.cookie);
      const body = JSON.stringify(res.body);
      for (const secret of [ADDRESS.name, ADDRESS.line1, ADDRESS.city, ADDRESS.postalCode]) {
        expect(body, `${secret} must not leave the server`).not.toContain(secret);
      }
      // Anti-vacuity: the response really did carry the order, so the absences
      // above are absences from something rather than from an empty body.
      expect(res.body.orders).toHaveLength(1);
    });

    it("refuses an anonymous caller", async () => {
      const res = await request(app).get("/commerce/orders");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /commerce/products/for-artifact/:artifactId", () => {
    /**
     * The discovery read both buying surfaces need. `commerce_products` is keyed
     * on a SKU, so without this the SKU would have to be a constant in the
     * client — the same string in two repositories, and a `product_unavailable`
     * the day an operator renames one.
     */
    async function seedArtifact(): Promise<number> {
      const [artifact] = await db
        .insert(artifactsTable)
        .values({
          externalId: makeTestId("commerce-art"),
          title: "Commerce Test Piece",
          creatorName: "Selfheal",
          publicUrl: "https://example.invalid/piece",
          artifactType: "image",
        })
        .returning({ id: artifactsTable.id });
      artifactIds.push(artifact!.id);
      return artifact!.id;
    }

    it("lists a published product at the same total the quote will charge", async () => {
      // The shop window and the till have to agree. Both go through
      // `priceProduct`, and a second sum computed here would be the drift this
      // asserts against.
      const artifactId = await seedArtifact();
      await db
        .update(commerceProductsTable)
        .set({ artifactId })
        .where(eq(commerceProductsTable.sku, sku));

      const res = await request(app).get(`/commerce/products/for-artifact/${artifactId}`);
      expect(res.status, `reached: ${lastError}`).toBe(200);
      expect(res.body.products).toHaveLength(1);
      expect(res.body.products[0]).toMatchObject({
        sku,
        itemCents: ITEM_CENTS,
        shippingCents: SHIPPING_CENTS,
        taxCents: 0,
        totalCents: TOTAL_CENTS,
        shipToCountries: ["US"],
      });

      const buyer = await readyBuyer();
      const quote = await request(app).post("/commerce/quote").set("Cookie", buyer.cookie).send({ sku });
      expect(quote.body.totalCents).toBe(res.body.products[0].totalCents);
    });

    it("is readable without a session", async () => {
      // `/s/:slug/artifacts/:id` and `/s/:slug/room` are public routes, so a
      // signed-out visitor has to be able to see that a print exists before
      // being asked to sign in for it. A `requireAuth` here would make the
      // panel invisible to exactly the buyer it is trying to recruit.
      const artifactId = await seedArtifact();
      await db
        .update(commerceProductsTable)
        .set({ artifactId })
        .where(eq(commerceProductsTable.sku, sku));

      const res = await request(app).get(`/commerce/products/for-artifact/${artifactId}`);
      expect(res.status).toBe(200);
      expect(res.body.products).toHaveLength(1);
    });

    it("hides an unpublished product exactly as the quote refuses one", async () => {
      // `published` is the only thing that makes a row sellable and it defaults
      // to false — migration 0026 seeds the sticker unpublished on purpose. A
      // window that showed it would offer a Buy button the quote then answers
      // `product_unavailable` to.
      const artifactId = await seedArtifact();
      await db
        .update(commerceProductsTable)
        .set({ artifactId, published: false })
        .where(eq(commerceProductsTable.sku, sku));

      const res = await request(app).get(`/commerce/products/for-artifact/${artifactId}`);
      expect(res.status).toBe(200);
      expect(res.body.products).toEqual([]);

      const buyer = await readyBuyer();
      const quote = await request(app).post("/commerce/quote").set("Cookie", buyer.cookie).send({ sku });
      expect(quote.status).toBe(409);
      expect(quote.body.reason).toBe("product_unavailable");
    });

    it("does not answer for an artifact the product is not wired to", async () => {
      // The seeded product has a null `artifact_id` until an operator wires it.
      // A filter that fell back to "everything" would print every artifact's
      // page with somebody else's poster on it.
      const artifactId = await seedArtifact();
      const res = await request(app).get(`/commerce/products/for-artifact/${artifactId}`);
      expect(res.status).toBe(200);
      expect(res.body.products).toEqual([]);
    });

    it("never publishes the supplier's identifiers", async () => {
      // Printify's product and variant ids are our keys for our own catalogue.
      // They are what an admin endpoint submits an order with, and they have no
      // business in a public response.
      const artifactId = await seedArtifact();
      await db
        .update(commerceProductsTable)
        .set({ artifactId, printifyProductId: "kax-test-printify-product", printifyVariantId: "12345" })
        .where(eq(commerceProductsTable.sku, sku));

      const res = await request(app).get(`/commerce/products/for-artifact/${artifactId}`);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain("kax-test-printify-product");
      expect(body).not.toContain("12345");
      // Anti-vacuity: the product was in the response, so the absences are
      // absences from something.
      expect(res.body.products).toHaveLength(1);
    });

    it("refuses an artifact id that is not one", async () => {
      // `Number("nonsense")` is NaN, and a NaN reaching a WHERE clause is a 500.
      const res = await request(app).get("/commerce/products/for-artifact/nonsense");
      expect(res.status).toBe(400);
    });
  });

  describe("the Stripe webhook settles physical orders", () => {
    /** An order sitting at pending_payment with an intent id already on it. */
    async function pendingOrder(userId: string, intentId: string | null) {
      const clientReference = randomUUID();
      const [row] = await db
        .insert(commerceOrdersTable)
        .values({
          clientReference,
          buyerUserId: userId,
          sku,
          itemCents: ITEM_CENTS,
          shippingCents: SHIPPING_CENTS,
          totalCents: TOTAL_CENTS,
          shipToName: ADDRESS.name,
          shipToLine1: ADDRESS.line1,
          shipToCity: ADDRESS.city,
          shipToRegion: ADDRESS.region,
          shipToPostalCode: ADDRESS.postalCode,
          shipToCountry: ADDRESS.country,
          stripePaymentIntentId: intentId,
        })
        .returning();
      return row!;
    }

    async function statusOf(orderId: number): Promise<string> {
      const [row] = await db
        .select({ status: commerceOrdersTable.status })
        .from(commerceOrdersTable)
        .where(eq(commerceOrdersTable.id, orderId));
      return row!.status;
    }

    it("marks the order paid, and a redelivery changes nothing", async () => {
      const { id } = await bareUser();
      const order = await pendingOrder(id, "pi_hook_1");

      expect((await deliver(intentEvent("payment_intent.succeeded", "pi_hook_1", order.id))).status).toBe(200);
      expect(await statusOf(order.id)).toBe("paid");

      // Idempotent by the `status <> 'paid'` guard, which is what lets the
      // webhook and the client's own poll race each other safely.
      expect((await deliver(intentEvent("payment_intent.succeeded", "pi_hook_1", order.id))).status).toBe(200);
      expect(await statusOf(order.id)).toBe("paid");
    });

    it("does not un-pay an order when a late failure arrives", async () => {
      // Same guard, read the other way. Remove `status <> 'paid'` and a stale
      // payment_intent.payment_failed marks a settled order failed.
      const { id } = await bareUser();
      const order = await pendingOrder(id, "pi_hook_2");
      await deliver(intentEvent("payment_intent.succeeded", "pi_hook_2", order.id));

      expect((await deliver(intentEvent("payment_intent.payment_failed", "pi_hook_2", order.id))).status).toBe(200);
      expect(await statusOf(order.id)).toBe("paid");
    });

    it("settles an order whose row never received the intent id", async () => {
      // The window between Stripe creating the intent and us writing it down.
      // The intent-keyed statement cannot find this row, because the column it
      // keys on is the one that was never written. Remove the metadata fallback
      // and this order stays pending_payment with the card already charged.
      const { id } = await bareUser();
      const order = await pendingOrder(id, null);

      expect((await deliver(intentEvent("payment_intent.succeeded", "pi_orphan", order.id))).status).toBe(200);
      const [row] = await db
        .select()
        .from(commerceOrdersTable)
        .where(eq(commerceOrdersTable.id, order.id));
      expect(row!.status).toBe("paid");
      expect(row!.stripePaymentIntentId).toBe("pi_orphan");
    });

    it("returns non-2xx when the state write fails, so Stripe redelivers", async () => {
      // The seam. The digital branch swallows and answers 200 because a lost
      // digital settlement is recovered by the buyer's own redirect to
      // /store/orders/confirm; the physical path has no redirect, so a
      // swallowed failure here is a charged card and an order nothing will look
      // at again. Change this branch to match the digital one and this fails.
      const { id } = await bareUser();
      const order = await pendingOrder(id, "pi_hook_3");
      control.settlementFailure = new Error("connection terminated");

      const res = await deliver(intentEvent("payment_intent.succeeded", "pi_hook_3", order.id));

      expect(res.status, "a 2xx here tells Stripe the order is settled").toBeGreaterThanOrEqual(500);
      expect(await statusOf(order.id)).toBe("pending_payment");
    });

    it("ignores a payment intent that is not ours", async () => {
      // The same Stripe account carries payments this table knows nothing
      // about. No metadata, no settlement, and no 500 either.
      const res = await deliver(intentEvent("payment_intent.succeeded", "pi_not_ours", null));
      expect(res.status).toBe(200);
    });

    /** A charge or dispute event, which names our order only by its intent. */
    function chargeEvent(type: string, intentId: string, status?: string) {
      return {
        type,
        data: { object: { id: `ch_${intentId}`, payment_intent: intentId, ...(status ? { status } : {}) } },
      };
    }

    it("marks a refunded order refunded, so the desk cannot ship it", async () => {
      // Without this branch an order refunded in the Stripe dashboard keeps
      // `status = 'paid'` forever, and `POST /admin/commerce-orders/:id/submit`
      // gates on exactly that literal — so the operator presses submit,
      // Printify prints and ships, and KAX pays a manufacturer for a parcel
      // against money that has already gone back to the buyer.
      const { id } = await bareUser();
      const order = await pendingOrder(id, "pi_refund_1");
      await deliver(intentEvent("payment_intent.succeeded", "pi_refund_1", order.id));
      expect(await statusOf(order.id)).toBe("paid");

      expect((await deliver(chargeEvent("charge.refunded", "pi_refund_1"))).status).toBe(200);
      expect(await statusOf(order.id), "the reversal must move the row out of paid").toBe("refunded");
    });

    it("marks a disputed order chargeback, and a won dispute puts it back", async () => {
      const { id } = await bareUser();
      const order = await pendingOrder(id, "pi_dispute_1");
      await deliver(intentEvent("payment_intent.succeeded", "pi_dispute_1", order.id));

      expect((await deliver(chargeEvent("charge.dispute.created", "pi_dispute_1"))).status).toBe(200);
      expect(await statusOf(order.id)).toBe("chargeback");

      // Closed in the merchant's favour: the funds are ours again, so the order
      // is fulfillable again. A dispute closed any other way stays a chargeback.
      expect((await deliver(chargeEvent("charge.dispute.closed", "pi_dispute_1", "won"))).status).toBe(200);
      expect(await statusOf(order.id)).toBe("paid");
    });

    it("does not resurrect a refunded order when a dispute closes in our favour", async () => {
      // The narrowing on `status = 'chargeback'`. Without it a won dispute on an
      // order that was also refunded silently re-marks it paid and hands a
      // submittable order back to the desk.
      const { id } = await bareUser();
      const order = await pendingOrder(id, "pi_refund_2");
      await deliver(intentEvent("payment_intent.succeeded", "pi_refund_2", order.id));
      await deliver(chargeEvent("charge.refunded", "pi_refund_2"));

      await deliver(chargeEvent("charge.dispute.closed", "pi_refund_2", "won"));
      expect(await statusOf(order.id)).toBe("refunded");
    });

    it("does not let a late payment failure overwrite a refund", async () => {
      // Stripe retries a failed-payment event for up to three days. The settle
      // guard is the whole terminal SET and not the single literal `paid`, so a
      // redelivery landing after the money went back cannot destroy the record
      // of the refund. Narrow the guard to `paid` and this reads
      // "payment_failed".
      const { id } = await bareUser();
      const order = await pendingOrder(id, "pi_refund_3");
      await deliver(intentEvent("payment_intent.succeeded", "pi_refund_3", order.id));
      await deliver(chargeEvent("charge.refunded", "pi_refund_3"));

      expect(
        (await deliver(intentEvent("payment_intent.payment_failed", "pi_refund_3", order.id))).status,
      ).toBe(200);
      expect(await statusOf(order.id)).toBe("refunded");
    });

    it("ignores a charge event for an intent this table does not know", async () => {
      const res = await deliver(chargeEvent("charge.refunded", "pi_not_ours_at_all"));
      expect(res.status).toBe(200);
    });

    it("still acknowledges a digital settlement it cannot match", async () => {
      // The digital branch's posture, exercised so that the physical branch's
      // 500 above is a difference between two live behaviours rather than a
      // claim about one.
      const res = await deliver({
        type: "checkout.session.completed",
        data: { object: { id: "cs_test_nonexistent", payment_status: "paid" } },
      });
      expect(res.status).toBe(200);
    });
  });

  describe("the rules this file is structurally held to", () => {
    it("cannot reach play_credit, the Joinery, or store_listings.price — on any file that states the rule", async () => {
      // Stated against the source because it is a rule about what may be
      // IMPORTED, and no runtime assertion can see an import that is never
      // exercised. play_credit must never buy a physical good, and the way that
      // is guaranteed is that no path from these files reaches the ledger at
      // all. Every module specifier is collected, static and dynamic alike, so a
      // multi-line import is not a way past this.
      //
      // Four files state this rule in their own prose and only one of them used
      // to be scanned. A ledger reach added to `purchasingFacts.ts` — which
      // commerce.ts imports — would have been invisible to a scan of commerce.ts
      // alone, so the whole local import graph of both entry points is walked
      // rather than their direct specifiers.
      const reached = await reachableSources([COMMERCE_SOURCE, PURCHASING_SOURCE]);

      expect(reached.size, "the walk reached almost nothing, so it proves nothing").toBeGreaterThan(5);
      for (const [path, code] of reached) {
        const specifiers = [
          ...code.matchAll(/from\s+["']([^"']+)["']/g),
          ...code.matchAll(/import\(\s*["']([^"']+)["']/g),
        ].map((m) => m[1]!);
        expect(specifiers.filter((s) => /joinery|ledger/i.test(s)), path).toEqual([]);

        // `store_listings.price` is one `real` column meaning play_credit minor
        // units in `lib/joinery.ts` and USD dollars in `store-checkout.ts`
        // (#269). The physical path is kept structurally out of reach of it
        // rather than carefully steered around it.
        expect(code, path).not.toContain("storeListingsTable");
        expect(code, path).not.toContain("store_listings");
      }

      // The two files the walk cannot reach — nothing on the purchase path
      // imports the admin fulfilment routes or the Printify adapter — but which
      // carry the same rule and touch the same rows.
      for (const source of [ADMIN_SOURCE, PRINTIFY_SOURCE]) {
        const code = stripComments(await readFile(source, "utf8"));
        const specifiers = [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
        // Anti-vacuity: prove the file was actually read and parsed, so a bad
        // path or an empty read cannot pass this by finding nothing to object
        // to. Keyed on file size and on at least one specifier rather than on
        // an import COUNT — `printifyClient.ts` deliberately imports almost
        // nothing, which is the property that keeps it out of reach of the
        // ledger, so a threshold would fail the very file whose leanness is
        // the point.
        expect(code.length, `${source} scan read no source`).toBeGreaterThan(1000);
        expect(specifiers.length, `${source} scan parsed no imports`).toBeGreaterThan(0);
        expect(specifiers.filter((s) => /joinery|ledger/i.test(s)), String(source)).toEqual([]);
      }
    });

    it("contains neither off_session nor error_on_requires_action anywhere", async () => {
      // The params assertion above covers the call that is made. This covers
      // the ones that are not — a second Stripe call added later, under a branch
      // no test happens to reach, would still be caught here.
      const code = stripComments(await readFile(COMMERCE_SOURCE, "utf8"));
      expect(code, "on-session confirmation is the whole point").toContain("use_stripe_sdk");
      expect(code).not.toContain("off_session");
      expect(code).not.toContain("error_on_requires_action");
    });
  });
});

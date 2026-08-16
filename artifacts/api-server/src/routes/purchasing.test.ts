/**
 * purchasing.test.ts — the settings desk, and the one thing it must never do.
 *
 * A server that accepts a `pm_...` id from a request body lets anyone attach a
 * stranger's card to their own account by naming it. So the client sends a
 * SetupIntent id instead, and the server retrieves that SetupIntent from
 * Stripe, checks its Customer against the one on this user's row, and reads the
 * payment method off it. The cases below attack that from both sides: a
 * SetupIntent belonging to somebody else's Customer, and a raw payment-method
 * id offered where the SetupIntent id goes.
 *
 * Everything else here is written the same way — against the guard, not around
 * it. Removing the country check, the ownership comparison, the archive-instead
 * -of-update, the server-side hash, or the user filter on the delete makes at
 * least two assertions fail, and the assertion that a refusal PERSISTED NOTHING
 * is stated separately from the status code every time, because a 403 that has
 * already written a row is the failure this file exists to catch.
 *
 * Stripe is stood in for. The stand-in records what it was asked, which is the
 * only way to assert on an idempotency key or on the fact that a card was never
 * fetched — neither of those appears in an HTTP response. It runs against CI's
 * real Postgres through the real authMiddleware, because the session cookie is
 * what decides whose account this is, and faking that would remove the input
 * every ownership case is about.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { db } from "@workspace/db";
import {
  userPaymentMethodsTable,
  userPurchasingConsentsTable,
  userShippingAddressesTable,
  usersTable,
} from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { authMiddleware } from "../middlewares/authMiddleware";
import { CURRENT_STORED_CARD_TERMS_VERSION } from "../lib/purchasingState";
import { STORED_CARD_TERMS_SHA256 } from "../lib/storedCardTerms";
import { cleanupAuthTestData, createWalletUser } from "../test-helpers";

// The route reaches Stripe through this module and nowhere else, so wrapping
// the one accessor is enough to stand in for the whole provider. `commerceEnabled`
// is deliberately left as the real implementation — the flag gate is one of the
// things under test, and a stubbed flag would prove nothing about it.
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

// Imported after the mock is registered, because this module resolves the
// Stripe accessor at load.
const purchasingModule = await import("./purchasing");
const purchasingRouter = purchasingModule.default;
const { scrubDatabaseError } = purchasingModule;

interface FakeSetupIntent {
  id: string;
  customer: string | null;
  payment_method: string | null;
  client_secret: string;
}

interface FakeCard {
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
}

/**
 * A Stripe stand-in that remembers everything it was asked.
 *
 * The recordings are the point. Whether a second Customer was created, whether
 * the create carried an idempotency key, whether a card was ever fetched for a
 * request that should have been refused before that — none of those are visible
 * in a response body, and all of them are the property being tested.
 */
function makeFakeStripe() {
  const customerCreates: Array<{ params: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const setupIntentsRetrieved: string[] = [];
  const paymentMethodsRetrieved: string[] = [];
  const detached: string[] = [];
  const intents = new Map<string, FakeSetupIntent>();
  const cards = new Map<string, FakeCard>();
  let seq = 0;

  function missing(kind: string): Error {
    return Object.assign(new Error(`No such ${kind}`), { code: "resource_missing", statusCode: 404 });
  }

  const client = {
    customers: {
      create: async (params: Record<string, unknown>, options: Record<string, unknown>) => {
        customerCreates.push({ params, options });
        return { id: `cus_test_${++seq}` };
      },
    },
    setupIntents: {
      create: async (params: { customer: string }) => {
        const id = `seti_test_${++seq}`;
        const intent: FakeSetupIntent = {
          id,
          customer: params.customer,
          payment_method: null,
          client_secret: `${id}_secret`,
        };
        intents.set(id, intent);
        return intent;
      },
      retrieve: async (id: string) => {
        setupIntentsRetrieved.push(id);
        const found = intents.get(id);
        if (!found) throw missing("setupintent");
        return found;
      },
    },
    paymentMethods: {
      retrieve: async (id: string) => {
        paymentMethodsRetrieved.push(id);
        const card = cards.get(id);
        if (!card) throw missing("payment_method");
        return { id, card };
      },
      detach: async (id: string) => {
        detached.push(id);
        return { id };
      },
    },
  };

  /** Mark a SetupIntent as confirmed with a card, the way Stripe.js would. */
  function confirm(setupIntentId: string, paymentMethodId: string, card: FakeCard): void {
    const intent = intents.get(setupIntentId);
    if (!intent) throw new Error(`test bug: unknown setup intent ${setupIntentId}`);
    intent.payment_method = paymentMethodId;
    cards.set(paymentMethodId, card);
  }

  return {
    client,
    confirm,
    customerCreates,
    setupIntentsRetrieved,
    paymentMethodsRetrieved,
    detached,
  };
}

const VISA: FakeCard = { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2035 };

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

let lastError: string | null = null;

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authMiddleware);
  app.use(purchasingRouter);
  // Express's own handler renders HTML, which says nothing about where the
  // request stopped. Keeping the message lets a failing assertion report
  // whether the route refused or threw on its way to the provider.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    lastError = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: lastError });
  });
  return app;
}

describe("purchasing settings (#284)", () => {
  let app: Express;
  let fake: ReturnType<typeof makeFakeStripe>;
  let priorFlag: string | undefined;
  const userIds: string[] = [];
  const sids: string[] = [];

  beforeEach(() => {
    lastError = null;
    app = buildApp();
    fake = makeFakeStripe();
    getStripeClientMock.mockResolvedValue(fake.client);
    priorFlag = process.env["KAX_COMMERCE_ENABLED"];
    process.env["KAX_COMMERCE_ENABLED"] = "1";
  });

  afterEach(async () => {
    // Single-fork runner: a leaked flag decides which branch a later file takes.
    if (priorFlag === undefined) delete process.env["KAX_COMMERCE_ENABLED"];
    else process.env["KAX_COMMERCE_ENABLED"] = priorFlag;
    // Put the real accessor back rather than leaving a mock that resolves
    // undefined: anything else sharing this module would fail somewhere
    // unrelated and blame itself.
    getStripeClientMock.mockImplementation(realGetStripeClient);
    await cleanupAuthTestData({ userIds: userIds.splice(0), sids: sids.splice(0) });
  });

  async function signedInUser(): Promise<{ id: string; cookie: string }> {
    const { id, sid } = await createWalletUser();
    userIds.push(id);
    sids.push(sid);
    return { id, cookie: `sid=${sid}` };
  }

  /** Run the real setup-intent endpoint and hand back the id it minted. */
  async function startSetup(cookie: string): Promise<string> {
    const res = await request(app).post("/me/purchasing/setup-intent").set("Cookie", cookie).send({});
    expect(res.status, `setup-intent failed: ${JSON.stringify(res.body)} / ${lastError}`).toBe(200);
    return String(res.body.clientSecret).replace(/_secret$/, "");
  }

  /** An account with a card saved through the real endpoint. */
  async function saveCard(cookie: string, paymentMethodId: string): Promise<void> {
    const setupIntentId = await startSetup(cookie);
    fake.confirm(setupIntentId, paymentMethodId, VISA);
    const res = await request(app)
      .post("/me/purchasing/payment-method")
      .set("Cookie", cookie)
      .send({ setupIntentId });
    expect(res.status, `save card failed: ${JSON.stringify(res.body)} / ${lastError}`).toBe(200);
  }

  function cardsFor(userId: string) {
    return db
      .select()
      .from(userPaymentMethodsTable)
      .where(eq(userPaymentMethodsTable.userId, userId));
  }

  function addressesFor(userId: string) {
    return db
      .select()
      .from(userShippingAddressesTable)
      .where(eq(userShippingAddressesTable.userId, userId));
  }

  function consentsFor(userId: string) {
    return db
      .select()
      .from(userPurchasingConsentsTable)
      .where(eq(userPurchasingConsentsTable.userId, userId));
  }

  async function customerIdOf(userId: string): Promise<string | null> {
    const [row] = await db
      .select({ stripeCustomerId: usersTable.stripeCustomerId })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    return row?.stripeCustomerId ?? null;
  }

  describe("the flag gates the whole surface", () => {
    it("404s every route when KAX_COMMERCE_ENABLED is unset, session or not", async () => {
      // 404 and not 401: with the flag off the surface answers as if it were
      // never mounted. Remove the gate and each of these becomes a 401 from
      // requireAuth (or a 200), so the assertion fails in either direction.
      delete process.env["KAX_COMMERCE_ENABLED"];
      const { cookie } = await signedInUser();

      const attempts = [
        () => request(app).get("/me/purchasing/terms"),
        () => request(app).post("/me/purchasing/setup-intent").send({}),
        () => request(app).post("/me/purchasing/payment-method").send({ setupIntentId: "seti_x" }),
        () => request(app).put("/me/purchasing/address").send(ADDRESS),
        () => request(app).post("/me/purchasing/consent").send({ termsVersion: CURRENT_STORED_CARD_TERMS_VERSION }),
        () => request(app).delete("/me/purchasing/payment-method"),
      ];

      for (const attempt of attempts) {
        expect((await attempt()).status, "anonymous caller").toBe(404);
        expect((await attempt().set("Cookie", cookie)).status, "signed-in caller").toBe(404);
      }
      // And nothing reached the provider on the way to any of those 404s.
      expect(fake.customerCreates).toHaveLength(0);
      expect(fake.setupIntentsRetrieved).toHaveLength(0);
    });

    it("serves the same routes once the flag is on", async () => {
      // The other half. Without this the 404 case above would also pass against
      // a router that was simply broken.
      const { cookie } = await signedInUser();
      const res = await request(app).get("/me/purchasing/terms").set("Cookie", cookie);
      expect(res.status).toBe(200);
    });

    it("still requires a session when the flag is on", async () => {
      const res = await request(app).post("/me/purchasing/setup-intent").send({});
      expect(res.status).toBe(401);
    });

    it("503s while 0026's tables are gone and recovers by itself once they are back", async () => {
      // The fail-closed branch, which no test could reach: the probe cached its
      // verdict in a module-level flag with no way back, so once the first
      // request in this file had seen the schema the 503 was unreachable.
      //
      // The recovery half is the one that matters. A `catch` cannot tell an
      // unmigrated deployment from a connection reset or a failover, so caching
      // the NEGATIVE would take the whole settings desk dark for the life of
      // the process on one transient fault, clearing only on a restart nobody
      // knows to perform. Cache it and the last assertion here fails.
      const { cookie } = await signedInUser();
      purchasingModule.resetPurchasingSchemaProbeForTests();
      await db.execute(sql`ALTER TABLE user_payment_methods RENAME TO user_payment_methods_probe`);

      try {
        const blocked = await request(app).get("/me/purchasing/terms").set("Cookie", cookie);
        expect(blocked.status).toBe(503);
        expect(blocked.body.error).toContain("0026");
        expect(fake.setupIntentsRetrieved, "nothing reached Stripe on the way to a 503").toHaveLength(0);
      } finally {
        await db.execute(sql`ALTER TABLE user_payment_methods_probe RENAME TO user_payment_methods`);
      }

      const recovered = await request(app).get("/me/purchasing/terms").set("Cookie", cookie);
      expect(recovered.status, `the desk stayed dark after the schema came back: ${lastError}`).toBe(200);
    });
  });

  describe("POST /me/purchasing/setup-intent", () => {
    it("does not create a second Stripe Customer on a second call", async () => {
      const { id, cookie } = await signedInUser();

      await startSetup(cookie);
      const afterFirst = await customerIdOf(id);
      expect(afterFirst, "the first call must persist the Customer").toMatch(/^cus_/);

      await startSetup(cookie);

      // The load-bearing pair. Drop the read of `users.stripe_customer_id` and
      // the count becomes 2; drop the persisting UPDATE and the id changes.
      expect(fake.customerCreates, "one account, one Customer").toHaveLength(1);
      expect(await customerIdOf(id)).toBe(afterFirst);
    });

    it("keys the create on the user so a lost response cannot double it either", async () => {
      // The read above only covers the case where the first call finished. The
      // idempotency key is what covers the one where Stripe created the
      // Customer and we never heard back — remove it and this fails while the
      // count assertion above still passes.
      const { id, cookie } = await signedInUser();
      await startSetup(cookie);

      expect(fake.customerCreates[0]!.options).toMatchObject({ idempotencyKey: `kax-customer-${id}` });
      expect(fake.customerCreates[0]!.params).toMatchObject({ metadata: { kaxUserId: id } });
      // A wallet-only account has no email, and Stripe rejects "" rather than
      // treating it as absent.
      expect(fake.customerCreates[0]!.params).not.toHaveProperty("email");
    });

    it("returns the client secret and not the Customer id", async () => {
      const { cookie } = await signedInUser();
      const res = await request(app).post("/me/purchasing/setup-intent").set("Cookie", cookie).send({});

      expect(res.status).toBe(200);
      expect(res.body.clientSecret).toMatch(/^seti_/);
      expect(JSON.stringify(res.body), "the client has no business knowing the Customer id").not.toContain("cus_");
    });
  });

  describe("POST /me/purchasing/payment-method", () => {
    it("refuses a SetupIntent belonging to another user's Customer, and persists nothing", async () => {
      // Both accounts are real and both have Stripe Customers, so the only
      // thing separating them is the ownership comparison. Remove it and the
      // attacker's row appears.
      const attacker = await signedInUser();
      const victim = await signedInUser();

      const victimIntentId = await startSetup(victim.cookie);
      fake.confirm(victimIntentId, "pm_victim_card", VISA);
      await startSetup(attacker.cookie);

      const res = await request(app)
        .post("/me/purchasing/payment-method")
        .set("Cookie", attacker.cookie)
        .send({ setupIntentId: victimIntentId });

      expect(res.status, `reached: ${lastError}`).toBe(403);
      expect(await cardsFor(attacker.id), "the refused card must not have been written").toHaveLength(0);
      expect(await cardsFor(victim.id), "and must not have been moved off its owner either").toHaveLength(0);
      // Stated separately: the refusal happens BEFORE the card is fetched, so a
      // guessed SetupIntent id cannot even be used to read brand and last four.
      expect(fake.paymentMethodsRetrieved).toHaveLength(0);
    });

    it("refuses a raw payment-method id offered in place of a SetupIntent id", async () => {
      // The shape of the attack the whole design exists to prevent. 400 at the
      // door, and Stripe is never consulted — widen the regex to a bare string
      // and the request instead reaches `setupIntents.retrieve`, which fails
      // both of these.
      const { id, cookie } = await signedInUser();
      await startSetup(cookie);
      const before = fake.setupIntentsRetrieved.length;

      const res = await request(app)
        .post("/me/purchasing/payment-method")
        .set("Cookie", cookie)
        .send({ setupIntentId: "pm_1234567890" });

      expect(res.status).toBe(400);
      expect(res.body.issues?.[0]?.path).toBe("setupIntentId");
      expect(fake.setupIntentsRetrieved).toHaveLength(before);
      expect(await cardsFor(id)).toHaveLength(0);
    });

    it("ignores a paymentMethodId sent alongside the SetupIntent id", async () => {
      // Belt and braces on the same hinge: even a well-formed request that also
      // names a card must save the card the SetupIntent points at.
      const { id, cookie } = await signedInUser();
      const setupIntentId = await startSetup(cookie);
      fake.confirm(setupIntentId, "pm_from_intent", VISA);

      const res = await request(app)
        .post("/me/purchasing/payment-method")
        .set("Cookie", cookie)
        .send({ setupIntentId, paymentMethodId: "pm_attacker_choice" });

      expect(res.status, `reached: ${lastError}`).toBe(200);
      const rows = await cardsFor(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.stripePaymentMethodId).toBe("pm_from_intent");
    });

    it("refuses an account that has no Customer of its own yet", async () => {
      // The null-equals-null hole. This account has never called setup-intent,
      // so `users.stripe_customer_id` is null; a comparison that treated that as
      // matching a customerless SetupIntent would attach an unowned card to
      // whoever asked first.
      const victim = await signedInUser();
      const victimIntentId = await startSetup(victim.cookie);
      fake.confirm(victimIntentId, "pm_victim_card", VISA);

      const stranger = await signedInUser();
      expect(await customerIdOf(stranger.id)).toBeNull();

      const res = await request(app)
        .post("/me/purchasing/payment-method")
        .set("Cookie", stranger.cookie)
        .send({ setupIntentId: victimIntentId });

      expect(res.status).toBe(403);
      expect(await cardsFor(stranger.id)).toHaveLength(0);
    });

    it("refuses an unknown SetupIntent id with the same answer", async () => {
      const { id, cookie } = await signedInUser();
      await startSetup(cookie);

      const res = await request(app)
        .post("/me/purchasing/payment-method")
        .set("Cookie", cookie)
        .send({ setupIntentId: "seti_nonexistent" });

      expect(res.status, `reached: ${lastError}`).toBe(403);
      expect(await cardsFor(id)).toHaveLength(0);
    });

    it("saves the display metadata of the caller's own confirmed card", async () => {
      const { id, cookie } = await signedInUser();
      const setupIntentId = await startSetup(cookie);
      fake.confirm(setupIntentId, "pm_own_card", VISA);

      const res = await request(app)
        .post("/me/purchasing/payment-method")
        .set("Cookie", cookie)
        .send({ setupIntentId });

      expect(res.status, `reached: ${lastError}`).toBe(200);
      const rows = await cardsFor(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        stripePaymentMethodId: "pm_own_card",
        brand: "visa",
        last4: "4242",
        expMonth: 12,
        expYear: 2035,
        isDefault: true,
      });
      // The response is the derived state, reached through the same module
      // `GET /me` uses, so the two can never disagree about this account.
      expect(res.body.purchasing.card).toMatchObject({ brand: "visa", last4: "4242" });
      expect(JSON.stringify(res.body), "the payment-method id is not the client's").not.toContain("pm_own_card");
    });

    it("refuses a SetupIntent that has not been confirmed with a card", async () => {
      const { id, cookie } = await signedInUser();
      const setupIntentId = await startSetup(cookie);

      const res = await request(app)
        .post("/me/purchasing/payment-method")
        .set("Cookie", cookie)
        .send({ setupIntentId });

      expect(res.status).toBe(409);
      expect(await cardsFor(id)).toHaveLength(0);
    });

    it("leaves exactly one default card when a second one is saved", async () => {
      // Two rows marked default make `selectCard()` pick by insertion order,
      // which is to say arbitrarily — and the card the panel names would stop
      // being the card a charge would use.
      const { id, cookie } = await signedInUser();
      await saveCard(cookie, "pm_first");
      await saveCard(cookie, "pm_second");

      const rows = await cardsFor(id);
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => r.isDefault)).toHaveLength(1);
      expect(rows.find((r) => r.isDefault)!.stripePaymentMethodId).toBe("pm_second");
    });

    it("refuses a card already saved to another account, and rolls the whole request back", async () => {
      // The second half of the card hinge, and the half nothing reached.
      // `stripe_payment_method_id` is unique across the WHOLE table, so a save
      // of a method another account already holds conflicts — and
      // `onConflictDoUpdate`'s `setWhere: userId` is what stops that conflict
      // being resolved by handing the row to whoever asked last. Remove it and
      // the card changes hands.
      //
      // The rollback is the other claim, and it is the expensive one: the
      // default-clearing UPDATE runs FIRST, so a refusal that committed half of
      // this would strip the buyer's working default card as the price of a
      // request that was denied. Return instead of throwing and the last
      // assertion fails.
      const owner = await signedInUser();
      await saveCard(owner.cookie, "pm_shared");

      const claimant = await signedInUser();
      await saveCard(claimant.cookie, "pm_claimants_own");
      const setupIntentId = await startSetup(claimant.cookie);
      fake.confirm(setupIntentId, "pm_shared", VISA);

      const res = await request(app)
        .post("/me/purchasing/payment-method")
        .set("Cookie", claimant.cookie)
        .send({ setupIntentId });

      expect(res.status, `reached: ${lastError}`).toBe(409);

      const claimantRows = await cardsFor(claimant.id);
      expect(
        claimantRows.map((r) => r.stripePaymentMethodId),
        "the claimant must not have acquired a row for a card that is not theirs",
      ).toEqual(["pm_claimants_own"]);
      expect(
        claimantRows[0]!.isDefault,
        "the denied request must not have cost them their working default card",
      ).toBe(true);
      expect(claimantRows[0]!.detachedAt).toBeNull();

      const ownerRows = await cardsFor(owner.id);
      expect(ownerRows.map((r) => r.stripePaymentMethodId)).toEqual(["pm_shared"]);
      expect(ownerRows[0]!.detachedAt, "and the owner's card is still attached").toBeNull();
      expect(ownerRows[0]!.isDefault).toBe(true);
    });
  });

  describe("PUT /me/purchasing/address", () => {
    it("refuses a country it cannot ship to with a field-level error and writes nothing", async () => {
      const { id, cookie } = await signedInUser();

      const res = await request(app)
        .put("/me/purchasing/address")
        .set("Cookie", cookie)
        .send({ ...ADDRESS, country: "GB" });

      expect(res.status, `reached: ${lastError}`).toBe(400);
      // Field-level, not "invalid address": the form has eight fields and the
      // buyer has to be told which one. Drop the refine and this is a 200.
      expect(res.body.issues).toContainEqual(
        expect.objectContaining({ path: "country" }),
      );
      expect(await addressesFor(id), "a refused address must not be stored").toHaveLength(0);
    });

    it("accepts a US address and archives the previous one rather than editing it", async () => {
      // Editing in place would rewrite where an earlier order had been sent.
      // Two rows, one archived, and the archived one still carrying the ORIGINAL
      // values is what separates archive-then-insert from update.
      const { id, cookie } = await signedInUser();

      const first = await request(app).put("/me/purchasing/address").set("Cookie", cookie).send(ADDRESS);
      expect(first.status, `reached: ${lastError}`).toBe(200);

      const second = await request(app)
        .put("/me/purchasing/address")
        .set("Cookie", cookie)
        .send({ ...ADDRESS, line1: "2 Second Street", postalCode: "97202" });
      expect(second.status, `reached: ${lastError}`).toBe(200);

      const rows = await addressesFor(id);
      expect(rows, "the earlier address must survive as history").toHaveLength(2);
      const live = rows.filter((r) => r.archivedAt === null);
      const archived = rows.filter((r) => r.archivedAt !== null);
      expect(live).toHaveLength(1);
      expect(archived).toHaveLength(1);
      expect(live[0]!.postalCode).toBe("97202");
      expect(archived[0]!.line1, "the archived row must not have been overwritten").toBe(ADDRESS.line1);
      expect(second.body.purchasing.shipsTo).toEqual({ country: "US", postalCode: "97202" });
    });

    it("normalises a lower-case country rather than refusing it", async () => {
      const { id, cookie } = await signedInUser();
      const res = await request(app)
        .put("/me/purchasing/address")
        .set("Cookie", cookie)
        .send({ ...ADDRESS, country: "us" });

      expect(res.status, `reached: ${lastError}`).toBe(200);
      const rows = await addressesFor(id);
      expect(rows[0]!.country, "stored upper-case so the shipping check is not case-dependent").toBe("US");
    });

    it("returns nothing about the address beyond a country and a postal code", async () => {
      // The first postal PII in this schema. The guard is stated over the whole
      // serialised body, so attaching the address anywhere in the response —
      // an echo, a confirmation, a debug field — fails here.
      const { cookie } = await signedInUser();
      const res = await request(app).put("/me/purchasing/address").set("Cookie", cookie).send(ADDRESS);

      const body = JSON.stringify(res.body);
      for (const secret of [ADDRESS.name, ADDRESS.line1, ADDRESS.line2, ADDRESS.city, ADDRESS.phone]) {
        expect(body, `${secret} must not leave the server`).not.toContain(secret);
      }
    });

    it("refuses a control character rather than failing on the write", async () => {
      // A NUL is not storable at all — Postgres rejects it as an invalid UTF-8
      // byte — so without this check it would surface as a failed INSERT on an
      // address that had already passed validation, which is both a 500 and, via
      // drizzle's error message, the leak the scrubber below exists for. The
      // rest of the class breaks a printed shipping label.
      const { id, cookie } = await signedInUser();

      const res = await request(app)
        .put("/me/purchasing/address")
        .set("Cookie", cookie)
        .send({ ...ADDRESS, name: "Buyer\u0000Smuggled" });

      expect(res.status).toBe(400);
      expect(res.body.issues).toContainEqual(expect.objectContaining({ path: "name" }));
      expect(await addressesFor(id)).toHaveLength(0);
    });

    it("names the offending field without repeating what was submitted", async () => {
      // An error message is a place a rejected address can escape to — into a
      // client-side log, a bug report, a screenshot. The refusal describes the
      // constraint, never the value.
      //
      // The INVALID field has to be the one carrying the PII, or the test
      // cannot fail for the guard it names: asserting that valid fields are
      // absent proves nothing, because a valid field produces no issue to
      // appear in regardless of what the handler echoes. So the over-long
      // street line is what is rejected, and the assertion is that the
      // submitted string itself is not in the response. Drop the
      // `.map(i => ({ path, message }))` projection and zod's raw issues carry
      // the field back out.
      const { cookie } = await signedInUser();
      const smuggled = `${ADDRESS.line1} ${"x".repeat(300)}`;
      const res = await request(app)
        .put("/me/purchasing/address")
        .set("Cookie", cookie)
        .send({ ...ADDRESS, line1: smuggled, name: "Buyer\u0000Smuggled" });

      expect(res.status).toBe(400);
      const body = JSON.stringify(res.body);
      expect(res.body.issues).toContainEqual(expect.objectContaining({ path: "line1" }));
      expect(res.body.issues).toContainEqual(expect.objectContaining({ path: "name" }));
      expect(body, "the submitted street must not come back out").not.toContain(smuggled);
      expect(body, "nor any part of it").not.toContain(ADDRESS.line1);
      expect(body, "nor the smuggled name").not.toContain("Smuggled");
      for (const secret of [ADDRESS.name, ADDRESS.line2, ADDRESS.city, ADDRESS.phone]) {
        expect(body, `${secret} must not appear in an error`).not.toContain(secret);
      }
    });
  });

  describe("a failed write does not put the address in the log", () => {
    it("strips the query and its bound parameters off a database error", async () => {
      // The leak this closes is not hypothetical. drizzle-orm builds every
      // failed statement into a `DrizzleQueryError` whose OWN message is
      // "Failed query: <sql>\nparams: <values>", and app.ts logs whatever
      // reaches it with `req.log.error({ err })`. For an address INSERT those
      // values are the recipient's name, their street and their phone number.
      //
      // Provoking a live failure is not something this suite can do on demand —
      // every column is unbounded varchar and control characters are refused
      // before the write — so the error is built to the exact shape drizzle
      // produces and the guarantee is stated against that.
      const params = [ADDRESS.name, ADDRESS.line1, ADDRESS.city, ADDRESS.phone];
      const drizzleError = Object.assign(
        new Error(
          `Failed query: insert into "user_shipping_addresses" ...\nparams: ${params.join(",")}`,
        ),
        {
          query: 'insert into "user_shipping_addresses" ...',
          params,
          cause: Object.assign(new Error("duplicate key value violates unique constraint"), {
            code: "23505",
          }),
        },
      );

      const scrubbed = scrubDatabaseError("shipping address write", drizzleError);

      // Everything a log line can reach: the message, and `cause`, which pino's
      // error serialiser walks. Re-parenting the original would undo the whole
      // exercise, so the absence of a cause is asserted, not assumed.
      const reachable = JSON.stringify({
        message: scrubbed.message,
        cause: (scrubbed as { cause?: unknown }).cause ?? null,
        params: (scrubbed as { params?: unknown }).params ?? null,
      });
      for (const secret of params) {
        expect(reachable, `${secret} must not survive into a loggable error`).not.toContain(secret);
      }
      expect(reachable).not.toContain("user_shipping_addresses");
      // And it still says enough to diagnose: which write, and the SQLSTATE.
      expect(scrubbed.message).toContain("shipping address write");
      expect(scrubbed.message).toContain("23505");
    });
  });

  describe("POST /me/purchasing/consent", () => {
    it("records the digest of the terms the server serves, not one the client sent", async () => {
      // A hash the caller can choose proves nothing about what they were shown.
      const { id, cookie } = await signedInUser();

      const terms = await request(app).get("/me/purchasing/terms").set("Cookie", cookie);
      expect(terms.status).toBe(200);

      const res = await request(app)
        .post("/me/purchasing/consent")
        .set("Cookie", cookie)
        .send({
          termsVersion: CURRENT_STORED_CARD_TERMS_VERSION,
          termsSha256: "0".repeat(64),
        });

      expect(res.status, `reached: ${lastError}`).toBe(200);
      const rows = await consentsFor(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.termsSha256).toBe(STORED_CARD_TERMS_SHA256);
      expect(rows[0]!.termsSha256, "the client's hash must have been ignored").not.toBe("0".repeat(64));
      // The digest recorded is the digest of the document that was served,
      // which is what makes the row evidence rather than a claim.
      expect(rows[0]!.termsSha256).toBe(terms.body.sha256);
      expect(res.body.purchasing.consentVersion).toBe(CURRENT_STORED_CARD_TERMS_VERSION);
    });

    it("refuses a version it did not serve and writes no row", async () => {
      // Consent to a document nobody displayed is not consent.
      const { id, cookie } = await signedInUser();

      const res = await request(app)
        .post("/me/purchasing/consent")
        .set("Cookie", cookie)
        .send({ termsVersion: "v0-superseded" });

      expect(res.status).toBe(409);
      expect(res.body.currentVersion).toBe(CURRENT_STORED_CARD_TERMS_VERSION);
      expect(await consentsFor(id)).toHaveLength(0);
    });
  });

  describe("DELETE /me/purchasing/payment-method", () => {
    it("detaches the caller's card at Stripe and stamps the row", async () => {
      const { id, cookie } = await signedInUser();
      await saveCard(cookie, "pm_to_remove");

      const res = await request(app).delete("/me/purchasing/payment-method").set("Cookie", cookie);

      expect(res.status, `reached: ${lastError}`).toBe(200);
      expect(fake.detached, "Stripe has to be told, or the card stays chargeable").toEqual(["pm_to_remove"]);
      const rows = await cardsFor(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.detachedAt, "the row is stamped, not deleted").not.toBeNull();
      // The distinction the stamped-rather-than-deleted row exists to preserve:
      // this account HAD a card and it is gone, which is different copy from
      // never having had one. Delete the row instead and this account becomes
      // indistinguishable from one that never set anything up.
      expect(res.body.purchasing.reasons).toContain("pm_detached");
      expect(res.body.purchasing.card).toBeNull();
    });

    it("cannot reach another account's card", async () => {
      // The row is found by user id, never by an id from the request. Drop the
      // user filter and the global ordering hands this caller somebody else's
      // newest card.
      const owner = await signedInUser();
      await saveCard(owner.cookie, "pm_owner_card");
      const other = await signedInUser();
      await saveCard(other.cookie, "pm_other_card");

      const res = await request(app).delete("/me/purchasing/payment-method").set("Cookie", owner.cookie);

      expect(res.status, `reached: ${lastError}`).toBe(200);
      expect(fake.detached).toEqual(["pm_owner_card"]);
      const otherRows = await cardsFor(other.id);
      expect(otherRows[0]!.detachedAt, "an untouched account's card must stay attached").toBeNull();
    });

    it("404s when there is nothing to remove, without calling Stripe", async () => {
      const { cookie } = await signedInUser();
      const res = await request(app).delete("/me/purchasing/payment-method").set("Cookie", cookie);

      expect(res.status).toBe(404);
      expect(fake.detached).toHaveLength(0);
    });

    it("does not detach the same card twice", async () => {
      const { cookie } = await signedInUser();
      await saveCard(cookie, "pm_once");

      expect((await request(app).delete("/me/purchasing/payment-method").set("Cookie", cookie)).status).toBe(200);
      const second = await request(app).delete("/me/purchasing/payment-method").set("Cookie", cookie);

      // The stamped row is no longer live, so there is nothing left to remove.
      expect(second.status).toBe(404);
      expect(fake.detached).toEqual(["pm_once"]);
    });
  });
});

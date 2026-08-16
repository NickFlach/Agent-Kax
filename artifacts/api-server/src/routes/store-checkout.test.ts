/**
 * store-checkout.test.ts — the fiat till must not sell what the Joinery prices.
 *
 * `store_listings.price` is a single `real` column with two readers that
 * disagree about its unit. lib/joinery.ts reads it as play_credit minor units
 * and debits that number verbatim through the ledger; this route reads the
 * same column as USD dollars and multiplies by 100. A chair listed at 1000 is
 * 0.001 credits to the Joinery and $1,000.00 to Stripe, and the Stripe side is
 * real money — so the direction of the error is the dangerous one (#269).
 *
 * Nothing structural separated the two. The checkout selected on listing id
 * alone, so every furniture listing was reachable from it, and the
 * `amountCents >= 50` floor screened out nothing because `list()` only ever
 * stores a positive whole number of minor units.
 *
 * What these cases pin down is therefore a pair, not a single refusal: that
 * furniture is refused BEFORE anything is charged, and that an ordinary priced
 * listing still reaches the payment provider. A guard written too wide would
 * close the hole and the shop with it, and only the second case would notice.
 *
 * The second suite covers #272: where the buyer is sent back to after the card
 * has been charged.
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import { db } from "@workspace/db";
import { artifactsTable, listingOrdersTable, storeListingsTable } from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";
import { MAX_LIST_PRICE_MINOR } from "../lib/joinery-core";
import { cleanupTestData, createTestAgent, createTestUser } from "../test-helpers";

// Wrap the credential fetch so a case can hand the route a Stripe stand-in.
// The default is still the real implementation, because "how far did this
// request get" is exactly what the #269 cases below measure, and they measure
// it by where it fails. Only the #272 cases, which have to read the redirect
// URLs off a created session, swap in a stub.
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

const storeCheckoutRouter = (await import("./store-checkout")).default;
const agentStorefrontRouter = (await import("./agent-storefront")).default;

/**
 * Every variable that decides how far a checkout gets or where it points the
 * buyer afterwards: the set `getStripeCredentials()` reads, plus the redirect
 * base's configuration. Each suite clears the lot and puts back what it found,
 * so neither the developer's shell nor a sibling case can silently change which
 * branch a test is exercising.
 */
const MANAGED_ENV = [
  "KAX_COMMERCE_ENABLED",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "REPLIT_CONNECTORS_HOSTNAME",
  "REPL_IDENTITY",
  "WEB_REPL_RENEWAL",
  "KAX_PUBLIC_URL",
  "REPLIT_DEV_DOMAIN",
  "REPLIT_DOMAINS",
] as const;

const priorEnv: Record<string, string | undefined> = {};

function clearManagedEnv(): void {
  for (const key of MANAGED_ENV) {
    priorEnv[key] = process.env[key];
    delete process.env[key];
  }
}

function restoreManagedEnv(): void {
  for (const key of MANAGED_ENV) {
    if (priorEnv[key] === undefined) delete process.env[key];
    else process.env[key] = priorEnv[key];
  }
}

/** The last error the router handed to Express, so a test can prove how far a request got. */
let lastError: string | null = null;

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const userId = req.header("x-test-user");
    if (userId) (req as unknown as { user: { id: string } }).user = { id: userId };
    req.isAuthenticated = function (this: Request) {
      return this.user != null;
    } as Request["isAuthenticated"];
    next();
  });
  app.use(storeCheckoutRouter);
  app.use(agentStorefrontRouter);
  // Express's own handler renders HTML, which says nothing useful about where
  // the request stopped. Keeping the message lets a test distinguish "refused
  // by the guard" from "ran all the way to the payment provider".
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    lastError = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: lastError });
  });
  return app;
}

const artifactIds: number[] = [];
const listingIds: number[] = [];

/** An artifact of `type` listed in `storeAgentId`'s store at `price`. */
async function stock(type: "furniture" | "image", price: number | null, storeAgentId: number): Promise<number> {
  const id = await makeArtifact(type);
  const [listing] = await db
    .insert(storeListingsTable)
    .values({ storeAgentId, artifactId: id, price })
    .returning({ id: storeListingsTable.id });
  listingIds.push(listing!.id);
  return listing!.id;
}

async function makeArtifact(type: "furniture" | "image"): Promise<number> {
  const [artifact] = await db
    .insert(artifactsTable)
    .values({
      externalId: `test-checkout-${type}-${Math.random().toString(36).slice(2)}`,
      title: `Test ${type} for checkout`,
      creatorName: "Test Maker Of Things",
      publicUrl: "https://example.invalid/piece",
      artifactType: type,
    })
    .returning({ id: artifactsTable.id });
  artifactIds.push(artifact!.id);
  return artifact!.id;
}

// Both suites stock the same tables, so the teardown belongs to the file
// rather than to whichever suite happens to finish first. Orders cascade from
// their listing, so nothing here has to reach into `listing_orders`.
afterAll(async () => {
  if (listingIds.length) {
    await db.delete(storeListingsTable).where(inArray(storeListingsTable.id, listingIds));
  }
  if (artifactIds.length) {
    await db.delete(artifactsTable).where(inArray(artifactsTable.id, artifactIds));
  }
  await cleanupTestData();
});

describe("POST /store/listings/:id/checkout currency guard (#269)", () => {
  const app = buildApp();

  let buyer: { id: string };
  let store: { id: number; slug: string };
  let furnitureListingId: number;
  let maxPricedFurnitureListingId: number;
  let ordinaryListingId: number;

  beforeAll(async () => {
    buyer = await createTestUser({ emailLabel: "checkout-buyer" });
    const owner = await createTestUser({ emailLabel: "checkout-owner" });
    store = await createTestAgent(owner.id, "checkout-store");

    // 1000 is what the Joinery stores for a chair priced at 0.001 credits.
    // Read as dollars it is $1,000.00.
    furnitureListingId = await stock("furniture", 1000, store.id);
    // The ceiling `list()` permits: one whole play_credit, and $1,000,000.00
    // if this route is allowed to read it.
    maxPricedFurnitureListingId = await stock("furniture", MAX_LIST_PRICE_MINOR, store.id);
    // A genuine fiat listing: an image priced as the dollars it means.
    ordinaryListingId = await stock("image", 12.5, store.id);
  });

  beforeEach(() => {
    lastError = null;
    // Cleared so a checkout that gets past the guard fails on credentials
    // instead of reaching the network, which keeps the "it proceeded"
    // assertion offline and deterministic.
    clearManagedEnv();
    process.env.KAX_COMMERCE_ENABLED = "1";
    // The redirect base is configuration since #272, and an unconfigured one is
    // refused before the listing is even read. These cases are about what the
    // route does with a price, so give them a base to get past that.
    process.env.KAX_PUBLIC_URL = "https://kax.test.invalid";
  });

  afterEach(restoreManagedEnv);

  function checkout(listingId: number) {
    return request(app).post(`/store/listings/${listingId}/checkout`).set("x-test-user", buyer.id);
  }

  it("refuses a furniture listing instead of charging its minor units as dollars", async () => {
    const res = await checkout(furnitureListingId);

    // Without the guard this listing sails through every check the route has —
    // 100000 cents clears the $0.50 floor and is a clean two-decimal amount —
    // and stops only where Stripe credentials are missing, i.e. with a 500 and
    // an intent to charge $1,000.00 for 0.001 credits' worth of chair.
    expect(res.status, `guard did not fire; request reached: ${lastError}`).toBe(409);
    expect(res.body.error).toMatch(/furniture/i);
    expect(res.body.error).toMatch(/joinery/i);
    expect(lastError, "the refusal must happen before the payment provider is touched").toBeNull();
  });

  it("refuses the largest price the Joinery can store, which is one credit", async () => {
    // MAX_LIST_PRICE_MINOR is 1,000,000 minor units — one play_credit — and
    // $1,000,000.00 read as dollars. It is the worst case of the same defect
    // and must not depend on a magnitude check to be caught.
    const res = await checkout(maxPricedFurnitureListingId);

    expect(res.status, `guard did not fire; request reached: ${lastError}`).toBe(409);
    expect(lastError).toBeNull();
  });

  it("still lets an ordinary priced listing through to the payment provider", async () => {
    // The half a too-wide guard would break. This must get past the type check
    // and the price checks and stop only at the Stripe credential fetch, which
    // is unreachable here because every credential variable is cleared above.
    const res = await checkout(ordinaryListingId);

    expect(res.status, "a non-furniture listing must not be refused as furniture").not.toBe(409);
    expect(lastError, "the request should have reached the Stripe client").toMatch(/Stripe|Replit/i);
  });

  it("still 404s the whole surface when commerce is off", async () => {
    // The flag is what has been holding this defect out of production, so the
    // guard must not be what accidentally starts serving the surface.
    delete process.env.KAX_COMMERCE_ENABLED;

    const res = await checkout(ordinaryListingId);
    expect(res.status).toBe(404);
  });

  /**
   * The other way a priced furniture listing can come into existence. The
   * curation endpoint takes a bare number and never looks at the artifact's
   * type, so it could write a furniture price into the same ambiguous column
   * without the Joinery's minor-unit validation ever running. The checkout
   * guard above already makes such a row unsellable in fiat; this refuses to
   * create it in the first place.
   */
  describe("POST /agents/:slug/listings", () => {
    let owner: { id: string };
    let curatedStore: { id: number; slug: string };

    beforeEach(async () => {
      owner = await createTestUser({ emailLabel: "curator" });
      curatedStore = await createTestAgent(owner.id, "curated-store");
    });

    it("refuses to price furniture", async () => {
      const artifactId = await makeArtifact("furniture");

      const res = await request(app)
        .post(`/agents/${curatedStore.slug}/listings`)
        .set("x-test-user", owner.id)
        .send({ artifactId, price: 1000 });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/joinery/i);
      const rows = await db
        .select({ id: storeListingsTable.id })
        .from(storeListingsTable)
        .where(eq(storeListingsTable.artifactId, artifactId));
      expect(rows, "the refused listing must not have been written").toHaveLength(0);
    });

    it("still stocks furniture with no price, which is display rather than sale", async () => {
      // A NULL price carries no unit and so cannot be misread; refusing it too
      // would take the showroom down along with the ambiguity.
      const artifactId = await makeArtifact("furniture");

      const res = await request(app)
        .post(`/agents/${curatedStore.slug}/listings`)
        .set("x-test-user", owner.id)
        .send({ artifactId });

      expect(res.status, `unexpected refusal: ${JSON.stringify(res.body)}`).toBe(201);
      listingIds.push(res.body.id);
      expect(res.body.price).toBeNull();
    });

    it("still prices a non-furniture work", async () => {
      const artifactId = await makeArtifact("image");

      const res = await request(app)
        .post(`/agents/${curatedStore.slug}/listings`)
        .set("x-test-user", owner.id)
        .send({ artifactId, price: 12.5 });

      expect(res.status, `unexpected refusal: ${JSON.stringify(res.body)}`).toBe(201);
      listingIds.push(res.body.id);
      expect(res.body.price).toBe(12.5);
    });
  });
});

interface CapturedSession {
  success_url?: string;
  cancel_url?: string;
}

/**
 * A Stripe stand-in that records the sessions it is asked to create. The
 * redirect targets exist only in that call — the route hands back a session id
 * and a Stripe-hosted URL — so there is no way to assert on them from the HTTP
 * response, and no way to read them at all without standing in for Stripe.
 */
function fakeStripeClient(captured: CapturedSession[]): unknown {
  return {
    products: { create: async () => ({ id: "prod_test_redirect" }) },
    prices: {
      // Answered as unusable every time so the route always mints a fresh
      // price and no case depends on which one ran before it.
      retrieve: async () => ({ id: "price_stale", unit_amount: 0, active: false }),
      create: async () => ({ id: "price_test_redirect" }),
    },
    checkout: {
      sessions: {
        create: async (params: CapturedSession) => {
          captured.push(params);
          return { id: `cs_test_${randomUUID()}`, url: "https://checkout.stripe.test/c/pay/cs_test" };
        },
      },
    },
  };
}

/**
 * #272 — where the buyer lands after the card has been charged.
 *
 * `success_url` used to be chosen by `req.get("origin")`, with the `Host`
 * header as the last-resort fallback, so the caller of the checkout POST named
 * the host the buyer was returned to. Stripe honours whatever URL the session
 * was created with, and the redirect arrives at the instant a buyer is most
 * primed to believe a page about their own order, which makes it the worst
 * open redirect the system can have.
 *
 * So these cases are about provenance rather than about any one value: the
 * base comes from configuration, the same precedence `resetLinkBase()` uses,
 * and a request that carries a foreign `Origin` or `Host` changes nothing. The
 * unconfigured case is the load-bearing one — the temptation is always to fall
 * back to something derived from the request, and the whole point is that a
 * refused sale beats a completed one that ends on someone else's page.
 */
describe("POST /store/listings/:id/checkout redirect base (#272)", () => {
  const app = buildApp();
  const FOREIGN_ORIGIN = "https://checkout-thief.invalid";
  const CONFIGURED = "https://kax.test.invalid";

  let buyer: { id: string };
  let listingId: number;
  let captured: CapturedSession[];

  beforeAll(async () => {
    buyer = await createTestUser({ emailLabel: "redirect-buyer" });
    const owner = await createTestUser({ emailLabel: "redirect-owner" });
    const store = await createTestAgent(owner.id, "redirect-store");
    listingId = await stock("image", 12.5, store.id);
  });

  beforeEach(() => {
    lastError = null;
    captured = [];
    clearManagedEnv();
    process.env.KAX_COMMERCE_ENABLED = "1";
    getStripeClientMock.mockResolvedValue(fakeStripeClient(captured));
  });

  afterEach(() => {
    restoreManagedEnv();
    getStripeClientMock.mockImplementation(realGetStripeClient);
  });

  function checkout() {
    return request(app).post(`/store/listings/${listingId}/checkout`).set("x-test-user", buyer.id);
  }

  it("sends the buyer to the configured base even when the request claims another origin", async () => {
    process.env.KAX_PUBLIC_URL = CONFIGURED;

    const res = await checkout().set("Origin", FOREIGN_ORIGIN);

    expect(res.status, `unexpected refusal: ${JSON.stringify(res.body)} / ${lastError}`).toBe(200);
    expect(captured, "the session should have been created").toHaveLength(1);
    const session = captured[0]!;
    expect(session.success_url).toBe(`${CONFIGURED}/checkout/success?session_id={CHECKOUT_SESSION_ID}`);
    expect(session.cancel_url).toBe(`${CONFIGURED}/checkout/cancel`);
    // Stated separately from the equality above so a later change to the path
    // can never quietly turn this into an assertion about nothing.
    expect(session.success_url, "the buyer must not be returned to the caller's host").not.toContain(
      "checkout-thief",
    );
    expect(session.cancel_url).not.toContain("checkout-thief");
  });

  it("ignores the Host header, which is the fallback an attacker reaches when no Origin is sent", async () => {
    process.env.KAX_PUBLIC_URL = CONFIGURED;

    const res = await checkout().set("Host", "checkout-thief.invalid");

    expect(res.status, `unexpected refusal: ${JSON.stringify(res.body)} / ${lastError}`).toBe(200);
    expect(captured[0]!.success_url).toBe(`${CONFIGURED}/checkout/success?session_id={CHECKOUT_SESSION_ID}`);
  });

  it("refuses the sale when no base is configured instead of falling back to the request", async () => {
    // Nothing in MANAGED_ENV is set, so there is no configured answer. The old
    // implementation had one anyway — the Origin header — and would have
    // charged a card and returned the buyer to it.
    const before = await ordersForListing();

    const res = await checkout().set("Origin", FOREIGN_ORIGIN);

    expect(res.status).toBe(503);
    expect(res.body.error, "the refusal must name the variable to set").toContain("KAX_PUBLIC_URL");
    expect(captured, "no Checkout Session may be created without a safe return address").toHaveLength(0);
    expect(await ordersForListing(), "and no order row may be left behind").toHaveLength(before.length);
  });

  it("falls back to the platform domain, which the deployment supplies rather than the caller", async () => {
    // REPLIT_DOMAINS is kept as the middle step deliberately: it reaches the
    // process from the platform, never from a request, and it is already what
    // the startup step uses to register the managed Stripe webhook. The foreign
    // Origin is here to show it does not win against it.
    process.env.REPLIT_DOMAINS = "kax-deploy.replit.app,second.replit.app";

    const res = await checkout().set("Origin", FOREIGN_ORIGIN);

    expect(res.status, `unexpected refusal: ${JSON.stringify(res.body)} / ${lastError}`).toBe(200);
    expect(captured[0]!.success_url).toBe(
      "https://kax-deploy.replit.app/checkout/success?session_id={CHECKOUT_SESSION_ID}",
    );
  });

  it("refuses a KAX_PUBLIC_URL with no scheme instead of stranding a Product and a Price", async () => {
    // The likely typo, because the variable beneath this one is a bare host.
    // Taken literally it yields a relative success_url, which Stripe rejects —
    // but only at session creation, which is after the route has already
    // minted catalog objects for the listing. REPLIT_DOMAINS is set here to
    // show the schemeless value is not quietly ignored in favour of it either:
    // a misconfigured canonical URL is a refusal, not a silent substitution.
    process.env.KAX_PUBLIC_URL = "kax.test.invalid";
    process.env.REPLIT_DOMAINS = "kax-deploy.replit.app";

    const res = await checkout();

    expect(res.status, `reached: ${lastError}`).toBe(503);
    expect(res.body.error, "the refusal must name the scheme requirement").toMatch(/https:\/\//);
    expect(captured, "no Checkout Session may be created from a relative base").toHaveLength(0);
  });

  it("does not double the slash when the configured base carries a trailing one", async () => {
    // A trailing slash is the likeliest way the variable gets set by hand, and
    // `//checkout/success` is a URL Stripe accepts and the app does not serve.
    process.env.KAX_PUBLIC_URL = `${CONFIGURED}/`;

    const res = await checkout();

    expect(res.status, `unexpected refusal: ${JSON.stringify(res.body)} / ${lastError}`).toBe(200);
    expect(captured[0]!.success_url).toBe(`${CONFIGURED}/checkout/success?session_id={CHECKOUT_SESSION_ID}`);
  });

  async function ordersForListing(): Promise<Array<{ id: number }>> {
    return db
      .select({ id: listingOrdersTable.id })
      .from(listingOrdersTable)
      .where(eq(listingOrdersTable.listingId, listingId));
  }
});

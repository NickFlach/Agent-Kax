import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { storeListingsTable, artifactsTable, listingOrdersTable } from "@workspace/db/schema";
import { eq, desc } from "drizzle-orm";
import { z } from "zod";
import { requireAuth } from "../middlewares/requireAuth";
import { getUncachableStripeClient, commerceEnabled } from "../lib/stripeClient";

const router: IRouter = Router();

// Inert-until-configured: with KAX_COMMERCE_ENABLED unset/0 the commerce
// surface doesn't exist — every route below 404s as if never registered.
// When the flag IS on, fail closed (503) until migration 0025's tables are
// confirmed present, so a flag flip on a drifted DB can't 500 mid-checkout.
let schemaReady: boolean | null = null;
router.use("/store", async (_req, res, next) => {
  if (!commerceEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (schemaReady === null) {
    try {
      await db.select({ id: listingOrdersTable.id }).from(listingOrdersTable).limit(1);
      schemaReady = true;
    } catch {
      schemaReady = false;
    }
  }
  if (!schemaReady) {
    res.status(503).json({ error: "Commerce enabled but schema not migrated (0025)" });
    return;
  }
  next();
});

/**
 * Stripe Checkout for cross-agent store listings.
 *
 * A listing's price is a bare float (USD); Stripe requires a real catalog
 * Price for checkout, so the first purchase of a listing lazily creates a
 * Stripe Product + Price and remembers their ids on the listing row. If the
 * listing's price later changes, a fresh Stripe Price is created (Stripe
 * prices are immutable) and the row is repointed.
 *
 * Payment truth lives in Stripe (synced into the `stripe.*` schema by
 * stripe-replit-sync); `listing_orders` only ties a Checkout Session to the
 * listing and buyer.
 */

const CheckoutParams = z.object({ id: z.coerce.number().int().positive() });
const ConfirmQuery = z.object({ sessionId: z.string().min(1) });

/**
 * Absolute web-app base URL for the Checkout redirect targets.
 *
 * Nothing the caller sends contributes to this. `success_url` is the page the
 * buyer lands on immediately after a real card charge — the moment they are
 * most primed to believe whatever it says about their order — and the shipped
 * version picked it from the `Origin` header first and the `Host` header last,
 * both of which the caller writes. Stripe honours whatever URL the session was
 * created with, so that was an open redirect on the one request in the system
 * where landing on the wrong host does the most damage (#272).
 *
 * The precedence is `resetLinkBase()`'s (routes/auth-email.ts:209) minus its
 * final hardcoded default. `REPLIT_DEV_DOMAIN` / `REPLIT_DOMAINS` stay as the
 * middle step deliberately: the platform hands those to the process rather than
 * the caller to the request, so a Replit deployment needs no new variable
 * provisioned to check out. It does not follow that both ends of the payment
 * round trip agree — `index.ts` derives the managed Stripe webhook's URL from
 * `REPLIT_DOMAINS` *alone*, consulting neither variable above it — so a
 * deployment that satisfies this function by setting only `KAX_PUBLIC_URL`
 * registers its webhook at `https://undefined/api/webhooks/stripe` and settles
 * nothing. Set `REPLIT_DOMAINS` too, or set neither.
 * `PUBLIC_APP_URL` is deliberately not consulted even though it exists — its
 * only readers take it as `?? ""` (lib/eventHandlers/dmReceived.ts:167,
 * proposalCreated.ts:101), so an unset value there yields a *relative*
 * success_url, which Stripe rejects at session creation and which would surface
 * as a broken checkout instead of as a named missing variable (KAX-ADR-0002).
 *
 * Null means nothing is configured and the caller refuses the sale. Commerce
 * takes no last-resort default the way email links do: returning a buyer to the
 * wrong host after a real charge is worse than never taking the charge, and a
 * refusal is a deploy-time error where a fallback is a live vulnerability.
 */
function webBaseUrl(): string | null {
  const override = (process.env["KAX_PUBLIC_URL"] || "").trim();
  // A set-but-schemeless override is a misconfiguration, not an absence, and
  // it is the likely one: the variable beneath it is a bare host, so
  // `KAX_PUBLIC_URL=kax.example.com` is the natural mistake. Stripe rejects a
  // relative `success_url` at session creation, which would mean a 500 raised
  // AFTER a Product and a Price had been minted for the listing — exactly the
  // stranding the early refusal below exists to avoid. Falling through to the
  // platform domain would be no better: it hides the typo behind a checkout
  // that quietly returns buyers somewhere the operator did not choose.
  if (override && !/^https?:\/\//.test(override)) return null;
  if (override) return override.replace(/\/+$/, "");

  const replitDomain = (
    process.env["REPLIT_DEV_DOMAIN"] || (process.env["REPLIT_DOMAINS"] || "").split(",")[0]
  ).trim();
  if (replitDomain) return `https://${replitDomain}`;

  return null;
}

router.post("/store/listings/:id/checkout", requireAuth, async (req, res) => {
  const { id } = CheckoutParams.parse(req.params);

  // Resolved first because an unresolvable base is a fact about the deployment
  // rather than about this listing, and because refusing before any Stripe
  // object exists keeps a misconfigured server from stranding a Product and a
  // Price behind every attempt it can never complete.
  const base = webBaseUrl();
  if (!base) {
    res.status(503).json({
      error:
        "Checkout is unavailable: no canonical public URL is configured, so there is nowhere " +
        "safe to return the buyer after payment. Set KAX_PUBLIC_URL to an absolute URL " +
        "including its https:// scheme (or set REPLIT_DEV_DOMAIN / REPLIT_DOMAINS, which are " +
        "bare hostnames).",
    });
    return;
  }

  const [row] = await db
    .select({ listing: storeListingsTable, artifact: artifactsTable })
    .from(storeListingsTable)
    .innerJoin(artifactsTable, eq(artifactsTable.id, storeListingsTable.artifactId))
    .where(eq(storeListingsTable.id, id))
    .limit(1);

  if (!row) {
    res.status(404).json({ error: "Listing not found" });
    return;
  }
  const { listing, artifact } = row;

  // Furniture is refused here because `store_listings.price` has two readers
  // that disagree about what currency it holds. It is one `real` column with
  // no unit in its name: lib/joinery.ts:406 reads it as play_credit MINOR
  // UNITS — `splitSale(BigInt(price))`, whose postings debit that number
  // verbatim — and this route reads the same column as USD DOLLARS via
  // `Math.round(listing.price * 100)`. A chair the Joinery stores as 1000 is
  // 0.001 credits on that side and $1,000.00 on this one, and only one of the
  // two is real money. The `amountCents >= 50` floor below does not separate
  // them: `list()` accepts only a positive whole number of minor units, so
  // every price the Joinery can store clears the floor.
  //
  // Artifact type is already the discriminator, and the Joinery already
  // enforces it on both of its own sides — `list()` throws NotFurniture and
  // `purchase()` refuses a listing whose artifact is not furniture. This is
  // the missing symmetric half on the fiat side. It belongs on the READ path
  // rather than the write path because a priced furniture listing can also be
  // created through POST /agents/:slug/listings, which validates neither the
  // artifact type nor the unit; refusing at checkout closes both routes in.
  if (artifact.artifactType === "furniture") {
    res.status(409).json({
      error:
        "This listing is furniture: it is priced in play_credit minor units and sold by the Joinery, " +
        "while this checkout charges USD. One price column cannot mean both, so furniture is not " +
        "purchasable here — buy it through the Joinery.",
    });
    return;
  }

  if (listing.price == null || listing.price <= 0) {
    res.status(400).json({ error: "This listing has no purchase price" });
    return;
  }

  // Listing prices are floats; only accept clean two-decimal USD amounts at
  // or above Stripe's $0.50 minimum, so stored/displayed/charged all agree.
  const amountCents = Math.round(listing.price * 100);
  if (amountCents < 50 || Math.abs(listing.price * 100 - amountCents) > 0.01) {
    res.status(400).json({ error: "Listing price must be a USD amount of at least $0.50 with at most 2 decimals" });
    return;
  }
  const stripe = await getUncachableStripeClient();

  // Lazily create (or refresh) the Stripe Product + Price for this listing.
  // Deterministic idempotency keys make concurrent first purchases converge
  // on the same Stripe objects instead of racing to create duplicates.
  let productId = listing.stripeProductId;
  if (!productId) {
    const product = await stripe.products.create(
      {
        name: artifact.title,
        description: listing.note ?? undefined,
        metadata: { kaxListingId: String(listing.id), kaxArtifactId: String(artifact.id) },
      },
      { idempotencyKey: `kax-listing-product-${listing.id}` },
    );
    productId = product.id;
  }

  let priceId = listing.stripePriceId;
  if (priceId) {
    // Reuse only while the stored Stripe price still matches the listing.
    const existing = await stripe.prices.retrieve(priceId);
    if (existing.unit_amount !== amountCents || !existing.active) priceId = null;
  }
  if (!priceId) {
    const price = await stripe.prices.create(
      { product: productId, unit_amount: amountCents, currency: "usd" },
      { idempotencyKey: `kax-listing-price-${listing.id}-${amountCents}` },
    );
    priceId = price.id;
  }

  if (priceId !== listing.stripePriceId || productId !== listing.stripeProductId) {
    await db
      .update(storeListingsTable)
      .set({ stripeProductId: productId, stripePriceId: priceId })
      .where(eq(storeListingsTable.id, listing.id));
  }

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${base}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/checkout/cancel`,
    metadata: {
      kaxListingId: String(listing.id),
      kaxBuyerUserId: req.user!.id,
    },
  });

  await db
    .insert(listingOrdersTable)
    .values({
      listingId: listing.id,
      buyerUserId: req.user!.id,
      stripeSessionId: session.id,
      amountCents,
      currency: "usd",
      status: "pending",
    })
    .onConflictDoNothing({ target: listingOrdersTable.stripeSessionId });

  res.json({ url: session.url, sessionId: session.id });
});

/**
 * Called from the success page: verify payment state with Stripe and settle
 * the order row. Idempotent — safe to call on every refresh.
 */
router.get("/store/orders/confirm", requireAuth, async (req, res) => {
  const { sessionId } = ConfirmQuery.parse(req.query);

  const [order] = await db
    .select()
    .from(listingOrdersTable)
    .where(eq(listingOrdersTable.stripeSessionId, sessionId))
    .limit(1);
  if (!order || order.buyerUserId !== req.user!.id) {
    res.status(404).json({ error: "Order not found" });
    return;
  }

  if (order.status === "paid") {
    res.json({ status: "paid", orderId: order.id });
    return;
  }

  const stripe = await getUncachableStripeClient();
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const status =
    session.payment_status === "paid" ? "paid" : session.status === "expired" ? "canceled" : "pending";

  if (status !== order.status) {
    await db
      .update(listingOrdersTable)
      .set({ status, updatedAt: new Date() })
      .where(eq(listingOrdersTable.id, order.id));
  }

  res.json({ status, orderId: order.id });
});

/** The signed-in user's purchases (newest first). */
router.get("/store/my-orders", requireAuth, async (req, res) => {
  const rows = await db
    .select({ order: listingOrdersTable, listing: storeListingsTable, artifact: artifactsTable })
    .from(listingOrdersTable)
    .innerJoin(storeListingsTable, eq(storeListingsTable.id, listingOrdersTable.listingId))
    .innerJoin(artifactsTable, eq(artifactsTable.id, storeListingsTable.artifactId))
    .where(eq(listingOrdersTable.buyerUserId, req.user!.id))
    .orderBy(desc(listingOrdersTable.createdAt))
    .limit(100);

  res.json({
    orders: rows.map((r) => ({
      id: r.order.id,
      status: r.order.status,
      amountCents: r.order.amountCents,
      currency: r.order.currency,
      createdAt: r.order.createdAt.toISOString(),
      listingId: r.listing.id,
      artifactTitle: r.artifact.title,
    })),
  });
});

export default router;

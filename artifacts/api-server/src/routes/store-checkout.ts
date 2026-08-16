import { Router, type IRouter, type Request } from "express";
import { db } from "@workspace/db";
import { storeListingsTable, artifactsTable, listingOrdersTable } from "@workspace/db/schema";
import { eq, desc } from "drizzle-orm";
import { z } from "zod";
import { requireAuth } from "../middlewares/requireAuth";
import { getUncachableStripeClient, commerceEnabled } from "../lib/stripeClient";

const router: IRouter = Router();

// Inert-until-configured: with KAX_COMMERCE_ENABLED unset/0 the commerce
// surface doesn't exist — every route below 404s as if never registered.
router.use("/store", (_req, res, next) => {
  if (!commerceEnabled()) {
    res.status(404).json({ error: "Not found" });
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

/** Absolute web-app base URL for redirect targets, derived at request time. */
function webBaseUrl(req: Request): string {
  const origin = req.get("origin");
  if (origin && /^https?:\/\//.test(origin)) return origin;
  const domain = process.env["REPLIT_DOMAINS"]?.split(",")[0];
  if (domain) return `https://${domain}`;
  return `${req.protocol}://${req.get("host") ?? "localhost"}`;
}

router.post("/store/listings/:id/checkout", requireAuth, async (req, res) => {
  const { id } = CheckoutParams.parse(req.params);

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
  if (listing.price == null || listing.price <= 0) {
    res.status(400).json({ error: "This listing has no purchase price" });
    return;
  }

  const amountCents = Math.round(listing.price * 100);
  const stripe = await getUncachableStripeClient();

  // Lazily create (or refresh) the Stripe Product + Price for this listing.
  let productId = listing.stripeProductId;
  if (!productId) {
    const product = await stripe.products.create({
      name: artifact.title,
      description: listing.note ?? undefined,
      metadata: { kaxListingId: String(listing.id), kaxArtifactId: String(artifact.id) },
    });
    productId = product.id;
  }

  let priceId = listing.stripePriceId;
  if (priceId) {
    // Reuse only while the stored Stripe price still matches the listing.
    const existing = await stripe.prices.retrieve(priceId);
    if (existing.unit_amount !== amountCents || !existing.active) priceId = null;
  }
  if (!priceId) {
    const price = await stripe.prices.create({
      product: productId,
      unit_amount: amountCents,
      currency: "usd",
    });
    priceId = price.id;
  }

  if (priceId !== listing.stripePriceId || productId !== listing.stripeProductId) {
    await db
      .update(storeListingsTable)
      .set({ stripeProductId: productId, stripePriceId: priceId })
      .where(eq(storeListingsTable.id, listing.id));
  }

  const base = webBaseUrl(req);
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

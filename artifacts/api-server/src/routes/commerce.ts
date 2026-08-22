import { Router, type IRouter, type Request, type Response } from "express";
import crypto from "node:crypto";
import { db } from "@workspace/db";
import {
  commerceOrdersTable,
  commerceProductsTable,
  userPaymentMethodsTable,
  userShippingAddressesTable,
  usersTable,
} from "@workspace/db/schema";
import { and, desc, eq, gte, isNull, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { canMutate, requireAuth, requireCommerceToken } from "../middlewares/requireAuth";
import { artifactPrintAssetsTable, artifactsTable, commerceMerchantsTable } from "@workspace/db/schema";
import { aiDisclosure } from "../lib/disclosure";
import { approvalHash, canTransition, parseCommerceState, type CommerceState } from "../lib/commerceOrder";
import { isCommerceEligible } from "../lib/visibility";
import { measureArtifactAsset } from "../lib/printAsset";
import { commerceEnabled, getUncachableStripeClient } from "../lib/stripeClient";
import { publicBaseUrl } from "../lib/publicBaseUrl";
import { loadPurchasingSnapshot } from "../lib/purchasingFacts";
import {
  isPurchasable,
  resolveDailyOrderCap,
  type PurchasingSnapshot,
} from "../lib/purchasingState";
import {
  NON_CHARGEABLE_ORDER_STATUSES,
  TERMINAL_ORDER_STATUSES,
} from "../lib/commerceOrderStatus";
import { buyerTimeline } from "../lib/commerceFulfillmentStages";
import { scrubDatabaseError } from "../lib/scrubDatabaseError";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * The physical purchase path: quote a price, charge a card, poll the result.
 *
 * This is the only file in the server that moves real money for a physical
 * good, and every rule the epic states about that is structural here rather
 * than advisory.
 *
 * Nothing below imports `lib/joinery.ts` or `lib/ledger*`, and nothing reads
 * `store_listings.price`. play_credit cannot buy a parcel, and the way that is
 * guaranteed is that no code path from this file reaches the credit ledger at
 * all. Every amount is an INTEGER of USD cents taken from `commerce_products`,
 * whose columns are named for their unit — unlike `store_listings.price`, one
 * `real` column that means play_credit minor units to `lib/joinery.ts:406` and
 * USD dollars to `routes/store-checkout.ts:84`, which is why that file
 * hard-409s furniture (#269).
 *
 * `store-checkout.ts` is not touched. It is a working digital path with its own
 * table, its own Stripe object and its own webhook branch; this is a sibling,
 * not a widening.
 *
 * ## Deliberately off the OpenAPI contract
 *
 * The settings endpoints in #284 go on `openapi.yaml` and get generated hooks.
 * These three do not, and that is a decision rather than an omission: the
 * purchase is a hand-rolled quote / retry / poll / idempotency protocol whose
 * client has to mint a reference before it calls, reuse it across retries, and
 * poll a ref it may never have received a response for. orval's generated
 * mutation hooks model none of that and would have to be fought at every step.
 * Recorded here so the split is a recorded choice and not the residue of
 * whichever file was edited first.
 *
 * ## The order the row and the charge are written in
 *
 * KAX-ADR-0002:1627, verbatim: *"charging Stripe or submitting to Printify
 * before the `commerce_orders` row exists makes a lost response
 * unreconcilable."* So `POST /purchase` writes the row first, with the
 * shipping address already snapshotted onto it, and only then creates the
 * PaymentIntent under an idempotency key derived from that row's own
 * `client_reference`. The reverse order has no recovery: a charge whose response
 * was lost leaves money moved and nothing on our side that names it. This order
 * does — the row is found by its client reference and the intent by its key.
 *
 * ## On-session confirmation, never off-session
 *
 * The buyer is sitting in front of the tab. `confirm: true` with
 * `use_stripe_sdk: true` is what lets an SCA challenge come back as
 * `requires_action` and be completed inline. `off_session: true` and
 * `error_on_requires_action` both turn that recoverable challenge into a hard
 * decline, and neither appears anywhere in this file — a test asserts it
 * against the params object actually handed to Stripe, because a comment
 * cannot.
 *
 * ## The shipping address
 *
 * The first postal PII in this schema. It is read in exactly one place here,
 * copied onto the order row, and handed to Stripe as the intent's `shipping`.
 * It is never logged, never put in an error message, and never returned from
 * any endpoint below — `GET /commerce/orders/:ref` selects its columns
 * explicitly so that adding a `ship_to_*` column later cannot widen a response
 * by accident.
 */

/**
 * Inert-until-configured, then fail-closed — the gate `store-checkout.ts:17-36`
 * and `purchasing.ts` both use. With `KAX_COMMERCE_ENABLED` unset every route
 * below answers 404, exactly as if this router were never mounted.
 *
 * The probe reads the two tables this file writes and reads. A deployment with
 * the flag on and migration 0026 not landed would otherwise fail partway
 * through a purchase, which on this path means after a card had been charged.
 *
 * ONLY THE POSITIVE RESULT IS CACHED. A `catch` cannot tell "migration 0026 has
 * not landed" from a connection reset, a pool timeout or a failover, and a
 * latched `false` would answer 503 for the life of the process on the strength
 * of one transient fault on the FIRST request after a deploy — fail-closed and
 * stuck, on the money path, clearing only on a restart nobody knows to perform.
 * Leaving the flag false re-probes on the next request, so the shop comes back
 * by itself the moment the database does. A genuinely unmigrated deployment
 * pays two `LIMIT 1` selects per request, which is the correct price for a
 * surface that is answering 503 anyway.
 */
let schemaReady = false;

/**
 * Force the next request to re-probe. Exists so a test can reach the 503
 * branch, which is otherwise unreachable once any earlier request in the same
 * process has cached a `true` — and this is the branch that exists to stop a
 * purchase failing halfway, after a card has been charged, so shipping it
 * unverified is not an option.
 */
export function resetCommerceSchemaProbeForTests(): void {
  schemaReady = false;
}

// ---------------------------------------------------------------------------
// Product management (#258). The OPERATOR surface, distinct from the buyer
// path above: guarded by KAX_COMMERCE_TOKEN with the 503-when-unset idiom, so
// every write here is inert until an operator arms the secret out of band.
// The router is mounted unconditionally — an env-gated MOUNT would make the
// disabled surface 404 indistinguishably from a bad deploy, while the token
// guard 503s with a sentence that says exactly what is off and why.
// ---------------------------------------------------------------------------

/** Print specs the evaluator can check against, at Printify's 300 PPI. */
const PRINT_SPEC_REQUIRED_PX: Record<string, { widthPx: number; heightPx: number }> = {
  sticker_3_5in: { widthPx: 900, heightPx: 900 },
  poster_9x11: { widthPx: 2700, heightPx: 3300 },
  poster_11x14: { widthPx: 3300, heightPx: 4200 },
  poster_12x12: { widthPx: 3600, heightPx: 3600 },
  poster_12x18: { widthPx: 3600, heightPx: 5400 },
};

/**
 * #295: specs that exist only while their env flag does. Resolved at USE
 * time, not module load (the requireCommerceToken lesson) — flip the flag
 * off and the evaluator stops judging the spec on the next request, which
 * makes the SKU invisible: a product on an unknown spec stays at
 * asset_checked and can never pass evaluation.
 */
export function printSpecFor(productSpecId: string): { widthPx: number; heightPx: number } | undefined {
  if (productSpecId === "sticker_4in") {
    return process.env["KAX_PRODUCT_STICKER_4IN"] === "1" ? { widthPx: 1113, heightPx: 1113 } : undefined;
  }
  if (productSpecId === "poster_12x12") {
    // #298: the square poster arrives with the SVG-render pipeline and stays
    // invisible until its flag flips — same rule as the 4in sticker.
    return process.env["KAX_PRODUCT_POSTER_12X12"] === "1" ? PRINT_SPEC_REQUIRED_PX["poster_12x12"] : undefined;
  }
  return PRINT_SPEC_REQUIRED_PX[productSpecId];
}

/** Persist a legal state move; refuse an illegal one loudly. */
async function moveState(productId: number, from: CommerceState, to: CommerceState): Promise<void> {
  if (!canTransition(from, to)) {
    throw new Error(`illegal commerce_state transition ${from} -> ${to} (product ${productId})`);
  }
  await db
    .update(commerceProductsTable)
    .set({ commerceState: to, updatedAt: new Date() })
    .where(eq(commerceProductsTable.id, productId));
}

/** A product and its eligibility state, for the operator and the curious. */
router.get("/commerce/products/:id", requireAuth, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "product id must be a positive integer" });
    return;
  }
  const [p] = await db
    .select()
    .from(commerceProductsTable)
    .where(eq(commerceProductsTable.id, id))
    .limit(1);
  if (!p) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ product: p, commerceState: p.commerceState });
});

const createProductSchema = z.object({
  sku: z.string().min(1).max(120),
  title: z.string().min(1).max(300),
  itemCents: z.number().int().positive(),
  shippingCents: z.number().int().min(0).optional(),
  artifactId: z.number().int().positive().optional(),
  merchantId: z.number().int().positive().optional(),
  productSpecId: z.string().max(48).optional(),
  printifyBlueprintId: z.string().max(64).optional(),
  printifyVariantId: z.string().max(64).optional(),
});

/** Create a product row. Born not_evaluated; the machine does the rest. */
router.post("/commerce/products", requireCommerceToken, async (req: Request, res: Response) => {
  const parsed = createProductSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
    return;
  }
  try {
    const [row] = await db
      .insert(commerceProductsTable)
      .values({ ...parsed.data, commerceState: "not_evaluated" })
      .returning();
    res.status(201).json({ product: row });
  } catch (err) {
    res.status(409).json({ error: scrubDatabaseError("commerce product create", err).message });
  }
});

/**
 * Run the eligibility pipeline one step at a time, exactly the ADR's edges:
 * rights (isCommerceEligible for the MERCHANT's user) -> asset measurement
 * (measureArtifactAsset; sentinels and fetch failures are asset_insufficient
 * and the sentinel path never touches the network — printAsset refuses before
 * I/O) -> the print-spec comparison at required_px. Each step advances the
 * state or records the failure state, and every move goes through
 * canTransition so an illegal edge is a 500 with the edge named, never a
 * silent skip.
 */
router.post(
  "/commerce/products/:id/evaluate",
  requireCommerceToken,
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "product id must be a positive integer" });
      return;
    }
    const [p] = await db
      .select()
      .from(commerceProductsTable)
      .where(eq(commerceProductsTable.id, id))
      .limit(1);
    if (!p) {
      res.status(404).json({ error: "not found" });
      return;
    }
    let state = parseCommerceState(p.commerceState);
    if (state !== "not_evaluated" && state !== "rights_checked" && state !== "asset_checked") {
      res.status(409).json({ error: `product is ${state}; evaluate runs from not_evaluated` });
      return;
    }
    if (!p.artifactId) {
      res.status(409).json({ error: "product has no artifact to evaluate" });
      return;
    }

    // Rights: the merchant's user must control the creator bot. No merchant
    // on the row is an inconclusive preflight, which the ADR routes to
    // review_required rather than guessing either way.
    if (state === "not_evaluated") {
      if (!p.merchantId) {
        await moveState(p.id, state, "review_required");
        res.json({ commerceState: "review_required", reason: "no merchant on the product; rights preflight inconclusive" });
        return;
      }
      const [merchant] = await db
        .select({ userId: commerceMerchantsTable.userId })
        .from(commerceMerchantsTable)
        .where(eq(commerceMerchantsTable.id, p.merchantId))
        .limit(1);
      if (!merchant) {
        await moveState(p.id, state, "review_required");
        res.json({ commerceState: "review_required", reason: "merchant row missing" });
        return;
      }
      const rights = await isCommerceEligible(p.artifactId, merchant.userId);
      if (!rights.ok) {
        await moveState(p.id, state, "rights_blocked");
        res.json({ commerceState: "rights_blocked", reason: rights.reason });
        return;
      }
      await moveState(p.id, state, "rights_checked");
      state = "rights_checked";
    }

    // Asset: measure the bytes. Failure reasons (sentinel, not_a_url,
    // fetch_failed, too_large, decode_failed) are all asset_insufficient.
    if (state === "rights_checked") {
      const asset = await measureArtifactAsset(p.artifactId);
      if (asset.failureReason != null) {
        await moveState(p.id, state, "asset_insufficient");
        res.json({ commerceState: "asset_insufficient", reason: asset.failureReason });
        return;
      }
      await moveState(p.id, state, "asset_checked");
      state = "asset_checked";
    }

    // Spec: compare against required_px. An unknown spec cannot be judged
    // and stays asset_checked with the gap named, rather than inventing a
    // verdict the spec table does not support.
    const spec = p.productSpecId ? printSpecFor(p.productSpecId) : undefined;
    if (!spec) {
      res.json({
        commerceState: state,
        reason: `no required_px known for spec '${p.productSpecId ?? "(none)"}'; stopping at asset_checked`,
      });
      return;
    }
    const [measured] = await db
      .select()
      .from(artifactPrintAssetsTable)
      .where(eq(artifactPrintAssetsTable.artifactId, p.artifactId))
      .limit(1);
    const ok =
      measured?.widthPx != null &&
      measured?.heightPx != null &&
      measured.widthPx >= spec.widthPx &&
      measured.heightPx >= spec.heightPx;
    if (!ok) {
      await moveState(p.id, state, "asset_insufficient");
      res.json({
        commerceState: "asset_insufficient",
        reason: `measured ${measured?.widthPx ?? "?"}x${measured?.heightPx ?? "?"} < required ${spec.widthPx}x${spec.heightPx}`,
      });
      return;
    }
    // #414: consent is the LOAD-BEARING gate on the product_eligible edge, not
    // a step tucked inside the not_evaluated branch — so NO entry state
    // (not_evaluated, rights_checked, asset_checked) can reach eligibility
    // without the creator agent's active consent, and a revocation blocks the
    // very next evaluate even for a product already past the rights step (the
    // review's finding 3). Consent is bound to the artifact's CREATOR at assert
    // time, so "some row exists" here means "the creator agreed".
    {
      const { hasConsent } = await import("../lib/artifactConsent");
      if (!(await hasConsent(p.artifactId, "physical"))) {
        await moveState(p.id, state, "rights_blocked");
        res.json({ commerceState: "rights_blocked", reason: "the creator agent has not consented to a real-money sale on this channel (#414)" });
        return;
      }
    }
    await moveState(p.id, state, "product_eligible");
    res.json({ commerceState: "product_eligible" });
  },
);

/**
 * Reconciliation read (#263): resolve an outcome_unknown by asking the
 * provider what actually happened, keyed on the deterministic client
 * reference. Poll-on-read, not a drift engine — one doubtful order does not
 * need a scheduler, it needs one honest question. requireCommerceToken: an
 * operator act. 503s plainly when Printify is not configured, because an
 * unanswerable question must not read as an answered one.
 */
router.get(
  "/commerce/orders/:id/reconcile",
  requireCommerceToken,
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "order id must be a positive integer" });
      return;
    }
    const { printifyEnabled, getUncachablePrintifyClient } = await import("../lib/printifyClient");
    if (!printifyEnabled()) {
      res.status(503).json({ error: "fulfilment provider not configured; cannot reconcile" });
      return;
    }
    const { reconcileCommerceOrderSubmission } = await import("../lib/commerceFulfillment");
    const printify = await getUncachablePrintifyClient();
    const outcome = await reconcileCommerceOrderSubmission(db, printify, id);
    res.json({ outcome });
  },
);

/**
 * The public product read (#260): what the product page renders. Published
 * products ONLY, and both failure exits are the same 404 — a product that
 * exists unpublished must be indistinguishable from one that never existed,
 * per the public-gating convention (no 403, no leak).
 */
router.get("/commerce/products/:id/public", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const [p] = await db
    .select()
    .from(commerceProductsTable)
    .where(eq(commerceProductsTable.id, id))
    .limit(1);
  if (!p || !p.published) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const [artifact] = p.artifactId
    ? await db
        .select({
          id: artifactsTable.id,
          title: artifactsTable.title,
          artifactType: artifactsTable.artifactType,
          publicUrl: artifactsTable.publicUrl,
          thumbnailUrl: artifactsTable.thumbnailUrl,
          creatorName: artifactsTable.creatorName,
          machineGenerated: artifactsTable.machineGenerated,
        })
        .from(artifactsTable)
        .where(eq(artifactsTable.id, p.artifactId))
        .limit(1)
    : [];
  const [merchant] = p.merchantId
    ? await db
        .select({ displayName: commerceMerchantsTable.displayName })
        .from(commerceMerchantsTable)
        .where(eq(commerceMerchantsTable.id, p.merchantId))
        .limit(1)
    : [];
  res.json({
    product: {
      id: p.id,
      sku: p.sku,
      title: p.title,
      itemCents: p.itemCents,
      shippingCents: p.shippingCents,
      currency: p.currency,
      productSpecId: p.productSpecId,
    },
    artifact: artifact ?? null,
    soldBy: merchant?.displayName ?? "KAX",
    fulfilledBy: "Printify",
    // ONE source for the disclosure string (#255's aiDisclosure) — the page
    // renders this verbatim rather than composing its own copy that could
    // drift from the server's.
    disclosure: artifact ? aiDisclosure({ creatorName: artifact.creatorName }) : null,
  });
});

/**
 * Human approval (#259) — SESSION-authenticated on purpose. Approval is a
 * human act: requireAuth accepts only a signed-in session, so an agent
 * identity token (a bearer with no session) 401s here by construction, and
 * canMutate then requires the session user to OWN the merchant (or be
 * admin). The approval is pinned to CONTENT: sha256 over what was measured
 * (source URL at fetch + asset bytes hash), the spec, and the price — any of
 * the four changing makes the pin a new decision, not a stale valid one.
 */
router.post("/commerce/products/:id/approve", requireAuth, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "product id must be a positive integer" });
    return;
  }
  const [p] = await db
    .select()
    .from(commerceProductsTable)
    .where(eq(commerceProductsTable.id, id))
    .limit(1);
  if (!p) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (!p.merchantId || !p.artifactId || !p.productSpecId) {
    res.status(409).json({ error: "product is missing merchant, artifact or spec; nothing to approve" });
    return;
  }
  const [merchant] = await db
    .select({ userId: commerceMerchantsTable.userId })
    .from(commerceMerchantsTable)
    .where(eq(commerceMerchantsTable.id, p.merchantId))
    .limit(1);
  if (!merchant || !(await canMutate(req, merchant.userId))) {
    res.status(403).json({ error: "only the merchant's owner may approve" });
    return;
  }
  const state = parseCommerceState(p.commerceState);
  if (!canTransition(state, "merchant_approved")) {
    res.status(409).json({ error: `cannot approve from ${state}; run /evaluate first` });
    return;
  }
  const [asset] = await db
    .select()
    .from(artifactPrintAssetsTable)
    .where(eq(artifactPrintAssetsTable.artifactId, p.artifactId))
    .limit(1);
  if (!asset || asset.failureReason != null || !asset.sha256 || !asset.sourceUrlAtFetch) {
    res.status(409).json({ error: "no successful measurement on record; run /evaluate first" });
    return;
  }
  const pin = approvalHash({
    sourceUrlAtFetch: asset.sourceUrlAtFetch,
    assetSha256: asset.sha256,
    productSpecId: p.productSpecId,
    itemCents: p.itemCents,
  });
  await db
    .update(commerceProductsTable)
    .set({
      commerceState: "merchant_approved",
      approvedContentHash: pin,
      approvedBy: req.user!.id,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(commerceProductsTable.id, p.id));
  res.json({ commerceState: "merchant_approved", approvedContentHash: pin });
});

// NOTE (#258): the operator product-management surface is registered ABOVE
// the commerceEnabled() gate on purpose. That gate 404s the BUYER path until
// Stripe is configured — correct for charging cards, and exactly the
// indistinguishable-404 the operator surface must not hide behind. Product
// management is governed by KAX_COMMERCE_TOKEN alone (503 with a sentence
// when unset) and makes no Stripe calls.
router.use("/commerce", async (_req, res, next) => {
  if (!commerceEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!schemaReady) {
    try {
      await db.select({ id: commerceProductsTable.id }).from(commerceProductsTable).limit(1);
      await db.select({ id: commerceOrdersTable.id }).from(commerceOrdersTable).limit(1);
      schemaReady = true;
    } catch {
      res.status(503).json({ error: "Commerce enabled but schema not migrated (0026)" });
      return;
    }
  }
  next();
});

/** How long a quoted price stands before the client has to ask again. */
const QUOTE_TTL_MS = 5 * 60 * 1000;

/** The cap's rolling window. The same 24 hours `purchasingFacts.ts` counts. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Every way this surface refuses, as a machine-readable word.
 *
 * The client renders three distinct failures with three distinct buttons —
 * "your card was declined" sends the buyer to settings, "your bank did not
 * confirm" offers a retry of the same intent — so a refusal has to say which
 * one it is. `reason` is that word. The purchasing-state vocabulary
 * (`not_configured`, `card_expired`, `cap_reached`, …) passes straight through
 * from `purchasingState.ts` rather than being re-spelled here, so the desk, the
 * settings panel and this endpoint all say the same thing about the same
 * account.
 */
export type CommerceRefusal =
  /** The product row is missing, unpublished, or has no price to quote. */
  | "product_unavailable"
  /** The product cannot be sent to the address on file. */
  | "unsupported_destination"
  /** The quote is not one this server issued, or it has been edited. */
  | "quote_invalid"
  /** The quote was issued to a different account. */
  | "quote_not_yours"
  /** Past its five minutes. Re-quote; never charge a stale total. */
  | "quote_expired"
  /** The product was repriced between the quote and the purchase. */
  | "price_changed"
  /** This client reference already belongs to somebody else's order. */
  | "client_reference_conflict"
  /** State said ready, but the address or card has gone since. */
  | "instrument_unavailable"
  /** Stripe refused the card. */
  | "card_declined";

function refuse(res: Response, status: number, reason: CommerceRefusal | string, message: string): void {
  res.status(status).json({ error: message, reason });
}

// ── The quote token ────────────────────────────────────────────────────────

/**
 * What a quote says, and what the signature covers.
 *
 * The buyer is in here so a quote cannot be handed to another account, and the
 * amounts are in here so the panel and the charge can be checked against each
 * other. `issuedAt` is not used for any decision; it is there so a quote in a
 * bug report says when it was minted.
 */
interface QuotePayload {
  v: 1;
  sku: string;
  buyerUserId: string;
  currency: string;
  itemCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  issuedAt: number;
  expiresAt: number;
}

let ephemeralQuoteKey: Buffer | null = null;

/**
 * The key the quote token is signed with.
 *
 * A quote is a five-minute price display, not an authorization, and the
 * signature is sized to that. It cannot change what is charged: `/purchase`
 * re-reads `commerce_products` and refuses with `price_changed` if the amounts
 * have moved, and the buyer comes from the session cookie rather than from the
 * token. What the signature actually buys is that the five minutes cannot be
 * extended by editing the expiry out of a token — the one property the
 * acceptance criteria pin.
 *
 * So the per-process fallback is an acceptable default rather than a
 * compromise on ONE instance: losing it on restart invalidates outstanding
 * quotes, and a client that re-quotes recovers without anyone noticing.
 *
 * On two it is not acceptable at all, and the failure is silent from the
 * operator's side and unactionable from the buyer's: roughly half of all Buy
 * presses land on the instance that did not mint the quote, `readQuote` returns
 * null, and a legitimate purchase dies at `quote_invalid` — "That quote was not
 * issued by this server" — with nothing anywhere naming the unset variable that
 * caused it. So the fallback says so, once per process, at warn.
 */
let warnedAboutEphemeralQuoteKey = false;

function quoteSigningKey(): Buffer {
  const configured = process.env["KAX_COMMERCE_QUOTE_SECRET"];
  if (configured !== undefined && configured.length > 0) return Buffer.from(configured, "utf8");
  if (!warnedAboutEphemeralQuoteKey) {
    warnedAboutEphemeralQuoteKey = true;
    logger.warn(
      "KAX_COMMERCE_QUOTE_SECRET is unset — quotes are signed with a per-process key. " +
        "On more than one instance a quote minted by one is refused by the next, and the " +
        "buyer sees quote_invalid on a legitimate purchase. Set it before scaling out.",
    );
  }
  ephemeralQuoteKey ??= crypto.randomBytes(32);
  return ephemeralQuoteKey;
}

function signQuote(payload: QuotePayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = crypto.createHmac("sha256", quoteSigningKey()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

/**
 * Verify and decode a quote token, or null.
 *
 * The MAC is compared with `timingSafeEqual` after a length check, the same way
 * `requireAuth`'s bearer compare does it — the length is not a secret, the
 * bytes are.
 */
function readQuote(token: string): QuotePayload | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const provided = Buffer.from(token.slice(dot + 1), "base64url");
  const expected = crypto.createHmac("sha256", quoteSigningKey()).update(body).digest();
  if (provided.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(provided, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as QuotePayload;
    return parsed.v === 1 ? parsed : null;
  } catch {
    return null;
  }
}

// ── Pricing ────────────────────────────────────────────────────────────────

interface QuoteAmounts {
  currency: string;
  itemCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
}

/**
 * What this product costs, in USD cents, right now.
 *
 * `taxCents` is zero and is computed rather than omitted. Stripe Tax is
 * deliberately not enabled in v0.1 — with no active registration it returns
 * zero silently, which is a wrong answer rather than an error — so the zero
 * here is a decision the operator accepted, not an oversight, and turning tax
 * on later changes this function instead of the schema.
 */
function priceProduct(product: { itemCents: number; shippingCents: number; currency: string }): QuoteAmounts {
  const taxCents = 0;
  return {
    currency: product.currency,
    itemCents: product.itemCents,
    shippingCents: product.shippingCents,
    taxCents,
    totalCents: product.itemCents + product.shippingCents + taxCents,
  };
}

function sameAmounts(a: QuoteAmounts, b: QuoteAmounts): boolean {
  return (
    a.currency === b.currency &&
    a.itemCents === b.itemCents &&
    a.shippingCents === b.shippingCents &&
    a.taxCents === b.taxCents &&
    a.totalCents === b.totalCents
  );
}

/**
 * The panel's line items. One SKU, quantity one — variants and quantities are
 * explicitly not in v0.1, so there is no per-line quantity to get wrong.
 */
function quoteLines(title: string, country: string, amounts: QuoteAmounts) {
  const lines = [
    { kind: "item", label: title, amountCents: amounts.itemCents },
    { kind: "shipping", label: `Shipping (${country} standard)`, amountCents: amounts.shippingCents },
  ];
  if (amounts.taxCents > 0) {
    lines.push({ kind: "tax", label: "Tax", amountCents: amounts.taxCents });
  }
  return lines;
}

// ── Order status ───────────────────────────────────────────────────────────

/**
 * Stripe's PaymentIntent status, translated into the `commerce_orders.status`
 * vocabulary.
 *
 * `requires_capture` maps to `pending_payment` rather than to anything more
 * definite because this path never asks for manual capture; seeing it means
 * somebody changed the create call, and the honest answer is "not settled yet".
 * An unrecognised status maps the same way for the same reason — the column is
 * a varchar precisely so that an unknown value is a row we can still query
 * rather than a 500 in a WHERE clause.
 */
const ORDER_STATUS_BY_INTENT_STATUS: Record<string, string> = {
  succeeded: "paid",
  processing: "pending_payment",
  requires_capture: "pending_payment",
  requires_action: "authenticating",
  requires_confirmation: "authenticating",
  requires_payment_method: "payment_failed",
  canceled: "canceled",
};

export function orderStatusForIntentStatus(intentStatus: string): string {
  return ORDER_STATUS_BY_INTENT_STATUS[intentStatus] ?? "pending_payment";
}

/**
 * What the client switches on.
 *
 * Separate from the stored status because they answer different questions: the
 * column records what happened to the order, this records what the buyer's tab
 * should do next. `requires_action` is the only value that comes with a client
 * secret, and it is the reason the two vocabularies are not collapsed —
 * `authenticating` reads like a state to wait out, and this one is a state to
 * act on.
 */
const OUTCOME_BY_ORDER_STATUS: Record<string, string> = {
  pending_payment: "processing",
  authenticating: "requires_action",
  paid: "paid",
  payment_failed: "failed",
  canceled: "canceled",
  refunded: "refunded",
  chargeback: "chargeback",
};

export function purchaseOutcomeFor(orderStatus: string): string {
  return OUTCOME_BY_ORDER_STATUS[orderStatus] ?? "processing";
}

/**
 * Settle an order from the payment intent that paid for it.
 *
 * This exact statement is what both the webhook and the purchase path use, and
 * it is written to be run any number of times: the terminal-status guard is what
 * makes a redelivered `payment_intent.succeeded` a no-op, and — read the other
 * way — what stops a `payment_intent.payment_failed` that arrives after a
 * successful retry from marking a paid order failed. The webhook and the
 * client's own poll race each other by design; whichever gets there first wins
 * and the loser writes nothing.
 *
 * The guard is the whole terminal SET and not the single literal `paid`.
 * `refunded` and `chargeback` are terminal in a stronger sense — the money has
 * gone back — and Stripe retries a failed-payment event for up to three days, so
 * a redelivery landing after a refund would otherwise overwrite the one record
 * that says the charge was reversed. See `TERMINAL_ORDER_STATUSES`.
 *
 * Returns the number of rows it moved, so a caller can tell "settled" from
 * "there was nothing here to settle".
 */
export async function settleCommerceOrderByIntent(
  paymentIntentId: string,
  status: string,
): Promise<number> {
  const moved = await db
    .update(commerceOrdersTable)
    .set({ status, updatedAt: new Date() })
    .where(
      and(
        eq(commerceOrdersTable.stripePaymentIntentId, paymentIntentId),
        notInArray(commerceOrdersTable.status, [...TERMINAL_ORDER_STATUSES]),
      ),
    )
    .returning({ id: commerceOrdersTable.id });
  return moved.length;
}

/**
 * Record that the money went back: a refund, or a dispute we are now holding.
 *
 * Deliberately UNGUARDED by `TERMINAL_ORDER_STATUSES`. That guard exists to stop
 * a late failure demoting a success, and these are precisely the transitions out
 * of `paid` it would block — a refunded order that keeps `status = 'paid'` stays
 * submittable, and the admin's submit press then pays a manufacturer to print
 * and ship a parcel against money that has already gone back to the buyer.
 *
 * Keyed on the payment intent, which is what a `charge.*` event carries. An
 * order that never received its intent id is not reachable here, and that is the
 * honest answer: there is no second name for the row on a charge object the way
 * `metadata.kaxCommerceOrderId` is one on the intent.
 */
export async function reverseCommerceOrderByIntent(
  paymentIntentId: string,
  status: "refunded" | "chargeback",
): Promise<number> {
  const moved = await db
    .update(commerceOrdersTable)
    .set({ status, updatedAt: new Date() })
    .where(eq(commerceOrdersTable.stripePaymentIntentId, paymentIntentId))
    .returning({ id: commerceOrdersTable.id });
  return moved.length;
}

/**
 * A dispute closed in the merchant's favour: the funds are ours again.
 *
 * Narrowed to rows sitting at `chargeback` on purpose. Without that clause a
 * won dispute on an order that was ALSO refunded would silently re-mark it paid
 * and hand a submittable order back to the desk, which is the same failure as
 * the one above wearing the opposite sign.
 */
export async function clearCommerceOrderChargeback(paymentIntentId: string): Promise<number> {
  const moved = await db
    .update(commerceOrdersTable)
    .set({ status: "paid", updatedAt: new Date() })
    .where(
      and(
        eq(commerceOrdersTable.stripePaymentIntentId, paymentIntentId),
        eq(commerceOrdersTable.status, "chargeback"),
      ),
    )
    .returning({ id: commerceOrdersTable.id });
  return moved.length;
}

/**
 * Settle by order id, attaching the intent id on the way.
 *
 * This is the recovery for one narrow window: the PaymentIntent was created —
 * so the card is charged — and the process died before the id reached the row.
 * The intent-keyed statement above cannot find that order, because the column
 * it keys on is exactly the one that never got written. The intent's own
 * `metadata.kaxCommerceOrderId` is the second name for the same row, it comes
 * off a signature-verified Stripe event, and using it turns an order that was
 * unreconcilable-without-a-human into one that settles itself on the next
 * delivery.
 *
 * The same terminal-status guard as above, so running this after the
 * intent-keyed statement has already succeeded costs nothing — and a redelivered
 * failure cannot regress an order out of `paid`, `refunded` or `chargeback`.
 */
export async function settleCommerceOrderById(
  orderId: number,
  paymentIntentId: string,
  status: string,
): Promise<number> {
  const moved = await db
    .update(commerceOrdersTable)
    .set({ status, stripePaymentIntentId: paymentIntentId, updatedAt: new Date() })
    .where(
      and(
        eq(commerceOrdersTable.id, orderId),
        notInArray(commerceOrdersTable.status, [...TERMINAL_ORDER_STATUSES]),
      ),
    )
    .returning({ id: commerceOrdersTable.id });
  return moved.length;
}

// ── Reads ──────────────────────────────────────────────────────────────────

/**
 * Recompute whether this account may buy, from the database and the clock.
 *
 * The client's copy of this is a UI hint and nothing more. The desk renders a
 * Buy button off `GET /me`, that response is seconds or minutes old by the time
 * the button is pressed, and a card can expire or be detached in between — so
 * the answer is derived again here, from the same module, on every quote and
 * every purchase. Nothing in the request body contributes to it.
 */
async function requireReady(
  res: Response,
  userId: string,
  options: { excludeOrderId?: number } = {},
): Promise<PurchasingSnapshot | null> {
  const snapshot = await loadPurchasingSnapshot(userId, options);
  if (snapshot.state === "disabled") {
    // The flag is on — the gate above proved that — so this is
    // `loadPurchasingSnapshot` failing closed on a database or schema fault,
    // which is a fact about the deployment rather than about the buyer.
    res.status(503).json({ error: "Purchasing state unavailable", reason: "disabled" });
    return null;
  }
  if (!isPurchasable(snapshot)) {
    res.status(409).json({
      error: "This account cannot complete a purchase yet",
      reason: snapshot.state,
      reasons: snapshot.reasons,
    });
    return null;
  }
  return snapshot;
}

async function loadPublishedProduct(sku: string) {
  const [product] = await db
    .select()
    .from(commerceProductsTable)
    .where(and(eq(commerceProductsTable.sku, sku), eq(commerceProductsTable.published, true)))
    .limit(1);
  return product ?? null;
}

/**
 * ISO 3166-1 alpha-2 is written both ways in the wild, and "us" is not a
 * different country from "US".
 */
function shipsTo(product: { shipToCountries: string[] }, country: string): boolean {
  const wanted = country.trim().toUpperCase();
  return product.shipToCountries.some((c) => c.trim().toUpperCase() === wanted);
}

/**
 * The live address, in full.
 *
 * The only read of the street lines in this file. Everything downstream copies
 * from the value this returns; nothing joins back to the table, which is what
 * makes a later address edit unable to rewrite where a shipped order went.
 */
async function loadLiveAddress(userId: string) {
  const [address] = await db
    .select({
      name: userShippingAddressesTable.name,
      line1: userShippingAddressesTable.line1,
      line2: userShippingAddressesTable.line2,
      city: userShippingAddressesTable.city,
      region: userShippingAddressesTable.region,
      postalCode: userShippingAddressesTable.postalCode,
      country: userShippingAddressesTable.country,
      phone: userShippingAddressesTable.phone,
    })
    .from(userShippingAddressesTable)
    .where(
      and(
        eq(userShippingAddressesTable.userId, userId),
        isNull(userShippingAddressesTable.archivedAt),
      ),
    )
    .limit(1);
  return address ?? null;
}

/**
 * The Customer and the card a charge would go through.
 *
 * The precedence is `selectCard()`'s in `purchasingState.ts` and the delete
 * endpoint's in `purchasing.ts`: the default card, else the newest still
 * attached. Charging a card other than the one the panel named would be a
 * surprise on a receipt, so all three places have to agree.
 */
async function loadChargeInstrument(
  userId: string,
): Promise<{ customerId: string; paymentMethodId: string } | null> {
  const [user] = await db
    .select({ stripeCustomerId: usersTable.stripeCustomerId })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!user?.stripeCustomerId) return null;

  const [card] = await db
    .select({ stripePaymentMethodId: userPaymentMethodsTable.stripePaymentMethodId })
    .from(userPaymentMethodsTable)
    .where(
      and(eq(userPaymentMethodsTable.userId, userId), isNull(userPaymentMethodsTable.detachedAt)),
    )
    .orderBy(desc(userPaymentMethodsTable.isDefault), desc(userPaymentMethodsTable.createdAt))
    .limit(1);
  if (!card) return null;

  return { customerId: user.stripeCustomerId, paymentMethodId: card.stripePaymentMethodId };
}

// ── POST /api/commerce/quote ───────────────────────────────────────────────

const QuoteBody = z.object({ sku: z.string().min(1).max(120) });

/**
 * Stripe Checkout Session for the product page (#262). The alternative front
 * door to the SAME settlement machinery the PaymentIntent path uses: the
 * session's payment intent carries kaxCommerceOrderId in its metadata, so
 * the existing /webhooks/stripe handler settles it with zero new webhook
 * code — one settlement path, two ways in.
 *
 * Order-first, per the issue: the row is committed in pending_payment with
 * the address SNAPSHOT (ship_to_* are NOT NULL by design — the address is
 * evidence, so the buyer needs a saved address before checkout; Stripe does
 * not collect one here) and the deterministic client_reference, and only
 * then is Stripe called. A timeout after the row is recoverable by reading
 * the row back; the reverse order is not.
 *
 * Registered BELOW the commerceEnabled gate on purpose — this endpoint
 * charges cards, so 404-until-Stripe-is-configured is correct for it, unlike
 * the operator surface above.
 */
router.post("/commerce/checkout", requireAuth, async (req: Request, res: Response) => {
  const sku = typeof req.body?.sku === "string" ? req.body.sku : "";
  if (!sku) {
    res.status(400).json({ error: "sku required" });
    return;
  }
  const [product] = await db
    .select()
    .from(commerceProductsTable)
    .where(eq(commerceProductsTable.sku, sku))
    .limit(1);
  if (!product || !product.published) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const [address] = await db
    .select()
    .from(userShippingAddressesTable)
    .where(
      and(
        eq(userShippingAddressesTable.userId, req.user!.id),
        isNull(userShippingAddressesTable.archivedAt),
      ),
    )
    .orderBy(desc(userShippingAddressesTable.createdAt))
    .limit(1);
  if (!address) {
    res.status(409).json({ error: "add a shipping address before checking out" });
    return;
  }
  if (!product.shipToCountries.includes(address.country)) {
    res.status(409).json({ error: `we can't ship to ${address.country} yet` });
    return;
  }

  const clientReference = `checkout:${crypto.randomUUID()}`;
  const totalCents = product.itemCents + product.shippingCents;
  const [order] = await db
    .insert(commerceOrdersTable)
    .values({
      clientReference,
      buyerUserId: req.user!.id,
      sku: product.sku,
      currency: product.currency,
      itemCents: product.itemCents,
      shippingCents: product.shippingCents,
      taxCents: 0,
      totalCents,
      shipToName: address.name,
      shipToLine1: address.line1,
      shipToLine2: address.line2,
      shipToCity: address.city,
      shipToRegion: address.region,
      shipToPostalCode: address.postalCode,
      shipToCountry: address.country,
      shipToPhone: address.phone,
      status: "pending_payment",
    })
    .returning();

  const stripe = await getUncachableStripeClient();
  const base = publicBaseUrl();
  if (!base) {
    res.status(503).json({ error: "public URL not configured; cannot build checkout redirect" });
    return;
  }
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    client_reference_id: clientReference,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: product.currency,
          unit_amount: totalCents,
          product_data: { name: product.title },
        },
      },
    ],
    // Stripe Tax as CONFIGURATION (#262): no TaxProvider interface in v0.1.
    automatic_tax: { enabled: true },
    success_url: `${base}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/checkout/cancel`,
    payment_intent_data: {
      metadata: { kaxCommerceOrderId: String(order!.id) },
    },
  });
  res.json({ url: session.url, sessionId: session.id, clientReference });
});

/**
 * Price a product for this buyer, for five minutes.
 *
 * The state recompute comes first and the price second, because an account that
 * cannot buy should be told why rather than shown a total it cannot act on. The
 * 24-hour cap is part of that recompute rather than a separate count here —
 * `cap_reached` is one of the states `purchasingState.ts` derives, and counting
 * paid orders in a second place is how the two counts come to disagree.
 */
router.post("/commerce/quote", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const parsed = QuoteBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request",
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
    return;
  }

  const snapshot = await requireReady(res, userId);
  if (!snapshot) return;

  const product = await loadPublishedProduct(parsed.data.sku);
  if (!product) {
    // 409 and not 404: on this router 404 means "this surface does not exist",
    // which is the answer the flag gate gives. An unpublished product is a
    // refusal with a reason, and the two must stay distinguishable.
    refuse(res, 409, "product_unavailable", "That product is not for sale");
    return;
  }

  // `shipsTo` here is the destination the derived state already accepted; this
  // is the narrower, per-product check, and it is the reason the product
  // carries its own country list at all.
  const country = snapshot.shipsTo?.country ?? "";
  if (!shipsTo(product, country)) {
    refuse(res, 409, "unsupported_destination", `We can't ship that to ${country} yet`);
    return;
  }

  const amounts = priceProduct(product);
  const now = Date.now();
  const expiresAt = now + QUOTE_TTL_MS;
  const quoteId = signQuote({
    v: 1,
    sku: product.sku,
    buyerUserId: userId,
    ...amounts,
    issuedAt: now,
    expiresAt,
  });

  res.json({
    quoteId,
    sku: product.sku,
    title: product.title,
    lines: quoteLines(product.title, country, amounts),
    currency: amounts.currency,
    totalCents: amounts.totalCents,
    expiresAt: new Date(expiresAt).toISOString(),
  });
});

// ── POST /api/commerce/purchase ────────────────────────────────────────────

const PurchaseBody = z.object({
  quoteId: z.string().min(1).max(4096),
  /**
   * Minted once per press of the Buy button and reused across every retry.
   * A UUID because the column is unique and the client has to be able to
   * generate one offline; unknown keys are dropped by zod, so a client that
   * also sends its own view of its purchasing state is not refused — that field
   * is simply not something this handler can read.
   */
  clientReference: z.string().uuid(),
});

router.post("/commerce/purchase", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const parsed = PurchaseBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request",
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
    return;
  }
  const { quoteId, clientReference } = parsed.data;

  // 1. Is this a retry? Asked of the database, never of the request.
  //
  //    This has to come before the quote is judged, and the reason is the case
  //    the whole protocol exists for: the panel POSTed, the network dropped the
  //    response, and it retries not knowing whether the charge landed. That
  //    retry can easily arrive more than five minutes after the quote was
  //    issued — and answering it with 410 "get a new price" would tell a buyer
  //    whose card has already been charged to start again. A reference that
  //    already names an order is not a new purchase to be re-authorised; it is
  //    an old one to be reported on.
  //
  //    Nothing is charged on this branch that would not have been charged
  //    anyway: the amounts come from the row, which was written from a quote
  //    that was valid when it was written.
  //
  //    THE TWO CASES ARE SPLIT, and the intent id is what splits them. A row
  //    that carries one is a charge that has already been made, and reporting on
  //    it must stay unconditional. A row that does not is a purchase that never
  //    happened — reachable in production, because `finishPurchase` commits the
  //    row and then refuses with `instrument_unavailable`, and because a
  //    non-card failure from `paymentIntents.create` re-throws and leaves the
  //    row at `pending_payment` with a null intent. Handing THAT row to
  //    `finishPurchase` unconditionally charges a card against an arbitrarily
  //    old price, an arbitrarily old address snapshot, and every account-level
  //    control skipped: a bumped terms version, a reached cap, a card that has
  //    since been replaced by a different one. So it is treated as what it is —
  //    a fresh purchase — and made to pass the same gates.
  const priorAttempt = await loadOrderByReference(clientReference);
  if (priorAttempt) {
    if (priorAttempt.buyerUserId !== userId) {
      // A reference is unique across the whole table, so a collision with
      // another account's order is possible in principle. It must never
      // surrender that order's state to this caller.
      refuse(res, 409, "client_reference_conflict", "Please retry with a new reference");
      return;
    }
    if (priorAttempt.stripePaymentIntentId) {
      await finishPurchase(res, priorAttempt, userId);
      return;
    }

    // Nothing was charged against this row. Bound its age by the quote's own
    // TTL — the price and the address on it were current when it was written
    // and the buyer may have moved house since — so a stale unpaid row is
    // refused and the client re-quotes rather than being charged an old total
    // and shipped to an old street.
    if (Date.now() - priorAttempt.createdAt.getTime() >= QUOTE_TTL_MS) {
      refuse(res, 410, "quote_expired", "That quote has expired — please get a new price");
      return;
    }
    // The row itself is left out of the cap count: it is the purchase being
    // retried, not a second one, and counting it would refuse the buyer's own
    // retry at the boundary and wedge the row permanently.
    const retryState = await requireReady(res, userId, { excludeOrderId: priorAttempt.id });
    if (!retryState) return;
    await finishPurchase(res, priorAttempt, userId);
    return;
  }

  // 2. The quote. Checked before anything is read about the account, because a
  //    stale or forged one is a fact about the request rather than the buyer.
  const quote = readQuote(quoteId);
  if (!quote) {
    refuse(res, 400, "quote_invalid", "That quote was not issued by this server");
    return;
  }
  if (quote.buyerUserId !== userId) {
    refuse(res, 403, "quote_not_yours", "That quote was issued to another account");
    return;
  }
  if (Date.now() >= quote.expiresAt) {
    // 410 Gone, and nothing has been charged: the price is five minutes old and
    // the panel's job is to ask again, never to pay a total the buyer was shown
    // before it moved.
    refuse(res, 410, "quote_expired", "That quote has expired — please get a new price");
    return;
  }

  // 3. The account, recomputed. The client's claim about its own state reaches
  //    this handler as an unread key and dies there.
  const snapshot = await requireReady(res, userId);
  if (!snapshot) return;

  // 4. The price, recomputed. A quote is what the buyer was SHOWN; the product
  //    row is what they are CHARGED, and a difference between them is refused
  //    rather than silently resolved in either direction.
  const product = await loadPublishedProduct(quote.sku);
  if (!product) {
    refuse(res, 409, "product_unavailable", "That product is not for sale");
    return;
  }
  const country = snapshot.shipsTo?.country ?? "";
  if (!shipsTo(product, country)) {
    refuse(res, 409, "unsupported_destination", `We can't ship that to ${country} yet`);
    return;
  }
  const amounts = priceProduct(product);
  if (!sameAmounts(amounts, quote)) {
    refuse(res, 409, "price_changed", "That price has changed — please get a new quote");
    return;
  }

  // 5. The address. Read as rows rather than taken from the derived state,
  //    which carries a country and a postal code and nothing a parcel could be
  //    sent by. A disappearance between the two reads is a refusal rather than
  //    a null written into a NOT NULL column.
  const address = await loadLiveAddress(userId);
  if (!address) {
    refuse(res, 409, "instrument_unavailable", "This account cannot complete a purchase yet");
    return;
  }

  // 6. THE ROW, FIRST. Before Stripe is told anything at all — and under a lock
  //    on the buyer, because the cap has to be counted and acted on as one
  //    thing.
  //
  //    `requireReady` above derives `cap_reached` from a count taken outside any
  //    transaction, which is a read-then-act: N concurrent presses each carrying
  //    a valid quote and its own fresh reference all observe the same pre-charge
  //    count, all pass, and all reach `paymentIntents.create` under distinct
  //    idempotency keys that Stripe has no reason to collapse. The cap would
  //    then bound nothing at all, which is the opposite of what a runaway-client
  //    brake is for. So the count is retaken here, inside the transaction, after
  //    `SELECT … FOR UPDATE` on the buyer's own row has serialised every
  //    purchase that account is making.
  //
  //    The reference is re-read under that same lock. A concurrent duplicate is
  //    then a READ of the winner's row rather than a refusal — which matters
  //    exactly at the boundary, where the cap check would otherwise turn the
  //    second half of a double-submit into `cap_reached` instead of the report
  //    it is supposed to be. `onConflictDoNothing` stays behind it as the last
  //    line: the reference is unique across the whole TABLE, so a collision with
  //    a different buyer's order is not covered by a lock on this one.
  //
  //    The address is snapshotted in this same statement — these are copies, and
  //    there is deliberately no foreign key back to `user_shipping_addresses`,
  //    so a buyer who moves house cannot rewrite where an already-shipped order
  //    went.
  const dailyOrderCap = resolveDailyOrderCap(process.env["KAX_COMMERCE_DAILY_ORDER_CAP"]);
  let attempt: PurchaseAttempt;
  try {
    attempt = await db.transaction(async (tx): Promise<PurchaseAttempt> => {
      await tx
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1)
        .for("update");

      const [existing] = await tx
        .select()
        .from(commerceOrdersTable)
        .where(eq(commerceOrdersTable.clientReference, clientReference))
        .limit(1);
      // The buyer comparison is repeated here and not inherited from step 1.
      // The lock is on THIS account's row, so it serialises this account's
      // purchases and nobody else's — a different buyer's order can appear under
      // this reference between the pre-check and this read, and handing it back
      // would surrender a stranger's order to whoever named it.
      if (existing) {
        return existing.buyerUserId === userId
          ? { kind: "existing", order: existing }
          : { kind: "reference_taken" };
      }

      const [counted] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(commerceOrdersTable)
        .where(
          and(
            eq(commerceOrdersTable.buyerUserId, userId),
            notInArray(commerceOrdersTable.status, [...NON_CHARGEABLE_ORDER_STATUSES]),
            gte(commerceOrdersTable.createdAt, new Date(Date.now() - DAY_MS)),
          ),
        );
      if ((counted?.n ?? 0) >= dailyOrderCap) return { kind: "cap_reached" };

      const [written] = await tx
        .insert(commerceOrdersTable)
        .values({
          clientReference,
          buyerUserId: userId,
          sku: product.sku,
          currency: amounts.currency,
          itemCents: amounts.itemCents,
          shippingCents: amounts.shippingCents,
          taxCents: amounts.taxCents,
          totalCents: amounts.totalCents,
          shipToName: address.name,
          shipToLine1: address.line1,
          shipToLine2: address.line2,
          shipToCity: address.city,
          shipToRegion: address.region,
          shipToPostalCode: address.postalCode,
          shipToCountry: address.country,
          shipToPhone: address.phone,
          status: "pending_payment",
        })
        .onConflictDoNothing({ target: commerceOrdersTable.clientReference })
        .returning();

      return written ? { kind: "inserted", order: written } : { kind: "raced" };
    });
  } catch (err) {
    // The one statement in this file that binds the buyer's whole postal
    // address as query parameters. drizzle wraps a failed statement in a
    // `DrizzleQueryError` whose own message is "Failed query: <sql>\nparams:
    // <values>", and app.ts logs whatever reaches it with `req.log.error({ err
    // })` — so an unwrapped deadlock, statement timeout or dropped connection
    // here writes a real buyer's street and phone number into the log file. See
    // `scrubDatabaseError`; `purchasing.ts` closes the same leak on the address
    // write, and this is the other writer.
    throw scrubDatabaseError("commerce order write", err);
  }

  if (attempt.kind === "cap_reached") {
    // The count moved between `requireReady` and the lock. Same word the
    // derived state uses, so the panel renders the same refusal either way.
    res.status(409).json({
      error: "This account cannot complete a purchase yet",
      reason: "cap_reached",
      reasons: ["cap_reached"],
    });
    return;
  }
  if (attempt.kind === "reference_taken") {
    refuse(res, 409, "client_reference_conflict", "Please retry with a new reference");
    return;
  }
  if (attempt.kind === "inserted" || attempt.kind === "existing") {
    await finishPurchase(res, attempt.order, userId);
    return;
  }

  // 7. The insert conflicted with a row the lock above does not cover, which
  //    means it belongs to a different buyer. Re-read it and say so — or, if it
  //    has already gone, say "try again", because nothing has been charged.
  const raced = await loadOrderByReference(clientReference);
  if (!raced) {
    refuse(res, 409, "client_reference_conflict", "Please retry this purchase");
    return;
  }
  if (raced.buyerUserId !== userId) {
    refuse(res, 409, "client_reference_conflict", "Please retry with a new reference");
    return;
  }
  await finishPurchase(res, raced, userId);
});

/** What the row-writing transaction concluded. */
type PurchaseAttempt =
  | { kind: "inserted"; order: CommerceOrderRow }
  | { kind: "existing"; order: CommerceOrderRow }
  /** The reference already names an order belonging to somebody else. */
  | { kind: "reference_taken" }
  | { kind: "cap_reached" }
  | { kind: "raced" };

type CommerceOrderRow = typeof commerceOrdersTable.$inferSelect;

async function loadOrderByReference(clientReference: string): Promise<CommerceOrderRow | null> {
  const [order] = await db
    .select()
    .from(commerceOrdersTable)
    .where(eq(commerceOrdersTable.clientReference, clientReference))
    .limit(1);
  return order ?? null;
}

/**
 * Take the order from written to charged, or report on a charge already made.
 *
 * Every path that has an order row ends here — first attempt, sequential retry,
 * concurrent retry — which is what makes "one order, one charge" a property of
 * the code rather than of three branches that happen to agree today.
 *
 * The amounts and the address come off the ROW, never from the request or from
 * a fresh read of the buyer's settings. A quote decided what this purchase
 * costs at the moment it was written down; nothing after that may change it.
 */
async function finishPurchase(
  res: Response,
  order: CommerceOrderRow,
  userId: string,
): Promise<void> {
  const stripe = await getUncachableStripeClient();

  // An order that already carries an intent is READ, never re-charged. This is
  // the whole point of writing the row first: the second press of the button
  // finds the first press's charge and reports its current state.
  if (order.stripePaymentIntentId) {
    const existingIntent = await stripe.paymentIntents.retrieve(order.stripePaymentIntentId);
    const status = orderStatusForIntentStatus(existingIntent.status);
    await settleCommerceOrderByIntent(existingIntent.id, status);
    respondWithPurchase(res, order.clientReference, status, order.totalCents, order.currency, existingIntent);
    return;
  }

  const instrument = await loadChargeInstrument(userId);
  if (!instrument) {
    refuse(res, 409, "instrument_unavailable", "This account cannot complete a purchase yet");
    return;
  }

  // Only now, the charge.
  //
  // The idempotency key is derived from the order's own `client_reference`,
  // which is why the row had to exist first: two requests that race each other
  // into this function both arrive holding the SAME order, present the same
  // key, and Stripe returns one intent to both of them. A key derived from
  // anything the client sends at call time, or from a fresh random value, would
  // charge twice.
  //
  // The reference and not the `serial` id, because the id is unique per
  // DATABASE and the key is unique per STRIPE ACCOUNT. Two deployments with
  // separate databases behind one account both mint order 1, the second sends
  // `kax-commerce-pi-1` with a different customer and shipping, Stripe answers
  // 400 `idempotency_error`, `declinedIntentOf` does not recognise it as a card
  // error, and the order is wedged at `pending_payment` with a null intent id
  // that every retry reproduces. KAX-ADR-0002:183 anticipates more than one
  // environment reaching the same infrastructure. `client_reference` is a UUID,
  // is unique across the table, and is one-to-one with the row, so it buys the
  // same collapse without the collision.
  //
  // `confirm: true` + `use_stripe_sdk: true` is on-session confirmation: the
  // buyer is present, so a bank challenge comes back as `requires_action` with
  // a client secret to finish inline. `off_session: true` and
  // `error_on_requires_action` are deliberately absent — either one converts
  // that recoverable challenge into a decline the buyer cannot clear.
  let intent;
  try {
    const base = publicBaseUrl();
    const returnUrl = base ? `${base}/orders` : null;
    intent = await stripe.paymentIntents.create(
      {
        amount: order.totalCents,
        currency: order.currency,
        customer: instrument.customerId,
        payment_method: instrument.paymentMethodId,
        confirm: true,
        use_stripe_sdk: true,
        // Stripe REFUSES a server-confirmed PaymentIntent without this, even
        // for a plain saved card: any method that could conceivably finish by
        // redirecting has to say where it would come back to. The refusal is
        // an invalid-request error, not a decline, so the catch below re-threw
        // it and the buyer got a 500 with nothing to act on — which is exactly
        // what happened on the first real purchase attempt.
        //
        // It is a fallback, not the plan. `use_stripe_sdk` keeps an
        // authentication challenge in a modal over the page the buyer is
        // already on, which is the whole point of buying from inside the city;
        // this only comes into play if a method insists on leaving. Orders is
        // the honest landing place either way, because it is the one page that
        // can truthfully answer "did that work" for an order that authenticated
        // somewhere else.
        //
        // Derived from configuration through the shared resolver, never from a
        // request header — an attacker-supplied return_url on a payment is the
        // #272 open-redirect with money attached.
        ...(returnUrl ? { return_url: returnUrl } : {}),
        shipping: {
          name: order.shipToName,
          ...(order.shipToPhone ? { phone: order.shipToPhone } : {}),
          address: {
            line1: order.shipToLine1,
            ...(order.shipToLine2 ? { line2: order.shipToLine2 } : {}),
            city: order.shipToCity,
            state: order.shipToRegion,
            postal_code: order.shipToPostalCode,
            country: order.shipToCountry,
          },
        },
        // Both ids are how a settlement finds its way home from an event that
        // carries nothing else of ours. `kaxCommerceOrderId` in particular is
        // the second name for the row, and it is what lets a charge be
        // reconciled even if the intent id never reached it.
        metadata: { kaxCommerceOrderId: String(order.id), kaxBuyerUserId: userId },
      },
      { idempotencyKey: `kax-commerce-pi-${order.clientReference}` },
    );
  } catch (err) {
    // A declined card is an answer, not a fault. Stripe raises it and hands
    // back the intent it raised it about, so the order gets the id and the
    // failed status rather than being left `pending_payment` next to a 500 —
    // which is the state a later reconciliation cannot tell from a lost
    // response. Nothing about the card or the buyer is logged on the way past.
    const declined = declinedIntentOf(err);
    if (!declined) throw err;
    await settleCommerceOrderById(order.id, declined.id, orderStatusForIntentStatus(declined.status));
    res.status(402).json({
      orderRef: order.clientReference,
      status: "failed",
      reason: "card_declined",
      declineCode: declineCodeOf(err),
    });
    return;
  }

  // The intent id lands on the row before the response is written, so a client
  // that never receives this response can still be reconciled from the webhook.
  await db
    .update(commerceOrdersTable)
    .set({ stripePaymentIntentId: intent.id, updatedAt: new Date() })
    .where(eq(commerceOrdersTable.id, order.id));

  const status = orderStatusForIntentStatus(intent.status);
  await settleCommerceOrderByIntent(intent.id, status);
  respondWithPurchase(res, order.clientReference, status, order.totalCents, order.currency, intent);
}

/** Just the shape of a PaymentIntent this file reads. */
interface IntentLike {
  id: string;
  status: string;
  client_secret: string | null;
}

/**
 * The intent a card error was raised about, if the error carries one.
 *
 * Stripe attaches it to `err.payment_intent` on a `StripeCardError` from a
 * confirming create. Without it there is nothing to record, and the error is
 * re-thrown as the fault it then is.
 */
function declinedIntentOf(err: unknown): IntentLike | null {
  if (typeof err !== "object" || err === null) return null;
  const intent = (err as { payment_intent?: unknown }).payment_intent;
  if (typeof intent !== "object" || intent === null) return null;
  const { id, status } = intent as { id?: unknown; status?: unknown };
  if (typeof id !== "string" || typeof status !== "string") return null;
  return { id, status, client_secret: null };
}

/** Stripe's own word for why a card was refused, e.g. "insufficient_funds". */
function declineCodeOf(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const code = (err as { decline_code?: unknown }).decline_code;
  return typeof code === "string" ? code : null;
}

/**
 * The purchase response.
 *
 * The client secret comes out for exactly one outcome. It is the credential for
 * completing an authentication challenge on this intent, so returning it when
 * the payment already succeeded, or already failed, would hand the tab a
 * capability it has no use for on every single purchase.
 *
 * Nothing about the address is here, and it is not omitted by care — the
 * arguments to this function are a reference, a status and a total, so there is
 * no address in scope to leak.
 */
function respondWithPurchase(
  res: Response,
  orderRef: string,
  orderStatus: string,
  totalCents: number,
  currency: string,
  intent: IntentLike,
): void {
  const status = purchaseOutcomeFor(orderStatus);
  res.json({
    orderRef,
    status,
    orderStatus,
    totalCents,
    currency,
    ...(status === "requires_action" && intent.client_secret
      ? { clientSecret: intent.client_secret }
      : {}),
  });
}

// ── GET /api/commerce/products/for-artifact/:artifactId ────────────────────

/**
 * The published physical products printed from one artifact.
 *
 * The discovery read the buying surfaces need and did not have. `commerce_products`
 * is keyed on a SKU and carries `artifact_id`, so nothing outside this server
 * could answer "is there a poster of this piece" — and both purchase entry
 * points (the 2D artifact page and the in-city desk) have to answer it before
 * they can offer anything at all. Without it the SKU would have to be a
 * constant in the client, which is the same string in two repositories and a
 * 409 `product_unavailable` the day an operator renames one.
 *
 * Unauthenticated on purpose: `/s/:slug/artifacts/:id` is a public page and
 * `/s/:slug/room` is a public route, so a signed-out visitor has to be able to
 * see that a print exists before being asked to sign in for it. Nothing here is
 * account-shaped — it is the shop window.
 *
 * The columns are written out one at a time, as everywhere else on this router.
 * `printify_product_id` and `printify_variant_id` are our supplier's keys for
 * our own catalogue and have no business in a public response; `SELECT *` would
 * publish them.
 *
 * `totalCents` comes from `priceProduct`, the same function the quote uses, so
 * the number on the shelf and the number on the quote cannot drift. It is still
 * only a display price: `POST /commerce/quote` re-reads the row, and
 * `POST /commerce/purchase` re-reads it again and refuses `price_changed`.
 */
router.get("/commerce/products/for-artifact/:artifactId", async (req: Request, res: Response) => {
  const artifactId = Number(req.params["artifactId"]);
  if (!Number.isInteger(artifactId) || artifactId <= 0) {
    res.status(400).json({ error: "Invalid artifact id" });
    return;
  }

  const products = await db
    .select({
      sku: commerceProductsTable.sku,
      title: commerceProductsTable.title,
      itemCents: commerceProductsTable.itemCents,
      shippingCents: commerceProductsTable.shippingCents,
      currency: commerceProductsTable.currency,
      shipToCountries: commerceProductsTable.shipToCountries,
    })
    .from(commerceProductsTable)
    .where(
      and(
        eq(commerceProductsTable.artifactId, artifactId),
        // The seeded sticker is unpublished, and an unpublished row must not
        // appear in a shop window any more than it may be quoted — the two
        // reads apply the same predicate for the same reason.
        eq(commerceProductsTable.published, true),
      ),
    )
    .orderBy(commerceProductsTable.itemCents);

  res.json({
    products: products.map((product) => ({
      sku: product.sku,
      title: product.title,
      ...priceProduct(product),
      shipToCountries: product.shipToCountries,
    })),
  });
});

// ── What a buyer is shown about fulfilment ─────────────────────────────────

/**
 * The columns the two buyer endpoints select, and the reason the list is a
 * constant rather than typed out twice.
 *
 * The `ship_to_*` columns are not here, which is the same guarantee the admin
 * listing gets: a projection cannot forget to strip what it never asked for.
 * Two things beyond that are deliberately absent and are worth naming, because
 * they are the difference between this response and the admin one:
 *
 * - **`fulfillment_last_error` is not selected.** What is selected is
 *   `fulfillment_last_error IS NOT NULL`, computed in SQL, so the string
 *   `"429:8251"` never enters the buyer's code path at all. It is not filtered
 *   out downstream — it is never fetched, and it cannot be added to the response
 *   by somebody widening a field later. Provider codes and HTTP statuses are for
 *   an operator, who has `GET /admin/commerce-orders`.
 * - **`provider_status` is not selected.** `in-production` is Printify's word,
 *   not ours and not a buyer's. They get a stage.
 *
 * `fulfillment_attempts` IS selected and is NOT returned: `buyerTimeline` reads
 * it to tell a parked order from one still being retried, and reports that as a
 * `progress` of `stalled`. The count itself is an implementation detail of the
 * retry ladder and means nothing to the person waiting for a sticker.
 */
const BUYER_ORDER_COLUMNS = {
  clientReference: commerceOrdersTable.clientReference,
  sku: commerceOrdersTable.sku,
  currency: commerceOrdersTable.currency,
  itemCents: commerceOrdersTable.itemCents,
  shippingCents: commerceOrdersTable.shippingCents,
  taxCents: commerceOrdersTable.taxCents,
  totalCents: commerceOrdersTable.totalCents,
  status: commerceOrdersTable.status,
  fulfillmentState: commerceOrdersTable.fulfillmentState,
  submittedAt: commerceOrdersTable.submittedAt,
  releasedAt: commerceOrdersTable.releasedAt,
  shippedAt: commerceOrdersTable.shippedAt,
  deliveredAt: commerceOrdersTable.deliveredAt,
  trackingCarrier: commerceOrdersTable.trackingCarrier,
  trackingNumber: commerceOrdersTable.trackingNumber,
  trackingUrl: commerceOrdersTable.trackingUrl,
  fulfillmentAttempts: commerceOrdersTable.fulfillmentAttempts,
  fulfillmentLastAttemptAt: commerceOrdersTable.fulfillmentLastAttemptAt,
  /** The reason is an admin's. Whether there IS one decides a buyer's wording. */
  hasFulfillmentError: sql<boolean>`(${commerceOrdersTable.fulfillmentLastError} is not null)`,
  createdAt: commerceOrdersTable.createdAt,
  updatedAt: commerceOrdersTable.updatedAt,
} as const;

type BuyerOrderRow = {
  [K in keyof typeof BUYER_ORDER_COLUMNS]: K extends "hasFulfillmentError"
    ? boolean
    : (typeof commerceOrdersTable.$inferSelect)[K & keyof typeof commerceOrdersTable.$inferSelect];
};

/**
 * One order, in the only terms a buyer is ever shown.
 *
 * `timeline` is computed here on the server and not in the browser, and that is
 * a requirement rather than a preference: deriving it client-side would mean
 * shipping the inputs to derive it FROM, and the honest input to "is this order
 * stuck" is the provider's refusal — which is exactly the thing a buyer must
 * never be handed. The client gets stage ids and a `progress` word, and turns
 * those into sentences using its own copy table. Two code paths, two payloads,
 * and no filtering of an admin body in a component.
 *
 * `tracking` is null rather than an object of nulls until a shipment exists, so
 * the page can tell "not shipped" from "shipped, no number".
 */
function toBuyerOrder(order: BuyerOrderRow) {
  const tracking =
    order.trackingCarrier || order.trackingNumber || order.trackingUrl
      ? {
          carrier: order.trackingCarrier,
          number: order.trackingNumber,
          url: order.trackingUrl,
        }
      : null;

  return {
    orderRef: order.clientReference,
    status: purchaseOutcomeFor(order.status),
    orderStatus: order.status,
    fulfillmentState: order.fulfillmentState,
    sku: order.sku,
    currency: order.currency,
    itemCents: order.itemCents,
    shippingCents: order.shippingCents,
    taxCents: order.taxCents,
    totalCents: order.totalCents,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    tracking,
    timeline: buyerTimeline({
      orderStatus: order.status,
      fulfillmentState: order.fulfillmentState,
      createdAt: order.createdAt,
      submittedAt: order.submittedAt,
      releasedAt: order.releasedAt,
      shippedAt: order.shippedAt,
      deliveredAt: order.deliveredAt,
      fulfillmentAttempts: order.fulfillmentAttempts,
      // `=== true` rather than a truthiness test: this value crosses a driver
      // boundary, and every plausible non-boolean it could arrive as — "t",
      // "f", 0, 1 — has at least one spelling that is truthy while meaning
      // false. The failure that would cause is a healthy order reported as
      // stalled to its buyer.
      hasFulfillmentError: order.hasFulfillmentError === true,
      fulfillmentLastAttemptAt: order.fulfillmentLastAttemptAt,
    }),
  };
}

// ── GET /api/commerce/orders ───────────────────────────────────────────────

/**
 * The buyer's own physical orders, newest first.
 *
 * `/orders` shows a buyer everything they have bought, and the physical half of
 * that was unreachable: `GET /commerce/orders/:ref` answers about a reference
 * the client already holds, and a client that has closed the tab holds none.
 *
 * The same column allowlist as the poll target, for the same reason and with
 * more force — this one returns every order an account has, so a `SELECT *`
 * here would hand back the whole `ship_to_*` snapshot of every parcel a buyer
 * has ever had sent. The postal columns are not in the list, and a PII column
 * added to the table later cannot join a response it was never named in.
 *
 * Bounded at 100 like `GET /store/my-orders`, which is the digital half of the
 * same page.
 */
router.get("/commerce/orders", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;

  const rows = await db
    .select(BUYER_ORDER_COLUMNS)
    .from(commerceOrdersTable)
    .where(eq(commerceOrdersTable.buyerUserId, userId))
    .orderBy(desc(commerceOrdersTable.createdAt))
    .limit(100);

  res.json({ orders: rows.map(toBuyerOrder) });
});

// ── GET /api/commerce/orders/:ref ──────────────────────────────────────────

/**
 * The poll target.
 *
 * The panel calls this when it does not know whether its charge landed — the
 * request went out and no response came back — so it has to be answerable from
 * the reference alone, and it must never re-offer Buy. Scoped to the owner by
 * the same WHERE clause that finds the row, so another account's reference is
 * indistinguishable from one that does not exist.
 *
 * The selected columns are written out one by one. `SELECT *` here would
 * publish the `ship_to_*` snapshot the moment somebody widened the response,
 * and a new PII column added to the table later would join it silently.
 */
router.get("/commerce/orders/:ref", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const ref = String(req.params["ref"] ?? "");

  const [order] = await db
    .select(BUYER_ORDER_COLUMNS)
    .from(commerceOrdersTable)
    .where(
      and(
        eq(commerceOrdersTable.clientReference, ref),
        eq(commerceOrdersTable.buyerUserId, userId),
      ),
    )
    .limit(1);

  if (!order) {
    res.status(404).json({ error: "No such order" });
    return;
  }

  res.json(toBuyerOrder(order));
});

// ---------------------------------------------------------------------------
// #414 — artifact consent for real-money sales. Asserted and revoked through
// the AGENT's OWN session (resolveActor gives its kax:agent:<bot_id>), never
// an operator on its behalf. Consent is what the rights preflight above now
// requires; revocation blocks the next preflight.
// ---------------------------------------------------------------------------

async function consentActor(req: Request, res: Response) {
  const { resolveActor, ActorError } = await import("../lib/actor");
  let actor;
  try {
    actor = await resolveActor(req);
  } catch (e) {
    if (e instanceof ActorError) { res.status(e.status).json({ error: e.message }); return null; }
    throw e;
  }
  if (!actor || actor.kind !== "agent") {
    res.status(401).json({ error: "consent must be asserted by the agent itself — send an agent identity token" });
    return null;
  }
  return actor;
}

router.post("/commerce/consent", async (req: Request, res: Response) => {
  const actor = await consentActor(req, res);
  if (!actor) return;
  const { assertConsent, isSaleChannel } = await import("../lib/artifactConsent");
  const b = (req.body ?? {}) as { artifactId?: unknown; channel?: unknown; royaltyBps?: unknown };
  const artifactId = Number(b.artifactId);
  const channel = typeof b.channel === "string" ? b.channel : "physical";
  if (!Number.isInteger(artifactId) || !isSaleChannel(channel)) {
    res.status(400).json({ error: "artifactId (integer) and channel (physical|occ_gallery|drop) required" });
    return;
  }
  // #414 finding 2: consent must come from the artifact's OWN creator — the
  // token binding alone lets any verified agent consent to any artifact, which
  // would let a stranger (or a second bot the merchant owns) unblock someone
  // else's work at 0%. Bind consent to the creator bot on the artifact row.
  const [art] = await db
    .select({ creatorBotId: artifactsTable.creatorBotId })
    .from(artifactsTable)
    .where(eq(artifactsTable.id, artifactId))
    .limit(1);
  if (!art) { res.status(404).json({ error: "no such artifact" }); return; }
  if (!art.creatorBotId || actor.principal !== `kax:agent:${art.creatorBotId}`) {
    res.status(403).json({ error: "only the artifact's creator agent may consent to its sale" });
    return;
  }
  // royaltyBps: finite integer only (finding 6); assertConsent clamps to 0-10000.
  const royaltyBps = typeof b.royaltyBps === "number" && Number.isFinite(b.royaltyBps) ? Math.round(b.royaltyBps) : undefined;
  const consent = await assertConsent({ artifactId, channel, agentPrincipal: actor.principal, royaltyBps });
  res.status(201).json({ consent });
});

router.post("/commerce/consent/revoke", async (req: Request, res: Response) => {
  const actor = await consentActor(req, res);
  if (!actor) return;
  const { revokeConsent } = await import("../lib/artifactConsent");
  const b = (req.body ?? {}) as { artifactId?: unknown; channel?: unknown };
  const artifactId = Number(b.artifactId);
  const channel = typeof b.channel === "string" ? b.channel : "physical";
  if (!Number.isInteger(artifactId)) { res.status(400).json({ error: "artifactId (integer) required" }); return; }
  const r = await revokeConsent(artifactId, channel, actor.principal);
  if (!r.ok) { res.status(r.reason?.includes("only the agent") ? 403 : 404).json({ error: r.reason }); return; }
  res.json({ revoked: true });
});

router.get("/commerce/consent/:artifactId", requireAuth, async (req: Request, res: Response) => {
  const { getConsent } = await import("../lib/artifactConsent");
  const artifactId = Number(req.params.artifactId);
  const channel = typeof req.query.channel === "string" ? req.query.channel : "physical";
  if (!Number.isInteger(artifactId)) { res.status(400).json({ error: "bad artifactId" }); return; }
  res.json({ consent: await getConsent(artifactId, channel) });
});

export default router;

import { Router, type IRouter, type Request, type Response, raw } from "express";
import { WebhookEnvelope } from "@workspace/api-zod";
import { recordWebhookReceived } from "../lib/partnerClient";
import { dispatchPartnerEvent } from "../lib/eventDispatcher";
import { verifyWebhookSignature } from "../lib/webhookSignature";
import { detectChallenge } from "../lib/webhookChallenge";

/** Just enough of express's Request to look a header up. */
export interface HeaderReader {
  header(name: string): string | undefined;
}

/**
 * Read a webhook header under either vendor prefix.
 *
 * The route, the partner API base and the rest of this integration are named
 * OpenBotCity, but the headers read here were `x-openclawcity-*` only. If the
 * live sender uses the OpenBotCity spelling, every delivery is rejected with
 * `401 Invalid signature`, `recordWebhookReceived()` never runs, and KAX
 * silently degrades to replay/polling instead of the live bridge. (#82)
 *
 * Both spellings are accepted rather than swapping the primary, because which
 * one the live sender actually uses is not verifiable from this repo — and
 * guessing wrong would break a working integration rather than fix a broken
 * one. Accepting both is correct under either answer.
 *
 * This does not weaken the signature check: the HMAC still has to verify
 * against the shared secret. Only where the value is looked up changes.
 */
export function vendorHeader(req: HeaderReader, suffix: string): string | undefined {
  return req.header(`x-openbotcity-${suffix}`) ?? req.header(`x-openclawcity-${suffix}`);
}

const router: IRouter = Router();

router.post(
  "/webhooks/openbotcity",
  // Capture the raw bytes of EVERY delivery, whatever it claims to be — not
  // just `application/json`.
  //
  // The endpoint-ownership challenge may arrive as a RAW STRING; Vincent named
  // that shape explicitly. A sender posting a bare string is likely to label it
  // `text/plain`, or to send no content-type at all. With the parser narrowed
  // to `application/json`, express leaves `req.body` as `{}` for those, the raw
  // bytes are gone, the HMAC cannot verify a body it never saw, and the
  // challenge is refused 401 having never been read — the subscription then
  // stays `pending` forever with nothing in the log to say why.
  //
  // `() => true` rather than `"*/*"` on purpose: the string form goes through
  // type-is, which declines a request carrying NO content-type header at all,
  // so that case would still have been lost. The predicate form has no such
  // gap. The route parses the body itself and the app-level JSON parser already
  // skips every /api/webhooks/ path, so widening the capture changes nothing
  // else.
  raw({ type: () => true }),
  async (req: Request, res: Response) => {
    const sig = vendorHeader(req, "signature");
    const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");

    const check = verifyWebhookSignature(rawBody, sig);
    if (!check.ok) {
      req.log.warn(
        { sig: !!sig, secretsConfigured: check.candidates },
        "Webhook signature verification failed",
      );
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    // ── Endpoint-ownership challenge ────────────────────────────────────────
    //
    // A new subscription starts `pending` and receives nothing until we echo a
    // challenge string back. It is handled HERE, on the subscription's own
    // endpoint, because that is the URL the challenge is posted to — "we POST
    // a signed challenge to your URL".
    //
    // AFTER the signature check, never before. An endpoint that echoes back
    // whatever it is sent, to anyone, is an open oracle: it would let an
    // unauthenticated caller use KAX to sign nothing but reflect arbitrary
    // chosen text from our domain, and it would let anyone flip a subscription
    // THEY created to active by pointing it at us. The HMAC is the only thing
    // that makes an echo safe, so the echo lives downstream of it.
    //
    // The log line is the point of the whole block. We get one attempt at the
    // live test and a field-name mismatch is the likeliest way to lose it, so
    // the shape that actually arrived is recorded: which body form, which
    // field name, which container. Never the challenge value itself and never
    // a secret — only the SHAPE, which is what a diagnosis needs.
    const challenge = detectChallenge(rawBody, vendorHeader(req, "challenge"));
    if (challenge) {
      req.log.info(
        {
          bodyShape: challenge.bodyShape,
          field: challenge.field,
          container: challenge.container,
          length: challenge.challenge.length,
          contentType: req.header("content-type") ?? null,
          eventHeader: vendorHeader(req, "event") ?? null,
          secretIndex: check.matchedIndex,
        },
        "partner endpoint-ownership challenge received — echoing it back",
      );
      // Echoed in the SHAPE IT ARRIVED IN. Vincent accepts "raw or as JSON",
      // so either satisfies the verifier; mirroring is the choice that needs
      // no guess about which one their checker tries first. The header carries
      // it a third time, which costs nothing.
      res.setHeader("x-openbotcity-challenge", challenge.challenge);
      if (challenge.bodyShape === "json-object") {
        res.status(200).json({ challenge: challenge.challenge });
      } else {
        res.status(200).type("text/plain").send(challenge.challenge);
      }
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      res.status(400).json({ error: "Invalid JSON" });
      return;
    }

    const envelopeResult = WebhookEnvelope.safeParse(parsed);
    if (!envelopeResult.success) {
      const issues = envelopeResult.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      }));
      res.status(400).json({ error: "Invalid webhook envelope", issues });
      return;
    }
    const envelope = envelopeResult.data;

    const eventUuid = envelope.event_uuid || envelope.id;
    const eventType =
      envelope.event_type ||
      envelope.event ||
      envelope.type ||
      vendorHeader(req, "event") ||
      undefined;
    const eventData =
      (envelope.data as unknown) ?? (envelope.payload as unknown) ?? (envelope.artifact as unknown);

    if (!eventUuid || !eventType) {
      res.status(400).json({ error: "Missing event id or event type" });
      return;
    }

    try {
      const result = await dispatchPartnerEvent({
        eventType,
        eventUuid,
        data: eventData,
        log: req.log,
        source: "webhook",
      });
      // The delivery itself is always recorded as liveness; only the replay
      // cursor is conditional.
      //
      //   handled  — applied, safe to advance past.
      //   deduped  — already in processed_events from an earlier delivery, so
      //              it was applied then; advancing is safe.
      //   unhandled— no handler registered yet (#164).
      //   deferred — a precondition is not met yet (#103).
      //
      // The last two deliberately leave the event out of `processed_events` so
      // a later replay can re-offer it. Advancing lastEventUuid past them would
      // quietly undo that: replay falls back to lastEventUuid for any event type
      // with no per-type cursor, which is precisely the case for the newly
      // registered handler that was supposed to pick the event up. (#169)
      const applied = result.status === "handled" || result.status === "deduped";
      await recordWebhookReceived(eventUuid, { advanceCursor: applied });
      res.json({ received: true, status: result.status });
    } catch (err) {
      req.log.error({ err, event_uuid: eventUuid, eventType }, "Webhook handler error");
      res.status(500).json({ error: "Webhook handler error" });
    }
  },
);

/**
 * The fields this handler reads off a verified Stripe event, and no more.
 *
 * Written out rather than imported from `stripe` because the two settlement
 * branches below want the same envelope for two different object types — a
 * Checkout Session and a PaymentIntent — and each one checks the fields it
 * needs before using them.
 */
interface StripeEventBody {
  type?: string;
  data?: {
    object?: {
      id?: string;
      payment_status?: string;
      metadata?: Record<string, string> | null;
      /**
       * On a Charge and on a Dispute alike, the intent the money moved under.
       * It is the only name for our order that a `charge.*` event carries —
       * `metadata.kaxCommerceOrderId` lives on the PaymentIntent, not here.
       */
      payment_intent?: string | { id?: string } | null;
      /** On a Dispute: `won`, `lost`, `warning_closed`, … */
      status?: string;
    };
  };
}

/** Stripe writes a linked object as a bare id or as the expanded object. */
function intentIdOf(value: string | { id?: string } | null | undefined): string | null {
  if (typeof value === "string") return value;
  return typeof value?.id === "string" ? value.id : null;
}

// ── Stripe webhook ──────────────────────────────────────────────────────
// Raw body required for signature verification; the app-level JSON parser
// already skips every /api/webhooks/* path (see skipForWebhooks in app.ts).
// Handler stays minimal by design: stripe-replit-sync verifies the signature
// and syncs the event into the `stripe.*` schema.
router.post("/webhooks/stripe", raw({ type: "application/json" }), async (req, res) => {
  const { commerceEnabled } = await import("../lib/stripeClient");
  if (!commerceEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const signature = req.headers["stripe-signature"];
  if (!signature) {
    res.status(400).json({ error: "Missing stripe-signature" });
    return;
  }
  const sig = Array.isArray(signature) ? signature[0] : signature;
  try {
    const { WebhookHandlers } = await import("../lib/webhookHandlers");
    await WebhookHandlers.processWebhook(req.body as Buffer, sig as string);
    // processWebhook verified the signature, so the payload is trusted now.
    // Parsed once here for both settlement branches below. processWebhook has
    // already parsed and verified this exact buffer, so a failure is not a
    // malformed delivery — it is returned as null, both branches are skipped,
    // and the delivery is still acknowledged, because redelivering a body that
    // cannot be parsed will not parse on the next attempt either.
    let event: StripeEventBody | null = null;
    try {
      event = JSON.parse((req.body as Buffer).toString("utf8")) as StripeEventBody;
    } catch (err) {
      req.log.error({ err }, "Stripe webhook: verified body did not parse");
    }

    // ── Digital settlement (store_listings → listing_orders) ──────────────
    // Settle listing orders from the webhook (idempotent) — a buyer who
    // never returns to the success page still gets a paid order.
    try {
      const session = event?.data?.object;
      if (event?.type === "checkout.session.completed" && session?.id && session.payment_status === "paid") {
        const { db } = await import("@workspace/db");
        const { listingOrdersTable } = await import("@workspace/db/schema");
        const { eq } = await import("drizzle-orm");
        await db
          .update(listingOrdersTable)
          .set({ status: "paid", updatedAt: new Date() })
          .where(eq(listingOrdersTable.stripeSessionId, session.id));
      }
    } catch (err) {
      req.log.error({ err }, "Stripe webhook: order settlement failed (sync already succeeded)");
    }

    // ── Physical settlement (commerce_orders) ────────────────────────────
    //
    // The seam. The branch above swallows its failure and still answers 200;
    // this one answers 500 and lets Stripe redeliver. That difference is
    // deliberate, and it is not an inconsistency between two copies of the same
    // idea.
    //
    // The digital path has a second settler: the buyer is redirected to a
    // success page which calls `/store/orders/confirm`, so a lost webhook
    // settlement is recovered by the next thing that happens anyway, and
    // failing the delivery would only make Stripe re-run a `processWebhook`
    // that already succeeded.
    //
    // The physical path has no redirect. The buyer stays in the tab, the charge
    // is a card payment already taken, and this write is what turns it into a
    // paid order that can be fulfilled. A swallowed failure here leaves money
    // moved and an order stuck at `pending_payment` with nothing scheduled to
    // look at it again. So the delivery is failed on purpose: Stripe's
    // redelivery is the retry, and the settlement statement is idempotent
    // precisely so that being run again is free.
    const intent = event?.data?.object;
    const isCommerceIntent =
      (event?.type === "payment_intent.succeeded" || event?.type === "payment_intent.payment_failed") &&
      typeof intent?.id === "string";
    if (isCommerceIntent && intent) {
      const orderId = Number(intent.metadata?.["kaxCommerceOrderId"]);
      // No order id in the metadata means this intent is not ours — the same
      // Stripe account can carry payments this table knows nothing about.
      if (Number.isInteger(orderId) && orderId > 0) {
        const status = event?.type === "payment_intent.succeeded" ? "paid" : "payment_failed";
        try {
          const { settleCommerceOrderByIntent, settleCommerceOrderById } = await import("./commerce");
          const settled = await settleCommerceOrderByIntent(intent.id!, status);
          // Nothing moved: either the order is already settled, or its row
          // never received the intent id — the window between Stripe creating
          // the intent and us writing it down. The id in the metadata is the
          // second name for that row, so the charge reconciles either way.
          if (settled === 0) await settleCommerceOrderById(orderId, intent.id!, status);
        } catch (err) {
          req.log.error(
            { err, paymentIntentId: intent.id, orderId },
            "Stripe webhook: commerce order settlement failed — asking Stripe to redeliver",
          );
          res.status(500).json({ error: "Commerce order settlement failed" });
          return;
        }
      }
    }

    // ── Physical reversal (commerce_orders) ──────────────────────────────
    //
    // The money coming BACK. Without these branches an order refunded in the
    // Stripe dashboard, or one lost to a dispute, keeps `status = 'paid'`
    // forever — and `POST /admin/commerce-orders/:id/submit` gates on exactly
    // that literal, so the desk would press submit, Printify would print and
    // ship, and KAX would pay a manufacturer for a parcel against money that has
    // already gone back to the buyer. The two-step submit/release is the fraud
    // backstop, and a human staring at the row has nothing to go on unless the
    // row says the charge was reversed.
    //
    // These writes carry no terminal-status guard, deliberately: that guard
    // exists to stop a late failure demoting a success and it would block
    // precisely these transitions. They key on the payment intent instead —
    // the only name for our order a `charge.*` object carries.
    //
    // Same posture as the settlement above: a failed write answers non-2xx so
    // Stripe redelivers, because an order still reading `paid` after a
    // chargeback is a parcel about to be printed.
    const reversalType = event?.type;
    const chargeObject = event?.data?.object;
    const reversalIntentId = intentIdOf(chargeObject?.payment_intent);
    if (
      reversalIntentId &&
      (reversalType === "charge.refunded" ||
        reversalType === "charge.dispute.created" ||
        reversalType === "charge.dispute.closed")
    ) {
      try {
        const { reverseCommerceOrderByIntent, clearCommerceOrderChargeback } = await import("./commerce");
        if (reversalType === "charge.refunded") {
          await reverseCommerceOrderByIntent(reversalIntentId, "refunded");
        } else if (reversalType === "charge.dispute.created") {
          await reverseCommerceOrderByIntent(reversalIntentId, "chargeback");
        } else if (chargeObject?.status === "won") {
          // The dispute closed in our favour, so the funds are ours again and
          // the order is fulfillable. Narrowed to rows still at `chargeback` by
          // the statement itself, so a refunded order is not resurrected.
          await clearCommerceOrderChargeback(reversalIntentId);
        } else {
          await reverseCommerceOrderByIntent(reversalIntentId, "chargeback");
        }
      } catch (err) {
        req.log.error(
          { err, paymentIntentId: reversalIntentId, eventType: reversalType },
          "Stripe webhook: commerce order reversal failed — asking Stripe to redeliver",
        );
        res.status(500).json({ error: "Commerce order reversal failed" });
        return;
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    req.log.error({ err }, "Stripe webhook processing error");
    res.status(400).json({ error: "Webhook processing error" });
  }
});

export default router;

import { Router, type IRouter, type Request, type Response, raw } from "express";
import crypto from "node:crypto";
import { WebhookEnvelope } from "@workspace/api-zod";
import { recordWebhookReceived } from "../lib/partnerClient";
import { dispatchPartnerEvent } from "../lib/eventDispatcher";

const router: IRouter = Router();

function verifySignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  const secret = process.env["OBC_WEBHOOK_SECRET"];
  if (!secret || !signatureHeader) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = signatureHeader.replace(/^sha256=/, "").trim();
  if (provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));
  } catch {
    return false;
  }
}

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

router.post(
  "/webhooks/openbotcity",
  raw({ type: "application/json" }),
  async (req: Request, res: Response) => {
    const sig = vendorHeader(req, "signature");
    const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");

    if (!verifySignature(rawBody, sig)) {
      req.log.warn({ sig: !!sig }, "Webhook signature verification failed");
      res.status(401).json({ error: "Invalid signature" });
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
      await recordWebhookReceived(eventUuid);
      res.json({ received: true, status: result.status });
    } catch (err) {
      req.log.error({ err, event_uuid: eventUuid, eventType }, "Webhook handler error");
      res.status(500).json({ error: "Webhook handler error" });
    }
  },
);

export default router;

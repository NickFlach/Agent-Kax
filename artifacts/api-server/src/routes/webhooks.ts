import { Router, type IRouter, type Request, type Response, raw } from "express";
import crypto from "node:crypto";
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

interface WebhookEnvelope {
  event_uuid?: string;
  id?: string;
  event_type?: string;
  event?: string;
  type?: string;
  occurred_at?: string;
  data?: unknown;
  payload?: unknown;
  artifact?: unknown;
}

router.post(
  "/webhooks/openbotcity",
  raw({ type: "application/json" }),
  async (req: Request, res: Response) => {
    const sig = req.header("x-openclawcity-signature");
    const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");

    if (!verifySignature(rawBody, sig)) {
      req.log.warn({ sig: !!sig }, "Webhook signature verification failed");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    let envelope: WebhookEnvelope;
    try {
      envelope = JSON.parse(rawBody.toString("utf8")) as WebhookEnvelope;
    } catch {
      res.status(400).json({ error: "Invalid JSON" });
      return;
    }

    const eventUuid = envelope.event_uuid || envelope.id;
    const eventType =
      envelope.event_type ||
      envelope.event ||
      envelope.type ||
      req.header("x-openclawcity-event") ||
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

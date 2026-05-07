import { Router, type IRouter, type Request, type Response, raw } from "express";
import crypto from "node:crypto";
import { db } from "@workspace/db";
import {
  artifactsTable,
  activitiesTable,
  processedEventsTable,
  agentsTable,
} from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { recordWebhookReceived } from "../lib/partnerClient";
import type { PartnerArtifact } from "../lib/partnerClient";
import { KANNAKA_SYSTEM_USER_ID } from "../lib/backfill";
import { runTasteEngineFor } from "../lib/tasteEngine";

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

async function handleArtifactCreated(req: Request, data: PartnerArtifact): Promise<void> {
  const existing = await db
    .select({ id: artifactsTable.id })
    .from(artifactsTable)
    .where(eq(artifactsTable.obcArtifactUuid, data.uuid))
    .limit(1);
  if (existing.length > 0) {
    req.log.info({ uuid: data.uuid }, "Webhook artifact already ingested, skipping");
    return;
  }

  const editionType = data.edition?.type ?? "open";

  // Route by creator slug to a registered agent so per-agent dashboards stay accurate.
  const creatorSlug = data.creator?.id ?? null;
  let ownerId: string = KANNAKA_SYSTEM_USER_ID;
  let agentId: number | null = null;
  if (creatorSlug) {
    const [agent] = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.slug, creatorSlug))
      .limit(1);
    if (agent) {
      ownerId = agent.ownerId;
      agentId = agent.id;
    }
  }

  const inserted = await db
    .insert(artifactsTable)
    .values({
      externalId: data.uuid,
      obcArtifactUuid: data.uuid,
      title: data.title || "Untitled",
      creatorName: data.creator?.display_name || "Unknown",
      publicUrl: data.public_url,
      thumbnailUrl: data.thumbnail_url ?? data.public_url,
      reactionCount: data.reaction_count ?? 0,
      artifactType: data.artifact_type as "image" | "audio" | "music" | "text" | "furniture",
      tags: [],
      ownerId,
      agentId,
      editionType,
      editionTotal: data.edition?.total ?? null,
      editionSerial: data.edition?.serial ?? null,
    })
    .onConflictDoNothing({ target: artifactsTable.obcArtifactUuid })
    .returning({ id: artifactsTable.id, title: artifactsTable.title });

  if (inserted[0]) {
    if (agentId !== null) {
      await db
        .update(agentsTable)
        .set({
          artifactsHarvested: sql`${agentsTable.artifactsHarvested} + 1`,
          lastSyncAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(agentsTable.id, agentId));
    }
    await db.insert(activitiesTable).values({
      type: "harvested",
      message: `Webhook ingested "${inserted[0].title}" (${editionType})`,
      artifactTitle: inserted[0].title,
    });
    try {
      await runTasteEngineFor(inserted[0].id);
    } catch (err) {
      req.log.error({ err, id: inserted[0].id }, "Auto-score after webhook ingest failed");
    }
  }
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

    const already = await db
      .select({ eventUuid: processedEventsTable.eventUuid })
      .from(processedEventsTable)
      .where(eq(processedEventsTable.eventUuid, eventUuid))
      .limit(1);

    if (already.length > 0) {
      await recordWebhookReceived(eventUuid);
      res.json({ received: true, deduped: true });
      return;
    }

    try {
      if (eventType === "artifact.created") {
        await handleArtifactCreated(req, eventData as PartnerArtifact);
      } else {
        req.log.info({ type: eventType }, "Webhook event type not handled in v1");
      }
      await db
        .insert(processedEventsTable)
        .values({ eventUuid, eventType })
        .onConflictDoNothing();
      await recordWebhookReceived(eventUuid);
      res.json({ received: true, deduped: false });
    } catch (err) {
      req.log.error({ err, event_uuid: eventUuid }, "Webhook handler error");
      res.status(500).json({ error: "Webhook handler error" });
    }
  },
);

export default router;

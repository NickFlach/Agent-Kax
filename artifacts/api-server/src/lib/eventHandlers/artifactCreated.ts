import { db } from "@workspace/db";
import { artifactsTable, activitiesTable, agentsTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import {
  creatorBotIdOf,
  creatorDisplayNameOf,
  type PartnerArtifact,
  type PartnerArtifactDetail,
} from "../partnerClient";
import { KANNAKA_SYSTEM_USER_ID } from "../backfill";
import { runTasteEngineFor } from "../tasteEngine";
import { maybeRespondToArtwork } from "../kannakaArtworkResponse";
import type { EventHandler } from "../eventDispatcher";

export const handleArtifactCreated: EventHandler = async (data, { log }) => {
  const pa = data as PartnerArtifact;
  if (!pa || typeof pa.uuid !== "string") {
    log.warn({ data }, "artifact.created event missing uuid");
    return;
  }

  const editionType = pa.edition?.type ?? "open";

  // `PartnerArtifact.creator.id` is the OBC bot UUID, not a slug — partnerClient
  // normalises it from `creator.id ?? creator_bot_id ?? fallback.creatorBotId`.
  // This used to be matched against `agents.slug`, which is a different
  // namespace, so the lookup essentially never hit: every webhook-ingested
  // artifact landed with `agentId: null`, owned by the system user, and the
  // agent's `artifactsHarvested` counter never moved. (#102)
  //
  // `obc_bot_id` is the right key — the schema calls it out as the identifier
  // that survives when "OBC slugs/display names can change or 404", and
  // backfill.ts already joins `artifacts.creator_bot_id -> agents.obc_bot_id`.
  //
  // The fallback matters because of WHERE this handler is called from. The
  // polling path runs every artifact through partnerClient's normalizeArtifact()
  // first, which is what collapses `creator_bot_id` into `creator.id`. The
  // webhook path does not: routes/webhooks.ts hands the envelope's `data`
  // straight to the dispatcher. So a raw partner payload carrying a top-level
  // `creator_bot_id` and no nested `creator` object resolved to null here and
  // the artifact was inserted owned by kannaka-system with `agentId: null` —
  // and, because `creator_bot_id` was also stamped null, backfill could not
  // repair it afterwards either. A webhook that beat the harvester therefore
  // mis-attributed the artifact permanently. (#151)
  //
  // `creatorBotIdOf` is the same extractor /auth/agent/verify uses, so auth and
  // ingestion agree on which partner shapes count as carrying a creator id.
  const creatorBotId =
    pa.creator?.id ?? creatorBotIdOf(pa as unknown as PartnerArtifactDetail);
  let ownerId: string = KANNAKA_SYSTEM_USER_ID;
  let agentId: number | null = null;
  if (creatorBotId) {
    const [agent] = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.obcBotId, creatorBotId))
      .limit(1);
    if (agent) {
      ownerId = agent.ownerId;
      agentId = agent.id;
    } else {
      // Slug fallback, kept deliberately. An agent row whose `obc_bot_id` is
      // still null (backfill records those: slugs that no longer resolve on
      // OBC) can only be reached by slug, and a partner that really does send a
      // slug here should not start failing to attribute. Bot id is tried first
      // so the correct key always wins.
      const [bySlug] = await db
        .select()
        .from(agentsTable)
        .where(eq(agentsTable.slug, creatorBotId))
        .limit(1);
      if (bySlug) {
        ownerId = bySlug.ownerId;
        agentId = bySlug.id;
      }
    }
  }

  const inserted = await db
    .insert(artifactsTable)
    .values({
      externalId: pa.uuid,
      obcArtifactUuid: pa.uuid,
      // Webhook events come from the OBC partner API — stamp the same
      // connectorId the pull-based harvester uses so registry-tag queries
      // see both ingestion paths consistently (#16). The schema default
      // ("obc_public") is wrong here.
      connectorId: "obc_partner",
      title: pa.title || "Untitled",
      // Same un-normalised-payload problem as creatorBotId above: a raw webhook
      // shape carries the name at the top level, so reading only the nested
      // field stored every webhook artifact as "Unknown".
      creatorName:
        pa.creator?.display_name ||
        creatorDisplayNameOf(pa as unknown as PartnerArtifactDetail) ||
        "Unknown",
      // The harvester stamps this (harvesterJob.ts) and backfill repairs
      // attribution by joining on it. Leaving it null on the webhook path meant
      // a mis-attributed artifact could not even be repaired later. (#102)
      creatorBotId,
      publicUrl: pa.public_url,
      thumbnailUrl: pa.thumbnail_url ?? pa.public_url,
      reactionCount: pa.reaction_count ?? 0,
      artifactType: pa.artifact_type as "image" | "audio" | "music" | "text" | "furniture" | "video" | "app",
      tags: [],
      ownerId,
      agentId,
      editionType,
      editionTotal: pa.edition?.total ?? null,
      editionSerial: pa.edition?.serial ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: artifactsTable.id, title: artifactsTable.title });

  if (!inserted[0]) {
    log.info({ uuid: pa.uuid }, "artifact.created already ingested, skipping");
    return;
  }
  if (editionType === "1_of_1") {
    log.info(
      { uuid: pa.uuid, title: inserted[0].title },
      "1-of-1 artifact webhook ingested — eligible for NFT mint",
    );
  }

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
    ownerId,
    agentId,
  });
  try {
    await runTasteEngineFor(inserted[0].id);
  } catch (err) {
    log.error({ err, id: inserted[0].id }, "Auto-score after artifact.created failed");
  }

  // Autonomous artwork responder — off unless KANNAKA_ARTWORK_RESPONSE === "on".
  // Fires once per genuinely-new artifact (this branch only runs on a real
  // insert); guards + spacing live inside. Never blocks ingestion.
  void maybeRespondToArtwork(pa);
};

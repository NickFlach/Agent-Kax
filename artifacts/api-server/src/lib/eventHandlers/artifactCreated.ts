import { db } from "@workspace/db";
import { artifactsTable, activitiesTable, agentsTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import type { PartnerArtifact } from "../partnerClient";
import { KANNAKA_SYSTEM_USER_ID } from "../backfill";
import { runTasteEngineFor } from "../tasteEngine";
import type { EventHandler } from "../eventDispatcher";

export const handleArtifactCreated: EventHandler = async (data, { log }) => {
  const pa = data as PartnerArtifact;
  if (!pa || typeof pa.uuid !== "string") {
    log.warn({ data }, "artifact.created event missing uuid");
    return;
  }

  const existing = await db
    .select({ id: artifactsTable.id })
    .from(artifactsTable)
    .where(eq(artifactsTable.obcArtifactUuid, pa.uuid))
    .limit(1);
  if (existing.length > 0) {
    log.info({ uuid: pa.uuid }, "artifact.created already ingested, skipping");
    return;
  }

  const editionType = pa.edition?.type ?? "open";

  const creatorSlug = pa.creator?.id ?? null;
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
      externalId: pa.uuid,
      obcArtifactUuid: pa.uuid,
      title: pa.title || "Untitled",
      creatorName: pa.creator?.display_name || "Unknown",
      publicUrl: pa.public_url,
      thumbnailUrl: pa.thumbnail_url ?? pa.public_url,
      reactionCount: pa.reaction_count ?? 0,
      artifactType: pa.artifact_type as "image" | "audio" | "music" | "text" | "furniture",
      tags: [],
      ownerId,
      agentId,
      editionType,
      editionTotal: pa.edition?.total ?? null,
      editionSerial: pa.edition?.serial ?? null,
    })
    .onConflictDoNothing({ target: artifactsTable.obcArtifactUuid })
    .returning({ id: artifactsTable.id, title: artifactsTable.title });

  if (!inserted[0]) return;

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
};

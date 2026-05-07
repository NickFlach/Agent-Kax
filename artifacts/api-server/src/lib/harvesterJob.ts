import { db } from "@workspace/db";
import {
  artifactsTable,
  activitiesTable,
  processedEventsTable,
  agentsTable,
  type Agent,
} from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import {
  listPartnerArtifacts,
  listPartnerEventsSince,
  recordPollSuccess,
  recordEventCursor,
  getSyncState,
  partnerApiAvailable,
  type PartnerArtifact,
} from "./partnerClient";
import { KANNAKA_SYSTEM_USER_ID } from "./backfill";
import { runTasteEngineFor } from "./tasteEngine";
import { logger } from "./logger";

export interface HarvestRunResult {
  harvested: number;
  newArtifacts: number;
  duplicates: number;
}

async function upsertPartnerArtifact(
  pa: PartnerArtifact,
  ownerId: string,
  agentId: number | null,
): Promise<"new" | "duplicate"> {
  const existing = await db
    .select({ id: artifactsTable.id })
    .from(artifactsTable)
    .where(eq(artifactsTable.obcArtifactUuid, pa.uuid))
    .limit(1);
  if (existing.length > 0) return "duplicate";

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
      editionType: pa.edition?.type ?? "open",
      editionTotal: pa.edition?.total ?? null,
      editionSerial: pa.edition?.serial ?? null,
    })
    .onConflictDoNothing({ target: artifactsTable.obcArtifactUuid })
    .returning({ id: artifactsTable.id });

  return inserted.length > 0 ? "new" : "duplicate";
}

/**
 * Harvest artifacts for a single agent using its own paginated cursor.
 */
export async function runPartnerHarvestForAgent(opts: {
  agent: Agent;
  limit?: number;
  type?: string;
}): Promise<HarvestRunResult> {
  if (!partnerApiAvailable()) {
    throw new Error("OBC_PARTNER_API_KEY not configured");
  }
  const targetLimit = opts.limit ?? 50;
  let cursor: string | null = opts.agent.lastArtifactCursor ?? null;
  let harvested = 0;
  let newArtifacts = 0;
  let duplicates = 0;

  while (harvested < targetLimit) {
    const page = await listPartnerArtifacts({
      since: cursor,
      limit: Math.min(50, targetLimit - harvested),
      type: opts.type,
      creator: opts.agent.slug,
    });
    if (page.artifacts.length === 0) break;

    for (const pa of page.artifacts) {
      harvested++;
      const result = await upsertPartnerArtifact(pa, opts.agent.ownerId, opts.agent.id);
      if (result === "new") newArtifacts++;
      else duplicates++;
      cursor = pa.uuid;
    }

    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }

  await db
    .update(agentsTable)
    .set({
      lastArtifactCursor: cursor,
      lastSyncAt: new Date(),
      artifactsHarvested: sql`${agentsTable.artifactsHarvested} + ${newArtifacts}`,
      updatedAt: new Date(),
    })
    .where(eq(agentsTable.id, opts.agent.id));

  await recordPollSuccess(cursor);

  if (newArtifacts > 0) {
    await db.insert(activitiesTable).values({
      type: "harvested",
      message: `Partner harvest [${opts.agent.slug}]: ${newArtifacts} new (${duplicates} duplicates)`,
    });
  }

  return { harvested, newArtifacts, duplicates };
}

export async function replayMissedEventsOnStartup(): Promise<void> {
  if (!partnerApiAvailable()) {
    logger.info("Partner API key not set; skipping startup event replay");
    return;
  }
  try {
    const state = await getSyncState();
    let cursor: string | null = state?.lastEventUuid ?? null;
    let processed = 0;
    let totalSeen = 0;
    const maxPages = 100;

    for (let pageIdx = 0; pageIdx < maxPages; pageIdx++) {
      const page = await listPartnerEventsSince(cursor);
      if (page.events.length === 0) break;
      totalSeen += page.events.length;

      for (const ev of page.events) {
        const already = await db
          .select({ eventUuid: processedEventsTable.eventUuid })
          .from(processedEventsTable)
          .where(eq(processedEventsTable.eventUuid, ev.event_uuid))
          .limit(1);

        if (already.length > 0) {
          cursor = ev.event_uuid;
          await recordEventCursor(cursor);
          continue;
        }

        let success = true;
        if (ev.event_type === "artifact.created") {
          try {
            const pa = ev.data as PartnerArtifact;
            // Route to agent if the creator slug matches a registered agent.
            const creatorSlug = pa.creator?.id ?? null;
            let ownerId = KANNAKA_SYSTEM_USER_ID;
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
            const result = await upsertPartnerArtifact(pa, ownerId, agentId);
            if (result === "new") {
              const [row] = await db
                .select({ id: artifactsTable.id })
                .from(artifactsTable)
                .where(eq(artifactsTable.obcArtifactUuid, pa.uuid))
                .limit(1);
              if (row) await runTasteEngineFor(row.id);
            }
          } catch (err) {
            success = false;
            logger.error({ err, eventUuid: ev.event_uuid }, "Replay handler failed; will retry on next startup");
          }
        }

        if (success) {
          await db
            .insert(processedEventsTable)
            .values({ eventUuid: ev.event_uuid, eventType: ev.event_type })
            .onConflictDoNothing();
          cursor = ev.event_uuid;
          await recordEventCursor(cursor);
          processed++;
        } else {
          return;
        }
      }

      if (!page.next_cursor) break;
      cursor = page.next_cursor;
      await recordEventCursor(cursor);
    }

    logger.info({ processed, totalSeen, finalCursor: cursor }, "Replayed missed partner events");
  } catch (err) {
    logger.error({ err }, "Startup event replay failed");
  }
}

import { db } from "@workspace/db";
import {
  artifactsTable,
  activitiesTable,
  processedEventsTable,
} from "@workspace/db/schema";
import { eq } from "drizzle-orm";
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
      editionType: pa.edition?.type ?? "open",
      editionTotal: pa.edition?.total ?? null,
      editionSerial: pa.edition?.serial ?? null,
    })
    .onConflictDoNothing({ target: artifactsTable.obcArtifactUuid })
    .returning({ id: artifactsTable.id });

  return inserted.length > 0 ? "new" : "duplicate";
}

export async function runPartnerHarvest(opts: {
  ownerId: string;
  limit?: number;
  type?: string;
}): Promise<HarvestRunResult> {
  if (!partnerApiAvailable()) {
    throw new Error("OBC_PARTNER_API_KEY not configured");
  }
  const targetLimit = opts.limit ?? 50;
  const state = await getSyncState();
  let cursor: string | null = state?.lastArtifactCursor ?? null;
  let harvested = 0;
  let newArtifacts = 0;
  let duplicates = 0;

  while (harvested < targetLimit) {
    const page = await listPartnerArtifacts({
      since: cursor,
      limit: Math.min(50, targetLimit - harvested),
      type: opts.type,
    });
    if (page.artifacts.length === 0) {
      await recordPollSuccess(cursor);
      break;
    }

    for (const pa of page.artifacts) {
      harvested++;
      const result = await upsertPartnerArtifact(pa, opts.ownerId);
      if (result === "new") newArtifacts++;
      else duplicates++;
      cursor = pa.uuid;
    }

    await recordPollSuccess(cursor);
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }

  if (newArtifacts > 0) {
    await db.insert(activitiesTable).values({
      type: "harvested",
      message: `Partner API harvest: ${newArtifacts} new (${duplicates} duplicates)`,
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
            const result = await upsertPartnerArtifact(pa, KANNAKA_SYSTEM_USER_ID);
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

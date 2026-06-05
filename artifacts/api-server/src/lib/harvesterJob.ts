import { db } from "@workspace/db";
import {
  artifactsTable,
  activitiesTable,
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
import { logger } from "./logger";
import { dispatchPartnerEvent, getRegisteredEventTypes } from "./eventDispatcher";

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
  // Insert with `ON CONFLICT DO NOTHING` (no target) so the statement
  // tolerates a violation on EITHER unique constraint
  // (`external_id_unique` or `obc_artifact_uuid_unique`). Both columns
  // hold the same partner UUID; specifying a single target meant the
  // other constraint could still fire and abort the entire harvest tick
  // when the same artifact had already been ingested under another agent.
  const inserted = await db
    .insert(artifactsTable)
    .values({
      externalId: pa.uuid,
      // Stamp the connector id so registry-tag queries see partner-harvested
      // rows correctly (#16). The schema default ("obc_public") is wrong
      // for partner harvests — partner is the authoritative source when
      // available.
      connectorId: "obc_partner",
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
    .onConflictDoNothing()
    .returning({ id: artifactsTable.id });

  if (inserted.length > 0) {
    if (pa.edition?.type === "1_of_1") {
      logger.info(
        { uuid: pa.uuid, title: pa.title, agentId },
        "1-of-1 artifact harvested — eligible for NFT mint",
      );
    }
    return "new";
  }
  return "duplicate";
}

/**
 * Harvest new artifacts for a single agent (top-anchored full catch-up).
 *
 * The partner `since` param returns artifacts OLDER than the given id — the
 * feed is newest-first. A *persisted* cursor therefore only ever pages
 * backward into history and never sees fresh top-of-feed artifacts, which is
 * why agents that had "caught up" stopped ingesting brand-new work entirely.
 *
 * Instead we anchor every run at the top (`since=null`) and page downward
 * until we hit a page that is entirely already in our DB — i.e. we've reached
 * previously-synced territory — or the end of the feed. There is deliberately
 * NO per-run cap: a finite cap would let a run stop mid-backlog, and because
 * every run restarts at the top, the next run's first page would be all
 * duplicates and the early-stop below would fire before reaching the remaining
 * backlog, leaving a permanent gap. Running uncapped, each pass ingests the
 * whole contiguous new region in one go, so new artifacts are never stranded.
 * Idempotent inserts keep steady state cheap (a single all-duplicate page).
 */
export async function runPartnerHarvestForAgent(opts: {
  agent: Agent;
  type?: string;
}): Promise<HarvestRunResult> {
  if (!partnerApiAvailable()) {
    throw new Error("OBC_PARTNER_API_KEY not configured");
  }
  const MAX_PAGES = 1000; // safety bound: 1000 * 50 = 50k artifacts per run
  const PAGE_SIZE = 50;

  let cursor: string | null = null; // always start at the newest
  let newestSeen: string | null = null;
  let harvested = 0;
  let newArtifacts = 0;
  let duplicates = 0;
  let pageIdx = 0;

  for (; pageIdx < MAX_PAGES; pageIdx++) {
    const page = await listPartnerArtifacts({
      since: cursor,
      limit: PAGE_SIZE,
      type: opts.type,
      creator: opts.agent.slug,
      fallbackDisplayName: opts.agent.displayName,
    });
    if (!page.artifacts || page.artifacts.length === 0) break;
    if (newestSeen === null) newestSeen = page.artifacts[0]?.uuid ?? null;

    let pageNew = 0;
    for (const pa of page.artifacts) {
      harvested++;
      const result = await upsertPartnerArtifact(pa, opts.agent.ownerId, opts.agent.id);
      if (result === "new") {
        newArtifacts++;
        pageNew++;
      } else {
        duplicates++;
      }
      cursor = pa.uuid;
    }

    if (pageNew === 0) break; // whole page already known → caught up to synced region
    if (!page.next_cursor) break; // reached the end of the feed
    cursor = page.next_cursor;
  }

  if (pageIdx >= MAX_PAGES) {
    logger.warn(
      { agent: opts.agent.slug, maxPages: MAX_PAGES, newArtifacts },
      "Partner harvest hit MAX_PAGES safety bound — backlog beyond 50k artifacts not ingested this run",
    );
  }

  await db
    .update(agentsTable)
    .set({
      lastArtifactCursor: newestSeen,
      lastSyncAt: new Date(),
      artifactsHarvested: sql`${agentsTable.artifactsHarvested} + ${newArtifacts}`,
      updatedAt: new Date(),
    })
    .where(eq(agentsTable.id, opts.agent.id));

  await recordPollSuccess(newestSeen);

  if (newArtifacts > 0) {
    await db.insert(activitiesTable).values({
      type: "harvested",
      message: `Partner harvest [${opts.agent.slug}]: ${newArtifacts} new (${duplicates} duplicates)`,
      ownerId: opts.agent.ownerId,
      agentId: opts.agent.id,
    });
  }

  return { harvested, newArtifacts, duplicates };
}

export async function replayMissedEventsOnStartup(): Promise<void> {
  if (!partnerApiAvailable()) {
    logger.info("Partner API key not set; skipping startup event replay");
    return;
  }
  const eventTypes = getRegisteredEventTypes();
  if (eventTypes.length === 0) {
    logger.info("No event handlers registered; skipping replay");
    return;
  }
  const state = await getSyncState();
  let cursor: string | null = state?.lastEventUuid ?? null;
  let processed = 0;
  let totalSeen = 0;
  const maxPagesPerType = 100;

  for (const eventType of eventTypes) {
    try {
      for (let pageIdx = 0; pageIdx < maxPagesPerType; pageIdx++) {
        const page = await listPartnerEventsSince(cursor, eventType);
        if (page.events.length === 0) break;
        totalSeen += page.events.length;

        let consecutiveFailures = 0;
        for (const ev of page.events) {
          try {
            const result = await dispatchPartnerEvent({
              eventType: ev.event_type,
              eventUuid: ev.event_uuid,
              data: ev.data,
              log: logger,
              source: "replay",
            });
            cursor = ev.event_uuid;
            await recordEventCursor(cursor);
            if (result.status === "handled" || result.status === "unhandled") processed++;
            consecutiveFailures = 0;
          } catch (err) {
            // Single-event failure during replay shouldn't kill the
            // entire startup replay — previously a `return` here
            // abandoned every remaining event type, which silently
            // dropped data for hours until the next restart. Skip the
            // bad event, advance the cursor so we don't reprocess it,
            // and continue. Only bail (break to outer loop) after 5
            // consecutive failures in this type — that's a real
            // upstream problem, not a one-off bad event.
            logger.error({ err, eventUuid: ev.event_uuid, eventType: ev.event_type }, "Replay handler failed — skipping event");
            cursor = ev.event_uuid;
            await recordEventCursor(cursor).catch(() => {});
            consecutiveFailures++;
            if (consecutiveFailures >= 5) {
              logger.warn({ eventType, consecutiveFailures }, "5 consecutive replay failures — skipping rest of this event type");
              throw err; // breaks to outer catch, continues to next type
            }
          }
        }

        if (!page.next_cursor) break;
        cursor = page.next_cursor;
        await recordEventCursor(cursor);
      }
    } catch (err) {
      logger.warn({ err, eventType }, "Skipping event type during startup replay");
    }
  }

  logger.info({ processed, totalSeen, finalCursor: cursor, eventTypes }, "Replayed missed partner events");
}

import { db } from "@workspace/db";
import {
  artifactsTable,
  activitiesTable,
  agentsTable,
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
import { maybeRespondToArtwork } from "./kannakaArtworkResponse";
import { dispatchPartnerEvent, getRegisteredEventTypes } from "./eventDispatcher";
import {
  findOrCreateAgentByBotUuid,
  KANNAKA_SYSTEM_USER_ID,
  type ResolvedAgent,
} from "./backfill";

export interface HarvestRunResult {
  harvested: number;
  newArtifacts: number;
  duplicates: number;
}

interface Attribution {
  ownerId: string;
  agentId: number | null;
  creatorName: string;
  creatorBotId: string | null;
}

async function upsertPartnerArtifact(
  pa: PartnerArtifact,
  attribution: Attribution,
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
      creatorName: attribution.creatorName,
      creatorBotId: attribution.creatorBotId,
      publicUrl: pa.public_url,
      thumbnailUrl: pa.thumbnail_url ?? pa.public_url,
      reactionCount: pa.reaction_count ?? 0,
      artifactType: pa.artifact_type as "image" | "audio" | "music" | "text" | "furniture",
      tags: [],
      ownerId: attribution.ownerId,
      agentId: attribution.agentId,
      editionType: pa.edition?.type ?? "open",
      editionTotal: pa.edition?.total ?? null,
      editionSerial: pa.edition?.serial ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: artifactsTable.id });

  if (inserted.length > 0) {
    if (pa.edition?.type === "1_of_1") {
      logger.info(
        { uuid: pa.uuid, title: pa.title, agentId: attribution.agentId },
        "1-of-1 artifact harvested — eligible for NFT mint",
      );
    }
    return "new";
  }
  return "duplicate";
}

/**
 * Global partner harvest (top-anchored full catch-up), attributing every
 * artifact to its TRUE creator by bot UUID.
 *
 * Why global and not per-agent: the OBC partner feed IGNORES the `creator`
 * filter and always returns the same newest-first global feed. Running it
 * per-agent therefore re-fetched the identical feed N times and stamped every
 * artifact onto whichever agent happened to run. Instead we make a single pass
 * and attribute each artifact via `creator_bot_id` -> `agents.obc_bot_id`,
 * auto-creating an unclaimed placeholder agent (owned by the Kannaka system
 * user) for creators nobody has onboarded yet.
 *
 * The partner `since` param returns artifacts OLDER than the given id, so we
 * anchor every run at the top (`since=null`) and page downward until we hit a
 * page that is entirely already in our DB — i.e. previously-synced territory —
 * or the end of the feed. There is deliberately NO per-run cap (see the
 * MAX_PAGES safety bound only): each pass ingests the whole contiguous new
 * region in one go, and idempotent inserts keep steady state cheap.
 */
export async function runPartnerHarvest(opts: {
  type?: string;
} = {}): Promise<HarvestRunResult> {
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

  // Cache bot id -> resolved agent within a run; also tally new artifacts per
  // agent (for stats) and per owner (for activity-feed entries).
  const agentCache = new Map<string, ResolvedAgent>();
  const perAgentNew = new Map<number, number>();
  const perOwnerNew = new Map<string, number>();

  for (; pageIdx < MAX_PAGES; pageIdx++) {
    const page = await listPartnerArtifacts({
      since: cursor,
      limit: PAGE_SIZE,
      ...(opts.type ? { type: opts.type } : {}),
    });
    if (!page.artifacts || page.artifacts.length === 0) break;
    if (newestSeen === null) newestSeen = page.artifacts[0]?.uuid ?? null;

    let pageNew = 0;
    for (const pa of page.artifacts) {
      harvested++;
      const botId = pa.creator?.id || null;
      let agent: ResolvedAgent | null = null;
      if (botId) {
        agent = agentCache.get(botId) ?? null;
        if (!agent) {
          agent = await findOrCreateAgentByBotUuid(botId);
          agentCache.set(botId, agent);
        }
      }
      const result = await upsertPartnerArtifact(pa, {
        ownerId: agent?.ownerId ?? KANNAKA_SYSTEM_USER_ID,
        agentId: agent?.id ?? null,
        creatorName: agent?.displayName ?? (pa.creator?.display_name || "Unknown"),
        creatorBotId: botId,
      });
      if (result === "new") {
        newArtifacts++;
        pageNew++;
        if (agent) {
          perAgentNew.set(agent.id, (perAgentNew.get(agent.id) ?? 0) + 1);
          perOwnerNew.set(agent.ownerId, (perOwnerNew.get(agent.ownerId) ?? 0) + 1);
        }
        // Poll-path trigger for the artwork responder (off unless enabled).
        // Idempotent vs the webhook path: only ONE path ever sees a given
        // artifact as "new", and the responder's recency gate keeps the
        // top-anchored backfill from firing at historical work.
        void maybeRespondToArtwork(pa);
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
      { maxPages: MAX_PAGES, newArtifacts },
      "Partner harvest hit MAX_PAGES safety bound — backlog beyond 50k artifacts not ingested this run",
    );
  }

  // Bump per-agent harvest counters + sync timestamps for agents that gained work.
  for (const [agentId, n] of perAgentNew) {
    await db
      .update(agentsTable)
      .set({
        lastSyncAt: new Date(),
        artifactsHarvested: sql`${agentsTable.artifactsHarvested} + ${n}`,
        updatedAt: new Date(),
      })
      .where(eq(agentsTable.id, agentId));
  }

  await recordPollSuccess(newestSeen);

  // One activity-feed entry per owner that gained artifacts, so a claimed
  // creator sees harvest activity in their dashboard (placeholder/system-owned
  // work is summarised under the Kannaka system user).
  for (const [ownerId, n] of perOwnerNew) {
    if (n <= 0) continue;
    await db.insert(activitiesTable).values({
      type: "harvested",
      message: `Partner harvest: ${n} new artifact${n === 1 ? "" : "s"}`,
      ownerId,
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

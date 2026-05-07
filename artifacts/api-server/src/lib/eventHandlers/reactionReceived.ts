import { db } from "@workspace/db";
import { artifactsTable, reactionsTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { runTasteEngineFor } from "../tasteEngine";
import type { EventHandler } from "../eventDispatcher";

export interface ReactionReceivedPayload {
  reaction_uuid?: string;
  uuid?: string;
  artifact_uuid?: string;
  kind?: string;
  occurred_at?: string;
}

export const handleReactionReceived: EventHandler = async (data, { log }) => {
  const p = (data ?? {}) as ReactionReceivedPayload;
  const sourceUuid = p.reaction_uuid ?? p.uuid;
  const artifactUuid = p.artifact_uuid;
  if (!sourceUuid || !artifactUuid) {
    log.warn({ data }, "reaction.received missing reaction or artifact uuid");
    return;
  }

  const [artifact] = await db
    .select({ id: artifactsTable.id })
    .from(artifactsTable)
    .where(eq(artifactsTable.obcArtifactUuid, artifactUuid))
    .limit(1);
  if (!artifact) {
    log.info({ artifactUuid }, "reaction.received for unknown artifact, skipping");
    return;
  }

  const now = new Date();
  let occurredAt = now;
  if (p.occurred_at) {
    const parsed = new Date(p.occurred_at);
    if (!Number.isNaN(parsed.getTime())) occurredAt = parsed;
    else log.warn({ occurredAt: p.occurred_at, sourceUuid }, "reaction.received occurred_at unparseable; falling back to now");
  }

  const inserted = await db
    .insert(reactionsTable)
    .values({
      artifactId: artifact.id,
      kind: p.kind ?? "like",
      sourceUuid,
      createdAt: occurredAt,
    })
    .onConflictDoNothing({ target: reactionsTable.sourceUuid })
    .returning({ id: reactionsTable.id });

  if (inserted.length === 0) {
    log.info({ sourceUuid }, "reaction.received deduped on source_uuid");
    return;
  }

  // Bump heat + reactionCount; advance lastReactionAt only if this event is
  // newer than what we already have, so a replayed old reaction can't make a
  // long-cold artifact look hot right now.
  await db
    .update(artifactsTable)
    .set({
      heat: sql`${artifactsTable.heat} + 1`,
      reactionCount: sql`${artifactsTable.reactionCount} + 1`,
      lastReactionAt: sql`GREATEST(COALESCE(${artifactsTable.lastReactionAt}, 'epoch'::timestamp), ${occurredAt})`,
    })
    .where(eq(artifactsTable.id, artifact.id));

  try {
    await runTasteEngineFor(artifact.id);
  } catch (err) {
    log.error({ err, id: artifact.id }, "Re-score after reaction.received failed");
  }
};

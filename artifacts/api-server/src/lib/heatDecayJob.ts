import { db } from "@workspace/db";
import { artifactsTable } from "@workspace/db/schema";
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { computeScore, HEAT_RAW_COOLDOWN_MS } from "./tasteEngine";
import { logger } from "./logger";

export type HeatDecayResult = {
  scanned: number;
  decayed: number;
  zeroed: number;
  rescoreSkipped: number;
};

/**
 * Halve the raw `heat` integer on artifacts whose most recent reaction is
 * older than the cooldown window (or that have no reaction at all but still
 * carry residual heat). Re-runs the taste engine inline so kannakaScore and
 * scoreBreakdown stay consistent with the decayed value.
 *
 * Concurrency: the heat halving is done in a single conditional UPDATE
 * (with the staleness predicate re-checked at write time) so a reaction
 * that arrives between scan and update cannot be clobbered. The follow-up
 * score write is also conditional on the heat / lastReactionAt values we
 * just observed; if a reaction landed in between, we skip the rescore and
 * let the reaction handler's own `runTasteEngineFor` call carry the
 * authoritative score.
 *
 * No activity row is written — this is a background hygiene job, not a
 * user or system event worth surfacing in the feed.
 */
export async function runHeatDecayOnce(now: Date = new Date()): Promise<HeatDecayResult> {
  const cutoff = new Date(now.getTime() - HEAT_RAW_COOLDOWN_MS);

  // Atomic halving: the WHERE clause re-asserts the staleness predicate at
  // write time so a concurrent reaction.received update (which atomically
  // bumps heat and advances lastReactionAt) cannot have its work erased.
  const decayedRows = await db
    .update(artifactsTable)
    .set({ heat: sql`${artifactsTable.heat} / 2` })
    .where(
      and(
        gt(artifactsTable.heat, 0),
        or(
          isNull(artifactsTable.lastReactionAt),
          lt(artifactsTable.lastReactionAt, cutoff),
        ),
      ),
    )
    .returning();

  let zeroed = 0;
  let rescoreSkipped = 0;

  for (const a of decayedRows) {
    if (a.heat === 0) zeroed += 1;

    const { kannakaScore, rarityScore, breakdown } = computeScore({
      reactionCount: a.reactionCount,
      editionType: a.editionType,
      heat: a.heat,
      lastReactionAt: a.lastReactionAt,
      now,
    });

    // Conditional score write: only overwrite the score if heat and
    // lastReactionAt still match what we just observed. If a reaction
    // landed in the gap, that handler will run the taste engine itself
    // with fresh state, so dropping our stale rescore is correct.
    const lastReactionPredicate = a.lastReactionAt
      ? eq(artifactsTable.lastReactionAt, a.lastReactionAt)
      : isNull(artifactsTable.lastReactionAt);

    const updated = await db
      .update(artifactsTable)
      .set({
        kannakaScore,
        rarityScore,
        scoreBreakdown: breakdown,
      })
      .where(
        and(
          eq(artifactsTable.id, a.id),
          eq(artifactsTable.heat, a.heat),
          lastReactionPredicate,
        ),
      )
      .returning({ id: artifactsTable.id });

    if (updated.length === 0) rescoreSkipped += 1;
  }

  return {
    scanned: decayedRows.length,
    decayed: decayedRows.length,
    zeroed,
    rescoreSkipped,
  };
}

export const HEAT_DECAY_INTERVAL_MS = 60 * 60 * 1000; // hourly

let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const result = await runHeatDecayOnce();
    if (result.scanned > 0) {
      logger.info(result, "Heat decay sweep completed");
    }
  } catch (err) {
    logger.error({ err }, "Heat decay sweep failed");
  } finally {
    running = false;
  }
}

export function startHeatDecayScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    void tick();
  }, HEAT_DECAY_INTERVAL_MS);
  logger.info(
    { intervalMs: HEAT_DECAY_INTERVAL_MS, cooldownMs: HEAT_RAW_COOLDOWN_MS },
    "Heat decay scheduler started",
  );
  void tick();
}

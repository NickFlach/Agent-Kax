import { db } from "@workspace/db";
import { artifactsTable, activitiesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

export const SCARCITY_MULTIPLIERS: Record<string, number> = {
  open: 1.0,
  limited: 1.2,
  "1_of_1": 1.5,
};

// Heat half-life in minutes — heat from a reaction loses half its weight every hour.
export const HEAT_HALF_LIFE_MIN = 60;

// Cooldown window for the raw `heat` integer. If an artifact has had no new
// reactions inside this window, the periodic decay job halves its raw heat
// so old viral moments stop dominating the breakdown panel and scoring.
export const HEAT_RAW_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

export type ScoreBreakdown = {
  reactionSignal: number;
  heatSignal: number;
  novelty: number;
  exploration: number;
  baseScore: number;
  scarcityMultiplier: number;
  editionType: string;
  finalScore: number;
};

/**
 * Returns a 0..1 signal derived from time-decayed heat. Recent reactions count
 * more than old ones; tanh keeps the curve bounded so a viral artifact does
 * not blow out the rest of the score.
 */
export function decayedHeatSignal(input: {
  heat: number;
  lastReactionAt: Date | null;
  now?: Date;
}): number {
  if (input.heat <= 0 || !input.lastReactionAt) return 0;
  const now = input.now ?? new Date();
  const ageMin = Math.max(0, (now.getTime() - input.lastReactionAt.getTime()) / 60_000);
  const decay = Math.pow(0.5, ageMin / HEAT_HALF_LIFE_MIN);
  const decayed = input.heat * decay;
  // Saturating curve: ~0.46 at heat=5, ~0.76 at heat=10, asymptote 1.
  return Math.tanh(decayed / 10);
}

// FNV-1a 32-bit hash of a string. Cheap, deterministic, no crypto needed
// for what is effectively a per-artifact seed. Same string in → same
// number out, every time.
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

// Linear-congruential PRNG seeded from a 32-bit integer. Returns a
// stream of floats in [0, 1). Drift-free determinism: same seed →
// same sequence, forever. Replaces Math.random() so an artifact's
// score is reproducible from its (id, createdAt) tuple.
function lcgFloats(seed: number): () => number {
  let s = seed >>> 0;
  if (s === 0) s = 0x9e3779b9;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function computeScore(input: {
  reactionCount: number;
  editionType: string;
  heat?: number;
  lastReactionAt?: Date | null;
  now?: Date;
  /** Artifact id (or uuid). Required for deterministic scoring; if
   *  omitted, scoring falls back to non-deterministic Math.random for
   *  one-off / test paths that don't have a stable id yet. */
  id?: number | string | null;
  /** Stable creation time. Folded into the seed so the same id at
   *  different creation moments doesn't accidentally collide. */
  createdAt?: Date | string | null;
}): { kannakaScore: number; rarityScore: number; breakdown: ScoreBreakdown } {
  const reactionSignal = Math.min(input.reactionCount / 100, 1);
  const heatSignal = decayedHeatSignal({
    heat: input.heat ?? 0,
    lastReactionAt: input.lastReactionAt ?? null,
    now: input.now,
  });
  // Deterministic PRNG. The "novelty" and "exploration" are score
  // jitter, but each artifact deserves a FIXED jitter that doesn't
  // change between calls — otherwise rescoring the same artifact two
  // ticks apart produces different finalScores and breaks auditing.
  let rand: () => number;
  if (input.id != null) {
    const seedSrc =
      `${input.id}|${input.createdAt instanceof Date ? input.createdAt.toISOString() : (input.createdAt ?? "")}`;
    rand = lcgFloats(fnv1a32(seedSrc));
  } else {
    rand = Math.random;
  }
  const novelty = rand() * 0.3;
  const exploration = rand() * 0.1;
  // Reactions and heat together carry the social weight, then novelty/exploration on top.
  const baseScore = reactionSignal * 0.35 + heatSignal * 0.25 + novelty + exploration + 0.1;
  const scarcityMultiplier = SCARCITY_MULTIPLIERS[input.editionType] ?? 1.0;
  const finalScore = Math.min(baseScore * scarcityMultiplier, 1);
  const rarityScore = Math.min(
    (rand() * 0.4 + 0.3) * scarcityMultiplier,
    1,
  );
  return {
    kannakaScore: Math.round(finalScore * 100) / 100,
    rarityScore: Math.round(rarityScore * 100) / 100,
    breakdown: {
      reactionSignal: Math.round(reactionSignal * 1000) / 1000,
      heatSignal: Math.round(heatSignal * 1000) / 1000,
      novelty: Math.round(novelty * 1000) / 1000,
      exploration: Math.round(exploration * 1000) / 1000,
      baseScore: Math.round(baseScore * 1000) / 1000,
      scarcityMultiplier,
      editionType: input.editionType,
      finalScore: Math.round(finalScore * 1000) / 1000,
    },
  };
}

export async function runTasteEngineFor(id: number): Promise<void> {
  const [a] = await db.select().from(artifactsTable).where(eq(artifactsTable.id, id)).limit(1);
  if (!a) return;
  const { kannakaScore, rarityScore, breakdown } = computeScore({
    reactionCount: a.reactionCount,
    editionType: a.editionType,
    heat: a.heat,
    lastReactionAt: a.lastReactionAt,
    id: a.id,
    createdAt: a.createdAt,
  });

  await db
    .update(artifactsTable)
    .set({
      kannakaScore,
      rarityScore,
      scoreBreakdown: breakdown,
      status: a.status === "raw" ? "scored" : a.status,
      scoredAt: new Date(),
    })
    .where(eq(artifactsTable.id, id));

  await db.insert(activitiesTable).values({
    type: "scored",
    message: `Auto-scored "${a.title}" — ${(kannakaScore * 100).toFixed(0)}% (${a.editionType})`,
    artifactTitle: a.title,
    ownerId: a.ownerId,
    agentId: a.agentId,
  });
}

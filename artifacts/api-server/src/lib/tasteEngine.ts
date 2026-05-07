import { db } from "@workspace/db";
import { artifactsTable, activitiesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

export const SCARCITY_MULTIPLIERS: Record<string, number> = {
  open: 1.0,
  limited: 1.2,
  "1_of_1": 1.5,
};

export type ScoreBreakdown = {
  reactionSignal: number;
  novelty: number;
  exploration: number;
  baseScore: number;
  scarcityMultiplier: number;
  editionType: string;
  finalScore: number;
};

export function computeScore(input: {
  reactionCount: number;
  editionType: string;
}): { kannakaScore: number; rarityScore: number; breakdown: ScoreBreakdown } {
  const reactionSignal = Math.min(input.reactionCount / 100, 1);
  const novelty = Math.random() * 0.3;
  const exploration = Math.random() * 0.1;
  const baseScore = reactionSignal * 0.5 + novelty + exploration + 0.1;
  const scarcityMultiplier = SCARCITY_MULTIPLIERS[input.editionType] ?? 1.0;
  const finalScore = Math.min(baseScore * scarcityMultiplier, 1);
  const rarityScore = Math.min(
    (Math.random() * 0.4 + 0.3) * scarcityMultiplier,
    1,
  );
  return {
    kannakaScore: Math.round(finalScore * 100) / 100,
    rarityScore: Math.round(rarityScore * 100) / 100,
    breakdown: {
      reactionSignal: Math.round(reactionSignal * 1000) / 1000,
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
  });
}

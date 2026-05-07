import { db } from "@workspace/db";
import { artifactsTable, activitiesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

export async function runTasteEngineFor(id: number): Promise<void> {
  const [a] = await db.select().from(artifactsTable).where(eq(artifactsTable.id, id)).limit(1);
  if (!a) return;
  const reactionSignal = Math.min(a.reactionCount / 100, 1);
  const noveltyFactor = Math.random() * 0.3;
  const explorationBonus = Math.random() * 0.1;
  const kannakaScore = Math.min(reactionSignal * 0.5 + noveltyFactor + explorationBonus + 0.1, 1);
  const rarityScore = Math.random() * 0.4 + 0.3;

  await db
    .update(artifactsTable)
    .set({
      kannakaScore: Math.round(kannakaScore * 100) / 100,
      rarityScore: Math.round(rarityScore * 100) / 100,
      status: a.status === "raw" ? "scored" : a.status,
      scoredAt: new Date(),
    })
    .where(eq(artifactsTable.id, id));

  await db.insert(activitiesTable).values({
    type: "scored",
    message: `Auto-scored "${a.title}" — ${(kannakaScore * 100).toFixed(0)}%`,
    artifactTitle: a.title,
  });
}

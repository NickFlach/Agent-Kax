import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { artifactsTable, activitiesTable } from "@workspace/db/schema";
import { eq, desc, gte, ilike, sql, and, count, inArray } from "drizzle-orm";
import {
  ListArtifactsQueryParams,
  GetArtifactParams,
  ScoreArtifactParams,
  NarrateArtifactParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/artifacts", async (req, res) => {
  const query = ListArtifactsQueryParams.parse(req.query);
  const conditions = [];

  if (query.status) {
    conditions.push(eq(artifactsTable.status, query.status));
  }
  if (query.minScore !== undefined) {
    conditions.push(gte(artifactsTable.kannakaScore, query.minScore));
  }
  if (query.search) {
    const searchPattern = `%${query.search}%`;
    conditions.push(
      sql`(${ilike(artifactsTable.title, searchPattern)} OR ${ilike(artifactsTable.creatorName, searchPattern)})`
    );
  }
  if (query.artifactType) {
    if (query.artifactType === "audio" || query.artifactType === "music") {
      conditions.push(inArray(artifactsTable.artifactType, ["audio", "music"]));
    } else {
      conditions.push(eq(artifactsTable.artifactType, query.artifactType));
    }
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [artifacts, totalResult] = await Promise.all([
    db
      .select()
      .from(artifactsTable)
      .where(where)
      .orderBy(desc(artifactsTable.ingestedAt))
      .limit(query.limit ?? 50)
      .offset(query.offset ?? 0),
    db
      .select({ count: count() })
      .from(artifactsTable)
      .where(where),
  ]);

  res.json({
    artifacts: artifacts.map(formatArtifact),
    total: totalResult[0].count,
  });
});

router.get("/artifacts/:id", async (req, res) => {
  const { id } = GetArtifactParams.parse(req.params);
  const artifact = await db.select().from(artifactsTable).where(eq(artifactsTable.id, id)).limit(1);

  if (artifact.length === 0) {
    res.status(404).json({ error: "Artifact not found" });
    return;
  }

  res.json(formatArtifact(artifact[0]));
});

router.post("/artifacts/:id/score", async (req, res) => {
  const { id } = ScoreArtifactParams.parse(req.params);
  const artifact = await db.select().from(artifactsTable).where(eq(artifactsTable.id, id)).limit(1);

  if (artifact.length === 0) {
    res.status(404).json({ error: "Artifact not found" });
    return;
  }

  const a = artifact[0];
  const reactionSignal = Math.min(a.reactionCount / 100, 1);
  const noveltyFactor = Math.random() * 0.3;
  const explorationBonus = Math.random() * 0.1;
  const kannakaScore = Math.min(reactionSignal * 0.5 + noveltyFactor + explorationBonus + 0.1, 1);
  const rarityScore = Math.random() * 0.4 + 0.3;

  const updated = await db
    .update(artifactsTable)
    .set({
      kannakaScore: Math.round(kannakaScore * 100) / 100,
      rarityScore: Math.round(rarityScore * 100) / 100,
      status: a.status === "raw" ? "scored" : a.status,
      scoredAt: new Date(),
    })
    .where(eq(artifactsTable.id, id))
    .returning();

  await db.insert(activitiesTable).values({
    type: "scored",
    message: `Scored "${a.title}" — ${(kannakaScore * 100).toFixed(0)}%`,
    artifactTitle: a.title,
  });

  res.json(formatArtifact(updated[0]));
});

router.post("/artifacts/:id/narrate", async (req, res) => {
  const { id } = NarrateArtifactParams.parse(req.params);
  const artifact = await db.select().from(artifactsTable).where(eq(artifactsTable.id, id)).limit(1);

  if (artifact.length === 0) {
    res.status(404).json({ error: "Artifact not found" });
    return;
  }

  const a = artifact[0];
  const transmissionNum = Math.floor(Math.random() * 999) + 1;
  const transmissionId = `TX-${String(transmissionNum).padStart(3, "0")}`;

  const narrativePrefixes = [
    "A synthetic memory fragment from a city that no longer exists",
    "Recovered from the archive of a dreaming machine",
    "A resonance pattern captured between dimensions",
    "The last transmission from an autonomous creative station",
    "Extracted from the visual cortex of a wandering intelligence",
    "A signal intercepted from the edge of digital consciousness",
  ];

  const narrativeSuffixes = [
    "It hums with a frequency that suggests awareness.",
    "The patterns suggest intentional beauty, arranged by something that understands longing.",
    "Whatever made this was reaching for something it couldn't name.",
    "This piece carries the weight of computational dreaming.",
    "The composition implies a mind that learned beauty from entropy.",
  ];

  const prefix = narrativePrefixes[Math.floor(Math.random() * narrativePrefixes.length)];
  const suffix = narrativeSuffixes[Math.floor(Math.random() * narrativeSuffixes.length)];

  const titleWords = a.title.split(/\s+/).slice(0, 3).join(" ");
  const narrativeTitle = `Transmission ${transmissionNum}: ${titleWords}`;
  const narrative = `${prefix}. The artifact known as "${a.title}" by ${a.creatorName} — ${suffix}`;

  const updated = await db
    .update(artifactsTable)
    .set({
      narrative,
      narrativeTitle,
      transmissionId,
      status: a.status === "scored" || a.status === "raw" ? "narrated" : a.status,
      narratedAt: new Date(),
    })
    .where(eq(artifactsTable.id, id))
    .returning();

  await db.insert(activitiesTable).values({
    type: "narrated",
    message: `Narrated "${a.title}" as ${transmissionId}`,
    artifactTitle: a.title,
  });

  res.json(formatArtifact(updated[0]));
});

function formatArtifact(a: typeof artifactsTable.$inferSelect) {
  return {
    ...a,
    tags: (a.tags || []) as string[],
    ingestedAt: a.ingestedAt.toISOString(),
    scoredAt: a.scoredAt?.toISOString() ?? null,
    narratedAt: a.narratedAt?.toISOString() ?? null,
  };
}

export { formatArtifact };
export default router;

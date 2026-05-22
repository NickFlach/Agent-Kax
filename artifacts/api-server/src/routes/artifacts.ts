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
import { canMutate, requireAuth, getOwnerScope, getOptionalAuth } from "../middlewares/requireAuth";
import { computeScore } from "../lib/tasteEngine";
import { isArtifactPublic } from "../lib/visibility";
import { dropsTable } from "@workspace/db/schema";

const router: IRouter = Router();

router.get("/artifacts", requireAuth, async (req, res) => {
  const query = ListArtifactsQueryParams.parse(req.query);
  const conditions = [];

  const ownerScope = await getOwnerScope(req);
  if (ownerScope !== null) {
    conditions.push(eq(artifactsTable.ownerId, ownerScope));
  }

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
  if (query.editionType) {
    conditions.push(eq(artifactsTable.editionType, query.editionType));
  }
  if (query.agentId !== undefined) {
    conditions.push(eq(artifactsTable.agentId, query.agentId));
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
  const [artifact] = await db.select().from(artifactsTable).where(eq(artifactsTable.id, id)).limit(1);

  if (!artifact) {
    res.status(404).json({ error: "Artifact not found" });
    return;
  }

  // Owners and admins see their own artifacts unconditionally. Everyone
  // else only sees artifacts attached to a published drop AND in a
  // publishable status. Without this filter the route was leaking raw /
  // scored / private artifact metadata by enumerable numeric id (#6).
  const auth = await getOptionalAuth(req);
  if (auth && (auth.role === "admin" || artifact.ownerId === auth.id)) {
    res.json(formatArtifact(artifact));
    return;
  }
  // Fetch the drop only when we need to check visibility (not for owners).
  let drop = null;
  if (artifact.dropId != null) {
    [drop] = await db
      .select()
      .from(dropsTable)
      .where(eq(dropsTable.id, artifact.dropId))
      .limit(1);
  }
  if (!isArtifactPublic(artifact, drop ?? null)) {
    res.status(404).json({ error: "Artifact not found" });
    return;
  }
  res.json(formatArtifact(artifact));
});

router.post("/artifacts/:id/score", requireAuth, async (req, res) => {
  const { id } = ScoreArtifactParams.parse(req.params);
  const artifact = await db.select().from(artifactsTable).where(eq(artifactsTable.id, id)).limit(1);

  if (artifact.length === 0) {
    res.status(404).json({ error: "Artifact not found" });
    return;
  }

  const a = artifact[0];
  if (!(await canMutate(req, a.ownerId))) {
    res.status(403).json({ error: "Not authorized to modify this artifact" });
    return;
  }
  const { kannakaScore, rarityScore, breakdown } = computeScore({
    reactionCount: a.reactionCount,
    editionType: a.editionType,
    heat: a.heat,
    lastReactionAt: a.lastReactionAt,
  });

  const updated = await db
    .update(artifactsTable)
    .set({
      kannakaScore,
      rarityScore,
      scoreBreakdown: breakdown,
      status: a.status === "raw" ? "scored" : a.status,
      scoredAt: new Date(),
    })
    .where(eq(artifactsTable.id, id))
    .returning();

  await db.insert(activitiesTable).values({
    type: "scored",
    message: `Scored "${a.title}" — ${(kannakaScore * 100).toFixed(0)}% (${a.editionType}, ×${breakdown.scarcityMultiplier})`,
    artifactTitle: a.title,
    ownerId: a.ownerId,
    agentId: a.agentId,
  });

  res.json(formatArtifact(updated[0]));
});

router.post("/artifacts/:id/narrate", requireAuth, async (req, res) => {
  const { id } = NarrateArtifactParams.parse(req.params);
  const artifact = await db.select().from(artifactsTable).where(eq(artifactsTable.id, id)).limit(1);

  if (artifact.length === 0) {
    res.status(404).json({ error: "Artifact not found" });
    return;
  }

  const a = artifact[0];
  if (!(await canMutate(req, a.ownerId))) {
    res.status(403).json({ error: "Not authorized to modify this artifact" });
    return;
  }
  // Transmission id: previously `TX-NNN` with N in 1..999 chosen at
  // random — collides with surprising regularity once you have a few
  // hundred artifacts. Use the artifact id itself (monotonic, unique by
  // construction) padded to at least 3 digits. Cosmetic: keep the
  // TX- prefix so the rest of the UI doesn't need to know.
  const transmissionId = `TX-${String(a.id).padStart(3, "0")}`;

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
  const narrativeTitle = `Transmission ${transmissionId}: ${titleWords}`;
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
    ownerId: a.ownerId,
    agentId: a.agentId,
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
    editionType: a.editionType,
    editionTotal: a.editionTotal,
    editionSerial: a.editionSerial,
    obcArtifactUuid: a.obcArtifactUuid,
    agentId: a.agentId,
    scoreBreakdown: a.scoreBreakdown ?? null,
    heat: a.heat,
    lastReactionAt: a.lastReactionAt?.toISOString() ?? null,
  };
}

export { formatArtifact };
export default router;

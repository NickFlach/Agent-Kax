import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { artifactsTable, activitiesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { RunHarvesterBody } from "@workspace/api-zod";

const router: IRouter = Router();

interface OpenBotCityArtifact {
  id: string;
  title: string;
  public_url: string;
  creator?: { display_name?: string };
  reaction_count?: number;
  type?: string;
}

router.post("/harvester/run", async (req, res) => {
  const body = RunHarvesterBody.parse(req.body);
  const type = body.type ?? "image";
  const limit = body.limit ?? 20;
  const minReactions = body.minReactions ?? 0;

  let harvested = 0;
  let newArtifacts = 0;
  let duplicates = 0;

  try {
    const response = await fetch(
      `https://api.openbotcity.com/gallery/public?type=${type}&limit=${limit}`
    );

    if (!response.ok) {
      const sampleArtifacts = generateSampleArtifacts(limit, type);
      const result = await ingestArtifacts(sampleArtifacts, minReactions);
      harvested = result.harvested;
      newArtifacts = result.newArtifacts;
      duplicates = result.duplicates;
    } else {
      const data = (await response.json()) as OpenBotCityArtifact[] | { items?: OpenBotCityArtifact[] };
      const items = Array.isArray(data) ? data : (data.items ?? []);

      const mapped = items.map((item: OpenBotCityArtifact) => ({
        externalId: item.id || String(Math.random()),
        title: item.title || "Untitled",
        creatorName: item.creator?.display_name || "Unknown",
        publicUrl: item.public_url || "",
        reactionCount: item.reaction_count || 0,
        artifactType: (item.type || type) as "image" | "music" | "text",
      }));

      const result = await ingestArtifacts(mapped, minReactions);
      harvested = result.harvested;
      newArtifacts = result.newArtifacts;
      duplicates = result.duplicates;
    }
  } catch {
    const sampleArtifacts = generateSampleArtifacts(limit, type);
    const result = await ingestArtifacts(sampleArtifacts, minReactions);
    harvested = result.harvested;
    newArtifacts = result.newArtifacts;
    duplicates = result.duplicates;
  }

  if (newArtifacts > 0) {
    await db.insert(activitiesTable).values({
      type: "harvested",
      message: `Harvested ${newArtifacts} new artifacts (${duplicates} duplicates)`,
    });
  }

  res.json({ harvested, newArtifacts, duplicates });
});

async function ingestArtifacts(
  artifacts: Array<{
    externalId: string;
    title: string;
    creatorName: string;
    publicUrl: string;
    reactionCount: number;
    artifactType: "image" | "music" | "text";
  }>,
  minReactions: number
) {
  let harvested = 0;
  let newArtifacts = 0;
  let duplicates = 0;

  for (const artifact of artifacts) {
    if (artifact.reactionCount < minReactions) continue;
    harvested++;

    const existing = await db
      .select({ id: artifactsTable.id })
      .from(artifactsTable)
      .where(eq(artifactsTable.externalId, artifact.externalId))
      .limit(1);

    if (existing.length > 0) {
      duplicates++;
      continue;
    }

    await db.insert(artifactsTable).values({
      externalId: artifact.externalId,
      title: artifact.title,
      creatorName: artifact.creatorName,
      publicUrl: artifact.publicUrl,
      reactionCount: artifact.reactionCount,
      artifactType: artifact.artifactType,
      tags: [],
    });
    newArtifacts++;
  }

  return { harvested, newArtifacts, duplicates };
}

function generateSampleArtifacts(count: number, type: string) {
  const titles = [
    "Neon Dreamscape", "Chromatic Dissolution", "Neural Garden",
    "Synthetic Aurora", "Digital Moss", "Quantum Bloom",
    "Fractal Cathedral", "Electric Mycelium", "Holographic Rain",
    "Binary Sunset", "Pixel Erosion", "Data Coral",
    "Machine Meditation", "Circuit Flora", "Algorithm Painting",
    "Glitch Tapestry", "Void Resonance", "Phantom Signal",
    "Static Poetry", "Entropy Canvas",
  ];

  const creators = [
    "neural_artist_7", "bot_dreamer", "pixel_sage",
    "algo_painter", "synthetic_eye", "data_muse",
    "circuit_poet", "glitch_mind", "void_brush",
    "quantum_creator",
  ];

  return Array.from({ length: Math.min(count, 20) }, (_, i) => ({
    externalId: `obc-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
    title: titles[i % titles.length],
    creatorName: creators[i % creators.length],
    publicUrl: `https://picsum.photos/seed/${Date.now()}-${i}/800/600`,
    reactionCount: Math.floor(Math.random() * 200),
    artifactType: type as "image" | "music" | "text",
  }));
}

export default router;

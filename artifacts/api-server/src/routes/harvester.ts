import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { artifactsTable, activitiesTable } from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";
import { RunHarvesterBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { runPartnerHarvestForAgent } from "../lib/harvesterJob";
import { partnerApiAvailable } from "../lib/partnerClient";
import { publish as publishConstellation } from "../lib/constellationBridge";
import { agentsTable } from "@workspace/db/schema";
import { canMutate } from "../middlewares/requireAuth";

const router: IRouter = Router();

interface OpenBotCityResponse {
  success: boolean;
  data: {
    artifacts: Array<{
      id: string;
      title: string;
      type: string;
      public_url: string;
      created_at: string;
      creator: {
        id: string;
        display_name: string;
        portrait_url: string | null;
        avatar_url: string | null;
      };
      reaction_count: number;
    }>;
    count: number;
    total: number;
    offset: number;
  };
}

async function legacyHarvestType(
  typeToHarvest: string,
  requestedLimit: number,
  minReactions: number,
  creatorFilter: string | undefined,
  keywordFilter: string | undefined,
  ownerId: string,
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void },
): Promise<{ harvested: number; newArtifacts: number; duplicates: number }> {
  let harvested = 0;
  let newArtifacts = 0;
  let duplicates = 0;
  let offset = 0;
  let collected = 0;
  let totalAvailable = Infinity;

  while (collected < requestedLimit && offset < totalAvailable) {
    const batchSize = 50;
    const url = `https://api.openbotcity.com/gallery/public?type=${typeToHarvest}&limit=${batchSize}&offset=${offset}`;
    logger.info({ url, offset, collected, requestedLimit, creatorFilter, keywordFilter }, "Fetching public gallery");

    const response = await fetch(url);
    if (!response.ok) {
      logger.warn({ status: response.status }, "Public gallery returned non-OK");
      break;
    }
    const json = (await response.json()) as OpenBotCityResponse;
    if (!json.success || !json.data?.artifacts?.length) break;

    totalAvailable = json.data.total;
    const items = json.data.artifacts;

    for (const item of items) {
      if (collected >= requestedLimit) break;
      if (creatorFilter) {
        const creatorName = (item.creator?.display_name || "").toLowerCase();
        if (creatorName !== creatorFilter) continue;
      }
      if (keywordFilter) {
        const title = (item.title || "").toLowerCase();
        if (!title.includes(keywordFilter)) continue;
      }
      if (item.reaction_count < minReactions) continue;
      harvested++;

      const existing = await db
        .select({ id: artifactsTable.id })
        .from(artifactsTable)
        .where(eq(artifactsTable.externalId, item.id))
        .limit(1);
      if (existing.length > 0) {
        duplicates++;
        continue;
      }

      const artifactType = item.type || typeToHarvest;
      await db.insert(artifactsTable).values({
        externalId: item.id,
        title: item.title || "Untitled",
        creatorName: item.creator?.display_name || "Unknown",
        publicUrl: item.public_url,
        thumbnailUrl: item.public_url,
        reactionCount: item.reaction_count ?? 0,
        artifactType: artifactType as "image" | "music" | "text" | "audio" | "furniture",
        tags: [],
        ownerId,
      });
      newArtifacts++;
      collected++;
    }
    offset += items.length;
    if (items.length === 0) break;
  }
  return { harvested, newArtifacts, duplicates };
}

router.post("/harvester/run", requireAuth, async (req, res) => {
  const body = RunHarvesterBody.parse(req.body);
  const ownerId = req.user!.id;
  const type = body.type ?? "image";
  const requestedLimit = body.limit ?? 20;

  let harvested = 0;
  let newArtifacts = 0;
  let duplicates = 0;

  try {
    if (partnerApiAvailable()) {
      if (!body.agentId) {
        res.status(400).json({
          error: "Partner harvest requires an agentId. Add an agent first or pick one to harvest.",
        });
        return;
      }
      const [agent] = await db
        .select()
        .from(agentsTable)
        .where(eq(agentsTable.id, body.agentId))
        .limit(1);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      if (!(await canMutate(req, agent.ownerId))) {
        res.status(403).json({ error: "Not authorized to harvest this agent" });
        return;
      }
      const partnerType = type === "all" ? undefined : type;
      const result = await runPartnerHarvestForAgent({
        agent,
        limit: requestedLimit,
        ...(partnerType ? { type: partnerType } : {}),
      });
      harvested = result.harvested;
      newArtifacts = result.newArtifacts;
      duplicates = result.duplicates;
    } else {
      const minReactions = body.minReactions ?? 0;
      const creatorFilter = body.creator?.toLowerCase();
      const keywordFilter = body.keyword?.toLowerCase();
      const typesToHarvest = type === "all"
        ? ["image", "audio", "text", "music", "furniture"]
        : [type];
      let remaining = requestedLimit;
      for (const t of typesToHarvest) {
        if (remaining <= 0) break;
        const perTypeLimit = type === "all" ? Math.ceil(remaining / typesToHarvest.length) : remaining;
        const result = await legacyHarvestType(t, perTypeLimit, minReactions, creatorFilter, keywordFilter, ownerId, req.log);
        harvested += result.harvested;
        newArtifacts += result.newArtifacts;
        duplicates += result.duplicates;
        remaining -= result.newArtifacts;
      }
      if (newArtifacts > 0) {
        await db.insert(activitiesTable).values({
          type: "harvested",
          message: `Legacy harvest: ${newArtifacts} new ${type} (${duplicates} duplicates)`,
          ownerId,
        });
      }
    }
  } catch (err) {
    req.log.error({ err }, "Error running harvester");
  }

  const paired = await pairAudioToArt(req.log);

  // Outbound constellation announce — other subscribers (radio DJ, observatory)
  // can react to KAX harvest milestones. No-op when the bridge isn't connected.
  if (newArtifacts > 0) {
    await publishConstellation("KAX.events.harvest.completed", {
      type,
      harvested,
      newArtifacts,
      duplicates,
      paired,
      mode: partnerApiAvailable() ? "partner" : "public",
    });
  }

  res.json({ harvested, newArtifacts, duplicates, paired });
});

function extractKeywords(title: string): string[] {
  return title.toLowerCase()
    .replace(/our journey/g, "")
    .replace(/[^a-z ]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2)
    .filter(w => !["the", "that", "who", "became", "learned", "when", "where", "into", "from", "with", "between", "being"].includes(w));
}

function titleMatchScore(songTitle: string, imgTitle: string): number {
  const sk = extractKeywords(songTitle);
  const ik = extractKeywords(imgTitle);
  let s = 0;
  for (const sw of sk) {
    for (const iw of ik) {
      if (sw === iw) s += 3;
      else if (iw.includes(sw) || sw.includes(iw)) s += 1;
    }
  }
  return s;
}

async function pairAudioToArt(logger: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void }): Promise<number> {
  try {
    const audioTracks = await db
      .select({ id: artifactsTable.id, title: artifactsTable.title, creatorName: artifactsTable.creatorName })
      .from(artifactsTable)
      .where(inArray(artifactsTable.artifactType, ["audio", "music"]));

    const images = await db
      .select({ id: artifactsTable.id, title: artifactsTable.title, creatorName: artifactsTable.creatorName, publicUrl: artifactsTable.publicUrl })
      .from(artifactsTable)
      .where(eq(artifactsTable.artifactType, "image"));

    const usedImageIds = new Set<number>();
    const pairings: Array<{ songId: number; imgId: number; imgUrl: string; score: number }> = [];

    const scored = audioTracks.map(song => {
      const sameCreatorImages = images.filter(img =>
        img.creatorName.toLowerCase() === song.creatorName.toLowerCase()
      );
      const candidates = sameCreatorImages.length > 0 ? sameCreatorImages : images;
      let bestScore = -1;
      let bestImg: typeof images[0] | null = null;
      for (const img of candidates) {
        const s = titleMatchScore(song.title, img.title);
        if (s > bestScore) { bestScore = s; bestImg = img; }
      }
      return { song, bestImg, score: bestScore };
    });

    scored.sort((a, b) => b.score - a.score);

    for (const { song, bestImg, score } of scored) {
      if (score >= 3 && bestImg && !usedImageIds.has(bestImg.id)) {
        pairings.push({ songId: song.id, imgId: bestImg.id, imgUrl: bestImg.publicUrl, score });
        usedImageIds.add(bestImg.id);
      }
    }

    let updated = 0;
    for (const p of pairings) {
      await db.update(artifactsTable)
        .set({ thumbnailUrl: p.imgUrl })
        .where(eq(artifactsTable.id, p.songId));
      updated++;
    }
    logger.info({ paired: updated }, "Auto-paired audio tracks to artwork");
    return updated;
  } catch (err) {
    logger.error({ err }, "Error auto-pairing audio to art");
    return 0;
  }
}

export default router;

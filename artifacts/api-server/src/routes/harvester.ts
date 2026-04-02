import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { artifactsTable, activitiesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { RunHarvesterBody } from "@workspace/api-zod";

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

router.post("/harvester/run", async (req, res) => {
  const body = RunHarvesterBody.parse(req.body);
  const type = body.type ?? "image";
  const requestedLimit = body.limit ?? 20;
  const minReactions = body.minReactions ?? 0;
  const creatorFilter = body.creator?.toLowerCase();

  let harvested = 0;
  let newArtifacts = 0;
  let duplicates = 0;

  try {
    let offset = 0;
    let collected = 0;
    let totalAvailable = Infinity;

    while (collected < requestedLimit && offset < totalAvailable) {
      const batchSize = 50;
      const url = `https://api.openbotcity.com/gallery/public?type=${type}&limit=${batchSize}&offset=${offset}`;

      req.log.info({ url, offset, collected, requestedLimit, creatorFilter }, "Fetching from OpenBotCity");

      const response = await fetch(url);

      if (!response.ok) {
        req.log.warn({ status: response.status }, "OpenBotCity API returned non-OK status");
        break;
      }

      const json = (await response.json()) as OpenBotCityResponse;

      if (!json.success || !json.data?.artifacts?.length) {
        req.log.info("No more artifacts available from OpenBotCity");
        break;
      }

      totalAvailable = json.data.total;
      const items = json.data.artifacts;

      for (const item of items) {
        if (collected >= requestedLimit) break;

        if (creatorFilter) {
          const creatorName = (item.creator?.display_name || "").toLowerCase();
          if (creatorName !== creatorFilter) continue;
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
          collected++;
          continue;
        }

        await db.insert(artifactsTable).values({
          externalId: item.id,
          title: item.title || "Untitled",
          creatorName: item.creator?.display_name || "Unknown",
          publicUrl: item.public_url,
          thumbnailUrl: item.public_url,
          reactionCount: item.reaction_count ?? 0,
          artifactType: (item.type || type) as "image" | "music" | "text",
          tags: [],
        });
        newArtifacts++;
        collected++;
      }

      offset += items.length;

      if (items.length === 0) {
        break;
      }
    }
  } catch (err) {
    req.log.error({ err }, "Error harvesting from OpenBotCity");
  }

  if (newArtifacts > 0) {
    const creatorMsg = creatorFilter ? ` by "${creatorFilter}"` : "";
    await db.insert(activitiesTable).values({
      type: "harvested",
      message: `Harvested ${newArtifacts} new artifacts${creatorMsg} from OpenBotCity (${duplicates} duplicates skipped)`,
    });
  }

  res.json({ harvested, newArtifacts, duplicates });
});

export default router;

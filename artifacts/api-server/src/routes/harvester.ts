import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { artifactsTable, activitiesTable } from "@workspace/db/schema";
import { eq, inArray, desc } from "drizzle-orm";
import { RunHarvesterBody } from "@workspace/api-zod";
import { requireAdmin } from "../middlewares/requireAuth";
import { runPartnerHarvest } from "../lib/harvesterJob";
import { partnerApiAvailable } from "../lib/partnerClient";
import { publish as publishConstellation } from "../lib/constellationBridge";
import { runRegistryHarvest } from "../lib/registryHarvest";

const router: IRouter = Router();

// Admin-only: with the partner API configured this triggers the single global
// harvest pass (mutates rows across every owner, spends the shared partner
// budget); the registry fallback likewise ingests system-wide. Either way this
// is a privileged operation, not a per-user one.
router.post("/harvester/run", requireAdmin, async (req, res) => {
  const body = RunHarvesterBody.parse(req.body);
  const ownerId = req.user!.id;
  const type = body.type ?? "image";
  const requestedLimit = body.limit ?? 20;

  let harvested = 0;
  let newArtifacts = 0;
  let duplicates = 0;

  // Note: we no longer wrap this in a try/catch that swallows errors and
  // returns 200. Async route rejections propagate to the global error
  // handler in app.ts, which returns a 500 with a logged stack so DB
  // hiccups stop silently pretending to succeed.
  if (partnerApiAvailable()) {
    // The OBC partner feed ignores the creator filter, so harvesting is a
    // single global top-anchored pass — there is no per-agent harvest. Each
    // artifact is attributed to its true creator by bot UUID, auto-creating
    // unclaimed placeholder agents as needed (see runPartnerHarvest). The
    // optional agentId from the UI is ignored.
    const partnerType = type === "all" ? undefined : type;
    const result = await runPartnerHarvest({
      ...(partnerType ? { type: partnerType } : {}),
    });
    harvested = result.harvested;
    newArtifacts = result.newArtifacts;
    duplicates = result.duplicates;
  } else {
    // Registry path — fans out across every enabled AgenticConnector.
    // OBC public + constellation today; HF Spaces / Civitai / Replicate
    // when those land (#21). Adding a new platform never has to touch
    // this route.
    const minReactions = body.minReactions ?? 0;
    const keywordFilter = body.keyword?.toLowerCase();
    const result = await runRegistryHarvest({
      ownerId,
      ...(type !== "all" ? { type: type as never } : {}),
      ...(body.creator ? { creator: body.creator } : {}),
      limit: requestedLimit,
    });
    harvested = result.totalHarvested;
    newArtifacts = result.totalNew;
    duplicates = result.totalDuplicates;

    // Post-fetch filters that pre-registry legacy supported but the
    // connector contract doesn't yet model. Apply by deleting the
    // already-inserted rows that don't match. Cheaper than threading
    // filters through every connector, and these are rarely used.
    if (minReactions > 0 || keywordFilter) {
      const justInserted = await db
        .select()
        .from(artifactsTable)
        .where(eq(artifactsTable.ownerId, ownerId))
        .orderBy(desc(artifactsTable.ingestedAt))
        .limit(newArtifacts);
      const toDelete = justInserted.filter((row) => {
        if (minReactions > 0 && row.reactionCount < minReactions) return true;
        if (keywordFilter && !row.title.toLowerCase().includes(keywordFilter)) return true;
        return false;
      });
      if (toDelete.length > 0) {
        for (const row of toDelete) {
          await db.delete(artifactsTable).where(eq(artifactsTable.id, row.id));
        }
        newArtifacts -= toDelete.length;
      }
    }

    if (newArtifacts > 0) {
      const summary = result.perConnector
        .filter((p) => p.newArtifacts > 0)
        .map((p) => `${p.connectorId}:${p.newArtifacts}`)
        .join(" ");
      await db.insert(activitiesTable).values({
        type: "harvested",
        message: `Registry harvest: ${newArtifacts} new ${type} across [${summary}] (${duplicates} duplicates)`,
        ownerId,
      });
    }
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

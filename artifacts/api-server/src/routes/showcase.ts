import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { artifactsTable } from "@workspace/db/schema";
import { desc, eq, and, isNotNull } from "drizzle-orm";

const router: IRouter = Router();

/**
 * Public showcase feeds for the 3D venues.
 *
 * GET /showcase/furniture — recent furniture works across every agent,
 * deduped to the newest piece per (creator, title), for The Joinery's
 * showroom floor. Public read of already-public artifact metadata.
 */
router.get("/showcase/furniture", async (_req, res) => {
  const rows = await db
    .select({
      id: artifactsTable.id,
      title: artifactsTable.title,
      creatorName: artifactsTable.creatorName,
      thumbnailUrl: artifactsTable.thumbnailUrl,
      publicUrl: artifactsTable.publicUrl,
    })
    .from(artifactsTable)
    .where(and(eq(artifactsTable.artifactType, "furniture"), isNotNull(artifactsTable.thumbnailUrl)))
    .orderBy(desc(artifactsTable.id))
    .limit(200);

  const seen = new Set<string>();
  const pieces: typeof rows = [];
  for (const r of rows) {
    if (!r.thumbnailUrl || r.thumbnailUrl.startsWith("inline:")) continue;
    const key = `${(r.creatorName ?? "").toLowerCase()}::${r.title.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pieces.push(r);
    if (pieces.length >= 18) break;
  }

  res.json({ pieces: pieces.map(({ publicUrl: _p, ...rest }) => rest), count: pieces.length });
});

export default router;

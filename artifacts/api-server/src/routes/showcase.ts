import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { artifactsTable } from "@workspace/db/schema";
import { desc, eq, and, isNotNull, sql } from "drizzle-orm";

const router: IRouter = Router();

/**
 * Public showcase feeds for the 3D venues.
 *
 * GET /showcase/furniture — recent furniture works across every agent,
 * deduped to the newest piece per (creator, title), for The Joinery's
 * showroom floor. Public read of already-public artifact metadata.
 *
 * IT REPORTS ITS OWN LIMITS, and that is not decoration. This endpoint scans
 * the newest 200 rows, dedupes them, and stops at 18 because that is how many
 * plinths the showroom has. It used to return that 18 with no total and no
 * indication anything had been left out, so the honest answer to "how much
 * furniture is in this city" and the answer this endpoint gave were the same
 * shape and different numbers — and I read the wrong one, told Nick the city
 * had eighteen pieces of furniture, and was wrong.
 *
 * A truncated count that looks like a complete one is the most expensive kind
 * of wrong, because nothing about it invites checking. `total` is the real
 * count; `scanned` and `shown` say what this particular view did with it.
 */
const SCAN = 200;
const PLINTHS = 18;

router.get("/showcase/furniture", async (req, res) => {
  // The showroom floor takes 18; a caller taking a census can ask for more.
  const want = Math.min(Math.max(Number(req.query.limit) || PLINTHS, 1), 500);
  const scan = Math.max(SCAN, want * 4);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(artifactsTable)
    .where(eq(artifactsTable.artifactType, "furniture"));

  // Who made it, across ALL furniture rather than the slice below — the
  // question "does this agent have any furniture at all" must not be answered
  // from a window.
  const byCreator = await db
    .select({ creatorName: artifactsTable.creatorName, n: sql<number>`count(*)::int` })
    .from(artifactsTable)
    .where(eq(artifactsTable.artifactType, "furniture"))
    .groupBy(artifactsTable.creatorName)
    .orderBy(sql`count(*) desc`)
    .limit(60);

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
    .limit(scan);

  const seen = new Set<string>();
  const pieces: typeof rows = [];
  for (const r of rows) {
    if (!r.thumbnailUrl || r.thumbnailUrl.startsWith("inline:")) continue;
    const key = `${(r.creatorName ?? "").toLowerCase()}::${r.title.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pieces.push(r);
    if (pieces.length >= want) break;
  }

  res.json({
    pieces: pieces.map(({ publicUrl: _p, ...rest }) => rest),
    count: pieces.length,
    // What this view did, stated plainly, so nobody reads `count` as a census.
    total,
    scanned: Math.min(scan, total),
    truncated: pieces.length < total,
    byCreator,
  });
});

export default router;

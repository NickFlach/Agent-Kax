import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { dropsTable, artifactsTable } from "@workspace/db/schema";
import { eq, desc, count, isNotNull, and } from "drizzle-orm";
import { formatArtifact } from "./artifacts";
import {
  GetStorefrontDropsQueryParams,
  GetStorefrontDropParams,
} from "@workspace/api-zod";
import { publicArtifactWhere, isPublishableStatus } from "../lib/visibility";

const router: IRouter = Router();

router.get("/storefront/drops", async (req, res) => {
  const query = GetStorefrontDropsQueryParams.parse(req.query);

  const [drops, totalResult] = await Promise.all([
    db
      .select()
      .from(dropsTable)
      .where(eq(dropsTable.status, "published"))
      .orderBy(desc(dropsTable.publishedAt))
      .limit(query.limit ?? 20)
      .offset(query.offset ?? 0),
    db
      .select({ count: count() })
      .from(dropsTable)
      .where(eq(dropsTable.status, "published")),
  ]);

  const dropsWithArtifacts = await Promise.all(
    drops.map(async (drop) => {
      const artifacts = await db
        .select()
        .from(artifactsTable)
        .where(eq(artifactsTable.dropId, drop.id));
      // Publishable-status floor — see #9. The drop itself is already
      // published (filtered above), but its inner artifacts could
      // include raw/scored back-doors stamped by the private
      // drop-management route.
      const publishable = artifacts.filter((a) => isPublishableStatus(a.status));
      return {
        ...drop,
        artifacts: publishable.map(formatArtifact),
        createdAt: drop.createdAt.toISOString(),
        publishedAt: drop.publishedAt?.toISOString() ?? null,
      };
    })
  );

  res.json({ drops: dropsWithArtifacts, total: totalResult[0].count });
});

router.get("/storefront/drops/:id", async (req, res) => {
  const { id } = GetStorefrontDropParams.parse(req.params);

  const drop = await db
    .select()
    .from(dropsTable)
    .where(eq(dropsTable.id, id))
    .limit(1);

  if (drop.length === 0 || drop[0].status !== "published") {
    res.status(404).json({ error: "Drop not found" });
    return;
  }

  const artifacts = await db
    .select()
    .from(artifactsTable)
    .where(eq(artifactsTable.dropId, id));
  // Publishable-status floor — see #9.
  const publishable = artifacts.filter((a) => isPublishableStatus(a.status));

  res.json({
    ...drop[0],
    artifacts: publishable.map(formatArtifact),
    createdAt: drop[0].createdAt.toISOString(),
    publishedAt: drop[0].publishedAt?.toISOString() ?? null,
  });
});

router.get("/storefront/featured", async (req, res) => {
  // Featured is a public hero — must only return publishable artifacts
  // attached to a published drop. The old query merely required a
  // non-null kannakaScore, which silently included scored-but-unpublished
  // artifacts (#3).
  const featured = await db
    .select()
    .from(artifactsTable)
    .where(and(isNotNull(artifactsTable.kannakaScore), publicArtifactWhere()))
    .orderBy(desc(artifactsTable.kannakaScore))
    .limit(6);

  const latestDrop = await db
    .select()
    .from(dropsTable)
    .where(eq(dropsTable.status, "published"))
    .orderBy(desc(dropsTable.publishedAt))
    .limit(1);

  let latestDropWithArtifacts = undefined;
  if (latestDrop.length > 0) {
    const dropArtifacts = await db
      .select()
      .from(artifactsTable)
      .where(eq(artifactsTable.dropId, latestDrop[0].id));
    // Same publishable-status floor as /storefront/drops/:id (#9).
    const publishable = dropArtifacts.filter((a) => isPublishableStatus(a.status));
    latestDropWithArtifacts = {
      ...latestDrop[0],
      artifacts: publishable.map(formatArtifact),
      createdAt: latestDrop[0].createdAt.toISOString(),
      publishedAt: latestDrop[0].publishedAt?.toISOString() ?? null,
    };
  }

  res.json({
    featured: featured.map(formatArtifact),
    latestDrop: latestDropWithArtifacts,
  });
});

export default router;

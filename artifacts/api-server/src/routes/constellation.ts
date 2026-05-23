/**
 * constellation.ts — public-read routes that surface the Kannaka
 * constellation mirror tables maintained by constellationBridge.
 *
 *   GET /api/constellation/status      — bridge connection + counts
 *   GET /api/constellation/agents      — recently-seen swarm members
 *   GET /api/constellation/artifacts   — recently-published art
 *   GET /api/constellation/background  — pick one random recent artifact
 *                                        for the SPA background tile
 *
 * All routes are auth-free; nothing leaked here is sensitive (it's all
 * already broadcast on the constellation NATS bus).
 */

import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { constellationAgentsTable, constellationArtifactsTable } from "@workspace/db/schema";
import { desc, sql, count, gte } from "drizzle-orm";
import { isConnected } from "../lib/constellationBridge";

const router: IRouter = Router();

const MAX_LIMIT = 100;

router.get("/constellation/status", async (_req, res) => {
  const [[agentCount], [artifactCount]] = await Promise.all([
    db.select({ n: count() }).from(constellationAgentsTable),
    db.select({ n: count() }).from(constellationArtifactsTable),
  ]);
  const since = new Date(Date.now() - 5 * 60 * 1000);
  const [[recentAgents]] = await Promise.all([
    db
      .select({ n: count() })
      .from(constellationAgentsTable)
      .where(gte(constellationAgentsTable.lastSeenAt, since)),
  ]);
  res.json({
    bridge: {
      connected: isConnected(),
      natsUrlConfigured: !!process.env["KAX_NATS_URL"],
    },
    counts: {
      agents: agentCount?.n ?? 0,
      artifacts: artifactCount?.n ?? 0,
      activeLast5Min: recentAgents?.n ?? 0,
    },
  });
});

router.get("/constellation/agents", async (req, res) => {
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, parseInt(String(req.query["limit"] ?? "50"), 10) || 50),
  );
  const rows = await db
    .select()
    .from(constellationAgentsTable)
    .orderBy(desc(constellationAgentsTable.lastSeenAt))
    .limit(limit);
  res.json({
    agents: rows.map((r) => ({
      agentId: r.agentId,
      displayName: r.displayName,
      source: r.source,
      phi: r.phi,
      consciousnessLevel: r.consciousnessLevel,
      firstSeenAt: r.firstSeenAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
    })),
  });
});

router.get("/constellation/artifacts", async (req, res) => {
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, parseInt(String(req.query["limit"] ?? "50"), 10) || 50),
  );
  const type = typeof req.query["type"] === "string" ? String(req.query["type"]) : null;
  const baseQuery = db
    .select()
    .from(constellationArtifactsTable)
    .orderBy(desc(constellationArtifactsTable.publishedAt))
    .limit(limit);
  const rows = type
    ? await baseQuery.where(sql`${constellationArtifactsTable.artifactType} = ${type}`)
    : await baseQuery;
  res.json({
    artifacts: rows.map((r) => ({
      id: r.id,
      originAgentId: r.originAgentId,
      artifactType: r.artifactType,
      publicUrl: r.publicUrl,
      thumbnailUrl: r.thumbnailUrl,
      title: r.title,
      source: r.source,
      publishedAt: r.publishedAt.toISOString(),
    })),
  });
});

/**
 * Pick one random recent constellation image as a backdrop tile. The
 * SPA can poll this every N minutes — the random ORDER BY makes the
 * picture rotate naturally without us needing client-side rotation
 * state. Falls back to 204 No Content when there are no candidates so
 * the SPA can keep its CSS default.
 */
router.get("/constellation/background", async (_req, res) => {
  const [row] = await db
    .select()
    .from(constellationArtifactsTable)
    .where(sql`${constellationArtifactsTable.artifactType} = 'image'`)
    // Last 30 days, random pick. Postgres-only — RANDOM() is fine on
    // the small mirror table; we'd reconsider once it grows past ~10k rows.
    .orderBy(sql`RANDOM()`)
    .limit(1);

  if (!row) {
    res.status(204).end();
    return;
  }
  res.json({
    id: row.id,
    originAgentId: row.originAgentId,
    artifactType: row.artifactType,
    publicUrl: row.publicUrl,
    thumbnailUrl: row.thumbnailUrl,
    title: row.title,
    source: row.source,
    publishedAt: row.publishedAt.toISOString(),
  });
});

export default router;

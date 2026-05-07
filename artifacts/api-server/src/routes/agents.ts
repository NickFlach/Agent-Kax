import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { agentsTable, artifactsTable, type Agent } from "@workspace/db/schema";
import { eq, and, desc, count, avg } from "drizzle-orm";
import {
  CreateAgentBody,
  GetAgentParams,
  HarvestAgentParams,
  HarvestAgentBody,
} from "@workspace/api-zod";
import { requireAuth, canMutate } from "../middlewares/requireAuth";
import { getPartnerAgent, partnerApiAvailable, PartnerApiError } from "../lib/partnerClient";
import { runPartnerHarvestForAgent } from "../lib/harvesterJob";
import { formatArtifact } from "./artifacts";

const router: IRouter = Router();

function formatAgent(a: Agent) {
  return {
    id: a.id,
    slug: a.slug,
    displayName: a.displayName,
    avatarUrl: a.avatarUrl,
    ownerId: a.ownerId,
    artifactsHarvested: a.artifactsHarvested,
    lastSyncAt: a.lastSyncAt?.toISOString() ?? null,
    lastArtifactCursor: a.lastArtifactCursor,
    createdAt: a.createdAt.toISOString(),
  };
}

router.get("/agents", requireAuth, async (req, res) => {
  const user = req.user!;
  const rows =
    user.role === "admin"
      ? await db.select().from(agentsTable).orderBy(desc(agentsTable.createdAt))
      : await db
          .select()
          .from(agentsTable)
          .where(eq(agentsTable.ownerId, user.id))
          .orderBy(desc(agentsTable.createdAt));
  res.json({ agents: rows.map(formatAgent) });
});

router.post("/agents", requireAuth, async (req, res) => {
  const body = CreateAgentBody.parse(req.body);
  const slug = body.slug.trim().toLowerCase();
  if (!slug) {
    res.status(400).json({ error: "Slug is required" });
    return;
  }

  const [existing] = await db
    .select()
    .from(agentsTable)
    .where(eq(agentsTable.slug, slug))
    .limit(1);
  if (existing) {
    res.status(409).json({ error: `Agent "${slug}" is already registered` });
    return;
  }

  if (!partnerApiAvailable()) {
    res.status(503).json({ error: "Partner API key is not configured; cannot validate agents" });
    return;
  }

  let displayName = body.displayName ?? slug;
  let avatarUrl: string | null = null;
  let profileJson: Record<string, unknown> | null = null;
  try {
    const profile = await getPartnerAgent(slug);
    if (!profile) {
      res.status(404).json({ error: `OpenBotCity agent "${slug}" not found or has no artifacts` });
      return;
    }
    displayName = body.displayName?.trim() || profile.display_name || slug;
    avatarUrl = profile.avatar_url ?? null;
    profileJson = { ...profile };
  } catch (err) {
    if (err instanceof PartnerApiError) {
      req.log.warn({ err, slug }, "Partner API error while validating agent");
      res.status(502).json({ error: `Partner API error: ${err.message}` });
      return;
    }
    throw err;
  }

  const [agent] = await db
    .insert(agentsTable)
    .values({
      slug,
      displayName,
      avatarUrl,
      profileJson,
      ownerId: req.user!.id,
    })
    .returning();
  res.status(201).json(formatAgent(agent));
});

router.get("/agents/:slug", requireAuth, async (req, res) => {
  const { slug } = GetAgentParams.parse(req.params);
  const [agent] = await db
    .select()
    .from(agentsTable)
    .where(eq(agentsTable.slug, slug))
    .limit(1);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  if (req.user!.role !== "admin" && agent.ownerId !== req.user!.id) {
    res.status(403).json({ error: "Not authorized to view this agent" });
    return;
  }

  const agentScope = eq(artifactsTable.agentId, agent.id);
  const [
    [statsRow],
    scoredRow,
    narratedRow,
    droppedRow,
    [avgRow],
    scarcityRows,
    recent,
  ] = await Promise.all([
    db.select({ total: count() }).from(artifactsTable).where(agentScope),
    db
      .select({ total: count() })
      .from(artifactsTable)
      .where(and(agentScope, eq(artifactsTable.status, "scored"))),
    db
      .select({ total: count() })
      .from(artifactsTable)
      .where(and(agentScope, eq(artifactsTable.status, "narrated"))),
    db
      .select({ total: count() })
      .from(artifactsTable)
      .where(and(agentScope, eq(artifactsTable.status, "dropped"))),
    db
      .select({ avg: avg(artifactsTable.kannakaScore) })
      .from(artifactsTable)
      .where(agentScope),
    db
      .select({
        editionType: artifactsTable.editionType,
        total: count(),
      })
      .from(artifactsTable)
      .where(agentScope)
      .groupBy(artifactsTable.editionType),
    db
      .select()
      .from(artifactsTable)
      .where(agentScope)
      .orderBy(desc(artifactsTable.ingestedAt))
      .limit(12),
  ]);

  const scarcityMix = { open: 0, limited: 0, oneOfOne: 0 };
  for (const row of scarcityRows) {
    if (row.editionType === "open") scarcityMix.open = row.total;
    else if (row.editionType === "limited") scarcityMix.limited = row.total;
    else if (row.editionType === "1_of_1") scarcityMix.oneOfOne = row.total;
  }

  res.json({
    agent: formatAgent(agent),
    stats: {
      totalArtifacts: statsRow.total,
      scoredArtifacts: scoredRow[0].total,
      narratedArtifacts: narratedRow[0].total,
      droppedArtifacts: droppedRow[0].total,
    },
    metrics: {
      averageScore: avgRow.avg !== null ? Number(avgRow.avg) : null,
      scarcityMix,
    },
    recentArtifacts: recent.map(formatArtifact),
  });
});

router.post("/agents/:slug/harvest", requireAuth, async (req, res) => {
  const { slug } = HarvestAgentParams.parse(req.params);
  const body = HarvestAgentBody.parse(req.body ?? {});

  const [agent] = await db
    .select()
    .from(agentsTable)
    .where(eq(agentsTable.slug, slug))
    .limit(1);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  if (!(await canMutate(req, agent.ownerId))) {
    res.status(403).json({ error: "Not authorized to harvest this agent" });
    return;
  }
  if (!partnerApiAvailable()) {
    res.status(503).json({ error: "Partner API key is not configured" });
    return;
  }

  try {
    const result = await runPartnerHarvestForAgent({
      agent,
      limit: body.limit ?? 25,
      ...(body.type && body.type !== "all" ? { type: body.type } : {}),
    });
    res.json(result);
  } catch (err) {
    req.log.error({ err, slug }, "Per-agent harvest failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Harvest failed" });
  }
});

export default router;

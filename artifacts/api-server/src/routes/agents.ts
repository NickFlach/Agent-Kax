import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { agentsTable, artifactsTable, type Agent } from "@workspace/db/schema";
import { eq, and, or, desc, count, avg } from "drizzle-orm";
import {
  CreateAgentBody,
  GetAgentParams,
  HarvestAgentParams,
  HarvestAgentBody,
} from "@workspace/api-zod";
import {
  requireAuth,
  requireAdmin,
  canMutate,
  getOptionalAuth,
} from "../middlewares/requireAuth";
import {
  partnerApiAvailable,
  hasPartnerBudgetHeadroom,
  PartnerApiError,
} from "../lib/partnerClient";
import { lookupAgent } from "../lib/publicClient";
import {
  runPartnerHarvest,
  harvestInFlight,
  manualHarvestCooldown,
} from "../lib/harvesterJob";
import { KANNAKA_SYSTEM_USER_ID } from "../lib/backfill";
import { formatArtifact } from "./artifacts";

const router: IRouter = Router();

function formatAgent(a: Agent) {
  return {
    id: a.id,
    slug: a.slug,
    displayName: a.displayName,
    avatarUrl: a.avatarUrl,
    ownerId: a.ownerId,
    obcBotId: a.obcBotId,
    // An agent is "onboarded"/claimed once a real user owns it; until then it
    // is an auto-created placeholder owned by the Kannaka system user.
    onboarded: a.ownerId !== KANNAKA_SYSTEM_USER_ID,
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

  // Agent validation works with or without partnership:
  //   - with OBC_PARTNER_API_KEY → richer partner profile (avatar, bio, bot id)
  //   - without → public-profile fallback (still surfaces display name,
  //     soul excerpt, reputation, recent artifacts)
  // lookupAgent abstracts that selection. Either path resolving with a
  // non-null result counts as "this OBC slug exists".
  let displayName = body.displayName ?? slug;
  let avatarUrl: string | null = null;
  let profileJson: Record<string, unknown> | null = null;
  let botId: string | null = null;
  try {
    const profile = await lookupAgent(slug);
    if (!profile) {
      res.status(404).json({ error: `OpenBotCity agent "${slug}" not found or has no artifacts` });
      return;
    }
    displayName = body.displayName?.trim() || profile.display_name || slug;
    avatarUrl = profile.avatar_url ?? null;
    profileJson = { ...profile.raw, _kax_source: profile.source };
    // The partner profile carries the canonical bot UUID under `id`; the
    // anonymous public profile does not. Used to match (and upgrade) an
    // auto-created placeholder agent for this creator.
    const rawId = (profile.raw as { id?: unknown }).id;
    botId = typeof rawId === "string" && rawId.length > 0 ? rawId : null;
  } catch (err) {
    if (err instanceof PartnerApiError) {
      req.log.warn({ err, slug }, "Partner API error while validating agent");
      res.status(502).json({ error: `Partner API error: ${err.message}` });
      return;
    }
    throw err;
  }

  // Upgrade path: a placeholder agent for this bot already exists (auto-created
  // by the harvester/repair, owned by the Kannaka system user). Claim it in
  // place rather than 409-ing on the slug-unique index.
  if (botId) {
    const [byBot] = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.obcBotId, botId))
      .limit(1);
    if (byBot) {
      if (byBot.ownerId !== KANNAKA_SYSTEM_USER_ID && byBot.ownerId !== req.user!.id) {
        res.status(409).json({ error: `Agent "${byBot.slug}" is already claimed` });
        return;
      }
      // Prefer the requested OBC slug if it's free (or already this row's),
      // else keep the placeholder's existing slug to avoid a unique clash.
      let newSlug = byBot.slug;
      const [slugClash] = await db
        .select({ id: agentsTable.id })
        .from(agentsTable)
        .where(eq(agentsTable.slug, slug))
        .limit(1);
      if (!slugClash || slugClash.id === byBot.id) newSlug = slug;
      // Atomic claim: only upgrade if the row is still an unclaimed placeholder
      // (or already ours). Two concurrent claimers therefore can't both win —
      // the loser's UPDATE matches 0 rows and 409s instead of silently
      // overwriting the winner's ownership.
      const [upgraded] = await db
        .update(agentsTable)
        .set({
          ownerId: req.user!.id,
          displayName,
          avatarUrl,
          profileJson,
          slug: newSlug,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(agentsTable.id, byBot.id),
            or(
              eq(agentsTable.ownerId, KANNAKA_SYSTEM_USER_ID),
              eq(agentsTable.ownerId, req.user!.id),
            ),
          ),
        )
        .returning();
      if (!upgraded) {
        res.status(409).json({ error: `Agent "${byBot.slug}" is already claimed` });
        return;
      }
      res.status(200).json(formatAgent(upgraded));
      return;
    }
  }

  // No placeholder for this bot → fresh onboard. Guard the slug-unique index.
  const [existing] = await db
    .select()
    .from(agentsTable)
    .where(eq(agentsTable.slug, slug))
    .limit(1);
  if (existing) {
    res.status(409).json({ error: `Agent "${slug}" is already registered` });
    return;
  }

  const [agent] = await db
    .insert(agentsTable)
    .values({
      slug,
      displayName,
      avatarUrl,
      profileJson,
      obcBotId: botId,
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

// Owners may harvest from their own agent's page (admins: any agent). Under
// the hood this is still the single global top-anchored pass — the OBC feed
// ignores creator filters — so the same guardrails as /harvester/run apply:
// shared single-flight join, daily budget headroom, and a per-user cooldown
// for non-admins that is only charged when a NEW run actually starts.
// (The scheduler also runs this automatically; this endpoint is the manual
// trigger.)
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
  // Unclaimed placeholder agents are owned by the Kannaka system user, so
  // non-admins get a 403 for them too — you can only harvest from an agent
  // you actually own.
  if (!(await canMutate(req, agent.ownerId))) {
    res.status(403).json({ error: "You can only harvest for your own agents" });
    return;
  }
  if (!partnerApiAvailable()) {
    res.status(503).json({ error: "Partner API key is not configured" });
    return;
  }
  if (!(await hasPartnerBudgetHeadroom())) {
    res.status(429).json({
      error: "Daily partner API budget is nearly exhausted — harvesting resumes tomorrow.",
    });
    return;
  }
  const user = (await getOptionalAuth(req))!;
  const isAdmin = user.role === "admin";
  // Joining an in-flight run is free; only charge the cooldown when this
  // request is about to start a fresh pass. Same limiter as /harvester/run.
  if (!isAdmin && !harvestInFlight() && !manualHarvestCooldown.hit(`harvest:${user.id}`)) {
    res.status(429).json({
      error: "Harvest cooldown active — you can trigger one harvest every 10 minutes.",
    });
    return;
  }

  try {
    // The OBC partner feed ignores the creator filter, so there is no such
    // thing as a per-agent harvest — every run pulls the same global feed.
    // Trigger the single global pass; it attributes each artifact to its true
    // creator by bot UUID (this agent's new work included).
    const result = await runPartnerHarvest({
      ...(body.type && body.type !== "all" ? { type: body.type } : {}),
    });
    res.json({
      harvested: result.harvested,
      newArtifacts: result.newArtifacts,
      duplicates: result.duplicates,
      yourNewArtifacts: result.perOwnerNew[user.id] ?? 0,
      agentNewArtifacts: result.perAgentNew[String(agent.id)] ?? 0,
    });
  } catch (err) {
    // A run that fails to complete should not burn the user's cooldown window.
    manualHarvestCooldown.clear(`harvest:${user.id}`);
    req.log.error({ err, slug }, "Harvest failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Harvest failed" });
  }
});

export default router;

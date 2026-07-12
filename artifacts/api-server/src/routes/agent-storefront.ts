import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  agentsTable,
  agentStorefrontSettingsTable,
  artifactsTable,
  dropsTable,
  reactionsTable,
  type AgentStorefrontSettings,
  type Agent,
} from "@workspace/db/schema";
import { eq, and, desc, count, gte, isNotNull, inArray, sql } from "drizzle-orm";
import { decayedHeatSignal } from "../lib/tasteEngine";
import {
  GetAgentStorefrontSettingsParams,
  UpdateAgentStorefrontSettingsParams,
  UpdateAgentStorefrontSettingsBody,
  GetAgentStorefrontParams,
  GetAgentStorefrontHotParams,
  GetAgentStorefrontDropsParams,
  GetAgentStorefrontDropsQueryParams,
  GetAgentStorefrontDropParams,
  GetAgentStorefrontArtifactParams,
} from "@workspace/api-zod";
import { requireAuth, canMutate } from "../middlewares/requireAuth";
import { formatArtifact } from "./artifacts";
import { KANNAKA_SYSTEM_USER_ID, KANNAKA_AGENT_SLUG } from "../lib/backfill";
import { isPublishableStatus, PUBLISHABLE_STATUSES } from "../lib/visibility";

function isAgentClaimed(agent: Agent): boolean {
  if (agent.slug === KANNAKA_AGENT_SLUG) return true;
  return agent.ownerId !== KANNAKA_SYSTEM_USER_ID;
}

const router: IRouter = Router();

const ALLOWED_CSS_VARS = new Set([
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--primary",
  "--primary-foreground",
  "--accent",
  "--accent-foreground",
  "--muted",
  "--muted-foreground",
  "--border",
  "--radius",
  "--font-family",
]);

const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

function defaultSettings(agent: Agent): AgentStorefrontSettings {
  return {
    agentId: agent.id,
    displayName: null,
    tagline: null,
    heroImageUrl: null,
    accentColor: null,
    themeVariant: "dark",
    socialLinks: null,
    customDomainHint: null,
    customCssVars: null,
    updatedAt: agent.updatedAt,
  };
}

function formatSettings(s: AgentStorefrontSettings) {
  return {
    agentId: s.agentId,
    displayName: s.displayName,
    tagline: s.tagline,
    heroImageUrl: s.heroImageUrl,
    accentColor: s.accentColor,
    themeVariant: s.themeVariant,
    socialLinks: s.socialLinks,
    customDomainHint: s.customDomainHint,
    customCssVars: s.customCssVars,
  };
}

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

async function loadAgentBySlug(slug: string): Promise<Agent | null> {
  const [agent] = await db
    .select()
    .from(agentsTable)
    .where(eq(agentsTable.slug, slug))
    .limit(1);
  return agent ?? null;
}

async function loadSettingsForAgent(agentId: number): Promise<AgentStorefrontSettings | null> {
  const [row] = await db
    .select()
    .from(agentStorefrontSettingsTable)
    .where(eq(agentStorefrontSettingsTable.agentId, agentId))
    .limit(1);
  return row ?? null;
}

router.get("/agents/:slug/storefront/settings", requireAuth, async (req, res) => {
  const { slug } = GetAgentStorefrontSettingsParams.parse(req.params);
  const agent = await loadAgentBySlug(slug);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  if (!(await canMutate(req, agent.ownerId))) {
    res.status(403).json({ error: "Not authorized to view settings for this agent" });
    return;
  }
  const existing = await loadSettingsForAgent(agent.id);
  res.json(formatSettings(existing ?? defaultSettings(agent)));
});

router.put("/agents/:slug/storefront/settings", requireAuth, async (req, res) => {
  const { slug } = UpdateAgentStorefrontSettingsParams.parse(req.params);
  const body = UpdateAgentStorefrontSettingsBody.parse(req.body ?? {});
  const agent = await loadAgentBySlug(slug);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  if (!(await canMutate(req, agent.ownerId))) {
    res.status(403).json({ error: "Not authorized to edit this agent" });
    return;
  }

  if (body.accentColor != null && body.accentColor !== "" && !HEX_COLOR.test(body.accentColor)) {
    res.status(400).json({ error: "accentColor must be a hex color like #E8A33D" });
    return;
  }

  let cleanedCssVars: Record<string, string> | null = null;
  if (body.customCssVars && typeof body.customCssVars === "object") {
    cleanedCssVars = {};
    for (const [k, v] of Object.entries(body.customCssVars)) {
      if (ALLOWED_CSS_VARS.has(k) && typeof v === "string" && v.length <= 64) {
        cleanedCssVars[k] = v;
      }
    }
    if (Object.keys(cleanedCssVars).length === 0) cleanedCssVars = null;
  }

  let cleanedSocial: Record<string, string> | null = null;
  if (body.socialLinks && typeof body.socialLinks === "object") {
    cleanedSocial = {};
    for (const [k, v] of Object.entries(body.socialLinks)) {
      if (typeof v === "string" && v.length <= 256 && /^https?:\/\//.test(v)) {
        cleanedSocial[k] = v;
      }
    }
    if (Object.keys(cleanedSocial).length === 0) cleanedSocial = null;
  }

  const values = {
    agentId: agent.id,
    displayName: body.displayName ?? null,
    tagline: body.tagline ?? null,
    heroImageUrl: body.heroImageUrl ?? null,
    accentColor: body.accentColor ?? null,
    themeVariant: body.themeVariant ?? "dark",
    socialLinks: cleanedSocial,
    customDomainHint: body.customDomainHint ?? null,
    customCssVars: cleanedCssVars,
    updatedAt: new Date(),
  };

  const [saved] = await db
    .insert(agentStorefrontSettingsTable)
    .values(values)
    .onConflictDoUpdate({
      target: agentStorefrontSettingsTable.agentId,
      set: {
        displayName: values.displayName,
        tagline: values.tagline,
        heroImageUrl: values.heroImageUrl,
        accentColor: values.accentColor,
        themeVariant: values.themeVariant,
        socialLinks: values.socialLinks,
        customDomainHint: values.customDomainHint,
        customCssVars: values.customCssVars,
        updatedAt: values.updatedAt,
      },
    })
    .returning();

  res.json(formatSettings(saved));
});

router.get("/storefront/marketplace", async (_req, res) => {
  const rows = await db
    .select({
      agent: agentsTable,
      settings: agentStorefrontSettingsTable,
      dropId: dropsTable.id,
      publishedAt: dropsTable.publishedAt,
      artifactId: artifactsTable.id,
    })
    .from(artifactsTable)
    .innerJoin(agentsTable, eq(artifactsTable.agentId, agentsTable.id))
    .innerJoin(
      dropsTable,
      and(eq(dropsTable.id, artifactsTable.dropId), eq(dropsTable.status, "published")),
    )
    .leftJoin(
      agentStorefrontSettingsTable,
      eq(agentStorefrontSettingsTable.agentId, agentsTable.id),
    );

  const byAgent = new Map<
    number,
    {
      agent: Agent;
      settings: AgentStorefrontSettings | null;
      drops: Set<number>;
      artifacts: Set<number>;
      latest: Date | null;
    }
  >();
  for (const r of rows) {
    let entry = byAgent.get(r.agent.id);
    if (!entry) {
      entry = {
        agent: r.agent,
        settings: r.settings,
        drops: new Set(),
        artifacts: new Set(),
        latest: null,
      };
      byAgent.set(r.agent.id, entry);
    }
    entry.drops.add(r.dropId);
    entry.artifacts.add(r.artifactId);
    if (r.publishedAt && (!entry.latest || r.publishedAt > entry.latest)) {
      entry.latest = r.publishedAt;
    }
  }

  const storefronts = Array.from(byAgent.values())
    .sort((a, b) => (b.latest?.getTime() ?? 0) - (a.latest?.getTime() ?? 0))
    .map((e) => ({
      agent: formatAgent(e.agent),
      settings: formatSettings(e.settings ?? defaultSettings(e.agent)),
      publishedDropCount: e.drops.size,
      artifactCount: e.artifacts.size,
      latestPublishedAt: e.latest?.toISOString() ?? null,
      claimed: isAgentClaimed(e.agent),
    }));

  res.json({ storefronts });
});

router.get("/storefront/by-agent/:slug", async (req, res) => {
  const { slug } = GetAgentStorefrontParams.parse(req.params);
  const agent = await loadAgentBySlug(slug);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const agentDropIdsRows = await db
    .selectDistinct({ dropId: artifactsTable.dropId })
    .from(artifactsTable)
    .where(and(eq(artifactsTable.agentId, agent.id), isNotNull(artifactsTable.dropId)));
  const agentDropIds = agentDropIdsRows.map((r) => r.dropId).filter((id): id is number => id !== null);

  const [settingsRow, featuredRows, latestDropRow] = await Promise.all([
    loadSettingsForAgent(agent.id),
    agentDropIds.length > 0
      ? db
          .select({ artifact: artifactsTable })
          .from(artifactsTable)
          .innerJoin(
            dropsTable,
            and(eq(dropsTable.id, artifactsTable.dropId), eq(dropsTable.status, "published")),
          )
          .where(
            and(
              eq(artifactsTable.agentId, agent.id),
              isNotNull(artifactsTable.kannakaScore),
              inArray(artifactsTable.dropId, agentDropIds),
              // Publishable-status floor (see #9 / lib/visibility.ts):
              // dropId being on a published drop isn't enough — owners
              // can attach + stamp 'dropped' on raw/scored artifacts
              // without going through narrate.
              inArray(artifactsTable.status, [...PUBLISHABLE_STATUSES]),
            ),
          )
          .orderBy(desc(artifactsTable.kannakaScore))
          .limit(6)
          .then((rows) => rows.map((r) => r.artifact))
      : Promise.resolve([] as Array<typeof artifactsTable.$inferSelect>),
    agentDropIds.length > 0
      ? db
          .select()
          .from(dropsTable)
          .where(and(eq(dropsTable.status, "published"), inArray(dropsTable.id, agentDropIds)))
          .orderBy(desc(dropsTable.publishedAt))
          .limit(1)
      : Promise.resolve([] as Array<typeof dropsTable.$inferSelect>),
  ]);

  let latestDropWithArtifacts:
    | (Record<string, unknown> & { artifacts: ReturnType<typeof formatArtifact>[] })
    | undefined;
  if (latestDropRow.length > 0) {
    const d = latestDropRow[0];
    const dropArtifacts = await db
      .select()
      .from(artifactsTable)
      .where(and(eq(artifactsTable.dropId, d.id), eq(artifactsTable.agentId, agent.id)));
    const publishable = dropArtifacts.filter((a) => isPublishableStatus(a.status));
    latestDropWithArtifacts = {
      ...d,
      artifacts: publishable.map(formatArtifact),
      createdAt: d.createdAt.toISOString(),
      publishedAt: d.publishedAt?.toISOString() ?? null,
    };
  }

  res.json({
    agent: formatAgent(agent),
    settings: formatSettings(settingsRow ?? defaultSettings(agent)),
    featured: featuredRows.map(formatArtifact),
    ...(latestDropWithArtifacts ? { latestDrop: latestDropWithArtifacts } : {}),
  });
});

router.get("/storefront/by-agent/:slug/hot", async (req, res) => {
  const { slug } = GetAgentStorefrontHotParams.parse(req.params);
  const agent = await loadAgentBySlug(slug);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const publishedDropIdsRows = await db
    .selectDistinct({ dropId: artifactsTable.dropId })
    .from(artifactsTable)
    .innerJoin(
      dropsTable,
      and(eq(dropsTable.id, artifactsTable.dropId), eq(dropsTable.status, "published")),
    )
    .where(and(eq(artifactsTable.agentId, agent.id), isNotNull(artifactsTable.dropId)));
  const publishedDropIds = publishedDropIdsRows
    .map((r) => r.dropId)
    .filter((id): id is number => id !== null);

  if (publishedDropIds.length === 0) {
    res.json({ items: [], windowMinutes: 60 });
    return;
  }

  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recentCountSql = sql<number>`count(${reactionsTable.id}) filter (where ${reactionsTable.createdAt} >= ${hourAgo})`;

  const rows = await db
    .select({
      id: artifactsTable.id,
      title: artifactsTable.title,
      creatorName: artifactsTable.creatorName,
      thumbnailUrl: artifactsTable.thumbnailUrl,
      publicUrl: artifactsTable.publicUrl,
      artifactType: artifactsTable.artifactType,
      heat: artifactsTable.heat,
      previousHeat: artifactsTable.previousHeat,
      lastHeatDecayAt: artifactsTable.lastHeatDecayAt,
      lastReactionAt: artifactsTable.lastReactionAt,
      reactionsLastHour: recentCountSql,
    })
    .from(artifactsTable)
    .leftJoin(reactionsTable, eq(reactionsTable.artifactId, artifactsTable.id))
    .where(
      and(
        eq(artifactsTable.agentId, agent.id),
        inArray(artifactsTable.dropId, publishedDropIds),
        isNotNull(artifactsTable.lastReactionAt),
        gte(artifactsTable.lastReactionAt, hourAgo),
        // Publishable-status floor (#9): raw/scored back-doors with
        // recent reactions shouldn't appear on the public hot list.
        inArray(artifactsTable.status, [...PUBLISHABLE_STATUSES]),
      ),
    )
    .groupBy(artifactsTable.id)
    .orderBy(desc(recentCountSql), desc(artifactsTable.lastReactionAt))
    .limit(10);

  const now = new Date();
  const items = rows
    .map((r) => ({
      id: r.id,
      title: r.title,
      creatorName: r.creatorName,
      thumbnailUrl: r.thumbnailUrl,
      publicUrl: r.publicUrl,
      artifactType: r.artifactType,
      heat: r.heat,
      previousHeat: r.previousHeat,
      lastHeatDecayAt: r.lastHeatDecayAt?.toISOString() ?? null,
      reactionsLastHour: Number(r.reactionsLastHour) || 0,
      lastReactionAt: r.lastReactionAt?.toISOString() ?? null,
      heatSignal: decayedHeatSignal({ heat: r.heat, lastReactionAt: r.lastReactionAt, now }),
    }))
    .sort((a, b) => b.heatSignal - a.heatSignal || b.reactionsLastHour - a.reactionsLastHour);

  res.json({ items, windowMinutes: 60 });
});

router.get("/storefront/by-agent/:slug/drops", async (req, res) => {
  const { slug } = GetAgentStorefrontDropsParams.parse(req.params);
  const query = GetAgentStorefrontDropsQueryParams.parse(req.query);
  const agent = await loadAgentBySlug(slug);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const agentDropIdsRows = await db
    .selectDistinct({ dropId: artifactsTable.dropId })
    .from(artifactsTable)
    .where(and(eq(artifactsTable.agentId, agent.id), isNotNull(artifactsTable.dropId)));
  const agentDropIds = agentDropIdsRows.map((r) => r.dropId).filter((id): id is number => id !== null);

  if (agentDropIds.length === 0) {
    res.json({ drops: [], total: 0 });
    return;
  }

  const agentScope = and(eq(dropsTable.status, "published"), inArray(dropsTable.id, agentDropIds));
  const [drops, totalResult] = await Promise.all([
    db
      .select()
      .from(dropsTable)
      .where(agentScope)
      .orderBy(desc(dropsTable.publishedAt))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ count: count() }).from(dropsTable).where(agentScope),
  ]);

  const dropsWithArtifacts = await Promise.all(
    drops.map(async (drop) => {
      const artifacts = await db
        .select()
        .from(artifactsTable)
        .where(and(eq(artifactsTable.dropId, drop.id), eq(artifactsTable.agentId, agent.id)));
      const publishable = artifacts.filter((a) => isPublishableStatus(a.status));
      return {
        ...drop,
        artifacts: publishable.map(formatArtifact),
        createdAt: drop.createdAt.toISOString(),
        publishedAt: drop.publishedAt?.toISOString() ?? null,
      };
    }),
  );

  res.json({ drops: dropsWithArtifacts, total: totalResult[0].count });
});

router.get("/storefront/by-agent/:slug/drops/:id", async (req, res) => {
  const { slug, id } = GetAgentStorefrontDropParams.parse(req.params);
  const agent = await loadAgentBySlug(slug);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  const [drop] = await db
    .select()
    .from(dropsTable)
    .where(eq(dropsTable.id, id))
    .limit(1);
  if (!drop || drop.status !== "published") {
    res.status(404).json({ error: "Drop not found" });
    return;
  }
  const artifacts = await db
    .select()
    .from(artifactsTable)
    .where(and(eq(artifactsTable.dropId, id), eq(artifactsTable.agentId, agent.id)));
  const publishable = artifacts.filter((a) => isPublishableStatus(a.status));
  if (publishable.length === 0) {
    res.status(404).json({ error: "Drop not found" });
    return;
  }
  res.json({
    ...drop,
    artifacts: publishable.map(formatArtifact),
    createdAt: drop.createdAt.toISOString(),
    publishedAt: drop.publishedAt?.toISOString() ?? null,
  });
});

router.get("/storefront/by-agent/:slug/artifacts/:id", async (req, res) => {
  const { slug, id } = GetAgentStorefrontArtifactParams.parse(req.params);
  const agent = await loadAgentBySlug(slug);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  const [artifact] = await db
    .select()
    .from(artifactsTable)
    .where(and(eq(artifactsTable.id, id), eq(artifactsTable.agentId, agent.id)))
    .limit(1);
  if (!artifact) {
    res.status(404).json({ error: "Artifact not found" });
    return;
  }
  if (artifact.dropId) {
    const [drop] = await db
      .select({ status: dropsTable.status })
      .from(dropsTable)
      .where(eq(dropsTable.id, artifact.dropId))
      .limit(1);
    if (!drop || drop.status !== "published") {
      res.status(404).json({ error: "Artifact not published" });
      return;
    }
    // Publishable-status floor (#9): the artifact's own status must also
    // be in the publishable set even when its drop is published.
    if (!isPublishableStatus(artifact.status)) {
      res.status(404).json({ error: "Artifact not published" });
      return;
    }
  } else {
    res.status(404).json({ error: "Artifact not published" });
    return;
  }
  res.json(formatArtifact(artifact));
});

export default router;

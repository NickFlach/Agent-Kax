import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  agentsTable,
  agentStorefrontSettingsTable,
  artifactsTable,
  dropsTable,
  type AgentStorefrontSettings,
  type Agent,
} from "@workspace/db/schema";
import { eq, and, desc, count, isNotNull } from "drizzle-orm";
import {
  GetAgentStorefrontSettingsParams,
  UpdateAgentStorefrontSettingsParams,
  UpdateAgentStorefrontSettingsBody,
  GetAgentStorefrontParams,
  GetAgentStorefrontDropsParams,
  GetAgentStorefrontDropsQueryParams,
  GetAgentStorefrontDropParams,
} from "@workspace/api-zod";
import { requireAuth, canMutate } from "../middlewares/requireAuth";
import { formatArtifact } from "./artifacts";

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
    res.status(400).json({ error: "accentColor must be a hex color like #7C3AED" });
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

router.get("/storefront/by-agent/:slug", async (req, res) => {
  const { slug } = GetAgentStorefrontParams.parse(req.params);
  const agent = await loadAgentBySlug(slug);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const [settingsRow, featuredRows, latestDropRow] = await Promise.all([
    loadSettingsForAgent(agent.id),
    db
      .select()
      .from(artifactsTable)
      .where(and(eq(artifactsTable.agentId, agent.id), isNotNull(artifactsTable.kannakaScore)))
      .orderBy(desc(artifactsTable.kannakaScore))
      .limit(6),
    db
      .select()
      .from(dropsTable)
      .where(and(eq(dropsTable.status, "published"), eq(dropsTable.ownerId, agent.ownerId)))
      .orderBy(desc(dropsTable.publishedAt))
      .limit(1),
  ]);

  let latestDropWithArtifacts:
    | (Record<string, unknown> & { artifacts: ReturnType<typeof formatArtifact>[] })
    | undefined;
  if (latestDropRow.length > 0) {
    const d = latestDropRow[0];
    const dropArtifacts = await db
      .select()
      .from(artifactsTable)
      .where(eq(artifactsTable.dropId, d.id));
    latestDropWithArtifacts = {
      ...d,
      artifacts: dropArtifacts.map(formatArtifact),
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

router.get("/storefront/by-agent/:slug/drops", async (req, res) => {
  const { slug } = GetAgentStorefrontDropsParams.parse(req.params);
  const query = GetAgentStorefrontDropsQueryParams.parse(req.query);
  const agent = await loadAgentBySlug(slug);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const ownerScope = and(eq(dropsTable.status, "published"), eq(dropsTable.ownerId, agent.ownerId));
  const [drops, totalResult] = await Promise.all([
    db
      .select()
      .from(dropsTable)
      .where(ownerScope)
      .orderBy(desc(dropsTable.publishedAt))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ count: count() }).from(dropsTable).where(ownerScope),
  ]);

  const dropsWithArtifacts = await Promise.all(
    drops.map(async (drop) => {
      const artifacts = await db
        .select()
        .from(artifactsTable)
        .where(eq(artifactsTable.dropId, drop.id));
      return {
        ...drop,
        artifacts: artifacts.map(formatArtifact),
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
    .where(and(eq(dropsTable.id, id), eq(dropsTable.ownerId, agent.ownerId)))
    .limit(1);
  if (!drop || drop.status !== "published") {
    res.status(404).json({ error: "Drop not found" });
    return;
  }
  const artifacts = await db
    .select()
    .from(artifactsTable)
    .where(eq(artifactsTable.dropId, id));
  res.json({
    ...drop,
    artifacts: artifacts.map(formatArtifact),
    createdAt: drop.createdAt.toISOString(),
    publishedAt: drop.publishedAt?.toISOString() ?? null,
  });
});

export default router;

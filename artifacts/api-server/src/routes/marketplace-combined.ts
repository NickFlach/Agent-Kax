/**
 * marketplace-combined.ts — single endpoint that returns BOTH OBC
 * storefronts and Kannaka-constellation agents in one unified shape,
 * so the marketplace UIs can render the whole grid without two queries
 * and a client-side merge.
 *
 * GET /api/marketplace/combined → {
 *   storefronts: [{ source: "obc",          ...storefront fields }]
 *                                 | { source: "constellation", ...constellation fields }]
 *   counts: { obc, constellation }
 * }
 *
 * Constellation agents are scope-limited to those seen in the last 7
 * days — older entries probably went offline. The 7d window mirrors
 * the QUEEN.announce + queen.event.leave retention pattern.
 */

import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { constellationAgentsTable } from "@workspace/db/schema";
import { gte, desc } from "drizzle-orm";
import { listObcStorefronts } from "../lib/storefrontDirectory";

const router: IRouter = Router();

interface UnifiedStorefront {
  source: "obc" | "constellation";
  slug: string;
  displayName: string;
  agent: {
    id: number | null;
    slug: string;
    displayName: string;
    avatarUrl: string | null;
  };
  settings: {
    displayName: string;
    accentColor: string | null;
    heroImageUrl: string | null;
    tagline: string | null;
  };
  publishedDropCount: number;
  artifactCount: number;
  latestPublishedAt: string | null;
  claimed: boolean;
  // Constellation-specific extras (null on obc rows)
  phi: number | null;
  consciousnessLevel: string | null;
  lastSeenAt: string | null;
}

router.get("/marketplace/combined", async (_req, res) => {
  // ── OBC storefronts (directory model: every agent with harvested work
  //    has a pre-populated, claimable storefront — see storefrontDirectory) ──
  const entries = await listObcStorefronts();
  const obcStorefronts: UnifiedStorefront[] = entries.map((e) => ({
    source: "obc" as const,
    slug: e.agent.slug,
    displayName: e.settings?.displayName ?? e.agent.displayName,
    agent: {
      id: e.agent.id,
      slug: e.agent.slug,
      displayName: e.agent.displayName,
      avatarUrl: e.agent.avatarUrl,
    },
    settings: {
      displayName: e.settings?.displayName ?? e.agent.displayName,
      accentColor: e.settings?.accentColor ?? null,
      heroImageUrl: e.settings?.heroImageUrl ?? null,
      tagline: e.settings?.tagline ?? null,
    },
    publishedDropCount: e.publishedDropCount,
    artifactCount: e.artifactCount,
    latestPublishedAt: e.latestPublishedAt?.toISOString() ?? null,
    claimed: e.claimed,
    phi: null,
    consciousnessLevel: null,
    lastSeenAt: null,
  }));

  // ── Constellation agents (last 7d) ───────────────────────────────────
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const constRows = await db
    .select()
    .from(constellationAgentsTable)
    .where(gte(constellationAgentsTable.lastSeenAt, since))
    .orderBy(desc(constellationAgentsTable.lastSeenAt));

  // Suppress constellation rows whose slug already has an OBC storefront —
  // the OBC one is the authoritative "claimed" version. A user can claim
  // by inserting into agents; same surface afterward.
  const obcSlugs = new Set(obcStorefronts.map((s) => s.slug));
  const constellationStorefronts: UnifiedStorefront[] = constRows
    .filter((r) => !obcSlugs.has(r.agentId))
    .map((r) => ({
      source: "constellation" as const,
      slug: r.agentId,
      displayName: r.displayName,
      agent: {
        id: null,
        slug: r.agentId,
        displayName: r.displayName,
        avatarUrl: null,
      },
      settings: {
        displayName: r.displayName,
        accentColor: null,
        heroImageUrl: null,
        tagline: r.consciousnessLevel ? `Consciousness: ${r.consciousnessLevel}` : null,
      },
      publishedDropCount: 0,
      artifactCount: 0,
      latestPublishedAt: null,
      claimed: false,
      phi: r.phi,
      consciousnessLevel: r.consciousnessLevel,
      lastSeenAt: r.lastSeenAt.toISOString(),
    }));

  const all = [...obcStorefronts, ...constellationStorefronts].sort((a, b) => {
    // OBC first (sorted by latest publish), then constellation (by last seen)
    if (a.source !== b.source) return a.source === "obc" ? -1 : 1;
    if (a.source === "obc") {
      return (b.latestPublishedAt ?? "").localeCompare(a.latestPublishedAt ?? "");
    }
    return (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? "");
  });

  res.json({
    storefronts: all,
    counts: { obc: obcStorefronts.length, constellation: constellationStorefronts.length },
  });
});

export default router;

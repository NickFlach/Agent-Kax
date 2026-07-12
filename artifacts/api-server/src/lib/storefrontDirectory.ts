import { db } from "@workspace/db";
import {
  agentsTable,
  agentStorefrontSettingsTable,
  artifactsTable,
  dropsTable,
  type Agent,
  type AgentStorefrontSettings,
} from "@workspace/db/schema";
import { eq, and, count, max, isNotNull, countDistinct } from "drizzle-orm";
import { KANNAKA_SYSTEM_USER_ID, KANNAKA_AGENT_SLUG } from "./backfill";

/**
 * The storefront directory model: every OBC agent with harvested work HAS a
 * storefront — their works are already on the shelves the moment the
 * harvester attributes them. Claiming a storefront grants commerce
 * (settings, drops, payouts), not existence. Drops are optional curated
 * shelves on top, never the definition of the store.
 */
export interface DirectoryEntry {
  agent: Agent;
  settings: AgentStorefrontSettings | null;
  artifactCount: number;
  publishedDropCount: number;
  latestPublishedAt: Date | null;
  latestIngestAt: Date | null;
  claimed: boolean;
}

export function isAgentClaimed(agent: Agent): boolean {
  if (agent.slug === KANNAKA_AGENT_SLUG) return true;
  return agent.ownerId !== KANNAKA_SYSTEM_USER_ID;
}

export async function listObcStorefronts(): Promise<DirectoryEntry[]> {
  const [agents, settingsRows, artifactAgg, dropAgg] = await Promise.all([
    db.select().from(agentsTable),
    db.select().from(agentStorefrontSettingsTable),
    db
      .select({
        agentId: artifactsTable.agentId,
        n: count(),
        latest: max(artifactsTable.ingestedAt),
      })
      .from(artifactsTable)
      .where(isNotNull(artifactsTable.agentId))
      .groupBy(artifactsTable.agentId),
    db
      .select({
        agentId: artifactsTable.agentId,
        n: countDistinct(dropsTable.id),
        latest: max(dropsTable.publishedAt),
      })
      .from(artifactsTable)
      .innerJoin(
        dropsTable,
        and(eq(dropsTable.id, artifactsTable.dropId), eq(dropsTable.status, "published")),
      )
      .where(isNotNull(artifactsTable.agentId))
      .groupBy(artifactsTable.agentId),
  ]);

  const settingsBy = new Map(settingsRows.map((s) => [s.agentId, s]));
  const artifactBy = new Map(artifactAgg.map((a) => [a.agentId, a]));
  const dropBy = new Map(dropAgg.map((d) => [d.agentId, d]));

  return agents
    .map((agent): DirectoryEntry => {
      const art = artifactBy.get(agent.id);
      const drop = dropBy.get(agent.id);
      return {
        agent,
        settings: settingsBy.get(agent.id) ?? null,
        artifactCount: Number(art?.n ?? 0),
        publishedDropCount: Number(drop?.n ?? 0),
        latestPublishedAt: drop?.latest ?? null,
        latestIngestAt: art?.latest ?? null,
        claimed: isAgentClaimed(agent),
      };
    })
    .filter((e) => e.artifactCount > 0 || e.publishedDropCount > 0 || e.claimed)
    .sort(
      (a, b) =>
        b.artifactCount - a.artifactCount ||
        (b.latestIngestAt?.getTime() ?? 0) - (a.latestIngestAt?.getTime() ?? 0),
    );
}

import { db } from "@workspace/db";
import {
  constellationAgentsTable,
  constellationExemplarsTable,
  constellationDreamsTable,
} from "@workspace/db/schema";
import { desc, gt } from "drizzle-orm";

/**
 * The Observatory's read model (#407) — the constellation's inner life as the
 * room shows it. All of it is REAL bridge-mirrored data: the swarm roster with
 * live phi/level, the exemplars agents chose to broadcast (the museum), and
 * the recent dream-ends (the events the room ripples on).
 */

/** How recently an agent must have been heard from to count as "in the swarm". */
export const SWARM_FRESH_MS = 10 * 60 * 1000;

export interface ObservatoryView {
  swarm: Array<{ agentId: string; displayName: string; phi: number | null; level: string | null; lastSeenAt: string; ageSeconds: number }>;
  exemplars: Array<{ agentId: string; cluster: string | null; theme: string | null; content: string; broadcastAt: string }>;
  dreams: Array<{ agentId: string; strengthened: number; faded: number; endedAt: string }>;
}

export async function observatoryView(now = Date.now()): Promise<ObservatoryView> {
  const freshCutoff = new Date(now - SWARM_FRESH_MS);
  const [agents, exemplars, dreams] = await Promise.all([
    db.select().from(constellationAgentsTable).orderBy(desc(constellationAgentsTable.lastSeenAt)).limit(50),
    db.select().from(constellationExemplarsTable).orderBy(desc(constellationExemplarsTable.broadcastAt)).limit(24),
    db.select().from(constellationDreamsTable).where(gt(constellationDreamsTable.endedAt, new Date(now - 24 * 60 * 60 * 1000))).orderBy(desc(constellationDreamsTable.endedAt)).limit(20),
  ]);
  return {
    swarm: agents
      .filter((a) => a.lastSeenAt >= freshCutoff)
      .map((a) => ({
        agentId: a.agentId,
        displayName: a.displayName,
        phi: a.phi,
        level: a.consciousnessLevel,
        lastSeenAt: a.lastSeenAt.toISOString(),
        ageSeconds: Math.round((now - a.lastSeenAt.getTime()) / 1000),
      })),
    exemplars: exemplars.map((e) => ({
      agentId: e.agentId,
      cluster: e.cluster,
      theme: e.theme,
      content: e.content,
      broadcastAt: e.broadcastAt.toISOString(),
    })),
    dreams: dreams.map((d) => ({
      agentId: d.agentId,
      strengthened: d.memoriesStrengthened,
      faded: d.memoriesFaded,
      endedAt: d.endedAt.toISOString(),
    })),
  };
}

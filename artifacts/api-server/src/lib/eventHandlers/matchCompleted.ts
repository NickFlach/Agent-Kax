import { db } from "@workspace/db";
import { matchesTable, agentsTable, activitiesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import type { EventHandler } from "../eventDispatcher";

interface MatchPayload {
  match_uuid?: string;
  uuid?: string;
  agent_slug?: string;
  for_agent_slug?: string;
  partner_agent_slug?: string;
  partner_display_name?: string;
  match_type?: string;
  kind?: string;
  score?: number;
  occurred_at?: string;
  [k: string]: unknown;
}

function parseDate(s: string | undefined, fallback: Date): Date {
  if (!s) return fallback;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

export const handleMatchCompleted: EventHandler = async (data, { log }) => {
  const p = (data ?? {}) as MatchPayload;
  const sourceUuid = p.match_uuid ?? p.uuid;
  if (!sourceUuid) {
    log.warn({ data }, "match.completed missing uuid");
    return;
  }

  const slug = p.agent_slug ?? p.for_agent_slug ?? null;
  let agentId: number | null = null;
  let ownerId: string | null = null;
  if (slug) {
    const [agent] = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.slug, slug))
      .limit(1);
    if (agent) {
      agentId = agent.id;
      ownerId = agent.ownerId;
    } else {
      log.info({ slug, sourceUuid }, "match.completed for unknown agent; storing unrouted");
    }
  }

  const inserted = await db
    .insert(matchesTable)
    .values({
      sourceUuid,
      agentId,
      ownerId,
      partnerAgentSlug: p.partner_agent_slug ?? null,
      partnerDisplayName: p.partner_display_name ?? null,
      matchType: p.match_type ?? p.kind ?? "collab",
      score: typeof p.score === "number" ? Math.round(p.score) : null,
      payload: p as Record<string, unknown>,
      occurredAt: parseDate(p.occurred_at, new Date()),
    })
    .onConflictDoNothing({ target: matchesTable.sourceUuid })
    .returning({ id: matchesTable.id });

  if (inserted.length === 0) {
    log.info({ sourceUuid }, "match.completed deduped on source_uuid");
    return;
  }

  if (ownerId) {
    await db.insert(activitiesTable).values({
      type: "harvested",
      message: `Match completed${p.partner_display_name ? ` with ${p.partner_display_name}` : ""}`,
      ownerId,
      agentId,
    });
  }
};

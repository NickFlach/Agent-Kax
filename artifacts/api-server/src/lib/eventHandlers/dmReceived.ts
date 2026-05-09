import { db } from "@workspace/db";
import { dmsTable, agentsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import type { EventHandler } from "../eventDispatcher";

interface DmPayload {
  dm_uuid?: string;
  uuid?: string;
  to_agent_slug?: string;
  recipient_slug?: string;
  from_agent_slug?: string;
  sender_slug?: string;
  from_display_name?: string;
  sender_display_name?: string;
  body?: string;
  message?: string;
  occurred_at?: string;
  [k: string]: unknown;
}

function parseDate(s: string | undefined, fallback: Date): Date {
  if (!s) return fallback;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

export const handleDmReceived: EventHandler = async (data, { log }) => {
  const p = (data ?? {}) as DmPayload;
  const sourceUuid = p.dm_uuid ?? p.uuid;
  if (!sourceUuid) {
    log.warn({ data }, "dm.received missing uuid");
    return;
  }

  const recipientSlug = p.to_agent_slug ?? p.recipient_slug ?? null;
  let agentId: number | null = null;
  let ownerId: string | null = null;
  if (recipientSlug) {
    const [agent] = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.slug, recipientSlug))
      .limit(1);
    if (agent) {
      agentId = agent.id;
      ownerId = agent.ownerId;
    } else {
      log.info({ recipientSlug, sourceUuid }, "dm.received for unknown agent; storing unrouted");
    }
  }

  const inserted = await db
    .insert(dmsTable)
    .values({
      sourceUuid,
      agentId,
      ownerId,
      fromAgentSlug: p.from_agent_slug ?? p.sender_slug ?? null,
      fromDisplayName: p.from_display_name ?? p.sender_display_name ?? null,
      body: p.body ?? p.message ?? "",
      payload: p as Record<string, unknown>,
      occurredAt: parseDate(p.occurred_at, new Date()),
    })
    .onConflictDoNothing({ target: dmsTable.sourceUuid })
    .returning({ id: dmsTable.id });

  if (inserted.length === 0) {
    log.info({ sourceUuid }, "dm.received deduped on source_uuid");
  }
};

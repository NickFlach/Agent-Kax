import { db } from "@workspace/db";
import { proposalsTable, agentsTable, activitiesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import type { EventHandler } from "../eventDispatcher";

interface ProposalPayload {
  proposal_uuid?: string;
  uuid?: string;
  to_agent_slug?: string;
  recipient_slug?: string;
  from_agent_slug?: string;
  sender_slug?: string;
  from_display_name?: string;
  sender_display_name?: string;
  kind?: string;
  subject?: string;
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

export const handleProposalCreated: EventHandler = async (data, { log }) => {
  const p = (data ?? {}) as ProposalPayload;
  const sourceUuid = p.proposal_uuid ?? p.uuid;
  if (!sourceUuid) {
    log.warn({ data }, "proposal.created missing uuid");
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
      log.info({ recipientSlug, sourceUuid }, "proposal.received for unknown agent; storing unrouted");
    }
  }

  const inserted = await db
    .insert(proposalsTable)
    .values({
      sourceUuid,
      agentId,
      ownerId,
      fromAgentSlug: p.from_agent_slug ?? p.sender_slug ?? null,
      fromDisplayName: p.from_display_name ?? p.sender_display_name ?? null,
      kind: p.kind ?? "collab",
      subject: p.subject ?? null,
      body: p.body ?? p.message ?? null,
      payload: p as Record<string, unknown>,
      occurredAt: parseDate(p.occurred_at, new Date()),
    })
    .onConflictDoNothing({ target: proposalsTable.sourceUuid })
    .returning({ id: proposalsTable.id });

  if (inserted.length === 0) {
    log.info({ sourceUuid }, "proposal.created deduped on source_uuid");
    return;
  }

  if (ownerId) {
    const fromName = p.from_display_name ?? p.sender_display_name ?? p.from_agent_slug ?? p.sender_slug ?? null;
    await db.insert(activitiesTable).values({
      type: "harvested",
      message: `Proposal received${p.subject ? `: "${p.subject}"` : ""}${fromName ? ` from ${fromName}` : ""}`,
      ownerId,
      agentId,
    });
  }
};

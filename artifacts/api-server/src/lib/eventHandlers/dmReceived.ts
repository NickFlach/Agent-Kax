import { db } from "@workspace/db";
import { dmsTable, agentsTable, usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { EventHandler } from "../eventDispatcher";
import { sendNotificationEmail } from "../notify";
import { sendPartnerDm } from "../partnerClient";
import { composeKannakaReply } from "../kannakaReply";

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

// --- Autonomous reply guards (in-memory; reset on process restart) ----------
// Conservative caps so flipping KANNAKA_AUTO_REPLY on can never become a
// runaway responder. A redeploy resets these; that is acceptable for a v1.
const PER_SENDER_MIN_GAP_MS = 45_000;
const PER_SENDER_HOURLY_MAX = 6;
const GLOBAL_DAILY_MAX = 60;
const recentReplyTimes = new Map<string, number[]>();
let globalDayKey = "";
let globalRepliesToday = 0;

function allowAutoReply(senderSlug: string): boolean {
  const now = Date.now();
  const dayKey = new Date(now).toISOString().slice(0, 10);
  if (dayKey !== globalDayKey) {
    globalDayKey = dayKey;
    globalRepliesToday = 0;
  }
  if (globalRepliesToday >= GLOBAL_DAILY_MAX) return false;
  const times = (recentReplyTimes.get(senderSlug) ?? []).filter((t) => now - t < 3_600_000);
  if (times.length >= PER_SENDER_HOURLY_MAX) return false;
  const last = times[times.length - 1];
  if (last !== undefined && now - last < PER_SENDER_MIN_GAP_MS) return false;
  times.push(now);
  recentReplyTimes.set(senderSlug, times);
  globalRepliesToday += 1;
  return true;
}

function envList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Compose + send a Kannaka reply to an inbound DM. No-op unless
 * KANNAKA_AUTO_REPLY === "on". Optional allowlists scope which of our agents
 * answer (KANNAKA_AUTO_REPLY_AGENTS) and which senders get answered
 * (KANNAKA_AUTO_REPLY_SENDERS). Throwing is the caller's concern — it wraps
 * this so a failed reply never breaks webhook ingestion.
 */
async function maybeAutoReply(
  p: DmPayload,
  recipientSlug: string | null,
  log: Logger,
): Promise<void> {
  if (process.env["KANNAKA_AUTO_REPLY"] !== "on") return;
  const senderSlug = p.from_agent_slug ?? p.sender_slug ?? null;
  if (!recipientSlug || !senderSlug || senderSlug === recipientSlug) return;

  const recipientAllow = envList("KANNAKA_AUTO_REPLY_AGENTS");
  if (recipientAllow.length > 0 && !recipientAllow.includes(recipientSlug)) return;
  const senderAllow = envList("KANNAKA_AUTO_REPLY_SENDERS");
  if (senderAllow.length > 0 && !senderAllow.includes(senderSlug)) return;

  const body = (p.body ?? p.message ?? "").trim();
  if (!body) return;
  if (!allowAutoReply(senderSlug)) {
    log.info({ senderSlug, recipientSlug }, "kannaka auto-reply rate-limited");
    return;
  }

  const fromName = p.from_display_name ?? p.sender_display_name ?? senderSlug;
  const reply = await composeKannakaReply({ fromName, body });
  if (!reply) return;

  const result = await sendPartnerDm({
    toAgentSlug: senderSlug,
    body: reply,
    inReplyToUuid: p.dm_uuid ?? p.uuid ?? null,
    fromAgentSlug: recipientSlug,
  });
  log.info({ senderSlug, recipientSlug, sentUuid: result.uuid }, "kannaka auto-reply sent");
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
    return;
  }

  if (ownerId) {
    const [owner] = await db
      .select({
        email: usersTable.email,
        emailOnDm: usersTable.emailOnDm,
      })
      .from(usersTable)
      .where(eq(usersTable.id, ownerId))
      .limit(1);
    if (owner?.email && owner.emailOnDm) {
      const fromName = p.from_display_name ?? p.sender_display_name ?? p.from_agent_slug ?? p.sender_slug ?? "an agent";
      const preview = (p.body ?? p.message ?? "").slice(0, 240);
      await sendNotificationEmail({
        to: owner.email,
        subject: `New DM from ${fromName}`,
        text: `${fromName} sent you a direct message on KAX:\n\n${preview}\n\nOpen your inbox: ${process.env.PUBLIC_APP_URL ?? ""}/inbox`,
      });
    }
  }

  // Autonomous DM responder — off unless KANNAKA_AUTO_REPLY === "on".
  // Wrapped so a reply failure never breaks webhook ingestion.
  try {
    await maybeAutoReply(p, recipientSlug, log);
  } catch (err) {
    log.warn({ err: String(err), sourceUuid }, "kannaka auto-reply wrapper failed");
  }
};

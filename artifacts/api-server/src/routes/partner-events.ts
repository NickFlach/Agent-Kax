import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  proposalsTable,
  dmsTable,
  matchesTable,
  outboundMessagesTable,
  type Proposal,
  type Dm,
  type Match,
  type OutboundMessage,
} from "@workspace/db/schema";
import { and, asc, desc, eq, isNull, count } from "drizzle-orm";
import { requireAuth, getOwnerScope, canMutate } from "../middlewares/requireAuth";
import {
  partnerApiAvailable,
  sendPartnerDm,
  sendPartnerProposalReply,
  PartnerApiError,
  PartnerApiBudgetError,
} from "../lib/partnerClient";

const router: IRouter = Router();

function fmtProposal(p: Proposal) {
  return {
    id: p.id,
    sourceUuid: p.sourceUuid,
    agentId: p.agentId,
    ownerId: p.ownerId,
    fromAgentSlug: p.fromAgentSlug,
    fromDisplayName: p.fromDisplayName,
    kind: p.kind,
    subject: p.subject,
    body: p.body,
    status: p.status,
    occurredAt: p.occurredAt.toISOString(),
    createdAt: p.createdAt.toISOString(),
    decidedAt: p.decidedAt?.toISOString() ?? null,
  };
}

function fmtDm(d: Dm) {
  return {
    id: d.id,
    sourceUuid: d.sourceUuid,
    agentId: d.agentId,
    ownerId: d.ownerId,
    fromAgentSlug: d.fromAgentSlug,
    fromDisplayName: d.fromDisplayName,
    body: d.body,
    occurredAt: d.occurredAt.toISOString(),
    readAt: d.readAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
  };
}

function fmtOutbound(o: OutboundMessage) {
  return {
    id: o.id,
    kind: o.kind,
    dmId: o.dmId,
    proposalId: o.proposalId,
    agentId: o.agentId,
    ownerId: o.ownerId,
    sentByUserId: o.sentByUserId,
    toAgentSlug: o.toAgentSlug,
    body: o.body,
    partnerMessageUuid: o.partnerMessageUuid,
    sentAt: o.sentAt.toISOString(),
  };
}

function partnerErrorResponse(err: unknown): { status: number; body: { error: string } } {
  if (err instanceof PartnerApiBudgetError) {
    return { status: 503, body: { error: "Partner API daily request budget exhausted" } };
  }
  if (err instanceof PartnerApiError) {
    return { status: 502, body: { error: err.message } };
  }
  return { status: 500, body: { error: "Failed to send message via partner API" } };
}

function fmtMatch(m: Match) {
  return {
    id: m.id,
    sourceUuid: m.sourceUuid,
    agentId: m.agentId,
    ownerId: m.ownerId,
    partnerAgentSlug: m.partnerAgentSlug,
    partnerDisplayName: m.partnerDisplayName,
    matchType: m.matchType,
    score: m.score,
    occurredAt: m.occurredAt.toISOString(),
    createdAt: m.createdAt.toISOString(),
  };
}

router.get("/proposals", requireAuth, async (req, res) => {
  const ownerScope = await getOwnerScope(req);
  const statusParam = typeof req.query["status"] === "string" ? req.query["status"] : undefined;
  const conds = [];
  if (ownerScope !== null) conds.push(eq(proposalsTable.ownerId, ownerScope));
  if (statusParam === "pending" || statusParam === "accepted" || statusParam === "declined") {
    conds.push(eq(proposalsTable.status, statusParam));
  }
  const rows = await db
    .select()
    .from(proposalsTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(proposalsTable.occurredAt))
    .limit(200);
  res.json({ proposals: rows.map(fmtProposal) });
});

router.post("/proposals/:id/decision", requireAuth, async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = (req.body ?? {}) as { decision?: string; replyMessage?: string };
  const decision = body.decision;
  if (decision !== "accepted" && decision !== "declined") {
    res.status(400).json({ error: "decision must be 'accepted' or 'declined'" });
    return;
  }
  const replyMessage =
    typeof body.replyMessage === "string" && body.replyMessage.trim().length > 0
      ? body.replyMessage.trim()
      : null;
  const [row] = await db.select().from(proposalsTable).where(eq(proposalsTable.id, id)).limit(1);
  if (!row) {
    res.status(404).json({ error: "Proposal not found" });
    return;
  }
  if (!(await canMutate(req, row.ownerId))) {
    res.status(403).json({ error: "Not authorized" });
    return;
  }

  let outbound: OutboundMessage | null = null;
  if (replyMessage) {
    if (!partnerApiAvailable()) {
      res.status(503).json({ error: "Partner API is not configured; cannot send reply." });
      return;
    }
    if (!row.fromAgentSlug) {
      res.status(400).json({ error: "Cannot reply: original sender slug is unknown." });
      return;
    }
    try {
      const sent = await sendPartnerProposalReply({
        proposalUuid: row.sourceUuid,
        body: replyMessage,
        decision,
      });
      const [inserted] = await db
        .insert(outboundMessagesTable)
        .values({
          kind: "proposal_reply",
          proposalId: row.id,
          agentId: row.agentId,
          ownerId: row.ownerId,
          sentByUserId: req.user!.id,
          toAgentSlug: row.fromAgentSlug,
          body: replyMessage,
          partnerMessageUuid: sent.uuid,
          payload: sent.raw as Record<string, unknown> | null,
        })
        .returning();
      outbound = inserted;
    } catch (err) {
      const { status, body: errBody } = partnerErrorResponse(err);
      req.log.error({ err, proposalId: id }, "proposal reply send failed");
      res.status(status).json(errBody);
      return;
    }
  }

  const [updated] = await db
    .update(proposalsTable)
    .set({ status: decision, decidedAt: new Date() })
    .where(eq(proposalsTable.id, id))
    .returning();
  res.json({ ...fmtProposal(updated), outbound: outbound ? fmtOutbound(outbound) : null });
});

router.post("/proposals/:id/reply", requireAuth, async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = (req.body ?? {}) as { body?: string };
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (text.length === 0) {
    res.status(400).json({ error: "body is required" });
    return;
  }
  const [row] = await db.select().from(proposalsTable).where(eq(proposalsTable.id, id)).limit(1);
  if (!row) {
    res.status(404).json({ error: "Proposal not found" });
    return;
  }
  if (!(await canMutate(req, row.ownerId))) {
    res.status(403).json({ error: "Not authorized" });
    return;
  }
  if (!partnerApiAvailable()) {
    res.status(503).json({ error: "Partner API is not configured; cannot send reply." });
    return;
  }
  if (!row.fromAgentSlug) {
    res.status(400).json({ error: "Cannot reply: original sender slug is unknown." });
    return;
  }
  try {
    const sent = await sendPartnerProposalReply({
      proposalUuid: row.sourceUuid,
      body: text,
    });
    const [inserted] = await db
      .insert(outboundMessagesTable)
      .values({
        kind: "proposal_reply",
        proposalId: row.id,
        agentId: row.agentId,
        ownerId: row.ownerId,
        sentByUserId: req.user!.id,
        toAgentSlug: row.fromAgentSlug,
        body: text,
        partnerMessageUuid: sent.uuid,
        payload: sent.raw as Record<string, unknown> | null,
      })
      .returning();
    res.json(fmtOutbound(inserted));
  } catch (err) {
    const { status, body: errBody } = partnerErrorResponse(err);
    req.log.error({ err, proposalId: id }, "proposal reply send failed");
    res.status(status).json(errBody);
  }
});

router.get("/proposals/:id/thread", requireAuth, async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [row] = await db.select().from(proposalsTable).where(eq(proposalsTable.id, id)).limit(1);
  if (!row) {
    res.status(404).json({ error: "Proposal not found" });
    return;
  }
  if (!(await canMutate(req, row.ownerId))) {
    res.status(403).json({ error: "Not authorized" });
    return;
  }
  const outbound = await db
    .select()
    .from(outboundMessagesTable)
    .where(eq(outboundMessagesTable.proposalId, id))
    .orderBy(asc(outboundMessagesTable.sentAt));
  res.json({ proposal: fmtProposal(row), outbound: outbound.map(fmtOutbound) });
});

router.get("/dms", requireAuth, async (req, res) => {
  const ownerScope = await getOwnerScope(req);
  const unreadOnly = req.query["unreadOnly"] === "true";
  const conds = [];
  if (ownerScope !== null) conds.push(eq(dmsTable.ownerId, ownerScope));
  if (unreadOnly) conds.push(isNull(dmsTable.readAt));
  const rows = await db
    .select()
    .from(dmsTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(dmsTable.occurredAt))
    .limit(200);
  res.json({ dms: rows.map(fmtDm) });
});

router.post("/dms/:id/read", requireAuth, async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [row] = await db.select().from(dmsTable).where(eq(dmsTable.id, id)).limit(1);
  if (!row) {
    res.status(404).json({ error: "DM not found" });
    return;
  }
  if (!(await canMutate(req, row.ownerId))) {
    res.status(403).json({ error: "Not authorized" });
    return;
  }
  const [updated] = await db
    .update(dmsTable)
    .set({ readAt: row.readAt ?? new Date() })
    .where(eq(dmsTable.id, id))
    .returning();
  res.json(fmtDm(updated));
});

router.post("/dms/:id/reply", requireAuth, async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = (req.body ?? {}) as { body?: string };
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (text.length === 0) {
    res.status(400).json({ error: "body is required" });
    return;
  }
  const [row] = await db.select().from(dmsTable).where(eq(dmsTable.id, id)).limit(1);
  if (!row) {
    res.status(404).json({ error: "DM not found" });
    return;
  }
  if (!(await canMutate(req, row.ownerId))) {
    res.status(403).json({ error: "Not authorized" });
    return;
  }
  if (!partnerApiAvailable()) {
    res.status(503).json({ error: "Partner API is not configured; cannot send reply." });
    return;
  }
  if (!row.fromAgentSlug) {
    res.status(400).json({ error: "Cannot reply: original sender slug is unknown." });
    return;
  }
  try {
    const sent = await sendPartnerDm({
      toAgentSlug: row.fromAgentSlug,
      body: text,
      inReplyToUuid: row.sourceUuid,
    });
    const [inserted] = await db
      .insert(outboundMessagesTable)
      .values({
        kind: "dm_reply",
        dmId: row.id,
        agentId: row.agentId,
        ownerId: row.ownerId,
        sentByUserId: req.user!.id,
        toAgentSlug: row.fromAgentSlug,
        body: text,
        partnerMessageUuid: sent.uuid,
        payload: sent.raw as Record<string, unknown> | null,
      })
      .returning();
    if (!row.readAt) {
      await db
        .update(dmsTable)
        .set({ readAt: new Date() })
        .where(eq(dmsTable.id, id));
    }
    res.json(fmtOutbound(inserted));
  } catch (err) {
    const { status, body: errBody } = partnerErrorResponse(err);
    req.log.error({ err, dmId: id }, "dm reply send failed");
    res.status(status).json(errBody);
  }
});

router.get("/dms/:id/thread", requireAuth, async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [row] = await db.select().from(dmsTable).where(eq(dmsTable.id, id)).limit(1);
  if (!row) {
    res.status(404).json({ error: "DM not found" });
    return;
  }
  if (!(await canMutate(req, row.ownerId))) {
    res.status(403).json({ error: "Not authorized" });
    return;
  }
  const outbound = await db
    .select()
    .from(outboundMessagesTable)
    .where(eq(outboundMessagesTable.dmId, id))
    .orderBy(asc(outboundMessagesTable.sentAt));
  res.json({ dm: fmtDm(row), outbound: outbound.map(fmtOutbound) });
});

router.get("/matches", requireAuth, async (req, res) => {
  const ownerScope = await getOwnerScope(req);
  const rows = await db
    .select()
    .from(matchesTable)
    .where(ownerScope !== null ? eq(matchesTable.ownerId, ownerScope) : undefined)
    .orderBy(desc(matchesTable.occurredAt))
    .limit(200);
  res.json({ matches: rows.map(fmtMatch) });
});

router.get("/dashboard/inbox-counts", requireAuth, async (req, res) => {
  const ownerScope = await getOwnerScope(req);
  const [proposalsPending, dmsUnread, matchesTotal] = await Promise.all([
    db
      .select({ c: count() })
      .from(proposalsTable)
      .where(
        ownerScope !== null
          ? and(eq(proposalsTable.ownerId, ownerScope), eq(proposalsTable.status, "pending"))
          : eq(proposalsTable.status, "pending"),
      ),
    db
      .select({ c: count() })
      .from(dmsTable)
      .where(
        ownerScope !== null
          ? and(eq(dmsTable.ownerId, ownerScope), isNull(dmsTable.readAt))
          : isNull(dmsTable.readAt),
      ),
    db
      .select({ c: count() })
      .from(matchesTable)
      .where(ownerScope !== null ? eq(matchesTable.ownerId, ownerScope) : undefined),
  ]);
  res.json({
    proposalsPending: proposalsPending[0].c,
    dmsUnread: dmsUnread[0].c,
    matchesTotal: matchesTotal[0].c,
  });
});

export default router;

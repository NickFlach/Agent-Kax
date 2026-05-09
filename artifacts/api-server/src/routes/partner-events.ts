import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  proposalsTable,
  dmsTable,
  matchesTable,
  type Proposal,
  type Dm,
  type Match,
} from "@workspace/db/schema";
import { and, desc, eq, isNull, count } from "drizzle-orm";
import { requireAuth, getOwnerScope, canMutate } from "../middlewares/requireAuth";

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
  const decision = (req.body as { decision?: string } | undefined)?.decision;
  if (decision !== "accepted" && decision !== "declined") {
    res.status(400).json({ error: "decision must be 'accepted' or 'declined'" });
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
  const [updated] = await db
    .update(proposalsTable)
    .set({ status: decision, decidedAt: new Date() })
    .where(eq(proposalsTable.id, id))
    .returning();
  res.json(fmtProposal(updated));
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

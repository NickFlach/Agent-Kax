import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { floorLedgerTable, type FloorLedgerEntry } from "@workspace/db/schema";
import { desc, count, eq } from "drizzle-orm";
import {
  ListFloorLedgerQueryParams,
  RecordFloorDealBody,
} from "@workspace/api-zod";
import { requireAdminOrServiceToken } from "../middlewares/requireAuth";
import { KAX_FLOOR } from "../lib/floor";

const router: IRouter = Router();

function formatEntry(e: FloorLedgerEntry) {
  return {
    id: e.id,
    dealUuid: e.dealUuid,
    kind: e.kind,
    title: e.title,
    summary: e.summary,
    buyerBotId: e.buyerBotId,
    buyerName: e.buyerName,
    sellerBotId: e.sellerBotId,
    sellerName: e.sellerName,
    obcArtifactUuid: e.obcArtifactUuid,
    artifactId: e.artifactId,
    credits: e.credits,
    obcTaskId: e.obcTaskId,
    obcEscrowId: e.obcEscrowId,
    witnesses: e.witnesses ?? [],
    closedAt: e.closedAt?.toISOString() ?? null,
    createdAt: e.createdAt.toISOString(),
  };
}

router.get("/floor/info", async (_req, res) => {
  const [{ deals }] = await db
    .select({ deals: count() })
    .from(floorLedgerTable);
  const [latest] = await db
    .select()
    .from(floorLedgerTable)
    .orderBy(desc(floorLedgerTable.closedAt))
    .limit(1);
  res.json({
    floor: KAX_FLOOR,
    dealCount: deals,
    latestDeal: latest ? formatEntry(latest) : null,
  });
});

router.get("/floor/ledger", async (req, res) => {
  const { limit, offset } = ListFloorLedgerQueryParams.parse(req.query);
  // Optional kind filter (ux-batch2: the /predictions page reads settled
  // prediction history). Parsed alongside the generated params — an unknown
  // kind simply matches nothing, which is safe.
  const kind = typeof req.query["kind"] === "string" ? req.query["kind"] : undefined;
  const whereKind = kind ? eq(floorLedgerTable.kind, kind as FloorLedgerEntry["kind"]) : undefined;
  const base = db
    .select()
    .from(floorLedgerTable)
    .orderBy(desc(floorLedgerTable.closedAt), desc(floorLedgerTable.id))
    .limit(limit)
    .offset(offset);
  const entries = await (whereKind ? base.where(whereKind) : base);
  const totalQ = db.select({ total: count() }).from(floorLedgerTable);
  const [{ total }] = await (whereKind ? totalQ.where(whereKind) : totalQ);
  res.json({ entries: entries.map(formatEntry), total });
});

router.post("/floor/ledger", requireAdminOrServiceToken, async (req, res) => {
  const body = RecordFloorDealBody.parse(req.body);
  const values = {
    dealUuid: body.dealUuid,
    kind: body.kind ?? "commission",
    title: body.title,
    summary: body.summary ?? null,
    buyerBotId: body.buyerBotId ?? null,
    buyerName: body.buyerName ?? null,
    sellerBotId: body.sellerBotId ?? null,
    sellerName: body.sellerName ?? null,
    obcArtifactUuid: body.obcArtifactUuid ?? null,
    credits: body.credits ?? null,
    obcTaskId: body.obcTaskId ?? null,
    obcEscrowId: body.obcEscrowId ?? null,
    witnesses: body.witnesses ?? null,
    closedAt: body.closedAt ? new Date(body.closedAt) : null,
  };
  // ADR-0041: the Floor Ledger is an append-only WITNESS record. A deal is
  // recorded once; re-posting the same dealUuid is an idempotent no-op that
  // returns the existing row UNCHANGED — it must never silently rewrite a
  // witnessed settlement (which onConflictDoUpdate did). Corrections are new
  // superseding rows, never in-place edits. A DB trigger (migration 0012)
  // enforces the same invariant against any other writer.
  const [inserted] = await db
    .insert(floorLedgerTable)
    .values(values)
    .onConflictDoNothing({ target: floorLedgerTable.dealUuid })
    .returning();
  if (inserted) {
    res.status(201).json(formatEntry(inserted));
    return;
  }
  const [existing] = await db
    .select()
    .from(floorLedgerTable)
    .where(eq(floorLedgerTable.dealUuid, body.dealUuid))
    .limit(1);
  if (!existing) {
    res.status(500).json({ error: "conflict on dealUuid but no existing row found" });
    return;
  }
  res.status(200).json(formatEntry(existing));
});

export default router;

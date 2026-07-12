import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { floorLedgerTable, type FloorLedgerEntry } from "@workspace/db/schema";
import { desc, count } from "drizzle-orm";
import {
  ListFloorLedgerQueryParams,
  RecordFloorDealBody,
} from "@workspace/api-zod";
import { requireAdmin } from "../middlewares/requireAuth";
import { KAX_FLOOR } from "../lib/floor";
import type { Request, Response, NextFunction } from "express";

const router: IRouter = Router();

/**
 * Allow trusted constellation services (e.g. the observatory's prediction
 * registry) to write ledger entries server-to-server with a bearer token,
 * as an alternative to an admin browser session. Disabled unless
 * FLOOR_LEDGER_TOKEN is set.
 */
function requireAdminOrFloorToken(req: Request, res: Response, next: NextFunction) {
  const token = process.env.FLOOR_LEDGER_TOKEN;
  const header = req.headers.authorization;
  if (token && header === `Bearer ${token}`) {
    next();
    return;
  }
  requireAdmin(req, res, next);
}

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
  const entries = await db
    .select()
    .from(floorLedgerTable)
    .orderBy(desc(floorLedgerTable.closedAt), desc(floorLedgerTable.id))
    .limit(limit)
    .offset(offset);
  const [{ total }] = await db
    .select({ total: count() })
    .from(floorLedgerTable);
  res.json({ entries: entries.map(formatEntry), total });
});

router.post("/floor/ledger", requireAdminOrFloorToken, async (req, res) => {
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
  const [entry] = await db
    .insert(floorLedgerTable)
    .values(values)
    .onConflictDoUpdate({
      target: floorLedgerTable.dealUuid,
      set: values,
    })
    .returning();
  res.status(201).json(formatEntry(entry));
});

export default router;

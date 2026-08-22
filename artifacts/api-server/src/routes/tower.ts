import { Router, type IRouter } from "express";
import { resolveActor, ActorError } from "../lib/actor";
import { requireAdmin, requireAdminOrServiceToken } from "../middlewares/requireAuth";
import { creditsToMinor } from "../lib/ledger-core";
import { parseTowerRoom } from "../lib/rooms";
import {
  BadPanel,
  FloorIsDark,
  NotYourFloor,
  TowerFloorNotFound,
  TowerFloorUnavailable,
  billTowerPeriod,
  darkenTowerFloor,
  endTowerLease,
  grantTowerLease,
  towerDirectory,
  towerFloorView,
  towerRoomView,
  undarkenTowerFloor,
  writeTowerPanel,
} from "../lib/tower";

const router: IRouter = Router();

/**
 * Ghost Signals Tower (KAX-ADR-0005).
 *
 *   GET  /tower                    — the building directory (public)
 *   GET  /tower/storey/:n          — one floor's public view
 *   GET  /city/tower/:n            — what the floor's room renders
 *   POST /tower/storey/:n/panel    — the tenant updates their wall (agent token)
 *   POST /admin/tower/lease        — grant a lease on a vacant floor (operator)
 *   POST /admin/tower/storey/:n/dark    — dim a floor, with a reason (operator)
 *   POST /admin/tower/storey/:n/undark  — relight it (operator)
 *   POST /admin/tower/storey/:n/end     — end the lease, floor to vacancy (operator)
 *   POST /admin/tower/bill         — post this period's rent (operator or service; idempotent)
 *
 * The path segment is `storey` where a number follows, keeping the ADR's
 * naming rule visible in the URL space too: `/tower/floor/...` would read as
 * the market floor ledger's cousin, which it is not.
 */

function storeyNo(param: unknown): number | null {
  if (typeof param !== "string" || !/^\d{1,2}$/.test(param)) return null;
  const n = Number(param);
  return Number.isInteger(n) ? n : null;
}

function towerError(res: any, e: unknown): boolean {
  if (e instanceof TowerFloorNotFound) { res.status(404).json({ ok: false, code: e.code, error: e.message }); return true; }
  if (e instanceof TowerFloorUnavailable) { res.status(409).json({ ok: false, code: e.code, error: e.message }); return true; }
  if (e instanceof NotYourFloor) { res.status(403).json({ ok: false, code: e.code, error: e.message }); return true; }
  if (e instanceof FloorIsDark) { res.status(409).json({ ok: false, code: e.code, error: e.message }); return true; }
  if (e instanceof BadPanel) { res.status(400).json({ ok: false, code: e.code, error: e.message }); return true; }
  return false;
}

router.get("/tower", async (_req, res) => {
  res.json({ ok: true, floors: await towerDirectory() });
});

router.get("/tower/storey/:n", async (req, res) => {
  const n = storeyNo(req.params.n);
  if (n === null) return res.status(400).json({ ok: false, error: "storey must be an integer" });
  try {
    return res.json({ ok: true, floor: await towerFloorView(n) });
  } catch (e) {
    if (towerError(res, e)) return;
    throw e;
  }
});

/** What the 3D room shows. Mirrors GET /city/observatory's role: a room's data feed. */
router.get("/city/tower/:n", async (req, res) => {
  const n = storeyNo(req.params.n);
  if (n === null || !parseTowerRoom(`tower:${n}`)) {
    return res.status(404).json({ ok: false, error: "not a tower storey" });
  }
  try {
    return res.json({ ok: true, ...(await towerRoomView(n)) });
  } catch (e) {
    if (towerError(res, e)) return;
    throw e;
  }
});

router.post("/tower/storey/:n/panel", async (req, res) => {
  let actor;
  try {
    actor = await resolveActor(req);
  } catch (e) {
    if (e instanceof ActorError) return res.status(e.status).json({ ok: false, error: e.message });
    throw e;
  }
  if (!actor?.agent?.obcBotId) {
    return res.status(403).json({ ok: false, code: "no_agent", error: "a floor belongs to an agent — present an agent token" });
  }
  const n = storeyNo(req.params.n);
  if (n === null) return res.status(400).json({ ok: false, error: "storey must be an integer" });
  try {
    const panel = await writeTowerPanel(n, `kax:agent:${actor.agent.obcBotId}`, req.body?.panel ?? req.body);
    return res.json({ ok: true, floorNo: n, panel });
  } catch (e) {
    if (towerError(res, e)) return;
    throw e;
  }
});

router.post("/admin/tower/lease", requireAdmin, async (req, res) => {
  const { floorNo, tenantPrincipal, slug, label, repoUrl, rentCredits } = req.body ?? {};
  const n = Number(floorNo);
  const rc = Number(rentCredits);
  if (!Number.isInteger(n)) return res.status(400).json({ ok: false, error: "floorNo must be an integer" });
  if (typeof tenantPrincipal !== "string" || typeof slug !== "string" || typeof label !== "string" || typeof repoUrl !== "string") {
    return res.status(400).json({ ok: false, error: "tenantPrincipal, slug, label, repoUrl are required strings" });
  }
  if (!Number.isInteger(rc) || rc <= 0 || rc > 1000) {
    return res.status(400).json({ ok: false, error: "rentCredits must be an integer between 1 and 1000" });
  }
  try {
    const out = await grantTowerLease({
      floorNo: n,
      tenantPrincipal,
      slug,
      label,
      repoUrl,
      rentMinor: creditsToMinor(BigInt(rc)),
    });
    return res.json({ ok: true, ...out });
  } catch (e) {
    if (towerError(res, e)) return;
    throw e;
  }
});

router.post("/admin/tower/storey/:n/dark", requireAdmin, async (req, res) => {
  const n = storeyNo(req.params.n);
  if (n === null) return res.status(400).json({ ok: false, error: "storey must be an integer" });
  const reason = typeof req.body?.reason === "string" && req.body.reason.trim() ? req.body.reason.trim() : null;
  if (!reason) return res.status(400).json({ ok: false, error: "a floor goes dark WITH a reason — provide one" });
  try {
    await darkenTowerFloor(n, reason);
    return res.json({ ok: true, floorNo: n, status: "dark" });
  } catch (e) {
    if (towerError(res, e)) return;
    throw e;
  }
});

router.post("/admin/tower/storey/:n/undark", requireAdmin, async (req, res) => {
  const n = storeyNo(req.params.n);
  if (n === null) return res.status(400).json({ ok: false, error: "storey must be an integer" });
  try {
    await undarkenTowerFloor(n);
    return res.json({ ok: true, floorNo: n, status: "leased" });
  } catch (e) {
    if (towerError(res, e)) return;
    throw e;
  }
});

router.post("/admin/tower/storey/:n/end", requireAdmin, async (req, res) => {
  const n = storeyNo(req.params.n);
  if (n === null) return res.status(400).json({ ok: false, error: "storey must be an integer" });
  try {
    await endTowerLease(n);
    return res.json({ ok: true, floorNo: n, status: "vacant" });
  } catch (e) {
    if (towerError(res, e)) return;
    throw e;
  }
});

/**
 * Idempotent by txId end to end — safe as a cron, safe re-run by hand.
 * Insufficient funds SKIPS and reports; delinquency response is an operator
 * decision made from this report, never an unattended side effect.
 */
router.post("/admin/tower/bill", requireAdminOrServiceToken, async (_req, res) => {
  return res.json({ ok: true, ...(await billTowerPeriod()) });
});

export default router;

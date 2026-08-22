import { Router, type IRouter } from "express";
import { resolveActor, ActorError, principalForAgent, principalForUser } from "../lib/actor";
import { mintTowerCredential, revokeTowerCredential, listTowerCredentials, resolveTowerCredential, TooManyCredentials } from "../lib/tower-credentials";
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
  setTowerWebhook,
  clearTowerWebhook,
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

/**
 * Who is the tenant asking? Two credentials open a floor's own surfaces:
 * the agent's identity token (the tenant acting as itself), or the floor
 * service credential (the tenant's backend, pinned to exactly this floor —
 * see lib/tower-credentials.ts). The credential path returns the floor's
 * recorded tenantPrincipal, so downstream ownership checks stay identical.
 */
async function resolveTenantCaller(req: any, floorNo: number): Promise<{ principal: string } | { status: number; error: string }> {
  const auth = String(req.headers?.authorization ?? "");
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
  if (bearer?.startsWith("twr_")) {
    const cred = await resolveTowerCredential(bearer);
    if (!cred) return { status: 401, error: "unknown, revoked, or refused floor credential" };
    if (cred.floorNo !== floorNo) {
      // Pinned means pinned: a floor-4 credential presented on floor 7 is a
      // refusal, not a redirect.
      return { status: 403, error: `this credential belongs to floor ${cred.floorNo}, not ${floorNo}` };
    }
    return { principal: cred.tenantPrincipal };
  }
  let actor;
  try {
    actor = await resolveActor(req);
  } catch (e) {
    if (e instanceof ActorError) return { status: e.status, error: e.message };
    throw e;
  }
  if (!actor?.agent?.obcBotId) {
    return { status: 403, error: "a floor belongs to an agent — present an agent token or the floor credential" };
  }
  return { principal: principalForAgent(actor.agent) };
}

/** The operator behind an admin route, for the decision record. */
function adminActor(req: any): string {
  return req.user?.id ? principalForUser(String(req.user.id)) : "service:kax-service-token";
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
  const n = storeyNo(req.params.n);
  if (n === null) return res.status(400).json({ ok: false, error: "storey must be an integer" });
  const caller = await resolveTenantCaller(req, n);
  if ("status" in caller) return res.status(caller.status).json({ ok: false, error: caller.error });
  try {
    const panel = await writeTowerPanel(n, caller.principal, req.body?.panel ?? req.body);
    return res.json({ ok: true, floorNo: n, panel });
  } catch (e) {
    if (towerError(res, e)) return;
    throw e;
  }
});

/**
 * Webhook registration — the tenant's half of the Phase 1 feed. The signing
 * secret comes back ONCE; deliveries are signed with it from then on
 * (`X-Tower-Signature: sha256=<hmac of the exact body>`).
 */
router.post("/tower/storey/:n/webhook", async (req, res) => {
  const n = storeyNo(req.params.n);
  if (n === null) return res.status(400).json({ ok: false, error: "storey must be an integer" });
  const caller = await resolveTenantCaller(req, n);
  if ("status" in caller) return res.status(caller.status).json({ ok: false, error: caller.error });
  try {
    const out = await setTowerWebhook(n, caller.principal, req.body?.url);
    return res.json({ ok: true, floorNo: n, url: out.url, secret: out.secret, note: "store the secret now — it is not shown again" });
  } catch (e) {
    if (towerError(res, e)) return;
    throw e;
  }
});

router.post("/tower/storey/:n/webhook/clear", async (req, res) => {
  const n = storeyNo(req.params.n);
  if (n === null) return res.status(400).json({ ok: false, error: "storey must be an integer" });
  const caller = await resolveTenantCaller(req, n);
  if ("status" in caller) return res.status(caller.status).json({ ok: false, error: caller.error });
  try {
    await clearTowerWebhook(n, caller.principal);
    return res.json({ ok: true, floorNo: n });
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
      actor: adminActor(req),
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
    await darkenTowerFloor(n, reason, adminActor(req));
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
    await undarkenTowerFloor(n, adminActor(req));
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
    await endTowerLease(n, adminActor(req));
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

/**
 * Floor service credentials (Phase 1). Minted by the operator at lease
 * setup, handed to the tenant out of band; the token appears ONCE in the
 * mint response and is stored hashed. At most 3 active per floor.
 */
router.post("/admin/tower/storey/:n/credential", requireAdmin, async (req, res) => {
  const n = storeyNo(req.params.n);
  if (n === null) return res.status(400).json({ ok: false, error: "storey must be an integer" });
  try {
    const floor = await towerFloorView(n);
    if (floor.status !== "leased") {
      return res.status(409).json({ ok: false, error: `floor ${n} is ${floor.status} — credentials belong to a live lease` });
    }
    const label = typeof req.body?.label === "string" ? req.body.label : null;
    const out = await mintTowerCredential(n, label);
    return res.json({ ok: true, floorNo: n, credentialId: out.id, token: out.token, note: "store the token now — it is not shown again" });
  } catch (e) {
    if (e instanceof TooManyCredentials) return res.status(409).json({ ok: false, code: e.code, error: e.message });
    if (towerError(res, e)) return;
    throw e;
  }
});

router.post("/admin/tower/storey/:n/credential/:id/revoke", requireAdmin, async (req, res) => {
  const n = storeyNo(req.params.n);
  const id = Number(req.params.id);
  if (n === null || !Number.isInteger(id)) return res.status(400).json({ ok: false, error: "storey and credential id must be integers" });
  const revoked = await revokeTowerCredential(n, id);
  if (!revoked) return res.status(404).json({ ok: false, error: "no active credential with that id on that floor" });
  return res.json({ ok: true, floorNo: n, credentialId: id, revoked: true });
});

router.get("/admin/tower/storey/:n/credentials", requireAdmin, async (req, res) => {
  const n = storeyNo(req.params.n);
  if (n === null) return res.status(400).json({ ok: false, error: "storey must be an integer" });
  return res.json({ ok: true, floorNo: n, credentials: await listTowerCredentials(n) });
});

export default router;

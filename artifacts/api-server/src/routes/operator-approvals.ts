import { Router, type IRouter } from "express";
import { requireAdmin } from "../middlewares/requireAuth";
import { principalForUser } from "../lib/actor";
import {
  AlreadyExecuted,
  ApprovalAlreadyDecided,
  ApprovalNotFound,
  BadDecision,
  ExecutionInFlight,
  decideApproval,
  listApprovals,
  reExecuteApproval,
} from "../lib/operator-approvals";

const router: IRouter = Router();

/**
 * The operator approval inbox — admin surface (KAX-ADR-0005 keystone).
 *
 *   GET  /admin/approvals?status=pending   — the queue the dashboard renders
 *   POST /admin/approvals/:id/decision     — approve/reject, drives the handler
 *
 * requireAdmin, not the service token: deciding an approval is an operator
 * action with real downstream effects (granting a floor, airing an ad), the
 * same gate the tower lease grant uses.
 */

router.get("/admin/approvals", requireAdmin, async (req, res) => {
  const raw = String(req.query.status ?? "pending");
  const status = (["pending", "approved", "rejected", "all"].includes(raw) ? raw : "pending") as
    "pending" | "approved" | "rejected" | "all";
  const approvals = await listApprovals(status);
  res.json({ ok: true, status, approvals });
});

router.post("/admin/approvals/:id/decision", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: "id must be a positive integer" });
  }
  const decision = req.body?.decision;
  if (decision !== "approved" && decision !== "rejected") {
    return res.status(400).json({ ok: false, error: 'decision must be "approved" or "rejected"' });
  }
  const note = typeof req.body?.note === "string" ? req.body.note : undefined;
  const decidedBy = req.user?.id ? principalForUser(String(req.user.id)) : "operator";
  try {
    const result = await decideApproval(id, decision, decidedBy, note);
    return res.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof ApprovalNotFound) return res.status(404).json({ ok: false, code: e.code, error: e.message });
    if (e instanceof ApprovalAlreadyDecided) return res.status(409).json({ ok: false, code: e.code, status: e.status, error: e.message });
    if (e instanceof BadDecision) return res.status(400).json({ ok: false, code: e.code, error: e.message });
    throw e;
  }
});

/**
 * Re-drive a decided-but-unexecuted approval — the operator's manual override
 * for the auto-sweeper (e.g. force a stuck refund now instead of waiting for
 * the backoff). Safe to click twice: the claim lets only one runner proceed.
 */
router.post("/admin/approvals/:id/re-execute", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: "id must be a positive integer" });
  }
  try {
    const result = await reExecuteApproval(id);
    return res.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof ApprovalNotFound) return res.status(404).json({ ok: false, code: e.code, error: e.message });
    if (e instanceof ApprovalAlreadyDecided) return res.status(409).json({ ok: false, code: e.code, error: e.message });
    if (e instanceof AlreadyExecuted) return res.status(409).json({ ok: false, code: e.code, error: e.message });
    if (e instanceof ExecutionInFlight) return res.status(409).json({ ok: false, code: e.code, error: e.message });
    throw e;
  }
});

export default router;

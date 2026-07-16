import { Router, type IRouter } from "express";
import { requireAdminOrServiceToken } from "../middlewares/requireAuth";
import { balance, verifyLedgerChain } from "../lib/ledger";

const router: IRouter = Router();

/**
 * Derived balance for an account + asset (ADR-0041 Phase 2). Read-only,
 * service/admin gated. Balances are computed from the ledger postings, never
 * stored — this endpoint just runs the SUM. bigint is returned as a string so
 * it survives JSON without precision loss.
 */
router.get("/ledger/balance", requireAdminOrServiceToken, async (req, res) => {
  const account = typeof req.query.account === "string" ? req.query.account : "";
  const asset = typeof req.query.asset === "string" ? req.query.asset : "";
  if (!account || !asset) {
    res.status(400).json({ error: "account and asset query params are required" });
    return;
  }
  const bal = await balance(account, asset);
  res.json({ account, asset, balance: bal.toString() });
});

/**
 * Recompute and verify the entire hash chain from genesis. Returns
 * { ok, head, entries } or { ok:false, error } — an audit anyone with the
 * service token can run to confirm the ledger hasn't been tampered with.
 */
router.get("/ledger/verify", requireAdminOrServiceToken, async (_req, res) => {
  const result = await verifyLedgerChain();
  res.status(result.ok ? 200 : 500).json(result);
});

export default router;

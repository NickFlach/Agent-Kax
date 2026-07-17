import { Router, type IRouter, type Request, type Response } from "express";
import {
  requireAdminOrServiceToken,
  requireLedgerMintToken,
  requireLedgerTradeToken,
} from "../middlewares/requireAuth";
import {
  balance,
  verifyLedgerChain,
  postTransaction,
  getTransaction,
  houseOutflow,
  LedgerInsufficientFunds,
  LedgerIdempotencyConflict,
} from "../lib/ledger";
import { HOUSE_ACCOUNT, type Posting } from "../lib/ledger-core";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Account grammar. The server BUILDS every posting from these validated
// identifiers — clients never send raw account strings or signed amounts, so
// they cannot forge a `house` posting, mix assets, or craft an unbalanced set.
// ---------------------------------------------------------------------------
const DEFAULT_ASSET = "play_credit";
// A trader identity (KAX token subject): "kax:agent:<bot>", a user id, etc.
const PRINCIPAL_RE = /^[a-z0-9][a-z0-9:_.-]{2,127}$/i;
// A market pool id from the hub, e.g. "m_1a2b3c" or a slug.
const MARKET_RE = /^[a-z0-9][a-z0-9:_-]{2,79}$/i;
// A txId is caller-chosen but must be a bounded, safe token (idempotency key).
const TXID_RE = /^[a-z0-9][a-z0-9:_.\-]{2,127}$/i;
// Only these assets may be moved through the typed endpoints today.
const ALLOWED_ASSETS = new Set(["play_credit"]);

class BadRequest extends Error {}

function traderAccount(principal: unknown): string {
  if (typeof principal !== "string" || !PRINCIPAL_RE.test(principal)) {
    throw new BadRequest("principal must match [a-z0-9:_.-]{3,128}");
  }
  return `trader:${principal}`;
}

function ammAccount(marketId: unknown): string {
  if (typeof marketId !== "string" || !MARKET_RE.test(marketId)) {
    throw new BadRequest("marketId must match [a-z0-9:_-]{3,80}");
  }
  return `amm:${marketId}`;
}

function requireTxId(txId: unknown): string {
  if (typeof txId !== "string" || !TXID_RE.test(txId)) {
    throw new BadRequest("txId must match [a-z0-9:_.-]{3,128} (used as the idempotency key)");
  }
  return txId;
}

function requireAsset(asset: unknown): string {
  const a = typeof asset === "string" && asset ? asset : DEFAULT_ASSET;
  if (!ALLOWED_ASSETS.has(a)) throw new BadRequest(`unsupported asset '${a}'`);
  return a;
}

/** Parse a positive integer minor-unit amount from a decimal STRING (no floats). */
function positiveMinor(v: unknown, field: string): bigint {
  if (typeof v !== "string" || !/^\d{1,30}$/.test(v)) {
    throw new BadRequest(`${field} must be a decimal integer string of minor units`);
  }
  const n = BigInt(v);
  if (n <= 0n) throw new BadRequest(`${field} must be > 0`);
  return n;
}

/** Parse a non-negative amount (residual may be zero). */
function nonNegativeMinor(v: unknown, field: string): bigint {
  if (v === undefined || v === null) return 0n;
  if (typeof v !== "string" || !/^\d{1,30}$/.test(v)) {
    throw new BadRequest(`${field} must be a decimal integer string of minor units`);
  }
  return BigInt(v);
}

/**
 * Run a server-built transaction and shape the HTTP result. Business errors map
 * to specific statuses; validation errors to 400; everything else to 500.
 */
async function commit(
  res: Response,
  txId: string,
  asset: string,
  postings: Posting[],
): Promise<void> {
  try {
    const r = await postTransaction({ txId, asset, postings });
    res.status(r.idempotentReplay ? 200 : 201).json({
      ok: true,
      txId: r.txId,
      head: r.head,
      count: r.count,
      idempotentReplay: r.idempotentReplay,
    });
  } catch (err) {
    if (err instanceof LedgerInsufficientFunds) {
      res.status(409).json({ ok: false, error: err.message, code: err.code, account: err.account });
      return;
    }
    if (err instanceof LedgerIdempotencyConflict) {
      res.status(409).json({ ok: false, error: err.message, code: err.code, txId: err.txId });
      return;
    }
    throw err;
  }
}

/** Turn thrown BadRequest into a 400; re-throw anything else to the error handler. */
function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof BadRequest) {
        res.status(400).json({ ok: false, error: err.message });
        return;
      }
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// MINT surface (house -> account). Dedicated mint token. Creates credits.
// ---------------------------------------------------------------------------

/**
 * Grant play credits from the house to a trader. The ONLY way play credits enter
 * circulation. Optional per-day house-outflow cap (`KAX_LEDGER_GRANT_DAILY_CAP`,
 * minor units; 0/unset = unlimited) bounds a compromised mint token's blast
 * radius. Idempotent on `txId`.
 */
router.post(
  "/ledger/grant",
  requireLedgerMintToken,
  handle(async (req, res) => {
    const txId = requireTxId(req.body?.txId);
    const asset = requireAsset(req.body?.asset);
    const trader = traderAccount(req.body?.principal);
    const amount = positiveMinor(req.body?.amount, "amount");
    const ref = typeof req.body?.ref === "string" ? req.body.ref : null;

    const capRaw = process.env.KAX_LEDGER_GRANT_DAILY_CAP;
    const cap = capRaw && /^\d+$/.test(capRaw) ? BigInt(capRaw) : 0n;
    if (cap > 0n) {
      const since = new Date();
      since.setUTCHours(0, 0, 0, 0);
      const already = await houseOutflow("grant", asset, since);
      if (already + amount > cap) {
        res.status(429).json({
          ok: false,
          error: "daily grant cap exceeded",
          code: "grant_cap",
          cap: cap.toString(),
          alreadyToday: already.toString(),
        });
        return;
      }
    }

    await commit(res, txId, asset, [
      { account: HOUSE_ACCOUNT, amount: -amount, kind: "grant", ref },
      { account: trader, amount, kind: "grant", ref },
    ]);
  }),
);

/**
 * Fund a market's AMM pool from the house (the LMSR subsidy). Establishes the
 * conserved backing so payouts can only ever draw down what was funded.
 */
router.post(
  "/ledger/escrow",
  requireLedgerMintToken,
  handle(async (req, res) => {
    const txId = requireTxId(req.body?.txId);
    const asset = requireAsset(req.body?.asset);
    const amm = ammAccount(req.body?.marketId);
    const amount = positiveMinor(req.body?.amount, "amount");
    const ref = typeof req.body?.ref === "string" ? req.body.ref : null;

    await commit(res, txId, asset, [
      { account: HOUSE_ACCOUNT, amount: -amount, kind: "escrow", ref },
      { account: amm, amount, kind: "escrow", ref },
    ]);
  }),
);

// ---------------------------------------------------------------------------
// TRADE surface (account <-> account, never minted). Dedicated trade token.
// ---------------------------------------------------------------------------

/**
 * Move credits for a trade between a trader and a market pool. `side: "buy"`
 * (default) debits the trader and credits the pool; `side: "sell"` reverses it.
 * The overdraft guard rejects a buy the trader can't afford OR a sell the pool
 * can't cover (both are non-house accounts), so nothing is ever conjured.
 */
router.post(
  "/ledger/trade",
  requireLedgerTradeToken,
  handle(async (req, res) => {
    const txId = requireTxId(req.body?.txId);
    const asset = requireAsset(req.body?.asset);
    const trader = traderAccount(req.body?.principal);
    const amm = ammAccount(req.body?.marketId);
    const amount = positiveMinor(req.body?.amount, "amount");
    const ref = typeof req.body?.ref === "string" ? req.body.ref : null;
    const side = req.body?.side === "sell" ? "sell" : "buy";

    const postings: Posting[] =
      side === "buy"
        ? [
            { account: trader, amount: -amount, kind: "trade", ref },
            { account: amm, amount, kind: "trade", ref },
          ]
        : [
            { account: amm, amount: -amount, kind: "trade", ref },
            { account: trader, amount, kind: "trade", ref },
          ];
    await commit(res, txId, asset, postings);
  }),
);

/**
 * Resolve a market: pay winners out of the AMM pool in ONE balanced transaction,
 * sweeping any leftover subsidy back to the house as `residual`. The pool debit
 * equals the sum of all winner credits plus the residual, so the transaction is
 * self-balancing and the overdraft guard forbids paying out more than the pool
 * holds (the funded-AMM conservation invariant). Idempotent on `txId`.
 */
router.post(
  "/ledger/payout",
  requireLedgerTradeToken,
  handle(async (req, res) => {
    const txId = requireTxId(req.body?.txId);
    const asset = requireAsset(req.body?.asset);
    const amm = ammAccount(req.body?.marketId);
    const ref = typeof req.body?.ref === "string" ? req.body.ref : null;
    const residual = nonNegativeMinor(req.body?.residual, "residual");

    const winnersRaw = req.body?.winners ?? [];
    if (!Array.isArray(winnersRaw)) {
      throw new BadRequest("winners must be an array of { principal, amount }");
    }
    let total = 0n;
    const winnerPostings: Posting[] = winnersRaw.map((w: unknown) => {
      const row = w as { principal?: unknown; amount?: unknown };
      const account = traderAccount(row.principal);
      const amount = positiveMinor(row.amount, "winner.amount");
      total += amount;
      return { account, amount, kind: "payout", ref };
    });
    // An upset market can resolve to a side nobody holds: no winners, but the
    // full pool (subsidy + losers' stakes) must still be swept to house as the
    // residual. Reject only the genuinely-empty case (no winners AND no residual),
    // which would leave a single, unbalanced posting.
    if (winnerPostings.length === 0 && residual === 0n) {
      throw new BadRequest("payout must move value: provide winners and/or a residual > 0");
    }

    const postings: Posting[] = [
      { account: amm, amount: -(total + residual), kind: "payout", ref },
      ...winnerPostings,
    ];
    // House sweep whenever there's leftover subsidy (always present in the
    // no-winner case) — otherwise the pool debit already balances the winners.
    if (residual > 0n) {
      postings.push({ account: HOUSE_ACCOUNT, amount: residual, kind: "payout", ref });
    }
    await commit(res, txId, asset, postings);
  }),
);

// ---------------------------------------------------------------------------
// READ surface. Service/admin gated.
// ---------------------------------------------------------------------------

/**
 * A principal's OWN wallet, authenticated by their identity token (not the
 * service token) — the browser/dashboard surface. Verifies the Bearer JWT,
 * derives the canonical principal (kax:user:<sub> / kax:agent:<bot_id>), and
 * returns the play-credit balance. Safe to expose: a caller can only ever see
 * the balance of the principal their token proves.
 */
router.get("/ledger/my", async (req, res) => {
  const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? "");
  if (!m) {
    res.status(401).json({ error: "identity token required (Authorization: Bearer)" });
    return;
  }
  const { verifyToken } = await import("../lib/identity");
  const v = await verifyToken(m[1]);
  if (!v.ok) {
    res.status(401).json({ error: `token did not verify: ${v.error}` });
    return;
  }
  const c = v.claims;
  const principal = c.kind === "agent" && c.bot_id ? `kax:agent:${c.bot_id}` : `kax:${c.kind}:${c.sub}`;
  const bal = await balance(`trader:${principal}`, "play_credit");
  res.json({
    principal,
    asset: "play_credit",
    balance: bal.toString(),
    credits: Number(bal) / 1_000_000, // display convenience (float)
  });
});

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
 * Look up a recorded transaction by txId — the cross-service reconciliation
 * probe. Returns { found:false } (200) when absent so the hub can safely
 * distinguish "never landed" from "landed" without treating 404 as an error.
 */
router.get("/ledger/tx/:txId", requireAdminOrServiceToken, async (req, res) => {
  const txId = String(req.params.txId);
  const rec = await getTransaction(txId);
  if (!rec) {
    res.json({ found: false, txId });
    return;
  }
  res.json({ found: true, ...rec });
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

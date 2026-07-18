import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth } from "../middlewares/requireAuth";
import { issueToken, USER_TOKEN_TTL_SEC } from "../lib/identity";

/**
 * Predictions proxy (ux-batch2) — the /predictions page's same-origin surface.
 *
 * The prediction REGISTRY (statement, lifecycle, settles-by) lives in the
 * observatory, which serves no CORS headers; the tradeable LMSR MARKETS live
 * in the radio's GhostSignals hub; labs-tier trades require a KAX identity
 * token that is minted server-side only. All three facts point the browser at
 * ONE place: this router. It joins registry+market server-to-server and
 * bridges the identity token on trade so the browser never holds it.
 *
 * No database, no schema — pure proxy/join. Upstreams are public reads except
 * the trade forward, which carries the caller's freshly-minted token.
 */

const OBSERVATORY_URL = (process.env["OBSERVATORY_URL"] || "https://observatory.ninja-portal.com").replace(/\/$/, "");
const RADIO_URL = (process.env["RADIO_URL"] || "https://radio.ninja-portal.com").replace(/\/$/, "");
const UPSTREAM_TIMEOUT_MS = 10_000;

const router: IRouter = Router();

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: { Accept: "application/json", ...(init?.headers || {}) },
  });
  if (!res.ok) throw new Error(`upstream ${res.status} for ${url}`);
  return res.json();
}

type ObservatoryPrediction = {
  id: string;
  number?: number;
  statement?: string;
  category?: string;
  status?: string;
  outcome?: boolean | null;
  settlesBy?: string | null;
  settledAt?: string | null;
  createdAt?: string;
  market?: { id?: string } | null;
  dueForSettlement?: boolean;
};

type RadioMarket = {
  id: string;
  question?: string;
  outcomes?: string[];
  prices?: number[];
  volume?: number;
  resolved?: boolean;
  resolved_outcome?: number | null;
  ledger_backed?: boolean;
  ttl_remaining_sec?: number | null;
  tag?: string;
};

/** Fetch registry + market board once each and join on market id. */
async function fetchJoined(): Promise<Array<ObservatoryPrediction & { marketData: RadioMarket | null }>> {
  const [obsRaw, radioRaw] = await Promise.all([
    getJson(`${OBSERVATORY_URL}/api/predictions`),
    // Include resolved markets so settled predictions keep their final book.
    getJson(`${RADIO_URL}/api/markets?limit=200`).catch(() => ({ markets: [] })),
  ]);
  const predictions: ObservatoryPrediction[] =
    (obsRaw as { predictions?: ObservatoryPrediction[] }).predictions || [];
  const markets: RadioMarket[] = (radioRaw as { markets?: RadioMarket[] }).markets || [];
  const byId = new Map(markets.map((m) => [m.id, m]));
  return predictions.map((p) => ({
    ...p,
    marketData: (p.market && p.market.id && byId.get(p.market.id)) || null,
  }));
}

// GET /api/predictions — merged registry + market board (public).
router.get("/predictions", async (_req: Request, res: Response) => {
  try {
    const joined = await fetchJoined();
    res.json({ predictions: joined });
  } catch (err) {
    res.status(502).json({ error: `predictions upstream unavailable: ${(err as Error).message}` });
  }
});

// GET /api/predictions/:id — one prediction + its full market book (public).
router.get("/predictions/:id", async (req: Request, res: Response) => {
  try {
    const joined = await fetchJoined();
    const p = joined.find((x) => x.id === req.params["id"] || String(x.number) === req.params["id"]);
    if (!p) {
      res.status(404).json({ error: "prediction not found" });
      return;
    }
    // Refresh the single market for the freshest book (list endpoint may lag).
    if (p.market?.id) {
      try {
        const m = (await getJson(`${RADIO_URL}/api/markets/${p.market.id}`)) as { market?: RadioMarket };
        if (m.market) p.marketData = m.market;
      } catch {
        /* keep joined snapshot */
      }
    }
    res.json({ prediction: p });
  } catch (err) {
    res.status(502).json({ error: `predictions upstream unavailable: ${(err as Error).message}` });
  }
});

// POST /api/predictions/:id/trade {outcome, shares} — the identity bridge.
// Session-authed; mints a short-lived KAX user token server-side and forwards
// the trade to the radio hub, which derives trader_id from the token
// (ADR-0041 Phase 1 — the browser never sees the token).
router.post("/predictions/:id/trade", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const outcome = Number((req.body as { outcome?: unknown })?.outcome);
  const shares = Number((req.body as { shares?: unknown })?.shares);
  if (!Number.isInteger(outcome) || outcome < 0 || outcome > 1) {
    res.status(400).json({ error: "outcome must be 0 (Yes) or 1 (No)" });
    return;
  }
  if (!Number.isFinite(shares) || shares <= 0 || shares > 100) {
    res.status(400).json({ error: "shares must be in (0, 100]" });
    return;
  }
  try {
    const joined = await fetchJoined();
    const p = joined.find((x) => x.id === req.params["id"] || String(x.number) === req.params["id"]);
    if (!p || !p.market?.id) {
      res.status(404).json({ error: "prediction has no open market" });
      return;
    }
    let token: string;
    try {
      token = await issueToken({
        kind: "user",
        subject: String(userId),
        scopes: ["trade"],
        ttlSeconds: USER_TOKEN_TTL_SEC,
      });
    } catch {
      res.status(503).json({ error: "identity signing not configured" });
      return;
    }
    const hubRes = await fetch(`${RADIO_URL}/api/markets/${p.market.id}/trade`, {
      method: "POST",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ outcome, shares }),
    });
    const body = (await hubRes.json().catch(() => ({}))) as Record<string, unknown>;
    res.status(hubRes.status).json(body);
  } catch (err) {
    res.status(502).json({ error: `trade upstream unavailable: ${(err as Error).message}` });
  }
});

export default router;

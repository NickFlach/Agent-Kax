import { db } from "@workspace/db";
import { agentsTable } from "@workspace/db/schema";

/**
 * The unified prediction leaderboard (#409, KAX-ADR-0004 Phase 1).
 *
 * The constellation ran two prediction surfaces with reputation split across
 * them. The GhostSignals hub already spans BOTH market sources (kannaka-labs +
 * kannaka-radio) at the data level and serves one Brier-scored leaderboard at
 * `${RADIO_URL}/api/leaderboard`; what was missing was a KAX-side door to it
 * and a keying on the ONE identity the rest of KAX uses. This is that door:
 * it federates the hub's leaderboard and resolves each trader to its
 * `kax:agent:<bot_id>` principal, so a human reads one board and can find an
 * agent by its KAX identity — the ADR's Option A (federate), read-only, no
 * stake crossing.
 *
 * The identity map is a v1 HEURISTIC (the ADR calls the map a standing
 * decision to be refined): a hub trader is matched to a KAX agent by its id
 * appearing in the agent's obc_bot_id, or by an exact display-name/slug match.
 * Unmatched traders are still shown, keyed by their hub id — an honest board
 * that does not silently drop the accounts it cannot yet map.
 */

const RADIO_URL = (process.env["RADIO_URL"] || "https://radio.ninja-portal.com").replace(/\/$/, "");
const UPSTREAM_TIMEOUT_MS = 8000;

export interface HubTrader {
  id: string;
  display_name?: string;
  kind?: string;
  capital?: number;
  reputation?: number;
  trades_total?: number;
  trades_won?: number;
  accuracy?: number;
}

export interface LeaderboardRow {
  /** The resolved KAX principal, or null when the hub account is not yet mapped. */
  kaxPrincipal: string | null;
  hubId: string;
  name: string;
  capital: number;
  reputation: number;
  trades: number;
  accuracy: number | null;
}

/** Fetch the hub's leaderboard. Throws on upstream failure (caller fails soft). */
export async function fetchHubLeaderboard(fetchImpl: typeof fetch = fetch): Promise<HubTrader[]> {
  const res = await fetchImpl(`${RADIO_URL}/api/leaderboard`, {
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`hub leaderboard ${res.status}`);
  const body = (await res.json()) as { traders?: HubTrader[] };
  return body.traders ?? [];
}

/** Build the hub-id/name → kax:agent principal resolver from the agents table. */
async function principalResolver(): Promise<(t: HubTrader) => string | null> {
  const agents = await db
    .select({ slug: agentsTable.slug, displayName: agentsTable.displayName, obcBotId: agentsTable.obcBotId })
    .from(agentsTable);
  const byName = new Map<string, string>();
  const byBot: Array<{ botId: string; principal: string }> = [];
  for (const a of agents) {
    if (!a.obcBotId) continue;
    const principal = `kax:agent:${a.obcBotId}`;
    byName.set(a.displayName.toLowerCase(), principal);
    byName.set(a.slug.toLowerCase(), principal);
    byBot.push({ botId: a.obcBotId.toLowerCase(), principal });
  }
  return (t: HubTrader) => {
    const id = t.id.toLowerCase();
    // A hub id that is a bot-uuid fragment resolves when it appears in a bot id.
    const hit = byBot.find((b) => b.botId.includes(id) || id.includes(b.botId.replace(/-/g, "").slice(0, 12)));
    if (hit) return hit.principal;
    const name = (t.display_name ?? "").toLowerCase();
    return byName.get(name) ?? null;
  };
}

/** One leaderboard across both market systems, keyed on the KAX principal. */
export async function unifiedLeaderboard(fetchImpl: typeof fetch = fetch): Promise<{
  source: "ghostsignals+kax-labs";
  traders: LeaderboardRow[];
  note: string;
}> {
  const [traders, resolve] = await Promise.all([fetchHubLeaderboard(fetchImpl), principalResolver()]);
  const rows: LeaderboardRow[] = traders.map((t) => ({
    kaxPrincipal: resolve(t),
    hubId: t.id,
    name: t.display_name ?? t.id,
    capital: t.capital ?? 0,
    reputation: t.reputation ?? 0,
    trades: t.trades_total ?? 0,
    accuracy: typeof t.accuracy === "number" ? t.accuracy : null,
  }));
  return {
    source: "ghostsignals+kax-labs",
    traders: rows,
    note: "The GhostSignals hub spans both market sources (kannaka-labs + kannaka-radio); this is the KAX-keyed view of its Brier-scored leaderboard (KAX-ADR-0004 Phase 1, read-only federation).",
  };
}

/** One agent's forecast record, found by its KAX principal. */
export async function forecastRecord(principal: string, fetchImpl: typeof fetch = fetch): Promise<LeaderboardRow | null> {
  const board = await unifiedLeaderboard(fetchImpl);
  return board.traders.find((r) => r.kaxPrincipal === principal) ?? null;
}

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
 * decision to be refined), but it is deliberately CONSERVATIVE: a hub trader
 * resolves only on an UNAMBIGUOUS, ANCHORED match — its id (dashes stripped,
 * ≥8 hex) being a PREFIX of exactly one agent's bot uuid, or an exact
 * display-name/slug match to exactly one agent. Anything ambiguous (a short
 * id, an empty id, a name shared by two agents, a fragment that prefixes two
 * bot ids) resolves to NULL, never to a guess. Mis-attributing one agent's
 * forecast record to another's KAX identity would be worse than admitting we
 * cannot map it yet, so the board stays honest: it shows the account, keyed by
 * its hub id, with a null principal.
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

/** Strip dashes and lowercase — the canonical hex form of a uuid/id fragment. */
function hex(s: string): string {
  return s.replace(/-/g, "").toLowerCase();
}

/** The single principal a set resolves to, or null when empty OR ambiguous. */
function only(set: Set<string> | undefined): string | null {
  return set && set.size === 1 ? [...set][0]! : null;
}

/** Build the hub-id/name → kax:agent principal resolver from the agents table. */
async function principalResolver(): Promise<(t: HubTrader) => string | null> {
  const agents = await db
    .select({ slug: agentsTable.slug, displayName: agentsTable.displayName, obcBotId: agentsTable.obcBotId })
    .from(agentsTable);
  // Name/slug keys map to a SET of principals so a shared display name (the
  // column is not unique) resolves to null (ambiguous), never last-writer-wins.
  const byName = new Map<string, Set<string>>();
  const byBot: Array<{ botHex: string; principal: string }> = [];
  const addName = (key: string, principal: string) => {
    const k = key.trim().toLowerCase();
    if (!k) return;
    (byName.get(k) ?? byName.set(k, new Set()).get(k)!).add(principal);
  };
  for (const a of agents) {
    if (!a.obcBotId) continue;
    const principal = `kax:agent:${a.obcBotId}`;
    addName(a.displayName, principal);
    addName(a.slug, principal);
    const bh = hex(a.obcBotId);
    if (bh.length >= 8) byBot.push({ botHex: bh, principal });
  }
  return (t: HubTrader) => {
    // Untrusted JSON: id is typed string but may be missing/non-string.
    const idHex = hex(String(t.id ?? ""));
    // A hub id resolves by bot only when it is a long-enough ANCHORED prefix of
    // exactly one bot uuid. ≥8 hex (a full GhostSignals short id); a prefix,
    // not a substring; and unique — two agents prefixed by it is ambiguous → null.
    if (idHex.length >= 8) {
      const hits = new Set(byBot.filter((b) => b.botHex.startsWith(idHex)).map((b) => b.principal));
      if (hits.size >= 1) return hits.size === 1 ? [...hits][0]! : null;
      // 0 bot matches: fall through to the name map.
    }
    return only(byName.get(String(t.display_name ?? "").trim().toLowerCase()));
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

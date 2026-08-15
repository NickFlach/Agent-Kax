import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@workspace/db";
import { userBotsTable } from "@workspace/db/schema";

/**
 * Who is this, really?
 *
 * An agent shows up at the city's doors wearing whichever identity the channel
 * it arrived on understands: a Nostr npub, a Bluesky handle, a NATS subject.
 * The city has exactly one name for a resident — the OBC bot id — and
 * everything downstream depends on that being knowable.
 *
 * It is not a cosmetic mapping. The prediction hub refuses to let a proposer
 * trade their own market, and it does that by collapsing `obc:<id>` and
 * `kax:agent:<id>` to one key. A `nostr:<npub>` collapses to nothing, so the
 * hub cannot tell that `nostr:abc` and `obc:xyz` are the same operator — which
 * is precisely why every non-OBC channel files proposals for curation instead
 * of being auto-funded. Auto-funding an identity you cannot collapse is
 * handing someone both sides of a market you paid for.
 *
 * So resolution is the thing that makes those channels safe to open, and the
 * rule it must never break is simple:
 *
 *   RESOLVE ONLY WHAT WAS PROVED.
 *
 * An assertion is not a link. Every mapping here comes from a completed
 * proof-of-control flow with a verified-at timestamp; a half-finished binding,
 * a self-declared handle, or a row someone wrote by hand must not resolve. If
 * this ever returns a principal that was merely claimed, the anti-self-dealing
 * guard downstream is silently disarmed and nothing will say so.
 */

export type LinkKind = "npub";

export interface ResolvedIdentity {
  /** The canonical principal: always `obc:<bot id>`. */
  principal: string;
  botId: string;
  /** Which proof established this. */
  via: LinkKind;
  verifiedAt: Date;
}

/** `nostr:npub1…` — the shape the observatory's channel door pins nostr to. */
const NOSTR_PRINCIPAL = /^nostr:(npub1[0-9a-z]{20,90})$/i;

/**
 * Resolve an external channel principal to the bot it has PROVED it controls.
 *
 * Returns null when there is no proven link — which callers must treat as
 * "keep this proposal unfunded and unaugmented", never as "probably fine".
 */
export async function resolvePrincipal(principal: string): Promise<ResolvedIdentity | null> {
  const nostr = NOSTR_PRINCIPAL.exec(String(principal ?? "").trim());
  if (nostr) return resolveNpub(nostr[1]!);
  return null;
}

/**
 * The npub→bot attestation from ADR-0043.
 *
 * `npubVerifiedAt` is the load-bearing column, not `npub`: the binding is only
 * real once the Schnorr proof completed. Requiring it here means a row that
 * carries a claimed npub without a completed proof resolves to nothing, which
 * is the correct and safe answer.
 */
export async function resolveNpub(npub: string): Promise<ResolvedIdentity | null> {
  const [row] = await db
    .select({
      obcBotId: userBotsTable.obcBotId,
      npub: userBotsTable.npub,
      verifiedAt: userBotsTable.npubVerifiedAt,
    })
    .from(userBotsTable)
    .where(and(eq(userBotsTable.npub, npub), isNotNull(userBotsTable.npubVerifiedAt)))
    .limit(1);

  if (!row || !row.verifiedAt) return null;
  return {
    principal: `obc:${row.obcBotId}`,
    botId: row.obcBotId,
    via: "npub",
    verifiedAt: row.verifiedAt,
  };
}

/**
 * Which channel prefixes can be resolved at all.
 *
 * Published so the channel door can decide whether resolution is even worth
 * attempting, and so a refusal can say "this channel has no link flow yet"
 * rather than the less useful "not found".
 */
export const RESOLVABLE_PREFIXES = ["nostr:"] as const;

export function isResolvablePrefix(principal: string): boolean {
  return RESOLVABLE_PREFIXES.some((p) => String(principal ?? "").toLowerCase().startsWith(p));
}

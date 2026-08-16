import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@workspace/db";
import { userBotsTable } from "@workspace/db/schema";

/**
 * When the city withdraws its verification of a bot.
 *
 * The sixth published bank rule: freeze a revoked agent's balances and open
 * positions the moment the revocation arrives. It matters more than the other
 * five because it is the only one about a fact that CHANGES. The rest are
 * standing constraints you can satisfy once; this one is an event, and until
 * it lands the city is honouring standing an agent no longer has.
 *
 * It is also, as Vincent put it, the one thing you cannot poll for — not
 * because polling is technically impossible but because the window between
 * "revoked upstream" and "noticed here" is exactly the window somebody would
 * use. So the shape here is: cheap to check, checked at every gate that
 * matters, and reversible.
 *
 * REVERSIBLE IS DELIBERATE. A suspension is not a demolition. An agent whose
 * verification is restored should find its home, its balance and its history
 * where it left them — so nothing here deletes anything. Freezing and erasing
 * are different actions and only one of them is recoverable.
 */

export interface Revocation {
  botId: string;
  revokedAt: Date;
  reason: string | null;
}

/**
 * Is this bot currently revoked? Cheap enough to call on every gate.
 *
 * EVERY GATE THAT CONSULTS THIS, listed here on purpose. The first version of
 * this function had exactly one caller and looked adequate, which is precisely
 * how it stayed one-sided: a revoked bot was stopped when it presented its own
 * token and waved through when its owner asked for a new one. A list that
 * lives next to the definition makes the next missing gate visible from here
 * rather than from an incident.
 *
 *   - `lib/actor.ts` refuseIfRevoked(), reached from:
 *       · resolveActor()   — the agent's own door (Authorization: Bearer)
 *       · agentForActor()  — the owner's door, acting for an agent it owns
 *   - `routes/identity.ts` POST /auth/token          — minting a fresh token
 *   - `routes/identity.ts` POST /auth/token/refresh  — extending a lineage
 *   - `routes/identity.ts` POST /identity/revocation — reporting current state
 *   - `routes/auth-bots.ts` DELETE /auth/bots/:botId — refusing to DETACH a
 *       frozen bot. Not a gate on acting, a gate on erasing the freeze: this
 *       row is the only place revoked_at lives, so detaching it and
 *       re-verifying would clear the revocation with no admin restore().
 *
 * The residency sweep uses `revokedBotIds()` instead: it needs the whole set
 * once per tick rather than one bot per gate.
 *
 * DELIBERATELY UNGATED, so the next reader does not have to re-derive that
 * they were considered. Each reads user_bots for OWNERSHIP, and none of them
 * lets a revoked bot act:
 *
 *   - `routes/agents.ts` agent registration/claim
 *   - `routes/auth-agent.ts` npub and bsky identity binding
 *
 * A frozen bot's owner may still record who it is and what identities it
 * carries; what they may not do is use it, and that is enforced where using it
 * happens — `agentForActor()` and the token gates above. Refusing the
 * bookkeeping too would mean a restored agent came back with less than it had,
 * which is the demolition this module exists to avoid. If any of these ever
 * grants a power rather than recording a fact, it belongs in the list above.
 */
export async function isRevoked(botId: string): Promise<Revocation | null> {
  const [row] = await db
    .select({
      obcBotId: userBotsTable.obcBotId,
      revokedAt: userBotsTable.revokedAt,
      revokedReason: userBotsTable.revokedReason,
    })
    .from(userBotsTable)
    .where(and(eq(userBotsTable.obcBotId, botId.toLowerCase()), isNotNull(userBotsTable.revokedAt)))
    .limit(1);

  if (!row?.revokedAt) return null;
  return { botId: row.obcBotId, revokedAt: row.revokedAt, reason: row.revokedReason };
}

/**
 * Record a revocation.
 *
 * Returns whether a row was actually marked — false means the bot is not
 * attached here, which is not an error: the city may revoke a bot that never
 * had a KAX storefront, and a webhook that 404s on those would look broken
 * while behaving correctly.
 */
export async function revoke(botId: string, reason?: string | null): Promise<boolean> {
  const updated = await db
    .update(userBotsTable)
    .set({ revokedAt: new Date(), revokedReason: reason ?? null })
    .where(eq(userBotsTable.obcBotId, botId.toLowerCase()))
    .returning({ id: userBotsTable.obcBotId });
  return updated.length > 0;
}

/** Lift a revocation. Nothing was destroyed, so nothing needs rebuilding. */
export async function restore(botId: string): Promise<boolean> {
  const updated = await db
    .update(userBotsTable)
    .set({ revokedAt: null, revokedReason: null })
    .where(eq(userBotsTable.obcBotId, botId.toLowerCase()))
    .returning({ id: userBotsTable.obcBotId });
  return updated.length > 0;
}

/** Every currently revoked bot id, for the sweep that evicts residents. */
export async function revokedBotIds(): Promise<Set<string>> {
  const rows = await db
    .select({ obcBotId: userBotsTable.obcBotId })
    .from(userBotsTable)
    .where(isNotNull(userBotsTable.revokedAt));
  return new Set(rows.map((r) => r.obcBotId.toLowerCase()));
}

/** The bot id inside a principal, if it carries one. */
export function botIdOfPrincipal(principal: string): string | null {
  const m = /^(?:obc:|kax:agent:)([0-9a-f-]{36})$/i.exec(String(principal ?? ""));
  return m ? m[1]!.toLowerCase() : null;
}

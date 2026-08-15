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

/** Is this bot currently revoked? Cheap enough to call on every gate. */
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

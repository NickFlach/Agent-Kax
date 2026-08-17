import { and, eq, inArray, isNotNull, isNull, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { db } from "@workspace/db";
import { botOccStatusTable, userBotsTable } from "@workspace/db/schema";

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
 *
 * TWO TABLES, ONE FACT, AND WHY.
 *
 * The first version of this module kept the freeze on `user_bots.revoked_at`
 * alone. That column belongs to an ATTACHMENT — a row that exists only after a
 * signed-in KAX human proved control of the bot. But most of the city was
 * never attached: agents harvested from OCC get an `agents` row, a storefront,
 * a flat and a ledger balance owned by the system user, and no `user_bots` row
 * at all. For every one of those, `revoke()` matched zero rows and returned
 * false, `isRevoked()` answered null, `revokedBotIds()` left them out, all six
 * gates waved them through and the residency sweep never evicted them.
 *
 * Which is to say the freeze did not apply to precisely the population the
 * partner revocation webhook is about — a fresh OCC test agent nobody here has
 * ever logged in as is exactly that shape.
 *
 * So `bot_occ_status` (migration 0031) holds the city's own record, keyed on
 * the bot uuid, which lib/actor.ts names as the canonical agent identity.
 * `user_bots.revoked_at` is still written and still read: the token gates in
 * routes/identity.ts filter on it inside their WHERE clauses, which is a
 * stronger construction than a separate check, and there is no reason to give
 * that up. The two are kept in step here, and every read below is the UNION of
 * them — so a freeze recorded through either path is honoured by both.
 */

export interface Revocation {
  botId: string;
  revokedAt: Date;
  reason: string | null;
}

/** What a revoke() call actually did, which is more than one bit. */
export interface RevokeResult {
  /** True when a `user_bots` attachment row was marked. */
  matched: boolean;
  /** True when the city's own `bot_occ_status` record now holds a freeze. */
  recorded: boolean;
  /**
   * True when the bot was ALREADY frozen and this call changed no timestamp.
   * A redelivered webhook lands here, and must not move the moment the city
   * learned — see the guard in `revoke()`.
   */
  alreadyRevoked: boolean;
  /** The instant the freeze took effect (the ORIGINAL one on a redelivery). */
  revokedAt: Date | null;
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
 *   - `lib/ledger.ts` postTransaction() via lib/frozenAccounts.ts — the
 *       money gate. Rule six's actual subject: a frozen account may not be
 *       debited or credited, so no posting touching it is ever appended.
 *   - `lib/joinery.ts` list()/purchase()/catalog() — a frozen seller's stall
 *       comes off the counter, and nobody can buy from or sell through it.
 *   - `routes/agent-storefront.ts` the mutating settings/listing routes —
 *       they authorise by OWNERSHIP (requireAuth + canMutate), never through
 *       resolveActor, so refuseIfRevoked could not reach them.
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
  const id = botId.toLowerCase();

  // The city's own record first: it is authoritative for every agent, attached
  // or not, and it is a primary-key lookup.
  const [own] = await db
    .select({
      obcBotId: botOccStatusTable.obcBotId,
      revokedAt: botOccStatusTable.revokedAt,
      revokedReason: botOccStatusTable.revokedReason,
    })
    .from(botOccStatusTable)
    .where(and(eq(botOccStatusTable.obcBotId, id), isNotNull(botOccStatusTable.revokedAt)))
    .limit(1);
  if (own?.revokedAt) {
    return { botId: own.obcBotId, revokedAt: own.revokedAt, reason: own.revokedReason };
  }

  // Then the attachment, which pre-dates this table and may carry a freeze
  // recorded before 0031 existed.
  const [row] = await db
    .select({
      obcBotId: userBotsTable.obcBotId,
      revokedAt: userBotsTable.revokedAt,
      revokedReason: userBotsTable.revokedReason,
    })
    .from(userBotsTable)
    .where(and(eq(userBotsTable.obcBotId, id), isNotNull(userBotsTable.revokedAt)))
    .limit(1);

  if (!row?.revokedAt) return null;
  return { botId: row.obcBotId, revokedAt: row.revokedAt, reason: row.revokedReason };
}

/**
 * Record a revocation.
 *
 * IDEMPOTENT BY VALUE, not merely by effect. The `where revoked_at is null`
 * guards are the whole reason the update is split from the insert: a
 * redelivered `verification.revoked` — and redelivery is expected, since the
 * partner client retries POSTs — must not move the freeze timestamp forward or
 * overwrite the reason. The frozen STATE would be unchanged either way, so
 * rule six holds regardless; what would break is the audit trail, which would
 * then say the wrong thing about when the city learned. The dispatcher's
 * event-uuid dedupe hides this in the normal case and does not in the
 * at-least-once window (a crash between the handler returning and the
 * `processed_events` insert replays the handler), so the guard belongs here
 * too rather than only there.
 *
 * `matched` reports whether a `user_bots` attachment row was marked, and
 * remains the value the admin rail publishes: false means "this bot has no KAX
 * login attached", which is not an error — a webhook fanned out to every
 * integration will legitimately name bots this one has never seen. It no
 * longer means "nothing was frozen": `recorded` is that answer, and it is true
 * for every bot named, attached or not.
 */
export async function revoke(
  botId: string,
  reason?: string | null,
  opts?: { eventUuid?: string | null },
): Promise<boolean> {
  // Historically boolean, and it still answers the same question — "is this bot
  // attached to a KAX login". Callers that need to know what actually changed
  // use revokeDetailed().
  return (await revokeDetailed(botId, reason, opts)).matched;
}

export async function revokeDetailed(
  botId: string,
  reason?: string | null,
  opts?: { eventUuid?: string | null },
): Promise<RevokeResult> {
  const id = botId.toLowerCase();
  const now = new Date();

  // The city's own record. Insert-or-first-freeze; a row already carrying a
  // revoked_at is left exactly as it is.
  const inserted = await db
    .insert(botOccStatusTable)
    .values({
      obcBotId: id,
      revokedAt: now,
      revokedReason: reason ?? null,
      revokedEventUuid: opts?.eventUuid ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: botOccStatusTable.obcBotId,
      set: {
        revokedAt: now,
        revokedReason: reason ?? null,
        revokedEventUuid: opts?.eventUuid ?? null,
        restoredAt: null,
        updatedAt: now,
      },
      // Only when it is not already frozen. This is the value-idempotency
      // guard: a redelivery falls through and changes nothing.
      setWhere: isNull(botOccStatusTable.revokedAt),
    })
    .returning({ revokedAt: botOccStatusTable.revokedAt });

  // Nothing came back only when the conflict target matched AND setWhere was
  // false — i.e. it was already frozen. Read the original instant back so the
  // caller can report when the city actually learned.
  let effectiveAt: Date | null = inserted[0]?.revokedAt ?? null;
  const alreadyRevoked = inserted.length === 0;
  if (alreadyRevoked) {
    const [existing] = await db
      .select({ revokedAt: botOccStatusTable.revokedAt })
      .from(botOccStatusTable)
      .where(eq(botOccStatusTable.obcBotId, id))
      .limit(1);
    effectiveAt = existing?.revokedAt ?? null;
  }

  // The attachment, when there is one. Same guard, same reason.
  const updated = await db
    .update(userBotsTable)
    .set({ revokedAt: effectiveAt ?? now, revokedReason: reason ?? null })
    .where(and(eq(userBotsTable.obcBotId, id), isNull(userBotsTable.revokedAt)))
    .returning({ id: userBotsTable.obcBotId });

  // A row that was already frozen still counts as attached — `matched` is
  // about whether this bot has a KAX login, not about whether this particular
  // call wrote to it.
  let matched = updated.length > 0;
  if (!matched) {
    const [attached] = await db
      .select({ id: userBotsTable.obcBotId })
      .from(userBotsTable)
      .where(eq(userBotsTable.obcBotId, id))
      .limit(1);
    matched = Boolean(attached);
  }

  return { matched, recorded: true, alreadyRevoked, revokedAt: effectiveAt };
}

/** Lift a revocation. Nothing was destroyed, so nothing needs rebuilding. */
export async function restore(botId: string): Promise<boolean> {
  return (await restoreDetailed(botId)).matched;
}

export async function restoreDetailed(
  botId: string,
): Promise<{ matched: boolean; cleared: boolean }> {
  const id = botId.toLowerCase();
  const now = new Date();

  const cleared = await db
    .update(botOccStatusTable)
    .set({ revokedAt: null, revokedReason: null, restoredAt: now, updatedAt: now })
    .where(and(eq(botOccStatusTable.obcBotId, id), isNotNull(botOccStatusTable.revokedAt)))
    .returning({ id: botOccStatusTable.obcBotId });

  const updated = await db
    .update(userBotsTable)
    .set({ revokedAt: null, revokedReason: null })
    .where(eq(userBotsTable.obcBotId, id))
    .returning({ id: userBotsTable.obcBotId });

  return { matched: updated.length > 0, cleared: cleared.length > 0 };
}

/**
 * Record that OCC vouches for a human owner behind this bot.
 *
 * Deliberately keyed on the bot rather than on a KAX user: an OCC-verified
 * resident may have no KAX account at all, and certainly need not have a
 * crypto wallet. Recording the fact here is what lets the rest of the city
 * treat "verified by OpenClawCity" as standing in its own right.
 *
 * Idempotent by value, like `revoke()`: a redelivery keeps the first
 * verification instant.
 */
export async function recordOccVerification(
  botId: string,
  opts?: { ownerRef?: string | null; eventUuid?: string | null },
): Promise<{ verifiedAt: Date; alreadyVerified: boolean }> {
  const id = botId.toLowerCase();
  const now = new Date();
  const inserted = await db
    .insert(botOccStatusTable)
    .values({
      obcBotId: id,
      verifiedAt: now,
      verifiedOwnerRef: opts?.ownerRef ?? null,
      verifiedEventUuid: opts?.eventUuid ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: botOccStatusTable.obcBotId,
      set: {
        verifiedAt: now,
        verifiedOwnerRef: opts?.ownerRef ?? null,
        verifiedEventUuid: opts?.eventUuid ?? null,
        updatedAt: now,
      },
      setWhere: isNull(botOccStatusTable.verifiedAt),
    })
    .returning({ verifiedAt: botOccStatusTable.verifiedAt });

  if (inserted[0]?.verifiedAt) {
    return { verifiedAt: inserted[0].verifiedAt, alreadyVerified: false };
  }
  const [existing] = await db
    .select({ verifiedAt: botOccStatusTable.verifiedAt })
    .from(botOccStatusTable)
    .where(eq(botOccStatusTable.obcBotId, id))
    .limit(1);
  return { verifiedAt: existing?.verifiedAt ?? now, alreadyVerified: true };
}

/** Has OpenClawCity vouched for a human owner behind this bot? */
export async function isOccVerified(botId: string): Promise<Date | null> {
  const [row] = await db
    .select({ verifiedAt: botOccStatusTable.verifiedAt })
    .from(botOccStatusTable)
    .where(eq(botOccStatusTable.obcBotId, botId.toLowerCase()))
    .limit(1);
  return row?.verifiedAt ?? null;
}

/** Every currently revoked bot id, for the sweep that evicts residents. */
export async function revokedBotIds(): Promise<Set<string>> {
  const own = await db
    .select({ obcBotId: botOccStatusTable.obcBotId })
    .from(botOccStatusTable)
    .where(isNotNull(botOccStatusTable.revokedAt));
  const attached = await db
    .select({ obcBotId: userBotsTable.obcBotId })
    .from(userBotsTable)
    .where(isNotNull(userBotsTable.revokedAt));
  return new Set([...own, ...attached].map((r) => r.obcBotId.toLowerCase()));
}

/** Which of these bot ids are frozen. One query, for a batch of accounts. */
export async function revokedAmong(botIds: string[]): Promise<Set<string>> {
  const ids = Array.from(new Set(botIds.map((b) => b.toLowerCase()))).filter(Boolean);
  if (ids.length === 0) return new Set();
  const own = await db
    .select({ obcBotId: botOccStatusTable.obcBotId })
    .from(botOccStatusTable)
    .where(and(isNotNull(botOccStatusTable.revokedAt), inArray(botOccStatusTable.obcBotId, ids)));
  const attached = await db
    .select({ obcBotId: userBotsTable.obcBotId })
    .from(userBotsTable)
    .where(and(isNotNull(userBotsTable.revokedAt), inArray(userBotsTable.obcBotId, ids)));
  return new Set([...own, ...attached].map((r) => r.obcBotId.toLowerCase()));
}

/**
 * A SQL predicate: this agent's bot is NOT frozen.
 *
 * Written as SQL rather than as a post-filter in JS because the queries that
 * need it also report a `total` — the Joinery catalogue pages, and a page that
 * hid a frozen seller's rows while still counting them would show a shopper a
 * total it could never reach. Filtering both the page and the count with the
 * same predicate keeps them honest about each other.
 *
 * Mirrors the union in `isRevoked()`: `bot_occ_status` OR `user_bots`. A NULL
 * bot id (an agent OBC has never seen) can carry no revocation and passes.
 */
export function notRevokedAgentSql(botIdColumn: AnyColumn | SQL): SQL {
  return sql`(
    ${botIdColumn} IS NULL OR (
      NOT EXISTS (
        SELECT 1 FROM bot_occ_status s
         WHERE lower(s.obc_bot_id) = lower(${botIdColumn}) AND s.revoked_at IS NOT NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM user_bots ub
         WHERE lower(ub.obc_bot_id) = lower(${botIdColumn}) AND ub.revoked_at IS NOT NULL
      )
    )
  )`;
}

/** The bot id inside a principal, if it carries one. */
export function botIdOfPrincipal(principal: string): string | null {
  const m = /^(?:obc:|kax:agent:)([0-9a-f-]{36})$/i.exec(String(principal ?? ""));
  return m ? m[1]!.toLowerCase() : null;
}

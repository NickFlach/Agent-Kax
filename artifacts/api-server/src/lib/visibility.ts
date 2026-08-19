/**
 * visibility.ts — single source of truth for "is this artifact / drop
 * publicly visible right now?"
 *
 * Multiple public routes had drifted versions of this check (#3, #5, #6,
 * #7, #9, #12). Some checked only the drop's status, some checked only
 * the artifact's score, and several didn't check at all — letting raw
 * / unnarrated / unminted records leak through ID-guessing.
 *
 * The contract here:
 *
 *   - A *drop* is public iff `drops.status = 'published'`.
 *   - An *artifact* is public iff BOTH:
 *       (a) it's attached to a published drop, AND
 *       (b) its own `artifacts.status` is one of PUBLISHABLE_STATUSES.
 *
 * The status floor matters: the private drop-management route lets an
 * owner attach an artifact to a drop *and forcibly stamps its status
 * to 'dropped'* without going through score → narrate. Without the
 * status floor, a published drop becomes a back door to raw / scored
 * artifacts that were never intended for the public.
 *
 * Use `isArtifactPublic` for in-memory checks; use `artifactPublicJoin`
 * to push the filter into the SQL.
 */

import { db } from "@workspace/db";
import {
  artifactsTable,
  dropsTable,
  userBotsTable,
  type Artifact,
  type Drop,
} from "@workspace/db/schema";
import { eq, and, inArray, isNull, sql, type SQL } from "drizzle-orm";

/** Artifact statuses that may appear on a public surface when attached to a published drop. */
export const PUBLISHABLE_STATUSES = ["narrated", "dropped"] as const;
export type PublishableStatus = (typeof PUBLISHABLE_STATUSES)[number];

export function isPublishableStatus(s: string | null | undefined): s is PublishableStatus {
  return s != null && (PUBLISHABLE_STATUSES as readonly string[]).includes(s);
}

/**
 * Sync check for an artifact + its (optionally already-fetched) drop.
 * Pass undefined for `drop` only when you've already verified upstream
 * that the artifact's drop is published.
 * Pass null when the drop was fetched but not found in the DB — treated
 * as not public regardless of artifact status.
 */
export function isArtifactPublic(a: Artifact, drop?: Pick<Drop, "status"> | null): boolean {
  if (a.dropId == null) return false;
  if (!isPublishableStatus(a.status)) return false;
  // null means the DB lookup found nothing — the artifact's dropId is
  // orphaned; treat it as not public.
  if (drop === null) return false;
  if (drop && drop.status !== "published") return false;
  return true;
}

/**
 * Drizzle WHERE clause that constrains a query to artifacts whose
 * `dropId` references a published drop AND whose own status is in
 * the publishable set.
 *
 * Usage:
 *   db.select().from(artifactsTable).where(publicArtifactWhere())
 *
 * Implemented as a sub-select on dropsTable so callers don't need to
 * thread an explicit join through every existing select shape.
 */
export function publicArtifactWhere(): SQL {
  const publishedDropIds = db
    .select({ id: dropsTable.id })
    .from(dropsTable)
    .where(eq(dropsTable.status, "published"));
  return and(
    sql`${artifactsTable.dropId} IS NOT NULL`,
    inArray(artifactsTable.dropId, publishedDropIds),
    inArray(
      artifactsTable.status,
      [...PUBLISHABLE_STATUSES] as PublishableStatus[],
    ),
  )!;
}

/**
 * Look up an artifact by id only if it is publicly visible right now.
 * Returns null otherwise — callers must NOT 404 with extra leaked info
 * (e.g. "exists but private"); just say "not found".
 */
export async function getPublicArtifact(id: number): Promise<Artifact | null> {
  const [row] = await db
    .select()
    .from(artifactsTable)
    .where(and(eq(artifactsTable.id, id), publicArtifactWhere()))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Commerce eligibility (#256, KAX-ADR-0002). The repo's THIRD visibility
// predicate, named and defined once — deliberately independent of the two
// above. Public visibility asks "may anyone see this?"; storefront visibility
// (agent-storefront.ts) deliberately asks nothing; commerce eligibility asks
// "does the REQUESTING PRINCIPAL control the bot OBC names as creator?".
// A route that wants "sellable" must call this, never improvise a fourth.
//
// What this proves, precisely: the requesting user has a live (non-revoked)
// user_bots attachment to the artifact's creator_bot_id. What it does NOT
// prove: that the bot actually created the work — creator_bot_id arrives from
// OBC's partner feed and KAX never independently verifies authorship. That
// gap belongs to the rights preflight's human half, not to this predicate.
// ---------------------------------------------------------------------------

/**
 * Drizzle WHERE clause constraining a query to artifacts commerce-eligible
 * for `userId`: a creator bot is on record, and it is attached to this user
 * with the attachment not revoked. Sub-select for the same reason as
 * publicArtifactWhere — callers keep their select shape.
 */
export function commerceEligibleWhere(userId: string): SQL {
  const controlledBotIds = db
    .select({ botId: userBotsTable.obcBotId })
    .from(userBotsTable)
    .where(and(eq(userBotsTable.userId, userId), isNull(userBotsTable.revokedAt)));
  return and(
    sql`${artifactsTable.creatorBotId} IS NOT NULL`,
    inArray(artifactsTable.creatorBotId, controlledBotIds),
  )!;
}

/**
 * Single-artifact check with a DISTINCT reason per failure, so a form
 * mismatch is never mistaken for a rights denial (#256 AC). Reasons are
 * stable strings — receipts and support both grep them.
 *
 * The not-attached-to-you reason deliberately does not distinguish "attached
 * to somebody else" from "attached to nobody": the caller's remedy is the
 * same (attach the bot), and the difference is another user's business.
 */
export async function isCommerceEligible(
  artifactId: number,
  userId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [a] = await db
    .select({ creatorBotId: artifactsTable.creatorBotId })
    .from(artifactsTable)
    .where(eq(artifactsTable.id, artifactId))
    .limit(1);
  if (!a) return { ok: false, reason: "artifact not found" };
  if (a.creatorBotId == null) {
    return { ok: false, reason: "artifact has no creator bot on record" };
  }
  const [attachment] = await db
    .select({ userId: userBotsTable.userId, revokedAt: userBotsTable.revokedAt })
    .from(userBotsTable)
    .where(eq(userBotsTable.obcBotId, a.creatorBotId))
    .limit(1);
  if (!attachment || attachment.userId !== userId) {
    return { ok: false, reason: "creator bot is not attached to the requesting principal" };
  }
  if (attachment.revokedAt != null) {
    return { ok: false, reason: "the creator bot's attachment is revoked" };
  }
  return { ok: true };
}

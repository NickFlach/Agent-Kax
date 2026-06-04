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
  type Artifact,
  type Drop,
} from "@workspace/db/schema";
import { eq, and, inArray, sql, type SQL } from "drizzle-orm";

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

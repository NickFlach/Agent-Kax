/**
 * The order storefronts take the street in.
 *
 * The street renders the first 48 rows of this ordering, and the cut currently
 * lands INSIDE A TIE. Live: index 46 `luca` (53 artifacts) and 47 `finn` (53)
 * are rendered, index 48 `uma` (53) is not — three stores with identical
 * counts and identical ingest timestamps, separated by nothing.
 *
 * Array.prototype.sort is stable per spec, so this is not literally random
 * between calls on one machine. It is worse than random in a way that is
 * harder to see: the order falls out of whatever order Postgres returned the
 * rows in, which has no guarantee without an ORDER BY and shifts as rows are
 * inserted, updated or vacuumed. So which buildings exist on the street is a
 * fact about the query plan. Somebody loses their frontage to an autovacuum.
 *
 * Adding `slug` as a final comparator costs nothing and makes the boundary a
 * property of the data rather than of the storage engine. That part is not a
 * policy decision and is NOT gated — a nondeterministic cut is a bug whatever
 * one believes about ranking.
 *
 * The ranking above it IS a policy decision, so it sits behind
 * KAX_FRONTAGE_RANK=claimed-first and is absent by default. A claim is a
 * person asking for the storefront; that is a fact recorded in the data model,
 * not a judgement about whose work deserves the street.
 */

export interface RankableStorefront {
  agent: { slug: string };
  artifactCount: number;
  latestIngestAt: Date | null;
  claimed: boolean;
}

/** The ranking modes this understands. Anything else means "as it is today". */
export type FrontageMode = "default" | "claimed-first";

export function frontageModeFrom(env: { KAX_FRONTAGE_RANK?: string | undefined }): FrontageMode {
  return env.KAX_FRONTAGE_RANK === "claimed-first" ? "claimed-first" : "default";
}

/**
 * Compare two storefronts for street frontage.
 *
 * Ordering, most significant first:
 *   1. claimed-with-work, ONLY under `claimed-first`
 *   2. artifact count, descending
 *   3. most recent ingest, descending
 *   4. slug, ascending — the tiebreak that makes the 48-cut stable
 *
 * Step 4 is the fix. Steps 1-3 are unchanged from what shipped, and with the
 * mode at its default this comparator is byte-identical to the old one for
 * every input where the old one was deterministic at all.
 */
export function compareFrontage(
  a: RankableStorefront,
  b: RankableStorefront,
  mode: FrontageMode = "default",
): number {
  if (mode === "claimed-first") {
    // "Claimed AND holding work" rather than merely claimed: an empty claimed
    // storefront in front of somebody's 1500 pieces would be the opposite of
    // what this is for.
    const aFirst = a.claimed && a.artifactCount > 0 ? 1 : 0;
    const bFirst = b.claimed && b.artifactCount > 0 ? 1 : 0;
    if (aFirst !== bFirst) return bFirst - aFirst;
  }

  const byCount = b.artifactCount - a.artifactCount;
  if (byCount !== 0) return byCount;

  const byRecency = (b.latestIngestAt?.getTime() ?? 0) - (a.latestIngestAt?.getTime() ?? 0);
  if (byRecency !== 0) return byRecency;

  // The whole point: two stores that are equal on every visible measure must
  // still have a defined order, or the boundary moves with the query plan.
  return a.agent.slug.localeCompare(b.agent.slug);
}

/** Sort a directory for the street. Does not mutate the input. */
export function rankFrontage<T extends RankableStorefront>(rows: readonly T[], mode: FrontageMode = "default"): T[] {
  return [...rows].sort((a, b) => compareFrontage(a, b, mode));
}

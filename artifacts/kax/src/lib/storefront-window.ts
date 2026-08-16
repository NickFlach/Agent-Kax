/**
 * What card goes in an unclaimed storefront's window.
 *
 * The street used to ask one question — `!claimed && !constellation` — and put
 * FOR LEASE in the window whenever the answer was yes. But `claimed` means
 * "has a non-system owner" (storefrontDirectory.ts), NOT "empty". Those are
 * different facts, and conflating them made the city advertise its best
 * dormant work as vacant premises.
 *
 * Measured against the live directory on 2026-08-16: of 302 storefronts, 278
 * are unclaimed, and ALL 278 of them hold work. The median unclaimed store has
 * 24 artifacts. The largest is `rex` with 1534 — a body of work the street was
 * describing as an empty shop with a card reading "inquire at kax".
 *
 * So availability and emptiness get separated. Both cards still say the store
 * can be claimed, because that remains true; only one of them claims there is
 * nothing inside.
 *
 * The threshold is a judgement and worth owning: below three artifacts a
 * storefront is a harvest artefact rather than a body of work, and FOR LEASE
 * describes it fairly. From the live distribution that leaves 68 genuinely
 * sparse fronts still advertising, and stops the other 210 from disowning what
 * they hold. Set deliberately low — the failure this fixes is a store with
 * work reading as empty, and a store with two pieces reading as available is
 * not the same kind of wrong.
 */

/** Below this many artifacts, an unclaimed store is fairly called vacant. */
export const THIN_STOREFRONT_ARTIFACTS = 3;

export type WindowCard = "for-lease" | "unclaimed-with-works" | "none";

export interface StorefrontWindowInput {
  /** Has a non-system owner. NOT a statement about whether it holds work. */
  claimed: boolean;
  /** Constellation venues are civic buildings, never for lease. */
  source?: string | null | undefined;
  artifacts: number;
}

/**
 * Which card, if any, belongs in this window.
 *
 * Pure and exported so it can be tested without a Canvas: the bug was in the
 * predicate, not in the geometry, and a predicate that needs WebGL to check is
 * a predicate nobody checks.
 */
export function storefrontWindowCard(shop: StorefrontWindowInput): WindowCard {
  if (shop.source === "constellation") return "none";
  if (shop.claimed) return "none";
  // A negative or missing count is treated as thin rather than trusted — an
  // absent number should not promote a store to "has work".
  const artifacts = Number.isFinite(shop.artifacts) ? Math.max(0, shop.artifacts) : 0;
  return artifacts >= THIN_STOREFRONT_ARTIFACTS ? "unclaimed-with-works" : "for-lease";
}

/**
 * commerceFulfillmentStages.ts — the one ordered ladder a physical order climbs,
 * the translation of Printify's vocabulary onto it, and the buyer's view of
 * where on it their order actually is.
 *
 * Pure by construction. Nothing here imports `@workspace/db` — importing it
 * opens a connection pool — so the poller, the two buyer endpoints and the tests
 * can all reach it without a cycle, exactly as `commerceOrderStatus.ts` is pure
 * for the same reason.
 *
 * ## Why the ladder is written down once
 *
 * `fulfillment_state` is a varchar and not a pgEnum, deliberately: an unknown
 * enum literal in a WHERE clause is a 500 rather than a query that matches
 * nothing. That freedom is precisely why the ORDER of the values has to live in
 * one place. Three separate things need to agree about it — the poller deciding
 * whether a provider status is forward or backward, the buyer timeline deciding
 * which stage is current, and the admin listing — and a ladder spelled out at
 * each use site is a ladder that drifts. When it drifts, the failure is an order
 * that reports itself as being printed after it has already been delivered.
 *
 * ## Printify's words are Printify's, and unknown ones are not errors
 *
 * `PROVIDER_STATUS_TO_STATE` is keyed on Printify's own literals, normalised
 * only for punctuation and case. `in-production` — hyphenated — was captured
 * from a live response; the rest come from Printify's documented order
 * lifecycle. The map is deliberately not exhaustive of anything, because a
 * provider is free to add a status tomorrow and we will not be told.
 *
 * An unrecognised status therefore maps to `null`, and `null` means "learn
 * nothing, change nothing" — NOT "reset". A poller that treated an unknown word
 * as a reason to move an order would be worse than one that never looked: the
 * buyer would watch their delivered parcel walk backwards. The raw literal is
 * stored on the row either way, so an operator can find out what a new status is
 * rather than inferring it from an order that quietly stopped.
 */

/**
 * The states `fulfillment_state` can hold that are ON the ladder, in order.
 *
 * `canceled` is a seventh value of the column and is deliberately NOT here. It
 * is not a rung — it is a way of leaving the ladder — and giving it a rank would
 * make it either "before submitted" or "after delivered", both of which are
 * lies that the monotonic guard below would then enforce.
 */
export const FULFILLMENT_LADDER = [
  "unfulfilled",
  "submitted",
  "in_production",
  "shipped",
  "delivered",
] as const;

export type FulfillmentLadderState = (typeof FULFILLMENT_LADDER)[number];

/** The off-ladder terminal state. Reachable from any rung, and from none. */
export const FULFILLMENT_CANCELED = "canceled";

/**
 * How far up the ladder a state is, or -1 for anything that is not on it.
 *
 * -1 rather than a throw, because the column is a varchar and a value nobody
 * declared can genuinely be in it. The callers below all treat -1 as "I cannot
 * compare this", which is the honest answer and never a reason to write.
 */
export function ladderRank(state: string): number {
  return (FULFILLMENT_LADDER as readonly string[]).indexOf(state);
}

/**
 * Printify's status literal, reduced to a comparison key.
 *
 * Case folded and every run of punctuation collapsed to a single `-`, so
 * `in-production`, `IN_PRODUCTION` and `In Production` are one key. This is the
 * ONLY liberty taken with the provider's vocabulary: nothing is stemmed, no
 * prefix is matched and no word is guessed at, because a fuzzy match here would
 * silently adopt a status that means something else.
 */
export function normalizeProviderStatus(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/-+/g, "-");
}

/**
 * Printify's order lifecycle, mapped onto ours.
 *
 * `in-production` is the one value captured from a live response — the released
 * sticker order reported exactly that, hyphenated. The others are Printify's
 * documented statuses and are mapped by what they mean for the parcel rather
 * than by name:
 *
 * - Everything before manufacturing — the order exists at the printer and is
 *   waiting — is `submitted`. That is the truthful stage: we have handed it
 *   over and it has not started.
 * - `fulfilled` and `partially-fulfilled` are Printify's words for "it has left
 *   the building". There is no `shipped` literal in their lifecycle, and
 *   mapping `fulfilled` to anything other than our `shipped` would leave the
 *   shipped rung permanently unreachable — which is the bug this whole file
 *   exists to end.
 * - `has-issues` is deliberately absent. It is not a stage and it is not a
 *   rung: an order with issues is stuck wherever it already was, and the honest
 *   response is to leave the state alone and let the raw literal reach an
 *   operator through `provider_status`. Mapping it onto a rung would move an
 *   order on the strength of bad news.
 *
 * Printify has no `delivered` status at all; delivery arrives as a
 * `delivered_at` on a shipment, which the poller reads separately.
 */
export const PROVIDER_STATUS_TO_STATE: Readonly<
  Record<string, FulfillmentLadderState | typeof FULFILLMENT_CANCELED>
> = {
  // Handed over, not started.
  "pending": "submitted",
  "on-hold": "submitted",
  "payment-not-received": "submitted",
  "callback-received": "submitted",
  "checking-sending-to-production": "submitted",
  "sending-to-production": "submitted",
  // Being made. Captured live, hyphenated.
  "in-production": "in_production",
  // Gone to the carrier.
  "fulfilled": "shipped",
  "partially-fulfilled": "shipped",
  "shipped": "shipped",
  // Delivered is not one of Printify's statuses; it is kept because a provider
  // that starts sending it should be understood rather than ignored.
  "delivered": "delivered",
  // Off the ladder.
  "canceled": FULFILLMENT_CANCELED,
  "cancelled": FULFILLMENT_CANCELED,
  "canceled-by-provider": FULFILLMENT_CANCELED,
  "cancelled-by-provider": FULFILLMENT_CANCELED,
};

/**
 * What a provider status means for our state, or `null` for "we do not know".
 *
 * `null` is a first-class answer and never an error. See the header: an unknown
 * status must change nothing, and the caller records the raw literal regardless.
 */
export function mapProviderStatus(
  raw: string | null | undefined,
): FulfillmentLadderState | typeof FULFILLMENT_CANCELED | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  return PROVIDER_STATUS_TO_STATE[normalizeProviderStatus(raw)] ?? null;
}

/**
 * The state an order should be in after learning `observed`, given where it is.
 *
 * This is the monotonic guard and it is the single rule that keeps a poller from
 * doing damage. Three cases, in this order:
 *
 * 1. **Nothing observed** (an unknown or absent provider status) — stay put.
 * 2. **Cancellation** — always honoured, EXCEPT over a delivered order. A parcel
 *    that has arrived is not un-delivered by a late provider cancellation, and
 *    telling a buyer holding their sticker that their order was canceled is a
 *    worse lie than dropping the update.
 * 3. **Otherwise, forward only.** An order at `in_production` that the provider
 *    reports as `on-hold` stays at `in_production`. Printify's list is not a
 *    monotonic log — a status can be re-reported, an order can be re-queued, and
 *    a page can be stale — and a buyer watching their order walk backwards has
 *    been told something false by a feature whose entire purpose is telling them
 *    something true.
 *
 * A `current` value that is not on the ladder (an operator's hand-edit, a value
 * from a future version) is left alone entirely: rank -1 compares as behind
 * everything, and advancing off the back of a value we cannot place would be
 * exactly the silent regression this returns to prevent.
 */
export function nextFulfillmentState(current: string, observed: string | null): string {
  if (observed === null) return current;
  if (current === FULFILLMENT_CANCELED) return current;

  if (observed === FULFILLMENT_CANCELED) {
    return current === "delivered" ? current : FULFILLMENT_CANCELED;
  }

  const currentRank = ladderRank(current);
  const observedRank = ladderRank(observed);
  if (currentRank < 0 || observedRank < 0) return current;
  return observedRank > currentRank ? observed : current;
}

// ---------------------------------------------------------------------------
// The buyer's timeline
// ---------------------------------------------------------------------------

/**
 * Attempts at which the automatic worker gives up and parks an order.
 *
 * It lives HERE rather than in `commerceFulfillmentWorker.ts` — which
 * re-exports it, so nothing that already imports it from there had to change —
 * because the buyer timeline has to know it and cannot import the worker: the
 * worker imports `@workspace/db`, and a pure module that opened a connection
 * pool would be a pure module no test could import.
 *
 * It is the ONE number that separates "still being retried" from "given up on",
 * and that separation is the whole of what the buyer is owed here.
 */
export const MAX_FULFILLMENT_ATTEMPTS = 6;

/**
 * The stages a buyer is shown, in order.
 *
 * Five, not the six of the sketch this was asked for. `submitted` and
 * "accepted" are one observable event in this system and not two: the POST that
 * creates the order at Printify returns its id in the same call, so there is no
 * moment at which KAX has submitted an order the printer has not accepted. A
 * sixth stage that always lit at the same instant as its neighbour would be
 * theatre, and theatre in a progress indicator is how a buyer learns not to
 * trust it.
 *
 * `paid` is the first rung and comes from `commerce_orders.status`, not from
 * `fulfillment_state`. The two columns move on different clocks — a paid order
 * is unfulfilled until somebody submits it, and a shipped order can still go to
 * chargeback — and this list is the one place they are read as a single line,
 * for display, which is exactly how `/orders` already treats them.
 */
export const BUYER_STAGES = [
  "paid",
  "submitted",
  "in_production",
  "shipped",
  "delivered",
] as const;

export type BuyerStageId = (typeof BUYER_STAGES)[number];

/**
 * How the order is moving through the stages.
 *
 * - `moving` — it is progressing, or waiting normally for the next step.
 * - `stalled` — it has stopped somewhere it was not supposed to stop, and a
 *   human has to push it. This is the reading of a PARKED order.
 * - `stopped` — it ended: canceled, refunded, charged back, or never paid.
 * - `none` — there is no fulfilment to report, because the charge never landed.
 *
 * `stalled` and `moving` being different values is the entire point of the
 * feature. A parked order that rendered identically to an in-flight one is the
 * failure this replaces, and it is asserted directly in the tests.
 */
export type BuyerProgress = "moving" | "stalled" | "stopped" | "none";

export interface BuyerStage {
  id: BuyerStageId;
  /** Whether the order has got this far. */
  reached: boolean;
  /**
   * When it got here, ISO 8601, or null.
   *
   * Null on a reached stage is possible and honest: an order fulfilled by hand
   * before these columns existed has a state without a stamp, and inventing one
   * from `updated_at` would put a fabricated time in front of a buyer.
   */
  at: string | null;
  /** The furthest stage reached — the one the buyer is watching. */
  current: boolean;
}

export interface BuyerTimeline {
  stages: BuyerStage[];
  /** The furthest stage reached, or null when nothing has been reached. */
  current: BuyerStageId | null;
  progress: BuyerProgress;
  /**
   * The stage the order stopped at, when `progress` is `stalled`. It is the
   * stage the buyer is told about, in the client's own words — this server
   * never sends prose, a provider code, or an HTTP status to a buyer.
   */
  stalledAt: BuyerStageId | null;
}

/**
 * Everything the buyer timeline is allowed to see, and NOTHING else.
 *
 * The shape is the guarantee, in the same way `CommerceOrderShippingSnapshot`
 * is the guarantee that the Printify adapter cannot reach a live address:
 *
 * - There is no `shipToLine1` and no other postal field, so no derivation below
 *   can put one in a buyer payload even by accident.
 * - There is no `fulfillmentLastError`. The parked signal arrives as
 *   `hasFulfillmentError`, a BOOLEAN computed in SQL, so the string `"429:8251"`
 *   is not merely omitted from the response — it never enters this module and
 *   cannot be added to the response by a later widening. That string is for an
 *   admin.
 * - There is no `providerStatus`. Printify's literals are the operator's
 *   vocabulary and the buyer is shown a stage.
 */
export interface BuyerTimelineInput {
  /** `commerce_orders.status`. */
  orderStatus: string;
  /** `commerce_orders.fulfillment_state`. */
  fulfillmentState: string;
  createdAt: Date | string;
  submittedAt: Date | string | null;
  releasedAt: Date | string | null;
  shippedAt: Date | string | null;
  deliveredAt: Date | string | null;
  fulfillmentAttempts: number;
  /** `fulfillment_last_error IS NOT NULL`. The reason itself stays server-side. */
  hasFulfillmentError: boolean;
  /**
   * When the automatic worker last tried and was refused.
   *
   * Needed because the MANUAL admin endpoints deliberately do not touch any of
   * the worker's columns — that is what keeps the manual path exactly what it
   * was before the worker existed, and it is the only path proven end to end
   * against a real order. So an order the worker parked and an operator then
   * fulfilled by hand still carries a spent budget and a stored error forever,
   * and a stall test that read only those two would call a shipped parcel stuck.
   * Comparing this against the current stage's own stamp is what tells "it
   * failed and stopped" from "it failed and then somebody moved it".
   */
  fulfillmentLastAttemptAt: Date | string | null;
}

/**
 * Order statuses for which there is a parcel to talk about at all.
 *
 * The same three `showsFulfillment` uses on the client, and for the same
 * reason: printing a fulfilment line beside a declined card reads as a queue the
 * buyer is waiting in.
 */
const FULFILLABLE_STATUSES: readonly string[] = ["paid", "refunded", "chargeback"];

/**
 * Of those three, the two where the money has gone back.
 *
 * `canceled` is not here because it is not in the list above either — an order
 * canceled before payment gets `none`, not `stopped`, because there was never a
 * parcel to stop.
 */
const STOPPED_STATUSES: readonly string[] = ["refunded", "chargeback"];

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Where this order is, in the only terms a buyer is ever shown.
 *
 * The stamp for each stage comes from the column that records that stage
 * happening, and `in_production` uses `released_at` because release IS the act
 * of sending it to production — the poller's later confirmation that Printify
 * agrees does not restart the clock on a stage the buyer has already watched
 * begin. That also means the timeline keeps working with the status poller
 * switched off, which matters: a stage that only lit when an optional flag was
 * set would reintroduce, one rung higher, the silence this feature removes.
 */
export function buyerTimeline(input: BuyerTimelineInput): BuyerTimeline {
  const reachedAt: Record<BuyerStageId, string | null> = {
    paid: iso(input.createdAt),
    submitted: iso(input.submittedAt),
    in_production: iso(input.releasedAt),
    shipped: iso(input.shippedAt),
    delivered: iso(input.deliveredAt),
  };

  const paid = FULFILLABLE_STATUSES.includes(input.orderStatus);
  const stateRank = ladderRank(input.fulfillmentState);

  // A stage counts as reached when the ladder says so OR when its own timestamp
  // is set. Both, rather than either alone: an order canceled at the printer has
  // an off-ladder state (rank -1) and still genuinely reached the rungs it
  // climbed, and an order fulfilled by hand before 0030 has rungs with no stamp.
  const reached: Record<BuyerStageId, boolean> = {
    paid,
    submitted: paid && (stateRank >= ladderRank("submitted") || reachedAt.submitted !== null),
    in_production:
      paid && (stateRank >= ladderRank("in_production") || reachedAt.in_production !== null),
    shipped: paid && (stateRank >= ladderRank("shipped") || reachedAt.shipped !== null),
    delivered: paid && (stateRank >= ladderRank("delivered") || reachedAt.delivered !== null),
  };

  // The furthest TRUE, not the first FALSE: a row whose stamps are sparse must
  // still report the highest stage it can actually evidence.
  let current: BuyerStageId | null = null;
  for (const id of BUYER_STAGES) {
    if (reached[id]) current = id;
  }

  // The last time FULFILMENT moved, which is deliberately not the same as the
  // current stage's stamp. `paid` is stamped from `created_at` — the moment the
  // row was written, before anything was attempted — so comparing a failure
  // against it would call every order parked at the very first step "moving",
  // because the row is always older than the failure. Only the four stages that
  // represent an actual fulfilment step count here; `null` means fulfilment has
  // never moved at all, which is exactly the state a submit-time park leaves.
  const lastMove = [reachedAt.submitted, reachedAt.in_production, reachedAt.shipped, reachedAt.delivered]
    .filter((at): at is string => at !== null)
    .reduce<string | null>((latest, at) => (latest === null || Date.parse(at) > Date.parse(latest) ? at : latest), null);

  const progress = buyerProgress(input, current, lastMove);

  return {
    stages: BUYER_STAGES.map((id) => ({
      id,
      reached: reached[id],
      at: reached[id] ? reachedAt[id] : null,
      current: current === id,
    })),
    current,
    progress,
    stalledAt: progress === "stalled" ? current : null,
  };
}

/**
 * Moving, stalled, stopped, or nothing to say.
 *
 * The stalled test is `fulfillment_attempts >= MAX_FULFILLMENT_ATTEMPTS`, which
 * is exactly what PARKED means: the worker spends the whole budget in one write
 * to take an order out of its own hands, and every claim query filters on that
 * ceiling. So this reads the same fact the worker acts on, rather than a second
 * opinion about it.
 *
 * An order mid-retry — one failure, five left — is `moving` on purpose. It has a
 * `fulfillment_last_error` and it is still on its way, and shouting at a buyer
 * about a 429 that will clear in two minutes is how a status page becomes noise.
 * `hasFulfillmentError` is therefore not what decides a stall; it is the second
 * of the two conditions, and it is what keeps an order that has simply been
 * fulfilled by hand — attempts at the ceiling, error cleared on success — from
 * being reported as stuck.
 *
 * `delivered` short-circuits both. A parcel that arrived is not stalled no
 * matter what the counter says, and a delivered order still carrying a spent
 * budget from a rocky submission is a completely ordinary row.
 *
 * The third condition is the one that keeps the MANUAL path readable. Those
 * endpoints do not clear the worker's columns — deliberately — so an order the
 * worker gave up on and an operator then pushed through by hand keeps its spent
 * budget and its stored error for good. It is stalled only if that last refusal
 * is more recent than the last time fulfilment actually MOVED. If the order
 * moved after the failure, somebody already dealt with it, and the buyer must
 * not be told otherwise — which matters more than it sounds, because the one
 * order that has ever been fulfilled was fulfilled by hand.
 *
 * `lastMoveAt` is null when fulfilment has never moved at all, and that is the
 * ordinary shape of a park at the very first step: nothing was submitted, so
 * there is no stamp, and a spent budget with a stored reason is exactly stalled.
 */
function buyerProgress(
  input: BuyerTimelineInput,
  current: BuyerStageId | null,
  lastMoveAt: string | null,
): BuyerProgress {
  if (!FULFILLABLE_STATUSES.includes(input.orderStatus)) return "none";
  if (STOPPED_STATUSES.includes(input.orderStatus)) return "stopped";
  if (input.fulfillmentState === FULFILLMENT_CANCELED) return "stopped";
  if (current === "delivered") return "moving";
  if (input.fulfillmentAttempts < MAX_FULFILLMENT_ATTEMPTS) return "moving";
  if (!input.hasFulfillmentError) return "moving";
  if (lastMoveAt === null) return "stalled";

  const failedAt = iso(input.fulfillmentLastAttemptAt);
  // No stamp at all: the budget was spent by something that did not record
  // when. Read that as stalled — an order at the ceiling with a stored reason
  // and no evidence of having moved since is the case this feature is for.
  if (failedAt === null) return "stalled";
  return Date.parse(failedAt) > Date.parse(lastMoveAt) ? "stalled" : "moving";
}

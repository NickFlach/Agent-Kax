/**
 * The two subsets of `commerce_orders.status` that more than one file has to
 * agree about.
 *
 * The column is a varchar and not a pgEnum on purpose — an unknown literal in a
 * WHERE clause is a 500 rather than a no-match — but that freedom is exactly
 * why the vocabulary has to be written down once. A set spelled out at each use
 * site is a set that drifts, and both of these decide whether real money moves.
 *
 * Pure by construction: nothing here imports `@workspace/db` (importing it opens
 * a connection pool), so `routes/commerce.ts`, `routes/webhooks.ts` and
 * `lib/purchasingFacts.ts` can all reach it without a cycle.
 */

/**
 * States a late delivery must never move an order OUT of.
 *
 * `paid` is the obvious one — a `payment_intent.payment_failed` redelivered
 * after a successful retry must not mark a settled order failed. `refunded` and
 * `chargeback` are terminal in a stronger sense: the money has gone back, and
 * Stripe retries a failed-payment event for up to three days, so a redelivery
 * arriving after a refund would otherwise overwrite the record of that refund
 * with `payment_failed` and leave nothing on the row to say the charge was
 * reversed.
 *
 * The reversal writes themselves are keyed on the payment intent and carry no
 * such guard, because these are the transitions they exist to make.
 */
export const TERMINAL_ORDER_STATUSES: readonly string[] = ["paid", "refunded", "chargeback"];

/**
 * States that do NOT count against the 24-hour purchase cap.
 *
 * The exclusion is stated rather than the inclusion, so a status added later
 * counts by default. A cap that counted only `paid` would miss every order
 * between its INSERT and the webhook that settles it, which is the entire
 * lifetime of a burst.
 */
export const NON_CHARGEABLE_ORDER_STATUSES: readonly string[] = ["canceled", "payment_failed"];

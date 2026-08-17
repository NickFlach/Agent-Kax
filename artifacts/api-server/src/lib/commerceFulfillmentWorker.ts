import { db } from "@workspace/db";
import { commerceOrdersTable } from "@workspace/db/schema";
import { and, eq, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  getUncachablePrintifyClient,
  printifyEnabled,
  PrintifyError,
  PrintifyNotConfiguredError,
  type PrintifyClient,
} from "./printifyClient";
import {
  reconcileCommerceOrderSubmission,
  releaseCommerceOrder,
  submitCommerceOrder,
} from "./commerceFulfillment";
import { logger } from "./logger";

/**
 * commerceFulfillmentWorker.ts — the two admin buttons, pressed on a timer.
 *
 * ADR-0002 made fulfilment a manual admin action and gave a real reason: the
 * window between submit and release is where a human's eyeballs are
 * simultaneously the address-validation backstop and the fraud check, which is
 * what made shipping v0.1 without an address-validation service a decision
 * rather than an omission. That reason has not gone away, so this worker is
 * OFF by default, is opt-in per deployment behind its own flag on top of the
 * one that arms Printify at all, and does not remove or weaken either endpoint.
 * A deployment that wants a human in the loop simply never sets the flag.
 *
 * It presses `lib/commerceFulfillment.ts`, the same code the endpoints press,
 * so every property that makes a manual submission safe — the row lock, the
 * `paid` precondition read under it, the double-submit guard, the rollback on
 * refusal, the address taken from the order's own snapshot — is the same code
 * here and cannot drift away from it.
 *
 * ## What is actually new, and it is the retry policy
 *
 * `printifyClient.ts` never retries a write, for a good reason: a retried
 * submission whose first attempt actually landed is a second parcel, printed
 * and paid for. A worker that retries at all has to earn each retry, so:
 *
 * - **429 retries.** The provider told us it did not take the request, and it
 *   told us in a way that arrived. Nothing was created.
 * - **Every 4xx that is not 429 parks immediately.** A rejected address is
 *   rejected again tomorrow. Retrying it for a day produces nothing but a slow
 *   leak of the error budget Printify counts against us.
 * - **`not_printable` parks**, because a product with no variant id is a
 *   configuration fact, not a transient one.
 * - **`not_paid` is not a failure at all** and burns no attempt. The order is
 *   simply not ready, and it will be picked up on the tick after it settles.
 * - **An internal failure — anything that is not a `PrintifyError` — charges
 *   an attempt like any other.** See `submitPass`; it is our bug, and the
 *   order still has to yield its place in the queue.
 *
 * ## Ambiguity, which is a separate thing from failure
 *
 * A failure says nothing was created. An AMBIGUOUS failure says we do not know
 * — and there are several of them, not one:
 *
 * - a **2xx carrying no order id** (including a 2xx with an empty body), where
 *   Printify plainly accepted the request and only the identifier was lost;
 * - a **5xx**, which can just as easily be a backend that created the order and
 *   then failed to answer as one that did nothing;
 * - a **transport failure**, `PrintifyError` with status 0, where we did not
 *   learn anything at all;
 * - an **internal error thrown out of `submitCommerceOrder`**, which from here
 *   cannot be placed before or after the provider call it wraps.
 *
 * A previous version of this comment claimed status 0 was "the ONE case where
 * we do not know". That was false — a 5xx is exactly as unknown, and the 2xx
 * with no id is worse than unknown, because the order almost certainly EXISTS.
 * Treating those two as ordinary retryable failures is how one customer payment
 * becomes several parcels and several charges to the merchant's own card.
 *
 * So a submission never happens without a RECONCILIATION first:
 * `printify.findOrderByExternalId(clientReference)`, using the `external_id`
 * every submission already carries for precisely this purpose. Found means the
 * order exists — adopt its id, mark the row submitted, charge no attempt and
 * post nothing. Definitively absent means submitting is safe. A lookup that
 * FAILED means we still do not know, so it charges an attempt and tries the
 * lookup again next time — a failed lookup is never grounds for a submission.
 *
 * **That reconciliation runs before EVERY submission, not only before one whose
 * marker looks ambiguous.** The marker is written after the POST returns, so
 * the failures it exists for — a crash inside the POST window, an OOM, a
 * rolling deploy, a database blip — are the failures that stop it being
 * written. A row that lost its process mid-POST looks untouched (null id, zero
 * attempts, null error), and a guard keyed on the marker would wave it straight
 * through to a second parcel. Reconciling unconditionally also closes the
 * marker-overwrite hole: a marker later replaced by an unrelated failure, or
 * cleared by an operator, can no longer hide an order that exists, because
 * nothing reads the marker to decide whether to look. `isAmbiguousMarker`
 * survives only to tell an OPERATOR what a row means — see `routes/admin.ts`.
 *
 * A transport failure still parks rather than reconciling, and that is a
 * deliberate difference of degree: status 0 usually means the network itself is
 * gone, in which case the lookup cannot run either, so a human is the faster
 * route. The marker it leaves is read as ambiguous all the same, so an operator
 * who un-parks the row by hand gets the reconcile path rather than a blind post.
 *
 * The release pass needs none of this. `sendToProduction` is called with an id
 * we already hold, so `readOrderRef`'s fallback means it can never raise the
 * ambiguous error — and re-sending an order that is already in production does
 * not manufacture a second parcel. Ambiguity is a property of NAMING the order,
 * and release starts out knowing the name.
 *
 * "Parked" means `fulfillment_attempts` is set to the ceiling, which the claim
 * queries filter on — so a parked order leaves the worker's world entirely and
 * waits for the manual endpoints, which still work on it. Parking is logged
 * loudly, with the order id and the reason and NOTHING else: no `ship_to_*`
 * value reaches a log line here, or a stored error string, any more than it
 * reaches an HTTP response.
 */

/**
 * Tries before an order is parked.
 *
 * Six attempts means five waits between them, and with the backoff below those
 * are 2, 4, 8, 16 and 32 minutes — **62 minutes** of retrying, not the "roughly
 * two hours" an earlier version of this comment claimed. Long enough to ride
 * out a provider blip, short enough that a genuinely broken order is in a
 * human's hands within the hour.
 */
export const MAX_FULFILLMENT_ATTEMPTS = 6;

/** Base of the exponential backoff. Attempt 1 waits two minutes. */
export const BACKOFF_BASE_MS = 60_000;
/**
 * Clamp on the backoff, so that raising `MAX_FULFILLMENT_ATTEMPTS` cannot
 * silently turn the ladder into days of waiting.
 *
 * Worth stating plainly: at six attempts it never binds. The largest delay the
 * ladder can write is the sixth, 64 minutes, and that one is written onto a row
 * that has just been taken out of the claim queries anyway. It is a guard on a
 * future edit rather than a live rung.
 */
export const BACKOFF_CEILING_MS = 6 * 60 * 60 * 1000;

/**
 * Orders claimed per pass per tick. Small deliberately: each one costs a
 * provider call made inside a row lock, and the tick comes round again in a
 * minute. A large batch buys nothing but a longer-held connection.
 */
const BATCH_SIZE = 10;

/** How often the worker looks. */
export const FULFILLMENT_TICK_INTERVAL_MS = 60_000;

/**
 * The gap between submitting an order and sending it to production, and the
 * only part of the manual window automation can preserve. Fifteen minutes by
 * default: an operator watching the admin list has that long to cancel at
 * Printify before anything is manufactured.
 */
export const DEFAULT_RELEASE_HOLD_MS = 900_000;

/** Recorded on `release_actor` when nobody pressed anything. */
export const AUTO_RELEASE_ACTOR = "system:auto-fulfillment";

/**
 * The second switch. `printifyEnabled()` arms the fulfilment surface at all;
 * this one decides whether it drives itself, and it is read separately so that
 * turning automation off never means turning fulfilment off.
 *
 * Parsed exactly like `printifyEnabled()` — same two accepted spellings, same
 * default of off — because a flag pair where one accepts "yes" and the other
 * does not is a flag pair somebody will get wrong at 2am.
 */
export function autoFulfillEnabled(): boolean {
  const v = process.env["KAX_PRINTIFY_AUTO_FULFILL"];
  return v === "1" || v === "true";
}

/**
 * How long a submitted order waits before it is released.
 *
 * `0` is a real, meaningful setting — "release in the same tick you submit" —
 * and it is the one a naive `Number(v) || DEFAULT` would silently turn into
 * fifteen minutes, so absence is decided before the value is read rather than
 * inferred from falsiness afterwards. A value that is not a non-negative finite
 * number is a typo rather than an instruction, and falls back to the default.
 */
export function releaseHoldMs(): number {
  const raw = process.env["KAX_PRINTIFY_AUTO_RELEASE_HOLD_MS"]?.trim();
  if (raw === undefined || raw.length === 0) return DEFAULT_RELEASE_HOLD_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_RELEASE_HOLD_MS;
  return parsed;
}

export interface FulfillmentTickResult {
  /** Why the tick did nothing, or null if it ran. */
  skipped: "disabled" | "not_configured" | null;
  submitted: number;
  released: number;
  /**
   * Orders whose earlier, ambiguous submission was found at Printify and
   * adopted instead of being posted again. Every one of these is a parcel that
   * was not printed twice.
   */
  reconciled: number;
  /** Failures that will be tried again. */
  retryScheduled: number;
  /** Orders taken out of the worker's hands and left to the manual endpoints. */
  parked: number;
}

function emptyResult(skipped: FulfillmentTickResult["skipped"]): FulfillmentTickResult {
  return { skipped, submitted: 0, released: 0, reconciled: 0, retryScheduled: 0, parked: 0 };
}

/**
 * What `fulfillment_last_error` holds when the last attempt left it UNKNOWN
 * whether Printify has the order.
 *
 * A short fixed literal, like `"product_not_printable"`, and for the same
 * reason: the column is read out by an admin listing and must never carry a
 * provider body. It reads as what it is — an operator seeing it knows the next
 * step is a lookup and not a resubmission — where a bare `"502:none"` would
 * read as an ordinary gateway refusal.
 */
const AMBIGUOUS_SUBMISSION_REASON = "submission_ambiguous";

/**
 * What it holds when this process, rather than the provider, was the problem.
 * A fixed literal and never `err.message`: an internal error's message is
 * arbitrary text this code did not write and may quote anything it was handed.
 */
const INTERNAL_ERROR_REASON = "internal_error";

/**
 * What it holds when the pre-submission lookup could not be completed.
 *
 * A distinct literal from `AMBIGUOUS_SUBMISSION_REASON`, because it states a
 * different fact: nothing was posted, so nothing is in doubt at Printify — we
 * simply declined to post until we could check. Writing the ambiguity literal
 * here would tell an operator (and `isAmbiguousMarker`) that a submission might
 * be sitting at Printify when none was ever made, which is a lie in a column
 * whose whole job is to be believed. It also must not ERASE a real ambiguity,
 * so `markerAfterFailedLookup` keeps an existing ambiguous marker instead.
 */
const RECONCILE_UNAVAILABLE_REASON = "reconcile_unavailable";

/**
 * Does this stored marker mean "we do not know whether Printify has it"?
 *
 * **Nothing in the submit path consults this any more.** Reconciliation happens
 * unconditionally, precisely because the marker cannot be trusted to have been
 * written; this function's remaining jobs are telling an operator what a row
 * means at `POST /admin/commerce-orders/:id/submit`, and deciding which marker
 * survives a failed lookup.
 *
 * Read off `fulfillment_last_error`, which is the only memory the worker keeps
 * between ticks. Three shapes count, and each is here for a reason:
 *
 * - the ambiguous literal, written for a 2xx-with-no-id, a 5xx, a failed
 *   reconciliation, or an internal error inside the submit call;
 * - `5xx:*`, which is what a genuine provider 5xx wrote before this literal
 *   existed — rows already in that state must not be resubmitted blind on
 *   the first tick after this deploys;
 * - `0:*`, the transport failure. Those rows are parked, so the worker will
 *   not reach them on its own; the case that matters is an operator who resets
 *   `fulfillment_attempts` by hand, and who must get a lookup and not a post.
 *
 * Anything else — `400:8251`, `product_not_printable`, `internal_error` from a
 * pass that never reached the provider, or no error at all — is not ambiguous.
 */
export function isAmbiguousMarker(lastError: string | null): boolean {
  if (lastError === null) return false;
  if (lastError === AMBIGUOUS_SUBMISSION_REASON) return true;
  return /^(0|5\d\d):/.test(lastError);
}

/**
 * A provider refusal that is worth trying again, or one that is not.
 *
 * The ambiguous ones are refused FIRST and by name, before the status is looked
 * at, because the ambiguous 2xx-with-no-id wears a 502 and would otherwise be
 * waved through by the `>= 500` clause as an ordinary server error. "Worth
 * trying again" here means "worth POSTING again"; an ambiguous failure may
 * still be worth reconciling, which is a different call to a different verb and
 * is decided in `recordFailure` and `reconcileAmbiguousSubmission`.
 *
 * Note what falls into `park` without being named: status 0, the adapter's
 * "could not be reached", for the reason in the header.
 */
function isRetryable(err: PrintifyError): boolean {
  if (err.ambiguous) return false;
  return err.status === 429 || err.status >= 500;
}

/**
 * Provider status and code, and nothing else, for `fulfillment_last_error`.
 *
 * `PrintifyError` has no body field by construction — `toPrintifyError` drops
 * Printify's `errors` object, which on a rejected address quotes the buyer's
 * street back at us. This function is the second place that has to stay true:
 * `err.message` is deliberately NOT included, because the adapter passes
 * Printify's top-level `message` through and a provider is free to put anything
 * in it.
 */
function errorTag(err: PrintifyError): string {
  return `${err.status}:${err.code ?? "none"}`;
}

/**
 * Claim orders that are paid, unsubmitted, still within their attempt budget
 * and due.
 *
 * `SKIP LOCKED` is what makes a second api-server instance safe to run: a row
 * another instance is mid-submission on is passed over entirely rather than
 * queued behind. It is not, by itself, what prevents a double submission —
 * these locks are released when this short transaction commits, and the real
 * guarantee is the `FOR UPDATE` plus `printify_order_id IS NOT NULL` check
 * inside `submitCommerceOrder`, which is where a losing racer discovers the
 * work is already done and calls nobody. SKIP LOCKED avoids the contention;
 * the guard avoids the second parcel.
 */
async function claimSubmittable(now: Date, limit: number): Promise<number[]> {
  const rows = await db.transaction(async (tx) =>
    tx
      .select({ id: commerceOrdersTable.id })
      .from(commerceOrdersTable)
      .where(
        and(
          eq(commerceOrdersTable.status, "paid"),
          isNull(commerceOrdersTable.printifyOrderId),
          lt(commerceOrdersTable.fulfillmentAttempts, MAX_FULFILLMENT_ATTEMPTS),
          or(
            isNull(commerceOrdersTable.fulfillmentNextAttemptAt),
            lte(commerceOrdersTable.fulfillmentNextAttemptAt, now),
          ),
        ),
      )
      .orderBy(commerceOrdersTable.id)
      .limit(limit)
      .for("update", { skipLocked: true }),
  );
  return rows.map((r) => r.id);
}

/**
 * Claim orders that are paid, submitted, unreleased, past their hold and due.
 *
 * `submitted_at <= now - hold` also excludes a null `submitted_at` for free —
 * a comparison against NULL is NULL, not true — so an order carrying a Printify
 * id it somehow got without a submission timestamp is left alone rather than
 * released on the strength of a missing value.
 *
 * **`status = 'paid'` is here for the same reason it is in `claimSubmittable`,
 * and it was missing.** The release hold is a window measured in minutes, and
 * `charge.dispute.created` lands inside windows like that: submit at T, dispute
 * webhook at T+3, hold expires at T+15, and without this clause the worker
 * manufactures a parcel against money that is already gone. Like the submit
 * side, this predicate is an OPTIMISER and not the guarantee — it keeps the
 * batch clean, but a row that changes status between this claim and the lock is
 * caught by `releaseCommerceOrder`'s own read under `FOR UPDATE`, which is the
 * check that actually decides.
 */
async function claimReleasable(now: Date, holdMs: number, limit: number): Promise<number[]> {
  const readyBy = new Date(now.getTime() - holdMs);
  const rows = await db.transaction(async (tx) =>
    tx
      .select({ id: commerceOrdersTable.id })
      .from(commerceOrdersTable)
      .where(
        and(
          eq(commerceOrdersTable.status, "paid"),
          isNotNull(commerceOrdersTable.printifyOrderId),
          isNull(commerceOrdersTable.releasedAt),
          lte(commerceOrdersTable.submittedAt, readyBy),
          lt(commerceOrdersTable.fulfillmentAttempts, MAX_FULFILLMENT_ATTEMPTS),
          or(
            isNull(commerceOrdersTable.fulfillmentNextAttemptAt),
            lte(commerceOrdersTable.fulfillmentNextAttemptAt, now),
          ),
        ),
      )
      .orderBy(commerceOrdersTable.id)
      .limit(limit)
      .for("update", { skipLocked: true }),
  );
  return rows.map((r) => r.id);
}

/** A step worked. Give the order its budget back for the next one. */
async function recordSuccess(orderId: number, now: Date): Promise<void> {
  await db
    .update(commerceOrdersTable)
    .set({
      // Reset rather than leave: a submission that took three attempts must not
      // spend the release's budget before release has tried once.
      fulfillmentAttempts: 0,
      fulfillmentLastError: null,
      fulfillmentLastAttemptAt: now,
      fulfillmentNextAttemptAt: null,
      updatedAt: now,
    })
    .where(eq(commerceOrdersTable.id, orderId));
}

/**
 * Charge an attempt against the order and say when it may be tried again.
 *
 * The increment is `fulfillment_attempts + 1` in SQL and the delay is derived
 * from the incremented value in the same statement, so two instances that both
 * failed on the same order cost two attempts rather than one — a count read in
 * JavaScript and written back would let the second overwrite the first and
 * retry forever.
 *
 * `reason` is a caller-chosen tag, not an error object, because three different
 * kinds of thing end up here: a provider status pair, the ambiguity literal,
 * and the internal-error literal. All three are short and fixed-shape by
 * construction, which is the property `fulfillment_last_error` needs.
 */
async function recordRetry(orderId: number, reason: string, now: Date): Promise<void> {
  // The casts are load-bearing: a bare bind parameter next to `+ interval`
  // leaves Postgres with an `unknown` left-hand side and no unique operator to
  // resolve it to.
  const base = sql.raw(`interval '${BACKOFF_BASE_MS / 1000} seconds'`);
  const ceiling = sql.raw(`interval '${BACKOFF_CEILING_MS / 1000} seconds'`);
  const attempts = commerceOrdersTable.fulfillmentAttempts;
  await db
    .update(commerceOrdersTable)
    .set({
      fulfillmentAttempts: sql`${attempts} + 1`,
      fulfillmentLastError: reason,
      fulfillmentLastAttemptAt: now,
      fulfillmentNextAttemptAt: sql`${now}::timestamptz + least(power(2, ${attempts} + 1) * ${base}, ${ceiling})`,
      updatedAt: now,
    })
    .where(eq(commerceOrdersTable.id, orderId));
}

/**
 * Take the order out of the worker's hands for good.
 *
 * Spending the whole budget at once is the mechanism: every claim query filters
 * `fulfillment_attempts < MAX_FULFILLMENT_ATTEMPTS`, so this row is never
 * picked up again. Nothing about the order is otherwise changed — it is still
 * paid, still submittable by hand, and the manual endpoints do not read this
 * column at all.
 */
async function park(orderId: number, reason: string, now: Date): Promise<void> {
  await db
    .update(commerceOrdersTable)
    .set({
      fulfillmentAttempts: MAX_FULFILLMENT_ATTEMPTS,
      fulfillmentLastError: reason,
      fulfillmentLastAttemptAt: now,
      fulfillmentNextAttemptAt: null,
      updatedAt: now,
    })
    .where(eq(commerceOrdersTable.id, orderId));
  // Loudly, and with the id and the reason only. An operator looking this up
  // has the order in front of them; a log aggregator does not need the address.
  logger.warn(
    { orderId, reason },
    "Commerce order parked by the auto-fulfilment worker — it now needs the manual endpoints",
  );
}

/**
 * Apply the failure ladder to one refused order. Returns which rung was used so
 * the tick can count it.
 *
 * Ambiguity is decided before retryability, not after, because the two answers
 * disagree about the 2xx-with-no-id and the ambiguous answer is the correct
 * one. "Retry" for an ambiguous failure does NOT mean "post it again": the row
 * carries the ambiguous marker away with it, and the next due tick starts with
 * a lookup. Parking it instead would be the other safe answer, and it is the
 * wrong one here — the order almost certainly exists at Printify and a lookup
 * will say so, which is a thing this process can do without waking anybody.
 */
async function recordFailure(
  orderId: number,
  err: PrintifyError,
  now: Date,
): Promise<"retry" | "park"> {
  if (err.ambiguous) {
    await recordRetry(orderId, AMBIGUOUS_SUBMISSION_REASON, now);
    return "retry";
  }
  if (isRetryable(err)) {
    // A genuine 5xx keeps its status pair, which is more use to an operator
    // than the literal would be — and `isAmbiguousMarker` reads `5xx:` as
    // ambiguous too, so it still reconciles before it resubmits.
    await recordRetry(orderId, errorTag(err), now);
    return "retry";
  }
  await park(orderId, errorTag(err), now);
  return "park";
}

/**
 * Which marker a row should carry after a lookup that could not be completed.
 *
 * A failed lookup adds no information, so it must not destroy any. If the row
 * already said "a submission may be sitting at Printify", it goes on saying so;
 * only a row with nothing to lose gets the honest `reconcile_unavailable`.
 * Overwriting an ambiguity marker with the weaker literal would be the
 * marker-overwrite hole reopened by the code that closes it.
 */
async function markerAfterFailedLookup(orderId: number): Promise<string> {
  const [row] = await db
    .select({ fulfillmentLastError: commerceOrdersTable.fulfillmentLastError })
    .from(commerceOrdersTable)
    .where(eq(commerceOrdersTable.id, orderId))
    .limit(1);
  const current = row?.fulfillmentLastError ?? null;
  return isAmbiguousMarker(current) ? current! : RECONCILE_UNAVAILABLE_REASON;
}

/**
 * Ask Printify whether it already has this order. Returns false when the caller
 * must NOT submit — either because there is nothing to submit, or because we
 * could not find out.
 *
 * The lookup itself and the adoption live in `commerceFulfillment.ts`, shared
 * with the manual admin endpoint, because the manual endpoint has exactly the
 * same hole and a second copy of this reasoning is the copy that drifts. What
 * belongs to the worker, and stays here, is the accounting: which outcome
 * charges an attempt, which restores the budget, and which literal lands in
 * `fulfillment_last_error`.
 */
async function reconcileBeforeSubmit(
  printify: PrintifyClient,
  orderId: number,
  now: Date,
  result: FulfillmentTickResult,
): Promise<boolean> {
  let outcome: Awaited<ReturnType<typeof reconcileCommerceOrderSubmission>>;
  try {
    outcome = await reconcileCommerceOrderSubmission(db, printify, orderId, now);
  } catch (err) {
    if (err instanceof PrintifyNotConfiguredError) throw err;
    // The lookup failed, so whatever was true a moment ago is still true and
    // nothing new is known. The one thing that must not happen is submitting on
    // the strength of a search that did not finish, so an attempt is charged,
    // the row's marker is preserved if it had one, and the next due tick looks
    // again. Six failed lookups park the row for a human, which is the right
    // end for an order this process cannot resolve — including the case where
    // Printify's list endpoint is down and NOTHING here can safely submit.
    await recordRetry(orderId, await markerAfterFailedLookup(orderId), now);
    logger.warn(
      { orderId, reason: err instanceof PrintifyError ? errorTag(err) : INTERNAL_ERROR_REASON },
      "Could not check Printify for an existing order — not submitting",
    );
    result.retryScheduled += 1;
    return false;
  }

  switch (outcome.kind) {
    case "absent":
      // A completed search that found nothing. Printify does not have this
      // order, so submitting creates one parcel rather than a second one.
      return true;
    case "adopted":
      // Loudly, and with the ids only. This line is how an operator learns that
      // a parcel was NOT printed twice.
      logger.warn(
        { orderId, printifyOrderId: outcome.printifyOrderId },
        "Adopted an existing Printify order instead of submitting again",
      );
      result.reconciled += 1;
      return false;
    case "already_submitted":
    case "not_found":
      // Somebody else resolved it, or the row went, between the claim and here.
      // Nothing to post and nothing to count.
      return false;
  }
}

async function submitPass(
  printify: PrintifyClient,
  now: Date,
  result: FulfillmentTickResult,
): Promise<void> {
  for (const orderId of await claimSubmittable(now, BATCH_SIZE)) {
    try {
      // Reconcile BEFORE submitting, never after, and for every order rather
      // than only for one that looks doubtful. Everything downstream of this
      // line assumes the order is not already at Printify under a name we
      // failed to write down, and that assumption is only true because of it.
      // Counting and attempt-charging for every outcome but "go ahead" happen
      // inside, which is where the decision not to submit is taken.
      if (!(await reconcileBeforeSubmit(printify, orderId, now, result))) continue;

      const outcome = await submitCommerceOrder(db, printify, orderId);
      switch (outcome.kind) {
        case "submitted":
          result.submitted += 1;
          await recordSuccess(orderId, now);
          break;
        case "already_submitted":
          // Another instance got there between the claim and the lock. The
          // guard held; nothing to do and nothing to charge for.
          break;
        case "not_paid":
        case "not_found":
          // Not an error. The order settled back out of `paid` (or went) after
          // the claim read it, and it simply is not ready. No attempt is burnt.
          break;
        case "not_printable":
          await park(orderId, "product_not_printable", now);
          result.parked += 1;
          break;
      }
    } catch (err) {
      if (err instanceof PrintifyNotConfiguredError) throw err;
      if (!(err instanceof PrintifyError)) {
        // Our bug, not the order's — and that reasoning still holds, which is
        // why this charges an ATTEMPT and not the whole budget. What it must
        // not do is charge nothing: `claimSubmittable` is `ORDER BY id LIMIT
        // 10`, so a row that fails this way every tick is claimed first every
        // tick, forever, and the newer paid orders behind it are never reached.
        // A defect in this process would quietly become a fulfilment outage for
        // every order queued behind the row that triggers it — and silently,
        // because a tick that submits nothing logs nothing. The row keeps its
        // place in the queue only until it has burnt its budget like anything
        // else, and then it parks for a human.
        //
        // The marker is ambiguous on purpose: an exception thrown out of
        // `submitCommerceOrder` cannot be placed before or after the provider
        // call it wraps, so the next due tick reconciles rather than reposts.
        logger.error({ err, orderId }, "Auto-fulfilment submit failed for a non-provider reason");
        await recordRetry(orderId, AMBIGUOUS_SUBMISSION_REASON, now);
        result.retryScheduled += 1;
        continue;
      }
      if ((await recordFailure(orderId, err, now)) === "park") result.parked += 1;
      else result.retryScheduled += 1;
    }
  }
}

async function releasePass(
  printify: PrintifyClient,
  now: Date,
  holdMs: number,
  result: FulfillmentTickResult,
): Promise<void> {
  for (const orderId of await claimReleasable(now, holdMs, BATCH_SIZE)) {
    try {
      const outcome = await releaseCommerceOrder(db, printify, orderId, AUTO_RELEASE_ACTOR);
      switch (outcome.kind) {
        case "released":
          result.released += 1;
          await recordSuccess(orderId, now);
          break;
        case "not_paid":
          // The money went back between the submission and the hold expiring —
          // a refund, or a dispute Stripe told us about. Not a failure and not
          // an attempt: there is simply nothing here to manufacture, and the
          // order will not be claimed again unless it returns to `paid`, which
          // `clearCommerceOrderChargeback` is allowed to do.
          break;
        case "already_released":
        case "not_submitted":
        case "not_found":
          break;
      }
    } catch (err) {
      if (err instanceof PrintifyNotConfiguredError) throw err;
      if (!(err instanceof PrintifyError)) {
        // Charged an attempt for the same reason the submit pass charges one:
        // `claimReleasable` is also `ORDER BY id LIMIT 10`, and a row that
        // throws here every tick would hold the front of that queue against
        // every submitted order waiting behind it. Nothing about a release is
        // ambiguous — `sendToProduction` is called with an id we already hold
        // and re-sending it prints nothing extra — so this keeps the honest
        // internal-error marker rather than the reconcile one.
        logger.error({ err, orderId }, "Auto-fulfilment release failed for a non-provider reason");
        await recordRetry(orderId, INTERNAL_ERROR_REASON, now);
        result.retryScheduled += 1;
        continue;
      }
      if ((await recordFailure(orderId, err, now)) === "park") result.parked += 1;
      else result.retryScheduled += 1;
    }
  }
}

/**
 * One pass of each, in order: submit first, then release.
 *
 * Both passes judge dueness against the same `now`, which is the tick's nominal
 * time rather than each pass's wall clock. That has one visible consequence
 * worth stating plainly: an order the submit pass has just created is stamped
 * `submitted_at` from `submitCommerceOrder`'s own clock, a hair AFTER this
 * `now`, so even a zero hold does not release it until the following tick. A
 * zero hold means "apply no approval window", not "finish within one tick" —
 * the tick cadence is the floor on every action this worker takes, and reaching
 * past it would mean either a second wall-clock read that a caller-supplied
 * `now` could not override, or a release pass judged against a different moment
 * than the submit pass. Neither is worth up to a minute.
 *
 * Both flags are read here rather than at module load, so a tick is decided by
 * the environment the process is in now.
 */
export async function runFulfillmentTickOnce(now: Date = new Date()): Promise<FulfillmentTickResult> {
  if (!printifyEnabled() || !autoFulfillEnabled()) return emptyResult("disabled");

  let printify: PrintifyClient;
  try {
    printify = getUncachablePrintifyClient();
  } catch (err) {
    if (err instanceof PrintifyNotConfiguredError) {
      // The flag is on and the credentials are not there. No row is touched and
      // no attempt is burnt: this is a fact about the deployment, and parking
      // paid orders over it would turn a missing env var into a manual repair
      // job. Loud, because a deployment in this state fulfils nothing.
      logger.warn(
        { reason: err.message },
        "Auto-fulfilment is armed but Printify is not configured — tick skipped",
      );
      return emptyResult("not_configured");
    }
    throw err;
  }

  const result = emptyResult(null);
  const holdMs = releaseHoldMs();
  try {
    await submitPass(printify, now, result);
    await releasePass(printify, now, holdMs, result);
  } catch (err) {
    if (err instanceof PrintifyNotConfiguredError) {
      // A rotation emptied the environment mid-tick. Stop where we are rather
      // than working through the rest of the batch against a client that
      // cannot be built.
      logger.warn({ reason: err.message }, "Printify configuration vanished mid-tick — stopping");
      return { ...result, skipped: "not_configured" };
    }
    throw err;
  }
  return result;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick(): Promise<void> {
  // The provider calls are made inside row locks; overlapping ticks would queue
  // on each other's rows to no purpose.
  if (running) return;
  running = true;
  try {
    const result = await runFulfillmentTickOnce();
    if (
      result.submitted > 0 ||
      result.released > 0 ||
      result.reconciled > 0 ||
      result.parked > 0 ||
      result.retryScheduled > 0
    ) {
      logger.info(result, "Auto-fulfilment tick completed");
    }
  } catch (err) {
    logger.error({ err }, "Auto-fulfilment tick failed");
  } finally {
    running = false;
  }
}

/**
 * Start the worker, or explain why there is nothing to start.
 *
 * Never throws: an unconfigured deployment is the DEFAULT state of this
 * feature, not an error in it, and boot must not care. The startup step that
 * calls this is isolated anyway, but a scheduler that needs that isolation to
 * survive being off is a scheduler that would take the shop down the first time
 * somebody deployed without the flag.
 */
export function startCommerceFulfillmentWorker(): void {
  if (timer) return;
  if (!printifyEnabled() || !autoFulfillEnabled()) {
    logger.info(
      { printifyEnabled: printifyEnabled(), autoFulfill: autoFulfillEnabled() },
      "Auto-fulfilment worker inert — KAX_PRINTIFY_ENABLED and KAX_PRINTIFY_AUTO_FULFILL must both be on",
    );
    return;
  }
  timer = setInterval(() => {
    void tick();
  }, FULFILLMENT_TICK_INTERVAL_MS);
  // The HTTP server is what holds this process open; this timer should not be
  // the reason anything stays alive, least of all a test that imported the
  // module for one of its exported helpers.
  timer.unref();
  logger.info(
    { intervalMs: FULFILLMENT_TICK_INTERVAL_MS, releaseHoldMs: releaseHoldMs(), maxAttempts: MAX_FULFILLMENT_ATTEMPTS },
    "Auto-fulfilment worker started",
  );
  void tick();
}

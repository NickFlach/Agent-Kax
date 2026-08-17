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
import { releaseCommerceOrder, submitCommerceOrder } from "./commerceFulfillment";
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
 * - **429 and 5xx retry.** The provider told us it did not take the request
 *   (rate limit) or failed serving it, and it told us in a way that arrived.
 *   Backoff is exponential from a minute, capped at six hours.
 * - **Every other 4xx parks immediately.** A rejected address is rejected
 *   again tomorrow. Retrying it for a day produces nothing but a slow leak of
 *   the error budget Printify counts against us.
 * - **A transport failure — `PrintifyError` with status 0 — parks too**, and
 *   this is the one worth being explicit about. It is the ONE case where we do
 *   not know whether the order was created and only the answer was lost, which
 *   makes it exactly the case where an automatic retry is a coin flip on a
 *   second print run. The adapter's own comment says as much. Parking hands it
 *   to an operator who can look the `external_id` up in Printify's UI, which
 *   is precisely what `external_id` carrying `client_reference` is for.
 * - **`not_printable` parks**, because a product with no variant id is a
 *   configuration fact, not a transient one.
 * - **`not_paid` is not a failure at all** and burns no attempt. The order is
 *   simply not ready, and it will be picked up on the tick after it settles.
 *
 * "Parked" means `fulfillment_attempts` is set to the ceiling, which the claim
 * queries filter on — so a parked order leaves the worker's world entirely and
 * waits for the manual endpoints, which still work on it. Parking is logged
 * loudly, with the order id and the reason and NOTHING else: no `ship_to_*`
 * value reaches a log line here, or a stored error string, any more than it
 * reaches an HTTP response.
 */

/**
 * Tries before an order is parked. Five failures then park, with the backoff
 * below, is roughly two hours of retrying — long enough to ride out a provider
 * incident, short enough that a genuinely broken order reaches a human the same
 * working day.
 */
export const MAX_FULFILLMENT_ATTEMPTS = 6;

/** Base of the exponential backoff. Attempt 1 waits two minutes. */
const BACKOFF_BASE_MS = 60_000;
/** Ceiling on the backoff. Beyond this the delay stops being informative. */
const BACKOFF_CEILING_MS = 6 * 60 * 60 * 1000;

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
  /** Failures that will be tried again. */
  retryScheduled: number;
  /** Orders taken out of the worker's hands and left to the manual endpoints. */
  parked: number;
}

function emptyResult(skipped: FulfillmentTickResult["skipped"]): FulfillmentTickResult {
  return { skipped, submitted: 0, released: 0, retryScheduled: 0, parked: 0 };
}

/**
 * A provider refusal that is worth trying again, or one that is not.
 *
 * Note what falls into `park` without being named: status 0, the adapter's
 * "could not be reached". See the header — it is the ambiguous one, and the
 * ambiguous one is the one a machine must not retry.
 */
function isRetryable(err: PrintifyError): boolean {
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
 * Claim orders that are submitted, unreleased, past their hold and due.
 *
 * `submitted_at <= now - hold` also excludes a null `submitted_at` for free —
 * a comparison against NULL is NULL, not true — so an order carrying a Printify
 * id it somehow got without a submission timestamp is left alone rather than
 * released on the strength of a missing value.
 */
async function claimReleasable(now: Date, holdMs: number, limit: number): Promise<number[]> {
  const readyBy = new Date(now.getTime() - holdMs);
  const rows = await db.transaction(async (tx) =>
    tx
      .select({ id: commerceOrdersTable.id })
      .from(commerceOrdersTable)
      .where(
        and(
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
 */
async function recordRetry(orderId: number, err: PrintifyError, now: Date): Promise<void> {
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
      fulfillmentLastError: errorTag(err),
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
 */
async function recordFailure(
  orderId: number,
  err: PrintifyError,
  now: Date,
): Promise<"retry" | "park"> {
  if (isRetryable(err)) {
    await recordRetry(orderId, err, now);
    return "retry";
  }
  await park(orderId, errorTag(err), now);
  return "park";
}

async function submitPass(
  printify: PrintifyClient,
  now: Date,
  result: FulfillmentTickResult,
): Promise<void> {
  for (const orderId of await claimSubmittable(now, BATCH_SIZE)) {
    try {
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
        // Our bug, not the order's. Charging an attempt for it would park a
        // perfectly good paid order over a defect in this process.
        logger.error({ err, orderId }, "Auto-fulfilment submit failed for a non-provider reason");
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
        case "already_released":
        case "not_submitted":
        case "not_found":
          break;
      }
    } catch (err) {
      if (err instanceof PrintifyNotConfiguredError) throw err;
      if (!(err instanceof PrintifyError)) {
        logger.error({ err, orderId }, "Auto-fulfilment release failed for a non-provider reason");
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
    if (result.submitted > 0 || result.released > 0 || result.parked > 0 || result.retryScheduled > 0) {
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

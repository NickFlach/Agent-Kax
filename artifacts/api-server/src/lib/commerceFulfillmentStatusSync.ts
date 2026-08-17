import { db } from "@workspace/db";
import { commerceOrdersTable } from "@workspace/db/schema";
import { and, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import {
  getUncachablePrintifyClient,
  printifyEnabled,
  PrintifyError,
  PrintifyNotConfiguredError,
  type PrintifyClient,
  type PrintifyOrderState,
} from "./printifyClient";
import {
  FULFILLMENT_CANCELED,
  mapProviderStatus,
  nextFulfillmentState,
} from "./commerceFulfillmentStages";
import { logger } from "./logger";

/**
 * commerceFulfillmentStatusSync.ts — the other half of the conversation with
 * the printer.
 *
 * Until this existed, KAX only ever TOLD Printify things. `fulfillment_state`
 * declares six values and the server could write three of them; `shipped` and
 * `delivered` were vocabulary with no writer, so an order that had been in the
 * post for a week and one that was still sitting on a press were the same row to
 * a buyer and to an operator. This poller reads submitted orders back and moves
 * them.
 *
 * ## It is off, and off is the default
 *
 * Same discipline as `commerceFulfillmentWorker.ts`, because it is the same
 * risk shape: `printifyEnabled()` arms the fulfilment surface at all, and
 * `KAX_PRINTIFY_STATUS_SYNC` decides whether this reads from it. Both must be
 * on. The flags are parsed identically — same two accepted spellings, same
 * default of off — because a flag family where one member accepts "yes" and
 * another does not is a flag family somebody gets wrong at 2am.
 *
 * With the flag off the tick calls nobody and touches no row. Not "logs and
 * returns having already worked": a test asserts zero outbound calls AND an
 * untouched row, because a gate that skipped the log and did the work would
 * otherwise pass.
 *
 * ## What it is allowed to do to a row
 *
 * Almost nothing, and that is deliberate. It writes `provider_status`,
 * `provider_status_at`, the tracking triple, `shipped_at`, `delivered_at`,
 * `fulfillment_synced_at` and — only ever FORWARD, via `nextFulfillmentState` —
 * `fulfillment_state`.
 *
 * It does NOT touch `fulfillment_attempts`, `fulfillment_last_error`,
 * `fulfillment_next_attempt_at`, `printify_order_id`, `submitted_at`,
 * `released_at` or anything about money. Those belong to the submit/release
 * path, and a reader that could rewrite them would be able to un-submit an
 * order or spend a budget it does not own. This is a READER that records what
 * it read.
 *
 * ## Silence is the bug
 *
 * A dropped column once made the fulfilment worker throw on every tick with no
 * successful pass to contrast against, which is indistinguishable from the
 * feature being switched off, and it cost hours. So `fulfillment_synced_at` is
 * stamped on every COMPLETED check — one that changed nothing, and one the
 * provider refused, as much as one that advanced a stage. A stale stamp means
 * "nothing has looked", and it means only that.
 *
 * ## Nothing here logs an address
 *
 * The adapter reduces a fetched order to an id, a status and any shipments at
 * its parse boundary; `address_to` never reaches this file, and there is no
 * column here it could be written into. Log lines carry an order id, a provider
 * status literal and a mapped state — nothing else.
 */

/**
 * The second switch. Read separately from `printifyEnabled()` so that turning
 * the reader off never means turning fulfilment off, and vice versa.
 */
export function statusSyncEnabled(): boolean {
  const v = process.env["KAX_PRINTIFY_STATUS_SYNC"];
  return v === "1" || v === "true";
}

/** How often the poller looks for orders due a check. */
export const STATUS_SYNC_TICK_INTERVAL_MS = 300_000;

/**
 * The minimum gap between two checks of the SAME order.
 *
 * Manufacturing and posting a sticker takes days, so asking every fifteen
 * minutes is already far more often than the answer changes. The ceiling that
 * matters is Printify's: it publishes 600 requests/minute and counts a >5% error
 * rate as a violation in its own right, and this poller shares that budget with
 * the submissions that actually make money. Per-order pacing plus a small batch
 * is what keeps a shop with a thousand open orders from spending it.
 */
export const STATUS_SYNC_MIN_INTERVAL_MS = 900_000;

/**
 * Orders checked per tick.
 *
 * Larger than the fulfilment worker's ten because these are reads that create
 * nothing, and still small: the tick comes round again in five minutes, and a
 * batch big enough to matter is a batch that holds a connection long enough to
 * matter.
 */
const BATCH_SIZE = 25;

export interface StatusSyncTickResult {
  /** Why the tick did nothing, or null if it ran. */
  skipped: "disabled" | "not_configured" | null;
  /** Orders read back from Printify. */
  checked: number;
  /** Orders whose `fulfillment_state` moved. */
  advanced: number;
  /** Orders read successfully whose state did not change. */
  unchanged: number;
  /** Statuses this build has no mapping for. Nothing was changed for these. */
  unknownStatus: number;
  /** Orders Printify answered 404 for. */
  vanished: number;
  /** Provider refusals. Nothing was changed for these either. */
  failed: number;
}

function emptyResult(skipped: StatusSyncTickResult["skipped"]): StatusSyncTickResult {
  return {
    skipped,
    checked: 0,
    advanced: 0,
    unchanged: 0,
    unknownStatus: 0,
    vanished: 0,
    failed: 0,
  };
}

interface ClaimedOrder {
  id: number;
  printifyOrderId: string;
  fulfillmentState: string;
  providerStatus: string | null;
  deliveredAt: Date | null;
}

/**
 * Orders that are at Printify, are not finished, and have not been looked at
 * recently — least recently looked at first.
 *
 * Both halves of the partial index's predicate are in this WHERE clause
 * (`printify_order_id IS NOT NULL`, `delivered_at IS NULL`) so the index is
 * guaranteed to imply the query. A delivered order is finished with this poller
 * permanently; a canceled one is excluded here rather than in DDL, because
 * baking a state literal into an index predicate is the trap 0028 already
 * records.
 *
 * `SKIP LOCKED` for the same reason the fulfilment worker uses it: a second
 * api-server instance passes over a row this one is mid-check on rather than
 * queueing behind it. The lock is released when this short transaction commits;
 * the actual protection against two instances disagreeing is that each write
 * below re-reads the row under `FOR UPDATE` and applies `nextFulfillmentState`,
 * which is monotonic — so a stale reader can only ever fail to advance, never
 * pull an order backwards.
 *
 * `NULLS FIRST` is explicit: a never-checked order has a NULL stamp, Postgres
 * sorts NULLs LAST in ascending order by default, and the row that has never
 * been looked at is precisely the one that should be looked at first.
 */
async function claimDueForSync(now: Date, limit: number): Promise<ClaimedOrder[]> {
  const dueBy = new Date(now.getTime() - STATUS_SYNC_MIN_INTERVAL_MS);
  return db.transaction(async (tx) =>
    tx
      .select({
        id: commerceOrdersTable.id,
        printifyOrderId: commerceOrdersTable.printifyOrderId,
        fulfillmentState: commerceOrdersTable.fulfillmentState,
        providerStatus: commerceOrdersTable.providerStatus,
        deliveredAt: commerceOrdersTable.deliveredAt,
      })
      .from(commerceOrdersTable)
      .where(
        and(
          isNotNull(commerceOrdersTable.printifyOrderId),
          isNull(commerceOrdersTable.deliveredAt),
          sql`${commerceOrdersTable.fulfillmentState} <> ${FULFILLMENT_CANCELED}`,
          or(
            isNull(commerceOrdersTable.fulfillmentSyncedAt),
            lte(commerceOrdersTable.fulfillmentSyncedAt, dueBy),
          ),
        ),
      )
      .orderBy(sql`${commerceOrdersTable.fulfillmentSyncedAt} asc nulls first`)
      .limit(limit)
      .for("update", { skipLocked: true }),
  ) as Promise<ClaimedOrder[]>;
}

/** Record that we looked and learnt nothing actionable. Never touches state. */
async function stampChecked(orderId: number, now: Date): Promise<void> {
  await db
    .update(commerceOrdersTable)
    .set({ fulfillmentSyncedAt: now })
    .where(eq(commerceOrdersTable.id, orderId));
}

/**
 * The first shipment that carries anything worth keeping.
 *
 * First rather than merged: v0.1 sells one sticker, a single-item order has a
 * single parcel, and inventing a policy for the multi-parcel case before there
 * is one would be a policy nobody has tested. A `partially-fulfilled` order with
 * two shipments shows the first, and the state still says `shipped`, which is
 * true of both.
 */
function firstTracking(state: PrintifyOrderState): {
  carrier: string | null;
  number: string | null;
  url: string | null;
} | null {
  for (const s of state.shipments) {
    if (s.carrier !== null || s.number !== null || s.url !== null) {
      return { carrier: s.carrier, number: s.number, url: s.url };
    }
  }
  return null;
}

/** The earliest `delivered_at` any shipment reports, as a Date, or null. */
function deliveredAtFrom(state: PrintifyOrderState): Date | null {
  let earliest: Date | null = null;
  for (const s of state.shipments) {
    if (s.deliveredAt === null) continue;
    const at = new Date(s.deliveredAt);
    if (Number.isNaN(at.getTime())) continue;
    if (earliest === null || at < earliest) earliest = at;
  }
  return earliest;
}

/**
 * Apply one order's reading, under the row lock.
 *
 * Re-reads the state inside the transaction rather than trusting the claim: the
 * fulfilment worker may have released the order in the gap, and applying
 * `nextFulfillmentState` to a value read minutes ago could otherwise write a
 * lower rung than the row already holds. `nextFulfillmentState` is monotonic
 * over the ladder, so even without the re-read the worst case is a no-op — the
 * re-read makes it exactly a no-op rather than nearly one.
 *
 * Returns what happened, for the tick's counters.
 */
async function applyReading(
  orderId: number,
  state: PrintifyOrderState,
  now: Date,
): Promise<"advanced" | "unchanged" | "unknown"> {
  const observed = mapProviderStatus(state.status);
  const delivered = deliveredAtFrom(state);
  const tracking = firstTracking(state);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        fulfillmentState: commerceOrdersTable.fulfillmentState,
        providerStatus: commerceOrdersTable.providerStatus,
        shippedAt: commerceOrdersTable.shippedAt,
        deliveredAt: commerceOrdersTable.deliveredAt,
      })
      .from(commerceOrdersTable)
      .where(eq(commerceOrdersTable.id, orderId))
      .limit(1)
      .for("update");
    if (!row) return "unchanged" as const;

    // A shipment that reports a delivery date is the ONLY evidence of delivery
    // there is: Printify's order lifecycle has no `delivered` status at all. It
    // is applied through the same monotonic guard as everything else rather than
    // written straight onto the row.
    let target = nextFulfillmentState(row.fulfillmentState, observed);
    if (delivered !== null) target = nextFulfillmentState(target, "delivered");

    const update: Partial<typeof commerceOrdersTable.$inferInsert> = {
      fulfillmentSyncedAt: now,
    };

    // The provider's literal, verbatim, whether or not we could map it — that
    // is what lets an operator find out what a new status IS, instead of
    // inferring it from an order that quietly stopped moving.
    if (state.status !== null && state.status !== row.providerStatus) {
      update.providerStatus = state.status;
      update.providerStatusAt = now;
    }

    if (tracking !== null) {
      update.trackingCarrier = tracking.carrier;
      update.trackingNumber = tracking.number;
      update.trackingUrl = tracking.url;
    }

    const moved = target !== row.fulfillmentState;
    if (moved) {
      update.fulfillmentState = target;
      update.updatedAt = now;
      // Stage stamps are written once. `?? now` covers the ordinary case where
      // Printify tells us an order shipped without telling us when; a second
      // pass must not overwrite the first answer with a later clock reading.
      if (target === "shipped" && row.shippedAt === null) update.shippedAt = now;
      if (target === "delivered") {
        if (row.shippedAt === null) update.shippedAt = delivered ?? now;
        if (row.deliveredAt === null) update.deliveredAt = delivered ?? now;
      }
    }

    await tx.update(commerceOrdersTable).set(update).where(eq(commerceOrdersTable.id, orderId));

    if (moved) return "advanced" as const;
    // An unrecognised status is reported separately from a recognised one that
    // simply has not changed. They look identical on the row and they are very
    // different facts about this build.
    return observed === null && state.status !== null ? ("unknown" as const) : ("unchanged" as const);
  });
}

/**
 * One pass.
 *
 * A provider refusal is caught PER ORDER rather than around the loop: one order
 * Printify will not talk about must not stop the other twenty-four from being
 * read. `PrintifyNotConfiguredError` is the exception — a rotation that emptied
 * the environment mid-tick makes every remaining call pointless — and it is
 * rethrown to be handled once, at the top.
 */
export async function runStatusSyncTickOnce(
  now: Date = new Date(),
): Promise<StatusSyncTickResult> {
  if (!printifyEnabled() || !statusSyncEnabled()) return emptyResult("disabled");

  let printify: PrintifyClient;
  try {
    printify = getUncachablePrintifyClient();
  } catch (err) {
    if (err instanceof PrintifyNotConfiguredError) {
      // Armed and uncredentialed. No row is touched — in particular
      // `fulfillment_synced_at` is NOT stamped, because nothing looked, and
      // stamping it would make the deployment's own broken configuration read
      // as healthy on exactly the column that exists to reveal it.
      logger.warn(
        { reason: err.message },
        "Printify status sync is armed but Printify is not configured — tick skipped",
      );
      return emptyResult("not_configured");
    }
    throw err;
  }

  const result = emptyResult(null);
  const claimed = await claimDueForSync(now, BATCH_SIZE);

  for (const order of claimed) {
    let state: PrintifyOrderState | null;
    try {
      state = await printify.getOrder(order.printifyOrderId);
    } catch (err) {
      if (err instanceof PrintifyNotConfiguredError) throw err;
      if (!(err instanceof PrintifyError)) {
        // Our bug, not the order's. Not stamped as checked, because it was not.
        logger.error({ err, orderId: order.id }, "Printify status sync failed for a non-provider reason");
        result.failed += 1;
        continue;
      }
      // A provider refusal IS a completed check in the sense that matters here:
      // we asked, we were answered, and the answer was no. Stamping it paces the
      // retry at the same interval as everything else instead of hammering one
      // unreadable order on every tick. Only the status and Printify's numeric
      // code are logged — never a body, which on this path quotes a street back.
      logger.warn(
        { orderId: order.id, printifyStatus: err.status, printifyCode: err.code },
        "Printify refused a status read",
      );
      await stampChecked(order.id, now);
      result.failed += 1;
      continue;
    }

    if (state === null) {
      // Printify answered, and the answer is that this shop has no such order.
      // Loud, and NOTHING is changed: the local row is the record that we
      // submitted it and got an id back, and deciding here that a submitted
      // order never happened would be this poller inventing news. An operator
      // looks it up.
      logger.warn(
        { orderId: order.id },
        "Printify has no order under the id on this row — status left untouched",
      );
      await stampChecked(order.id, now);
      result.vanished += 1;
      continue;
    }

    // Counted here and not before the 404 branch: `checked` means "an order was
    // read back", and a 404 is a completed request that produced no order. The
    // three failure counters — `vanished`, `failed` — say what happened to the
    // rest, and every claimed order lands in exactly one of the four.
    result.checked += 1;

    const outcome = await applyReading(order.id, state, now);
    if (outcome === "advanced") {
      result.advanced += 1;
      logger.info(
        { orderId: order.id, providerStatus: state.status },
        "Printify status sync advanced a fulfilment stage",
      );
    } else if (outcome === "unknown") {
      result.unknownStatus += 1;
      // Once per order per check, and it carries the literal, because that
      // literal is the only way anybody finds out what a new Printify status
      // means. The row keeps it too — this is the fast path to noticing.
      logger.warn(
        { orderId: order.id, providerStatus: state.status },
        "Printify reported a status this build has no mapping for — fulfilment state left untouched",
      );
    } else {
      result.unchanged += 1;
    }
  }

  return result;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const result = await runStatusSyncTickOnce();
    // Logged whenever anything at all was read, INCLUDING a pass that changed
    // nothing. That is the positive signal: "checked 3, advanced 0" and total
    // silence are different readings, and only one of them means the poller is
    // alive.
    if (result.checked > 0 || result.failed > 0) {
      logger.info(result, "Printify status sync tick completed");
    }
  } catch (err) {
    logger.error({ err }, "Printify status sync tick failed");
  } finally {
    running = false;
  }
}

/**
 * Start the poller, or say why there is nothing to start.
 *
 * Never throws. An unconfigured deployment is the DEFAULT state of this feature
 * and boot must not care — and the log line naming both flags is deliberate,
 * because "which switch is off" is the question this whole feature exists to
 * stop people answering by hand.
 */
export function startCommerceFulfillmentStatusSync(): void {
  if (timer) return;
  if (!printifyEnabled() || !statusSyncEnabled()) {
    logger.info(
      { printifyEnabled: printifyEnabled(), statusSync: statusSyncEnabled() },
      "Printify status sync inert — KAX_PRINTIFY_ENABLED and KAX_PRINTIFY_STATUS_SYNC must both be on",
    );
    return;
  }
  timer = setInterval(() => {
    void tick();
  }, STATUS_SYNC_TICK_INTERVAL_MS);
  // The HTTP server holds this process open; this timer must never be the
  // reason anything stays alive, least of all a test that imported the module
  // for one of its exported helpers.
  timer.unref();
  logger.info(
    { intervalMs: STATUS_SYNC_TICK_INTERVAL_MS, minPerOrderMs: STATUS_SYNC_MIN_INTERVAL_MS },
    "Printify status sync started",
  );
  void tick();
}

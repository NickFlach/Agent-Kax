import { db } from "@workspace/db";
import { commerceOrdersTable, commerceProductsTable, type CommerceOrder } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { addressToFromSnapshot, type PrintifyClient } from "./printifyClient";

/**
 * commerceFulfillment.ts — the two fulfilment steps themselves, with no opinion
 * about who is pressing them.
 *
 * This is `routes/admin.ts`'s submit and release lifted out verbatim, because
 * there are now two callers — an operator with a button and
 * `commerceFulfillmentWorker.ts` with a timer — and the properties below are
 * the difference between one parcel and two. Two copies of that reasoning is
 * one copy too many: the copy that drifts is the one that double-prints.
 *
 * Everything load-bearing lives here rather than in either caller:
 *
 * - **`SELECT … FOR UPDATE` around the whole decision.** The guards are read
 *   under the row lock, so they judge the order as it is at the moment of the
 *   press rather than as it was when the page was opened. That is what makes
 *   `refunded` and `chargeback` protective rather than decorative, and it is
 *   what makes two simultaneous presses produce one print run.
 * - **The provider call happens INSIDE that lock, deliberately.** A second
 *   press waits for the first one's answer instead of racing it.
 * - **`printify_order_id IS NOT NULL` is the double-submit guard** and
 *   `released_at IS NOT NULL` the double-release guard.
 * - **`status !== "paid"` refuses, in BOTH steps.** Charge first, then submit,
 *   always: a Stripe refund is one API call and unwinding a print run is not,
 *   and Printify charges the merchant's own card at submission. Release checks
 *   it too, and that is not redundant — it is the only check standing between a
 *   dispute and a print run. Submission and production are minutes apart by
 *   design, `charge.dispute.created` lands inside that window, and an order
 *   read as `paid` at submit is an order whose money may already have gone by
 *   the time anything is manufactured. Release reads `status` under its OWN
 *   lock, at its own moment, for exactly that reason.
 * - **A `PrintifyError` is allowed to propagate**, which rolls the transaction
 *   back, so an order the printer rejected keeps its `unfulfilled` state and
 *   its null id and can simply be submitted again once the reason is fixed.
 * - **The address comes from the order's own `ship_to_*` snapshot**, via
 *   `addressToFromSnapshot`, and never from a live `users` or
 *   `user_shipping_addresses` join. An address edit after the fact must not be
 *   able to rewrite where an already-shipped parcel went.
 *
 * Nothing here logs and nothing here returns a `ship_to_*` value. The outcomes
 * are discriminated unions and not HTTP responses, because one caller maps them
 * to status codes and the other to a retry decision; a function that already
 * knew it was answering a request could not serve the second.
 *
 * The worker-state columns (`fulfillment_attempts` and friends) are deliberately
 * NOT touched by `submitCommerceOrder` or `releaseCommerceOrder`. They belong to
 * the worker, and leaving them alone is what keeps the manual path exactly what
 * it was before the worker existed. `reconcileCommerceOrderSubmission` is the
 * one exception and it is a narrow one: those columns are where the DOUBT about
 * a submission is recorded, and adopting a found order is the moment the doubt
 * stops existing, so clearing them there is writing down the same fact as the id.
 */

/** The database handle, or a transaction on it. */
type Db = typeof db;

export type SubmitOutcome =
  | { kind: "not_found" }
  | { kind: "not_paid"; order: CommerceOrder }
  | { kind: "not_printable"; order: CommerceOrder }
  | { kind: "already_submitted"; order: CommerceOrder; printifyOrderId: string }
  | { kind: "submitted"; order: CommerceOrder; printifyOrderId: string; submittedAt: Date };

export type ReleaseOutcome =
  | { kind: "not_found" }
  | { kind: "not_paid"; order: CommerceOrder }
  | { kind: "not_submitted"; order: CommerceOrder }
  | { kind: "already_released"; order: CommerceOrder }
  | { kind: "released"; order: CommerceOrder; releasedAt: Date; providerStatus: string | null };

/** What asking Printify whether it already has this order concluded. */
export type ReconcileOutcome =
  /** No such row. Nothing to reconcile and nothing to submit. */
  | { kind: "not_found" }
  /** The row already carried an id. Nobody needs to look or post. */
  | { kind: "already_submitted"; printifyOrderId: string }
  /** Printify had it. The id is now on the row; posting again would duplicate it. */
  | { kind: "adopted"; printifyOrderId: string; providerStatus: string | null }
  /** A completed search proved it absent. Submitting creates the FIRST parcel. */
  | { kind: "absent" };

/**
 * Ask Printify whether it already has this order, before anybody submits it.
 *
 * ## Why this runs before EVERY submission and not only after a doubtful one
 *
 * The first version of this guard ran only when `fulfillment_last_error` held an
 * ambiguity marker, and the marker was written after the POST returned. Those
 * two facts do not fit together: the failures the marker exists for — a crash
 * mid-POST, an OOM, a pod killed by a rolling deploy, a database that blinked
 * while the provider call was in flight — are exactly the failures that prevent
 * the marker from being written at all. A row that lost its process inside the
 * POST window is left looking pristine: null id, zero attempts, null error. The
 * next tick would read that as "never tried" and post it again, and the marker
 * whose whole job was to stop that was never written because the thing it was
 * meant to describe is what stopped it.
 *
 * A durable pre-POST intent write would close it too — write "about to submit",
 * commit, then post — but it costs a transaction on every submission to record
 * something a single GET can find out for certain afterwards, and it still has
 * to be reconciled against Printify to be acted on. Reconciling unconditionally
 * is cheaper, is one code path instead of two, and closes a second hole in the
 * same motion: a marker that gets overwritten (by a later unrelated failure, or
 * by an operator) can no longer hide an existing order, because nothing consults
 * the marker to decide whether to look.
 *
 * The cost is one extra GET per submission, against Printify's 600/minute
 * ceiling, on a shop that submits a handful of orders a day.
 *
 * ## What it does NOT do
 *
 * It does not decide anything about money, and it does not submit. It is a
 * lookup and, if the lookup finds something, an adoption under the row lock. A
 * lookup that fails THROWS — `PrintifyError` straight out of the adapter — and
 * the caller must treat that as "still unknown", never as "absent". That is the
 * property the whole guard rests on and it is enforced in `printifyClient.ts`:
 * `null` is returned only for a completed search over pages it could parse.
 */
export async function reconcileCommerceOrderSubmission(
  database: Db,
  printify: PrintifyClient,
  orderId: number,
  now: Date = new Date(),
): Promise<ReconcileOutcome> {
  const [order] = await database
    .select({
      clientReference: commerceOrdersTable.clientReference,
      printifyOrderId: commerceOrdersTable.printifyOrderId,
    })
    .from(commerceOrdersTable)
    .where(eq(commerceOrdersTable.id, orderId))
    .limit(1);
  if (!order) return { kind: "not_found" } as const;
  // An id already on the row answers the question without a provider call.
  if (order.printifyOrderId !== null) {
    return { kind: "already_submitted", printifyOrderId: order.printifyOrderId } as const;
  }

  // Throws on a failed or unparseable search, deliberately. See the header.
  const found = await printify.findOrderByExternalId(order.clientReference);
  if (found === null) return { kind: "absent" } as const;

  // The lookup ran outside any lock, so the row is re-read under `FOR UPDATE`
  // and `printify_order_id IS NULL` re-checked before the id is written. Two
  // instances that both looked the same order up still write one id between
  // them, and the loser reports `already_submitted` rather than posting.
  return database.transaction(async (tx) => {
    const [locked] = await tx
      .select({ printifyOrderId: commerceOrdersTable.printifyOrderId })
      .from(commerceOrdersTable)
      .where(eq(commerceOrdersTable.id, orderId))
      .limit(1)
      .for("update");
    if (!locked) return { kind: "not_found" } as const;
    if (locked.printifyOrderId !== null) {
      return { kind: "already_submitted", printifyOrderId: locked.printifyOrderId } as const;
    }
    await tx
      .update(commerceOrdersTable)
      .set({
        printifyOrderId: found.id,
        fulfillmentState: "submitted",
        // The provider's clock is not ours to read, so the hold window starts
        // from the moment we LEARNED the order exists. That is the conservative
        // direction: it can only delay production, never bring it forward.
        submittedAt: now,
        // The doubt is what these columns held, and the doubt is now resolved.
        fulfillmentAttempts: 0,
        fulfillmentLastError: null,
        fulfillmentLastAttemptAt: now,
        fulfillmentNextAttemptAt: null,
        updatedAt: now,
      })
      .where(eq(commerceOrdersTable.id, orderId));
    return { kind: "adopted", printifyOrderId: found.id, providerStatus: found.status } as const;
  });
}

/**
 * Create the order at Printify, once.
 *
 * Throws `PrintifyError` when the provider refuses — the transaction rolls back
 * with it, which is what leaves the order submittable rather than stranded
 * half-submitted. Every other refusal is an outcome rather than an exception,
 * because "not paid" and "not printable" are facts about the order that both
 * callers have to act on rather than failures of this call.
 */
export async function submitCommerceOrder(
  database: Db,
  printify: PrintifyClient,
  orderId: number,
): Promise<SubmitOutcome> {
  return database.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(commerceOrdersTable)
      .where(eq(commerceOrdersTable.id, orderId))
      .limit(1)
      .for("update");
    if (!order) return { kind: "not_found" } as const;

    // Already submitted: hand back the id we already have and call nothing.
    // This is the branch that makes a double-click, a retried deploy script
    // and a second operator all cost one print run.
    if (order.printifyOrderId) {
      return { kind: "already_submitted", order, printifyOrderId: order.printifyOrderId } as const;
    }

    if (order.status !== "paid") {
      return { kind: "not_paid", order } as const;
    }

    // The product is looked up by the SKU the order recorded, because the
    // order snapshots what was sold rather than pointing at a row that can be
    // repriced or re-wired afterwards. Only the print identifiers come from
    // here; no money does.
    const [product] = await tx
      .select({
        printifyProductId: commerceProductsTable.printifyProductId,
        printifyVariantId: commerceProductsTable.printifyVariantId,
      })
      .from(commerceProductsTable)
      .where(eq(commerceProductsTable.sku, order.sku))
      .limit(1);

    // `printify_variant_id` is varchar so that an opaque foreign key never
    // gets arithmetic done to it; Printify wants the number, so the
    // conversion happens here at the boundary and a value that is not one is
    // a product nobody can print rather than a `NaN` posted to a printer.
    const variantId = Number(product?.printifyVariantId);
    if (!product?.printifyProductId || !Number.isInteger(variantId) || variantId <= 0) {
      return { kind: "not_printable", order } as const;
    }

    const submitted = await printify.submitOrder({
      externalId: order.clientReference,
      label: order.clientReference,
      lineItems: [
        { product_id: product.printifyProductId, variant_id: variantId, quantity: 1 },
      ],
      addressTo: addressToFromSnapshot(order),
    });

    const now = new Date();
    await tx
      .update(commerceOrdersTable)
      .set({
        printifyOrderId: submitted.id,
        fulfillmentState: "submitted",
        submittedAt: now,
        updatedAt: now,
      })
      .where(eq(commerceOrdersTable.id, order.id));

    return { kind: "submitted", order, printifyOrderId: submitted.id, submittedAt: now } as const;
  });
}

/**
 * Send an already-submitted order to production, once.
 *
 * `actor` is recorded verbatim on `release_actor`. It is a user id when a human
 * pressed the button and a sentinel when the worker did; the column is a
 * varchar with no foreign key precisely so the second case does not have to
 * invent a user row to be recorded honestly.
 *
 * **`status` is re-read here and it is load-bearing.** Production is the step
 * that spends money on manufacturing, and it happens minutes — the release hold
 * — after the submission that checked `paid`. A `charge.dispute.created` or a
 * `charge.refunded` delivery landing inside that window moves the row to
 * `chargeback` or `refunded`, and this locked read is the only thing that
 * notices. Without it the two-step's whole approval window is a window in which
 * the money can leave and the parcel is printed anyway.
 */
export async function releaseCommerceOrder(
  database: Db,
  printify: PrintifyClient,
  orderId: number,
  actor: string,
): Promise<ReleaseOutcome> {
  return database.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(commerceOrdersTable)
      .where(eq(commerceOrdersTable.id, orderId))
      .limit(1)
      .for("update");
    if (!order) return { kind: "not_found" } as const;

    if (order.releasedAt) {
      return { kind: "already_released", order } as const;
    }

    // Before the mechanics of the two-step, the question the two-step is FOR:
    // is this still paid for? Checked ahead of `not_submitted` because it is
    // the more fundamental refusal — an order whose money has been clawed back
    // must not be manufactured whether or not it ever reached Printify.
    if (order.status !== "paid") {
      return { kind: "not_paid", order } as const;
    }

    if (!order.printifyOrderId) {
      // Release is the second half of a two-step, and the first half has not
      // happened. Nothing to send to production, and inventing a submission
      // here would be the single-step flow this endpoint exists to avoid.
      return { kind: "not_submitted", order } as const;
    }

    const released = await printify.sendToProduction(order.printifyOrderId);

    const now = new Date();
    await tx
      .update(commerceOrdersTable)
      .set({
        fulfillmentState: "in_production",
        releasedAt: now,
        releaseActor: actor,
        updatedAt: now,
      })
      .where(eq(commerceOrdersTable.id, order.id));

    return { kind: "released", order, releasedAt: now, providerStatus: released.status } as const;
  });
}

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
 * - **`status !== "paid"` refuses.** Charge first, then submit, always: a
 *   Stripe refund is one API call and unwinding a print run is not, and
 *   Printify charges the merchant's own card at submission.
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
 * NOT touched here. They belong to the worker, and leaving them alone is what
 * keeps the manual path exactly what it was before the worker existed.
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
  | { kind: "not_submitted"; order: CommerceOrder }
  | { kind: "already_released"; order: CommerceOrder }
  | { kind: "released"; order: CommerceOrder; releasedAt: Date; providerStatus: string | null };

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

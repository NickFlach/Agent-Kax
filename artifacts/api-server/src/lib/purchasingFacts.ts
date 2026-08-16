/**
 * The database half of the purchasing gate: read the rows, hand them to the
 * pure derivation in `purchasingState.ts`.
 *
 * The split is not ceremony. `purchasingState.ts` decides the answer and can be
 * tested against an exact instant with no Postgres anywhere near it, because
 * importing `@workspace/db` opens a connection pool at module load. This file
 * is the only place that knows the queries, so when the purchase endpoint has
 * to recompute the same state server-side it asks the same four questions of
 * the same four tables rather than a near-miss of its own.
 *
 * Nothing here reads the credit ledger, the Joinery, or `store_listings.price`.
 * Physical goods are bought with USD and nothing else, and the way that stays
 * true is that no import from this file can reach play_credit at all.
 */

import { db } from "@workspace/db";
import {
  commerceOrdersTable,
  userPaymentMethodsTable,
  userPurchasingConsentsTable,
  userShippingAddressesTable,
} from "@workspace/db/schema";
import { and, desc, eq, gte, isNull, ne, notInArray, sql } from "drizzle-orm";
import { commerceEnabled } from "./stripeClient";
import { logger } from "./logger";
import { NON_CHARGEABLE_ORDER_STATUSES } from "./commerceOrderStatus";
import {
  CURRENT_STORED_CARD_TERMS_VERSION,
  DEFAULT_DAILY_ORDER_CAP,
  SUPPORTED_SHIP_TO_COUNTRIES,
  derivePurchasingState,
  resolveDailyOrderCap,
  type PurchasingFacts,
  type PurchasingSnapshot,
} from "./purchasingState";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The facts about an account nobody has looked anything up for. Both the
 * anonymous case and the fail-closed case are this plus a flag, and they are
 * built through the real derivation rather than written out as literals so that
 * "disabled" cannot come to mean two different shapes in two different files.
 */
function emptyFacts(commerce: boolean): PurchasingFacts {
  return {
    commerceEnabled: commerce,
    authenticated: false,
    address: null,
    paymentMethods: [],
    consent: null,
    currentTermsVersion: CURRENT_STORED_CARD_TERMS_VERSION,
    chargeableOrdersLast24h: 0,
    dailyOrderCap: DEFAULT_DAILY_ORDER_CAP,
    supportedCountries: SUPPORTED_SHIP_TO_COUNTRIES,
    now: new Date(),
  };
}

/** Commerce is off, or the schema behind it is not there. */
function disabledSnapshot(): PurchasingSnapshot {
  return derivePurchasingState(emptyFacts(false));
}

/**
 * The state for a caller with no session.
 *
 * Still gated on the flag first: with the commerce surface off there is nothing
 * to sign in *for*, and telling an anonymous visitor to sign in so they can buy
 * something that is not for sale is worse than saying nothing.
 */
export function anonymousPurchasingSnapshot(): PurchasingSnapshot {
  return derivePurchasingState(emptyFacts(commerceEnabled()));
}

export interface PurchasingSnapshotOptions {
  /**
   * An order to leave out of the 24-hour cap count.
   *
   * Used by exactly one caller: the retry of a purchase whose row was written
   * and never got a PaymentIntent. That row is already in the table and already
   * counts, so recomputing the account's state against it unchanged would refuse
   * the buyer's own retry with `cap_reached` at the boundary and wedge the row
   * forever. Excluding it asks the question the retry actually poses — "may this
   * account make a charge, setting aside the one it is already trying to make" —
   * and leaves every OTHER order counting, so an account genuinely at the cap is
   * still refused.
   */
  excludeOrderId?: number;
}

/**
 * Derive one account's purchasing state.
 *
 * `GET /me` is the endpoint the whole client hits on every page load, so this
 * fails to `disabled` rather than throwing. A deployment where migration 0026
 * has not landed yet, or where the flag was flipped on ahead of the schema,
 * must not be one where signing in stops working — and `disabled` is the
 * fail-closed answer, because it is the one that offers nothing for sale.
 */
export async function loadPurchasingSnapshot(
  userId: string,
  options: PurchasingSnapshotOptions = {},
): Promise<PurchasingSnapshot> {
  if (!commerceEnabled()) return disabledSnapshot();

  try {
    const since = new Date(Date.now() - DAY_MS);

    const [addressRows, paymentMethodRows, consentRows, chargeableRows] = await Promise.all([
      // One live address per user is a partial unique index, so this is a row
      // or nothing. Only the two fields that leave the server are selected —
      // the street lines are not fetched, which is the cheapest possible
      // guarantee that they cannot be logged or serialised by accident.
      db
        .select({
          country: userShippingAddressesTable.country,
          postalCode: userShippingAddressesTable.postalCode,
        })
        .from(userShippingAddressesTable)
        .where(
          and(
            eq(userShippingAddressesTable.userId, userId),
            isNull(userShippingAddressesTable.archivedAt),
          ),
        )
        .limit(1),
      // Detached rows included, deliberately: their presence is what turns
      // "you have no card" into "your card was removed".
      db
        .select({
          brand: userPaymentMethodsTable.brand,
          last4: userPaymentMethodsTable.last4,
          expMonth: userPaymentMethodsTable.expMonth,
          expYear: userPaymentMethodsTable.expYear,
          isDefault: userPaymentMethodsTable.isDefault,
          detachedAt: userPaymentMethodsTable.detachedAt,
        })
        .from(userPaymentMethodsTable)
        .where(eq(userPaymentMethodsTable.userId, userId))
        .orderBy(desc(userPaymentMethodsTable.createdAt)),
      db
        .select({ termsVersion: userPurchasingConsentsTable.termsVersion })
        .from(userPurchasingConsentsTable)
        .where(eq(userPurchasingConsentsTable.userId, userId))
        .orderBy(desc(userPurchasingConsentsTable.acceptedAt))
        .limit(1),
      // Every order that represents a real charge ATTEMPT, which is what the
      // cap brakes — not only the settled ones. Stated as an exclusion of the
      // two states where nothing was taken and nothing will be, so a status
      // added to the vocabulary later counts by default rather than slipping
      // past the limit unnoticed.
      //
      // `status` is a varchar and this is a set test on known literals, which is
      // exactly why it is not a pgEnum: an unrecognised value here matches
      // instead of raising.
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(commerceOrdersTable)
        .where(
          and(
            eq(commerceOrdersTable.buyerUserId, userId),
            notInArray(commerceOrdersTable.status, [...NON_CHARGEABLE_ORDER_STATUSES]),
            gte(commerceOrdersTable.createdAt, since),
            ...(options.excludeOrderId === undefined
              ? []
              : [ne(commerceOrdersTable.id, options.excludeOrderId)]),
          ),
        ),
    ]);

    return derivePurchasingState({
      commerceEnabled: true,
      authenticated: true,
      address: addressRows[0] ?? null,
      paymentMethods: paymentMethodRows,
      consent: consentRows[0] ?? null,
      currentTermsVersion: CURRENT_STORED_CARD_TERMS_VERSION,
      chargeableOrdersLast24h: chargeableRows[0]?.n ?? 0,
      dailyOrderCap: resolveDailyOrderCap(process.env["KAX_COMMERCE_DAILY_ORDER_CAP"]),
      supportedCountries: SUPPORTED_SHIP_TO_COUNTRIES,
      now: new Date(),
    });
  } catch (err) {
    // No userId in the log line and certainly no address: this is a schema or
    // connectivity failure, and the only useful thing to say about it is what
    // went wrong.
    logger.warn({ err }, "purchasing state unavailable — reporting disabled");
    return disabledSnapshot();
  }
}

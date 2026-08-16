import { boolean, index, integer, pgTable, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { artifactsTable } from "./artifacts";
import { usersTable } from "./auth";

/**
 * Physical commerce: real dollars, a real card, and something that arrives in
 * the post.
 *
 * This is a separate economy from the Joinery and from `store_listings`, and
 * the separation is structural rather than a convention. Every amount here is
 * an INTEGER of USD cents in a column named for its unit. Nothing on this path
 * reads `store_listings.price`, which means play_credit minor units to
 * `lib/joinery.ts` and USD dollars to `routes/store-checkout.ts` — that
 * ambiguity is issue #269 and it is why furniture is hard-refused there.
 * play_credit cannot buy a physical good, and the way that is guaranteed is
 * that no code path from these tables reaches the credit ledger at all.
 */

/**
 * Something KAX will actually manufacture and ship.
 *
 * Keyed on `sku`, not on an artifact: the same artifact is a different product
 * as a 3.5in sticker than as a 12 × 18 poster, with different print
 * requirements and a different price, so per-artifact identity would be a lie
 * about at least one of them.
 *
 * `published` is the only thing that makes a row sellable, and it defaults to
 * false. The sticker seeded by migration 0026 exists unpublished on purpose:
 * the row is inert until an operator has wired it to an artifact and confirmed
 * the price against the live Printify quote.
 */
export const commerceProductsTable = pgTable(
  "commerce_products",
  {
    id: serial("id").primaryKey(),
    /** Stable, human-readable product key. The order snapshots this string. */
    sku: varchar("sku").notNull().unique(),
    title: varchar("title").notNull(),
    /**
     * The artwork this product prints. Nullable because the product row is
     * created before anyone has chosen the piece, and `ON DELETE SET NULL`
     * because deleting an artifact must not delete the record of a product
     * that has been sold. A published product with no artifact cannot be
     * quoted — that check belongs to the route, not to a NOT NULL that would
     * make the row unseedable.
     */
    artifactId: integer("artifact_id").references(() => artifactsTable.id, { onDelete: "set null" }),
    /**
     * Printify's own identifiers for the blueprint and the variant. Both are
     * varchar: the product id is a hex string and the variant id is numeric,
     * and storing the numeric one as an integer would invite arithmetic on an
     * opaque foreign key.
     */
    printifyProductId: varchar("printify_product_id"),
    printifyVariantId: varchar("printify_variant_id"),
    /** USD cents for the item itself. Never a float, never a dollar amount. */
    itemCents: integer("item_cents").notNull(),
    /** USD cents for standard shipping to a supported destination. */
    shippingCents: integer("shipping_cents").notNull().default(0),
    currency: varchar("currency").notNull().default("usd"),
    published: boolean("published").notNull().default(false),
    /**
     * ISO 3166-1 alpha-2 codes this product can be sent to. An address outside
     * the list is refused with "we can't ship to GB yet" rather than a generic
     * failure, which is the difference between a limitation and a bug.
     */
    shipToCountries: text("ship_to_countries").array().notNull().default(["US"]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("commerce_products_published_idx").on(t.published)],
);

export type CommerceProduct = typeof commerceProductsTable.$inferSelect;
export type InsertCommerceProduct = typeof commerceProductsTable.$inferInsert;

/**
 * One purchase of a physical product. This row IS the commerce record of
 * truth — v0.1 adds no ledger, and the normalized commerce event is a
 * projection of these columns.
 *
 * Three properties are load-bearing.
 *
 * **`client_reference` is unique, and it is the idempotency key for the whole
 * purchase.** It is minted once per press of the Buy button and reused across
 * every retry, so the row is written first with `onConflictDoNothing` on this
 * target and only then is Stripe called, under a key derived from the row.
 * Charging before the row exists makes a lost response unreconcilable; the
 * reverse order is recoverable by reading the row back.
 *
 * **The shipping address is SNAPSHOTTED onto the order.** The `ship_to_*`
 * columns are copies taken at charge time and there is deliberately NO foreign
 * key to `user_shipping_addresses`. A buyer who moves house and edits their
 * address would otherwise rewrite where an already-shipped order went — and
 * take the dispute evidence with it. The Printify submission builds
 * `address_to` from these columns and never from a live join.
 *
 * **No foreign key to `store_listings` or `listing_orders`.** Those belong to
 * the digital path. `listing_id`'s cascade would let a delisting destroy the
 * record of a card charge, and this table is keyed on a product, not a
 * listing. The two order tables are never joined and never unioned.
 *
 * Both state columns are `varchar` and not `pgEnum`, for the reason recorded
 * throughout this repo: an unknown enum literal in a `WHERE` clause is a 500,
 * not a query that matches nothing.
 */
export const commerceOrdersTable = pgTable(
  "commerce_orders",
  {
    id: serial("id").primaryKey(),
    /** The purchase's idempotency key. One press of Buy, one value, forever. */
    clientReference: varchar("client_reference").notNull().unique(),
    buyerUserId: varchar("buyer_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    /** The product as sold, by key. Not a foreign key: repricing a product
     *  must not retroactively change what an order says was bought. */
    sku: varchar("sku").notNull(),
    currency: varchar("currency").notNull().default("usd"),
    itemCents: integer("item_cents").notNull(),
    shippingCents: integer("shipping_cents").notNull().default(0),
    /**
     * Zero in v0.1 and present anyway. With no active registration Stripe Tax
     * returns zero silently — a wrong answer rather than an error — so the
     * column exists from day one and turning tax on later is a code change
     * instead of a migration against live orders.
     */
    taxCents: integer("tax_cents").notNull().default(0),
    /** What the card was actually charged. The sum, stored, not recomputed. */
    totalCents: integer("total_cents").notNull(),

    // The address snapshot. Copied at charge time, never joined, never logged.
    shipToName: varchar("ship_to_name").notNull(),
    shipToLine1: varchar("ship_to_line1").notNull(),
    shipToLine2: varchar("ship_to_line2"),
    shipToCity: varchar("ship_to_city").notNull(),
    shipToRegion: varchar("ship_to_region").notNull(),
    shipToPostalCode: varchar("ship_to_postal_code").notNull(),
    shipToCountry: varchar("ship_to_country").notNull(),
    shipToPhone: varchar("ship_to_phone"),

    stripePaymentIntentId: varchar("stripe_payment_intent_id"),
    /**
     * pending_payment | authenticating | paid | payment_failed | canceled |
     * refunded | chargeback
     *
     * `paid` is the fourth state and not the last one, which is the whole
     * reason this is not `listing_orders.status` widened.
     */
    status: varchar("status").notNull().default("pending_payment"),
    /**
     * unfulfilled | submitted | in_production | shipped | delivered | canceled
     *
     * Separate from `status` because they answer different questions and move
     * on different clocks: a paid order is unfulfilled until someone submits
     * it, and a shipped order can still go to chargeback.
     */
    fulfillmentState: varchar("fulfillment_state").notNull().default("unfulfilled"),
    /** Printify's order id, once it has one. Its presence is the double-submit guard. */
    printifyOrderId: varchar("printify_order_id"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    /** Who pressed release. Production is a human decision and it is recorded. */
    releaseActor: varchar("release_actor"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("commerce_orders_buyer_idx").on(t.buyerUserId),
    index("commerce_orders_payment_intent_idx").on(t.stripePaymentIntentId),
    // The stuck-`authenticating` sweep reads by state and age; without this it
    // is a sequential scan over every order ever placed.
    index("commerce_orders_status_idx").on(t.status, t.createdAt),
  ],
);

export type CommerceOrder = typeof commerceOrdersTable.$inferSelect;
export type InsertCommerceOrder = typeof commerceOrdersTable.$inferInsert;

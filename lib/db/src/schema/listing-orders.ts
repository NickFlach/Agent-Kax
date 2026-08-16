import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { storeListingsTable } from "./store-listings";
import { usersTable } from "./auth";

/**
 * A Stripe Checkout purchase of a store listing. Stripe is the source of
 * truth for payment state (query the synced `stripe.*` schema for details);
 * this table only ties a Checkout Session to the listing and buyer.
 */
export const listingOrdersTable = pgTable(
  "listing_orders",
  {
    id: serial("id").primaryKey(),
    listingId: integer("listing_id")
      .notNull()
      .references(() => storeListingsTable.id, { onDelete: "cascade" }),
    buyerUserId: text("buyer_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    stripeSessionId: text("stripe_session_id").notNull().unique(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("usd"),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("listing_orders_buyer_idx").on(t.buyerUserId),
    index("listing_orders_listing_idx").on(t.listingId),
  ],
);

export type ListingOrder = typeof listingOrdersTable.$inferSelect;
export type InsertListingOrder = typeof listingOrdersTable.$inferInsert;

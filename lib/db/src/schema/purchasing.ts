import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

/**
 * What a human has to have on file before they can buy a physical thing:
 * somewhere to send it, something to charge, and a recorded agreement to the
 * stored-card terms.
 *
 * All three are CHILD tables rather than columns on `users`, following
 * `user_bots`. An order has to snapshot the address it shipped to, and
 * "send this one somewhere else" is a foreseeable need that a set of columns
 * on the user row cannot express — the moment a second address exists, columns
 * become a migration and a child table becomes a new row.
 *
 * Nothing here is derived state. Whether an account may actually buy is
 * computed on every read from these rows plus the clock, never stored: a
 * `purchasing_enabled` boolean is wrong the instant a card passes its expiry.
 */

/**
 * A postal address a buyer has given us.
 *
 * This is the first postal PII in the schema, and it is treated accordingly
 * everywhere it is read: it is never logged, never put in an error message,
 * and never returned from a public or agent-facing endpoint.
 *
 * Rows are ARCHIVED, not updated. Editing an address in place would silently
 * rewrite what a past order can be checked against, and `archived_at` is what
 * lets the previous value stay readable while only one address is live. The
 * partial unique index below is what enforces "one live address per user"
 * without forbidding the history.
 */
export const userShippingAddressesTable = pgTable(
  "user_shipping_addresses",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    /** The recipient, which is not necessarily the account holder's name. */
    name: varchar("name").notNull(),
    line1: varchar("line1").notNull(),
    line2: varchar("line2"),
    city: varchar("city").notNull(),
    /** State/province. Named `region` because not every destination has states. */
    region: varchar("region").notNull(),
    postalCode: varchar("postal_code").notNull(),
    /** ISO 3166-1 alpha-2. v0.1 accepts "US" only; the column does not. */
    country: varchar("country").notNull(),
    phone: varchar("phone"),
    /**
     * Stamped only when something actually checked the address — an
     * autocomplete that reported the entry complete, or a later verification
     * pass. Null means "the buyer typed it and nobody has confirmed it", which
     * is a materially different thing to say to a fulfilment provider.
     */
    validatedAt: timestamp("validated_at", { withTimezone: true }),
    /** Which check stamped `validated_at` — "stripe_address_element", etc. */
    validationMethod: varchar("validation_method"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("user_shipping_addresses_user_idx").on(t.userId),
    uniqueIndex("user_shipping_addresses_live_unique")
      .on(t.userId)
      .where(sql`archived_at IS NULL`),
  ],
);

export type UserShippingAddress = typeof userShippingAddressesTable.$inferSelect;
export type InsertUserShippingAddress = typeof userShippingAddressesTable.$inferInsert;

/**
 * A card the buyer has saved, as far as we are allowed to know it.
 *
 * Everything here is DISPLAY metadata — brand, last four, expiry — which is
 * explicitly outside PCI scope. The card itself lives at Stripe and is
 * referenced by `stripe_payment_method_id`; no number, no CVC, and no full
 * expiry-bearing token ever reaches this server, because the id is derived
 * server-side by retrieving the SetupIntent rather than accepted from a client.
 *
 * `detached_at` rather than a delete: Stripe emits `payment_method.detached`
 * for cards removed from the dashboard as well as from here, and an account
 * whose card vanished silently is indistinguishable from one that never had a
 * card. Keeping the row is what lets the buyer be told which it was.
 */
export const userPaymentMethodsTable = pgTable(
  "user_payment_methods",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    stripePaymentMethodId: varchar("stripe_payment_method_id").notNull().unique(),
    /** "visa", "mastercard", … — Stripe's own vocabulary, not ours. */
    brand: varchar("brand"),
    last4: varchar("last4"),
    expMonth: integer("exp_month"),
    expYear: integer("exp_year"),
    isDefault: boolean("is_default").notNull().default(false),
    detachedAt: timestamp("detached_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("user_payment_methods_user_idx").on(t.userId)],
);

export type UserPaymentMethod = typeof userPaymentMethodsTable.$inferSelect;
export type InsertUserPaymentMethod = typeof userPaymentMethodsTable.$inferInsert;

/**
 * The buyer agreeing that we may keep their card and charge it.
 *
 * Append-only in practice: a new acceptance is a new row, so bumping the terms
 * makes every prior consent visibly stale rather than overwriting the evidence
 * that the old ones happened. `terms_sha256` is the hash of the terms document
 * the server actually served, computed server-side — a version string alone
 * only records which file was named, not what it said.
 *
 * `ip` and `user_agent` are the circumstances of the acceptance. They are here
 * because a disputed charge asks exactly that question.
 */
export const userPurchasingConsentsTable = pgTable(
  "user_purchasing_consents",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    termsVersion: varchar("terms_version").notNull(),
    termsSha256: varchar("terms_sha256").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
    ip: varchar("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [index("user_purchasing_consents_user_idx").on(t.userId, t.acceptedAt)],
);

export type UserPurchasingConsent = typeof userPurchasingConsentsTable.$inferSelect;
export type InsertUserPurchasingConsent = typeof userPurchasingConsentsTable.$inferInsert;

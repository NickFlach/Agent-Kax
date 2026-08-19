import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { artifactsTable } from "./artifacts";
import { usersTable } from "./auth";

/**
 * commerce_merchants (#253, KAX-ADR-0002): the entity that sells. v0.1 has
 * exactly ONE — the KAX operating entity (is_first_party) — but the shape is
 * the general one, because locked decision #2 gates KYC at bank-account
 * creation and that gate needs an object to hang on.
 *
 * KAX does not perform verification; it RECORDS WHO DID. verification_verdict
 * holds the provider's machine verdict (account id, charges_enabled,
 * payouts_enabled, requirements_currently_due) — never documents, which must
 * not be stored here under any future.
 *
 * Status fields are VARCHAR, never pgEnum (adding enum values breaks the
 * deploy flow — routes/identity.ts:220, the user_bots.attached_via pattern).
 * Validation lives in lib/commerceMerchant.ts.
 */
export const commerceMerchantsTable = pgTable(
  "commerce_merchants",
  {
    id: serial("id").primaryKey(),
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    displayName: text("display_name").notNull(),
    legalName: text("legal_name"),
    isFirstParty: boolean("is_first_party").notNull().default(false),
    /** none | pending | verified | failed */
    buyerCipStatus: varchar("buyer_cip_status", { length: 24 }).notNull().default("none"),
    /** none | pending | verified | failed */
    payeeKybStatus: varchar("payee_kyb_status", { length: 24 }).notNull().default("none"),
    /** e.g. 'stripe_connect' — who performed the verification KAX records. */
    verificationProvider: varchar("verification_provider", { length: 32 }),
    verificationVerdict: jsonb("verification_verdict").$type<{
      account_id?: string;
      charges_enabled?: boolean;
      payouts_enabled?: boolean;
      requirements_currently_due?: string[];
    }>(),
    verifiedAt: timestamp("verified_at"),
    indemnityText: text("indemnity_text"),
    indemnityVersion: varchar("indemnity_version", { length: 16 }),
    indemnityAcceptedBy: varchar("indemnity_accepted_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    indemnityAcceptedAt: timestamp("indemnity_accepted_at"),
    disabledAt: timestamp("disabled_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("commerce_merchants_user_idx").on(t.userId)],
);

export type CommerceMerchant = typeof commerceMerchantsTable.$inferSelect;
export type InsertCommerceMerchant = typeof commerceMerchantsTable.$inferInsert;

/**
 * artifact_print_assets (#254): what the bytes behind an artifact's public
 * URL actually are — dimensions, format, checksum — measured lazily and
 * kept in a SIDE TABLE so formatArtifact()'s row spread can never leak it
 * onto a public surface by accident.
 *
 * A row is a measurement receipt either way: success fills the media
 * columns, failure fills failure_reason. Both record source_url_at_fetch
 * and fetched_at, because a measurement of a URL KAX does not control is
 * only meaningful with its provenance attached.
 */
export const artifactPrintAssetsTable = pgTable("artifact_print_assets", {
  artifactId: integer("artifact_id")
    .primaryKey()
    .references(() => artifactsTable.id, { onDelete: "cascade" }),
  widthPx: integer("width_px"),
  heightPx: integer("height_px"),
  format: varchar("format", { length: 16 }),
  hasAlpha: boolean("has_alpha"),
  /** NULL means unknown; see assumedSrgb. */
  colorSpace: varchar("color_space", { length: 16 }),
  assumedSrgb: boolean("assumed_srgb").notNull().default(false),
  byteSize: bigint("byte_size", { mode: "bigint" }),
  sha256: text("sha256"),
  sourceUrlAtFetch: text("source_url_at_fetch"),
  fetchedAt: timestamp("fetched_at"),
  /** not_a_url | sentinel | fetch_failed | too_large | decode_failed */
  failureReason: varchar("failure_reason", { length: 48 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type ArtifactPrintAsset = typeof artifactPrintAssetsTable.$inferSelect;
export type InsertArtifactPrintAsset = typeof artifactPrintAssetsTable.$inferInsert;

/**
 * commerce_ledger (#265, v0.2, DARK): the fiat ledger. A SEPARATE chain from
 * credit_ledger — one linear chain and one advisory lock per ledger, and a
 * fiat asset never enters ALLOWED_ASSETS. Double-entry, integer cents,
 * hash-chained, append-only by trigger (migration 0040). Account grammar and
 * the posting vocabulary live in lib/commerceLedger.ts; the reconciliation
 * queries in lib/commerceReconcile.ts shipped in the same PR, because a
 * ledger nothing reconciles is the floor_ledger defect repeated.
 */
export const commerceLedgerTable = pgTable(
  "commerce_ledger",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    entryHash: text("entry_hash").notNull().unique(),
    prevHash: text("prev_hash").notNull(),
    txId: text("tx_id").notNull(),
    /** Explicit ISO currency; 'usd' in v0.2. Never mixed within a transaction. */
    currency: varchar("currency", { length: 8 }).notNull(),
    account: text("account").notNull(),
    /** Signed integer USD cents. Debit negative, credit positive. */
    amountCents: bigint("amount_cents", { mode: "bigint" }).notNull(),
    kind: varchar("kind", { length: 32 }).notNull(),
    ref: text("ref"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("commerce_ledger_account_idx").on(t.account, t.currency),
    index("commerce_ledger_tx_idx").on(t.txId),
    index("commerce_ledger_ref_idx").on(t.ref),
    uniqueIndex("commerce_ledger_prev_hash_uq").on(t.prevHash),
  ],
);

export const commerceLedgerTxidsTable = pgTable("commerce_ledger_txids", {
  txId: text("tx_id").primaryKey(),
  postingsHash: text("postings_hash").notNull(),
  head: text("head").notNull(),
  entryCount: integer("entry_count").notNull(),
  actor: text("actor"),
  decisionId: text("decision_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type CommerceLedgerEntry = typeof commerceLedgerTable.$inferSelect;
export type CommerceLedgerTxid = typeof commerceLedgerTxidsTable.$inferSelect;

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
    // ---- #257: merchant link, spec identity, and the eligibility machine.
    /** Nullable: rows from before the merchant entity existed have none. */
    merchantId: integer("merchant_id").references(() => commerceMerchantsTable.id, {
      onDelete: "restrict",
    }),
    /** e.g. poster_12x12 — the print spec this product instantiates. */
    productSpecId: varchar("product_spec_id", { length: 48 }),
    /** ADR-0002's eligibility machine; vocabulary + transitions in lib/commerceOrder.ts. */
    commerceState: varchar("commerce_state", { length: 32 }).notNull().default("not_evaluated"),
    printifyBlueprintId: varchar("printify_blueprint_id"),
    /**
     * The content hash the human approval was pinned to (#259 consumes this):
     * approval is of BYTES, not of a URL, and a mismatch at re-check drops the
     * product back to product_eligible for fresh human eyes.
     */
    approvedContentHash: text("approved_content_hash"),
    approvedBy: varchar("approved_by").references(() => usersTable.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at"),
    unpublishedAt: timestamp("unpublished_at"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("commerce_products_published_idx").on(t.published),
    uniqueIndex("commerce_products_merchant_artifact_spec_idx").on(
      t.merchantId,
      t.artifactId,
      t.productSpecId,
    ),
  ],
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
    /**
     * Who pressed release. Production is a human decision and it is recorded —
     * or, when `commerceFulfillmentWorker.ts` is armed, a sentinel saying it
     * was not a human at all. Deliberately no foreign key to `users`: the
     * sentinel is not a user id and must not have to become one.
     */
    releaseActor: varchar("release_actor"),

    // ── Automatic fulfilment worker state (0028) ───────────────────────────
    //
    // Only `commerceFulfillmentWorker.ts` writes these. The manual admin
    // endpoints neither read nor set them, which is what keeps the manual path
    // exactly what it was before the worker existed.

    /**
     * How many times the worker has tried and been refused. Reaching the
     * worker's ceiling is how a row is PARKED: the claim query filters on
     * `fulfillment_attempts < MAX`, so a parked order stops being picked up
     * and waits for the manual endpoints instead of retrying forever.
     */
    fulfillmentAttempts: integer("fulfillment_attempts").notNull().default(0),
    /**
     * The provider's status and numeric code, e.g. `"429:8251"`. NEVER a
     * response body: Printify's 4xx bodies quote the offending field back, and
     * on this path that field is the buyer's street.
     */
    fulfillmentLastError: varchar("fulfillment_last_error"),
    fulfillmentLastAttemptAt: timestamp("fulfillment_last_attempt_at", { withTimezone: true }),
    /** When the worker may try again. NULL means "due now". */
    fulfillmentNextAttemptAt: timestamp("fulfillment_next_attempt_at", { withTimezone: true }),

    // ── Printify status sync and the buyer's stage timeline (0030) ─────────
    //
    // Only `commerceFulfillmentStatusSync.ts` writes these. They are the second
    // half of the conversation with the printer: until they existed KAX told
    // Printify things and never once asked, so `shipped` and `delivered` were
    // declared above with nothing in the system able to write either.

    /**
     * Printify's own status literal, verbatim and untranslated — `in-production`
     * is a real observed value, hyphenated, and it is not a word this schema
     * declares. Stored raw so a status we have never seen is RECORDED rather
     * than discarded; the mapping onto `fulfillment_state` is a separate,
     * revisable decision made in code.
     *
     * ADMIN-VISIBLE ONLY. No buyer-facing response carries this column.
     */
    providerStatus: varchar("provider_status"),
    /** When `provider_status` last CHANGED. Not when it was last read. */
    providerStatusAt: timestamp("provider_status_at", { withTimezone: true }),

    /** The two stage stamps the buyer timeline had no way to show. */
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),

    /**
     * The parcel in the carrier's terms. Populated together, because a Printify
     * shipment carries all three in one object and two of the three renders a
     * tracking line that cannot be followed. Not an address, and returned only
     * to the account that paid for the order.
     */
    trackingCarrier: varchar("tracking_carrier"),
    trackingNumber: varchar("tracking_number"),
    trackingUrl: varchar("tracking_url"),

    /**
     * The positive signal, and the reason this column is separate from
     * `provider_status_at`.
     *
     * Stamped on every completed check — including one that found no change and
     * including one the provider refused — so that "we looked and it has not
     * moved" stops being indistinguishable from "nothing has looked in three
     * days". A worker failing silently once a minute reads exactly like a worker
     * that was never switched on, and telling those two apart by hand is what
     * this column exists to make unnecessary. NULL means never checked.
     */
    fulfillmentSyncedAt: timestamp("fulfillment_synced_at", { withTimezone: true }),

    // ── #257: the full money-leg set. Margin cannot be computed from a gross
    // figure; every leg is an integer of USD cents named with its unit, and
    // lib/commerceOrder.ts's assertLegsBalance is the discipline that keeps
    // them summing. Naming equivalences with the issue are documented in
    // migration 0039 (item_price_cents == item_cents, external_ref ==
    // client_reference, pod_order_id == printify_order_id, ...).
    /** The full authorized amount, reconcilable to the Stripe charge. */
    customerChargeCents: integer("customer_charge_cents"),
    taxJurisdiction: varchar("tax_jurisdiction", { length: 48 }),
    taxRateBps: integer("tax_rate_bps"),
    /** kax | merchant */
    taxCollectorOfRecord: varchar("tax_collector_of_record", { length: 16 }),
    processorFeeCents: integer("processor_fee_cents"),
    /** platform | merchant */
    processorFeeBearer: varchar("processor_fee_bearer", { length: 16 }),
    platformFeeCents: integer("platform_fee_cents"),
    platformFeeRateBps: integer("platform_fee_rate_bps"),
    /** item_price | customer_charge */
    platformFeeBasis: varchar("platform_fee_basis", { length: 24 }),
    fulfillmentCostCents: integer("fulfillment_cost_cents"),
    fulfillmentShippingCostCents: integer("fulfillment_shipping_cost_cents"),
    /** kax | merchant */
    fulfillmentCostPayer: varchar("fulfillment_cost_payer", { length: 16 }),
    fulfillmentPaidAt: timestamp("fulfillment_paid_at"),
    merchantNetCents: integer("merchant_net_cents"),
    stripeChargeId: varchar("stripe_charge_id"),
    taxProviderTxn: varchar("tax_provider_txn"),
    correlationId: text("correlation_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("commerce_orders_buyer_idx").on(t.buyerUserId),
    index("commerce_orders_payment_intent_idx").on(t.stripePaymentIntentId),
    // The stuck-`authenticating` sweep reads by state and age; without this it
    // is a sequential scan over every order ever placed.
    index("commerce_orders_status_idx").on(t.status, t.createdAt),
    // The worker's claim query, once a minute on both passes. Partial on
    // `released_at IS NULL` so a released order leaves the index permanently
    // rather than accumulating in it.
    index("commerce_orders_fulfillment_due_idx")
      .on(t.fulfillmentNextAttemptAt)
      .where(sql`released_at is null`),
    // The status poller's claim query. Partial on the same two predicates the
    // query itself carries, so the index is guaranteed to imply it, and on
    // `delivered_at IS NULL` so a delivered order leaves it permanently.
    index("commerce_orders_status_sync_due_idx")
      .on(t.fulfillmentSyncedAt)
      .where(sql`printify_order_id is not null and delivered_at is null`),
  ],
);

export type CommerceOrder = typeof commerceOrdersTable.$inferSelect;
export type InsertCommerceOrder = typeof commerceOrdersTable.$inferInsert;

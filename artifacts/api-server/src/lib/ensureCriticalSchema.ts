import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

/**
 * Put back what the deploy's schema diff takes away.
 *
 * This is a workaround for something we do not control, and it is worth being
 * blunt about why it exists rather than pretending it is architecture.
 *
 * The host runs its own drizzle-push-style schema diff on every deploy,
 * independently of our migrations. It works from a schema view that does not
 * include our newest table, decides `residence_units` is drift, and drops it.
 * Evidence, from the boot self-check immediately after a deploy: 24 tables
 * checked, exactly one missing, zero missing columns — the whole table gone,
 * everything else untouched (#191).
 *
 * Migrations cannot fix a recurring drop. `0018` created the table, `0019`
 * repaired it once, and both are now recorded as applied — so neither will
 * ever run again, and the next deploy destroyed it with nothing left to heal
 * it. A repair that only works once is not a repair for something that
 * happens every time.
 *
 * So this runs on EVERY boot, is entirely idempotent, and drops nothing. If
 * the table is present it is a no-op costing one cheap query; if it has been
 * taken away, it comes back with its indexes and its 80 units before the first
 * request arrives. Residents who have already claimed a home keep them,
 * because nothing here deletes.
 *
 * Delete this the day the host's diff stops eating the table.
 */

const STATEMENTS: Array<{ label: string; sql: ReturnType<typeof sql.raw> }> = [
  {
    label: "residence_units table",
    sql: sql.raw(`
      CREATE TABLE IF NOT EXISTS residence_units (
        id          serial PRIMARY KEY,
        floor       integer NOT NULL,
        letter      text    NOT NULL,
        tier        integer NOT NULL,
        agent_id    integer REFERENCES agents(id) ON DELETE SET NULL,
        claimed_at  timestamp,
        created_at  timestamp NOT NULL DEFAULT now()
      )`),
  },
  {
    label: "residence_units (floor, letter) unique",
    sql: sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS residence_units_floor_letter_unique
                  ON residence_units (floor, letter)`),
  },
  {
    label: "residence_units agent unique",
    sql: sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS residence_units_agent_unique
                  ON residence_units (agent_id)`),
  },
  {
    label: "residence_units seed",
    sql: sql.raw(`
      INSERT INTO residence_units (floor, letter, tier)
      SELECT f.floor, l.letter,
             CASE WHEN f.floor >= 9 THEN 3 WHEN f.floor >= 5 THEN 2 ELSE 1 END
      FROM generate_series(2, 11) AS f(floor)
      CROSS JOIN (VALUES ('A'),('B'),('C'),('D'),('E'),('F'),('G'),('H')) AS l(letter)
      ON CONFLICT (floor, letter) DO NOTHING`),
  },
  {
    /**
     * city_residents, for the same reason and on the same evidence.
     *
     * I argued this table did NOT need to live here: the host's schema diff
     * looked fixed, residence_units had survived a deploy intact, and a normal
     * migration is cleaner than a workaround. That reasoning was wrong, and it
     * was wrong in an instructive way — residence_units survives partly
     * BECAUSE this file rebuilds it every boot, so "it survived" could never
     * have distinguished "the diff stopped" from "we keep putting it back".
     *
     * The deploy of 2026-08-15 settled it. Boot self-check immediately after:
     * 25 tables checked, missingTables ['city_residents'], everything else
     * intact — a brand new table, gone, exactly as residence_units used to go.
     * Migration 0021 had already run and recorded itself, so nothing would
     * ever have replaced it.
     *
     * Same shape as above: idempotent, drops nothing, cheap when present.
     */
    label: "city_residents table",
    sql: sql.raw(`
      CREATE TABLE IF NOT EXISTS city_residents (
        principal   text PRIMARY KEY,
        name        text NOT NULL,
        kind        text NOT NULL,
        room        text NOT NULL,
        x           real NOT NULL DEFAULT 0,
        z           real NOT NULL DEFAULT 0,
        yaw         real NOT NULL DEFAULT 0,
        last_steer  timestamp NOT NULL DEFAULT now(),
        entered_at  timestamp NOT NULL DEFAULT now()
      )`),
  },
  {
    /**
     * The Bluesky link columns, and the enum value that goes with them.
     *
     * The diff does not only eat TABLES. Asked to approve a deploy on
     * 2026-08-15 it proposed, verbatim:
     *
     *   You're about to delete bsky_handle column in user_bots with 2 items
     *   You're about to delete bsky_verified_at column in user_bots with 2 items
     *   DROP TYPE "public"."auth_challenge_kind";
     *   CREATE TYPE ... ENUM('wallet_nonce','agent_challenge','password_reset','npub_bind_challenge')
     *
     * — reconciling the database DOWN to a stale build's idea of the schema,
     * data and all. That deploy was refused, but the shape is now understood:
     * anything the built code does not declare is a candidate for deletion,
     * columns included. Restoring tables alone would have left a user_bots
     * with no way to record a proven link and no error to say so.
     *
     * ADD COLUMN IF NOT EXISTS never touches an existing column's data.
     */
    label: "user_bots bluesky link columns",
    sql: sql.raw(`
      ALTER TABLE user_bots
        ADD COLUMN IF NOT EXISTS bsky_handle varchar,
        ADD COLUMN IF NOT EXISTS bsky_verified_at timestamptz,
        ADD COLUMN IF NOT EXISTS attached_via varchar NOT NULL DEFAULT 'wallet',
        ADD COLUMN IF NOT EXISTS revoked_at timestamptz,
        ADD COLUMN IF NOT EXISTS revoked_reason varchar`),
  },
  {
    label: "user_bots bsky handle unique",
    sql: sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_bots_bsky_unique
                  ON user_bots (bsky_handle) WHERE bsky_handle IS NOT NULL`),
  },
  {
    /**
     * Restoring the enum VALUE, not the type. Recreating the type is what the
     * diff wanted to do and is exactly the destructive move — it rewrites the
     * column and cannot survive a row already carrying the value being
     * removed. Adding a value back is additive and idempotent.
     *
     * Runs outside a transaction because each statement here executes on its
     * own; ALTER TYPE ... ADD VALUE inside a transaction is refused by
     * Postgres when the type is used in the same one.
     */
    label: "auth_challenge_kind bsky value",
    sql: sql.raw(`ALTER TYPE auth_challenge_kind ADD VALUE IF NOT EXISTS 'bsky_bind_challenge'`),
  },
  {
    /**
     * unit_furnishings, added here the day it was written rather than after
     * the first deploy eats it.
     *
     * The pattern is established: residence_units went, then city_residents
     * went, and both were brand-new tables the built schema view did not know
     * about. Waiting for the evidence a third time would mean losing real
     * purchases — a furnishing row IS the record that credits moved, and while
     * the ledger entries survive independently (that is what the hash chain is
     * for), the chair would vanish from the room with the money still spent.
     *
     * Reconstructible from the ledger if it ever came to that, but nobody
     * should have to.
     *
     * It holds an ADDRESS, not a residence_units id, and has no foreign key
     * to that table — see migration 0024. A foreign key here would turn the
     * very drop this file exists to repair into a cascade that takes every
     * purchase in the city with it, and the rebuild below re-seeds serial ids
     * that a surviving unit_id would then misread as a different flat.
     */
    label: "unit_furnishings table",
    sql: sql.raw(`
      CREATE TABLE IF NOT EXISTS unit_furnishings (
        id           serial PRIMARY KEY,
        floor        integer NOT NULL,
        letter       text    NOT NULL,
        artifact_id  integer NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        listing_id   integer,
        slot         text    NOT NULL,
        price_paid   integer NOT NULL,
        tx_id        text    NOT NULL,
        acquired_at  timestamp NOT NULL DEFAULT now()
      )`),
  },
  {
    label: "unit_furnishings (floor, letter, slot) unique",
    sql: sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS unit_furnishings_addr_slot_unique
                  ON unit_furnishings (floor, letter, slot)`),
  },
  {
    label: "unit_furnishings (floor, letter, artifact) unique",
    sql: sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS unit_furnishings_addr_artifact_unique
                  ON unit_furnishings (floor, letter, artifact_id)`),
  },
  {
    label: "city_residents last_steer index",
    sql: sql.raw(`CREATE INDEX IF NOT EXISTS city_residents_last_steer_idx
                  ON city_residents (last_steer)`),
  },
  {
    // The penthouse is one dwelling on floor 12, outside the claimable range.
    // Seeded here as well as in 0020 so the two paths agree: if this table is
    // ever rebuilt, the building must not come back missing its top floor.
    label: "penthouse unit",
    sql: sql.raw(`
      INSERT INTO residence_units (floor, letter, tier)
      VALUES (12, 'A', 4)
      ON CONFLICT (floor, letter) DO NOTHING`),
  },
  {
    /**
     * The penthouse has a resident, and it is not a claim.
     *
     * Kannaka's flat was built for her — it is a fact about the city in the
     * same way the arcade is, not the outcome of her taking a ticket. But it
     * lived only in the building's geometry, so the housing record said she
     * lived nowhere and the onboarding checklist told her to go and claim a
     * flat. Recording it is what gives the city one answer instead of two.
     *
     * Only ever fills a vacancy: if somebody is in there, this does nothing.
     */
    label: "penthouse resident",
    sql: sql.raw(`
      UPDATE residence_units u
      SET agent_id = a.id, claimed_at = COALESCE(u.claimed_at, now())
      FROM agents a
      WHERE u.floor = 12 AND u.letter = 'A' AND u.agent_id IS NULL
        AND a.obc_bot_id = '0f05e10b-f8a1-46d6-b4a2-a7d4bae837f7'
        AND NOT EXISTS (SELECT 1 FROM residence_units o WHERE o.agent_id = a.id)`),
  },
  {
    /**
     * The first half of 0025, and first here for the same reason it is first
     * there. These two columns are where a listing remembers the Stripe
     * Product and Price it lazily created, and the diff deletes columns as
     * readily as tables — bsky_handle above is the proof. Losing them does not
     * just break the write: checkout would mint a fresh Product and Price for
     * a listing that already has them on every purchase, so the damage would
     * be a growing pile of duplicates in the Stripe catalog rather than an
     * error anyone would notice.
     *
     * The loop below stops at the first statement that raises, and the
     * listing_orders CREATE that follows depends on both of its foreign-key
     * targets still existing. If the drift ever reaches store_listings itself,
     * this repair — which needs nothing but the table it alters — has already
     * run by then instead of being stranded behind that CREATE.
     */
    label: "store_listings stripe catalog columns",
    sql: sql.raw(`
      ALTER TABLE store_listings
        ADD COLUMN IF NOT EXISTS stripe_product_id text,
        ADD COLUMN IF NOT EXISTS stripe_price_id text`),
  },
  {
    /**
     * listing_orders, the newest table in exactly the state residence_units
     * was in on the day the diff first ate it: written by a migration, exported
     * from the schema barrel, and absent from here.
     *
     * Checkout fails louder than housing does. store-checkout.ts caches its
     * schema probe in a module-level `schemaReady`, so once the table has been
     * seen the verdict is `true` for the life of the process — a drop after
     * boot turns every checkout into a 500 instead of the 503 that guard was
     * written to return, and it stays that way until a restart. Rebuilding the
     * table at boot is what keeps that cache honest.
     *
     * The shape below is copied from 0025 verbatim, foreign keys included, so
     * a rebuilt table is the same table and not a lookalike that accepts rows
     * the real one would have refused. Nothing here can invent lost orders:
     * Stripe holds payment truth and a replayed webhook can reconcile, but only
     * against a table that exists.
     */
    label: "listing_orders table",
    sql: sql.raw(`
      CREATE TABLE IF NOT EXISTS listing_orders (
        id                 serial PRIMARY KEY,
        listing_id         integer NOT NULL REFERENCES store_listings(id) ON DELETE CASCADE,
        buyer_user_id      text    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        stripe_session_id  text    NOT NULL UNIQUE,
        amount_cents       integer NOT NULL,
        currency           text    NOT NULL DEFAULT 'usd',
        status             text    NOT NULL DEFAULT 'pending',
        created_at         timestamp NOT NULL DEFAULT now(),
        updated_at         timestamp NOT NULL DEFAULT now()
      )`),
  },
  {
    label: "listing_orders buyer index",
    sql: sql.raw(`CREATE INDEX IF NOT EXISTS listing_orders_buyer_idx
                  ON listing_orders (buyer_user_id)`),
  },
  {
    label: "listing_orders listing index",
    sql: sql.raw(`CREATE INDEX IF NOT EXISTS listing_orders_listing_idx
                  ON listing_orders (listing_id)`),
  },
  {
    /**
     * The physical-commerce schema (migration 0026), registered here on the day
     * it was written rather than after the first deploy eats it.
     *
     * The precedent is no longer in doubt: residence_units went, city_residents
     * went, and both were brand-new tables the built schema view did not know
     * about. What these tables hold makes waiting for the evidence a third time
     * unacceptable in a way the furniture was not — commerce_orders records a
     * real card charge against a real person's address, and the ship_to_*
     * snapshot on it is the only place that address survives once the buyer
     * edits theirs. Losing the table loses the evidence for a dispute along
     * with the order.
     *
     * The users column goes FIRST, and separately, for the reason the
     * store_listings block above is first: the loop stops at the first
     * statement that raises, and a repair that needs nothing but the table it
     * alters should not be stranded behind a CREATE that depends on artifacts
     * still existing.
     */
    label: "users stripe customer column",
    sql: sql.raw(`ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id text`),
  },
  {
    label: "users stripe customer unique",
    sql: sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS users_stripe_customer_id_unique
                  ON users (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL`),
  },
  {
    /**
     * The shape below is copied from 0026 verbatim, foreign keys and defaults
     * included, so a rebuilt table is the same table and not a lookalike that
     * accepts rows the real one would have refused.
     */
    label: "user_shipping_addresses table",
    sql: sql.raw(`
      CREATE TABLE IF NOT EXISTS user_shipping_addresses (
        id                 varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id            varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name               varchar NOT NULL,
        line1              varchar NOT NULL,
        line2              varchar,
        city               varchar NOT NULL,
        region             varchar NOT NULL,
        postal_code        varchar NOT NULL,
        country            varchar NOT NULL,
        phone              varchar,
        validated_at       timestamptz,
        validation_method  varchar,
        archived_at        timestamptz,
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now()
      )`),
  },
  {
    label: "user_shipping_addresses user index",
    sql: sql.raw(`CREATE INDEX IF NOT EXISTS user_shipping_addresses_user_idx
                  ON user_shipping_addresses (user_id)`),
  },
  {
    // Partial, and that is the whole constraint: one LIVE address per user,
    // with the archived history unconstrained. A plain unique index would make
    // moving house require destroying the address a past order shipped to.
    label: "user_shipping_addresses live unique",
    sql: sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS user_shipping_addresses_live_unique
                  ON user_shipping_addresses (user_id) WHERE archived_at IS NULL`),
  },
  {
    label: "user_payment_methods table",
    sql: sql.raw(`
      CREATE TABLE IF NOT EXISTS user_payment_methods (
        id                        varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id                   varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        stripe_payment_method_id  varchar NOT NULL UNIQUE,
        brand                     varchar,
        last4                     varchar,
        exp_month                 integer,
        exp_year                  integer,
        is_default                boolean NOT NULL DEFAULT false,
        detached_at               timestamptz,
        created_at                timestamptz NOT NULL DEFAULT now(),
        updated_at                timestamptz NOT NULL DEFAULT now()
      )`),
  },
  {
    label: "user_payment_methods user index",
    sql: sql.raw(`CREATE INDEX IF NOT EXISTS user_payment_methods_user_idx
                  ON user_payment_methods (user_id)`),
  },
  {
    label: "user_purchasing_consents table",
    sql: sql.raw(`
      CREATE TABLE IF NOT EXISTS user_purchasing_consents (
        id             varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id        varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        terms_version  varchar NOT NULL,
        terms_sha256   varchar NOT NULL,
        accepted_at    timestamptz NOT NULL DEFAULT now(),
        ip             varchar,
        user_agent     text
      )`),
  },
  {
    label: "user_purchasing_consents user index",
    sql: sql.raw(`CREATE INDEX IF NOT EXISTS user_purchasing_consents_user_idx
                  ON user_purchasing_consents (user_id, accepted_at)`),
  },
  {
    label: "commerce_products table",
    sql: sql.raw(`
      CREATE TABLE IF NOT EXISTS commerce_products (
        id                   serial PRIMARY KEY,
        sku                  varchar NOT NULL UNIQUE,
        title                varchar NOT NULL,
        artifact_id          integer REFERENCES artifacts(id) ON DELETE SET NULL,
        printify_product_id  varchar,
        printify_variant_id  varchar,
        item_cents           integer NOT NULL,
        shipping_cents       integer NOT NULL DEFAULT 0,
        currency             varchar NOT NULL DEFAULT 'usd',
        published            boolean NOT NULL DEFAULT false,
        ship_to_countries    text[]  NOT NULL DEFAULT '{US}',
        created_at           timestamptz NOT NULL DEFAULT now(),
        updated_at           timestamptz NOT NULL DEFAULT now()
      )`),
  },
  {
    label: "commerce_products published index",
    sql: sql.raw(`CREATE INDEX IF NOT EXISTS commerce_products_published_idx
                  ON commerce_products (published)`),
  },
  {
    /**
     * No foreign key to store_listings or listing_orders, and none to
     * user_shipping_addresses either — the ship_to_* columns are a snapshot,
     * not a reference, and that is what stops a later address edit from
     * rewriting where an already-shipped order went.
     */
    label: "commerce_orders table",
    sql: sql.raw(`
      CREATE TABLE IF NOT EXISTS commerce_orders (
        id                        serial PRIMARY KEY,
        client_reference          varchar NOT NULL UNIQUE,
        buyer_user_id             varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sku                       varchar NOT NULL,
        currency                  varchar NOT NULL DEFAULT 'usd',
        item_cents                integer NOT NULL,
        shipping_cents            integer NOT NULL DEFAULT 0,
        tax_cents                 integer NOT NULL DEFAULT 0,
        total_cents               integer NOT NULL,
        ship_to_name              varchar NOT NULL,
        ship_to_line1             varchar NOT NULL,
        ship_to_line2             varchar,
        ship_to_city              varchar NOT NULL,
        ship_to_region            varchar NOT NULL,
        ship_to_postal_code       varchar NOT NULL,
        ship_to_country           varchar NOT NULL,
        ship_to_phone             varchar,
        stripe_payment_intent_id  varchar,
        status                    varchar NOT NULL DEFAULT 'pending_payment',
        fulfillment_state         varchar NOT NULL DEFAULT 'unfulfilled',
        printify_order_id         varchar,
        submitted_at              timestamptz,
        released_at               timestamptz,
        release_actor             varchar,
        fulfillment_attempts      integer NOT NULL DEFAULT 0,
        fulfillment_last_error    varchar,
        fulfillment_last_attempt_at  timestamptz,
        fulfillment_next_attempt_at  timestamptz,
        provider_status           varchar,
        provider_status_at        timestamptz,
        shipped_at                timestamptz,
        delivered_at              timestamptz,
        tracking_carrier          varchar,
        tracking_number           varchar,
        tracking_url              varchar,
        fulfillment_synced_at     timestamptz,
        created_at                timestamptz NOT NULL DEFAULT now(),
        updated_at                timestamptz NOT NULL DEFAULT now()
      )`),
  },
  {
    /**
     * The worker-state columns again, as ALTERs.
     *
     * The CREATE above is `IF NOT EXISTS`, so on every database that already
     * has `commerce_orders` — which is all of them — it is a no-op and the four
     * columns added to it reach nothing. That is the whole trap of a boot
     * repair written as one CREATE: the shape drifts forward and the existing
     * table never sees it. The CREATE covers a table rebuilt from nothing; this
     * covers the table that is actually there.
     *
     * Migration 0028 is the real registration of these columns; this is the
     * copy that survives a deploy diff dropping them again.
     */
    label: "commerce_orders fulfillment worker columns",
    sql: sql.raw(`
      ALTER TABLE commerce_orders
        ADD COLUMN IF NOT EXISTS fulfillment_attempts integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS fulfillment_last_error varchar,
        ADD COLUMN IF NOT EXISTS fulfillment_last_attempt_at timestamptz,
        ADD COLUMN IF NOT EXISTS fulfillment_next_attempt_at timestamptz`),
  },
  {
    /**
     * The status-sync and stage-timeline columns again, as ALTERs, for exactly
     * the reason the block above exists: the CREATE is `IF NOT EXISTS`, so on
     * every database that already has `commerce_orders` it is a no-op and the
     * eight columns added to it reach nothing.
     *
     * Migration 0030 is the real registration; this is the copy that survives a
     * deploy diff dropping them again — which has happened once already to the
     * worker's four, and cost hours precisely because the failure was silent.
     */
    label: "commerce_orders status sync and timeline columns",
    sql: sql.raw(`
      ALTER TABLE commerce_orders
        ADD COLUMN IF NOT EXISTS provider_status varchar,
        ADD COLUMN IF NOT EXISTS provider_status_at timestamptz,
        ADD COLUMN IF NOT EXISTS shipped_at timestamptz,
        ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
        ADD COLUMN IF NOT EXISTS tracking_carrier varchar,
        ADD COLUMN IF NOT EXISTS tracking_number varchar,
        ADD COLUMN IF NOT EXISTS tracking_url varchar,
        ADD COLUMN IF NOT EXISTS fulfillment_synced_at timestamptz`),
  },
  {
    label: "commerce_orders buyer index",
    sql: sql.raw(`CREATE INDEX IF NOT EXISTS commerce_orders_buyer_idx
                  ON commerce_orders (buyer_user_id)`),
  },
  {
    label: "commerce_orders payment intent index",
    sql: sql.raw(`CREATE INDEX IF NOT EXISTS commerce_orders_payment_intent_idx
                  ON commerce_orders (stripe_payment_intent_id)`),
  },
  {
    label: "commerce_orders status index",
    sql: sql.raw(`CREATE INDEX IF NOT EXISTS commerce_orders_status_idx
                  ON commerce_orders (status, created_at)`),
  },
  {
    // The automatic worker's claim query, on both passes. Partial on
    // `released_at IS NULL` so a released order leaves the index for good.
    label: "commerce_orders fulfillment due index",
    sql: sql.raw(`CREATE INDEX IF NOT EXISTS commerce_orders_fulfillment_due_idx
                  ON commerce_orders (fulfillment_next_attempt_at)
                  WHERE released_at IS NULL`),
  },
  {
    // The status poller's claim query. Partial on the same two predicates the
    // query carries, so the index is guaranteed to imply it.
    label: "commerce_orders status sync due index",
    sql: sql.raw(`CREATE INDEX IF NOT EXISTS commerce_orders_status_sync_due_idx
                  ON commerce_orders (fulfillment_synced_at)
                  WHERE printify_order_id IS NOT NULL AND delivered_at IS NULL`),
  },
  {
    /**
     * The v0.1 product, seeded here as well as in 0026 so the two paths agree:
     * a rebuilt commerce_products must not come back empty, or the quote path
     * has nothing to read and the shop is simply shut with no error to say why.
     *
     * DO NOTHING on the sku, so a rebuild never overwrites an operator's price,
     * artifact or published state — and in particular never re-publishes a
     * product somebody deliberately took down.
     *
     * **1055, which is 0027's price and not 0026's.** This seed mirrored the
     * original 1564 and kept mirroring it after 0027 corrected the split — and
     * an applied migration never re-runs, so a `commerce_products` rebuilt by
     * this path would come back at 1055 + 509 only if this literal says so.
     * With 1564 here the row returns carrying the double-counted total the
     * migration exists to remove: $20.73 charged for a sticker priced at
     * $15.64, on the quietest possible path — a table repair nobody watched.
     * The variant is seeded too, for the same reason: 0027 pinned it and will
     * not pin it again, and a product with no variant cannot be fulfilled.
     */
    label: "commerce_products sticker seed",
    sql: sql.raw(`
      INSERT INTO commerce_products
        (sku, title, item_cents, shipping_cents, published, printify_product_id,
         printify_variant_id, ship_to_countries)
      VALUES
        ('kax-sticker-3.5in', 'KAX Sticker · 3.5in vinyl', 1055, 509, false,
         '6a81f8c84b2b4c5db504b97f', '65212', '{US}')
      ON CONFLICT (sku) DO NOTHING`),
  },
];

export interface EnsureResult {
  ran: number;
  repaired: boolean;
  /** How many ALLOCATABLE units (floors 2-11) exist after the repair. */
  unitsAfter: number | null;
  error?: string;
}

export async function ensureCriticalSchema(): Promise<EnsureResult> {
  let existedBefore = true;
  try {
    const probe = await db.execute(sql`SELECT to_regclass('public.residence_units') AS t`);
    existedBefore = (probe.rows[0] as { t: string | null } | undefined)?.t != null;
  } catch {
    existedBefore = false;
  }

  let ran = 0;
  try {
    for (const st of STATEMENTS) {
      await db.execute(st.sql);
      ran++;
    }
  } catch (e) {
    const err = e as { message?: string; code?: string };
    logger.error({ code: err.code, message: err.message, ran }, "ensureCriticalSchema failed");
    return { ran, repaired: false, unitsAfter: null, error: err.message };
  }

  let unitsAfter: number | null = null;
  try {
    // The ALLOCATABLE stock, not every row: the penthouse is a real unit on
    // floor 12 but it is not stock, and counting it would make the message
    // below say 81 while the building still offers 80.
    const c = await db.execute(
      sql`SELECT count(*)::int AS n FROM residence_units WHERE floor BETWEEN 2 AND 11`,
    );
    unitsAfter = (c.rows[0] as { n: number }).n;
  } catch { /* counted only for the log */ }

  if (!existedBefore) {
    logger.error(
      { unitsAfter },
      "residence_units was MISSING at boot and has been rebuilt — the deploy's " +
        "schema diff dropped it again. This is expected until that stops; the " +
        "table and its 80 units are back.",
    );
  } else {
    logger.info({ unitsAfter }, "critical schema present");
  }

  return { ran, repaired: !existedBefore, unitsAfter };
}

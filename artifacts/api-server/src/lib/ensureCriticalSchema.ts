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

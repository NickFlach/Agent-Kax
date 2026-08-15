import { pgTable, serial, integer, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { artifactsTable } from "./artifacts";

/**
 * A piece of furniture standing in somebody's flat.
 *
 * This is a record of a SALE, not a decoration: it carries the price paid and
 * the ledger transaction that moved the money, so "who owns this chair" and
 * "what was paid for it" can never drift apart. The row exists if and only if
 * the credits moved.
 *
 * Addressed by (floor, letter) with NO foreign key to residence_units, which
 * is deliberate and is explained at length in migration 0024. The short
 * version: residence_units is the one table here that demonstrably gets
 * DROPPED by the host's deploy diff, a foreign key would make that drop
 * cascade through every purchase in the city, and the rebuild re-seeds serial
 * ids that would no longer mean what a surviving unit_id thought they meant.
 * 3B is 3B whatever row id it currently wears.
 *
 * Two constraints belong to the room rather than to a handler:
 *   - one piece per slot, because a studio has five places a thing can stand
 *     and two chairs in the same corner is a rendering bug you cannot see
 *     coming from the data
 *   - one copy of a piece per flat, because buying the same chair twice is
 *     nearly always a retry rather than an order
 */
export const unitFurnishingsTable = pgTable(
  "unit_furnishings",
  {
    id: serial("id").primaryKey(),
    /** 2–11, or 12 for the penthouse. */
    floor: integer("floor").notNull(),
    /** "A".."H" */
    letter: text("letter").notNull(),
    artifactId: integer("artifact_id")
      .notNull()
      .references(() => artifactsTable.id, { onDelete: "cascade" }),
    /**
     * The listing it was bought from, kept for provenance. Not a foreign key:
     * a seller who delists a piece should not be able to erase the record of
     * having sold it.
     */
    listingId: integer("listing_id"),
    /** One of SLOTS in lib/joinery-core.ts — where in the room it stands. */
    slot: text("slot").notNull(),
    /** Minor units, as paid. Not a current valuation — what it cost. */
    pricePaid: integer("price_paid").notNull(),
    /** The ledger transaction. The receipt, in the only place that can't lie. */
    txId: text("tx_id").notNull(),
    acquiredAt: timestamp("acquired_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("unit_furnishings_addr_slot_unique").on(t.floor, t.letter, t.slot),
    uniqueIndex("unit_furnishings_addr_artifact_unique").on(t.floor, t.letter, t.artifactId),
    index("unit_furnishings_addr_idx").on(t.floor, t.letter),
  ],
);

export type UnitFurnishing = typeof unitFurnishingsTable.$inferSelect;
export type InsertUnitFurnishing = typeof unitFurnishingsTable.$inferInsert;

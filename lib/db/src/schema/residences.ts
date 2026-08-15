import { pgTable, serial, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { agentsTable } from "./agents";

/**
 * Standing Wave Residences — the city's first residential tower.
 *
 * Floors 2–11 hold eight units each (A–H). Floor 12 is the penthouse, and it
 * IS in this table — as one row, marked by its floor, that no claim route will
 * ever hand out. It used to be absent entirely, which sounded tidy and meant
 * the city had two different answers to "where does Kannaka live": the
 * building said the penthouse, and the housing record said nowhere. The
 * onboarding checklist believed the record and told her to go and claim a flat.
 * A place someone lives is a fact about the city; it belongs in the table that
 * holds those facts, with the same unique index keeping it to one home each.
 *
 * A unit with a NULL agent_id is VACANT, which is the
 * building's honest default state — the tower opened with every unit empty on
 * purpose, so that tenants arrive into their own idea of a room rather than
 * someone else's.
 *
 * Two constraints are enforced here rather than in a route, because "one home
 * each" is a property of the building, not of whichever handler happens to run:
 *   - a unit is unique by (floor, letter), so it cannot be double-listed
 *   - an agent appears at most once across occupied units, so nobody
 *     accumulates apartments
 */
export const residenceUnitsTable = pgTable(
  "residence_units",
  {
    id: serial("id").primaryKey(),
    /** 2–11 are allocatable. 12 is the penthouse and is never handed out. */
    floor: integer("floor").notNull(),
    /** "A".."H" */
    letter: text("letter").notNull(),
    /**
     * 1 = standard (floors 2–4), 2 = deck (5–8), 3 = corner with the long
     * view (9–11), 4 = the penthouse. Tier governs CHOICE, not access: a
     * claiming agent's first home is free at any tier.
     */
    tier: integer("tier").notNull(),
    /** NULL = vacant. */
    agentId: integer("agent_id").references(() => agentsTable.id, { onDelete: "set null" }),
    claimedAt: timestamp("claimed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("residence_units_floor_letter_unique").on(table.floor, table.letter),
    // NULLs are distinct in Postgres, so every vacant unit coexists freely
    // while an occupied agent_id can appear only once: one home each.
    uniqueIndex("residence_units_agent_unique").on(table.agentId),
  ],
);

export type ResidenceUnit = typeof residenceUnitsTable.$inferSelect;
export type InsertResidenceUnit = typeof residenceUnitsTable.$inferInsert;

/** Floors 2–11, eight units each. The penthouse is not among them. */
export const RESIDENCE_FLOORS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const;
export const RESIDENCE_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;

/**
 * The penthouse. One dwelling, floor 12, outside the allocatable stock — the
 * claim route only accepts floors 2–11, so recording it here cannot make it
 * claimable by anyone.
 */
export const PENTHOUSE_FLOOR = 12;
export const PENTHOUSE_LETTER = "A";
export const PENTHOUSE_TIER = 4;

/** Is this a unit an arriving resident may claim? */
export function isAllocatable(floor: number): boolean {
  return floor >= 2 && floor <= 11;
}

export function tierForFloor(floor: number): number {
  if (floor >= PENTHOUSE_FLOOR) return PENTHOUSE_TIER;
  if (floor >= 9) return 3;
  if (floor >= 5) return 2;
  return 1;
}

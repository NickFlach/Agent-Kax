import { pgTable, integer, boolean, text, timestamp, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * The fleet-wide autonomy kill switch (KAX-ADR-0003 v0.2, D6).
 *
 * One operator flag that halts ALL autonomous execution at once — without
 * revoking any identity or evicting any resident. Agents keep standing and
 * keep talking; they simply stop ACTING, and say so when asked. A kill switch
 * that also destroyed presence is one nobody dares use, so this is deliberately
 * separate from revocation: revocation is per-agent and permanent-ish, this is
 * fleet-wide and instantly reversible.
 *
 * A single row (id = 1, enforced by the check constraint). The executor reads
 * `halted` between stages on the same cadence it checks revocation, so a halt
 * flipped mid-run stops the next stage rather than only the next run.
 */
export const autonomyStateTable = pgTable(
  "autonomy_state",
  {
    id: integer("id").primaryKey().default(1),
    halted: boolean("halted").notNull().default(false),
    /** Why it was halted — surfaced to agents so they can say it out loud. */
    reason: text("reason"),
    /** Who flipped it, for the audit trail. */
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [check("autonomy_state_singleton", sql`${t.id} = 1`)],
);

export type AutonomyState = typeof autonomyStateTable.$inferSelect;

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
];

export interface EnsureResult {
  ran: number;
  repaired: boolean;
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
    const c = await db.execute(sql`SELECT count(*)::int AS n FROM residence_units`);
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

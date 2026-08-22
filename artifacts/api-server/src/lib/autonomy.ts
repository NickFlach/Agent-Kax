import { db } from "@workspace/db";
import { autonomyStateTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";

/**
 * The fleet-wide autonomy kill switch (ADR-0003 v0.2, D6).
 *
 * `halted` stops all autonomous execution at once. It is deliberately NOT
 * revocation: identities stay valid, residents stay standing and talking, they
 * simply stop acting. Instantly reversible, because a kill switch that also
 * tears down presence is one nobody dares to use.
 *
 * The read is fail-CLOSED: if the flag cannot be read, autonomy is treated as
 * halted. An executor that cannot confirm it is allowed to act must not act —
 * the same posture the revocation probe takes.
 */
export interface AutonomyStatus {
  halted: boolean;
  reason: string | null;
  updatedAt: string | null;
}

export async function autonomyStatus(): Promise<AutonomyStatus> {
  const [row] = await db.select().from(autonomyStateTable).where(eq(autonomyStateTable.id, 1)).limit(1);
  // Missing row = never seeded; treat as halted (fail closed) rather than
  // silently allowing action against an unknown policy.
  if (!row) return { halted: true, reason: "autonomy state not initialised", updatedAt: null };
  return { halted: row.halted, reason: row.reason ?? null, updatedAt: row.updatedAt.toISOString() };
}

/**
 * Flip the switch. Upserts the singleton so it works even if the seed row is
 * absent. `by` is recorded for the audit trail.
 */
export async function setAutonomyHalt(halted: boolean, reason: string | null, by: string): Promise<AutonomyStatus> {
  await db
    .insert(autonomyStateTable)
    .values({ id: 1, halted, reason, updatedBy: by, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: autonomyStateTable.id,
      set: { halted, reason, updatedBy: by, updatedAt: sql`now()` },
    });
  return autonomyStatus();
}

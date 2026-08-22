import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { towerCredentialsTable, towerFloorsTable } from "@workspace/db/schema";

// Namespace for the per-floor mint advisory lock. Two-int form so it cannot
// collide with the single-int keys other modules use (e.g. the commerce
// ledger lock). The second int is the floor number.
const MINT_LOCK_NS = 0x746f7772; // "towr"

/**
 * Floor service credentials (KAX-ADR-0005 Phase 1) — the anti-god-token.
 *
 * A tenant's backend needs to call its own floor's surfaces (panel, webhook
 * registration) without running the 15-minute agent-token refresh loop. The
 * ledger's service tokens are the cautionary tale KAX-ADR-0001 tells: one
 * secret, any subject. This is the opposite shape:
 *
 *   - PINNED: a credential row carries its floor_no; resolution returns that
 *     floor and nothing else. There is no parameter by which a request can
 *     ask a credential to act as a different floor.
 *   - HASHED: the DB stores sha256(token); the `twr_…` token is shown once
 *     at mint. A read of the table is not a theft of the credentials.
 *   - REFUSED WHEN DARK: resolution checks the floor's live status — the
 *     kill-switch semantics of ADR-0003, fail closed.
 *   - BOUNDED: at most 3 active credentials per floor (enough for rotation
 *     overlap, too few to lose track of), revocation is a timestamp.
 *
 * Scope is STRUCTURAL, not declarative: only the tower routes consult this
 * resolver, so a floor credential cannot reach the ledger, the city, or any
 * other surface — there is no code path on which to present it.
 */

export const MAX_ACTIVE_CREDENTIALS_PER_FLOOR = 3;

export class TooManyCredentials extends Error {
  readonly code = "too_many_credentials";
}

export function hashCredential(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time equality over the two hex digests. */
function hashEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export async function mintTowerCredential(floorNo: number, label: string | null): Promise<{ id: number; token: string }> {
  const token = `twr_${randomBytes(32).toString("base64url")}`;
  // Count-then-insert under a per-floor advisory lock, so two concurrent
  // admin mints cannot both observe "2 active" and each insert a 3rd,
  // yielding 4. The lock is transaction-scoped and released on commit.
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${MINT_LOCK_NS}, ${floorNo})`);
    const active = await tx
      .select({ id: towerCredentialsTable.id })
      .from(towerCredentialsTable)
      .where(and(eq(towerCredentialsTable.floorNo, floorNo), isNull(towerCredentialsTable.revokedAt)));
    if (active.length >= MAX_ACTIVE_CREDENTIALS_PER_FLOOR) {
      throw new TooManyCredentials(
        `floor ${floorNo} already holds ${active.length} active credentials — revoke one before minting another`,
      );
    }
    const [row] = await tx
      .insert(towerCredentialsTable)
      .values({ floorNo, tokenHash: hashCredential(token), label: label?.slice(0, 80) ?? null })
      .returning();
    return { id: row!.id, token };
  });
}

export async function revokeTowerCredential(floorNo: number, credentialId: number): Promise<boolean> {
  const res = await db
    .update(towerCredentialsTable)
    .set({ revokedAt: new Date() })
    .where(and(
      eq(towerCredentialsTable.id, credentialId),
      eq(towerCredentialsTable.floorNo, floorNo),
      isNull(towerCredentialsTable.revokedAt),
    ))
    .returning({ id: towerCredentialsTable.id });
  return res.length > 0;
}

export async function listTowerCredentials(floorNo: number) {
  const rows = await db
    .select({
      id: towerCredentialsTable.id,
      label: towerCredentialsTable.label,
      createdAt: towerCredentialsTable.createdAt,
      revokedAt: towerCredentialsTable.revokedAt,
    })
    .from(towerCredentialsTable)
    .where(eq(towerCredentialsTable.floorNo, floorNo));
  return rows;
}

/**
 * Resolve a presented `twr_…` bearer to its floor, or null.
 *
 * Refusals, in the order they bite: not a tower token shape; unknown or
 * revoked; the floor is not currently leased (a dark floor's credentials
 * are refused fail-closed; a vacant floor has no tenant to be).
 */
export async function resolveTowerCredential(bearer: string | undefined): Promise<{ floorNo: number; tenantPrincipal: string } | null> {
  if (!bearer || !bearer.startsWith("twr_") || bearer.length > 200) return null;
  const digest = hashCredential(bearer);
  const [row] = await db
    .select()
    .from(towerCredentialsTable)
    .where(and(eq(towerCredentialsTable.tokenHash, digest), isNull(towerCredentialsTable.revokedAt)))
    .limit(1);
  // The unique-index lookup already did the matching; the constant-time
  // re-check keeps the comparison story uniform if the lookup path changes.
  if (!row || !hashEquals(row.tokenHash, digest)) return null;
  const [floor] = await db.select().from(towerFloorsTable).where(eq(towerFloorsTable.floorNo, row.floorNo)).limit(1);
  if (!floor || floor.status !== "leased" || !floor.tenantPrincipal) return null;
  return { floorNo: floor.floorNo, tenantPrincipal: floor.tenantPrincipal };
}

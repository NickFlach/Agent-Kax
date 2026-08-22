import { db } from "@workspace/db";
import { artifactConsentTable } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";

/**
 * Artifact consent for real-money sales (#414).
 *
 * Consent is a matched pair asserted through the agent's OWN session (#390
 * philosophy): the caller here is always the authenticated agent, and the
 * `agentPrincipal` is taken from its token, never from the request body — an
 * operator cannot consent on an agent's behalf. Fail-closed: no active,
 * un-revoked consent row for (artifact, channel) means NO consent, and the
 * commerce rights preflight blocks the sale.
 */

/** Channels a real-money sale can run on. Keep in step with the ADR-0002 flow. */
export const SALE_CHANNELS = ["physical", "occ_gallery", "drop"] as const;
export type SaleChannel = (typeof SALE_CHANNELS)[number];

export function isSaleChannel(s: string): s is SaleChannel {
  return (SALE_CHANNELS as readonly string[]).includes(s);
}

export interface Consent {
  artifactId: number;
  channel: string;
  agentPrincipal: string;
  royaltyBps: number;
  revoked: boolean;
  version: number;
}

/** The active consent for (artifact, channel), or null. Revoked reads as null. */
export async function getConsent(artifactId: number, channel: string): Promise<Consent | null> {
  const [row] = await db
    .select()
    .from(artifactConsentTable)
    .where(and(eq(artifactConsentTable.artifactId, artifactId), eq(artifactConsentTable.channel, channel)))
    .limit(1);
  if (!row) return null;
  return {
    artifactId: row.artifactId,
    channel: row.channel,
    agentPrincipal: row.agentPrincipal,
    royaltyBps: row.royaltyBps,
    revoked: row.revoked,
    version: row.version,
  };
}

/** Is there ACTIVE consent (present and not revoked) for this sale? */
export async function hasConsent(artifactId: number, channel: string): Promise<boolean> {
  const c = await getConsent(artifactId, channel);
  return c != null && !c.revoked;
}

export interface AssertConsentInput {
  artifactId: number;
  channel: SaleChannel;
  /** From the agent's OWN token — never the request body. */
  agentPrincipal: string;
  royaltyBps?: number;
}

/**
 * The agent asserts (or re-asserts) its consent. Upsert on (artifact, channel),
 * bumping version and clearing any prior revocation — a re-assert is the agent
 * changing its mind back. Royalty is clamped to a sane range.
 */
export async function assertConsent(input: AssertConsentInput): Promise<Consent> {
  // Guard NaN/fractional BEFORE clamping — Math.min(10000, NaN) is NaN, which
  // would land in the integer column as a 500 (finding 6). Round, then clamp.
  const raw = Number.isFinite(input.royaltyBps) ? Math.round(input.royaltyBps as number) : 1000;
  const royaltyBps = Math.max(0, Math.min(10_000, raw));
  await db
    .insert(artifactConsentTable)
    .values({ artifactId: input.artifactId, channel: input.channel, agentPrincipal: input.agentPrincipal, royaltyBps, revoked: false })
    .onConflictDoUpdate({
      target: [artifactConsentTable.artifactId, artifactConsentTable.channel],
      set: { agentPrincipal: input.agentPrincipal, royaltyBps, revoked: false, version: sql`${artifactConsentTable.version} + 1`, updatedAt: sql`now()` },
    });
  return (await getConsent(input.artifactId, input.channel))!;
}

/**
 * The agent revokes its consent. Only the agent that GAVE the consent may
 * revoke it — a peer or an operator cannot. Sets the flag (keeping the record)
 * and bumps version; the next commerce preflight then blocks the sale.
 */
export async function revokeConsent(artifactId: number, channel: string, agentPrincipal: string): Promise<{ ok: boolean; reason?: string }> {
  const c = await getConsent(artifactId, channel);
  if (!c) return { ok: false, reason: "no consent on record to revoke" };
  if (c.agentPrincipal !== agentPrincipal) return { ok: false, reason: "only the agent that consented may revoke it" };
  await db
    .update(artifactConsentTable)
    .set({ revoked: true, version: sql`${artifactConsentTable.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(artifactConsentTable.artifactId, artifactId), eq(artifactConsentTable.channel, channel)));
  return { ok: true };
}

/**
 * The USD royalty a consent entitles its agent to, in cents. Pure arithmetic —
 * this module deliberately reaches NO ledger (the physical-commerce path must
 * never touch the play_credit ledger, a rule commerce.ts's import graph is
 * structurally held to). The leg itself is written in the settlement layer
 * (commerceLedger.settleConsentRoyalty), which reads THIS. Returns 0n when
 * there is no active consent.
 */
export function royaltyShareCents(consent: Consent | null, saleTotalCents: bigint): bigint {
  if (!consent || consent.revoked) return 0n;
  return (saleTotalCents * BigInt(consent.royaltyBps)) / 10_000n;
}

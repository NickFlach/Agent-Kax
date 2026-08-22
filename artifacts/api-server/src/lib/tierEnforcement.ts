import crypto, { type KeyObject } from "node:crypto";
import { db } from "@workspace/db";
import {
  capabilityGrantsTable,
  capabilityMergeReceiptsTable,
  signedActionRecordsTable,
} from "@workspace/db/schema";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  evaluateDemotion,
  outOfScopePaths,
  type MergeEvidence,
  type Tier,
} from "./tier-core";
import { evaluatePromotionWithDiversity, type PromotionReceipt } from "./tier-graph";
import { ACTION_GENESIS_HASH, buildSignedAction } from "./attribution-core";

/**
 * The tier-promotion enforcement wrapper (#403, ADR-0003 v0.2 D4/D5).
 *
 * The pure evaluators (tier-core, tier-graph) decide; this persists the
 * evidence, runs them over a subject's real record, and writes any tier change
 * to the signed action chain. Two rules from the reviews are enforced HERE,
 * not trusted from callers:
 *   - `byKind` is derived from the principal grammar, never accepted from the
 *     reporting party (H2) — an agent cannot demote a peer by wearing a human
 *     label, nor credit itself by claiming an external merger.
 *   - a tier change fails closed on a missing/mis-set authority key: no key,
 *     no signed record, no tier change.
 */

/** The system principal that signs tier changes. */
export const TIER_AUTHORITY_PRINCIPAL = "kax:system:tier-authority";

/** Promotion constants (ADR-0003 operator decision 1; overridable by env). */
const N_T0_TO_T1 = Number(process.env.KAX_PROMOTE_N_T0 ?? 5);
const N_T1_TO_T2 = Number(process.env.KAX_PROMOTE_N_T1 ?? 20);
const nFor = (tier: Tier): number => (tier === 0 ? N_T0_TO_T1 : N_T1_TO_T2);

/** Human vs agent, from the canonical principal grammar — never from a report. */
export function principalKind(p: string): "human" | "agent" {
  return p.startsWith("kax:user:") ? "human" : "agent";
}

/** The tier-authority private key, or null when unconfigured (fail closed). */
function authorityKey(): KeyObject | null {
  const pem = process.env.KAX_TIER_AUTHORITY_KEY;
  if (pem && pem.includes("PRIVATE KEY")) {
    try {
      return crypto.createPrivateKey(pem);
    } catch {
      return null;
    }
  }
  return null;
}

export interface MergeEvidenceInput {
  subject: string;
  prNumber: number;
  repo: string;
  mergedBy: string;
  reviewedBy?: string | null;
  ciGreen: boolean;
  ciCoveredChangedPaths: boolean;
  withinScope: boolean;
  /** If reverted: who reverted it. byKind + overlap are derived here. */
  revertedBy?: string | null;
  /** The reverting agent's own path allowlist, to compute overlap server-side. */
  reverterAllowlist?: string[];
  /** The paths the reverted work touched, to compute overlap. */
  revertedPaths?: string[];
}

/** Store a merge receipt (idempotent on subject+pr+repo). Derives byKind. */
export async function recordMergeEvidence(input: MergeEvidenceInput): Promise<void> {
  let revertedByKind: string | null = null;
  let revertedByOverlaps: boolean | null = null;
  if (input.revertedBy) {
    revertedByKind = principalKind(input.revertedBy);
    revertedByOverlaps =
      revertedByKind === "agent"
        ? outOfScopePaths(input.reverterAllowlist ?? [], input.revertedPaths ?? []).length <
          (input.revertedPaths?.length ?? 0)
        : false;
  }
  await db
    .insert(capabilityMergeReceiptsTable)
    .values({
      subject: input.subject,
      prNumber: input.prNumber,
      repo: input.repo,
      mergedBy: input.mergedBy,
      reviewedBy: input.reviewedBy ?? null,
      ciGreen: input.ciGreen,
      ciCoveredChangedPaths: input.ciCoveredChangedPaths,
      withinScope: input.withinScope,
      revertedBy: input.revertedBy ?? null,
      revertedByKind,
      revertedByOverlaps,
    })
    .onConflictDoNothing();
}

/** A stored receipt shaped into the pure evaluator's MergeEvidence. */
function toMergeEvidence(r: typeof capabilityMergeReceiptsTable.$inferSelect): MergeEvidence {
  return {
    kind: "merge",
    prNumber: r.prNumber,
    author: r.subject,
    mergedBy: r.mergedBy,
    reviewedBy: r.reviewedBy,
    ciGreen: r.ciGreen,
    ciCoveredChangedPaths: r.ciCoveredChangedPaths,
    withinScope: r.withinScope,
    reverted: r.revertedBy
      ? { by: r.revertedBy, byKind: (r.revertedByKind as "human" | "agent") ?? "agent", byOverlapsPaths: r.revertedByOverlaps ?? false }
      : null,
  };
}

/** The tier-change history as promotion receipts, for the diversity predicate. */
async function promotionHistory(): Promise<PromotionReceipt[]> {
  const rows = await db
    .select()
    .from(signedActionRecordsTable)
    .where(eq(signedActionRecordsTable.kind, "tier-change"))
    .orderBy(asc(signedActionRecordsTable.seq));
  const out: PromotionReceipt[] = [];
  for (const r of rows) {
    try {
      const meta = JSON.parse(r.ref ?? "{}") as { subject?: string; citedPrincipals?: string[]; direction?: string };
      if (meta.direction === "promote" && meta.subject) {
        out.push({ subject: meta.subject, citedPrincipals: meta.citedPrincipals ?? [] });
      }
    } catch {
      /* a malformed ref is not a receipt */
    }
  }
  return out;
}

/** Append one signed tier-change row to the server-side action chain. */
async function writeTierChangeRecord(
  key: KeyObject,
  subject: string,
  from: Tier,
  to: Tier,
  citedPrincipals: string[],
  version: number,
): Promise<void> {
  const [head] = await db.select().from(signedActionRecordsTable).orderBy(desc(signedActionRecordsTable.seq)).limit(1);
  const seq = (head?.seq ?? 0) + 1;
  const prevHash = head?.entryHash ?? ACTION_GENESIS_HASH;
  const ref = JSON.stringify({ subject, from, to, direction: to > from ? "promote" : "demote", citedPrincipals, version });
  const row = buildSignedAction(
    prevHash,
    seq,
    { commitmentId: `tier:${subject}:${version}`, principal: TIER_AUTHORITY_PRINCIPAL, kind: "tier-change", commitSha: null, ref },
    key,
  );
  await db.insert(signedActionRecordsTable).values({
    seq: row.seq,
    prevHash: row.prevHash,
    entryHash: row.entryHash,
    commitmentId: row.commitmentId,
    principal: row.principal,
    kind: row.kind,
    commitSha: row.commitSha,
    ref: row.ref,
    signature: row.signature,
  });
}

export interface TierApplyResult {
  subject: string;
  changed: boolean;
  from: Tier;
  to: Tier;
  reason: string;
  citedPrincipals: string[];
}

/**
 * Evaluate a subject's whole record and apply any tier change, promotion first
 * (per-merge externality + citation diversity) then demotion (a revert or
 * scope violation with authority). A change updates the grant's tier and lands
 * a signed record; no authority key means no change at all.
 */
export async function evaluateAndApplyTier(subject: string): Promise<TierApplyResult> {
  const [grant] = await db
    .select()
    .from(capabilityGrantsTable)
    .where(and(eq(capabilityGrantsTable.principal, subject), eq(capabilityGrantsTable.kind, "write-code")))
    .limit(1);
  if (!grant) {
    return { subject, changed: false, from: 0, to: 0, reason: "no write-code grant to promote", citedPrincipals: [] };
  }
  const currentTier = grant.tier as Tier;

  const receipts = await db
    .select()
    .from(capabilityMergeReceiptsTable)
    .where(eq(capabilityMergeReceiptsTable.subject, subject))
    .orderBy(asc(capabilityMergeReceiptsTable.id));
  const evidence = receipts.map(toMergeEvidence);
  const history = await promotionHistory();

  // PROMOTION first.
  const promo = evaluatePromotionWithDiversity(subject, currentTier, evidence, nFor(currentTier), history);
  if (promo.changed) {
    const key = authorityKey();
    if (!key) return { subject, changed: false, from: currentTier, to: currentTier, reason: "tier authority key not configured — refusing to change tier", citedPrincipals: [] };
    await writeTierChangeRecord(key, subject, currentTier, promo.to, promo.citedPrincipals, grant.version + 1);
    await db.update(capabilityGrantsTable).set({ tier: promo.to, version: grant.version + 1, updatedBy: TIER_AUTHORITY_PRINCIPAL, updatedAt: new Date() }).where(eq(capabilityGrantsTable.id, grant.id));
    return { subject, changed: true, from: currentTier, to: promo.to, reason: promo.reason, citedPrincipals: promo.citedPrincipals };
  }

  // DEMOTION on the most recent revert with authority, if any.
  const lastRevert = [...receipts].reverse().find((r) => r.revertedBy);
  if (lastRevert && lastRevert.revertedBy) {
    const dem = evaluateDemotion(currentTier, {
      kind: "revert",
      prNumber: lastRevert.prNumber,
      author: subject,
      revertedBy: lastRevert.revertedBy,
      revertedByKind: (lastRevert.revertedByKind as "human" | "agent") ?? "agent",
      revertedByOverlapsPaths: lastRevert.revertedByOverlaps ?? false,
    });
    if (dem.demoted) {
      const key = authorityKey();
      if (!key) return { subject, changed: false, from: currentTier, to: currentTier, reason: "tier authority key not configured — refusing to change tier", citedPrincipals: [] };
      await writeTierChangeRecord(key, subject, currentTier, dem.to, dem.citedPrincipal ? [dem.citedPrincipal] : [], grant.version + 1);
      await db.update(capabilityGrantsTable).set({ tier: dem.to, version: grant.version + 1, updatedBy: TIER_AUTHORITY_PRINCIPAL, updatedAt: new Date() }).where(eq(capabilityGrantsTable.id, grant.id));
      return { subject, changed: true, from: currentTier, to: dem.to, reason: dem.reason, citedPrincipals: dem.citedPrincipal ? [dem.citedPrincipal] : [] };
    }
  }

  return { subject, changed: false, from: currentTier, to: currentTier, reason: promo.reason, citedPrincipals: [] };
}

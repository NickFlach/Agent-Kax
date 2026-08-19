import crypto from "node:crypto";
import { db } from "@workspace/db";
import {
  authorityPoliciesTable,
  authorityReservationsTable,
  authorityUsageTable,
  type AuthorityPolicy,
} from "@workspace/db/schema";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { recordDecision } from "./authority";
import { botIdOfPrincipal } from "./revocation";

/**
 * authorityPolicy.ts — the policy engine (#266, KAX-ADR-0001 Phase 1b).
 *
 * Phase 1a recorded WHO caused each movement; this decides whether it was
 * PERMITTED, and records that decision — allow and deny alike — through the
 * one sanctioned writer in lib/authority.ts.
 *
 * Shape of the flow: `admit()` runs BEFORE the ledger transaction opens —
 * policy lookup, revocation, cap reservation, decision row. Inside the ledger
 * transaction the only authority work is ONE indexed read confirming a
 *matching, unexpired decision row (postTransaction's admissionDecisionId).
 *
 * Fail-closed throughout: every deny path returns a machine-distinct reason
 * code, and infrastructure failure (the policy table missing) is a DENY, not
 * an ALLOW — the economy halting is correct, and /health/schema reports the
 * missing table because the drizzle registration makes the check automatic.
 *
 * DARK: no production route calls admit() yet. The default policy content is
 * a product decision (the issue's operator note); until Nick sets policies,
 * every principal is policy_missing — which is the conservative default.
 */

// ---------------------------------------------------------------------------
// Reason codes — varchar semantics, never an enum in the DB.
// ---------------------------------------------------------------------------

export const DENY_REASONS = [
  "policy_missing",
  "policy_table_unavailable",
  "principal_unparseable",
  "reservation_unavailable",
  "approval_expired",
  "revoked",
  "capability_not_granted",
  "cap_exceeded",
] as const;
export type DenyReason = (typeof DENY_REASONS)[number];

/** How long an admission is good for before the ledger must have used it. */
export const ADMISSION_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// The policy key.
// ---------------------------------------------------------------------------

/**
 * The policy key IS the principal string from lib/actor.ts, derived nowhere
 * else — with the `obc:<uuid>` channel-link form collapsed to
 * `kax:agent:<uuid>` via botIdOfPrincipal so one agent cannot hold two policy
 * identities. Anything unparseable is null, and null is a DENY.
 */
export function policyKeyOf(principal: string): string | null {
  const botId = botIdOfPrincipal(principal);
  if (botId) return `kax:agent:${botId}`;
  if (/^kax:[a-z]+:.+$/.test(principal)) return principal;
  return null;
}

// ---------------------------------------------------------------------------
// The policy document.
// ---------------------------------------------------------------------------

/**
 * One grant per (capability, asset). No grant, no action — an empty grants
 * list is a valid policy that denies everything, and IS the conservative
 * default until the product decision on default content is made.
 */
export interface PolicyGrant {
  capability: string;
  /** Omitted = the grant covers any asset. */
  asset?: string;
  /** Discrete UTC window the cap counts over. Omitted = uncapped. */
  window?: "day" | "month";
  /** Cap in minor units, as a decimal string (jsonb has no bigint). */
  capMinor?: string;
}

export interface PolicyDocument {
  v: 1;
  grants: PolicyGrant[];
}

/** The conservative default: a policy that exists but grants nothing. */
export const DEFAULT_POLICY_DOCUMENT: PolicyDocument = { v: 1, grants: [] };

/** Canonical form: sorted keys at every level, so the hash is reproducible. */
export function canonicalPolicyJson(doc: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(doc));
}

export function policyDocumentHash(doc: unknown): string {
  return crypto.createHash("sha256").update(canonicalPolicyJson(doc)).digest("hex");
}

// ---------------------------------------------------------------------------
// Storage: versioned, immutable, superseded — never edited.
// ---------------------------------------------------------------------------

/**
 * Install a new policy version for a principal. INSERTs version N+1 and
 * stamps superseded_at on version N — the one UPDATE the trigger permits.
 * The prior current row is locked FOR UPDATE first so two concurrent puts
 * serialize into consecutive versions instead of a unique-violation race.
 */
export async function putPolicy(input: {
  principal: string;
  document: PolicyDocument;
  createdBy: string;
}): Promise<AuthorityPolicy> {
  const key = policyKeyOf(input.principal);
  if (!key) throw new Error(`unparseable principal: ${input.principal}`);
  const hash = policyDocumentHash(input.document);
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(authorityPoliciesTable)
      .where(and(eq(authorityPoliciesTable.principal, key), isNull(authorityPoliciesTable.supersededAt)))
      .limit(1)
      .for("update");
    if (current) {
      await tx
        .update(authorityPoliciesTable)
        .set({ supersededAt: new Date() })
        .where(eq(authorityPoliciesTable.id, current.id));
    }
    const [row] = await tx
      .insert(authorityPoliciesTable)
      .values({
        principal: key,
        version: (current?.version ?? 0) + 1,
        document: input.document,
        documentHash: hash,
        createdBy: input.createdBy,
      })
      .returning();
    return row!;
  });
}

/** The current (unsuperseded) policy for a principal, or null. */
export async function currentPolicy(principal: string): Promise<AuthorityPolicy | null> {
  const key = policyKeyOf(principal);
  if (!key) return null;
  const [row] = await db
    .select()
    .from(authorityPoliciesTable)
    .where(and(eq(authorityPoliciesTable.principal, key), isNull(authorityPoliciesTable.supersededAt)))
    .limit(1);
  return row ?? null;
}

/**
 * Historical resolution: the policy ROW a decision referenced, verified
 * against the document hash the decision recorded. A superseded policy still
 * resolves — that is the point of never editing rows — and a hash mismatch is
 * an integrity failure, not a lookup miss.
 */
export async function policyForDecision(
  policyId: number,
  expectedDocumentHash: string,
): Promise<AuthorityPolicy> {
  const [row] = await db
    .select()
    .from(authorityPoliciesTable)
    .where(eq(authorityPoliciesTable.id, policyId))
    .limit(1);
  if (!row) throw new Error(`policy row ${policyId} does not exist`);
  if (row.documentHash !== expectedDocumentHash) {
    throw new Error(
      `policy row ${policyId} hash mismatch: decision recorded ${expectedDocumentHash}, row has ${row.documentHash}`,
    );
  }
  return row;
}

// ---------------------------------------------------------------------------
// Windows — discrete UTC keys, one usage row each.
// ---------------------------------------------------------------------------

export function windowKeyFor(window: "day" | "month", now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  if (window === "month") return `month:${y}-${m}`;
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `day:${y}-${m}-${d}`;
}

// ---------------------------------------------------------------------------
// Admission.
// ---------------------------------------------------------------------------

export interface AdmitInput {
  /** The acting principal, in any of its accepted spellings. */
  principal: string;
  capability: string;
  asset: string;
  amountMinor: bigint;
  /** The exact canonical posting array the ledger call will replay. */
  postings: unknown;
  postingsHash: string;
  /** Known upfront by commerce callers; recorded on the decision. */
  txId?: string;
  correlationId?: string;
}

export type Admission =
  | {
      decision: "allow";
      decisionId: string;
      policyId: number;
      policyDocumentHash: string;
      reservationId: string | null;
      expiresAt: Date;
    }
  | { decision: "deny"; decisionId: string; reasonCode: DenyReason };

/** Is this pg error "the relation does not exist"? */
function isUndefinedTable(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "42P01" || e?.cause?.code === "42P01";
}

let denySeq = 0;
function freshDecisionId(prefix: string): string {
  // Time+counter, not Math.random: unique enough for a decision id and
  // monotonic within a process, which makes logs sort.
  return `${prefix}:${Date.now().toString(36)}:${process.pid}:${++denySeq}`;
}

async function recordDeny(input: AdmitInput, reasonCode: DenyReason): Promise<Admission> {
  const decisionId = freshDecisionId("dec:deny");
  await db.transaction(async (tx) => {
    await recordDecision(tx, {
      decisionId,
      actor: input.principal,
      capability: input.capability,
      asset: input.asset,
      amountMinor: input.amountMinor,
      decision: "deny",
      reasonCode,
      txId: input.txId,
      postingsHash: input.postingsHash,
      correlationId: input.correlationId,
    });
  });
  return { decision: "deny", decisionId, reasonCode };
}

/**
 * Decide whether one consequential action is permitted, BEFORE the ledger
 * transaction opens. On allow: a cap reservation is held (if the grant is
 * capped), and an allow decision row exists with an expiry — pass its
 * decisionId to postTransaction as admissionDecisionId, which confirms it
 * with one indexed read inside the transaction.
 */
export async function admit(input: AdmitInput): Promise<Admission> {
  // 1. The key. Unparseable is a DENY with its own code, never a throw —
  //    fail-closed means the caller gets a decision, not an exception to map.
  const key = policyKeyOf(input.principal);
  if (!key) return recordDeny(input, "principal_unparseable");

  // 2. Revocation. The city withdrew its verification: no policy can help.
  const botId = botIdOfPrincipal(key);
  if (botId) {
    const { isRevoked } = await import("./revocation");
    if (await isRevoked(botId)) return recordDeny(input, "revoked");
  }

  // 3. The current policy. A missing TABLE and a missing ROW are different
  //    failures with different fixes; give each its own code.
  let policy: AuthorityPolicy | null;
  try {
    policy = await currentPolicy(key);
  } catch (err) {
    if (isUndefinedTable(err)) return recordDeny(input, "policy_table_unavailable");
    throw err;
  }
  if (!policy) return recordDeny(input, "policy_missing");

  // 4. The grant. Exact capability match; asset must match or be un-scoped.
  const doc = policy.document as PolicyDocument;
  const grant = (doc.grants ?? []).find(
    (g) => g.capability === input.capability && (g.asset == null || g.asset === input.asset),
  );
  if (!grant) return recordDeny(input, "capability_not_granted");

  // 5. The cap, if any: reserve headroom under a ROW-LEVEL lock.
  let reservationId: string | null = null;
  if (grant.capMinor != null) {
    const window = grant.window ?? "day";
    try {
      reservationId = await reserve({
        principal: key,
        capability: input.capability,
        asset: input.asset,
        windowKey: windowKeyFor(window, new Date()),
        capMinor: BigInt(grant.capMinor),
        amountMinor: input.amountMinor,
        postings: input.postings,
        postingsHash: input.postingsHash,
      });
    } catch (err) {
      if (isUndefinedTable(err)) return recordDeny(input, "reservation_unavailable");
      throw err;
    }
    if (reservationId === null) return recordDeny(input, "cap_exceeded");
  }

  // 6. The allow decision — ONE insert carrying the policy linkage and an
  //    expiry the ledger will re-check. Decisions are append-only, so all of
  //    it must ride the initial row; there is no stamping it in later.
  const decisionId = freshDecisionId("dec:adm");
  const expiresAt = new Date(Date.now() + ADMISSION_TTL_MS);
  await db.transaction(async (tx) => {
    await recordDecision(tx, {
      decisionId,
      actor: input.principal,
      principal: key,
      capability: input.capability,
      asset: input.asset,
      amountMinor: input.amountMinor,
      decision: "allow",
      txId: input.txId,
      postingsHash: input.postingsHash,
      correlationId: input.correlationId,
      policyId: policy.id,
      policyDocumentHash: policy.documentHash,
      expiresAt,
    });
  });

  return {
    decision: "allow",
    decisionId,
    policyId: policy.id,
    policyDocumentHash: policy.documentHash,
    reservationId,
    expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Reservations.
// ---------------------------------------------------------------------------

export const RESERVATION_STATES = [
  "reserved",
  "submitted",
  "outcome_unknown",
  "committed",
  "released",
] as const;
export type ReservationState = (typeof RESERVATION_STATES)[number];

/** The transitions the lifecycle permits. */
const RESERVATION_TRANSITIONS: Record<string, ReservationState[]> = {
  reserved: ["submitted", "released"],
  submitted: ["outcome_unknown", "committed", "released"],
  outcome_unknown: ["committed", "released"],
  committed: [],
  released: [],
};

/**
 * Reserve cap headroom. Returns a reservationId, or null when the cap has no
 * room. The usage row is locked FOR UPDATE for the duration, so two
 * concurrent reservations against one cap serialize and cannot double-spend.
 */
async function reserve(input: {
  principal: string;
  capability: string;
  asset: string;
  windowKey: string;
  capMinor: bigint;
  amountMinor: bigint;
  postings: unknown;
  postingsHash: string;
}): Promise<string | null> {
  if (input.amountMinor <= 0n) throw new Error("reservation amount must be positive");
  return db.transaction(async (tx) => {
    // Ensure the usage row exists, then take the ROW lock. The upsert is
    // idempotent; the lock is what serializes concurrent reservations.
    await tx
      .insert(authorityUsageTable)
      .values({
        principal: input.principal,
        capability: input.capability,
        asset: input.asset,
        windowKey: input.windowKey,
      })
      .onConflictDoNothing();
    const [usage] = await tx
      .select()
      .from(authorityUsageTable)
      .where(
        and(
          eq(authorityUsageTable.principal, input.principal),
          eq(authorityUsageTable.capability, input.capability),
          eq(authorityUsageTable.asset, input.asset),
          eq(authorityUsageTable.windowKey, input.windowKey),
        ),
      )
      .limit(1)
      .for("update");
    if (!usage) throw new Error("usage row vanished under its own upsert");
    if (usage.usedMinor + input.amountMinor > input.capMinor) return null;
    await tx
      .update(authorityUsageTable)
      .set({ usedMinor: usage.usedMinor + input.amountMinor, updatedAt: new Date() })
      .where(eq(authorityUsageTable.id, usage.id));
    const reservationId = freshDecisionId("rsv");
    await tx.insert(authorityReservationsTable).values({
      reservationId,
      usageId: usage.id,
      principal: input.principal,
      capability: input.capability,
      asset: input.asset,
      amountMinor: input.amountMinor,
      postings: input.postings,
      postingsHash: input.postingsHash,
    });
    return reservationId;
  });
}

async function transition(
  reservationId: string,
  to: ReservationState,
  extra: { txId?: string } = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(authorityReservationsTable)
      .where(eq(authorityReservationsTable.reservationId, reservationId))
      .limit(1)
      .for("update");
    if (!row) throw new Error(`reservation ${reservationId} does not exist`);
    if (!RESERVATION_TRANSITIONS[row.state]?.includes(to)) {
      throw new Error(`reservation ${reservationId}: ${row.state} -> ${to} is not a permitted transition`);
    }
    await tx
      .update(authorityReservationsTable)
      .set({ state: to, updatedAt: new Date(), ...(extra.txId ? { txId: extra.txId } : {}) })
      .where(eq(authorityReservationsTable.id, row.id));
    if (to === "released") {
      // Give the headroom back, under the same row lock discipline.
      const [usage] = await tx
        .select()
        .from(authorityUsageTable)
        .where(eq(authorityUsageTable.id, row.usageId))
        .limit(1)
        .for("update");
      if (usage) {
        await tx
          .update(authorityUsageTable)
          .set({ usedMinor: usage.usedMinor - row.amountMinor, updatedAt: new Date() })
          .where(eq(authorityUsageTable.id, usage.id));
      }
    }
  });
}

/** The ledger call is in flight. */
export async function markSubmitted(reservationId: string, txId: string): Promise<void> {
  await transition(reservationId, "submitted", { txId });
}

/**
 * The ledger call's outcome could not be observed (timeout, crash between
 * submit and response). The reservation KEEPS consuming cap headroom until a
 * reconciler resolves it — releasing here would let a retry double-spend the
 * cap while the first attempt may have committed.
 */
export async function markOutcomeUnknown(reservationId: string): Promise<void> {
  await transition(reservationId, "outcome_unknown");
}

/**
 * The ledger recorded the transaction. The postings hash must match what was
 * reserved byte-for-byte — a drifted retry would already have raised
 * LedgerIdempotencyConflict at the ledger, and a commit that disagrees with
 * its reservation is a bug worth halting on.
 */
export async function commitReservation(reservationId: string, postingsHash: string): Promise<void> {
  const [row] = await db
    .select()
    .from(authorityReservationsTable)
    .where(eq(authorityReservationsTable.reservationId, reservationId))
    .limit(1);
  if (!row) throw new Error(`reservation ${reservationId} does not exist`);
  if (row.postingsHash !== postingsHash) {
    throw new Error(
      `reservation ${reservationId}: commit postings hash differs from what was reserved — refusing`,
    );
  }
  await transition(reservationId, "committed");
}

/** The action definitively did not happen; return the headroom. */
export async function releaseReservation(reservationId: string): Promise<void> {
  await transition(reservationId, "released");
}

/**
 * The ageing alert (#266 AC): outcome_unknown reservations older than the
 * threshold, oldest first. Surfaced on GET /health/authority so an operator
 * finds them with one curl; a non-empty list is a 503 because unresolved
 * unknowns pin cap headroom and starve the principal.
 */
export const OUTCOME_UNKNOWN_AGEING_MS = 15 * 60 * 1000;

export async function ageingOutcomeUnknown(
  olderThanMs: number = OUTCOME_UNKNOWN_AGEING_MS,
): Promise<Array<{ reservationId: string; principal: string; amountMinor: bigint; createdAt: Date }>> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const rows = await db
    .select()
    .from(authorityReservationsTable)
    .where(
      and(eq(authorityReservationsTable.state, "outcome_unknown"), lt(authorityReservationsTable.createdAt, cutoff)),
    )
    .orderBy(desc(authorityReservationsTable.createdAt));
  return rows.map((r) => ({
    reservationId: r.reservationId,
    principal: r.principal,
    amountMinor: r.amountMinor,
    createdAt: r.createdAt,
  }));
}

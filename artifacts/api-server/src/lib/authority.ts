import { db } from "@workspace/db";
import { authorityDecisionsTable } from "@workspace/db/schema";

/**
 * authority.ts — the ONE sanctioned writer of authority_decisions (#248,
 * KAX-ADR-0001 Phase 1a).
 *
 * No policy engine exists yet, so `decision` is always "allow" here: the
 * record answers "who caused this", not "was it permitted" — permission is
 * enforced structurally by ledger-core's topology rule. When the policy
 * engine lands (Phase 1b), it slots in ABOVE this write; the record's shape
 * does not change.
 *
 * authorityDecisions.test.ts pins that no OTHER production file writes the
 * table. If you are adding a second writer, stop: route it through here, or
 * the audit trail forks.
 */

/** The transaction handle db.transaction() hands its callback. */
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Deterministic decision id for a ledger transaction, so a retried or
 * replayed post maps to the SAME decision row and ON CONFLICT DO NOTHING
 * makes the write idempotent without a read.
 */
export function decisionIdFor(txId: string): string {
  return `dec:tx:${txId}`;
}

export interface RecordDecisionInput {
  decisionId: string;
  actor: string;
  onBehalfOf?: string;
  principal?: string;
  capability: string;
  resource?: string;
  asset?: string;
  amountMinor?: bigint;
  /** Phase 1a: always "allow". The field exists so the shape never changes. */
  decision: "allow" | "deny" | "require_approval";
  reasonCode?: string;
  txId?: string;
  postingsHash?: string;
  correlationId?: string;
}

/**
 * Insert one immutable decision row. Takes the caller's transaction handle so
 * the decision and the action it records commit or roll back TOGETHER — a
 * decision row for a transaction that never happened, or a transaction with
 * no decision row, are both lies the audit trail must not be able to tell.
 * Single INSERT, no reads, no network: safe under the ledger advisory lock.
 */
export async function recordDecision(tx: DbTx, input: RecordDecisionInput): Promise<void> {
  await tx
    .insert(authorityDecisionsTable)
    .values({
      decisionId: input.decisionId,
      actor: input.actor,
      onBehalfOf: input.onBehalfOf ?? null,
      principal: input.principal ?? null,
      capability: input.capability,
      resource: input.resource ?? null,
      asset: input.asset ?? null,
      amountMinor: input.amountMinor ?? null,
      decision: input.decision,
      reasonCode: input.reasonCode ?? null,
      txId: input.txId ?? null,
      postingsHash: input.postingsHash ?? null,
      correlationId: input.correlationId ?? null,
    })
    .onConflictDoNothing({ target: authorityDecisionsTable.decisionId });
}

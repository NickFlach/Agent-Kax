import { evaluatePromotion, type MergeEvidence, type Tier, type TierDecision } from "./tier-core";

/**
 * tier-graph.ts — citation DIVERSITY over tier-core's citations (#361).
 *
 * tier-core judges one subject's evidence and, correctly, cannot see the
 * citation graph — so two agents can satisfy the D4 externality rule
 * JOINTLY: A's every credit cites B, B's every credit cites A, both
 * promote on records that are textually impeccable and substantively
 * manufactured (#346's defect with an accomplice). No collusion required:
 * two well-behaved agents that habitually review each other drift into
 * this shape honestly, which is why it is handled rather than moralized
 * about.
 *
 * This module is the graph half, pure like tier-core (the receipts it
 * reads are the wrapper's stored PromotionReceipts — the first place a
 * cycle exists as data). The predicate is the issue's weakest sufficient
 * form: a promotion stands only when at least one cited principal is
 * INDEPENDENT — not itself promoted on the subject's signals. A 2-cycle
 * (or any closed clique of mutual citation) cannot be self-sufficient;
 * mutual review between colleagues PLUS outside signal keeps working,
 * because that is the healthy pattern and blocking it would be the
 * overcorrection the issue's mutation test forbids.
 */

/** One stored promotion receipt — what the persistence wrapper keeps. */
export interface PromotionReceipt {
  subject: string;
  citedPrincipals: string[];
}

export interface DiversityVerdict {
  ok: boolean;
  reason: string;
  /** The cited principals found independent of the subject. Empty iff !ok. */
  independentPrincipals: string[];
}

/**
 * Is `principal` independent of `subject`, given the stored receipts?
 * Independent = none of the principal's own promotion receipts cite the
 * subject back. A principal with NO promotion receipts (a human reviewer,
 * or an agent that never promoted) is independent by construction — its
 * standing was not built on the subject's signals.
 */
export function isIndependent(
  principal: string,
  subject: string,
  history: PromotionReceipt[],
): boolean {
  const theirs = history.filter((r) => r.subject === principal);
  return theirs.every((r) => !r.citedPrincipals.includes(subject));
}

/**
 * The #361 predicate, applied to a WOULD-BE promotion's citations.
 * Refuses when every cited principal's own promotions cite the subject
 * back — the shape in which A and B manufacture each other's records.
 */
export function citationDiversity(
  subject: string,
  citedPrincipals: string[],
  history: PromotionReceipt[],
): DiversityVerdict {
  if (citedPrincipals.length === 0) {
    return { ok: false, reason: "no cited principals to assess", independentPrincipals: [] };
  }
  const independent = citedPrincipals.filter((p) => isIndependent(p, subject, history));
  if (independent.length === 0) {
    return {
      ok: false,
      reason:
        "citation cycle: every cited principal's own promotions cite the subject back — " +
        "a closed loop of mutual citation cannot be self-sufficient (#361)",
      independentPrincipals: [],
    };
  }
  return {
    ok: true,
    reason: `cited principal(s) independent of the subject: ${independent.join(", ")}`,
    independentPrincipals: independent,
  };
}

/**
 * The composed evaluator the persistence wrapper calls: tier-core first
 * (per-merge externality), then the graph predicate over the citations the
 * core produced. A refusal keeps the core's full decision list — the
 * receipts are the point — and downgrades `changed` with the cycle named,
 * so an auditor can see a promotion that was EARNED per-merge and refused
 * per-graph, which is exactly the distinction #361 introduces.
 */
export function evaluatePromotionWithDiversity(
  subject: string,
  currentTier: Tier,
  evidence: MergeEvidence[],
  n: number,
  history: PromotionReceipt[],
): TierDecision & { diversity: DiversityVerdict | null } {
  const core = evaluatePromotion(subject, currentTier, evidence, n);
  if (!core.changed) return { ...core, diversity: null };
  const verdict = citationDiversity(subject, core.citedPrincipals, history);
  if (!verdict.ok) {
    return {
      ...core,
      changed: false,
      to: core.from,
      citedPrincipals: [],
      reason: verdict.reason,
      diversity: verdict,
    };
  }
  return { ...core, diversity: verdict };
}

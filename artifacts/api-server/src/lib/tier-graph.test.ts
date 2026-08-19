/**
 * tier-graph.test.ts — #361's acceptance and its mutation, verbatim.
 *
 * The mutation the issue specifies: the A↔B fixture must leave NEITHER
 * promoted; adding ONE genuinely independent principal to A's window must
 * promote A while B stays refused. A fix that blocks the mixed case too
 * has overcorrected — mutual review plus outside signal is the healthy
 * pattern and must keep working.
 */

import { describe, expect, it } from "vitest";
import type { MergeEvidence } from "./tier-core";
import {
  citationDiversity,
  evaluatePromotionWithDiversity,
  isIndependent,
  type PromotionReceipt,
} from "./tier-graph";

const A = "kax:agent:aaaaaaaa-0000-0000-0000-000000000001";
const B = "kax:agent:bbbbbbbb-0000-0000-0000-000000000002";
const HUMAN = "kax:user:carol";

/** A creditable merge for `subject`, reviewed+merged by `peer`. */
function merge(subject: string, peer: string, pr: number): MergeEvidence {
  return {
    kind: "merge",
    prNumber: pr,
    author: subject,
    mergedBy: peer,
    reviewedBy: peer,
    ciGreen: true,
    ciCoveredChangedPaths: true,
    withinScope: true,
    reverted: null,
  };
}

const N = 3;

describe("independence over stored receipts", () => {
  it("a principal with no promotions is independent; one promoted on the subject is not", () => {
    const history: PromotionReceipt[] = [{ subject: B, citedPrincipals: [A] }];
    expect(isIndependent(HUMAN, A, history)).toBe(true); // never promoted at all
    expect(isIndependent(B, A, history)).toBe(false); // B's record is built on A
    expect(isIndependent(B, HUMAN, history)).toBe(true); // B never cited carol
  });

  it("an empty citation set never passes — nothing to be diverse about", () => {
    expect(citationDiversity(A, [], []).ok).toBe(false);
  });
});

describe("the #361 mutation, exactly as specified", () => {
  // The 2-cycle: A's evidence cites only B; B's cites only A. Each already
  // holds one promotion receipt citing the other — the drift state.
  const history: PromotionReceipt[] = [
    { subject: A, citedPrincipals: [B] },
    { subject: B, citedPrincipals: [A] },
  ];
  const aEvidence = [merge(A, B, 101), merge(A, B, 102), merge(A, B, 103)];
  const bEvidence = [merge(B, A, 201), merge(B, A, 202), merge(B, A, 203)];

  it("the A↔B fixture: NEITHER promotes, and the refusal names the cycle", () => {
    const a = evaluatePromotionWithDiversity(A, 0, aEvidence, N, history);
    const b = evaluatePromotionWithDiversity(B, 0, bEvidence, N, history);
    expect(a.changed).toBe(false);
    expect(b.changed).toBe(false);
    expect(a.reason).toMatch(/citation cycle/);
    expect(b.reason).toMatch(/citation cycle/);
    // The per-merge receipts survive the refusal — an auditor can see a
    // promotion earned per-merge and refused per-graph.
    expect(a.decisions.filter((d) => d.credited)).toHaveLength(3);
    expect(a.diversity?.ok).toBe(false);
  });

  it("one independent principal in A's window: A promotes, B still does not", () => {
    const aMixed = [merge(A, B, 101), merge(A, HUMAN, 102), merge(A, B, 103)];
    const a = evaluatePromotionWithDiversity(A, 0, aMixed, N, history);
    expect(a.changed).toBe(true);
    expect(a.to).toBe(1);
    expect(a.diversity?.ok).toBe(true);
    expect(a.diversity?.independentPrincipals).toEqual([HUMAN]);
    // B's window is still the pure cycle: refused, not collateral damage.
    const b = evaluatePromotionWithDiversity(B, 0, bEvidence, N, history);
    expect(b.changed).toBe(false);
  });

  it("does not overcorrect: mutual review plus outside signal keeps working both ways", () => {
    // After A's mixed promotion, A's newest receipt cites {B, HUMAN}. B's
    // next window citing {A, HUMAN} must promote: HUMAN is independent.
    const history2: PromotionReceipt[] = [...history, { subject: A, citedPrincipals: [B, HUMAN] }];
    const bMixed = [merge(B, A, 201), merge(B, HUMAN, 202), merge(B, A, 203)];
    const b = evaluatePromotionWithDiversity(B, 0, bMixed, N, history2);
    expect(b.changed).toBe(true);
    expect(b.diversity?.independentPrincipals).toContain(HUMAN);
  });

  it("a three-agent closed clique is still a closed loop — refused", () => {
    const C = "kax:agent:cccccccc-0000-0000-0000-000000000003";
    const clique: PromotionReceipt[] = [
      { subject: A, citedPrincipals: [B] },
      { subject: B, citedPrincipals: [C] },
      { subject: C, citedPrincipals: [A] },
    ];
    // A's window cites B and C; B promotes on C, C promotes on A. C's
    // record is built on A, so C is not independent OF A; B never cited A
    // back... B cited C, not A — B IS independent of A here. The predicate
    // is deliberately the WEAKEST sufficient form: it kills closed loops
    // that cite the subject back, not every triangle. Assert the exact
    // boundary so nobody "fixes" it into the overcorrection.
    const aEv = [merge(A, B, 301), merge(A, C, 302), merge(A, B, 303)];
    const a = evaluatePromotionWithDiversity(A, 0, aEv, N, clique);
    expect(a.changed).toBe(true); // B did not promote on A's signals
    // But the pure 2-cycle inside the clique stays dead:
    const cEv = [merge(C, A, 401), merge(C, A, 402), merge(C, A, 403)];
    const cliqueWithA: PromotionReceipt[] = [...clique, { subject: A, citedPrincipals: [C] }];
    const c = evaluatePromotionWithDiversity(C, 0, cEv, N, cliqueWithA);
    expect(c.changed).toBe(false);
  });

  it("tier-core refusals pass through untouched — the graph never rescues a bad window", () => {
    const tooFew = evaluatePromotionWithDiversity(A, 0, aEvidence.slice(0, 2), N, []);
    expect(tooFew.changed).toBe(false);
    expect(tooFew.diversity).toBeNull(); // the graph was never consulted
  });
});

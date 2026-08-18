/**
 * tier-core.test.ts — the acceptance criteria of #346, #347 and #349,
 * verbatim, against the D4 external-provenance rule as merged in #350.
 *
 * Mutations that prove these tests are real (each marked MUTATION-SENSITIVE):
 *   #346 — let self-merged own-path PRs count again: "still T1" goes red.
 *   #349 — credit unreviewed-and-untested merges: the absence test goes red.
 *   #347 — let any revert demote: the overlapping-peer test goes red.
 * A suite that stays green with a guard removed is asserting the counter,
 * not the property.
 *
 * Needs no DATABASE_URL: tier-core imports nothing at all.
 */

import { describe, expect, it } from "vitest";
import {
  evaluateDemotion,
  evaluatePromotion,
  pathMatchesGlob,
  type MergeEvidence,
  type RevertEvidence,
  type Tier,
} from "./tier-core";

const AGENT = "kax:agent:00000000-0000-4000-8000-0000000000aa";
const PEER = "kax:agent:00000000-0000-4000-8000-0000000000bb";
const HUMAN = "kax:user:nick";
const N = 5;

let nextPr = 100;
function merge(over: Partial<MergeEvidence>): MergeEvidence {
  return {
    kind: "merge",
    prNumber: nextPr++,
    author: AGENT,
    mergedBy: HUMAN,
    reviewedBy: null,
    ciGreen: true,
    ciCoveredChangedPaths: false,
    withinScope: true,
    reverted: false,
    ...over,
  };
}

describe("#346 — an agent cannot manufacture its own promotion", () => {
  // MUTATION-SENSITIVE (#346): credit self-merged merges and this goes red.
  it("stays T1 after N+2 clean self-merged own-path PRs", () => {
    const evidence = Array.from({ length: N + 2 }, () =>
      merge({ mergedBy: AGENT, reviewedBy: null, ciCoveredChangedPaths: true }),
    );
    const d = evaluatePromotion(AGENT, 1 as Tier, evidence, N);
    expect(d.changed).toBe(false);
    expect(d.to).toBe(1);
    // AC 3: the evaluator records which merges it counted and why each was
    // (not) creditable — every refusal names self-merging.
    expect(d.decisions).toHaveLength(N + 2);
    for (const c of d.decisions) {
      expect(c.credited).toBe(false);
      expect(c.reason).toMatch(/self-merged/);
    }
  });

  it("promotes to T2 on N externally-merged, reviewed PRs — promotion stays reachable", () => {
    const evidence = Array.from({ length: N }, () => merge({ reviewedBy: PEER }));
    const d = evaluatePromotion(AGENT, 1 as Tier, evidence, N);
    expect(d.changed).toBe(true);
    expect(d.to).toBe(2);
    // The receipt names the external principal and the signal it counted.
    expect(d.citedPrincipals).toEqual([PEER]);
    for (const c of d.decisions) {
      expect(c.credited).toBe(true);
      expect(c.signal).toBe("reviewed");
      expect(c.externalPrincipal).toBe(PEER);
    }
  });

  it("a self-review is not an external signal", () => {
    const evidence = Array.from({ length: N }, () => merge({ reviewedBy: AGENT }));
    const d = evaluatePromotion(AGENT, 1 as Tier, evidence, N);
    expect(d.changed).toBe(false);
  });
});

describe("#349 — absence of a revert is not evidence of correctness", () => {
  // MUTATION-SENSITIVE (#349): credit unread-and-uncovered merges and this
  // goes red — the merges below are externally merged, green, unreverted, and
  // still must not count, because nobody looked and nothing tested them.
  it("does not promote on N unreviewed merges whose changed paths no test touched", () => {
    const evidence = Array.from({ length: N }, () =>
      merge({ reviewedBy: null, ciCoveredChangedPaths: false }),
    );
    const d = evaluatePromotion(AGENT, 1 as Tier, evidence, N);
    expect(d.changed).toBe(false);
    for (const c of d.decisions) {
      expect(c.reason).toMatch(/unreviewed and untested/);
    }
  });

  it("promotes when CI exercised the changed paths, citing the external merger", () => {
    const evidence = Array.from({ length: N }, () =>
      merge({ reviewedBy: null, ciCoveredChangedPaths: true }),
    );
    const d = evaluatePromotion(AGENT, 1 as Tier, evidence, N);
    expect(d.changed).toBe(true);
    // AC 3: per counted merge, the receipt records WHICH positive signal.
    for (const c of d.decisions) {
      expect(c.signal).toBe("covered-ci");
      expect(c.externalPrincipal).toBe(HUMAN);
    }
  });

  it("a CI failure resets the consecutive streak; a non-creditable merge does not", () => {
    const credited = () => merge({ reviewedBy: PEER });
    // 4 credited, then a CI failure, then only 4 more: no promotion at N=5.
    const broken = [...Array.from({ length: 4 }, credited), merge({ ciGreen: false }),
      ...Array.from({ length: 4 }, credited)];
    expect(evaluatePromotion(AGENT, 1 as Tier, broken, N).changed).toBe(false);
    // A self-merged (non-creditable) merge in the middle neither counts nor
    // resets: 3 credited + absence + 2 credited still reaches 5.
    const gapped = [...Array.from({ length: 3 }, credited), merge({ mergedBy: AGENT }),
      ...Array.from({ length: 2 }, credited)];
    expect(evaluatePromotion(AGENT, 1 as Tier, gapped, N).changed).toBe(true);
  });
});

describe("#347 — a T2 agent cannot demote a peer by reverting their work", () => {
  const revert = (over: Partial<RevertEvidence>): RevertEvidence => ({
    kind: "revert",
    prNumber: 42,
    author: AGENT,
    revertedBy: PEER,
    revertedByKind: "agent",
    revertedByOverlapsPaths: true,
    ...over,
  });

  // MUTATION-SENSITIVE (#347): let any revert demote and this goes red.
  it("an overlapping-allowlist peer's revert does not demote the author", () => {
    const d = evaluateDemotion(2 as Tier, revert({}));
    expect(d.demoted).toBe(false);
    expect(d.to).toBe(2);
    expect(d.reason).toMatch(/conflict of interest/);
  });

  it("a human revert demotes, and the receipt names the reverting principal", () => {
    const d = evaluateDemotion(2 as Tier, revert({ revertedBy: HUMAN, revertedByKind: "human" }));
    expect(d.demoted).toBe(true);
    expect(d.to).toBe(1);
    expect(d.citedPrincipal).toBe(HUMAN);
  });

  it("a non-overlapping agent's revert demotes — peer reverts stay a signal", () => {
    const d = evaluateDemotion(2 as Tier, revert({ revertedByOverlapsPaths: false }));
    expect(d.demoted).toBe(true);
    expect(d.citedPrincipal).toBe(PEER);
  });

  it("a self-revert never demotes: external provenance applies downward too", () => {
    const d = evaluateDemotion(2 as Tier, revert({ revertedBy: AGENT }));
    expect(d.demoted).toBe(false);
    expect(d.reason).toMatch(/self-revert/);
  });
});

describe("external provenance, edge cases", () => {
  it("a scope violation demotes only with an external detector AND a reproducible violation", () => {
    const real = {
      allowlist: ["skills/agent-one/**"],
      touchedPaths: ["artifacts/api-server/src/lib/ledger.ts"],
    };
    const self = evaluateDemotion(1 as Tier, {
      kind: "scope-violation", principal: AGENT, detectedBy: AGENT, detail: "x", ...real,
    });
    expect(self.demoted).toBe(false);
    const ext = evaluateDemotion(1 as Tier, {
      kind: "scope-violation", principal: AGENT, detectedBy: "kax:system:scope-check",
      detail: "x", ...real,
    });
    expect(ext.demoted).toBe(true);
    expect(ext.citedPrincipal).toBe("kax:system:scope-check");
  });

  it("promotion caps at T2 and demotion floors at T0", () => {
    const evidence = Array.from({ length: N }, () => merge({ reviewedBy: PEER }));
    expect(evaluatePromotion(AGENT, 2 as Tier, evidence, N).changed).toBe(false);
    const d = evaluateDemotion(0 as Tier, {
      kind: "revert", prNumber: 1, author: AGENT,
      revertedBy: HUMAN, revertedByKind: "human", revertedByOverlapsPaths: false,
    });
    expect(d.demoted).toBe(false);
  });

  it("another agent's work never counts toward this subject's promotion", () => {
    const evidence = Array.from({ length: N }, () =>
      merge({ author: PEER, reviewedBy: HUMAN }),
    );
    const d = evaluatePromotion(AGENT, 0 as Tier, evidence, N);
    expect(d.changed).toBe(false);
    for (const c of d.decisions) expect(c.reason).toMatch(/not the subject's work/);
  });
});

describe("#356 Hunt H1 — a peer's unclean merge is an absence, not a reset", () => {
  it("a peer's red-CI merge between the subject's clean merges does not break the streak", () => {
    // Before the reorder this refused with "2 consecutive creditable merges":
    // the peer's failure reset the SUBJECT's streak, handing any agent a
    // denial-of-promotion attack — land failing work of your own, wipe every
    // peer's counter. The subject's five merges here are clean, reviewed, and
    // externally merged; the only blemish in the stream belongs to the peer.
    const evidence = [
      merge({ prNumber: 1, reviewedBy: PEER }),
      merge({ prNumber: 2, reviewedBy: PEER }),
      merge({ prNumber: 3, reviewedBy: PEER }),
      merge({ prNumber: 99, author: PEER, mergedBy: PEER, reviewedBy: null, ciGreen: false }),
      merge({ prNumber: 4, reviewedBy: PEER }),
      merge({ prNumber: 5, reviewedBy: PEER }),
    ];
    const d = evaluatePromotion(AGENT, 0 as Tier, evidence, 5);
    expect(d.changed).toBe(true);
    expect(d.decisions.find((c) => c.prNumber === 99)?.resetStreak).toBe(false);
    expect(d.decisions.find((c) => c.prNumber === 99)?.reason).toMatch(/not the subject's work/);
  });

  it("the subject's OWN red-CI merge still resets — the reorder must not weaken the real reset", () => {
    const evidence = [
      merge({ prNumber: 1, reviewedBy: PEER }),
      merge({ prNumber: 2, reviewedBy: PEER }),
      merge({ prNumber: 3, reviewedBy: PEER }),
      merge({ prNumber: 4, ciGreen: false, reviewedBy: PEER }),
      merge({ prNumber: 5, reviewedBy: PEER }),
      merge({ prNumber: 6, reviewedBy: PEER }),
    ];
    const d = evaluatePromotion(AGENT, 0 as Tier, evidence, 5);
    expect(d.changed).toBe(false);
    expect(d.decisions.find((c) => c.prNumber === 4)?.resetStreak).toBe(true);
  });
});

describe("#356 Hunt H2 — a violation is recomputed, never taken on assertion", () => {
  const base = {
    kind: "scope-violation" as const,
    principal: AGENT,
    detectedBy: PEER,
    detail: "asserted by a peer",
  };

  it("a fabricated report is inert: every touched path is inside the allowlist", () => {
    // Before recomputation this demoted — the agent the revert door had just
    // disarmed (#347) walked in through the assertion door. Now the facts
    // decide: nothing out of scope, nobody demoted, whoever asserted it.
    const d = evaluateDemotion(2 as Tier, {
      ...base,
      allowlist: ["skills/agent-one/**", "sandbox/**"],
      touchedPaths: ["skills/agent-one/SKILL.md", "sandbox/notes.txt"],
    });
    expect(d.demoted).toBe(false);
    expect(d.reason).toMatch(/not reproducible/);
  });

  it("a report with no touched paths verifies nothing and demotes nobody", () => {
    const d = evaluateDemotion(2 as Tier, { ...base, allowlist: ["**"], touchedPaths: [] });
    expect(d.demoted).toBe(false);
    expect(d.reason).toMatch(/no touched paths/);
  });

  it("a real violation still demotes, and the receipt names the offending path", () => {
    const d = evaluateDemotion(2 as Tier, {
      ...base,
      detectedBy: "kax:system:scope-check",
      allowlist: ["skills/agent-one/**"],
      touchedPaths: ["skills/agent-one/SKILL.md", "artifacts/api-server/src/lib/ledger.ts"],
    });
    expect(d.demoted).toBe(true);
    expect(d.reason).toMatch(/verified by recomputation/);
    expect(d.reason).toContain("artifacts/api-server/src/lib/ledger.ts");
  });

  it("glob semantics: ** crosses directories, * does not", () => {
    expect(pathMatchesGlob("a/b/c.ts", "a/**")).toBe(true);
    expect(pathMatchesGlob("a/b/c.ts", "a/*")).toBe(false);
    expect(pathMatchesGlob("a/b.ts", "a/*")).toBe(true);
    expect(pathMatchesGlob("xa/b.ts", "a/**")).toBe(false);
    // regex metacharacters in paths are literal, not operators
    expect(pathMatchesGlob("a/b+c.ts", "a/b+c.ts")).toBe(true);
    expect(pathMatchesGlob("a/bbc.ts", "a/b+c.ts")).toBe(false);
  });
});

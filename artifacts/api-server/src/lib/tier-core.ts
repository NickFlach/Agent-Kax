/**
 * Pure, DB-free core of the ADR-0003 D4 autonomy-tier evaluator
 * (issues #346, #347, #349). Mirrors ledger-core.ts and attribution-core.ts:
 * the security-critical invariants live here so they can be tested without a
 * database, and a persistence layer wraps them later.
 *
 * The one rule this module enforces, from D4 as amended:
 *
 *   Every tier change — up or down — must cite a positive signal originating
 *   from a principal other than the agent whose tier is changing, and the
 *   evaluator records which principal and which signal it counted. A tier
 *   change that cannot name an external principal does not happen; it fails
 *   closed.
 *
 * The rule exists because three review findings against the D4 draft were the
 * same error — a counter over absences read as evidence of a property:
 *
 *   #346  merges the agent produced itself counted toward its own promotion
 *   #349  the absence of a revert nobody was looking to file counted as clean
 *   #347  a revert with no named reverter demoted whoever it landed on
 *
 * Concretely, per the amended doctrine: self-merged work does not credit
 * toward promotion; an unreviewed AND untested merge does not credit; and a
 * revert demotes its author only when the reverting principal is not itself
 * an agent whose allowlist overlaps the reverted paths.
 *
 * Everything here returns a RECEIPT naming which evidence was counted, which
 * was refused, and why — so a later reader can tell a real tier change from
 * an accumulated one, which is #346's third acceptance criterion and the
 * property the whole rule protects.
 */

/** The autonomy dial. T0 propose · T1 own space · T2 shared space. */
export type Tier = 0 | 1 | 2;

export const MAX_TIER: Tier = 2;
export const MIN_TIER: Tier = 0;

/** One merged PR, as the promotion evaluator receives it. */
export interface MergeEvidence {
  kind: "merge";
  prNumber: number;
  /** Principal whose work was merged — the promotion subject's own acts. */
  author: string;
  /** Principal that performed the merge. */
  mergedBy: string;
  /** Approving reviewer, if the merge was actually reviewed. Null if unread. */
  reviewedBy: string | null;
  /** CI conclusion on the merge commit. */
  ciGreen: boolean;
  /** Did CI run at least one test touching the changed paths? (#349) */
  ciCoveredChangedPaths: boolean;
  /** Was the merge within the agent's granted scope? */
  withinScope: boolean;
  /** Was this merge later reverted? */
  reverted: boolean;
}

/** One revert, as the demotion evaluator receives it. */
export interface RevertEvidence {
  kind: "revert";
  /** The PR whose work was reverted. */
  prNumber: number;
  /** Author of the reverted work — the demotion subject. */
  author: string;
  /** Principal that performed the revert. */
  revertedBy: string;
  /**
   * MUST be derived by the wrapper from the principal grammar
   * (`kax:user:` vs `kax:agent:`), never accepted from the reporting party —
   * a caller-asserted kind is H2 in miniature.
   */
  revertedByKind: "human" | "agent";
  /**
   * When the reverter is an agent: does its path allowlist overlap the
   * reverted paths? An overlapping-allowlist agent has a standing conflict of
   * interest — its revert is still valid as code, but it must not carry
   * demotion authority over a peer (#347).
   */
  revertedByOverlapsPaths: boolean;
}

/**
 * A scope violation, MACHINE-CHECKED rather than reported (#356 hunt pass,
 * H2). The evidence carries the grant's path allowlist and the paths the act
 * touched, and the evaluator recomputes the violation itself — so
 * `detectedBy` is provenance for the receipt, never the authority for the
 * demotion. A false report from any principal is structurally inert: if the
 * touched paths all match the allowlist, no demotion happens no matter who
 * asserts otherwise. The earlier shape trusted the reporter's word, which
 * handed the agent the revert door had just disarmed a second door that
 * accepted assertions.
 */
export interface ScopeViolationEvidence {
  kind: "scope-violation";
  /** The violating principal — the demotion subject. */
  principal: string;
  /** The principal that filed the evidence. Recorded, not trusted. */
  detectedBy: string;
  /** The grant's path allowlist (globs: `*` in-segment, `**` any depth). */
  allowedPaths: string[];
  /** The paths the act actually touched. */
  touchedPaths: string[];
  detail: string;
}

/** Minimal glob for path allowlists: `*` within a segment, `**` any depth. */
function globToRegExp(glob: string): RegExp {
  const DOUBLE_STAR = "\u0000"; // placeholder no real path glob contains
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .split("**").join(DOUBLE_STAR)
    .split("*").join("[^/]*")
    .split(DOUBLE_STAR).join(".*");
  return new RegExp("^" + escaped + "$");
}

/** The paths in `touched` that no allowlist glob matches. */
export function offendingPaths(allowed: string[], touched: string[]): string[] {
  const patterns = allowed.map(globToRegExp);
  return touched.filter((p) => !patterns.some((re) => re.test(p)));
}

/** Why one piece of evidence was counted or refused. Every decision is kept. */
export interface CreditDecision {
  prNumber: number;
  credited: boolean;
  /** Human-readable reason, stable enough to grep in an audit. */
  reason: string;
  /** The non-subject principal this credit cites. Null iff not credited. */
  externalPrincipal: string | null;
  /** Which positive signal was counted. Null iff not credited. */
  signal: "reviewed" | "covered-ci" | null;
  /** True when this evidence also reset the consecutive-clean streak. */
  resetStreak: boolean;
}

/** The receipt a tier change must produce — or the refusal to change. */
export interface TierDecision {
  subject: string;
  changed: boolean;
  from: Tier;
  to: Tier;
  /** Every piece of evidence considered, in order, counted or refused. */
  decisions: CreditDecision[];
  /** External principals whose signals the change cites. Empty iff !changed. */
  citedPrincipals: string[];
  reason: string;
}

/**
 * Promotion: N consecutive creditable merges, evaluated oldest-first.
 *
 * What CREDITS (all four required):
 *   - within scope, CI green, never reverted
 *   - merged by a principal other than the subject (#346: self-merged work
 *     does not credit — an agent must not manufacture its own record)
 *   - carries a positive external signal (#349): an actual review by a
 *     non-subject principal, or CI that exercised the changed paths. A merge
 *     nobody read and no test touched is an absence, not evidence.
 *
 * What RESETS the consecutive streak: a CI failure or a reverted merge —
 * evidence of unclean work. A merely non-creditable merge (self-merged, or
 * unread-and-uncovered) neither counts nor resets: it is an absence of
 * evidence, and absences carry no weight in either direction. That asymmetry
 * is deliberate and is the module's whole reason to exist.
 *
 * Out-of-scope merges are refused here and NOT treated as violations — scope
 * violations demote through evaluateDemotion with a named detector, never as
 * a side effect of counting.
 */
export function evaluatePromotion(
  subject: string,
  currentTier: Tier,
  evidence: MergeEvidence[],
  n: number,
): TierDecision {
  const decisions: CreditDecision[] = [];
  let streak: CreditDecision[] = [];

  for (const e of evidence) {
    const d = judgeMerge(subject, e);
    decisions.push(d);
    if (d.resetStreak) {
      streak = [];
    } else if (d.credited) {
      streak.push(d);
    }
  }

  const refusal = (reason: string): TierDecision => ({
    subject,
    changed: false,
    from: currentTier,
    to: currentTier,
    decisions,
    citedPrincipals: [],
    reason,
  });

  if (currentTier >= MAX_TIER) return refusal(`already at T${MAX_TIER}`);
  if (streak.length < n) {
    return refusal(`${streak.length} consecutive creditable merges, ${n} required`);
  }

  // Fail closed: a promotion that cannot name an external principal for every
  // counted merge does not happen. By construction judgeMerge never credits
  // without one, but the guard is the property, not the construction.
  const window = streak.slice(-n);
  const cited = window.map((d) => d.externalPrincipal);
  if (cited.some((p) => p === null || p === subject)) {
    return refusal("credited evidence lacks an external principal; failing closed");
  }

  return {
    subject,
    changed: true,
    from: currentTier,
    to: (currentTier + 1) as Tier,
    decisions,
    citedPrincipals: [...new Set(cited as string[])],
    reason: `${n} consecutive creditable merges, each citing an external principal`,
  };
}

function judgeMerge(subject: string, e: MergeEvidence): CreditDecision {
  const no = (reason: string, resetStreak = false): CreditDecision => ({
    prNumber: e.prNumber,
    credited: false,
    reason,
    externalPrincipal: null,
    signal: null,
    resetStreak,
  });

  // H1 (#356 hunt pass): another principal's work is judged FIRST, before any
  // streak-reset check. A peer's red-CI merge is not evidence about this
  // subject — it is absence, and absences carry no weight in either
  // direction. Checked in the old order, a repo-wide evidence feed let any
  // agent reset every peer's streak by landing failing work of its own: a
  // denial-of-promotion attack, #347's shape through the other counter.
  if (e.author !== subject) return no("not the subject's work");
  if (!e.ciGreen) return no("CI failed on the merge commit", true);
  if (e.reverted) return no("merge was reverted", true);
  if (!e.withinScope) return no("outside the agent's granted scope");
  if (e.mergedBy === subject) {
    return no("self-merged: an agent must not manufacture its own record (#346)");
  }

  // Positive external signal (#349): a real review by someone other than the
  // subject beats coverage, because a reader saw the change; coverage is the
  // fallback signal, cited to the (external) merger who relied on it.
  if (e.reviewedBy !== null && e.reviewedBy !== subject) {
    return {
      prNumber: e.prNumber,
      credited: true,
      reason: "reviewed by an external principal",
      externalPrincipal: e.reviewedBy,
      signal: "reviewed",
      resetStreak: false,
    };
  }
  if (e.ciCoveredChangedPaths) {
    return {
      prNumber: e.prNumber,
      credited: true,
      reason: "CI exercised the changed paths; merged by an external principal",
      externalPrincipal: e.mergedBy,
      signal: "covered-ci",
      resetStreak: false,
    };
  }
  return no("unreviewed and untested: absence of a revert is not evidence (#349)");
}

/** The receipt a demotion produces — or the refusal, with the reason kept. */
export interface DemotionDecision {
  subject: string;
  demoted: boolean;
  from: Tier;
  to: Tier;
  /** The external principal whose signal the demotion cites. Null iff !demoted. */
  citedPrincipal: string | null;
  reason: string;
}

/**
 * Demotion: immediate on a qualifying revert or a detected scope violation —
 * but "qualifying" is where #347 lives:
 *
 *   - a HUMAN revert demotes the author it reverted;
 *   - an AGENT revert demotes only when the reverting agent's allowlist does
 *     NOT overlap the reverted paths — an overlapping agent holds a standing
 *     conflict of interest at T2, where one revert commit would otherwise be
 *     a veto over every peer;
 *   - a SELF revert never demotes: the external-provenance rule applies down
 *     as well as up, and a self-report is not an external signal;
 *   - a scope violation demotes only when its detector is a principal other
 *     than the subject, for the same reason.
 */
export function evaluateDemotion(
  currentTier: Tier,
  evidence: RevertEvidence | ScopeViolationEvidence,
): DemotionDecision {
  const subject = evidence.kind === "revert" ? evidence.author : evidence.principal;
  const refusal = (reason: string): DemotionDecision => ({
    subject,
    demoted: false,
    from: currentTier,
    to: currentTier,
    citedPrincipal: null,
    reason,
  });

  if (currentTier <= MIN_TIER) return refusal(`already at T${MIN_TIER}`);

  if (evidence.kind === "scope-violation") {
    if (evidence.detectedBy === subject) {
      return refusal("scope violation self-reported; an external detector is required");
    }
    // The evaluator recomputes the violation from the evidence. The report is
    // never the authority — an assertion whose paths all match the allowlist
    // demotes nobody, whoever filed it.
    const offending = offendingPaths(evidence.allowedPaths, evidence.touchedPaths);
    if (offending.length === 0) {
      return refusal(
        "no violation recomputable from the evidence: every touched path " +
          "matches the allowlist; the report is inert",
      );
    }
    return {
      subject,
      demoted: true,
      from: currentTier,
      to: (currentTier - 1) as Tier,
      citedPrincipal: evidence.detectedBy,
      reason:
        `scope violation recomputed from evidence filed by ${evidence.detectedBy}: ` +
        `${offending.join(", ")} outside the allowlist (${evidence.detail})`,
    };
  }

  if (evidence.revertedBy === subject) {
    return refusal("self-revert carries no demotion authority");
  }
  if (evidence.revertedByKind === "agent" && evidence.revertedByOverlapsPaths) {
    return refusal(
      "reverting agent's allowlist overlaps the reverted paths: " +
        "conflict of interest, no demotion authority (#347)",
    );
  }
  return {
    subject,
    demoted: true,
    from: currentTier,
    to: (currentTier - 1) as Tier,
    citedPrincipal: evidence.revertedBy,
    reason: `work on PR #${evidence.prNumber} reverted by ${evidence.revertedBy}`,
  };
}

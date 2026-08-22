/**
 * executor-core.mjs — pure decisions for the write-code executor (ADR-0003
 * v0.1, issue #402).
 *
 * The machinery around autonomous work shipped first: the commitment funnel
 * (commitments.mjs), the signed action record (attribution-core.ts), tiers,
 * credit. This module is the missing centre — everything the executor must
 * DECIDE, kept pure and tested, with the git/network wiring living in
 * scripts/write-code-executor.mjs.
 *
 * Four decisions live here:
 *
 *   NOTICE    Did a spoken line ask this agent for code work? Deterministic,
 *             like the meet parser and for the same reason: a model that
 *             hallucinates a TASK writes code nobody asked for, confidently.
 *   SCOPE     Is the repo inside the agent's allowlist? Checked from the
 *             grant, never from what the agent believes about itself; a
 *             violation is REFUSED OUT LOUD (D8), not failed silently.
 *   BUDGET    Actions per rolling window and a wall-clock ceiling per action
 *             (D7). Exhaustion is spoken, not swallowed.
 *   CADENCE   Revocation must be re-checked at most 60s apart during any
 *             stage (D6 as amended) — expressed as a pure "is a check due"
 *             so the bound is testable rather than aspirational.
 *
 * Attribution (canonical payload, hashing, Ed25519 signing, trailers) also
 * lives here, mirroring artifacts/api-server/src/lib/attribution-core.ts
 * BYTE-FOR-BYTE. That duplication is deliberate and guarded: the daemon runs
 * plain node and cannot import the TS core, so the test suite imports BOTH
 * and proves this module's chains and trailers verify through the TS
 * verifiers. If the formats ever drift, the cross-impl test is the tripwire.
 */

import crypto from "node:crypto";

/** Same genesis as the TS core — the chains must be mutually verifiable. */
export const ACTION_GENESIS_HASH = "GENESIS::action-record::v1";

/** D6 as amended in #350: never more than this between revocation checks. */
export const REVOCATION_CHECK_MS = 60_000;

/** D7 defaults — generous, per the ADR: policy should not be the limiter. */
export const DEFAULT_ACTIONS_PER_WINDOW = 6;
export const DEFAULT_WINDOW_MS = 60 * 60_000;
export const DEFAULT_WALL_CLOCK_CEILING_MS = 20 * 60_000;

/** The ordered stages of one write-code action. Report happens throughout. */
export const STAGES = ["worktree", "edit", "test", "commit", "push", "pr"];

// ---------------------------------------------------------------------------
// NOTICE — from a spoken line to a write-code proposal.
// ---------------------------------------------------------------------------

const WORK_INTENT =
  /\b(fix|update|correct|patch|refactor|rename|remove|add|write|implement|document)\b/i;

/**
 * Did this line ask THIS agent for code work in a repo it may touch?
 *
 * Deliberately narrow, like the meet parser: it requires the agent to be
 * addressed by name, a work verb, and an explicit repo reference in the form
 * `in <owner>/<repo>` — either alone is ordinary conversation. "The README is
 * stale" grumbles; "0xSCADA-QE, fix the README in flaukowski/sandbox" asks.
 */
export function parseWorkAsk({ text, from, youName, now = Date.now() } = {}) {
  const line = String(text ?? "");
  if (!line || !from || !youName || from === youName) return null;
  const addressed = new RegExp(`\\b${youName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  if (!addressed.test(line)) return null;
  if (!WORK_INTENT.test(line)) return null;
  const repo = /\bin\s+([\w.-]+\/[\w.-]+)\b/.exec(line);
  if (!repo) return null;
  return {
    kind: "write-code",
    repo: repo[1],
    task: line,
    from,
    at: now, // code work starts when agreed; there is no "meet me at nine" here
    text: line,
  };
}

/**
 * Which file does a v0.1 task touch? Single-file edits only, deliberately:
 * the edit is produced by the agent's one-shot mind, and one named file is
 * the scope where that is honest. A path spoken in the task wins; the README
 * is the default because the demo task is documentation.
 *
 * SECURITY: the returned path is a REPO-RELATIVE path that the executor joins
 * onto the clone dir and both READS and WRITES. A spoken sentence is
 * attacker-controlled, so a path that escapes the clone would read a host
 * file (into a prompt on the bus) and overwrite it. `isContainedRelPath`
 * rejects anything absolute, drive-qualified, or containing a `..` segment;
 * a candidate that fails it is ignored (not defaulted-around — a named path
 * that is hostile is a refusal, so the executor declines rather than silently
 * editing the README instead). Returns null for an empty task OR a task whose
 * only named path is an escape attempt.
 */
export function isContainedRelPath(p) {
  const s = String(p ?? "").replace(/\\/g, "/");
  if (!s || s.startsWith("/") || /^[a-zA-Z]:/.test(s)) return false; // absolute / drive
  if (s.split("/").some((seg) => seg === ".." )) return false; // traversal
  if (/\0/.test(s)) return false;
  return true;
}

export function fileFor(task) {
  const t = String(task ?? "");
  if (!t.trim()) return null;
  const named = /\b([\w][\w./-]*\.(?:md|txt|json|yml|yaml|js|mjs|ts|tsx|rs|py|toml))\b/i.exec(t);
  if (named) {
    // A named path that escapes the clone is hostile, not a typo — refuse the
    // whole task rather than quietly retargeting it at the README.
    return isContainedRelPath(named[1]) ? named[1] : null;
  }
  if (/\breadme\b/i.test(t)) return "README.md";
  return "README.md";
}

// ---------------------------------------------------------------------------
// SCOPE — the grant decides, not the agent.
// ---------------------------------------------------------------------------

/**
 * v0.1 grant shape: a repo allowlist plus the branch prefix the agent may
 * create. Grants arrive from configuration (server-side records are v0.2 —
 * #403); an empty allowlist means the agent holds no write-code capability,
 * which is the ADR's default of zero.
 */
export function scopeCheck(commitment, grant = {}) {
  const allow = grant.repos ?? [];
  if (allow.length === 0) {
    return { ok: false, reason: "I hold no write-code grant, so I must decline." };
  }
  if (!allow.includes(commitment.repo)) {
    return {
      ok: false,
      reason: `${commitment.repo} is outside my grant (I may touch: ${allow.join(", ")}).`,
    };
  }
  return { ok: true };
}

/** The branch a commitment works on: prefix from the grant, id for identity. */
export function branchName(commitment, grant = {}) {
  const prefix = grant.branchPrefix ?? "agent/unnamed";
  const slug = String(commitment.id ?? "c").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 24);
  return `${prefix}/${slug}`;
}

// ---------------------------------------------------------------------------
// BUDGET — D7.
// ---------------------------------------------------------------------------

/**
 * May another action start now? `history` is the start-times of previous
 * actions. Exhaustion returns the line to SAY — the caller must not invent a
 * quieter failure.
 */
export function budgetGate(history = [], now = Date.now(), limits = {}) {
  const perWindow = limits.actionsPerWindow ?? DEFAULT_ACTIONS_PER_WINDOW;
  const windowMs = limits.windowMs ?? DEFAULT_WINDOW_MS;
  const recent = history.filter((t) => now - t < windowMs);
  if (recent.length >= perWindow) {
    const retryMin = Math.ceil((windowMs - (now - Math.min(...recent))) / 60_000);
    return {
      ok: false,
      say: `My action budget for this window is spent — I can take this up in about ${retryMin} minutes.`,
    };
  }
  return { ok: true };
}

/** Has this action outlived its wall-clock ceiling? */
export function overCeiling(startedAt, now = Date.now(), limits = {}) {
  const ceiling = limits.wallClockCeilingMs ?? DEFAULT_WALL_CLOCK_CEILING_MS;
  return now - startedAt >= ceiling;
}

// ---------------------------------------------------------------------------
// CADENCE — D6.
// ---------------------------------------------------------------------------

/** Is a revocation re-check due? True at start (never checked) and every 60s. */
export function revocationCheckDue(lastCheckedAt, now = Date.now()) {
  if (!lastCheckedAt) return true;
  return now - lastCheckedAt >= REVOCATION_CHECK_MS;
}

// ---------------------------------------------------------------------------
// D8 — failure must be spoken. One composer so no caller invents silence.
// ---------------------------------------------------------------------------

export function failureLine(stage, reason) {
  const why = String(reason ?? "").slice(0, 160);
  return `I could not finish the code work I agreed to — ${stage} failed: ${why}`;
}

// ---------------------------------------------------------------------------
// Attribution — mirrors attribution-core.ts; cross-verified in tests.
// ---------------------------------------------------------------------------

function canonical(prevHash, seq, e) {
  return JSON.stringify([
    prevHash,
    seq,
    e.commitmentId,
    e.principal,
    e.kind,
    e.commitSha,
    e.ref ?? null,
  ]);
}

export function computeActionHash(prevHash, seq, e) {
  return crypto.createHash("sha256").update(canonical(prevHash, seq, e)).digest("hex");
}

export function signingPayload(prevHash, seq, e) {
  return Buffer.from(canonical(prevHash, seq, e), "utf8");
}

/**
 * Build the next signed row for the write-ahead record. The caller MUST
 * persist this before the act it describes (D5): recorded-then-acted means a
 * crash yields a recorded non-action (harmless, idempotency key skips it);
 * acted-then-recorded means a crash yields an unrecorded action — the silent
 * failure D8 forbids.
 */
export function buildSignedAction(headHash, seq, e, privateKey) {
  const entryHash = computeActionHash(headHash, seq, e);
  const signature = crypto.sign(null, signingPayload(headHash, seq, e), privateKey).toString("base64");
  return { ...e, seq, prevHash: headHash, entryHash, signature };
}

/** The commit trailer block (D5) — same three keys the TS parser requires. */
export function formatCommitTrailers({ commitmentId, principal, signature }) {
  return [
    `KAX-Commitment: ${commitmentId}`,
    `KAX-Principal: ${principal}`,
    `KAX-Signature: ${signature}`,
  ].join("\n");
}

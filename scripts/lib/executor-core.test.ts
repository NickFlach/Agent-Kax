/**
 * executor-core.test.ts — the decisions that make autonomous code work safe
 * to grant (ADR-0003 v0.1, #402).
 *
 * The refusals matter more than the acceptances, as everywhere in this
 * system: a hallucinated task writes code nobody asked for, an out-of-scope
 * repo is a grant violation, and a silent budget failure is the exact
 * failure mode D8 exists to forbid.
 *
 * The attribution block at the bottom is the tripwire for a deliberate
 * duplication: executor-core.mjs mirrors attribution-core.ts because plain
 * node cannot import the TS core. These tests build chains and trailers with
 * the MJS side and verify them with the TS side — if the canonical formats
 * ever drift, this file goes red before any record lies.
 */

import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import {
  parseWorkAsk,
  fileFor,
  scopeCheck,
  branchName,
  budgetGate,
  overCeiling,
  revocationCheckDue,
  failureLine,
  buildSignedAction,
  formatCommitTrailers,
  computeActionHash,
  ACTION_GENESIS_HASH,
  REVOCATION_CHECK_MS,
} from "./executor-core.mjs";
import {
  verifyActionChain,
  verifyActionAttribution,
  parseTrailers,
  ACTION_GENESIS_HASH as TS_GENESIS,
} from "../../artifacts/api-server/src/lib/attribution-core";

const you = "0xSCADA-QE";

describe("parseWorkAsk (notice)", () => {
  it("hears an addressed work ask naming a repo", () => {
    const p = parseWorkAsk({
      text: "0xSCADA-QE, the README install section is stale — fix it in flaukowski/sandbox?",
      from: "Nick",
      youName: you,
    });
    expect(p?.kind).toBe("write-code");
    expect(p?.repo).toBe("flaukowski/sandbox");
  });

  it("ignores work talk that does not address the agent", () => {
    expect(parseWorkAsk({ text: "somebody should fix the README in a/b", from: "Nick", youName: you })).toBeNull();
  });

  it("ignores an address with no repo, and a repo with no work verb", () => {
    expect(parseWorkAsk({ text: "0xSCADA-QE, fix the README?", from: "Nick", youName: you })).toBeNull();
    expect(parseWorkAsk({ text: "0xSCADA-QE, I like a/b", from: "Nick", youName: you })).toBeNull();
  });

  it("never hears itself", () => {
    expect(parseWorkAsk({ text: `${you}, fix it in a/b`, from: you, youName: you })).toBeNull();
  });
});

describe("fileFor (single-file scope, v0.1)", () => {
  it("a path spoken in the task wins", () => {
    expect(fileFor("fix the typo in docs/setup.md please")).toBe("docs/setup.md");
  });
  it("README talk and everything else defaults to README.md", () => {
    expect(fileFor("the readme install section is stale")).toBe("README.md");
    expect(fileFor("tidy the install instructions")).toBe("README.md");
  });
  it("an empty task names nothing", () => {
    expect(fileFor("  ")).toBeNull();
  });
});

describe("scopeCheck (the grant decides)", () => {
  const c = { repo: "flaukowski/sandbox" };

  it("zero grants means decline, out loud", () => {
    const r = scopeCheck(c, {});
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("no write-code grant");
  });

  it("an out-of-allowlist repo is refused naming the allowed set", () => {
    const r = scopeCheck(c, { repos: ["other/repo"] });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("other/repo");
  });

  it("an allowlisted repo passes", () => {
    expect(scopeCheck(c, { repos: ["flaukowski/sandbox"] }).ok).toBe(true);
  });

  it("branch names carry the grant prefix and the commitment id", () => {
    const b = branchName({ id: "cmt-123" }, { branchPrefix: "agent/scada" });
    expect(b).toBe("agent/scada/cmt-123");
  });
});

describe("budgetGate and ceiling (D7)", () => {
  it("allows within the window and refuses beyond it, speaking the refusal", () => {
    const now = 1_000_000_000;
    const limits = { actionsPerWindow: 2, windowMs: 60_000 };
    expect(budgetGate([now - 10_000], now, limits).ok).toBe(true);
    const refused = budgetGate([now - 10_000, now - 5_000], now, limits);
    expect(refused.ok).toBe(false);
    expect(refused.say).toContain("budget");
  });

  it("forgets actions older than the window", () => {
    const now = 1_000_000_000;
    const limits = { actionsPerWindow: 1, windowMs: 60_000 };
    expect(budgetGate([now - 61_000], now, limits).ok).toBe(true);
  });

  it("knows when an action outlives its ceiling", () => {
    const now = 1_000_000_000;
    expect(overCeiling(now - 1, now, { wallClockCeilingMs: 1_000 })).toBe(false);
    expect(overCeiling(now - 1_001, now, { wallClockCeilingMs: 1_000 })).toBe(true);
  });
});

describe("revocation cadence (D6, testable bound)", () => {
  it("is due immediately, not due within 60s, due at 60s", () => {
    const now = 1_000_000_000;
    expect(revocationCheckDue(null, now)).toBe(true);
    expect(revocationCheckDue(now - REVOCATION_CHECK_MS + 1, now)).toBe(false);
    expect(revocationCheckDue(now - REVOCATION_CHECK_MS, now)).toBe(true);
  });
});

describe("failure is spoken (D8)", () => {
  it("names the stage and the reason", () => {
    const line = failureLine("push", "remote rejected: token expired");
    expect(line).toContain("push");
    expect(line).toContain("token expired");
  });
});

describe("cross-impl attribution: MJS writer, TS verifier", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const principal = "kax:agent:00000000-0000-4000-8000-000000000042";

  it("shares the genesis constant", () => {
    expect(ACTION_GENESIS_HASH).toBe(TS_GENESIS);
  });

  it("a chain built by the MJS side passes both TS verifiers", () => {
    const e1 = { commitmentId: "cmt-1", principal, kind: "write-code", commitSha: "abc123", ref: "flaukowski/sandbox" };
    const r1 = buildSignedAction(ACTION_GENESIS_HASH, 1, e1, privateKey);
    const e2 = { commitmentId: "cmt-2", principal, kind: "write-code", commitSha: null, ref: null };
    const r2 = buildSignedAction(r1.entryHash, 2, e2, privateKey);

    expect(() => verifyActionChain([r1, r2])).not.toThrow();
    const keys = new Map([[principal, publicKey]]);
    expect(() => verifyActionAttribution([r1, r2], keys)).not.toThrow();
  });

  it("a tampered principal fails TS attribution even though the chain reseals", () => {
    const e = { commitmentId: "cmt-1", principal, kind: "write-code", commitSha: "abc", ref: null };
    const r = buildSignedAction(ACTION_GENESIS_HASH, 1, e, privateKey);
    const liar = "kax:agent:00000000-0000-4000-8000-00000000dead";
    // Rebuild the chain naming a different actor but keeping the old
    // signature — resealed, so the chain half passes and only attribution
    // can catch the lie.
    const forged = {
      ...r,
      principal: liar,
      entryHash: computeActionHash(ACTION_GENESIS_HASH, 1, { ...e, principal: liar }),
    };
    expect(() => verifyActionChain([forged])).not.toThrow();
    const keys = new Map([
      [principal, publicKey],
      [liar, publicKey],
    ]);
    expect(() => verifyActionAttribution([forged], keys)).toThrow(/signature does not verify/);
  });

  it("MJS trailers parse through the TS parser, and the demo acceptance holds", () => {
    const e = { commitmentId: "cmt-9", principal, kind: "write-code", commitSha: null, ref: null };
    const row = buildSignedAction(ACTION_GENESIS_HASH, 1, e, privateKey);
    const block = formatCommitTrailers({
      commitmentId: row.commitmentId,
      principal: row.principal,
      signature: row.signature,
    });
    const message = `Fix the stale install section\n\nBody text.\n\n${block}\nCo-Authored-By: QE <agent@kax.ninja-portal.com>`;
    const parsed = parseTrailers(message);
    expect(parsed).not.toBeNull();
    expect(parsed!.principal).toBe(principal);
    expect(parsed!.commitmentId).toBe("cmt-9");
    expect(parsed!.signature).toBe(row.signature);
  });
});

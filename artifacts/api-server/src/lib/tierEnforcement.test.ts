/**
 * tierEnforcement.test.ts — the tier-promotion wrapper (#403, D4/D5).
 *
 * DB-backed. The properties that matter: N clean externally-cited merges
 * promote and the change lands in the signed action chain with a verifiable
 * signature; self-merged / unread work does NOT promote; and a missing
 * authority key fails closed (no tier change at all).
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { verifyActionChain, verifyActionAttribution } from "./attribution-core";
import type { SignedActionRow } from "./attribution-core";

// A stable authority keypair for the run; the wrapper reads the PEM from env.
const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");

// A distinct UUID namespace from capabilityGrants.test.ts — CI runs both
// against one shared DB, so a colliding principal would let this suite's grant
// rows fail the other's fail-closed assertions.
let seq = 0;
const agent = () => `kax:agent:7e100000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

async function seedGrant(principal: string, tier = 0) {
  const { setGrant } = await import("./capabilityGrants");
  await setGrant({ principal, kind: "write-code", repos: ["flaukowski/sandbox"], tier, updatedBy: "user:nick" });
}

describe("tier enforcement (#403)", () => {
  beforeEach(async () => {
    process.env.KAX_TIER_AUTHORITY_KEY = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    process.env.KAX_PROMOTE_N_T0 = "3"; // small N for the test
    seq += 100;
    await db.execute(sql`DELETE FROM signed_action_records`);
  });
  afterEach(() => {
    delete process.env.KAX_TIER_AUTHORITY_KEY;
    delete process.env.KAX_PROMOTE_N_T0;
  });

  async function merge(subject: string, pr: number) {
    const { recordMergeEvidence } = await import("./tierEnforcement");
    await recordMergeEvidence({
      subject, prNumber: pr, repo: "flaukowski/sandbox",
      mergedBy: "kax:user:nick", // a human other than the subject
      reviewedBy: "kax:user:nick",
      ciGreen: true, ciCoveredChangedPaths: true, withinScope: true,
    });
  }

  it("promotes after N clean, human-merged, reviewed merges — and signs the change", async () => {
    const { evaluateAndApplyTier, TIER_AUTHORITY_PRINCIPAL } = await import("./tierEnforcement");
    const a = agent();
    await seedGrant(a, 0);
    await merge(a, 1); await merge(a, 2); await merge(a, 3);
    const r = await evaluateAndApplyTier(a);
    expect(r.changed).toBe(true);
    expect(r.to).toBe(1);
    expect(r.citedPrincipals).toContain("kax:user:nick");

    // The change is in the signed action chain and verifies.
    const rows = ((await db.execute(
      sql`SELECT seq, prev_hash AS "prevHash", entry_hash AS "entryHash", commitment_id AS "commitmentId", principal, kind, commit_sha AS "commitSha", ref, signature FROM signed_action_records ORDER BY seq`,
    )) as unknown as { rows: SignedActionRow[] }).rows;
    expect(rows.length).toBe(1);
    expect(() => verifyActionChain(rows)).not.toThrow();
    const keys = new Map([[TIER_AUTHORITY_PRINCIPAL, publicKey]]);
    expect(() => verifyActionAttribution(rows, keys)).not.toThrow();
  });

  it("does NOT promote self-merged work — an agent cannot manufacture its record", async () => {
    const { recordMergeEvidence, evaluateAndApplyTier } = await import("./tierEnforcement");
    const a = agent();
    await seedGrant(a, 0);
    for (const pr of [1, 2, 3]) {
      await recordMergeEvidence({
        subject: a, prNumber: pr, repo: "flaukowski/sandbox",
        mergedBy: a, // SELF-merged
        reviewedBy: null, ciGreen: true, ciCoveredChangedPaths: true, withinScope: true,
      });
    }
    expect((await evaluateAndApplyTier(a)).changed).toBe(false);
  });

  it("fails CLOSED with no authority key — no key, no tier change", async () => {
    const { evaluateAndApplyTier } = await import("./tierEnforcement");
    const a = agent();
    await seedGrant(a, 0);
    await merge(a, 1); await merge(a, 2); await merge(a, 3);
    delete process.env.KAX_TIER_AUTHORITY_KEY;
    const r = await evaluateAndApplyTier(a);
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("authority key");
  });

  it("derives byKind server-side: an agent revert on overlapping paths carries no demotion authority", async () => {
    const { recordMergeEvidence, evaluateAndApplyTier } = await import("./tierEnforcement");
    const a = agent();
    await seedGrant(a, 1); // start at T1 so a demotion is possible
    await recordMergeEvidence({
      subject: a, prNumber: 9, repo: "flaukowski/sandbox",
      mergedBy: "kax:user:nick", reviewedBy: "kax:user:nick",
      ciGreen: true, ciCoveredChangedPaths: true, withinScope: true,
      revertedBy: agent(), // an AGENT reverter...
      reverterAllowlist: ["src/**"], revertedPaths: ["src/x.ts"], // ...whose allowlist OVERLAPS
    });
    const r = await evaluateAndApplyTier(a);
    // Overlapping-allowlist agent revert is inert as authority (#347): no demotion.
    expect(r.changed).toBe(false);
    expect(r.to).toBe(1);
  });
});

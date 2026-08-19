/**
 * authorityPolicy.test.ts — #266's acceptance criteria.
 *
 * Pure halves (key derivation, canonical hashing) run anywhere; everything
 * else is DB-backed and runs in CI. The drop-and-repair tests restore the
 * tables through ensureCriticalSchema inside the same test, so order does
 * not poison later suites.
 */

import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { db } from "@workspace/db";
import { authorityDecisionsTable, botOccStatusTable, creditLedgerTxidsTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import {
  ADMISSION_TTL_MS,
  DEFAULT_POLICY_DOCUMENT,
  admit,
  ageingOutcomeUnknown,
  canonicalPolicyJson,
  commitReservation,
  currentPolicy,
  markOutcomeUnknown,
  markSubmitted,
  policyDocumentHash,
  policyForDecision,
  policyKeyOf,
  putPolicy,
  releaseReservation,
  windowKeyFor,
  type PolicyDocument,
} from "./authorityPolicy";
import { recordDecision } from "./authority";
import {
  LedgerAdmissionExpired,
  LedgerAdmissionMissing,
  postTransaction,
} from "./ledger";
import { ensureCriticalSchema } from "./ensureCriticalSchema";
import { checkSchema } from "./schemaSelfCheck";
import { canonicalPostingsHash, type Posting } from "./ledger-core";
import { makeBotUuid } from "../test-helpers";

const freshPrincipal = () => `kax:agent:${crypto.randomUUID()}`;

/** A policy that grants one capped capability. */
const cappedDoc = (capability: string, asset: string, capMinor: bigint): PolicyDocument => ({
  v: 1,
  grants: [{ capability, asset, window: "day", capMinor: capMinor.toString() }],
});

const admitArgs = (principal: string, amountMinor: bigint, over: Partial<Parameters<typeof admit>[0]> = {}) => {
  const postings = [
    { account: "house", amount: (-amountMinor).toString(), kind: "grant" },
    { account: `trader:${principal}`, amount: amountMinor.toString(), kind: "grant" },
  ];
  return {
    principal,
    capability: "credits.grant",
    asset: "play_credit",
    amountMinor,
    postings,
    postingsHash: crypto.createHash("sha256").update(JSON.stringify(postings)).digest("hex"),
    ...over,
  };
};

describe("the policy key (pure)", () => {
  it("collapses the obc channel-link form and refuses garbage", () => {
    const uuid = "b757bd93-6993-400b-9dd4-9d38bf257c67";
    expect(policyKeyOf(`obc:${uuid}`)).toBe(`kax:agent:${uuid}`);
    expect(policyKeyOf(`kax:agent:${uuid.toUpperCase()}`)).toBe(`kax:agent:${uuid}`);
    expect(policyKeyOf("kax:user:abc123")).toBe("kax:user:abc123");
    expect(policyKeyOf("house")).toBe(null);
    expect(policyKeyOf("")).toBe(null);
    expect(policyKeyOf("obc:not-a-uuid")).toBe(null);
  });

  it("canonicalizes documents so key order cannot change the hash", () => {
    const a = { v: 1, grants: [{ capability: "credits.grant", capMinor: "100" }] };
    const b = { grants: [{ capMinor: "100", capability: "credits.grant" }], v: 1 };
    expect(canonicalPolicyJson(a)).toBe(canonicalPolicyJson(b));
    expect(policyDocumentHash(a)).toBe(policyDocumentHash(b));
    expect(policyDocumentHash(a)).not.toBe(policyDocumentHash(DEFAULT_POLICY_DOCUMENT));
  });

  it("derives discrete UTC window keys", () => {
    const t = new Date(Date.UTC(2026, 7, 18, 23, 59));
    expect(windowKeyFor("day", t)).toBe("day:2026-08-18");
    expect(windowKeyFor("month", t)).toBe("month:2026-08");
  });
});

describe("policy storage (DB)", () => {
  it("versions by supersession and never edits — and a superseded policy still resolves by row id + hash", async () => {
    const principal = freshPrincipal();
    const v1 = await putPolicy({ principal, document: cappedDoc("credits.grant", "play_credit", 1000n), createdBy: "test:suite" });
    expect(v1.version).toBe(1);

    // A decision recorded against v1 — the historical anchor.
    const adm = await admit(admitArgs(principal, 10n));
    if (adm.decision !== "allow") throw new Error(`expected allow, got ${JSON.stringify(adm)}`);
    expect(adm.policyId).toBe(v1.id);
    expect(adm.policyDocumentHash).toBe(v1.documentHash);

    const v2 = await putPolicy({ principal, document: DEFAULT_POLICY_DOCUMENT, createdBy: "test:suite" });
    expect(v2.version).toBe(2);
    expect((await currentPolicy(principal))?.id).toBe(v2.id);

    // AC: the superseded row resolves for the historical decision.
    const resolved = await policyForDecision(adm.policyId, adm.policyDocumentHash);
    expect(resolved.id).toBe(v1.id);
    expect(resolved.supersededAt).not.toBe(null);
    await expect(policyForDecision(v1.id, v2.documentHash)).rejects.toThrow(/hash mismatch/);

    // The trigger: edits and deletes are refused; only the supersession stamp passed.
    const editErr = await db
      .execute(sql`UPDATE authority_policies SET document = '{}'::jsonb WHERE id = ${v1.id}`)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(editErr, "the immutability trigger did not reject the edit").not.toBe(null);
    const delErr = await db
      .execute(sql`DELETE FROM authority_policies WHERE id = ${v1.id}`)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(delErr, "the immutability trigger did not reject the DELETE").not.toBe(null);
    const restampErr = await db
      .execute(sql`UPDATE authority_policies SET superseded_at = now() WHERE id = ${v1.id}`)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(restampErr, "superseded_at must only be stampable once").not.toBe(null);
  });
});

describe("admission deny paths — every code distinct (DB)", () => {
  it("principal_unparseable", async () => {
    const r = await admit(admitArgs("not-a-principal" as string, 10n, { principal: "not-a-principal" }));
    expect(r).toMatchObject({ decision: "deny", reasonCode: "principal_unparseable" });
  });

  it("policy_missing", async () => {
    const r = await admit(admitArgs(freshPrincipal(), 10n));
    expect(r).toMatchObject({ decision: "deny", reasonCode: "policy_missing" });
  });

  it("revoked — before any policy is even consulted", async () => {
    const botId = makeBotUuid();
    await db.insert(botOccStatusTable).values({ obcBotId: botId, revokedAt: new Date(), revokedReason: "test" });
    try {
      const r = await admit(admitArgs(`obc:${botId}`, 10n, { principal: `obc:${botId}` }));
      expect(r).toMatchObject({ decision: "deny", reasonCode: "revoked" });
    } finally {
      await db.delete(botOccStatusTable).where(eq(botOccStatusTable.obcBotId, botId));
    }
  });

  it("capability_not_granted — the conservative default document denies everything", async () => {
    const principal = freshPrincipal();
    await putPolicy({ principal, document: DEFAULT_POLICY_DOCUMENT, createdBy: "test:suite" });
    const r = await admit(admitArgs(principal, 10n));
    expect(r).toMatchObject({ decision: "deny", reasonCode: "capability_not_granted" });
  });

  it("cap_exceeded, and each deny writes its decision row", async () => {
    const principal = freshPrincipal();
    await putPolicy({ principal, document: cappedDoc("credits.grant", "play_credit", 100n), createdBy: "test:suite" });
    const r = await admit(admitArgs(principal, 150n));
    expect(r).toMatchObject({ decision: "deny", reasonCode: "cap_exceeded" });
    if (r.decision !== "deny") throw new Error("unreachable");
    const [row] = await db
      .select()
      .from(authorityDecisionsTable)
      .where(eq(authorityDecisionsTable.decisionId, r.decisionId))
      .limit(1);
    expect(row?.decision).toBe("deny");
    expect(row?.reasonCode).toBe("cap_exceeded");
  });

  it("policy_table_unavailable is a DENY, /health/schema reports the hole, and repair closes it", async () => {
    const principal = freshPrincipal();
    await db.execute(sql`DROP TABLE authority_policies CASCADE`);
    try {
      const r = await admit(admitArgs(principal, 10n));
      expect(r).toMatchObject({ decision: "deny", reasonCode: "policy_table_unavailable" });
      const schema = await checkSchema();
      expect(schema.ok).toBe(false);
      expect(schema.missingTables).toContain("authority_policies");
    } finally {
      await ensureCriticalSchema();
    }
    expect((await checkSchema()).missingTables).not.toContain("authority_policies");
  });

  it("reservation_unavailable when the usage table is gone — never a silent uncapped allow", async () => {
    const principal = freshPrincipal();
    await putPolicy({ principal, document: cappedDoc("credits.grant", "play_credit", 100n), createdBy: "test:suite" });
    await db.execute(sql`DROP TABLE authority_usage CASCADE`);
    try {
      const r = await admit(admitArgs(principal, 10n));
      expect(r).toMatchObject({ decision: "deny", reasonCode: "reservation_unavailable" });
    } finally {
      await ensureCriticalSchema();
    }
  });
});

describe("reservations (DB)", () => {
  it("concurrent reservations against one cap do not double-spend", async () => {
    const principal = freshPrincipal();
    await putPolicy({ principal, document: cappedDoc("credits.grant", "play_credit", 100n), createdBy: "test:suite" });
    const [a, b] = await Promise.all([admit(admitArgs(principal, 60n)), admit(admitArgs(principal, 60n))]);
    const allows = [a, b].filter((r) => r.decision === "allow");
    const denies = [a, b].filter((r) => r.decision === "deny");
    expect(allows).toHaveLength(1);
    expect(denies).toHaveLength(1);
    expect(denies[0]).toMatchObject({ reasonCode: "cap_exceeded" });
  });

  it("outcome_unknown keeps consuming headroom until reconciled, and the ageing alert sees it", async () => {
    const principal = freshPrincipal();
    await putPolicy({ principal, document: cappedDoc("credits.grant", "play_credit", 100n), createdBy: "test:suite" });
    const first = await admit(admitArgs(principal, 70n));
    if (first.decision !== "allow" || !first.reservationId) throw new Error("expected a capped allow");
    await markSubmitted(first.reservationId, "tx-never-heard-back");
    await markOutcomeUnknown(first.reservationId);

    // Headroom is still pinned: 70 of 100 used, 40 more must be refused.
    const second = await admit(admitArgs(principal, 40n));
    expect(second).toMatchObject({ decision: "deny", reasonCode: "cap_exceeded" });

    // The alert: with threshold 0 the row ages immediately.
    const ageing = await ageingOutcomeUnknown(0);
    expect(ageing.map((r) => r.reservationId)).toContain(first.reservationId);

    // Reconciled as "did not happen": the headroom returns.
    await releaseReservation(first.reservationId);
    const third = await admit(admitArgs(principal, 40n));
    expect(third.decision).toBe("allow");
  });

  it("commit refuses a postings hash that differs from what was reserved", async () => {
    const principal = freshPrincipal();
    await putPolicy({ principal, document: cappedDoc("credits.grant", "play_credit", 100n), createdBy: "test:suite" });
    const adm = await admit(admitArgs(principal, 10n));
    if (adm.decision !== "allow" || !adm.reservationId) throw new Error("expected a capped allow");
    await markSubmitted(adm.reservationId, "tx-x");
    await expect(commitReservation(adm.reservationId, "someotherhash")).rejects.toThrow(/differs from what was reserved/);
    // And an illegal transition is refused outright.
    await commitReservation(adm.reservationId, admitArgs(principal, 10n).postingsHash);
    await expect(releaseReservation(adm.reservationId)).rejects.toThrow(/not a permitted transition/);
  });
});

describe("the ledger confirm read (DB)", () => {
  it("an admitted transaction links to its admission; an expired one is refused with approval_expired", async () => {
    const principal = freshPrincipal();
    await putPolicy({ principal, document: cappedDoc("credits.grant", "play_credit", 10_000_000n), createdBy: "test:suite" });

    const txId = `adm-${crypto.randomUUID()}`;
    const postings: Posting[] = [
      { account: "house", amount: -1_000_000n, kind: "grant", ref: "test:266" },
      { account: `trader:${principal}`, amount: 1_000_000n, kind: "grant", ref: "test:266" },
    ];
    const hash = canonicalPostingsHash(txId, "play_credit", postings);
    const adm = await admit(admitArgs(principal, 1_000_000n, { postingsHash: hash, txId }));
    if (adm.decision !== "allow") throw new Error(`expected allow, got ${JSON.stringify(adm)}`);
    expect(adm.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(adm.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + ADMISSION_TTL_MS + 1000);

    const posted = await postTransaction({
      txId,
      asset: "play_credit",
      postings,
      actor: principal,
      capability: "credits.grant",
      admissionDecisionId: adm.decisionId,
    });
    expect(posted.idempotentReplay).toBe(false);
    const [txids] = await db
      .select()
      .from(creditLedgerTxidsTable)
      .where(eq(creditLedgerTxidsTable.txId, txId))
      .limit(1);
    // The txids row links to the ADMISSION's decision — no second allow row.
    expect(txids?.decisionId).toBe(adm.decisionId);

    // A decision nobody recorded is admission_missing.
    await expect(
      postTransaction({
        txId: `adm-${crypto.randomUUID()}`,
        asset: "play_credit",
        postings: postings.map((p) => ({ ...p })),
        actor: principal,
        admissionDecisionId: "dec:adm:never-recorded",
      }),
    ).rejects.toThrow(LedgerAdmissionMissing);

    // An admission whose expiry passed is approval_expired — recorded through
    // the one sanctioned funnel with a past expiry, because ADMISSION_TTL_MS
    // is not something a test should wait out.
    const expiredId = `dec:adm:test-expired-${crypto.randomUUID()}`;
    const txId2 = `adm-${crypto.randomUUID()}`;
    const postings2: Posting[] = postings.map((p) => ({ ...p }));
    const hash2 = canonicalPostingsHash(txId2, "play_credit", postings2);
    await db.transaction(async (tx) => {
      await recordDecision(tx, {
        decisionId: expiredId,
        actor: principal,
        capability: "credits.grant",
        asset: "play_credit",
        decision: "allow",
        postingsHash: hash2,
        expiresAt: new Date(Date.now() - 1000),
      });
    });
    const err = await postTransaction({
      txId: txId2,
      asset: "play_credit",
      postings: postings2,
      actor: principal,
      admissionDecisionId: expiredId,
    })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LedgerAdmissionExpired);
    expect((err as LedgerAdmissionExpired).code).toBe("approval_expired");
  });
});

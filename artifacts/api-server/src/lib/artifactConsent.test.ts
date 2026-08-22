/**
 * artifactConsent.test.ts — consent gates a real-money sale, and the royalty
 * lands as a ledger leg (#414).
 *
 * DB-backed: the fail-closed reads, the agent-only revocation, and the royalty
 * moving a real balance are the safety properties, exercised against the real
 * tables.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  getConsent,
  hasConsent,
  assertConsent,
  revokeConsent,
  royaltyShareCents,
} from "./artifactConsent";
import { settleConsentRoyalty } from "./commerceLedger";
import { balance } from "./ledger";
import { commerceMerchantsTable, usersTable } from "@workspace/db/schema";

async function makeMerchant(tag: string): Promise<number> {
  const [u] = await db.insert(usersTable).values({ email: `${tag}-${Date.now()}-${Math.round(performance.now())}@t.test` }).returning({ id: usersTable.id });
  const [m] = await db.insert(commerceMerchantsTable).values({ userId: u.id, displayName: "Test Merchant" }).returning({ id: commerceMerchantsTable.id });
  return m.id;
}

let seq = 0;
const agent = () => `kax:agent:00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
let artifactSeq = 900000;
const artifact = () => ++artifactSeq;

describe("artifact consent (#414)", () => {
  beforeEach(() => {
    seq += 100;
  });

  it("fail-closed: no consent means the sale is not eligible", async () => {
    expect(await hasConsent(artifact(), "physical")).toBe(false);
  });

  it("the agent asserts consent, and it reads back active", async () => {
    const a = agent();
    const art = artifact();
    const c = await assertConsent({ artifactId: art, channel: "physical", agentPrincipal: a, royaltyBps: 1500 });
    expect(c.royaltyBps).toBe(1500);
    expect(await hasConsent(art, "physical")).toBe(true);
    // ...but not on a channel it did not consent to.
    expect(await hasConsent(art, "occ_gallery")).toBe(false);
  });

  it("only the consenting agent may revoke, and revocation blocks the next check", async () => {
    const a = agent();
    const other = agent();
    const art = artifact();
    await assertConsent({ artifactId: art, channel: "physical", agentPrincipal: a });
    // A different agent cannot revoke.
    expect((await revokeConsent(art, "physical", other)).ok).toBe(false);
    expect(await hasConsent(art, "physical")).toBe(true);
    // The agent that consented can, and the next check is blocked.
    expect((await revokeConsent(art, "physical", a)).ok).toBe(true);
    expect(await hasConsent(art, "physical")).toBe(false);
    // Re-asserting brings it back (the agent changed its mind).
    await assertConsent({ artifactId: art, channel: "physical", agentPrincipal: a });
    expect(await hasConsent(art, "physical")).toBe(true);
  });

  it("computes the royalty share from the consented split, frozen at sale", async () => {
    const a = agent();
    const art = artifact();
    await assertConsent({ artifactId: art, channel: "physical", agentPrincipal: a, royaltyBps: 1000 }); // 10%
    const consent = await getConsent(art, "physical");
    // The rate is frozen at sale — the caller computes the share, settlement
    // does not re-read it (finding 5). 10% of $100 = 1000 cents.
    expect(royaltyShareCents(consent, 10_000n)).toBe(1000n);
  });

  it("settles the royalty as a leg, moving the creator's balance", async () => {
    const a = agent();
    const art = artifact();
    const merchantId = await makeMerchant("royalty");
    const before = await balance(`trader:${a}`, "play_credit");
    const r = await settleConsentRoyalty({
      artifactId: art, shareCents: 1000n, // the sale-time frozen share
      merchantId, creatorPrincipal: a,
      commerceOrderRef: `ord-${seq}`, actor: "service:test",
    });
    expect(r?.shareCents).toBe(1000n);
    const after = await balance(`trader:${a}`, "play_credit");
    expect(after).toBeGreaterThan(before); // the agent's balance moved
  });

  it("keys the royalty per artifact, so an order with two line items pays both (finding 4)", async () => {
    const a = agent();
    const art1 = artifact();
    const art2 = artifact();
    const merchantId = await makeMerchant("multi");
    const ref = `ord-multi-${seq}`;
    const before = await balance(`trader:${a}`, "play_credit");
    // Two artifacts, different shares, ONE order+merchant — the old key would
    // collide; the artifact-scoped key pays each.
    const r1 = await settleConsentRoyalty({ artifactId: art1, shareCents: 500n, merchantId, creatorPrincipal: a, commerceOrderRef: ref, actor: "service:test" });
    const r2 = await settleConsentRoyalty({ artifactId: art2, shareCents: 1200n, merchantId, creatorPrincipal: a, commerceOrderRef: ref, actor: "service:test" });
    expect(r1?.commerceTxId).not.toBe(r2?.commerceTxId);
    const after = await balance(`trader:${a}`, "play_credit");
    expect(after - before).toBe(1700n * 1_000_000n); // 500 + 1200 credits (peg to minor)
  });

  it("pays nothing on a zero/absent share (a mis-sequenced caller cannot)", async () => {
    const a = agent();
    const art = artifact();
    const r = await settleConsentRoyalty({ artifactId: art, shareCents: 0n, merchantId: 999_999, creatorPrincipal: a, commerceOrderRef: `ord2-${seq}`, actor: "service:test" });
    expect(r).toBeNull();
  });
});

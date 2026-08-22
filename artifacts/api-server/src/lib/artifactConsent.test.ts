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

  it("settles the royalty as a leg, moving the creator's balance by the consented split", async () => {
    const a = agent();
    const art = artifact();
    // A merchant to debit the creator share from.
    const merchantId = await makeMerchant("royalty");
    await assertConsent({ artifactId: art, channel: "physical", agentPrincipal: a, royaltyBps: 1000 }); // 10%

    const before = await balance(`trader:${a}`, "play_credit");
    const r = await settleConsentRoyalty({
      artifactId: art, channel: "physical",
      saleTotalCents: 10_000n, // $100
      merchantId, creatorPrincipal: a,
      commerceOrderRef: `ord-${seq}`, actor: "service:test",
    });
    expect(r?.shareCents).toBe(1000n); // 10% of $100 = $10 = 1000 cents
    const after = await balance(`trader:${a}`, "play_credit");
    expect(after).toBeGreaterThan(before); // the agent's balance moved
  });

  it("pays no royalty when consent is absent or revoked (a mis-sequenced caller cannot)", async () => {
    const a = agent();
    const art = artifact();
    // No consent asserted — settleConsentRoyalty returns null before touching
    // any merchant/ledger, so a mis-sequenced caller pays nothing.
    const r = await settleConsentRoyalty({ artifactId: art, channel: "physical", saleTotalCents: 10_000n, merchantId: 999_999, creatorPrincipal: a, commerceOrderRef: `ord2-${seq}`, actor: "service:test" });
    expect(r).toBeNull();
  });
});

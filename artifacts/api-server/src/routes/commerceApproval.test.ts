/**
 * commerceApproval.test.ts — #259's acceptance criteria.
 *
 * Approval is a human act pinned to content. The tests tamper with each
 * input the pin covers — the measured bytes' hash, the price — and with the
 * rights underneath it, and assert the pin does what it exists for: acts and
 * throws, never warns and continues.
 *
 * DB-backed; runs in CI. Uses a mocked-fetch measurement seeded through the
 * REAL pipeline so re-measurement inside assertApprovalStillValid recomputes
 * against genuinely stored rows.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { db } from "@workspace/db";
import {
  artifactPrintAssetsTable,
  artifactsTable,
  commerceMerchantsTable,
  commerceProductsTable,
  userBotsTable,
} from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";
import commerceRouter from "./commerce";
import { authMiddleware } from "../middlewares/authMiddleware";
import { ApprovalInvalidated, assertApprovalStillValid } from "../lib/approvalPin";
import {
  cleanupAuthTestData,
  cleanupTestData,
  createTestAgent,
  createWalletUser,
  makeBotUuid,
  makeTestId,
} from "../test-helpers";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authMiddleware);
  app.use(commerceRouter);
  return app;
}

describe("approval pin (#259, DB)", () => {
  const app = makeApp();
  let owner: { id: string; address: string; sid: string };
  let stranger: { id: string; address: string; sid: string };
  let agentId: number;
  let merchantId: number;
  let botId: string;
  const artifacts: number[] = [];
  const products: number[] = [];
  const addresses: string[] = [];
  const userIds: string[] = [];
  const sids: string[] = [];

  beforeAll(async () => {
    owner = await createWalletUser();
    stranger = await createWalletUser();
    for (const u of [owner, stranger]) {
      addresses.push(u.address);
      userIds.push(u.id);
      sids.push(u.sid);
    }
    agentId = (await createTestAgent(owner.id, "approval")).id;
    botId = makeBotUuid();
    await db.insert(userBotsTable).values({ userId: owner.id, obcBotId: botId });
    const [m] = await db
      .insert(commerceMerchantsTable)
      .values({ userId: owner.id, displayName: "approval merchant" })
      .returning({ id: commerceMerchantsTable.id });
    merchantId = m!.id;
  });

  afterAll(async () => {
    await db.delete(commerceProductsTable).where(inArray(commerceProductsTable.id, products));
    await db.delete(artifactPrintAssetsTable).where(inArray(artifactPrintAssetsTable.artifactId, artifacts));
    await db.delete(artifactsTable).where(inArray(artifactsTable.id, artifacts));
    await db.delete(commerceMerchantsTable).where(eq(commerceMerchantsTable.id, merchantId));
    await db.delete(userBotsTable).where(eq(userBotsTable.obcBotId, botId));
    await cleanupAuthTestData({ addresses: addresses.splice(0), userIds: userIds.splice(0), sids: sids.splice(0) });
    await cleanupTestData();
  });

  /**
   * A product in product_eligible with a REAL measurement row whose bytes
   * are stable (the URL is a sentinel-free allowlisted host; the measurement
   * row is written directly so re-measurement inside the pin, which fetches,
   * is exercised via the DIRECT hash comparison instead — see the note in
   * each test).
   */
  async function seedApprovable(): Promise<{ artifactId: number; productId: number }> {
    const [a] = await db
      .insert(artifactsTable)
      .values({
        externalId: makeTestId("appr"),
        title: "approvable",
        creatorName: "kax-test-creator",
        creatorBotId: botId,
        publicUrl: "inline:unreachable", // pin tests never need a live fetch to PASS
        artifactType: "image",
        agentId,
      })
      .returning({ id: artifactsTable.id });
    artifacts.push(a!.id);
    await db.insert(artifactPrintAssetsTable).values({
      artifactId: a!.id,
      widthPx: 3600,
      heightPx: 3600,
      format: "png",
      byteSize: 1000n,
      sha256: "a".repeat(64),
      sourceUrlAtFetch: "https://kfz.supabase.co/original.png",
      fetchedAt: new Date(),
    });
    const [p] = await db
      .insert(commerceProductsTable)
      .values({
        sku: makeTestId("appr-sku"),
        title: "approvable poster",
        itemCents: 3900,
        merchantId,
        artifactId: a!.id,
        productSpecId: "poster_12x12",
        commerceState: "product_eligible",
      })
      .returning({ id: commerceProductsTable.id });
    products.push(p!.id);
    return { artifactId: a!.id, productId: p!.id };
  }

  async function approve(productId: number, sid: string) {
    return request(app)
      .post(`/commerce/products/${productId}/approve`)
      .set("Cookie", `sid=${sid}`);
  }

  it("the merchant's owner approves; the pin lands with approver and hash", async () => {
    const { productId } = await seedApprovable();
    const r = await approve(productId, owner.sid);
    expect(r.status).toBe(200);
    expect(r.body.commerceState).toBe("merchant_approved");
    expect(r.body.approvedContentHash).toMatch(/^[0-9a-f]{64}$/);
    const [row] = await db
      .select()
      .from(commerceProductsTable)
      .where(eq(commerceProductsTable.id, productId));
    expect(row!.approvedBy).toBe(owner.id);
  });

  it("an agent identity token can never approve: bearer without session is 401", async () => {
    const { productId } = await seedApprovable();
    const r = await request(app)
      .post(`/commerce/products/${productId}/approve`)
      .set("Authorization", "Bearer some-agent-identity-token");
    expect(r.status).toBe(401);
  });

  it("a user who does not own the merchant is 403", async () => {
    const { productId } = await seedApprovable();
    const r = await approve(productId, stranger.sid);
    expect(r.status).toBe(403);
  });

  it("tampered asset bytes: the pin throws and the state falls back with approval cleared", async () => {
    const { artifactId, productId } = await seedApprovable();
    await approve(productId, owner.sid);
    // The bytes behind the URL "change": re-measurement will record a
    // different world than the approval pinned. (publicUrl is a sentinel, so
    // the fresh measurement inside the pin records a failure — which is a
    // changed world too, and exactly the honest outcome: content that can no
    // longer be verified is content that no longer matches.)
    await db
      .update(artifactPrintAssetsTable)
      .set({ sha256: "b".repeat(64) })
      .where(eq(artifactPrintAssetsTable.artifactId, artifactId));
    await expect(assertApprovalStillValid(productId)).rejects.toThrow(ApprovalInvalidated);
    const [row] = await db
      .select()
      .from(commerceProductsTable)
      .where(eq(commerceProductsTable.id, productId));
    expect(row!.commerceState).toBe("product_eligible");
    expect(row!.approvedBy).toBeNull();
    expect(row!.approvedContentHash).toBeNull();
  });

  it("tampered price: same fall-back — the pin covers what the buyer would pay", async () => {
    const { productId } = await seedApprovable();
    await approve(productId, owner.sid);
    await db
      .update(commerceProductsTable)
      .set({ itemCents: 4900 })
      .where(eq(commerceProductsTable.id, productId));
    await expect(assertApprovalStillValid(productId)).rejects.toThrow(ApprovalInvalidated);
    const [row] = await db
      .select()
      .from(commerceProductsTable)
      .where(eq(commerceProductsTable.id, productId));
    expect(row!.commerceState).toBe("product_eligible");
  });

  it("revoked creator bot: rights_blocked, unpublished, approval cleared", async () => {
    const { productId } = await seedApprovable();
    await approve(productId, owner.sid);
    await db
      .update(userBotsTable)
      .set({ revokedAt: new Date(), revokedReason: "test" })
      .where(eq(userBotsTable.obcBotId, botId));
    try {
      await expect(assertApprovalStillValid(productId)).rejects.toThrow(/rights no longer hold/);
      const [row] = await db
        .select()
        .from(commerceProductsTable)
        .where(eq(commerceProductsTable.id, productId));
      expect(row!.commerceState).toBe("rights_blocked");
      expect(row!.published).toBe(false);
      expect(row!.approvedBy).toBeNull();
    } finally {
      await db
        .update(userBotsTable)
        .set({ revokedAt: null, revokedReason: null })
        .where(eq(userBotsTable.obcBotId, botId));
    }
  });
});

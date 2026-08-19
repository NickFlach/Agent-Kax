import { db } from "@workspace/db";
import {
  artifactPrintAssetsTable,
  commerceMerchantsTable,
  commerceProductsTable,
} from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { approvalHash, canTransition, parseCommerceState } from "./commerceOrder";
import { isCommerceEligible } from "./visibility";
import { measureArtifactAsset } from "./printAsset";

/**
 * approvalPin.ts — assertApprovalStillValid (#259).
 *
 * Lives here rather than in commerceOrder.ts, deviating from the issue's file
 * list for a reason that outranks it: commerceOrder.ts is PURE (no db import)
 * so routes, webhooks and purchasingFacts can share its vocabulary without a
 * connection pool — a property other files rely on. The pure half of #259
 * (approvalHash) is there; the half that reads the database is here.
 *
 * Called at the two points the ADR names: the merchant_approved ->
 * channel_ready transition, and immediately before fulfilment submission.
 * It RE-MEASURES the asset and RE-EVALUATES rights live — never reads either
 * from a recorded assertion — and on any mismatch it acts and THROWS. It
 * does not warn and continue: an approval that no longer describes the bytes
 * is not weaker evidence, it is no evidence.
 */

export class ApprovalInvalidated extends Error {
  constructor(
    message: string,
    readonly productId: number,
    readonly newState: "product_eligible" | "rights_blocked",
  ) {
    super(message);
  }
}

export async function assertApprovalStillValid(productId: number): Promise<void> {
  const [p] = await db
    .select()
    .from(commerceProductsTable)
    .where(eq(commerceProductsTable.id, productId))
    .limit(1);
  if (!p) throw new Error(`product ${productId} not found`);
  const state = parseCommerceState(p.commerceState);
  if (!p.approvedContentHash || !p.artifactId || !p.merchantId || !p.productSpecId) {
    throw new Error(`product ${productId} carries no complete approval to validate`);
  }

  // Rights, LIVE. A revoked creator bot is the one event that moves any
  // state to rights_blocked (the transition wildcard), plus unpublish.
  const [merchant] = await db
    .select({ userId: commerceMerchantsTable.userId })
    .from(commerceMerchantsTable)
    .where(eq(commerceMerchantsTable.id, p.merchantId))
    .limit(1);
  const rights = merchant
    ? await isCommerceEligible(p.artifactId, merchant.userId)
    : ({ ok: false, reason: "merchant row missing" } as const);
  if (!rights.ok) {
    await db
      .update(commerceProductsTable)
      .set({
        commerceState: "rights_blocked",
        published: false,
        unpublishedAt: new Date(),
        approvedContentHash: null,
        approvedBy: null,
        approvedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(commerceProductsTable.id, productId));
    throw new ApprovalInvalidated(
      `rights no longer hold for product ${productId}: ${rights.reason}`,
      productId,
      "rights_blocked",
    );
  }

  // Content, FRESH. Re-measure — the bucket is not ours and the bytes can
  // have changed with no KAX-side write to notice.
  const asset = await measureArtifactAsset(p.artifactId);
  const current =
    asset.failureReason == null && asset.sha256 && asset.sourceUrlAtFetch
      ? approvalHash({
          sourceUrlAtFetch: asset.sourceUrlAtFetch,
          assetSha256: asset.sha256,
          productSpecId: p.productSpecId,
          itemCents: p.itemCents,
        })
      : null;
  if (current !== p.approvedContentHash) {
    // Back to product_eligible for fresh human eyes — the legal demotion
    // edge the machine defines for exactly this case.
    if (!canTransition(state, "product_eligible")) {
      // From a state with no legal path back (should not occur on the two
      // call sites), still refuse to proceed — but do not corrupt the machine.
      throw new ApprovalInvalidated(
        `approval hash mismatch on product ${productId} in state ${state}`,
        productId,
        "product_eligible",
      );
    }
    await db
      .update(commerceProductsTable)
      .set({
        commerceState: "product_eligible",
        approvedContentHash: null,
        approvedBy: null,
        approvedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(commerceProductsTable.id, productId));
    throw new ApprovalInvalidated(
      `content behind product ${productId} changed since approval; re-approval required`,
      productId,
      "product_eligible",
    );
  }
}

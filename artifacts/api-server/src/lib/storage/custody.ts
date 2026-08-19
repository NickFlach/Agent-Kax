import crypto from "node:crypto";
import { db } from "@workspace/db";
import { artifactPrintAssetsTable, artifactsTable, derivedAssetsTable, type DerivedAsset } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { PRINT_ASSET_BYTE_CAP, hostAllowed, parseImageHeader } from "../printAsset";
import type { StorageAdapter } from "./adapter";

/**
 * storage/custody.ts — KAX takes custody of source bytes, and derived print
 * masters live only in KAX-controlled storage (#264, ADR-0002 v0.2).
 *
 * The rule the ADR states and this module enforces: a derived asset cannot be
 * regenerated from a URL that has rotated — the source host is OBC's,
 * artifacts-small is the only bucket, and there is no larger original to
 * re-derive from. So custody of the SOURCE bytes is a precondition of
 * creating any derived asset, and a reprint reads the KAX-held master, never
 * the OBC URL.
 *
 * An upscaled master is a NEW asset with its own provenance: its own row, its
 * own sha256, its own source_artifact_id edge, and (downstream) a fresh
 * merchant approval — an approval pinned to source bytes does not carry to a
 * file KAX generated afterwards.
 */

export class CustodyMissing extends Error {
  readonly code = "custody_missing";
  constructor(artifactId: number) {
    super(`KAX does not hold the bytes of artifact ${artifactId} — take custody before deriving`);
  }
}

export class SourceDrifted extends Error {
  readonly code = "source_drifted";
  constructor(artifactId: number) {
    super(
      `artifact ${artifactId}'s source bytes no longer match their measurement — ` +
        `re-measure and re-approve before taking custody`,
    );
  }
}

/** Storage keys are derived, never invented: content-addressed under a prefix. */
export function sourceKeyFor(artifactId: number, sha256: string): string {
  return `sources/${artifactId}/${sha256}`;
}
export function derivedKeyFor(artifactId: number, sha256: string): string {
  return `derived/${artifactId}/${sha256}`;
}

/**
 * The custody fetch: the SAME https-only host allowlist and byte cap as the
 * measurement in printAsset.ts (the issue's AC names them), but retaining the
 * bytes instead of discarding them.
 */
export async function fetchSourceBytes(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ bytes: Uint8Array; sha256: string } | { failure: "not_a_url" | "fetch_failed" | "too_large" }> {
  if (!/^https?:\/\//i.test(url)) return { failure: "not_a_url" };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { failure: "not_a_url" };
  }
  if (!hostAllowed(parsed)) return { failure: "fetch_failed" };

  try {
    const res = await fetchImpl(url, { redirect: "follow" });
    if (!res.ok || !res.body) return { failure: "fetch_failed" };
    const chunks: Uint8Array[] = [];
    let byteSize = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      byteSize += value.length;
      if (byteSize > PRINT_ASSET_BYTE_CAP) return { failure: "too_large" };
      chunks.push(value);
    }
    const bytes = new Uint8Array(byteSize);
    let off = 0;
    for (const c of chunks) {
      bytes.set(c, off);
      off += c.length;
    }
    return { bytes, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  } catch {
    return { failure: "fetch_failed" };
  }
}

/**
 * Copy an artifact's source bytes into KAX-controlled storage and record the
 * key on its measurement row. Requires a successful measurement first, and
 * refuses if the bytes no longer hash to what was measured — the approval pin
 * (#259) is a hash of the MEASURED bytes, and custody of different bytes
 * would launder a swap.
 */
export async function takeCustody(
  artifactId: number,
  storage: StorageAdapter,
  fetchImpl: typeof fetch = fetch,
): Promise<{ storageKey: string; sha256: string; alreadyHeld: boolean }> {
  const [asset] = await db
    .select()
    .from(artifactPrintAssetsTable)
    .where(eq(artifactPrintAssetsTable.artifactId, artifactId))
    .limit(1);
  if (!asset || asset.failureReason != null || !asset.sha256) {
    throw new Error(`artifact ${artifactId} has no successful measurement — measure before custody`);
  }
  if (asset.storageKey) {
    return { storageKey: asset.storageKey, sha256: asset.sha256, alreadyHeld: true };
  }

  const [artifact] = await db
    .select({ publicUrl: artifactsTable.publicUrl })
    .from(artifactsTable)
    .where(eq(artifactsTable.id, artifactId))
    .limit(1);
  const fetched = await fetchSourceBytes(artifact?.publicUrl ?? "", fetchImpl);
  if ("failure" in fetched) {
    throw new Error(`custody fetch for artifact ${artifactId} failed: ${fetched.failure}`);
  }
  if (fetched.sha256 !== asset.sha256) throw new SourceDrifted(artifactId);

  const storageKey = sourceKeyFor(artifactId, fetched.sha256);
  const contentType = asset.format === "jpeg" ? "image/jpeg" : asset.format === "webp" ? "image/webp" : "image/png";
  await storage.put(storageKey, fetched.bytes, contentType);
  await db
    .update(artifactPrintAssetsTable)
    .set({ storageKey })
    .where(eq(artifactPrintAssetsTable.artifactId, artifactId));
  return { storageKey, sha256: fetched.sha256, alreadyHeld: false };
}

/** The custody guard, importable wherever a derived master is about to exist. */
export async function assertSourceCustody(
  artifactId: number,
): Promise<{ storageKey: string; sha256: string | null }> {
  const [asset] = await db
    .select({ storageKey: artifactPrintAssetsTable.storageKey, sha256: artifactPrintAssetsTable.sha256 })
    .from(artifactPrintAssetsTable)
    .where(eq(artifactPrintAssetsTable.artifactId, artifactId))
    .limit(1);
  if (!asset?.storageKey) throw new CustodyMissing(artifactId);
  return { storageKey: asset.storageKey, sha256: asset.sha256 };
}

/** Upscale factors above this go to a human, even when the pixels check out. */
export const HUMAN_REVIEW_FACTOR = 2;

export const DERIVED_QUALITY_STATUSES = ["pending", "passed", "failed", "human_review"] as const;
export type DerivedQualityStatus = (typeof DERIVED_QUALITY_STATUSES)[number];

/**
 * Record one derived print master: custody-guarded, content-addressed, its
 * own provenance row. `bytes` are the OUTPUT of the transform — this module
 * stores and judges them; the transform itself (an upscaler binary or
 * service) is the explicit production stage the operator arms separately.
 */
export async function createDerivedAsset(input: {
  sourceArtifactId: number;
  transformType: string;
  transformFactor: number;
  bytes: Uint8Array;
  storage: StorageAdapter;
  /** The print spec's minimum for the target product, e.g. 2700×3300. */
  requiredPx?: { width: number; height: number };
  /**
   * #294: the cache identity. When all three are given, the row is UNIQUE on
   * (source bytes, pipeline, target) and regeneration returns the existing
   * row instead of inserting a twin — idempotency enforced by the schema,
   * not by caller discipline.
   */
  pipelineVersion?: string;
  targetProduct?: string;
  targetPx?: { width: number; height: number };
}): Promise<DerivedAsset> {
  // AC: no derived print master for an artifact whose bytes KAX does not hold.
  const custody = await assertSourceCustody(input.sourceArtifactId);

  const sha256 = crypto.createHash("sha256").update(input.bytes).digest("hex");
  const header = parseImageHeader(input.bytes);

  // The quality check, an explicit stage with a human-review branch:
  //  - undecodable or under the target spec: failed, no appeal
  //  - decodable and in-spec but upscaled beyond HUMAN_REVIEW_FACTOR: a human
  //    looks before any product uses it (interpolation artifacts do not show
  //    up in a width/height check)
  //  - otherwise: passed
  let qualityStatus: DerivedQualityStatus;
  if (!header) {
    qualityStatus = "failed";
  } else if (
    input.requiredPx &&
    (header.widthPx < input.requiredPx.width || header.heightPx < input.requiredPx.height)
  ) {
    qualityStatus = "failed";
  } else if (input.transformFactor > HUMAN_REVIEW_FACTOR) {
    qualityStatus = "human_review";
  } else {
    qualityStatus = "passed";
  }

  const storageKey = derivedKeyFor(input.sourceArtifactId, sha256);
  const contentType = header?.format === "jpeg" ? "image/jpeg" : header?.format === "webp" ? "image/webp" : "image/png";
  await input.storage.put(storageKey, input.bytes, contentType);

  const cacheable =
    custody.sha256 != null && input.pipelineVersion != null && input.targetPx != null;
  const values = {
    sourceArtifactId: input.sourceArtifactId,
    transformType: input.transformType,
    transformFactor: input.transformFactor,
    qualityStatus,
    storageKey,
    sha256,
    byteSize: BigInt(input.bytes.length),
    widthPx: header?.widthPx ?? null,
    heightPx: header?.heightPx ?? null,
    parentSha256: cacheable ? custody.sha256 : null,
    pipelineVersion: input.pipelineVersion ?? null,
    targetProduct: input.targetProduct ?? null,
    targetWpx: input.targetPx?.width ?? null,
    targetHpx: input.targetPx?.height ?? null,
  };
  const inserted = await db
    .insert(derivedAssetsTable)
    .values(values)
    .onConflictDoNothing()
    .returning();
  if (inserted.length > 0) return inserted[0]!;
  // The cache hit (#294): this exact (source bytes, pipeline, target) was
  // already produced. Return the EXISTING row — its verdicts and approval
  // state are the truth about these bytes; a twin would fork them.
  const [existing] = await db
    .select()
    .from(derivedAssetsTable)
    .where(
      and(
        eq(derivedAssetsTable.parentSha256, custody.sha256!),
        eq(derivedAssetsTable.pipelineVersion, input.pipelineVersion!),
        eq(derivedAssetsTable.targetWpx, input.targetPx!.width),
        eq(derivedAssetsTable.targetHpx, input.targetPx!.height),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("derived-asset insert conflicted but no cached row was found");
  return existing;
}

/**
 * MERCHANT approval (#294): pending -> approved | rejected, once, and the DB
 * trigger independently refuses approved without quality passed — a derived
 * asset cannot reach an approved state without a pass or a human-cleared
 * review (which resolves INTO passed).
 */
export async function approveDerivedAsset(
  id: number,
  verdict: "approved" | "rejected",
  approvedBy: string,
): Promise<DerivedAsset> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(derivedAssetsTable)
      .where(eq(derivedAssetsTable.id, id))
      .limit(1)
      .for("update");
    if (!row) throw new Error(`derived asset ${id} does not exist`);
    if (row.approvalStatus !== "pending") {
      throw new Error(`derived asset ${id} approval is already ${row.approvalStatus}`);
    }
    if (verdict === "approved" && row.qualityStatus !== "passed") {
      throw new Error(
        `derived asset ${id} cannot be approved with quality_status ${row.qualityStatus} — a pass is required`,
      );
    }
    const [updated] = await tx
      .update(derivedAssetsTable)
      .set({ approvalStatus: verdict, approvedBy, approvedAt: new Date() })
      .where(eq(derivedAssetsTable.id, id))
      .returning();
    return updated!;
  });
}

/** The human-review branch resolving: human_review -> passed | failed, once. */
export async function reviewDerivedAsset(
  id: number,
  verdict: "passed" | "failed",
  reviewedBy: string,
): Promise<DerivedAsset> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(derivedAssetsTable)
      .where(eq(derivedAssetsTable.id, id))
      .limit(1)
      .for("update");
    if (!row) throw new Error(`derived asset ${id} does not exist`);
    if (row.qualityStatus !== "human_review") {
      throw new Error(`derived asset ${id} is ${row.qualityStatus}, not awaiting review`);
    }
    const [updated] = await tx
      .update(derivedAssetsTable)
      .set({ qualityStatus: verdict, reviewedBy, reviewedAt: new Date() })
      .where(eq(derivedAssetsTable.id, id))
      .returning();
    return updated!;
  });
}

/**
 * Reprint from the KAX-held master. Reads storage by key and verifies the
 * recorded sha256 — the OBC source URL is not consulted, which is the entire
 * point of custody (the AC proves it with the origin stubbed to 404).
 */
export async function reprintMasterBytes(
  derivedAssetId: number,
  storage: StorageAdapter,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const [row] = await db
    .select()
    .from(derivedAssetsTable)
    .where(eq(derivedAssetsTable.id, derivedAssetId))
    .limit(1);
  if (!row) throw new Error(`derived asset ${derivedAssetId} does not exist`);
  const obj = await storage.get(row.storageKey);
  if (!obj) throw new Error(`derived asset ${derivedAssetId}: master ${row.storageKey} is missing from storage`);
  const sha = crypto.createHash("sha256").update(obj.bytes).digest("hex");
  if (sha !== row.sha256) {
    throw new Error(`derived asset ${derivedAssetId}: stored master hash mismatch — refusing to print it`);
  }
  return { bytes: obj.bytes, contentType: obj.contentType };
}

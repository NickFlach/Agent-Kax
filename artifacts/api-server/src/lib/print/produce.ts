import { db } from "@workspace/db";
import { artifactPrintAssetsTable, type DerivedAsset } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import type { StorageAdapter } from "../storage/adapter";
import { createDerivedAsset, takeCustody } from "../storage/custody";
import crypto from "node:crypto";
import { decodeImage, encodePng } from "./raster";
import { DECONTAMINATE_PIPELINE_VERSION, decontaminate } from "./decontaminate";
import { RESAMPLE_PIPELINE_VERSION, resampleForPrint } from "./resample";
import { RASTERIZE_PIPELINE_VERSION, renderSvgMaster } from "./rasterize";

/**
 * print/produce.ts — the production stages that turn a held source into
 * masters (#293 custody+decontamination, #295 the 4in sticker resample).
 *
 * Each stage is: custody first (the #264 guard makes that structural), then
 * a deterministic transform, then a derived_assets row whose cache identity
 * (parent_sha256, pipeline_version, target) makes re-runs idempotent — the
 * #293 acceptance "re-fetch of the same source is idempotent (no new rows)"
 * is enforced by the #294 unique constraint, not by caller discipline.
 */

/**
 * #293: take custody of the source AND store its decontaminated master in
 * one motion. The master is a derived asset with its own sha256 and a
 * lineage edge (source_artifact_id) to the source; the recorded format of
 * the SOURCE is whatever the bytes sniffed as (JPEG behind a .png filename
 * records as jpeg — printAsset.ts's rule), while the master is always PNG,
 * because re-encoding through JPEG would recontaminate what was just
 * cleaned.
 */
export async function custodyWithDecontaminatedMaster(
  artifactId: number,
  storage: StorageAdapter,
  fetchImpl: typeof fetch = fetch,
): Promise<{ custodySha256: string; master: DerivedAsset }> {
  const custody = await takeCustody(artifactId, storage, fetchImpl);

  // Read the held bytes back from OUR storage — the origin has done its one
  // job and is never consulted again.
  const held = await storage.get(custody.storageKey);
  if (!held) throw new Error(`custody bytes for artifact ${artifactId} are missing from storage`);
  const decoded = decodeImage(held.bytes);
  if (!decoded) {
    throw new Error(`artifact ${artifactId}'s held bytes did not decode — cannot build a master`);
  }

  const cleaned = decontaminate(decoded.raster);
  const master = await createDerivedAsset({
    sourceArtifactId: artifactId,
    transformType: "decontaminate",
    transformFactor: 1,
    bytes: encodePng(cleaned),
    storage,
    pipelineVersion: DECONTAMINATE_PIPELINE_VERSION,
    targetProduct: "master",
    targetPx: { width: cleaned.width, height: cleaned.height },
  });
  return { custodySha256: custody.sha256, master };
}

/** #295's placeholder: the 4×4in sticker, 1113×1113 at Printify's PPI. */
export const STICKER_4IN = { productSpecId: "sticker_4in", widthPx: 1113, heightPx: 1113 } as const;

export function sticker4inEnabled(): boolean {
  return process.env["KAX_PRODUCT_STICKER_4IN"] === "1";
}

/**
 * #295: the 4in sticker master — decontaminated source → Lanczos+unsharp at
 * 1113×1113. Deterministic (no model), so the derived row's sha256 is
 * byte-identical across runs on the same input and the cache constraint
 * collapses re-runs onto one row with `pass` and pending approval.
 */
export async function produceSticker4inMaster(
  artifactId: number,
  storage: StorageAdapter,
  fetchImpl: typeof fetch = fetch,
): Promise<DerivedAsset> {
  if (!sticker4inEnabled()) {
    throw new Error("sticker_4in is not enabled (set KAX_PRODUCT_STICKER_4IN=1)");
  }
  const { master } = await custodyWithDecontaminatedMaster(artifactId, storage, fetchImpl);
  const held = await storage.get(master.storageKey);
  if (!held) throw new Error(`decontaminated master ${master.id} is missing from storage`);
  const decoded = decodeImage(held.bytes);
  if (!decoded) throw new Error(`decontaminated master ${master.id} did not decode`);

  const [srcRow] = await db
    .select({ w: artifactPrintAssetsTable.widthPx, h: artifactPrintAssetsTable.heightPx })
    .from(artifactPrintAssetsTable)
    .where(eq(artifactPrintAssetsTable.artifactId, artifactId))
    .limit(1);
  const factor = srcRow?.w ? STICKER_4IN.widthPx / srcRow.w : STICKER_4IN.widthPx / decoded.raster.width;

  const resampled = resampleForPrint(decoded.raster, STICKER_4IN.widthPx, STICKER_4IN.heightPx);
  return createDerivedAsset({
    sourceArtifactId: artifactId,
    transformType: "resample",
    transformFactor: Math.round(factor * 1000) / 1000,
    bytes: encodePng(resampled),
    storage,
    requiredPx: { width: STICKER_4IN.widthPx, height: STICKER_4IN.heightPx },
    pipelineVersion: RESAMPLE_PIPELINE_VERSION,
    targetProduct: STICKER_4IN.productSpecId,
    targetPx: { width: STICKER_4IN.widthPx, height: STICKER_4IN.heightPx },
  });
}

/** #298's placeholder: the aspect-clean 12×12in square poster, 3600×3600. */
export const POSTER_12X12 = { productSpecId: "poster_12x12", widthPx: 3600, heightPx: 3600 } as const;

export function poster12x12Enabled(): boolean {
  return process.env["KAX_PRODUCT_POSTER_12X12"] === "1";
}

/**
 * #298: render an SVG MASTER to the exact 3600×3600 target. Deterministic —
 * same SVG + same target = same sha256 (the fixture pins it) — and each
 * render is its own derived_assets row whose lineage edge (parent_sha256)
 * is the SVG MASTER's sha, not the source raster's: what was transformed
 * here is the vector. Raw SVG never leaves KAX (printifyClient refuses
 * image/svg+xml); what ships to the printer is this render.
 */
export async function producePoster12x12Render(
  sourceArtifactId: number,
  svgMaster: string,
  storage: StorageAdapter,
): Promise<DerivedAsset> {
  if (!poster12x12Enabled()) {
    throw new Error("poster_12x12 is not enabled (set KAX_PRODUCT_POSTER_12X12=1)");
  }
  const svgSha = crypto.createHash("sha256").update(svgMaster, "utf8").digest("hex");
  const rendered = renderSvgMaster(svgMaster, POSTER_12X12.widthPx, POSTER_12X12.heightPx);
  return createDerivedAsset({
    sourceArtifactId,
    transformType: "rasterize",
    transformFactor: 1,
    bytes: encodePng(rendered),
    storage,
    requiredPx: { width: POSTER_12X12.widthPx, height: POSTER_12X12.heightPx },
    pipelineVersion: RASTERIZE_PIPELINE_VERSION,
    targetProduct: POSTER_12X12.productSpecId,
    targetPx: { width: POSTER_12X12.widthPx, height: POSTER_12X12.heightPx },
    parentSha256: svgSha,
  });
}

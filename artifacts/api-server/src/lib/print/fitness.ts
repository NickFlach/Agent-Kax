import { db } from "@workspace/db";
import { artifactPrintAssetsTable, printFitnessReportsTable, type PrintFitnessReport } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import type { StorageAdapter } from "../storage/adapter";
import { decodeImage, encodePng, type Raster } from "./raster";
import { judge } from "./gate";
import { vectorize, vectorizerConfigured, type VectorizeImpl, type VtracerPreset } from "./vectorize";

/**
 * print/fitness.ts — the report-only runner (#296).
 *
 * KAX_PRINT_FITNESS_GATE=report arms it; anything else and it writes
 * nothing. Even armed, it GATES NOTHING — its only writes are report rows,
 * and no production path reads verdict until the calibration run (#297)
 * replaces the guessed thresholds. The report is how the corpus's flat-art
 * fraction (the research pass's single most important unknown) gets
 * measured before anyone trusts a gate built on guesses about it.
 */

export const FITNESS_PIPELINE_VERSION = "fitness-v1";

export function printFitnessGateMode(): "off" | "report" {
  return process.env["KAX_PRINT_FITNESS_GATE"] === "report" ? "report" : "off";
}

/**
 * Render an SVG candidate back to a raster at given dims — #298's stage.
 * Injectable; production has none until that issue lands, and the gate
 * reports renderer_unavailable rather than inventing an SSIM.
 */
export type RenderImpl = (svg: string, width: number, height: number) => Promise<Raster>;

/**
 * Measure one artifact and WRITE THE REPORT ROW. Returns null (and writes
 * nothing) when the stage is not armed. Source bytes come from KAX custody
 * — this stage runs on held bytes only, never re-fetching the origin.
 */
export async function reportPrintFitness(
  artifactId: number,
  storage: StorageAdapter,
  opts: {
    preset?: VtracerPreset;
    vectorizeImpl?: VectorizeImpl;
    renderImpl?: RenderImpl;
  } = {},
): Promise<PrintFitnessReport | null> {
  if (printFitnessGateMode() !== "report") return null;

  const [asset] = await db
    .select({ storageKey: artifactPrintAssetsTable.storageKey })
    .from(artifactPrintAssetsTable)
    .where(eq(artifactPrintAssetsTable.artifactId, artifactId))
    .limit(1);
  if (!asset?.storageKey) {
    throw new Error(`artifact ${artifactId} is not in custody — the gate measures held bytes only`);
  }
  const held = await storage.get(asset.storageKey);
  if (!held) throw new Error(`artifact ${artifactId}'s custody bytes are missing from storage`);
  const decoded = decodeImage(held.bytes);
  if (!decoded) throw new Error(`artifact ${artifactId}'s held bytes did not decode`);

  const preset = opts.preset ?? "flat";
  let svgStats = null;
  let rendered: Raster | null = null;
  const canVectorize = opts.vectorizeImpl != null || vectorizerConfigured();
  if (canVectorize) {
    const result = await vectorize(encodePng(decoded.raster), preset, opts.vectorizeImpl);
    svgStats = result.stats;
    if (opts.renderImpl) {
      rendered = await opts.renderImpl(result.svg, decoded.raster.width, decoded.raster.height);
    }
  }

  const metrics = judge({ source: decoded.raster, rendered, svgStats });
  const [row] = await db
    .insert(printFitnessReportsTable)
    .values({
      artifactId,
      preset: canVectorize ? preset : null,
      ssim: metrics.ssim,
      meanDeltaE2000: metrics.meanDeltaE2000,
      pathCount: metrics.pathCount,
      nodeCount: metrics.nodeCount,
      svgBytes: metrics.svgBytes,
      colorBandCount: metrics.colorBandCount,
      verdict: metrics.verdict,
      reason: metrics.reason,
      pipelineVersion: FITNESS_PIPELINE_VERSION,
    })
    .returning();
  return row!;
}

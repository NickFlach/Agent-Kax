import { db } from "@workspace/db";
import { artifactPrintAssetsTable } from "@workspace/db/schema";
import { eq, isNotNull } from "drizzle-orm";
import type { StorageAdapter } from "../storage/adapter";
import { decodeImage, encodePng } from "./raster";
import { colorBandCount, meanDeltaE2000, ssim, type GateVerdict, type Thresholds, FALLBACK_THRESHOLDS } from "./gate";
import { VTRACER_PRESETS, vectorize, type VectorizeImpl, type VtracerPreset } from "./vectorize";
import type { RenderImpl } from "./fitness";

/**
 * print/calibrate.ts — the calibration machinery (#297).
 *
 * OPERATOR RUNBOOK (the parts no code can do):
 *   1. Arm VTracer (KAX_VTRACER_BIN + KAX_VTRACER_SHA256, pinned build) and
 *      storage, against the production DB.
 *   2. Run sampleCorpusRows() → calibrationSweep() → toCsv() and save the
 *      CSV. Its `label` column is EMPTY: filling it is the human step, one
 *      pass|needs_review|fail per row, eyes on the rendered candidate.
 *   3. Feed the labelled CSV to deriveThresholds() and write the result
 *      over config/print-fitness-thresholds.json with calibrated: true.
 *   4. flatArtFraction() of the sweep is the report's HEADLINE NUMBER —
 *      the corpus's flat-art share, the research pass's biggest unknown.
 *
 * Everything below is deterministic and testable without the corpus: the
 * sampling plan, the CSV round-trip, the threshold derivation (a grid
 * search maximizing label agreement), and the agreement scorer the vitest
 * fixtures hold the shipped thresholds to.
 */

export interface CalibrationRow {
  artifactId: number;
  preset: string;
  widthPx: number;
  heightPx: number;
  colorBandCount: number;
  ssim: number | null;
  meanDeltaE2000: number | null;
  pathCount: number | null;
  nodeCount: number | null;
  svgBytes: number | null;
  /** Filled by the HUMAN pass; empty in the emitted CSV. */
  label?: GateVerdict | "";
}

/**
 * Deterministic stratified sample of ~n measured artifacts: every 64px-floor
 * case is always included (the AC says the floor is in the sample), the rest
 * spread across ascending-size order at a fixed stride. No randomness — the
 * same corpus state yields the same sample.
 */
export function samplePlan(
  all: Array<{ artifactId: number; widthPx: number; heightPx: number }>,
  n = 100,
): number[] {
  const floor = all.filter((a) => a.widthPx < 65 || a.heightPx < 65);
  const rest = all
    .filter((a) => a.widthPx >= 65 && a.heightPx >= 65)
    .sort((a, b) => a.widthPx * a.heightPx - b.widthPx * b.heightPx || a.artifactId - b.artifactId);
  const want = Math.max(0, n - floor.length);
  const picked: typeof rest = [];
  if (rest.length > 0 && want > 0) {
    const stride = Math.max(1, Math.floor(rest.length / want));
    for (let i = 0; i < rest.length && picked.length < want; i += stride) picked.push(rest[i]!);
  }
  return [...floor, ...picked].map((a) => a.artifactId);
}

/** All measured artifacts, for the plan. Operator-time, production DB. */
export async function measuredArtifacts(): Promise<Array<{ artifactId: number; widthPx: number; heightPx: number }>> {
  const rows = await db
    .select({
      artifactId: artifactPrintAssetsTable.artifactId,
      widthPx: artifactPrintAssetsTable.widthPx,
      heightPx: artifactPrintAssetsTable.heightPx,
    })
    .from(artifactPrintAssetsTable)
    .where(isNotNull(artifactPrintAssetsTable.widthPx));
  return rows.filter((r): r is { artifactId: number; widthPx: number; heightPx: number } => r.widthPx != null && r.heightPx != null);
}

/**
 * Sweep the sampled artifacts across presets. Held bytes only; a sample row
 * whose bytes are missing or undecodable is emitted with null metrics
 * rather than dropped — silent truncation would misstate the corpus.
 */
export async function calibrationSweep(
  artifactIds: number[],
  storage: StorageAdapter,
  opts: {
    presets?: VtracerPreset[];
    vectorizeImpl?: VectorizeImpl;
    renderImpl?: RenderImpl;
  } = {},
): Promise<CalibrationRow[]> {
  const presets = opts.presets ?? (Object.keys(VTRACER_PRESETS) as VtracerPreset[]).slice(0, 3);
  const out: CalibrationRow[] = [];
  for (const artifactId of artifactIds) {
    const [row] = await db
      .select()
      .from(artifactPrintAssetsTable)
      .where(eq(artifactPrintAssetsTable.artifactId, artifactId))
      .limit(1);
    const held = row?.storageKey ? await storage.get(row.storageKey) : null;
    const decoded = held ? decodeImage(held.bytes) : null;
    if (!decoded) {
      out.push({
        artifactId, preset: "-", widthPx: row?.widthPx ?? 0, heightPx: row?.heightPx ?? 0,
        colorBandCount: 0, ssim: null, meanDeltaE2000: null, pathCount: null, nodeCount: null, svgBytes: null,
        label: "",
      });
      continue;
    }
    const bands = colorBandCount(decoded.raster);
    for (const preset of presets) {
      let s: number | null = null, dE: number | null = null;
      let pathCount: number | null = null, nodeCount: number | null = null, svgBytes: number | null = null;
      try {
        const v = await vectorize(encodePng(decoded.raster), preset, opts.vectorizeImpl);
        pathCount = v.stats.pathCount; nodeCount = v.stats.nodeCount; svgBytes = v.stats.svgBytes;
        if (opts.renderImpl) {
          const rendered = await opts.renderImpl(v.svg, decoded.raster.width, decoded.raster.height);
          s = ssim(decoded.raster, rendered);
          dE = meanDeltaE2000(decoded.raster, rendered, 4);
        }
      } catch {
        // tool unavailable for this row: metrics stay null, the row still counts
      }
      out.push({
        artifactId, preset, widthPx: decoded.raster.width, heightPx: decoded.raster.height,
        colorBandCount: bands, ssim: s, meanDeltaE2000: dE, pathCount, nodeCount, svgBytes, label: "",
      });
    }
  }
  return out;
}

const CSV_HEADER =
  "artifact_id,preset,width_px,height_px,color_band_count,ssim,mean_delta_e2000,path_count,node_count,svg_bytes,label";

export function toCsv(rows: CalibrationRow[]): string {
  const lines = rows.map((r) =>
    [
      r.artifactId, r.preset, r.widthPx, r.heightPx, r.colorBandCount,
      r.ssim ?? "", r.meanDeltaE2000 ?? "", r.pathCount ?? "", r.nodeCount ?? "", r.svgBytes ?? "", r.label ?? "",
    ].join(","),
  );
  return [CSV_HEADER, ...lines].join("\n") + "\n";
}

export function parseLabelledCsv(csv: string): CalibrationRow[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines[0] !== CSV_HEADER) throw new Error("not a calibration CSV (header mismatch)");
  return lines.slice(1).map((line) => {
    const c = line.split(",");
    const numOrNull = (v: string | undefined): number | null => (v === "" || v == null ? null : Number(v));
    const label = (c[10] ?? "") as GateVerdict | "";
    if (label !== "" && !["pass", "needs_review", "fail"].includes(label)) {
      throw new Error(`bad label '${label}' — pass | needs_review | fail`);
    }
    return {
      artifactId: Number(c[0]), preset: c[1] ?? "-", widthPx: Number(c[2]), heightPx: Number(c[3]),
      colorBandCount: Number(c[4]), ssim: numOrNull(c[5]), meanDeltaE2000: numOrNull(c[6]),
      pathCount: numOrNull(c[7]), nodeCount: numOrNull(c[8]), svgBytes: numOrNull(c[9]), label,
    };
  });
}

/** The verdict the thresholds would give a labelled row (metric half only). */
export function verdictFor(row: CalibrationRow, t: Thresholds): GateVerdict {
  if (row.widthPx < 65 || row.heightPx < 65) return "fail";
  if (row.ssim == null || row.meanDeltaE2000 == null) return "needs_review";
  if (row.ssim >= t.ssimPass && row.meanDeltaE2000 <= t.deltaEPass) return "pass";
  if (row.ssim >= t.ssimReview && row.meanDeltaE2000 <= t.deltaEReview) return "needs_review";
  return "fail";
}

/** Fraction of labelled rows the thresholds reproduce. */
export function agreement(rows: CalibrationRow[], t: Thresholds): number {
  const labelled = rows.filter((r) => !!r.label);
  if (labelled.length === 0) return 0;
  const hits = labelled.filter((r) => verdictFor(r, t) === r.label).length;
  return hits / labelled.length;
}

/**
 * Derive thresholds from a labelled run: a deterministic grid search over
 * candidate cut points (the observed metric values themselves), maximizing
 * agreement; ties break toward the STRICTER thresholds, because the cost of
 * passing a bad print is a customer holding it.
 */
export function deriveThresholds(rows: CalibrationRow[]): Thresholds {
  const labelled = rows.filter((r) => !!r.label && r.ssim != null && r.meanDeltaE2000 != null);
  if (labelled.length < 10) {
    throw new Error(`only ${labelled.length} labelled rows with metrics — label the CSV first (need ≥10)`);
  }
  const ssims = [...new Set(labelled.map((r) => r.ssim!))].sort((a, b) => a - b);
  const dEs = [...new Set(labelled.map((r) => r.meanDeltaE2000!))].sort((a, b) => a - b);
  let best: Thresholds = { ...FALLBACK_THRESHOLDS, calibrated: true };
  let bestScore = -1;
  for (const sp of ssims) {
    for (const sr of ssims) {
      if (sr > sp) continue; // review floor cannot exceed the pass floor
      for (const dp of dEs) {
        for (const dr of dEs) {
          if (dr < dp) continue;
          const t: Thresholds = {
            calibrated: true, ssimPass: sp, ssimReview: sr, deltaEPass: dp, deltaEReview: dr,
            flatArtMaxBands: FALLBACK_THRESHOLDS.flatArtMaxBands,
          };
          const score = agreement(labelled, t);
          const stricter =
            score === bestScore &&
            (t.ssimPass > best.ssimPass ||
              (t.ssimPass === best.ssimPass && t.deltaEPass < best.deltaEPass));
          if (score > bestScore || stricter) {
            bestScore = score;
            best = t;
          }
        }
      }
    }
  }
  return best;
}

/** The headline number: the corpus's flat-art fraction. */
export function flatArtFraction(rows: CalibrationRow[], maxBands = FALLBACK_THRESHOLDS.flatArtMaxBands): number {
  const perArtifact = new Map<number, number>();
  for (const r of rows) perArtifact.set(r.artifactId, r.colorBandCount);
  const ids = [...perArtifact.values()];
  if (ids.length === 0) return 0;
  return ids.filter((b) => b > 0 && b <= maxBands).length / ids.length;
}

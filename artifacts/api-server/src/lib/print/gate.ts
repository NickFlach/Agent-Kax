import type { Raster } from "./raster";
import type { SvgStats } from "./vectorize";

/**
 * print/gate.ts — the print-fitness candidacy gate, REPORT-ONLY (#296).
 *
 * Four metric families over (source raster, vectorized candidate):
 *   1. SSIM              — structural fidelity of the re-rendered candidate
 *   2. mean ΔE2000       — perceptual colour error (CIEDE2000, the real one)
 *   3. path / node count — geometric complexity of the traced SVG
 *   4. colour-band count — how flat the art actually is
 * plus the SVG byte size, and a verdict: pass | needs_review | fail.
 *
 * REPORT-ONLY is structural: this module computes and returns; it has no
 * imports from the product pipeline and nothing here can block a listing.
 * The thresholds are the UNCALIBRATED GUESSES the research pass warned
 * about — they live here as named constants precisely so the calibration
 * issue (#297) can move them to config without touching logic.
 */

export type GateVerdict = "pass" | "needs_review" | "fail";

export interface GateMetrics {
  ssim: number | null;
  meanDeltaE2000: number | null;
  pathCount: number | null;
  nodeCount: number | null;
  svgBytes: number | null;
  colorBandCount: number;
  verdict: GateVerdict;
  /** Machine-readable, stable — the 64×64 floor emits source_below_floor. */
  reason: string | null;
}

/** Below this edge length a source cannot candidate at all (#296 AC). */
export const SOURCE_FLOOR_PX = 65;

// Uncalibrated guesses (#297 owns making these real). Named, not inline.
export const GUESS_SSIM_PASS = 0.93;
export const GUESS_SSIM_REVIEW = 0.85;
export const GUESS_DELTA_E_PASS = 4;
export const GUESS_DELTA_E_REVIEW = 8;
export const GUESS_MAX_BAND_COUNT_FLAT = 32;

// ---------------------------------------------------------------------------
// SSIM — grayscale, 8×8 windows, the standard constants.
// ---------------------------------------------------------------------------

function toGray(r: Raster): Float64Array {
  const g = new Float64Array(r.width * r.height);
  for (let i = 0; i < g.length; i++) {
    g[i] = 0.299 * r.data[i * 4]! + 0.587 * r.data[i * 4 + 1]! + 0.114 * r.data[i * 4 + 2]!;
  }
  return g;
}

export function ssim(a: Raster, b: Raster): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error("ssim requires equal dimensions — resize the candidate to the source first");
  }
  const ga = toGray(a), gb = toGray(b);
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  const W = 8;
  let sum = 0, windows = 0;
  for (let y0 = 0; y0 + W <= a.height; y0 += W) {
    for (let x0 = 0; x0 + W <= a.width; x0 += W) {
      let ma = 0, mb = 0;
      for (let y = y0; y < y0 + W; y++) {
        for (let x = x0; x < x0 + W; x++) {
          ma += ga[y * a.width + x]!;
          mb += gb[y * a.width + x]!;
        }
      }
      const n = W * W;
      ma /= n; mb /= n;
      let va = 0, vb = 0, cov = 0;
      for (let y = y0; y < y0 + W; y++) {
        for (let x = x0; x < x0 + W; x++) {
          const da = ga[y * a.width + x]! - ma;
          const db = gb[y * a.width + x]! - mb;
          va += da * da; vb += db * db; cov += da * db;
        }
      }
      va /= n - 1; vb /= n - 1; cov /= n - 1;
      sum += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      windows++;
    }
  }
  return windows > 0 ? sum / windows : 1;
}

// ---------------------------------------------------------------------------
// CIEDE2000 — the real formula, not ΔE76.
// ---------------------------------------------------------------------------

function srgbToLab(r8: number, g8: number, b8: number): [number, number, number] {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const r = lin(r8), g = lin(g8), b = lin(b8);
  // sRGB D65 → XYZ
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function deltaE2000(lab1: [number, number, number], lab2: [number, number, number]): number {
  const [L1, a1, b1] = lab1, [L2, a2, b2] = lab2;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h1p = C1p === 0 ? 0 : ((Math.atan2(b1, a1p) * 180) / Math.PI + 360) % 360;
  const h2p = C2p === 0 ? 0 : ((Math.atan2(b2, a2p) * 180) / Math.PI + 360) % 360;
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI) / 360);
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbp += h1p + h2p < 360 ? 360 : -360;
    hbp /= 2;
  }
  const T =
    1 -
    0.17 * Math.cos(((hbp - 30) * Math.PI) / 180) +
    0.24 * Math.cos((2 * hbp * Math.PI) / 180) +
    0.32 * Math.cos(((3 * hbp + 6) * Math.PI) / 180) -
    0.2 * Math.cos(((4 * hbp - 63) * Math.PI) / 180);
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin((2 * dTheta * Math.PI) / 180) * Rc;
  return Math.sqrt(
    (dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh),
  );
}

/** Mean CIEDE2000 over all pixels (sampled every `stride`th for large images). */
export function meanDeltaE2000(a: Raster, b: Raster, stride = 1): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error("meanDeltaE2000 requires equal dimensions");
  }
  let sum = 0, n = 0;
  for (let i = 0; i < a.width * a.height; i += stride) {
    sum += deltaE2000(
      srgbToLab(a.data[i * 4]!, a.data[i * 4 + 1]!, a.data[i * 4 + 2]!),
      srgbToLab(b.data[i * 4]!, b.data[i * 4 + 1]!, b.data[i * 4 + 2]!),
    );
    n++;
  }
  return n > 0 ? sum / n : 0;
}

// ---------------------------------------------------------------------------
// Colour bands — how flat the art is.
// ---------------------------------------------------------------------------

/**
 * Distinct colours after 5-bit-per-channel bucketing. Flat art lands in the
 * tens; photographs land in the thousands. The single most important unknown
 * (the corpus's flat-art fraction) is a distribution of exactly this number.
 */
export function colorBandCount(r: Raster): number {
  const set = new Set<number>();
  for (let i = 0; i < r.width * r.height; i++) {
    set.add(
      ((r.data[i * 4]! >> 3) << 10) | ((r.data[i * 4 + 1]! >> 3) << 5) | (r.data[i * 4 + 2]! >> 3),
    );
  }
  return set.size;
}

// ---------------------------------------------------------------------------
// The verdict.
// ---------------------------------------------------------------------------

export function judge(input: {
  source: Raster;
  /** The vectorized candidate re-rendered at source dimensions, if the tool ran. */
  rendered?: Raster | null;
  svgStats?: SvgStats | null;
}): GateMetrics {
  const bands = colorBandCount(input.source);
  // The floor first: a 64×64-class source fails with its reason and no
  // amount of tracing changes that (#296 AC).
  if (input.source.width < SOURCE_FLOOR_PX || input.source.height < SOURCE_FLOOR_PX) {
    return {
      ssim: null,
      meanDeltaE2000: null,
      pathCount: input.svgStats?.pathCount ?? null,
      nodeCount: input.svgStats?.nodeCount ?? null,
      svgBytes: input.svgStats?.svgBytes ?? null,
      colorBandCount: bands,
      verdict: "fail",
      reason: "source_below_floor",
    };
  }
  if (!input.rendered || !input.svgStats) {
    // Honest partial: SVG stats can exist without a rendered candidate
    // (the rasterizer is #298's stage) and vice versa. Either hole means a
    // human looks; the reason names WHICH tool is missing.
    return {
      ssim: null,
      meanDeltaE2000: null,
      pathCount: input.svgStats?.pathCount ?? null,
      nodeCount: input.svgStats?.nodeCount ?? null,
      svgBytes: input.svgStats?.svgBytes ?? null,
      colorBandCount: bands,
      verdict: "needs_review",
      reason: input.svgStats ? "renderer_unavailable" : "vectorizer_unavailable",
    };
  }
  const s = ssim(input.source, input.rendered);
  const dE = meanDeltaE2000(input.source, input.rendered, 4);
  let verdict: GateVerdict;
  let reason: string | null = null;
  if (s >= GUESS_SSIM_PASS && dE <= GUESS_DELTA_E_PASS) {
    verdict = "pass";
  } else if (s >= GUESS_SSIM_REVIEW && dE <= GUESS_DELTA_E_REVIEW) {
    verdict = "needs_review";
    reason = "between_thresholds";
  } else {
    verdict = "fail";
    reason = s < GUESS_SSIM_REVIEW ? "ssim_below_floor" : "delta_e_above_ceiling";
  }
  return {
    ssim: s,
    meanDeltaE2000: dE,
    pathCount: input.svgStats.pathCount,
    nodeCount: input.svgStats.nodeCount,
    svgBytes: input.svgStats.svgBytes,
    colorBandCount: bands,
    verdict,
    reason,
  };
}

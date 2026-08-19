import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { VTRACER_PINNED_COMMIT, assertToolAllowed } from "./allowlist";

const execFileP = promisify(execFile);

/**
 * print/vectorize.ts — VTracer as an OPERATOR-ARMED external stage (#296).
 *
 * VTracer is a Rust binary and the ADR bans native dependencies inside the
 * bundled deploy, so it is invoked as an external tool the operator builds
 * from the PINNED commit (VTRACER_PINNED_COMMIT in allowlist.ts) and
 * registers by sha256:
 *
 *   KAX_VTRACER_BIN     — path to the binary
 *   KAX_VTRACER_SHA256  — sha256(s) of the audited binary
 *
 * Every invocation re-verifies the hash against the allowlist FIRST — a
 * swapped binary is a different program and does not run. Unset env means
 * vectorization is honestly unavailable (the gate reports it as such and
 * gates nothing); tests inject a fake VectorizeImpl and never exec.
 */

export interface SvgStats {
  pathCount: number;
  nodeCount: number;
  svgBytes: number;
  colorCount: number;
}

export interface VectorizeResult {
  svg: string;
  stats: SvgStats;
  preset: string;
}

export type VectorizeImpl = (pngBytes: Uint8Array, preset: VtracerPreset) => Promise<string>;

/** The 2–3 presets the calibration run (#297) sweeps. */
export const VTRACER_PRESETS = {
  flat: ["--colormode", "color", "--mode", "polygon", "--filter_speckle", "4"],
  detailed: ["--colormode", "color", "--mode", "spline", "--filter_speckle", "2"],
  poster: ["--colormode", "color", "--mode", "spline", "--filter_speckle", "8", "--color_precision", "5"],
} as const;
export type VtracerPreset = keyof typeof VTRACER_PRESETS;

export function vectorizerConfigured(): boolean {
  return !!process.env["KAX_VTRACER_BIN"];
}

/** Parse the stats the gate records from raw SVG text. Pure. */
export function svgStats(svg: string): SvgStats {
  const pathCount = (svg.match(/<path\b/g) ?? []).length;
  // Nodes ≈ drawing commands across all path data attributes.
  let nodeCount = 0;
  for (const m of svg.matchAll(/\sd="([^"]*)"/g)) {
    nodeCount += (m[1]!.match(/[MLHVCSQTAZmlhvcsqtaz]/g) ?? []).length;
  }
  const colors = new Set<string>();
  for (const m of svg.matchAll(/fill="([^"]+)"/g)) colors.add(m[1]!.toLowerCase());
  return { pathCount, nodeCount, svgBytes: Buffer.byteLength(svg, "utf8"), colorCount: colors.size };
}

/** The production impl: allowlist-verified exec of the pinned-commit build. */
const execVtracer: VectorizeImpl = async (pngBytes, preset) => {
  const bin = process.env["KAX_VTRACER_BIN"];
  if (!bin) throw new Error("vectorizer not configured (KAX_VTRACER_BIN unset)");
  assertToolAllowed(bin); // sha256 must be registered — every invocation
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kax-vtracer-"));
  const inPath = path.join(dir, "in.png");
  const outPath = path.join(dir, "out.svg");
  try {
    await fs.writeFile(inPath, pngBytes);
    await execFileP(bin, ["--input", inPath, "--output", outPath, ...VTRACER_PRESETS[preset]], {
      timeout: 120_000,
    });
    return await fs.readFile(outPath, "utf8");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
};

/**
 * Vectorize PNG bytes with one preset. `impl` is injectable for tests;
 * production uses the allowlist-verified exec of the pinned build
 * (VTRACER_PINNED_COMMIT — the operator builds exactly that commit).
 */
export async function vectorize(
  pngBytes: Uint8Array,
  preset: VtracerPreset,
  impl: VectorizeImpl = execVtracer,
): Promise<VectorizeResult> {
  const svg = await impl(pngBytes, preset);
  return { svg, stats: svgStats(svg), preset };
}

export { VTRACER_PINNED_COMMIT };

import type { Raster } from "./raster";

/**
 * print/resample.ts — deterministic Lanczos-3 resize + mild unsharp (#295).
 *
 * No model, no randomness, no external tool: separable Lanczos-3 over RGBA
 * with precomputed per-axis kernels, then a mild unsharp mask (3×3 box blur
 * difference, amount 0.3, integer-clamped). Identical input → identical
 * RGBA output on any IEEE-754 engine; the fixture hash downstream pins the
 * RGBA identity for exactly that reason (a PNG-byte hash would be a test of
 * zlib's version, not of this code).
 *
 * ≤1.1x is the "trivially solved" band from the print-fitness findings —
 * the 4in sticker's 1024→1113 (1.087x) sits inside it, which is why this
 * ships model-free while bigger factors wait behind the gate.
 */

export const RESAMPLE_PIPELINE_VERSION = "resample-v1";

function lanczos3(x: number): number {
  if (x === 0) return 1;
  const ax = Math.abs(x);
  if (ax >= 3) return 0;
  const pix = Math.PI * x;
  return (3 * Math.sin(pix) * Math.sin(pix / 3)) / (pix * pix);
}

interface AxisKernel {
  /** For each output coordinate: first source index and the weights. */
  starts: Int32Array;
  weights: Float64Array;
  taps: number;
}

function buildKernel(srcSize: number, dstSize: number): AxisKernel {
  const scale = srcSize / dstSize;
  const support = scale > 1 ? 3 * scale : 3;
  const taps = Math.ceil(support * 2) + 1;
  const starts = new Int32Array(dstSize);
  const weights = new Float64Array(dstSize * taps);
  for (let o = 0; o < dstSize; o++) {
    const center = (o + 0.5) * scale - 0.5;
    const start = Math.floor(center - support);
    starts[o] = start;
    let sum = 0;
    for (let t = 0; t < taps; t++) {
      const s = start + t;
      const w = lanczos3((s - center) / (scale > 1 ? scale : 1));
      weights[o * taps + t] = w;
      sum += w;
    }
    if (sum !== 0) {
      for (let t = 0; t < taps; t++) weights[o * taps + t]! /= sum;
    }
  }
  return { starts, weights, taps };
}

function clampIndex(v: number, max: number): number {
  return v < 0 ? 0 : v >= max ? max - 1 : v;
}

/** Separable Lanczos-3 resize. */
export function resizeLanczos(src: Raster, dstW: number, dstH: number): Raster {
  const kx = buildKernel(src.width, dstW);
  const ky = buildKernel(src.height, dstH);

  // Horizontal pass into a float intermediate (rows: src.height, cols: dstW).
  const mid = new Float64Array(src.height * dstW * 4);
  for (let y = 0; y < src.height; y++) {
    for (let ox = 0; ox < dstW; ox++) {
      let r = 0, g = 0, b = 0, a = 0;
      const start = kx.starts[ox]!;
      for (let t = 0; t < kx.taps; t++) {
        const w = kx.weights[ox * kx.taps + t]!;
        if (w === 0) continue;
        const sx = clampIndex(start + t, src.width);
        const o = (y * src.width + sx) * 4;
        r += w * src.data[o]!;
        g += w * src.data[o + 1]!;
        b += w * src.data[o + 2]!;
        a += w * src.data[o + 3]!;
      }
      const mo = (y * dstW + ox) * 4;
      mid[mo] = r; mid[mo + 1] = g; mid[mo + 2] = b; mid[mo + 3] = a;
    }
  }

  // Vertical pass into the output.
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  for (let oy = 0; oy < dstH; oy++) {
    const start = ky.starts[oy]!;
    for (let x = 0; x < dstW; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let t = 0; t < ky.taps; t++) {
        const w = ky.weights[oy * ky.taps + t]!;
        if (w === 0) continue;
        const sy = clampIndex(start + t, src.height);
        const mo = (sy * dstW + x) * 4;
        r += w * mid[mo]!;
        g += w * mid[mo + 1]!;
        b += w * mid[mo + 2]!;
        a += w * mid[mo + 3]!;
      }
      const oo = (oy * dstW + x) * 4;
      out[oo] = Math.round(r);
      out[oo + 1] = Math.round(g);
      out[oo + 2] = Math.round(b);
      out[oo + 3] = Math.round(a);
    }
  }
  return { width: dstW, height: dstH, data: out };
}

/** Mild unsharp: out = src + amount * (src - 3×3 box blur), clamped. */
export function unsharpMild(src: Raster, amount = 0.3): Raster {
  const { width, height } = src;
  const out = new Uint8ClampedArray(src.data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 4; c++) {
        const o = (y * width + x) * 4 + c;
        if (c === 3) { out[o] = src.data[o]!; continue; } // alpha untouched
        let sum = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy < 0 || yy >= height || xx < 0 || xx >= width) continue;
            sum += src.data[(yy * width + xx) * 4 + c]!;
            n++;
          }
        }
        const blur = sum / n;
        out[o] = Math.round(src.data[o]! + amount * (src.data[o]! - blur));
      }
    }
  }
  return { width, height, data: out };
}

/** The #295 production step: Lanczos to target, then the mild unsharp. */
export function resampleForPrint(src: Raster, dstW: number, dstH: number): Raster {
  return unsharpMild(resizeLanczos(src, dstW, dstH));
}

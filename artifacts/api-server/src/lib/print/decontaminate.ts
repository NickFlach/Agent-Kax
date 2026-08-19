import type { Raster } from "./raster";

/**
 * print/decontaminate.ts — undo what JPEG did to flat art (#293).
 *
 * The finding this implements (print-fitness research pass, 2026-08-16):
 * the corpus is JPEG behind .png filenames, and 4:2:0 chroma subsampling
 * stores colour at half resolution — flat-colour illustration is nothing
 * but colour boundaries, precisely where subsampling does its worst.
 * Upscalers sharpen the ringing; tracers trace it as real geometry.
 * Decontamination must run BEFORE anything else.
 *
 * The treatment: K=16 median-cut palette quantization (collapses ringing
 * halos back into the flat fields they escaped from) followed by a 3×3
 * majority speckle filter on palette indices (kills the isolated wrong-
 * palette pixels quantization leaves at boundary corners).
 *
 * Everything here is DETERMINISTIC by construction — integer arithmetic,
 * stable sorts with total tie-breaks — because a derived master's identity
 * is its sha256 and a nondeterministic pipeline would defeat the
 * (parent_sha256, pipeline_version, target) cache.
 */

export const DECONTAMINATE_K = 16;
export const DECONTAMINATE_PIPELINE_VERSION = "decon-v1";

interface Box {
  /** Pixel indices (into the sampled array) this box owns. */
  pixels: Uint32Array;
  rMin: number; rMax: number; gMin: number; gMax: number; bMin: number; bMax: number;
}

function boxRanges(colors: Uint8Array, pixels: Uint32Array): Omit<Box, "pixels"> {
  let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
  for (const p of pixels) {
    const o = p * 3;
    const r = colors[o]!, g = colors[o + 1]!, b = colors[o + 2]!;
    if (r < rMin) rMin = r; if (r > rMax) rMax = r;
    if (g < gMin) gMin = g; if (g > gMax) gMax = g;
    if (b < bMin) bMin = b; if (b > bMax) bMax = b;
  }
  return { rMin, rMax, gMin, gMax, bMin, bMax };
}

/**
 * Median-cut to K representative colours. Deterministic: the box with the
 * largest (range, then population, then creation order) splits next; the
 * split channel is the widest (ties r>g>b); pixels sort by that channel
 * with the pixel index as the total tie-break.
 */
export function medianCutPalette(raster: Raster, k = DECONTAMINATE_K): Array<[number, number, number]> {
  const n = raster.width * raster.height;
  const colors = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = raster.data[i * 4]!;
    colors[i * 3 + 1] = raster.data[i * 4 + 1]!;
    colors[i * 3 + 2] = raster.data[i * 4 + 2]!;
  }
  const all = new Uint32Array(n);
  for (let i = 0; i < n; i++) all[i] = i;
  const boxes: Box[] = [{ pixels: all, ...boxRanges(colors, all) }];

  while (boxes.length < k) {
    // Pick the box to split: widest channel range, then population.
    let best = -1, bestScore = -1;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i]!;
      const range = Math.max(b.rMax - b.rMin, b.gMax - b.gMin, b.bMax - b.bMin);
      if (b.pixels.length < 2 || range === 0) continue;
      const score = range * 1_000_000_000 + b.pixels.length;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best === -1) break; // nothing splittable — fewer than k distinct colours
    const box = boxes[best]!;
    const rr = box.rMax - box.rMin, gr = box.gMax - box.gMin, br = box.bMax - box.bMin;
    const ch = rr >= gr && rr >= br ? 0 : gr >= br ? 1 : 2;
    const sorted = Array.from(box.pixels).sort((a, b2) => {
      const d = colors[a * 3 + ch]! - colors[b2 * 3 + ch]!;
      return d !== 0 ? d : a - b2; // total order — determinism
    });
    const mid = sorted.length >> 1;
    const lo = Uint32Array.from(sorted.slice(0, mid));
    const hi = Uint32Array.from(sorted.slice(mid));
    boxes.splice(best, 1, { pixels: lo, ...boxRanges(colors, lo) }, { pixels: hi, ...boxRanges(colors, hi) });
  }

  return boxes.map((b) => {
    let r = 0, g = 0, bl = 0;
    for (const p of b.pixels) {
      r += colors[p * 3]!; g += colors[p * 3 + 1]!; bl += colors[p * 3 + 2]!;
    }
    const c = b.pixels.length || 1;
    return [Math.round(r / c), Math.round(g / c), Math.round(bl / c)] as [number, number, number];
  });
}

function nearestIndex(palette: Array<[number, number, number]>, r: number, g: number, b: number): number {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const [pr, pg, pb] = palette[i]!;
    const d = (pr - r) * (pr - r) + (pg - g) * (pg - g) + (pb - b) * (pb - b);
    if (d < bestD) { bestD = d; best = i; } // strict < keeps the lowest index on ties
  }
  return best;
}

/**
 * The full treatment: quantize to the K-colour palette, then one pass of a
 * 3×3 majority filter over palette INDICES (ties: the lowest index wins —
 * palette order is deterministic, so the filter is too). Alpha passes
 * through untouched; the corpus is opaque and inventing alpha would be a
 * change of content, not a cleanup.
 */
export function decontaminate(raster: Raster, k = DECONTAMINATE_K): Raster {
  const { width, height } = raster;
  const palette = medianCutPalette(raster, k);
  const idx = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    idx[i] = nearestIndex(palette, raster.data[i * 4]!, raster.data[i * 4 + 1]!, raster.data[i * 4 + 2]!);
  }

  // The speckle filter: a pixel whose palette index appears ONLY in itself
  // within its 3×3 neighbourhood is a speckle and takes the neighbourhood's
  // most common index (ties: lowest). A plain majority vote would also erode
  // 1px strokes — a 3-count line against a 6-count field loses every vote —
  // so the filter only ever touches genuinely isolated pixels.
  const voted = new Uint8Array(width * height);
  const counts = new Uint16Array(k);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const self = idx[y * width + x]!;
      counts.fill(0);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy < 0 || yy >= height || xx < 0 || xx >= width) continue;
          counts[idx[yy * width + xx]!]!++;
        }
      }
      if (counts[self]! > 1) {
        voted[y * width + x] = self;
        continue;
      }
      let bestI = self, bestC = 0;
      for (let i = 0; i < k; i++) {
        if (i === self) continue;
        if (counts[i]! > bestC) { bestC = counts[i]!; bestI = i; }
      }
      voted[y * width + x] = bestC > 0 ? bestI : self;
    }
  }

  const out = new Uint8ClampedArray(raster.data.length);
  for (let i = 0; i < width * height; i++) {
    const [r, g, b] = palette[voted[i]!] ?? [0, 0, 0];
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = raster.data[i * 4 + 3]!;
  }
  return { width, height, data: out };
}

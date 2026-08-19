import crypto from "node:crypto";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { parseImageHeader } from "../printAsset";

/**
 * print/raster.ts — decode/encode between bytes and RGBA rasters (#293/#295).
 *
 * Pure-JS codecs ON PURPOSE (jpeg-js, pngjs): the ADR bans native deps in
 * the bundled deploy (`sharp` sits in esbuild externals precisely so it can
 * never be imported), and both of these bundle cleanly. WebP has no
 * pure-JS decoder worth trusting, so it is refused honestly — the corpus is
 * JPEG-behind-.png, which is the case that matters (#293's research pass).
 *
 * The MIME truth rule: the format is what parseImageHeader SNIFFS from the
 * bytes, never what the filename claims. The corpus stores JPEG bytes behind
 * `.png` names; believing the extension is how 4:2:0 chroma ringing gets
 * upscaled as if it were clean flat art.
 */

export interface Raster {
  width: number;
  height: number;
  /** RGBA, row-major, 4 bytes per pixel. */
  data: Uint8ClampedArray;
}

export type SniffedFormat = "png" | "jpeg";

export function decodeImage(bytes: Uint8Array): { raster: Raster; sniffedFormat: SniffedFormat } | null {
  const header = parseImageHeader(bytes);
  if (!header) return null;
  try {
    if (header.format === "png") {
      const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
      return {
        raster: {
          width: png.width,
          height: png.height,
          data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length),
        },
        sniffedFormat: "png",
      };
    }
    if (header.format === "jpeg") {
      const out = jpeg.decode(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length), {
        useTArray: true,
        maxMemoryUsageInMB: 512,
        maxResolutionInMP: 100,
      });
      return {
        raster: {
          width: out.width,
          height: out.height,
          data: new Uint8ClampedArray(out.data.buffer, out.data.byteOffset, out.data.length),
        },
        sniffedFormat: "jpeg",
      };
    }
  } catch {
    return null; // corrupt body behind a valid header — refusal, not a guess
  }
  return null; // webp: no pure-JS decoder; honest refusal
}

/**
 * Deterministic PNG encode: every knob pinned (filter NONE, deflate level 9,
 * default strategy), so the same raster produces the same bytes on the same
 * zlib. Cross-zlib-version byte identity is NOT promised — which is why
 * fixture hashes downstream pin the RGBA, not the deflate stream.
 */
export function encodePng(r: Raster): Uint8Array {
  const png = new PNG({ width: r.width, height: r.height });
  Buffer.from(r.data.buffer, r.data.byteOffset, r.data.length).copy(png.data);
  const out = PNG.sync.write(png, { deflateLevel: 9, filterType: 0 });
  return new Uint8Array(out.buffer, out.byteOffset, out.length);
}

/** sha256 of the raw RGBA — the version-stable identity of a raster. */
export function rasterSha256(r: Raster): string {
  return crypto
    .createHash("sha256")
    .update(`${r.width}x${r.height}:`)
    .update(Buffer.from(r.data.buffer, r.data.byteOffset, r.data.length))
    .digest("hex");
}

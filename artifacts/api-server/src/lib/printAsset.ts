import crypto from "node:crypto";
import { db } from "@workspace/db";
import { artifactsTable, artifactPrintAssetsTable, type ArtifactPrintAsset } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

/**
 * printAsset.ts — measure the bytes behind an artifact's public URL (#254).
 *
 * CORPUS POLICY: LAZY, ON DEMAND ONLY. No bulk backfill, no scheduler. The
 * upstream host aggressively 429s (creatorDirectory.ts needs 6 attempts with
 * exponential backoff and honours Retry-After), most of the corpus is not
 * commercially eligible, and a backfilled measurement goes stale against a
 * URL KAX does not control. Measure when a merchant asks about ONE artifact.
 *
 * Reads artifacts.public_url and NEVER thumbnail_url: harvesterJob.ts writes
 * `thumbnailUrl: pa.thumbnail_url ?? pa.public_url`, so the thumbnail IS
 * often the full asset — and where it is not, measuring it would approve a
 * print the source cannot support.
 *
 * Dimensions come from a PURE-JS header parse (PNG IHDR, JPEG SOFn, WebP
 * VP8/VP8L/VP8X). Do not add `sharp`: it appears only in build.mjs's esbuild
 * externals and would be a native dependency in a bundled deploy. The body
 * streams through a sha256 exactly once and is then discarded — no object
 * storage here.
 */

/** Same shape as routes/arcade.ts's SSRF guard; the cap is print-sized. */
const ALLOWED_HOST_SUFFIXES = [".supabase.co", ".openclawcity.ai", ".openbotcity.ai", ".ninja-portal.com"];
/** 32 MB — deliberately distinct from arcade's FRAME_SIZE_CAP. */
export const PRINT_ASSET_BYTE_CAP = 32 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
/** Header bytes retained for dimension + ICC detection; profiles live early. */
const HEAD_RETAIN = 64 * 1024;

export type FailureReason = "not_a_url" | "sentinel" | "fetch_failed" | "too_large" | "decode_failed";

export interface ParsedImageHeader {
  format: "png" | "jpeg" | "webp";
  widthPx: number;
  heightPx: number;
  hasAlpha: boolean;
  /** True when an embedded ICC profile was seen in the retained head bytes. */
  hasIccProfile: boolean;
}

function u32be(b: Uint8Array, o: number): number {
  return (b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!;
}
function u16be(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!;
}
function u16le(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8);
}
function u24le(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
}
function ascii(b: Uint8Array, o: number, n: number): string {
  return Buffer.from(b.subarray(o, o + n)).toString("latin1");
}

/**
 * Parse dimensions/format/alpha from the leading bytes of an image. Returns
 * null when the bytes are not a recognisable, intact header — the caller
 * records that as decode_failed rather than guessing.
 */
export function parseImageHeader(bytes: Uint8Array): ParsedImageHeader | null {
  // ---- PNG: 8-byte signature, then the IHDR chunk is REQUIRED to be first.
  if (
    bytes.length >= 33 &&
    bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG" &&
    ascii(bytes, 12, 4) === "IHDR"
  ) {
    const widthPx = u32be(bytes, 16);
    const heightPx = u32be(bytes, 20);
    if (widthPx <= 0 || heightPx <= 0) return null;
    const colorType = bytes[25]!;
    // Alpha channel (4, 6) — a tRNS chunk can add transparency to the others,
    // but header-level truth is the channel, and tRNS would need a full scan.
    const hasAlpha = colorType === 4 || colorType === 6;
    const hasIccProfile = ascii(bytes, 0, Math.min(bytes.length, HEAD_RETAIN)).includes("iCCP");
    return { format: "png", widthPx, heightPx, hasAlpha, hasIccProfile };
  }

  // ---- JPEG: FFD8, then a marker walk to the first SOFn frame header.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let o = 2;
    let hasIccProfile = false;
    while (o + 4 <= bytes.length) {
      if (bytes[o] !== 0xff) return null; // lost sync — corrupt or truncated
      const marker = bytes[o + 1]!;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
      if (marker === 0xd9) return null; // EOI before any frame header
      const len = u16be(bytes, o + 2);
      if (len < 2 || o + 2 + len > bytes.length) return null; // truncated
      if (marker === 0xe2 && ascii(bytes, o + 4, 11) === "ICC_PROFILE") hasIccProfile = true;
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        const heightPx = u16be(bytes, o + 5);
        const widthPx = u16be(bytes, o + 7);
        if (widthPx <= 0 || heightPx <= 0) return null;
        return { format: "jpeg", widthPx, heightPx, hasAlpha: false, hasIccProfile };
      }
      o += 2 + len;
    }
    return null;
  }

  // ---- WebP: RIFF container, then VP8 (lossy) / VP8L (lossless) / VP8X.
  if (bytes.length >= 30 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    const chunk = ascii(bytes, 12, 4);
    const hasIccProfile = chunk === "VP8X" ? (bytes[20]! & 0x20) !== 0 : false;
    if (chunk === "VP8 " && bytes.length >= 30) {
      // Lossy: 3-byte frame tag, then the start code 9D 01 2A, then dims.
      if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
      const widthPx = u16le(bytes, 26) & 0x3fff;
      const heightPx = u16le(bytes, 28) & 0x3fff;
      if (widthPx <= 0 || heightPx <= 0) return null;
      return { format: "webp", widthPx, heightPx, hasAlpha: false, hasIccProfile };
    }
    if (chunk === "VP8L" && bytes.length >= 25) {
      if (bytes[20] !== 0x2f) return null; // lossless signature byte
      const b0 = bytes[21]!, b1 = bytes[22]!, b2 = bytes[23]!, b3 = bytes[24]!;
      const widthPx = 1 + (((b1 & 0x3f) << 8) | b0);
      const heightPx = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      const hasAlpha = ((b3 >> 4) & 1) === 1;
      return { format: "webp", widthPx, heightPx, hasAlpha, hasIccProfile };
    }
    if (chunk === "VP8X" && bytes.length >= 30) {
      const widthPx = 1 + u24le(bytes, 24);
      const heightPx = 1 + u24le(bytes, 27);
      const hasAlpha = (bytes[20]! & 0x10) !== 0;
      return { format: "webp", widthPx, heightPx, hasAlpha, hasIccProfile };
    }
    return null;
  }

  return null;
}

function hostAllowed(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    ALLOWED_HOST_SUFFIXES.some((s) => url.hostname === s.slice(1) || url.hostname.endsWith(s))
  );
}

export class ArtifactNotFound extends Error {}

/**
 * Measure one artifact's asset and upsert the receipt row. Success and
 * failure BOTH write a row — a refusal with a reason is a measurement too,
 * and the row is what stops the next caller re-fetching a known-bad URL.
 *
 * `fetchImpl` is injectable for tests; production callers pass nothing.
 */
export async function measureArtifactAsset(
  artifactId: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ArtifactPrintAsset> {
  const [artifact] = await db
    .select({ publicUrl: artifactsTable.publicUrl })
    .from(artifactsTable)
    .where(eq(artifactsTable.id, artifactId))
    .limit(1);
  if (!artifact) throw new ArtifactNotFound(`artifact ${artifactId} not found`);

  const url = artifact.publicUrl ?? "";
  const record = async (
    fields: Partial<Omit<ArtifactPrintAsset, "artifactId" | "createdAt">>,
  ): Promise<ArtifactPrintAsset> => {
    const values = {
      artifactId,
      sourceUrlAtFetch: url,
      fetchedAt: new Date(),
      ...fields,
    };
    const [row] = await db
      .insert(artifactPrintAssetsTable)
      .values(values)
      .onConflictDoUpdate({ target: artifactPrintAssetsTable.artifactId, set: values })
      .returning();
    return row!;
  };

  // OBC uses inline: sentinels for non-visual artifacts (showcase.ts) — a
  // text piece has no pixels and fetching the sentinel would 404 forever.
  if (/^inline:/i.test(url)) return record({ failureReason: "sentinel" });
  if (!/^https?:\/\//i.test(url)) return record({ failureReason: "not_a_url" });

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return record({ failureReason: "not_a_url" });
  }
  // SSRF guard, same shape routes/arcade.ts proved: https-only + host
  // allowlist, checked BEFORE any network I/O.
  if (!hostAllowed(parsed)) return record({ failureReason: "fetch_failed" });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const upstream = await fetchImpl(url, { signal: controller.signal, redirect: "follow" });
    if (!upstream.ok || !upstream.body) return record({ failureReason: "fetch_failed" });

    const hash = crypto.createHash("sha256");
    let byteSize = 0;
    let head: Uint8Array = new Uint8Array(0);
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      byteSize += value.length;
      if (byteSize > PRINT_ASSET_BYTE_CAP) {
        controller.abort();
        return record({ failureReason: "too_large" });
      }
      hash.update(value);
      if (head.length < HEAD_RETAIN) {
        const take = value.subarray(0, HEAD_RETAIN - head.length);
        const next = new Uint8Array(head.length + take.length);
        next.set(head);
        next.set(take, head.length);
        head = next;
      }
    }

    const header = parseImageHeader(head);
    if (!header) {
      return record({
        byteSize: BigInt(byteSize),
        sha256: hash.digest("hex"),
        failureReason: "decode_failed",
      });
    }
    return record({
      widthPx: header.widthPx,
      heightPx: header.heightPx,
      format: header.format,
      hasAlpha: header.hasAlpha,
      // Most OBC PNGs carry no ICC profile: color space is honestly unknown,
      // and downstream ASSUMES sRGB rather than claiming to know.
      colorSpace: header.hasIccProfile ? "embedded-icc" : null,
      assumedSrgb: !header.hasIccProfile,
      byteSize: BigInt(byteSize),
      sha256: hash.digest("hex"),
      failureReason: null,
    });
  } catch {
    return record({ failureReason: "fetch_failed" });
  } finally {
    clearTimeout(timer);
  }
}

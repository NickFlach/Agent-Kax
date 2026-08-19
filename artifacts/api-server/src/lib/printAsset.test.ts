/**
 * printAsset.test.ts — #254's acceptance criteria.
 *
 * The header parser is tested against constructed fixture bytes (no network,
 * no DB). The measurement path is DB-backed (runs in CI) with an injected
 * fetch, so "no fetch attempted" is a spy assertion rather than a hope.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@workspace/db";
import { artifactsTable } from "@workspace/db/schema";
import { inArray } from "drizzle-orm";
import { PRINT_ASSET_BYTE_CAP, measureArtifactAsset, parseImageHeader } from "./printAsset";
import { cleanupTestData, createTestAgent, createTestUser, makeTestId } from "../test-helpers";

// ---------------------------------------------------------------------------
// Fixture builders — real header layouts, minimal bodies.
// ---------------------------------------------------------------------------

function pngFixture(w: number, h: number, colorType = 6): Uint8Array {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // signature
  b.set([0, 0, 0, 13], 8); // IHDR length
  b.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  b[24] = 8; // bit depth
  b[25] = colorType;
  return b;
}

function jpegFixture(w: number, h: number, sof: number): Uint8Array {
  // FFD8, APP0 (JFIF), then the SOFn frame header carrying the dimensions.
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sofSeg = [0xff, sof, 0x00, 0x11, 0x08, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff,
    0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sofSeg]);
}

function webpLossyFixture(w: number, h: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  b.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  b.set([0x56, 0x50, 0x38, 0x20], 12); // "VP8 "
  b.set([0x9d, 0x01, 0x2a], 23); // start code
  b[26] = w & 0xff; b[27] = (w >> 8) & 0x3f;
  b[28] = h & 0xff; b[29] = (h >> 8) & 0x3f;
  return b;
}

describe("parseImageHeader (pure fixtures)", () => {
  it("reads PNG IHDR dimensions and the alpha channel", () => {
    const p = parseImageHeader(pngFixture(1024, 768, 6));
    expect(p).toEqual({ format: "png", widthPx: 1024, heightPx: 768, hasAlpha: true, hasIccProfile: false });
    expect(parseImageHeader(pngFixture(64, 64, 2))?.hasAlpha).toBe(false);
  });

  it("walks JPEG markers to SOF0 (baseline) and SOF2 (progressive)", () => {
    const base = parseImageHeader(jpegFixture(1024, 1024, 0xc0));
    expect(base).toMatchObject({ format: "jpeg", widthPx: 1024, heightPx: 1024, hasAlpha: false });
    const prog = parseImageHeader(jpegFixture(640, 480, 0xc2));
    expect(prog).toMatchObject({ format: "jpeg", widthPx: 640, heightPx: 480 });
  });

  it("reads a lossy WebP VP8 frame header", () => {
    const p = parseImageHeader(webpLossyFixture(900, 900));
    expect(p).toMatchObject({ format: "webp", widthPx: 900, heightPx: 900 });
  });

  it("returns null on a truncated file rather than guessing", () => {
    expect(parseImageHeader(pngFixture(1024, 768).subarray(0, 20))).toBeNull();
    expect(parseImageHeader(jpegFixture(1024, 1024, 0xc0).subarray(0, 10))).toBeNull();
    expect(parseImageHeader(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The measurement path (DB, in CI). fetch is injected: refusals must be
// proven by a spy that was never called, not by luck.
// ---------------------------------------------------------------------------

describe("measureArtifactAsset (DB)", () => {
  let agentId: number;
  const made: number[] = [];

  async function makeArtifact(publicUrl: string): Promise<number> {
    const [row] = await db
      .insert(artifactsTable)
      .values({
        externalId: makeTestId("print"),
        title: "print asset test",
        creatorName: "kax-test-creator",
        publicUrl,
        artifactType: "image",
        agentId,
      })
      .returning({ id: artifactsTable.id });
    made.push(row!.id);
    return row!.id;
  }

  const neverFetch: typeof fetch = () => {
    throw new Error("fetch must not be attempted for this case");
  };

  beforeAll(async () => {
    const user = await createTestUser({ emailLabel: "print" });
    agentId = (await createTestAgent(user.id, "print")).id;
  });

  afterAll(async () => {
    await db.delete(artifactsTable).where(inArray(artifactsTable.id, made));
    await cleanupTestData();
  });

  it("inline:text is a sentinel: recorded, and no fetch attempted", async () => {
    const id = await makeArtifact("inline:text");
    const row = await measureArtifactAsset(id, neverFetch);
    expect(row.failureReason).toBe("sentinel");
  });

  it("a non-URL is not_a_url: recorded, and no fetch attempted", async () => {
    const id = await makeArtifact("plainly not a url");
    const row = await measureArtifactAsset(id, neverFetch);
    expect(row.failureReason).toBe("not_a_url");
  });

  it("a non-allowlisted host is refused BEFORE any network I/O", async () => {
    const id = await makeArtifact("https://evil.example/asset.png");
    const row = await measureArtifactAsset(id, neverFetch);
    expect(row.failureReason).toBe("fetch_failed");
  });

  it("a response exceeding the cap aborts and records too_large", async () => {
    const id = await makeArtifact("https://kfz.supabase.co/huge.png");
    const chunk = new Uint8Array(1024 * 1024);
    let pushed = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pushed * chunk.length > PRINT_ASSET_BYTE_CAP + chunk.length) {
          controller.close();
          return;
        }
        pushed++;
        controller.enqueue(chunk);
      },
    });
    const fetchBig: typeof fetch = async () => new Response(endless, { status: 200 });
    const row = await measureArtifactAsset(id, fetchBig);
    expect(row.failureReason).toBe("too_large");
  });

  it("measures a real PNG body: dimensions, sha256, byte size, assumed sRGB", async () => {
    const id = await makeArtifact("https://kfz.supabase.co/ok.png");
    const body = pngFixture(1024, 1024, 6);
    const fetchPng: typeof fetch = async () => new Response(body, { status: 200 });
    const row = await measureArtifactAsset(id, fetchPng);
    expect(row.failureReason).toBeNull();
    expect(row.widthPx).toBe(1024);
    expect(row.heightPx).toBe(1024);
    expect(row.format).toBe("png");
    expect(row.byteSize).toBe(BigInt(body.length));
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    // No ICC profile in the fixture: color space honestly unknown, sRGB assumed.
    expect(row.colorSpace).toBeNull();
    expect(row.assumedSrgb).toBe(true);
  });

  it("junk bytes record decode_failed but still carry the hash and size", async () => {
    const id = await makeArtifact("https://kfz.supabase.co/junk.bin");
    const fetchJunk: typeof fetch = async () => new Response(new Uint8Array(100), { status: 200 });
    const row = await measureArtifactAsset(id, fetchJunk);
    expect(row.failureReason).toBe("decode_failed");
    expect(row.byteSize).toBe(100n);
  });
});

describe("consumer pin — exactly the sanctioned caller imports printAsset (#254/#258)", () => {
  it("only routes/commerce.ts (the #258 evaluate pipeline) imports printAsset", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const SRC = path.join(__dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && entry.name !== "printAsset.ts") {
          if (/from ["']\.{1,2}\/(?:lib\/)?printAsset["']/.test(fs.readFileSync(full, "utf8"))) {
            offenders.push(path.relative(SRC, full));
          }
        }
      }
    };
    walk(SRC);
    // The sanctioned consumers: the #258 evaluate pipeline, the #259
    // approval re-check, the #264 custody fetch (same allowlist + cap as
    // the measurement), and the #293 raster codec (same SNIFFED-format
    // rule — the bytes decide, never the filename).
    expect(offenders.map((o) => o.replace(/\\/g, "/")).sort()).toEqual([
      "lib/approvalPin.ts",
      "lib/print/raster.ts",
      "lib/storage/custody.ts",
      "routes/commerce.ts",
    ]);
  });
});

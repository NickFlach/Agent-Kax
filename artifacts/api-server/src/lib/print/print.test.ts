/**
 * print.test.ts — #293 (custody + decontamination) and #295 (the 4in
 * sticker resample) acceptance criteria.
 *
 * Codec, quantizer and resampler halves are pure. The custody/master and
 * sticker-production halves are DB-backed (CI). The committed fixture hash
 * pins the RGBA of the resampler's output — deliberately NOT the PNG bytes,
 * which would pin zlib's version instead of this code; encode determinism
 * is asserted separately, within-run.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import jpeg from "jpeg-js";
import { db } from "@workspace/db";
import { artifactsTable, derivedAssetsTable } from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";
import { decodeImage, encodePng, rasterSha256, type Raster } from "./raster";
import { DECONTAMINATE_K, decontaminate } from "./decontaminate";
import { resampleForPrint, resizeLanczos } from "./resample";
import {
  STICKER_4IN,
  custodyWithDecontaminatedMaster,
  produceSticker4inMaster,
  sticker4inEnabled,
} from "./produce";
import fs from "node:fs";
import path from "node:path";
import { measureArtifactAsset } from "../printAsset";
import { MemoryStorageAdapter } from "../storage/adapter";
import { takeCustody } from "../storage/custody";
import { cleanupTestData, createTestAgent, createTestUser, makeTestId } from "../../test-helpers";

/** The committed fixture hash (see resample.fixture.json for provenance). */
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, "resample.fixture.json"), "utf8"),
) as { rgbaSha256: string };

// ---------------------------------------------------------------------------
// Synthetic sources — procedural, so every run constructs identical inputs.
// ---------------------------------------------------------------------------

function syntheticSource(size: number): Raster {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      data[o] = (x * 7 + y * 13) % 256;
      data[o + 1] = (x * x + y) % 256;
      data[o + 2] = (x + y * y) % 256;
      data[o + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

/** Two flat fields, a 1px stroke, and deliberate speckles. */
function flatArtWithSpeckles(size: number): Raster {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const left = x < size / 2;
      data[o] = left ? 200 : 30;
      data[o + 1] = left ? 40 : 160;
      data[o + 2] = left ? 40 : 220;
      data[o + 3] = 255;
    }
  }
  // A 1px vertical stroke at x=8 in a third colour — must SURVIVE.
  for (let y = 2; y < size - 2; y++) {
    const o = (y * size + 8) * 4;
    data[o] = 250; data[o + 1] = 250; data[o + 2] = 20;
  }
  // Isolated speckles in the middle of the left field — must DIE.
  for (const [sx, sy] of [[20, 20], [24, 30], [30, 24]] as const) {
    const o = (sy * size + sx) * 4;
    data[o] = 10; data[o + 1] = 240; data[o + 2] = 10;
  }
  return { width: size, height: size, data };
}

function uniqueColors(r: Raster): Set<number> {
  const set = new Set<number>();
  for (let i = 0; i < r.width * r.height; i++) {
    set.add((r.data[i * 4]! << 16) | (r.data[i * 4 + 1]! << 8) | r.data[i * 4 + 2]!);
  }
  return set;
}

describe("the raster codec (pure)", () => {
  it("sniffs the BYTES, never the filename: jpeg data is jpeg", () => {
    const raw = syntheticSource(32);
    const jpegBytes = new Uint8Array(
      jpeg.encode({ width: 32, height: 32, data: Buffer.from(raw.data.buffer, raw.data.byteOffset, raw.data.length) }, 90).data,
    );
    const decoded = decodeImage(jpegBytes);
    expect(decoded?.sniffedFormat).toBe("jpeg");
    expect(decoded?.raster.width).toBe(32);
    const png = decodeImage(encodePng(raw));
    expect(png?.sniffedFormat).toBe("png");
    expect(decodeImage(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  it("PNG encode/decode round-trips RGBA exactly, and encoding is deterministic within-run", () => {
    const r = syntheticSource(64);
    const bytes = encodePng(r);
    const back = decodeImage(bytes)!.raster;
    expect(rasterSha256(back)).toBe(rasterSha256(r));
    expect(Buffer.from(encodePng(r)).equals(Buffer.from(bytes))).toBe(true);
  });
});

describe("decontaminate (pure)", () => {
  it("collapses to ≤K colours, kills speckles, and PRESERVES the 1px stroke", () => {
    const cleaned = decontaminate(flatArtWithSpeckles(64));
    expect(uniqueColors(cleaned).size).toBeLessThanOrEqual(DECONTAMINATE_K);
    // The speckles: their neighbourhood is flat field; they must now match it.
    for (const [sx, sy] of [[20, 20], [24, 30], [30, 24]] as const) {
      const o = (sy * 64 + sx) * 4;
      const no = (sy * 64 + sx - 2) * 4; // a neighbour well inside the field (x-2 stays left of the boundary)
      expect([cleaned.data[o], cleaned.data[o + 1], cleaned.data[o + 2]]).toEqual([
        cleaned.data[no], cleaned.data[no + 1], cleaned.data[no + 2],
      ]);
    }
    // The stroke: mid-height, still distinct from both fields.
    const so = (32 * 64 + 8) * 4;
    const leftO = (32 * 64 + 4) * 4;
    expect(cleaned.data[so]).not.toBe(cleaned.data[leftO]);
  });

  it("is deterministic: same input, same RGBA hash", () => {
    const a = decontaminate(flatArtWithSpeckles(64));
    const b = decontaminate(flatArtWithSpeckles(64));
    expect(rasterSha256(a)).toBe(rasterSha256(b));
  });
});

describe("resample (pure)", () => {
  it("hits the target dimensions and reproduces the COMMITTED fixture hash", () => {
    const out = resampleForPrint(syntheticSource(512), 557, 557);
    expect(out.width).toBe(557);
    expect(out.height).toBe(557);
    expect(rasterSha256(out)).toBe(FIXTURE.rgbaSha256);
  });

  it("a flat field resizes to the same flat field", () => {
    const flat: Raster = { width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4).fill(128) };
    const out = resizeLanczos(flat, 20, 20);
    for (let i = 0; i < 20 * 20 * 4; i++) expect(out.data[i]).toBe(128);
  });
});

describe("custody + masters (DB)", () => {
  let agentId: number;
  const made: number[] = [];

  async function makeArtifact(publicUrl: string): Promise<number> {
    const [row] = await db
      .insert(artifactsTable)
      .values({
        externalId: makeTestId("decon"),
        title: "decontamination test",
        creatorName: "kax-test-creator",
        publicUrl,
        artifactType: "image",
        agentId,
      })
      .returning({ id: artifactsTable.id });
    made.push(row!.id);
    return row!.id;
  }

  beforeAll(async () => {
    const user = await createTestUser({ emailLabel: "decon" });
    agentId = (await createTestAgent(user.id, "decon")).id;
  });

  afterAll(async () => {
    delete process.env["KAX_PRODUCT_STICKER_4IN"];
    await db.delete(artifactsTable).where(inArray(artifactsTable.id, made));
    await cleanupTestData();
  });

  it("#293: JPEG behind a .png filename records the SNIFFED type, and the master carries its own provenance", async () => {
    const raw = syntheticSource(128);
    const jpegBytes = new Uint8Array(
      jpeg.encode({ width: 128, height: 128, data: Buffer.from(raw.data.buffer, raw.data.byteOffset, raw.data.length) }, 90).data,
    );
    const id = await makeArtifact("https://kfz.supabase.co/liar.png"); // .png name, jpeg bytes
    const serve: typeof fetch = async () => new Response(jpegBytes, { status: 200 });
    const measured = await measureArtifactAsset(id, serve);
    expect(measured.format).toBe("jpeg"); // the bytes decide, never the filename

    const storage = new MemoryStorageAdapter();
    const { custodySha256, master } = await custodyWithDecontaminatedMaster(id, storage, serve);
    // Original bytes + sha256 held; the master is its own asset with lineage.
    expect(custodySha256).toBe(measured.sha256);
    expect(master.sourceArtifactId).toBe(id);
    expect(master.transformType).toBe("decontaminate");
    expect(master.sha256).not.toBe(custodySha256);
    expect(master.parentSha256).toBe(custodySha256);
    const stored = await storage.get(master.storageKey);
    expect(decodeImage(stored!.bytes)?.sniffedFormat).toBe("png"); // never re-JPEGed
    expect(uniqueColors(decodeImage(stored!.bytes)!.raster).size).toBeLessThanOrEqual(DECONTAMINATE_K);

    // #293: re-fetch of the same source is idempotent — no new rows.
    const again = await custodyWithDecontaminatedMaster(id, storage, serve);
    expect(again.master.id).toBe(master.id);
    const rows = await db.select().from(derivedAssetsTable).where(eq(derivedAssetsTable.sourceArtifactId, id));
    expect(rows).toHaveLength(1);
  });

  it("#295: the 4in sticker — env-gated, deterministic, pass + pending approval + lineage", async () => {
    const raw = syntheticSource(1024);
    const pngBytes = encodePng(raw);
    const id = await makeArtifact("https://kfz.supabase.co/sticker-src.png");
    const serve: typeof fetch = async () => new Response(pngBytes, { status: 200 });
    await measureArtifactAsset(id, serve);
    const storage = new MemoryStorageAdapter();

    // SKU invisible with env unset: production refuses BEFORE any writes.
    delete process.env["KAX_PRODUCT_STICKER_4IN"];
    expect(sticker4inEnabled()).toBe(false);
    await expect(produceSticker4inMaster(id, storage, serve)).rejects.toThrow(/not enabled/);
    expect(storage.keys()).toEqual([]);

    process.env["KAX_PRODUCT_STICKER_4IN"] = "1";
    const master = await produceSticker4inMaster(id, storage, serve);
    expect(master.widthPx).toBe(STICKER_4IN.widthPx);
    expect(master.heightPx).toBe(STICKER_4IN.heightPx);
    expect(master.qualityStatus).toBe("passed"); // spec met, factor 1.087 ≤ 2
    expect(master.approvalStatus).toBe("pending");
    expect(master.sourceArtifactId).toBe(id);
    expect(master.transformFactor).toBeCloseTo(1.087, 3);

    // Byte-identical across runs on the same input: the re-run lands on the
    // SAME row (the #294 cache) with the SAME sha256.
    const rerun = await produceSticker4inMaster(id, storage, serve);
    expect(rerun.id).toBe(master.id);
    expect(rerun.sha256).toBe(master.sha256);
  }, 60_000);

  it("with storage env unset, the production path writes nothing (custody refuses first)", async () => {
    // The injected-adapter tests above never touch env; the PRODUCTION entry
    // is storageFromEnv, pinned in custody.test.ts to throw while the five
    // KAX_STORAGE_* secrets are absent. Here: custody refuses before any
    // derived write when the artifact was never measured, either.
    const id = await makeArtifact("https://kfz.supabase.co/unmeasured.png");
    const storage = new MemoryStorageAdapter();
    await expect(takeCustody(id, storage)).rejects.toThrow(/no successful measurement/);
    expect(storage.keys()).toEqual([]);
  });
});

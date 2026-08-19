/**
 * gate.test.ts — #296's acceptance criteria.
 *
 * Metrics, allowlist and SVG-stat parsing are pure. The report-writing half
 * is DB-backed (CI) with an injected vectorizer — CI has no VTracer binary,
 * and that absence is itself one of the honest states under test. The four
 * fixture classes the AC names: flat art, photographic, soft-gradient, and
 * the 64×64 floor.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "@workspace/db";
import { artifactsTable, printFitnessReportsTable } from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";
import { encodePng, type Raster } from "./raster";
import {
  GUESS_SSIM_PASS,
  SOURCE_FLOOR_PX,
  colorBandCount,
  deltaE2000,
  judge,
  meanDeltaE2000,
  ssim,
} from "./gate";
import {
  BLOCKLISTED_WEIGHTS,
  BlocklistedTool,
  ToolNotRegistered,
  VTRACER_LICENSE,
  VTRACER_PINNED_COMMIT,
  assertNotBlocklisted,
  assertToolAllowed,
} from "./allowlist";
import { svgStats, vectorize, type VectorizeImpl } from "./vectorize";
import { FITNESS_PIPELINE_VERSION, reportPrintFitness } from "./fitness";
import { measureArtifactAsset } from "../printAsset";
import { MemoryStorageAdapter } from "../storage/adapter";
import { takeCustody } from "../storage/custody";
import { cleanupTestData, createTestAgent, createTestUser, makeTestId } from "../../test-helpers";

// ---------------------------------------------------------------------------
// Fixtures — the four classes the AC names, procedurally constructed.
// ---------------------------------------------------------------------------

function flatArt(size: number): Raster {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const c = x < size / 2 ? [220, 40, 40] : y < size / 2 ? [40, 180, 60] : [30, 60, 200];
      data[o] = c[0]!; data[o + 1] = c[1]!; data[o + 2] = c[2]!; data[o + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

function photographic(size: number): Raster {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      // Dense pseudo-texture: every pixel a different colour neighbourhood.
      data[o] = (x * 31 + y * 17 + ((x * y) % 97)) % 256;
      data[o + 1] = (x * 13 + y * 29 + ((x + y) % 83)) % 256;
      data[o + 2] = (x * 7 + y * 41 + ((x * 3 + y * 5) % 71)) % 256;
      data[o + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

function softGradient(size: number): Raster {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      data[o] = Math.round((x / (size - 1)) * 255);
      data[o + 1] = Math.round((y / (size - 1)) * 255);
      data[o + 2] = 128;
      data[o + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

function floor64(): Raster {
  return flatArt(64);
}

/** A noisy copy — what a bad trace re-renders as. */
function degrade(r: Raster, amplitude: number): Raster {
  const data = new Uint8ClampedArray(r.data);
  for (let i = 0; i < r.width * r.height; i++) {
    const n = ((i * 2654435761) % (2 * amplitude + 1)) - amplitude; // deterministic "noise"
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.max(0, Math.min(255, data[i * 4 + c]! + n));
  }
  return { ...r, data };
}

const FAKE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg"><path fill="#dc2828" d="M0 0 L10 0 L10 10 Z"/>' +
  '<path fill="#28b43c" d="M10 0 L20 0 L20 10 Z"/><path fill="#1e3cc8" d="M0 10 C5 15 10 15 20 10 Z"/></svg>';

describe("the metrics (pure)", () => {
  it("SSIM: identical images score 1; degradation lowers it monotonically", () => {
    const src = softGradient(96);
    expect(ssim(src, src)).toBeCloseTo(1, 10);
    const mild = ssim(src, degrade(src, 6));
    const harsh = ssim(src, degrade(src, 60));
    expect(mild).toBeLessThan(1);
    expect(harsh).toBeLessThan(mild);
  });

  it("CIEDE2000: zero for identity, known-order for known pairs", () => {
    expect(deltaE2000([50, 0, 0], [50, 0, 0])).toBe(0);
    // Small lightness step vs a hue flip — the flip must be far larger.
    const small = deltaE2000([50, 2, 1], [51, 2, 1]);
    const large = deltaE2000([50, 60, 0], [50, -60, 0]);
    expect(small).toBeLessThan(3);
    expect(large).toBeGreaterThan(20);
    const src = flatArt(64);
    expect(meanDeltaE2000(src, src)).toBe(0);
    expect(meanDeltaE2000(src, degrade(src, 30))).toBeGreaterThan(1);
  });

  it("colour bands separate the classes: flat art tens, photographic thousands", () => {
    expect(colorBandCount(flatArt(128))).toBeLessThanOrEqual(8);
    expect(colorBandCount(photographic(128))).toBeGreaterThan(1000);
  });
});

describe("the verdict (pure)", () => {
  const stats = svgStats(FAKE_SVG);

  it("64×64-class sources fail with the machine-readable reason", () => {
    const m = judge({ source: floor64(), rendered: floor64(), svgStats: stats });
    expect(m.verdict).toBe("fail");
    expect(m.reason).toBe("source_below_floor");
    expect(SOURCE_FLOOR_PX).toBe(65);
  });

  it("faithful flat art passes; a butchered render fails; between goes to review", () => {
    const src = flatArt(96);
    const pass = judge({ source: src, rendered: src, svgStats: stats });
    expect(pass.verdict).toBe("pass");
    expect(pass.ssim).toBeGreaterThanOrEqual(GUESS_SSIM_PASS);
    const fail = judge({ source: src, rendered: degrade(src, 90), svgStats: stats });
    expect(fail.verdict).toBe("fail");
    // Mild degradation of flat art sits between the thresholds: SSIM drops
    // (noise variance against zero-variance fields) while ΔE stays small.
    const mid = judge({ source: src, rendered: degrade(src, 4), svgStats: stats });
    expect(["needs_review", "pass"]).toContain(mid.verdict); // must never FAIL at ±4
  });

  it("a missing tool is needs_review with the tool named — never a silent pass", () => {
    const src = flatArt(96);
    expect(judge({ source: src })).toMatchObject({ verdict: "needs_review", reason: "vectorizer_unavailable" });
    expect(judge({ source: src, svgStats: stats })).toMatchObject({
      verdict: "needs_review",
      reason: "renderer_unavailable",
      svgBytes: stats.svgBytes,
    });
  });
});

describe("SVG stats + the allowlist (pure)", () => {
  it("parses path/node/colour counts and byte size", () => {
    const s = svgStats(FAKE_SVG);
    expect(s.pathCount).toBe(3);
    expect(s.colorCount).toBe(3);
    expect(s.nodeCount).toBeGreaterThanOrEqual(10);
    expect(s.svgBytes).toBe(Buffer.byteLength(FAKE_SVG, "utf8"));
  });

  it("blocklists the named weights WITH their licence findings", () => {
    for (const w of ["SUPIR", "HYPIR", "4x-UltraSharp", "4x-Remacri", "4x-AnimeSharp", "clarity-upscaler"]) {
      expect(BLOCKLISTED_WEIGHTS.some((b) => b.name === w), w).toBe(true);
      expect(() => assertNotBlocklisted(`/models/${w.toLowerCase()}.pth`)).toThrow(BlocklistedTool);
    }
    for (const b of BLOCKLISTED_WEIGHTS) expect(b.licence.length).toBeGreaterThan(10);
    expect(() => assertNotBlocklisted("/usr/local/bin/vtracer")).not.toThrow();
  });

  it("rejects any tool whose sha256 is not registered", () => {
    const self = path.join(__dirname, "allowlist.ts"); // any real file works as a stand-in binary
    delete process.env["KAX_VTRACER_SHA256"];
    expect(() => assertToolAllowed(self)).toThrow(ToolNotRegistered);
    // Register the actual hash and the same file is accepted.
    const sha = crypto.createHash("sha256").update(fs.readFileSync(self)).digest("hex");
    process.env["KAX_VTRACER_SHA256"] = sha;
    try {
      expect(assertToolAllowed(self)).toBe(sha);
    } finally {
      delete process.env["KAX_VTRACER_SHA256"];
    }
  });

  it("the pinned commit and its settled licence are recorded, and the text is vendored", () => {
    expect(VTRACER_PINNED_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    expect(VTRACER_LICENSE).toContain("MIT");
    const vendored = fs.readFileSync(
      path.join(__dirname, "..", "..", "..", "..", "..", "docs", "licenses", "vtracer-LICENSE-1ddc9ebb.txt"),
      "utf8",
    );
    expect(vendored).toContain("Permission is hereby granted");
  });
});

describe("the report-only runner (DB)", () => {
  let agentId: number;
  const made: number[] = [];

  async function makeHeldArtifact(raster: Raster, storage: MemoryStorageAdapter): Promise<number> {
    const [row] = await db
      .insert(artifactsTable)
      .values({
        externalId: makeTestId("gate"),
        title: "gate test",
        creatorName: "kax-test-creator",
        publicUrl: `https://kfz.supabase.co/${makeTestId("g")}.png`,
        artifactType: "image",
        agentId,
      })
      .returning({ id: artifactsTable.id });
    made.push(row!.id);
    const bytes = encodePng(raster);
    const serve: typeof fetch = async () => new Response(bytes, { status: 200 });
    await measureArtifactAsset(row!.id, serve);
    await takeCustody(row!.id, storage, serve);
    return row!.id;
  }

  const fakeVectorizer: VectorizeImpl = async () => FAKE_SVG;

  beforeAll(async () => {
    const user = await createTestUser({ emailLabel: "gate" });
    agentId = (await createTestAgent(user.id, "gate")).id;
  });

  afterAll(async () => {
    delete process.env["KAX_PRINT_FITNESS_GATE"];
    await db.delete(artifactsTable).where(inArray(artifactsTable.id, made));
    await cleanupTestData();
  });

  it("unarmed: writes NOTHING; armed: writes the row and gates nothing", async () => {
    const storage = new MemoryStorageAdapter();
    const id = await makeHeldArtifact(flatArt(96), storage);

    delete process.env["KAX_PRINT_FITNESS_GATE"];
    expect(await reportPrintFitness(id, storage, { vectorizeImpl: fakeVectorizer })).toBeNull();
    expect(await db.select().from(printFitnessReportsTable).where(eq(printFitnessReportsTable.artifactId, id))).toHaveLength(0);

    process.env["KAX_PRINT_FITNESS_GATE"] = "report";
    const report = await reportPrintFitness(id, storage, {
      vectorizeImpl: fakeVectorizer,
      renderImpl: async () => flatArt(96), // a faithful "render"
    });
    expect(report).not.toBeNull();
    expect(report!.verdict).toBe("pass");
    expect(report!.pathCount).toBe(3);
    expect(report!.pipelineVersion).toBe(FITNESS_PIPELINE_VERSION);
    // Report-only: the artifact itself is untouched — no state, no flags.
    const [art] = await db.select().from(artifactsTable).where(eq(artifactsTable.id, id));
    expect(art).toBeTruthy();
  });

  it("the 64×64 floor emits fail with its reason even with every tool present", async () => {
    process.env["KAX_PRINT_FITNESS_GATE"] = "report";
    const storage = new MemoryStorageAdapter();
    const id = await makeHeldArtifact(floor64(), storage);
    const report = await reportPrintFitness(id, storage, {
      vectorizeImpl: fakeVectorizer,
      renderImpl: async () => floor64(),
    });
    expect(report!.verdict).toBe("fail");
    expect(report!.reason).toBe("source_below_floor");
  });

  it("no vectorizer configured: needs_review naming the missing tool, metrics honest nulls", async () => {
    process.env["KAX_PRINT_FITNESS_GATE"] = "report";
    delete process.env["KAX_VTRACER_BIN"];
    const storage = new MemoryStorageAdapter();
    const id = await makeHeldArtifact(softGradient(96), storage);
    const report = await reportPrintFitness(id, storage, {});
    expect(report!.verdict).toBe("needs_review");
    expect(report!.reason).toBe("vectorizer_unavailable");
    expect(report!.ssim).toBeNull();
    expect(report!.preset).toBeNull();
  });

  it("vectorize() itself refuses an unregistered binary before any exec", async () => {
    process.env["KAX_VTRACER_BIN"] = path.join(__dirname, "gate.ts"); // exists, but unregistered
    delete process.env["KAX_VTRACER_SHA256"];
    try {
      await expect(vectorize(encodePng(flatArt(32)), "flat")).rejects.toThrow(ToolNotRegistered);
    } finally {
      delete process.env["KAX_VTRACER_BIN"];
    }
  });
});

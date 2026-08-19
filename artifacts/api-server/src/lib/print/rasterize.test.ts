/**
 * rasterize.test.ts — #298's acceptance criteria.
 *
 * Parsing/flattening/rendering are pure; the committed fixture pins the
 * RGBA hash (same SVG + same target = same sha256). The derived-row and
 * SVG-upload-refusal halves are DB-backed / adapter-level.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "@workspace/db";
import { artifactsTable } from "@workspace/db/schema";
import { inArray } from "drizzle-orm";
import { encodePng, rasterSha256, type Raster } from "./raster";
import { flattenPathData, parseSvgMaster, renderSvgMaster } from "./rasterize";
import { POSTER_12X12, poster12x12Enabled, producePoster12x12Render } from "./produce";
import { printSpecFor } from "../../routes/commerce";
import { getUncachablePrintifyClient } from "../printifyClient";
import { measureArtifactAsset } from "../printAsset";
import { MemoryStorageAdapter } from "../storage/adapter";
import { takeCustody } from "../storage/custody";
import { cleanupTestData, createTestAgent, createTestUser, makeTestId } from "../../test-helpers";

const FIXTURE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60">' +
  '<path fill="#dc2828" d="M0 0 H60 V60 H0 Z"/>' +
  '<path fill="#28b43c" d="M5 5 L55 5 L30 50 Z"/>' +
  '<path fill="#1e3cc8" fill-rule="evenodd" d="M10 10 H50 V30 H10 Z M20 15 H40 V25 H20 Z"/>' +
  '<path fill="#ffffff" d="M10 40 C 20 30 40 30 50 40 Q 30 55 10 40 Z"/>' +
  "</svg>";

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "rasterize.fixture.json"), "utf8")) as {
  target: [number, number];
  rgbaSha256: string;
};

function px(r: Raster, x: number, y: number): [number, number, number] {
  const o = (y * r.width + x) * 4;
  return [r.data[o]!, r.data[o + 1]!, r.data[o + 2]!];
}

describe("the master subset parser (pure)", () => {
  it("parses dimensions, fills and fill rules; refuses off-subset documents", () => {
    const parsed = parseSvgMaster(FIXTURE_SVG);
    expect(parsed.width).toBe(60);
    expect(parsed.height).toBe(60);
    expect(parsed.paths).toHaveLength(4);
    expect(parsed.paths[2]!.evenOdd).toBe(true);
    expect(() => parseSvgMaster('<svg width="10" height="10"><image href="x"/></svg>')).toThrow(/unsupported element/);
    expect(() => parseSvgMaster('<svg width="10" height="10"><path transform="scale(2)" d="M0 0"/></svg>')).toThrow(/transform/);
    expect(() => parseSvgMaster("<div>no</div>")).toThrow(/not an SVG/);
    expect(() => parseSvgMaster('<svg width="10" height="10"><path fill="url(#g)" d="M0 0"/></svg>')).toThrow(/unsupported fill/);
  });

  it("flattens relative commands and béziers deterministically", () => {
    const a = flattenPathData("M0 0 l10 0 l0 10 c -5 5 -5 5 -10 0 z", 1, 1);
    const b = flattenPathData("M0 0 l10 0 l0 10 c -5 5 -5 5 -10 0 z", 1, 1);
    expect(a).toEqual(b);
    expect(a[0]!.length).toBeGreaterThan(4); // the cubic flattened into segments
    expect(() => flattenPathData("M0 0 A 5 5 0 0 1 10 10", 1, 1)).toThrow(/unsupported path command 'A'/);
  });
});

describe("the renderer (pure)", () => {
  it("same SVG + same target = same sha256, matching the COMMITTED fixture", () => {
    const out = renderSvgMaster(FIXTURE_SVG, FIXTURE.target[0], FIXTURE.target[1]);
    expect(out.width).toBe(120);
    expect(rasterSha256(out)).toBe(FIXTURE.rgbaSha256);
    expect(rasterSha256(renderSvgMaster(FIXTURE_SVG, 120, 120))).toBe(FIXTURE.rgbaSha256);
  });

  it("paints in document order and honors evenodd holes", () => {
    const out = renderSvgMaster(FIXTURE_SVG, 120, 120);
    expect(px(out, 4, 4)).toEqual([0xdc, 0x28, 0x28]); // red ground
    expect(px(out, 30, 40)).toEqual([0x1e, 0x3c, 0xc8]); // blue band, left of the hole
    expect(px(out, 60, 40)).toEqual([0x28, 0xb4, 0x3c]); // the evenodd HOLE shows the triangle through
    expect(px(out, 60, 85)).toEqual([0xff, 0xff, 0xff]); // the white curved blob
  });

  it("renders the exact 3600×3600 poster target", () => {
    const out = renderSvgMaster(FIXTURE_SVG, POSTER_12X12.widthPx, POSTER_12X12.heightPx);
    expect(out.width).toBe(3600);
    expect(out.height).toBe(3600);
    expect(px(out, 100, 100)).toEqual([0xdc, 0x28, 0x28]);
  }, 60_000);
});

describe("the SKU gate + the SVG upload refusal", () => {
  it("poster_12x12 is invisible with env unset and priced-in with it", () => {
    delete process.env["KAX_PRODUCT_POSTER_12X12"];
    expect(poster12x12Enabled()).toBe(false);
    expect(printSpecFor("poster_12x12")).toBeUndefined();
    process.env["KAX_PRODUCT_POSTER_12X12"] = "1";
    try {
      expect(printSpecFor("poster_12x12")).toEqual({ widthPx: 3600, heightPx: 3600 });
    } finally {
      delete process.env["KAX_PRODUCT_POSTER_12X12"];
    }
  });

  it("raw SVG is never uploaded to Printify — refused before any network call", async () => {
    process.env["KAX_PRINTIFY_API_TOKEN"] = "test-token";
    process.env["KAX_PRINTIFY_SHOP_ID"] = "999001";
    const spy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", spy);
    try {
      const client = getUncachablePrintifyClient();
      await expect(client.uploadImageByUrl("master.svg", "https://kax.example/master.svg")).rejects.toThrow(
        /image\/svg\+xml refused/,
      );
      await expect(client.uploadImageByUrl("ok.png", "https://kax.example/master.svg?v=2")).rejects.toThrow(/refused/);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      delete process.env["KAX_PRINTIFY_API_TOKEN"];
      delete process.env["KAX_PRINTIFY_SHOP_ID"];
    }
  });
});

describe("the render row (DB)", () => {
  let agentId: number;
  const made: number[] = [];

  beforeAll(async () => {
    const user = await createTestUser({ emailLabel: "raster" });
    agentId = (await createTestAgent(user.id, "raster")).id;
  });

  afterAll(async () => {
    delete process.env["KAX_PRODUCT_POSTER_12X12"];
    await db.delete(artifactsTable).where(inArray(artifactsTable.id, made));
    await cleanupTestData();
  });

  it("each render is its own derived row: lineage to the SVG master, own approval, cached", async () => {
    const [row] = await db
      .insert(artifactsTable)
      .values({
        externalId: makeTestId("raster"),
        title: "raster test",
        creatorName: "kax-test-creator",
        publicUrl: "https://kfz.supabase.co/raster-src.png",
        artifactType: "image",
        agentId,
      })
      .returning({ id: artifactsTable.id });
    made.push(row!.id);
    const storage = new MemoryStorageAdapter();
    // Custody of the SOURCE is still the precondition — a render without a
    // held source is provenance with a hole in it.
    const srcBytes = encodePng(renderSvgMaster(FIXTURE_SVG, 64, 64));
    const serve: typeof fetch = async () => new Response(srcBytes, { status: 200 });
    await measureArtifactAsset(row!.id, serve);
    await takeCustody(row!.id, storage, serve);

    delete process.env["KAX_PRODUCT_POSTER_12X12"];
    await expect(producePoster12x12Render(row!.id, FIXTURE_SVG, storage)).rejects.toThrow(/not enabled/);

    process.env["KAX_PRODUCT_POSTER_12X12"] = "1";
    const render = await producePoster12x12Render(row!.id, FIXTURE_SVG, storage);
    const svgSha = crypto.createHash("sha256").update(FIXTURE_SVG, "utf8").digest("hex");
    expect(render.parentSha256).toBe(svgSha); // lineage edge to the SVG MASTER
    expect(render.transformType).toBe("rasterize");
    expect(render.widthPx).toBe(3600);
    expect(render.qualityStatus).toBe("passed");
    expect(render.approvalStatus).toBe("pending"); // its own approval
    // Same SVG + same target = the same row through the cache.
    const again = await producePoster12x12Render(row!.id, FIXTURE_SVG, storage);
    expect(again.id).toBe(render.id);
    expect(again.sha256).toBe(render.sha256);
  }, 120_000);
});

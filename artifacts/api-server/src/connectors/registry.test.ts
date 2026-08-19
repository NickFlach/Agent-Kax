/**
 * registry.test.ts — #21's registry-level acceptance, network-free.
 *
 * The upstream-data half of the acceptance ("returns real data when
 * configured") needs live tokens and is a deploy-time check via
 * GET /api/connectors/<id>/artifacts; what a test can pin is that the
 * registry lists every connector with honest availability/envMissing, and
 * that the token-gated connector refuses LOCALLY when unconfigured instead
 * of burning a doomed network call.
 */

import { describe, expect, it } from "vitest";
import { ALL_CONNECTORS, findConnector, statusSnapshot } from "./registry";
import { replicateConnector, typeOfOutputUrl } from "./replicate";
import { falaiConnector } from "./falai";

describe("the registry (#21)", () => {
  it("lists all seven connectors with stable snake_case ids", () => {
    expect(ALL_CONNECTORS.map((c) => c.id)).toEqual([
      "obc_partner",
      "obc_public",
      "kannaka_constellation",
      "civitai",
      "huggingface",
      "replicate",
      "falai",
    ]);
    for (const c of ALL_CONNECTORS) expect(c.id).toMatch(/^[a-z0-9_]+$/);
  });

  it("statusSnapshot surfaces available/envMissing for the new connectors", () => {
    const byId = new Map(statusSnapshot().map((s) => [s.id, s]));
    const replicate = byId.get("replicate")!;
    expect(replicate.envRequired).toEqual(["REPLICATE_API_TOKEN"]);
    if (!process.env["REPLICATE_API_TOKEN"]) {
      expect(replicate.available).toBe(false);
      expect(replicate.envMissing).toEqual(["REPLICATE_API_TOKEN"]);
    }
    const falai = byId.get("falai")!;
    expect(falai.envRequired).toEqual([]);
    expect(findConnector("falai")).toBe(falaiConnector);
    expect(findConnector("replicate")).toBe(replicateConnector);
    expect(findConnector("nope")).toBeNull();
  });
});

describe("replicate connector (local behavior, no network)", () => {
  it("refuses locally while the token is unset — empty page, null profile", async () => {
    expect(process.env["REPLICATE_API_TOKEN"]).toBeUndefined();
    expect(replicateConnector.isAvailable()).toBe(false);
    expect(await replicateConnector.fetchArtifacts({ limit: 5 })).toEqual({ artifacts: [], nextCursor: null });
    expect(await replicateConnector.lookupAgent("someone/some-model")).toBeNull();
  });

  it("maps output extensions to artifact types", () => {
    expect(typeOfOutputUrl("https://x/out.png")).toBe("image");
    expect(typeOfOutputUrl("https://x/out.webp?x=1")).toBe("image");
    expect(typeOfOutputUrl("https://x/out.mp3")).toBe("audio");
    expect(typeOfOutputUrl("https://x/out.mp4")).toBe("video");
    expect(typeOfOutputUrl("https://x/out.json")).toBe("text");
    expect(typeOfOutputUrl("https://x/no-extension")).toBe("image");
  });
});

describe("fal.ai connector (local behavior, no network)", () => {
  it("honors the type filter without touching the network", async () => {
    expect(await falaiConnector.fetchArtifacts({ type: "music", limit: 5 })).toEqual({
      artifacts: [],
      nextCursor: null,
    });
  });
});

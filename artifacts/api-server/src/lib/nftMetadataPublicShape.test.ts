/**
 * nftMetadataPublicShape.test.ts — the public ERC-721 metadata document must be
 * usable by a signed-out marketplace visitor (#88, #31).
 *
 * Two defects, both in the one JSON body that OpenSea and `tokenURI` resolve:
 *
 *  - `external_url` pointed at `/artifacts/:id`, which the frontend mounts
 *    inside AdminRoutes behind <RequireAuth>. Every marketplace visitor
 *    following it hit a login wall. The public artifact page is
 *    `/s/:slug/artifacts/:id`. (#88)
 *
 *  - `image` was always `publicUrl`. For audio and music artifacts that URL is
 *    the track itself, so marketplaces got an audio file where a still belongs
 *    and no `animation_url` to play. (#31)
 *
 * Source-level on purpose: this repo's DB-backed suite talks to a real
 * database, which must not be exercised from a dev machine.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const NFT = fs.readFileSync(path.join(__dirname, "..", "routes", "nft.ts"), "utf8");
const APP = fs.readFileSync(
  path.join(__dirname, "..", "..", "..", "kax", "src", "App.tsx"), "utf8");

/** Source with comment-only lines dropped, so prose never satisfies a check. */
function code(src: string): string {
  return src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

/** The public metadata handler body. */
function metadataHandler(): string {
  const src = code(NFT);
  const start = src.indexOf('router.get("/nft/metadata/:artifactId.json"');
  expect(start, "metadata route not found").toBeGreaterThanOrEqual(0);
  const next = src.indexOf("\nrouter.", start + 1);
  return src.slice(start, next > start ? next : undefined);
}

const HANDLER = metadataHandler();

describe("public NFT metadata shape (#88, #31)", () => {
  describe("external_url must be reachable signed-out", () => {
    it("the premise: /artifacts/:id is behind RequireAuth", () => {
      // If the frontend ever makes /artifacts/:id public, this fix's rationale
      // changes and someone should revisit it rather than trust the assertion.
      const at = APP.indexOf('<Route path="/artifacts/:id">');
      expect(at, "/artifacts/:id route not found").toBeGreaterThanOrEqual(0);
      expect(APP.slice(at, at + 200)).toContain("RequireAuth");
    });

    it("the premise: /s/:slug/artifacts/:id exists and is public", () => {
      const at = APP.indexOf('<Route path="/s/:slug/artifacts/:id">');
      expect(at, "public artifact route not found").toBeGreaterThanOrEqual(0);
      expect(APP.slice(at, at + 200)).not.toContain("RequireAuth");
    });

    it("builds external_url from the public storefront path", () => {
      expect(
        HANDLER.includes("/s/${owningAgent.slug}/artifacts/${a.id}"),
        "external_url must point at the public storefront artifact page",
      ).toBe(true);
    });

    it("no longer points at the auth-gated admin path", () => {
      expect(
        HANDLER.includes("${base}/artifacts/${a.id}"),
        "external_url still targets the RequireAuth-wrapped /artifacts/:id",
      ).toBe(false);
    });

    it("omits external_url rather than emitting a broken one", () => {
      // A dead-end link beats one that demands a login, so the key must be
      // absent when no storefront resolves — not defaulted back to /artifacts.
      expect(HANDLER).toContain("owningAgent ? { external_url");
    });

    it("resolves the agent by attribution, not by assuming agentId", () => {
      expect(HANDLER).toContain("agentsTable.id, a.agentId");
      expect(HANDLER).toContain("agentsTable.obcBotId, a.creatorBotId");
    });
  });

  describe("audio and music carry a still image and a playable url", () => {
    it("treats audio and music as time-based", () => {
      expect(HANDLER).toContain('a.artifactType === "audio"');
      expect(HANDLER).toContain('a.artifactType === "music"');
    });

    it("does not serve the track itself as the image", () => {
      expect(
        /image: isTimeBased \? \(a\.thumbnailUrl \?\? a\.publicUrl\) : a\.publicUrl/.test(HANDLER),
        "image must prefer the thumbnail for time-based artifacts",
      ).toBe(true);
    });

    it("emits animation_url for time-based artifacts only", () => {
      expect(HANDLER).toContain("isTimeBased ? { animation_url: a.publicUrl }");
    });
  });

  describe("existing public-visibility guarantees are untouched", () => {
    it("still requires the artifact to be publicly visible and minted", () => {
      // #12 added both filters; #107 asked whether they were present. They are,
      // and this pins them so the metadata body cannot start leaking again.
      expect(HANDLER).toContain("publicArtifactWhere()");
      expect(HANDLER).toContain("artifact has not been minted");
    });
  });
});

/**
 * creatorIdentityShapes.test.ts — bot ownership proofs must be read from every
 * creator shape the partner API sends (#81).
 *
 * `/partner/artifacts/{uuid}` detail responses are returned raw by
 * `getPartnerArtifact`, unlike list responses which `normalizeArtifact`
 * flattens. So the nested `creator.id` form — the one `PartnerArtifact` models
 * as canonical, and the one webhook ingestion was corrected to use in #102 —
 * reaches callers unchanged.
 *
 * `/auth/agent/verify` read only the top-level `creator_bot_id` / `creator_id`,
 * so a legitimate ownership proof was rejected with "artifact creator does not
 * match claimed bot id". The same omission on the display-name side let an
 * attachment succeed while persisting a null bot name.
 *
 * The helpers are pure, so these are real behavioural assertions rather than
 * source-level ones. The route wiring is checked separately at the end.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { creatorBotIdOf, creatorDisplayNameOf } from "./partnerClient";

const BOT = "9f2a51c8-0000-4a11-b7c3-1d5e6f7a8b90";

describe("creator identity shapes (#81)", () => {
  describe("bot id", () => {
    it("reads the nested creator.id the detail endpoint actually sends", () => {
      expect(creatorBotIdOf({ id: "a", creator: { id: BOT } })).toBe(BOT);
    });

    it("still reads the top-level creator_bot_id", () => {
      expect(creatorBotIdOf({ id: "a", creator_bot_id: BOT })).toBe(BOT);
    });

    it("still reads the top-level creator_id", () => {
      expect(creatorBotIdOf({ id: "a", creator_id: BOT })).toBe(BOT);
    });

    it("prefers the top-level id when both are present", () => {
      // Not arbitrary: the top-level field is the one the partner API
      // documents for detail responses, so it wins if it is there at all.
      expect(creatorBotIdOf({ id: "a", creator_bot_id: BOT, creator: { id: "other" } })).toBe(BOT);
    });

    it("returns null rather than an empty string when absent", () => {
      // The caller compares `creator.toLowerCase() !== obcBotId`. An empty
      // string that silently compared equal to a blank bot id would be an
      // authentication bypass, so absence must be distinguishable.
      expect(creatorBotIdOf({ id: "a" })).toBe(null);
      expect(creatorBotIdOf(null)).toBe(null);
      expect(creatorBotIdOf(undefined)).toBe(null);
    });

    it("treats blank and whitespace-only values as absent", () => {
      expect(creatorBotIdOf({ id: "a", creator_bot_id: "" })).toBe(null);
      expect(creatorBotIdOf({ id: "a", creator_bot_id: "   " })).toBe(null);
    });

    it("falls through a blank top-level value to the nested one", () => {
      expect(creatorBotIdOf({ id: "a", creator_bot_id: "", creator: { id: BOT } })).toBe(BOT);
    });

    it("ignores non-string values instead of coercing them", () => {
      const weird = { id: "a", creator_bot_id: 12345, creator: { id: BOT } } as never;
      expect(creatorBotIdOf(weird)).toBe(BOT);
    });
  });

  describe("display name", () => {
    it("reads the nested creator.display_name", () => {
      expect(creatorDisplayNameOf({ id: "a", creator: { display_name: "Ghost DJ" } })).toBe("Ghost DJ");
    });

    it("still reads the top-level forms", () => {
      expect(creatorDisplayNameOf({ id: "a", creator_display_name: "Ghost DJ" })).toBe("Ghost DJ");
      expect(creatorDisplayNameOf({ id: "a", display_name: "Ghost DJ" })).toBe("Ghost DJ");
    });

    it("returns null when no name is present", () => {
      expect(creatorDisplayNameOf({ id: "a" })).toBe(null);
      expect(creatorDisplayNameOf(null)).toBe(null);
    });

    it("treats a blank name as absent rather than storing an empty string", () => {
      expect(creatorDisplayNameOf({ id: "a", creator_display_name: "  " })).toBe(null);
    });
  });

  describe("the verify route uses them", () => {
    const SRC = fs.readFileSync(
      path.join(__dirname, "..", "routes", "auth-agent.ts"), "utf8");

    it("resolves the proof's bot id through the shared helper", () => {
      expect(SRC).toContain("creatorBotIdOf(artifact)");
    });

    it("resolves the stored display name through the shared helper", () => {
      expect(SRC).toContain("creatorDisplayNameOf(artifact)");
    });

    it("no longer reads creator ids straight off the payload", () => {
      expect(
        SRC.includes("artifact.creator_bot_id ??"),
        "the route should not re-implement shape handling inline",
      ).toBe(false);
    });

    it("still rejects a mismatched creator", () => {
      // The fix widens which shapes are accepted; it must not weaken the
      // comparison itself.
      expect(SRC).toContain("artifact creator does not match claimed bot id");
      expect(SRC).toContain("creator.toLowerCase() !== obcBotId");
    });
  });
});

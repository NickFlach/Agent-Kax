/**
 * artifactPublication.test.ts — bot attachment must not accept a proof nobody
 * can see (#115).
 *
 * `/auth/agent/verify` tells the user to PUBLISH an artifact containing the
 * challenge phrase, then checked only creator, phrase and freshness. An
 * artifact the partner API returns by UUID but that is private/draft satisfied
 * all three, so attachment could succeed without the user ever performing the
 * public action the instructions describe.
 *
 * The direction of this check is deliberate and is what most of these tests
 * pin down. It rejects only on POSITIVE evidence of non-publication, never on
 * the absence of a signal. The partner payload is typed `[k: string]: unknown`
 * because its shape is not pinned on this side; a check demanding proof of
 * publication would reject every legitimate user the moment OBC renamed or
 * dropped a field we guessed at — locking people out of attaching their own
 * bots, which is worse and far louder than the hole it closes.
 */

import { describe, expect, it } from "vitest";
import { detectNonPublic } from "./artifactPublication";

describe("detectNonPublic (#115)", () => {
  describe("rejects artifacts that declare themselves non-public", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["visibility: private", { visibility: "private" }],
      ["visibility: unlisted", { visibility: "unlisted" }],
      ["status: draft", { status: "draft" }],
      ["state: hidden", { state: "hidden" }],
      ["publish_status: unpublished", { publish_status: "unpublished" }],
      ["is_public: false", { is_public: false }],
      ["published: false", { published: false }],
      ["is_published: false", { is_published: false }],
    ];
    for (const [name, artifact] of cases) {
      it(name, () => {
        const verdict = detectNonPublic(artifact);
        expect(verdict.nonPublic).toBe(true);
        // The signal is surfaced in the 403 and the log, so a confused user
        // can see WHY their artifact was refused.
        expect(verdict.signal).toBeTruthy();
      });
    }

    it("is case- and whitespace-insensitive", () => {
      expect(detectNonPublic({ visibility: "  PRIVATE " }).nonPublic).toBe(true);
    });
  });

  describe("accepts anything that does not say it is non-public", () => {
    it("a payload with no visibility information at all", () => {
      // The fail-open half. This is the shape the existing happy-path fixture
      // uses, and the shape any legitimate publish may arrive in.
      expect(detectNonPublic({ creator_bot_id: "x", description: "KAX-VERIFY-ABC123" }).nonPublic)
        .toBe(false);
    });

    it("an explicitly public artifact", () => {
      expect(detectNonPublic({ visibility: "public", is_public: true }).nonPublic).toBe(false);
    });

    it("a status this check does not recognise", () => {
      // An unknown status must not be treated as private — that is exactly the
      // guess that would start rejecting real users.
      expect(detectNonPublic({ status: "minted" }).nonPublic).toBe(false);
      expect(detectNonPublic({ status: "live" }).nonPublic).toBe(false);
    });

    it("a MISSING boolean, as opposed to a false one", () => {
      // `undefined !== false`. Getting this wrong would reject every payload
      // that simply omits the field, i.e. probably all of them.
      expect(detectNonPublic({ is_public: undefined }).nonPublic).toBe(false);
      expect(detectNonPublic({}).nonPublic).toBe(false);
    });

    it("a non-boolean truthiness stand-in", () => {
      // Only strict `false` counts; a string "false" is not something we can
      // safely interpret, and 0 could mean anything.
      expect(detectNonPublic({ is_public: 0 }).nonPublic).toBe(false);
      expect(detectNonPublic({ published: "" }).nonPublic).toBe(false);
    });
  });

  describe("degenerate input", () => {
    it("null, undefined and non-objects are not treated as non-public", () => {
      for (const input of [null, undefined, 42, "artifact", []]) {
        expect(detectNonPublic(input).nonPublic).toBe(false);
      }
    });
  });
});

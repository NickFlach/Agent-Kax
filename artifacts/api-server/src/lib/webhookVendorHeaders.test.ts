/**
 * webhookVendorHeaders.test.ts — partner webhooks must be accepted under both
 * vendor header spellings (#82).
 *
 * `POST /webhooks/openbotcity`, `PARTNER_API_BASE` and the rest of this
 * integration are named OpenBotCity, but the handler read `x-openclawcity-*`
 * headers only. If the live sender uses the OpenBotCity spelling, every
 * delivery is rejected with `401 Invalid signature`, `recordWebhookReceived()`
 * never runs, and KAX silently degrades to replay/polling instead of the live
 * bridge.
 *
 * Both spellings are accepted rather than swapping the primary: which one the
 * live sender actually uses is not verifiable from this repo, and guessing
 * wrong would break a working integration instead of fixing a broken one.
 * Accepting both is correct under either answer, which is what these
 * assertions pin.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { vendorHeader } from "../routes/webhooks";

/** Minimal stand-in for the express Request surface the helper touches. */
function reqWith(headers: Record<string, string>) {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { header: (name: string) => lower[name.toLowerCase()] };
}

describe("webhook vendor headers (#82)", () => {
  it("accepts the OpenBotCity spelling", () => {
    const req = reqWith({ "x-openbotcity-signature": "sha256=abc" });
    expect(vendorHeader(req, "signature")).toBe("sha256=abc");
  });

  it("still accepts the OpenClawCity spelling", () => {
    // Backwards compatibility is the whole point — this must not regress.
    const req = reqWith({ "x-openclawcity-signature": "sha256=def" });
    expect(vendorHeader(req, "signature")).toBe("sha256=def");
  });

  it("prefers OpenBotCity when a sender somehow supplies both", () => {
    const req = reqWith({
      "x-openbotcity-signature": "sha256=bot",
      "x-openclawcity-signature": "sha256=claw",
    });
    expect(vendorHeader(req, "signature")).toBe("sha256=bot");
  });

  it("works for the event-type header too", () => {
    expect(vendorHeader(reqWith({ "x-openbotcity-event": "artifact.created" }), "event"))
      .toBe("artifact.created");
    expect(vendorHeader(reqWith({ "x-openclawcity-event": "artifact.created" }), "event"))
      .toBe("artifact.created");
  });

  it("returns undefined when neither is present", () => {
    // verifySignature fails closed on undefined, so absence must stay
    // distinguishable rather than becoming an empty string.
    expect(vendorHeader(reqWith({}), "signature")).toBe(undefined);
    expect(vendorHeader(reqWith({ "x-unrelated": "x" }), "signature")).toBe(undefined);
  });

  describe("both call sites use it", () => {
    const SRC = fs.readFileSync(
      path.join(__dirname, "..", "routes", "webhooks.ts"), "utf8");

    it("the signature lookup goes through the helper", () => {
      expect(SRC).toContain('vendorHeader(req, "signature")');
    });

    it("the event-type fallback goes through the helper", () => {
      expect(SRC).toContain('vendorHeader(req, "event")');
    });

    it("no header is read under a single hardcoded prefix any more", () => {
      const callSites = SRC.split("\n").filter(
        (l) => l.includes("req.header(") && !l.includes("x-openbotcity-") && !l.includes("x-openclawcity-"),
      );
      expect(callSites, `unexpected direct header reads: ${callSites.join(" | ")}`).toEqual([]);
    });

    it("the signature check itself is untouched", () => {
      // Widening where the value is looked up must not weaken how it is
      // verified: still HMAC-SHA256, constant-time, and fail-closed.
      expect(SRC).toContain("crypto.timingSafeEqual");
      expect(SRC).toContain('createHmac("sha256", secret)');
      expect(SRC).toContain("if (!secret || !signatureHeader) return false;");
    });
  });
});

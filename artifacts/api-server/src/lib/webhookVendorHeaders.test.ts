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

    it("no VENDOR header is read under a single hardcoded prefix any more", () => {
      // Scoped to vendor headers, which is what #82 was about. Standard headers
      // with one canonical spelling (`content-type`) have no second vendor form
      // to miss, so reading one directly cannot reintroduce the bug — and the
      // challenge handler logs the content-type deliberately, because which body
      // shape arrived is the first thing anybody diagnosing a failed
      // endpoint-ownership proof needs to know. Naming the exemptions keeps the
      // check strict about everything else.
      const STANDARD = ["content-type", "content-length", "user-agent"];
      const callSites = SRC.split("\n").filter(
        (l) =>
          l.includes("req.header(") &&
          !l.includes("x-openbotcity-") &&
          !l.includes("x-openclawcity-") &&
          !STANDARD.some((h) => l.includes(`"${h}"`)),
      );
      expect(callSites, `unexpected direct header reads: ${callSites.join(" | ")}`).toEqual([]);
    });

    it("the signature check itself is untouched", () => {
      // Widening where the value is looked up must not weaken how it is
      // verified: still HMAC-SHA256, constant-time, and fail-closed.
      //
      // The verifier MOVED to lib/webhookSignature.ts when the receiver had to
      // hold more than one signing secret — a subscription's secret is shown
      // exactly once at create time, so two subscriptions mean two secrets. The
      // properties asserted here are the same ones, read where they now live. A
      // test that stopped looking would have gone quietly green while the check
      // itself was free to rot.
      const SIG = fs.readFileSync(path.join(__dirname, "webhookSignature.ts"), "utf8");
      expect(SIG).toContain("crypto.timingSafeEqual");
      expect(SIG).toContain('crypto.createHmac("sha256"');
      // Fail-closed: no secret configured, or no signature presented, refuses.
      expect(SIG).toContain("if (secrets.length === 0 || !signatureHeader)");
      // And the route still refuses before doing anything else with the body.
      expect(SRC).toContain("if (!check.ok)");
      expect(SRC).toContain('res.status(401).json({ error: "Invalid signature" })');
    });

    it("the challenge echo is downstream of the signature check", () => {
      // Order is the security property, not a style preference: an endpoint
      // that reflects whatever it is sent, to anyone, is an open oracle. Pinned
      // by POSITION in the source so a refactor that hoists the echo above the
      // check fails here rather than in production.
      const refusal = SRC.indexOf('res.status(401).json({ error: "Invalid signature" })');
      const echo = SRC.indexOf("detectChallenge(");
      expect(refusal).toBeGreaterThan(-1);
      expect(echo).toBeGreaterThan(-1);
      expect(echo, "the challenge is echoed before the signature is verified").toBeGreaterThan(refusal);
    });
  });
});

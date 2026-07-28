/**
 * challengeConsumeOrder.test.ts — the attachment challenge must be consumed
 * only after the attachment is confirmed (#111).
 *
 * `/auth/agent/verify` used to mark the challenge consumed BEFORE inserting
 * into user_bots. Any failure afterwards — a DB error on the insert, or losing
 * the owner re-read race — burned the challenge anyway.
 *
 * That is expensive rather than merely annoying: verification also requires
 * `artifact.created_at >= challenge.createdAt`, so the user's existing OBC
 * artifact no longer satisfies the *new* challenge. A transient error cost them
 * a fresh challenge AND a brand new published artifact, inside a 30-minute
 * window.
 *
 * Source-level on purpose: this is about the ORDER of two statements in one
 * handler. Reproducing it behaviourally would mean injecting a DB failure
 * between them, and this repo's DB-backed suite talks to a real database, which
 * must not be exercised from a dev machine.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "routes", "auth-agent.ts"), "utf8");

/** Body of the /auth/agent/verify handler (up to the next route). */
function verifyHandler(): string {
  const start = SRC.indexOf('router.post("/auth/agent/verify"');
  expect(start, "/auth/agent/verify not found").toBeGreaterThanOrEqual(0);
  const next = SRC.indexOf("router.post(", start + 10);
  return SRC.slice(start, next > start ? next : undefined);
}

describe("challenge consume ordering (#111)", () => {
  const body = verifyHandler();

  it("consumes the challenge after the user_bots insert", () => {
    const insertAt = body.indexOf("insert(userBotsTable)");
    const consumeAt = body.indexOf("consumed: true");
    expect(insertAt, "user_bots insert not found in the verify handler").toBeGreaterThanOrEqual(0);
    expect(consumeAt, "challenge consume not found in the verify handler").toBeGreaterThanOrEqual(0);
    expect(
      consumeAt > insertAt,
      "the challenge is consumed BEFORE the attachment is written — a failed " +
      "insert then burns the challenge, and the user's artifact is no longer " +
      "valid for the replacement challenge",
    ).toBe(true);
  });

  it("consumes the challenge after the owner re-read check", () => {
    // lastIndexOf, not indexOf: the same 409 message appears earlier in this
    // handler as a cheap pre-check before the partner-API round trip. Anchoring
    // on the first occurrence made this assertion pass even with the consume
    // moved back before the insert — it was measuring the wrong statement.
    const ownerCheckAt = body.lastIndexOf("already attached to a different account");
    const consumeAt = body.indexOf("consumed: true");
    expect(ownerCheckAt).toBeGreaterThanOrEqual(0);
    expect(
      consumeAt > ownerCheckAt,
      "losing the owner race must not burn the challenge either",
    ).toBe(true);
  });

  it("still consumes the challenge on the success path", () => {
    // Guards the other direction: deferring must not turn into never
    // consuming, which would leave a replayable challenge behind.
    expect(body).toContain("consumed: true");
    expect(body).toContain("eq(authChallengesTable.consumed, false)");
  });

  it("still requires the artifact to post-date the challenge", () => {
    // The freshness guard is *why* burning the challenge is costly. If it were
    // ever removed, this test's premise changes and someone should revisit it.
    expect(body).toContain("createdAt < challenge.createdAt");
  });
});

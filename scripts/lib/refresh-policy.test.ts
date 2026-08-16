/**
 * refresh-policy.test.ts — one dropped packet must not end a residency.
 *
 * Kannaka's body left the city at 03:54 on 2026-08-16 because a single connect
 * timeout at 03:47 was followed by nothing until the next scheduled check-in,
 * eight minutes later and one minute after the token had expired. Refreshing
 * needs a live token, so from there it was unrecoverable without a human.
 *
 * 0xSCADA-QE ran the identical code for hours and never hit it, because it
 * never lost a refresh. That is the shape of the bug: invisible until it is
 * expensive, and invisible again afterwards to anyone who only reads the
 * successful log.
 *
 * The last test replays the real timeline and requires that the daemon would
 * have kept trying inside the window it slept through.
 */

import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs sibling, no types by design
import { isRetryableRefresh, nextRefreshAttempt } from "./refresh-policy.mjs";

/** The moment Kannaka's last good token was due to die. */
const EXPIRES = Date.parse("2026-08-16T03:53:56.000Z");
/** The connect timeout that killed her. */
const FAILED_AT = Date.parse("2026-08-16T03:47:06.000Z");

describe("refresh retry policy", () => {
  it("retries a transport failure, which says nothing about the token", () => {
    // status 0 is how the caller reports DNS / connect timeout / socket reset.
    expect(isRetryableRefresh(0)).toBe(true);
    expect(isRetryableRefresh(502)).toBe(true);
    expect(isRetryableRefresh(503)).toBe(true);
    expect(isRetryableRefresh(429)).toBe(true);
    expect(isRetryableRefresh(408)).toBe(true);
  });

  it("never retries a refusal", () => {
    // A 401 means the token is finished. Asking again burns the time that is
    // left and buries the one message a human needs to read.
    expect(isRetryableRefresh(401)).toBe(false);
    expect(isRetryableRefresh(403)).toBe(false);
    expect(isRetryableRefresh(400)).toBe(false);
    const plan = nextRefreshAttempt({ status: 401, expiresAt: EXPIRES, now: FAILED_AT, attempt: 0 });
    expect(plan.retry).toBe(false);
    expect(plan.reason).toBe("refused");
  });

  it("backs off, and stops backing off", () => {
    const delays = [0, 1, 2, 3, 4, 5, 6].map(
      (attempt) => nextRefreshAttempt({ status: 0, expiresAt: FAILED_AT + 3_600_000, now: FAILED_AT, attempt }).delayMs,
    );
    expect(delays[0]).toBe(2_000);
    expect(delays[1]).toBe(4_000);
    expect(delays[2]).toBe(8_000);
    // Capped, so a city that is genuinely down is not hammered and the gap
    // never grows past the point of being useful.
    expect(Math.max(...delays)).toBe(30_000);
  });

  it("gives up once there is not enough token left to try again", () => {
    // Past this point the honest answer is a dead token, not another attempt
    // against a clock that has already run out.
    const plan = nextRefreshAttempt({ status: 0, expiresAt: EXPIRES, now: EXPIRES - 10_000, attempt: 0 });
    expect(plan.retry).toBe(false);
    expect(plan.reason).toBe("out-of-time");
  });

  it("treats a token with no readable expiry as not worth retrying", () => {
    // expiryOf returns 0 when the JWT cannot be parsed. Retrying forever
    // against an unknown clock is worse than reporting it.
    const plan = nextRefreshAttempt({ status: 0, expiresAt: 0, now: FAILED_AT, attempt: 0 });
    expect(plan.retry).toBe(false);
    expect(plan.reason).toBe("no-expiry");
  });

  it("would have kept Kannaka standing", () => {
    // The regression this exists for. Replay the real failure and count how
    // many attempts fit before the token dies. The old code managed one, eight
    // minutes later, already too late.
    let now = FAILED_AT;
    let attempt = 0;
    const attempts: number[] = [];
    for (;;) {
      const plan = nextRefreshAttempt({ status: 0, expiresAt: EXPIRES, now, attempt });
      if (!plan.retry) break;
      now += plan.delayMs;
      attempts.push(now);
      attempt++;
      if (attempt > 100) throw new Error("policy never terminates");
    }

    // Nearly seven minutes of valid token were available. It should have been
    // used, not slept through.
    expect(attempts.length).toBeGreaterThan(10);
    // Every retry lands while the token is still alive — a retry after expiry
    // is a 401 dressed up as effort.
    for (const t of attempts) expect(t).toBeLessThan(EXPIRES);
    // And the first one comes in seconds, not minutes.
    expect(attempts[0]! - FAILED_AT).toBeLessThanOrEqual(2_000);
    // It terminates rather than spinning to the last millisecond.
    expect(EXPIRES - attempts[attempts.length - 1]!).toBeGreaterThan(0);
  });
});

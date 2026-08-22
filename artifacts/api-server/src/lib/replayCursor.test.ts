/**
 * replayCursor.test.ts — behaviour of the one owner of replay cursor advances
 * (#418, and the review that found the first fix's holes).
 *
 * These are behaviour tests, not source-text checks: they mock the single
 * collaborator (recordEventCursor) and assert what is PERSISTED across the
 * exact sequences the review named — a deferral on a full page, a deferral
 * before any progress (the pin), a failure behind a held deferral, and the
 * failure counter surviving page boundaries.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const recorded: Array<{ uuid: string; type?: string }> = [];
vi.mock("./partnerClient", () => ({
  recordEventCursor: vi.fn(async (uuid: string, eventType?: string) => {
    recorded.push({ uuid, type: eventType });
  }),
}));

import { ReplayCursor } from "./replayCursor";

beforeEach(() => {
  recorded.length = 0;
});

/** The last uuid persisted for a type — what the next replay would seed from. */
function lastPersisted(): string | undefined {
  return recorded[recorded.length - 1]?.uuid;
}

describe("ReplayCursor", () => {
  it("advances the persisted cursor per processed event when nothing is held", async () => {
    const rc = new ReplayCursor(null, "artifact.created");
    await rc.onProcessed("a");
    await rc.onProcessed("b");
    expect(lastPersisted()).toBe("b");
    expect(rc.fetchFrom()).toBe("b");
  });

  it("freezes the persisted cursor at a deferral but keeps fetching forward", async () => {
    const rc = new ReplayCursor("seed", "reaction.received");
    await rc.onProcessed("a"); // persisted = a
    await rc.onDeferred(); // holds at a
    await rc.onProcessed("b"); // still applicable, but must NOT advance persistence
    // The persisted cursor never moved past a — b's onProcessed is a no-op for
    // persistence — so the next replay re-offers the deferred event.
    expect(lastPersisted()).toBe("a");
    // ...but the fetch position keeps moving so later pages are still tried.
    await rc.onPageBoundary("page2");
    expect(rc.fetchFrom()).toBe("page2");
    expect(lastPersisted()).toBe("a"); // page boundary did not persist while held
  });

  it("pins the type onto its own cursor when its FIRST event defers", async () => {
    // The review's finding 1: a type with a prior position that defers before
    // any progress must PERSIST that position, so next boot it seeds from
    // eventCursors[type] and not the shared, mutable legacy lastEventUuid that
    // other types advance past the deferred event.
    const rc = new ReplayCursor("legacy-pos", "dm.received");
    await rc.onDeferred(); // first event of this type defers
    expect(lastPersisted()).toBe("legacy-pos");
    expect(recorded[recorded.length - 1]?.type).toBe("dm.received");
  });

  it("does not skip a deferred event when a later event of the type fails", async () => {
    // The review's finding 5: a failure behind a held deferral must not
    // advance the cursor past the deferred event.
    const rc = new ReplayCursor("p0", "reaction.received");
    await rc.onProcessed("a");
    await rc.onDeferred(); // held at a
    await rc.onFailed("b"); // a bad event after the deferral
    expect(lastPersisted()).toBe("a"); // never advanced to b
  });

  it("advances past a failed event only when nothing is held", async () => {
    const rc = new ReplayCursor(null, "artifact.created");
    await rc.onProcessed("a");
    await rc.onFailed("b"); // no deferral: skip it and move on
    expect(lastPersisted()).toBe("b");
  });

  it("counts consecutive failures across page boundaries (breaker can trip)", async () => {
    // The review's finding 4: the counter used to reset every page, so a
    // steady failure rate under one page never tripped the breaker.
    const rc = new ReplayCursor(null, "artifact.created");
    expect(await rc.onFailed("a")).toBe(1);
    await rc.onPageBoundary("p2"); // a page boundary must NOT reset the count
    expect(await rc.onFailed("b")).toBe(2);
    expect(rc.failures).toBe(2);
  });

  it("a success resets the failure count", async () => {
    const rc = new ReplayCursor(null, "artifact.created");
    await rc.onFailed("a");
    await rc.onProcessed("b");
    expect(rc.failures).toBe(0);
  });

  it("reports how it pinned a deferral", async () => {
    const withPos = new ReplayCursor("seed", "dm.received");
    expect(await withPos.onDeferred()).toBe("pinned");
    expect(await withPos.onDeferred()).toBe("held"); // already holding
    const fromNull = new ReplayCursor(null, "dm.received");
    expect(await fromNull.onDeferred()).toBe("unpinnable"); // nothing to pin to
  });

  describe("non-persisting mode (admin catch-up must not clobber the cursor)", () => {
    it("never writes the stored cursor, on any path", async () => {
      const rc = new ReplayCursor("seed", "dm.received", false);
      await rc.onProcessed("a");
      await rc.onPageBoundary("p2");
      await rc.onFailed("b");
      await rc.onDeferred();
      expect(recorded).toEqual([]); // the operator tool touched nothing durable
    });

    it("still holds the deferral for its own pagination", async () => {
      const rc = new ReplayCursor("seed", "dm.received", false);
      await rc.onProcessed("a");
      await rc.onDeferred();
      // held, so onProcessed is a no-op for the fetch position past the hold
      await rc.onProcessed("b");
      expect(rc.held).toBe(true);
    });
  });
});

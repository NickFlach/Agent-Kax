/**
 * reactionDeferral.test.ts — a reaction that arrives before its artifact must
 * stay recoverable (#103).
 *
 * OBC webhook delivery is not ordered, so `reaction.received` can land before
 * `artifact.created` or before the harvester has pulled the artifact in.
 * `handleReactionReceived` used to `return` on an unknown artifact, and
 * `dispatchPartnerEvent` records every handler that returns normally in
 * `processed_events`. So the reaction was lost permanently:
 *
 *   - no `reactions` row, so reactionCount / heat / lastReactionAt stayed low,
 *   - and replay could not repair it, because replay dedupes on exactly the
 *     `processed_events` row that the silent skip had just written.
 *
 * The fix is that "cannot apply yet" is now distinct from "done": the handler
 * throws `EventDeferredError`, and the dispatcher leaves the event unrecorded.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { dispatchPartnerEvent, EventDeferredError, registerEventHandler } from "./eventDispatcher";
// Registers the production handlers, so the end-to-end case below exercises
// the real reaction.received path rather than a stub.
import { registerAllEventHandlers } from "./eventHandlers";

registerAllEventHandlers();

const UNKNOWN_ARTIFACT = "00000000-0000-4000-8000-00000000dead";

async function processedCount(eventUuid: string): Promise<number> {
  const res = await db.execute<{ n: string }>(
    sql`SELECT COUNT(*)::int AS n FROM processed_events WHERE event_uuid = ${eventUuid}`,
  );
  const rows = (res as unknown as { rows?: { n: number }[] }).rows ?? [];
  return Number(rows[0]?.n ?? 0);
}

let seq = 0;
const nextUuid = () => `11111111-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

describe("deferred events stay replayable (#103)", () => {
  beforeEach(() => {
    seq += 1000;
  });

  it("does not record a deferred event as processed", async () => {
    const eventUuid = nextUuid();
    registerEventHandler("test.defer", async () => {
      throw new EventDeferredError("artifact not ingested yet");
    });

    const result = await dispatchPartnerEvent({
      eventType: "test.defer",
      eventUuid,
      data: {},
      source: "webhook",
    });

    expect(result.status).toBe("deferred");
    expect(result.reason).toContain("not ingested");
    // The whole point: absent from processed_events, so replay re-delivers it.
    expect(await processedCount(eventUuid)).toBe(0);
  });

  it("applies the event once the precondition is satisfied", async () => {
    // Same event uuid, delivered twice: deferred first, handled second. This
    // is the recovery path the bug made impossible.
    const eventUuid = nextUuid();
    let ingested = false;
    let applied = 0;
    registerEventHandler("test.defer.then.apply", async () => {
      if (!ingested) throw new EventDeferredError("artifact not ingested yet");
      applied += 1;
    });

    const first = await dispatchPartnerEvent({
      eventType: "test.defer.then.apply", eventUuid, data: {}, source: "webhook",
    });
    expect(first.status).toBe("deferred");
    expect(applied).toBe(0);

    ingested = true;
    const second = await dispatchPartnerEvent({
      eventType: "test.defer.then.apply", eventUuid, data: {}, source: "replay",
    });
    expect(second.status).toBe("handled");
    expect(applied).toBe(1);
    expect(await processedCount(eventUuid)).toBe(1);
  });

  it("still records a normally-returning handler as processed", async () => {
    // The over-correction guard: deferral must not make every event retryable
    // forever, or dedupe stops working.
    const eventUuid = nextUuid();
    registerEventHandler("test.ok", async () => {});
    const result = await dispatchPartnerEvent({
      eventType: "test.ok", eventUuid, data: {}, source: "webhook",
    });
    expect(result.status).toBe("handled");
    expect(await processedCount(eventUuid)).toBe(1);
  });

  it("still propagates a genuine failure rather than swallowing it as deferred", async () => {
    // A real bug must not be laundered into "we'll try later" — that would
    // turn every crash into silent, permanent retry.
    const eventUuid = nextUuid();
    registerEventHandler("test.boom", async () => {
      throw new Error("database on fire");
    });

    await expect(
      dispatchPartnerEvent({ eventType: "test.boom", eventUuid, data: {}, source: "webhook" }),
    ).rejects.toThrow("database on fire");
    // Not recorded either — an errored event is also not "done".
    expect(await processedCount(eventUuid)).toBe(0);
  });

  it("a real reaction for an unknown artifact defers rather than vanishing", async () => {
    // End-to-end through the registered production handler.
    const eventUuid = nextUuid();
    const result = await dispatchPartnerEvent({
      eventType: "reaction.received",
      eventUuid,
      data: {
        reaction_uuid: nextUuid(),
        artifact_uuid: UNKNOWN_ARTIFACT,
        kind: "like",
      },
      source: "webhook",
    });

    expect(result.status, "an unknown artifact must defer, not silently skip").toBe("deferred");
    expect(await processedCount(eventUuid)).toBe(0);
  });
});

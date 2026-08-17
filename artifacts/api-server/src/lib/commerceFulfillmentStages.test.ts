/**
 * commerceFulfillmentStages.test.ts — the ladder, the translation onto it, and
 * the buyer's reading of where an order is.
 *
 * Every case below fails if its rule is removed, which is the only reason to
 * write one. In particular:
 *
 * **The monotonic guard.** Printify's order list is not a monotonic log — a
 * status can be re-reported, an order re-queued, a page stale — and the poller
 * writes whatever it maps. Without `nextFulfillmentState` refusing to go
 * backwards, a buyer watches their delivered parcel return to the press. That is
 * asserted directly, in both directions, and for the unknown status too.
 *
 * **The parked reading.** A parked order and an in-flight one are the same row
 * except for a counter, and the entire point of the timeline is that they must
 * not read the same. So `stalled` and `moving` are asserted as different values
 * for two rows that differ only in that counter.
 *
 * **The manual path.** The two admin endpoints deliberately never touch the
 * worker's columns, which is what keeps the only proven fulfilment path exactly
 * what it was. That means an order the worker gave up on and a human then pushed
 * through KEEPS a spent budget and a stored error forever. A stall test that
 * read only those two would call a shipped parcel stuck, and there is a case
 * below that fails if this one is not handled.
 *
 * Pure, so there is no database here and no fetch: this module imports neither,
 * on purpose, and a test that needed one would be evidence it had stopped being
 * pure.
 */

import { describe, expect, it } from "vitest";
import {
  BUYER_STAGES,
  FULFILLMENT_LADDER,
  MAX_FULFILLMENT_ATTEMPTS,
  PROVIDER_STATUS_TO_STATE,
  buyerTimeline,
  ladderRank,
  mapProviderStatus,
  nextFulfillmentState,
  normalizeProviderStatus,
  type BuyerTimelineInput,
} from "./commerceFulfillmentStages";

const T0 = new Date("2026-08-10T10:00:00.000Z");
const T1 = new Date("2026-08-10T10:05:00.000Z");
const T2 = new Date("2026-08-10T10:30:00.000Z");
const T3 = new Date("2026-08-12T09:00:00.000Z");
const T4 = new Date("2026-08-15T14:00:00.000Z");

/** A healthy paid order that nothing has been done to yet. */
function order(overrides: Partial<BuyerTimelineInput> = {}): BuyerTimelineInput {
  return {
    orderStatus: "paid",
    fulfillmentState: "unfulfilled",
    createdAt: T0,
    submittedAt: null,
    releasedAt: null,
    shippedAt: null,
    deliveredAt: null,
    fulfillmentAttempts: 0,
    hasFulfillmentError: false,
    fulfillmentLastAttemptAt: null,
    ...overrides,
  };
}

describe("the fulfilment ladder", () => {
  it("is ordered, and `canceled` is not on it", () => {
    // Rank order IS the guard. If these ever compare differently, an order can
    // be walked backwards by a re-reported status and nothing else fails.
    expect(ladderRank("unfulfilled")).toBeLessThan(ladderRank("submitted"));
    expect(ladderRank("submitted")).toBeLessThan(ladderRank("in_production"));
    expect(ladderRank("in_production")).toBeLessThan(ladderRank("shipped"));
    expect(ladderRank("shipped")).toBeLessThan(ladderRank("delivered"));

    // Off-ladder, deliberately: a rank for `canceled` would have to be either
    // "before submitted" or "after delivered", and the monotonic guard would
    // then enforce whichever lie was chosen.
    expect(ladderRank("canceled")).toBe(-1);
    expect(FULFILLMENT_LADDER).not.toContain("canceled");
  });

  it("gives an unrecognised state a rank of -1 rather than throwing", () => {
    // The column is a varchar precisely so an unknown literal is survivable.
    expect(ladderRank("something_nobody_declared")).toBe(-1);
  });
});

describe("reading Printify's vocabulary", () => {
  it("maps the status captured from a live response", () => {
    // `in-production`, hyphenated, is the real observed value on the real
    // released order. If nothing else in this file survives, this must.
    expect(mapProviderStatus("in-production")).toBe("in_production");
  });

  it("folds case and punctuation and nothing else", () => {
    expect(normalizeProviderStatus("In_Production")).toBe("in-production");
    expect(normalizeProviderStatus("  IN PRODUCTION ")).toBe("in-production");
    expect(mapProviderStatus("IN_PRODUCTION")).toBe("in_production");

    // NOT stemmed, NOT prefix-matched. A fuzzy match here adopts a status that
    // means something else.
    expect(mapProviderStatus("in-production-queue")).toBeNull();
    expect(mapProviderStatus("production")).toBeNull();
  });

  it("maps `fulfilled` onto shipped, or the shipped rung is unreachable", () => {
    // Printify has no `shipped` status in its lifecycle. If `fulfilled` maps
    // anywhere else, nothing in the system can ever write `shipped` — which is
    // the exact bug this whole feature exists to end.
    expect(mapProviderStatus("fulfilled")).toBe("shipped");
    expect(mapProviderStatus("partially-fulfilled")).toBe("shipped");
  });

  it("treats every pre-manufacturing status as submitted", () => {
    for (const s of ["pending", "on-hold", "sending-to-production", "payment-not-received"]) {
      expect(mapProviderStatus(s), s).toBe("submitted");
    }
  });

  it("maps both spellings of cancellation", () => {
    expect(mapProviderStatus("canceled")).toBe("canceled");
    expect(mapProviderStatus("cancelled")).toBe("canceled");
    expect(mapProviderStatus("cancelled-by-provider")).toBe("canceled");
  });

  it("answers null for an unknown, an empty and an absent status", () => {
    // null is a first-class answer meaning "learn nothing", never an error.
    expect(mapProviderStatus("some-new-printify-status")).toBeNull();
    expect(mapProviderStatus("")).toBeNull();
    expect(mapProviderStatus("   ")).toBeNull();
    expect(mapProviderStatus(null)).toBeNull();
    expect(mapProviderStatus(undefined)).toBeNull();
  });

  it("has no mapping for `has-issues`, on purpose", () => {
    // An order with issues is stuck wherever it already was. Mapping it onto a
    // rung would move an order on the strength of bad news.
    expect(PROVIDER_STATUS_TO_STATE["has-issues"]).toBeUndefined();
    expect(mapProviderStatus("has-issues")).toBeNull();
  });
});

describe("the monotonic guard", () => {
  it("advances forward", () => {
    expect(nextFulfillmentState("submitted", "in_production")).toBe("in_production");
    expect(nextFulfillmentState("in_production", "shipped")).toBe("shipped");
    expect(nextFulfillmentState("unfulfilled", "delivered")).toBe("delivered");
  });

  it("REFUSES to go backwards", () => {
    // The one that matters. Printify re-reporting `on-hold` on an order already
    // in production must not walk the buyer's timeline back a stage.
    expect(nextFulfillmentState("in_production", "submitted")).toBe("in_production");
    expect(nextFulfillmentState("delivered", "shipped")).toBe("delivered");
    expect(nextFulfillmentState("shipped", "in_production")).toBe("shipped");
  });

  it("changes nothing at all for an unknown status", () => {
    // `null` observed means "learn nothing", NOT "reset".
    for (const state of FULFILLMENT_LADDER) {
      expect(nextFulfillmentState(state, null), state).toBe(state);
    }
    expect(nextFulfillmentState("canceled", null)).toBe("canceled");
  });

  it("honours a cancellation from any rung except delivered", () => {
    expect(nextFulfillmentState("submitted", "canceled")).toBe("canceled");
    expect(nextFulfillmentState("in_production", "canceled")).toBe("canceled");
    expect(nextFulfillmentState("shipped", "canceled")).toBe("canceled");

    // A parcel that arrived is not un-delivered by a late provider cancellation.
    // Telling a buyer holding their sticker that it was canceled is worse than
    // dropping the update.
    expect(nextFulfillmentState("delivered", "canceled")).toBe("delivered");
  });

  it("never moves an order out of `canceled`", () => {
    expect(nextFulfillmentState("canceled", "in_production")).toBe("canceled");
    expect(nextFulfillmentState("canceled", "delivered")).toBe("canceled");
  });

  it("leaves a state it cannot place entirely alone", () => {
    // A hand-edit, or a value from a future version. Advancing off the back of
    // a rank of -1 would treat it as "before everything" and silently regress.
    expect(nextFulfillmentState("some_future_state", "in_production")).toBe("some_future_state");
  });
});

describe("the buyer's timeline", () => {
  it("marks the current stage and stamps every completed one", () => {
    const t = buyerTimeline(
      order({
        fulfillmentState: "in_production",
        submittedAt: T1,
        releasedAt: T2,
      }),
    );

    expect(t.current).toBe("in_production");
    expect(t.progress).toBe("moving");

    const byId = new Map(t.stages.map((s) => [s.id, s]));
    expect(byId.get("paid")!.reached).toBe(true);
    expect(byId.get("paid")!.at).toBe(T0.toISOString());
    expect(byId.get("submitted")!.at).toBe(T1.toISOString());
    expect(byId.get("in_production")!.at).toBe(T2.toISOString());
    expect(byId.get("in_production")!.current).toBe(true);

    // Not yet reached, and no invented timestamp on the ones that have not.
    expect(byId.get("shipped")!.reached).toBe(false);
    expect(byId.get("shipped")!.at).toBeNull();
    expect(byId.get("delivered")!.reached).toBe(false);

    // Exactly one current stage, always.
    expect(t.stages.filter((s) => s.current)).toHaveLength(1);
  });

  it("reports the stages in order and reports all of them", () => {
    const t = buyerTimeline(order());
    expect(t.stages.map((s) => s.id)).toEqual([...BUYER_STAGES]);
  });

  it("shows a healthy just-paid order sitting at `paid`", () => {
    const t = buyerTimeline(order());
    expect(t.current).toBe("paid");
    expect(t.progress).toBe("moving");
    expect(t.stalledAt).toBeNull();
  });

  it("shows a shipped order at shipped, with its own stamp", () => {
    const t = buyerTimeline(
      order({
        fulfillmentState: "shipped",
        submittedAt: T1,
        releasedAt: T2,
        shippedAt: T3,
      }),
    );
    expect(t.current).toBe("shipped");
    expect(t.progress).toBe("moving");
    expect(t.stages.find((s) => s.id === "shipped")!.at).toBe(T3.toISOString());
  });

  it("shows a delivered order finished", () => {
    const t = buyerTimeline(
      order({
        fulfillmentState: "delivered",
        submittedAt: T1,
        releasedAt: T2,
        shippedAt: T3,
        deliveredAt: T4,
      }),
    );
    expect(t.current).toBe("delivered");
    expect(t.stages.every((s) => s.reached)).toBe(true);
  });

  // ── The reason this feature exists ──────────────────────────────────────

  it("does NOT read a parked order the same as an in-flight one", () => {
    // Two rows identical but for the attempt counter and its stored reason.
    // If these compare equal, the feature is gone.
    const inFlight = buyerTimeline(order({ fulfillmentAttempts: 1, hasFulfillmentError: true, fulfillmentLastAttemptAt: T1 }));
    const parked = buyerTimeline(
      order({
        fulfillmentAttempts: MAX_FULFILLMENT_ATTEMPTS,
        hasFulfillmentError: true,
        fulfillmentLastAttemptAt: T1,
      }),
    );

    expect(inFlight.progress).toBe("moving");
    expect(parked.progress).toBe("stalled");
    expect(parked.progress).not.toBe(inFlight.progress);
  });

  it("says WHERE a parked order stopped", () => {
    const parkedAtSubmit = buyerTimeline(
      order({
        fulfillmentAttempts: MAX_FULFILLMENT_ATTEMPTS,
        hasFulfillmentError: true,
        fulfillmentLastAttemptAt: T1,
      }),
    );
    expect(parkedAtSubmit.stalledAt).toBe("paid");

    const parkedAtRelease = buyerTimeline(
      order({
        fulfillmentState: "submitted",
        submittedAt: T1,
        fulfillmentAttempts: MAX_FULFILLMENT_ATTEMPTS,
        hasFulfillmentError: true,
        fulfillmentLastAttemptAt: T2,
      }),
    );
    expect(parkedAtRelease.stalledAt).toBe("submitted");
  });

  it("does not call an order stalled just because it once failed", () => {
    // One refusal with five tries left is an order on its way. Shouting about a
    // 429 that clears in two minutes is how a status page becomes noise.
    const t = buyerTimeline(
      order({ fulfillmentAttempts: 1, hasFulfillmentError: true, fulfillmentLastAttemptAt: T1 }),
    );
    expect(t.progress).toBe("moving");
    expect(t.stalledAt).toBeNull();
  });

  it("does not call an order stalled that a HUMAN pushed through after the park", () => {
    // The manual admin endpoints never clear the worker's columns — that is
    // deliberate, and it is what keeps the only proven fulfilment path what it
    // always was. So this row keeps a spent budget and a stored error forever,
    // and it is nonetheless fine: it moved AFTER the failure.
    const t = buyerTimeline(
      order({
        fulfillmentState: "in_production",
        submittedAt: T2,
        releasedAt: T3,
        fulfillmentAttempts: MAX_FULFILLMENT_ATTEMPTS,
        hasFulfillmentError: true,
        fulfillmentLastAttemptAt: T1, // the failure came BEFORE the manual push
      }),
    );
    expect(t.progress).toBe("moving");
    expect(t.current).toBe("in_production");
  });

  it("does not call a DELIVERED order stalled, whatever the counter says", () => {
    const t = buyerTimeline(
      order({
        fulfillmentState: "delivered",
        submittedAt: T1,
        releasedAt: T2,
        shippedAt: T3,
        deliveredAt: T4,
        fulfillmentAttempts: MAX_FULFILLMENT_ATTEMPTS,
        hasFulfillmentError: true,
        fulfillmentLastAttemptAt: T4,
      }),
    );
    expect(t.progress).toBe("moving");
  });

  // ── Orders that ended ───────────────────────────────────────────────────

  it("reports a refunded order as stopped, not stalled and not moving", () => {
    const t = buyerTimeline(order({ orderStatus: "refunded", fulfillmentState: "submitted", submittedAt: T1 }));
    expect(t.progress).toBe("stopped");
    expect(t.stalledAt).toBeNull();
  });

  it("reports an order canceled at the printer as stopped", () => {
    const t = buyerTimeline(order({ fulfillmentState: "canceled", submittedAt: T1 }));
    expect(t.progress).toBe("stopped");
  });

  it("has nothing to say about an order that was never paid for", () => {
    // A five-stage progress bar under a declined card reads as a queue the
    // buyer is waiting in.
    for (const status of ["pending_payment", "authenticating", "payment_failed", "canceled"]) {
      const t = buyerTimeline(order({ orderStatus: status }));
      expect(t.progress, status).toBe("none");
      expect(t.current, status).toBeNull();
      expect(t.stages.every((s) => !s.reached), status).toBe(true);
    }
  });

  // ── Rows that predate these columns ─────────────────────────────────────

  it("still reports a stage reached when its timestamp was never recorded", () => {
    // The real order was fulfilled by hand before 0030 existed. Its state is
    // real and its stamps are not, and inventing one from `updated_at` would
    // put a fabricated time in front of a buyer.
    const t = buyerTimeline(order({ fulfillmentState: "in_production", submittedAt: null, releasedAt: null }));
    expect(t.current).toBe("in_production");
    expect(t.stages.find((s) => s.id === "in_production")!.reached).toBe(true);
    expect(t.stages.find((s) => s.id === "in_production")!.at).toBeNull();
  });

  it("credits a stage whose stamp is set even when the ladder has moved off it", () => {
    // Canceled at the printer after it had already shipped. The state is
    // off-ladder (rank -1) and the rungs it genuinely climbed still show.
    const t = buyerTimeline(
      order({ fulfillmentState: "canceled", submittedAt: T1, releasedAt: T2, shippedAt: T3 }),
    );
    const byId = new Map(t.stages.map((s) => [s.id, s]));
    expect(byId.get("submitted")!.reached).toBe(true);
    expect(byId.get("shipped")!.reached).toBe(true);
    expect(byId.get("delivered")!.reached).toBe(false);
    expect(t.current).toBe("shipped");
  });

  it("survives an unparseable timestamp rather than emitting one", () => {
    const t = buyerTimeline(order({ createdAt: "not a date", fulfillmentState: "submitted", submittedAt: T1 }));
    expect(t.stages.find((s) => s.id === "paid")!.at).toBeNull();
    expect(t.stages.find((s) => s.id === "paid")!.reached).toBe(true);
  });
});

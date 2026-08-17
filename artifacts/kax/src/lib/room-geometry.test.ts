import { describe, it, expect } from "vitest";
import { wallAllocation } from "./room-geometry";

/**
 * The wall split, pinned.
 *
 * This exists because the bug it fixes was invisible: own-then-curated with a
 * single truncation reads as obviously correct, and is wrong only for stores
 * with more of their own images than the wall can hold. Kannaka has 426, so
 * every curated piece was cut, and the sole symptom was a work flashing on
 * screen for one frame before the paged fetch of her own works resolved.
 *
 * It is load-bearing now: curating is how a shop offers a piece it did not
 * make, and the checkout desk only sells prints of what hangs in the room.
 */
describe("wallAllocation", () => {
  const MAX = 16;

  it("gives a curated piece a slot even when the owner could fill the wall", () => {
    // The regression. Revert to `[...own, ...curated].slice(0, MAX)` and
    // curated is 0 here, which is exactly what shipped.
    expect(wallAllocation(426, 1, MAX)).toEqual({ own: 15, curated: 1 });
  });

  it("lets the owner have the whole wall when nothing is curated", () => {
    expect(wallAllocation(426, 0, MAX)).toEqual({ own: 16, curated: 0 });
  });

  it("caps curated at half when both sides could fill it", () => {
    // Own works lead: the room reads as this agent's first.
    expect(wallAllocation(426, 20, MAX)).toEqual({ own: 8, curated: 8 });
  });

  it("lets curation fill the space the owner does not need", () => {
    // Half is a guarantee, not a cap — sixteen empty frames serve no one.
    expect(wallAllocation(0, 20, MAX)).toEqual({ own: 0, curated: 16 });
    expect(wallAllocation(2, 20, MAX)).toEqual({ own: 2, curated: 14 });
  });

  it("never hangs more than the wall holds", () => {
    for (let own = 0; own <= 40; own++) {
      for (let curated = 0; curated <= 40; curated++) {
        const share = wallAllocation(own, curated, MAX);
        expect(share.own + share.curated, `own=${own} curated=${curated}`).toBeLessThanOrEqual(MAX);
        expect(share.own).toBeLessThanOrEqual(own);
        expect(share.curated).toBeLessThanOrEqual(curated);
        // No slot is left empty while something is waiting for it.
        if (share.own + share.curated < MAX) {
          expect(share.own, `own=${own} curated=${curated}`).toBe(own);
          expect(share.curated, `own=${own} curated=${curated}`).toBe(curated);
        }
      }
    }
  });

  it("treats a small store as a small store rather than padding it", () => {
    expect(wallAllocation(2, 1, MAX)).toEqual({ own: 2, curated: 1 });
    expect(wallAllocation(0, 0, MAX)).toEqual({ own: 0, curated: 0 });
  });

  it("refuses to be tripped by negative counts", () => {
    expect(wallAllocation(-5, -5, MAX)).toEqual({ own: 0, curated: 0 });
  });
});

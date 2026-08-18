/**
 * The ramp you SEE must be the ramp you WALK ON.
 *
 * Nick walked the deployed Undercroft on 2026-08-18 and reported that going
 * down worked fine but looked wrong: "the graphics of the ramp are flipped
 * backwards with the tallest part where the shortest part should be at ground
 * level, so when I go down the ramp I actually go through the air and through
 * the ramp to arrive at the underground floor."
 *
 * He was exactly right, and every existing test passed anyway. `undercroftDeckY`
 * was correct, the collision replay was correct, the guards were correct — the
 * only thing wrong was the mesh, and the suite runs in Node with no DOM and had
 * never looked at a mesh. An earlier investigation into this same complaint
 * concluded "the ramp geometry is sound, do not re-fix it", which was true of
 * the geometry and useless to the person who could see the ramp.
 *
 * The cause: the tilt was derived from `deckBottomZ - deckTopZ`, but a plane
 * rotated about X travels toward -Z as its local +Y grows. Both ramps came out
 * end-for-end, wrong by the whole 6 m drop.
 *
 * This test walks the DRAWN surface and demands it agree with the standable
 * one. It is the only thing standing between that bug and the next person.
 */

import { describe, expect, it } from "vitest";
import {
  RAMP_DROP,
  RAMP_RUN,
  UNDERCROFT_ENTRANCES,
  UNDERCROFT_FLOOR_Y,
  UNDERCROFT_SURFACE_Y,
  undercroftDeckY,
  undercroftRampPointAt,
  undercroftRampTransform,
} from "./undercroft";

/** Sub-millimetre: this is arithmetic, not a tolerance to be negotiated. */
const EPS = 1e-9;

describe.each(UNDERCROFT_ENTRANCES.map((e) => [e.id, e] as const))(
  "%s ramp, as drawn",
  (_id, e) => {
    const m = undercroftRampTransform(e);

    it("puts the high end at the top of the cutting and the low end at the floor", () => {
      const top = undercroftRampPointAt(e, -m.length / 2);
      const bottom = undercroftRampPointAt(e, m.length / 2);
      const [high, low] = top.y > bottom.y ? [top, bottom] : [bottom, top];

      expect(high.y).toBeCloseTo(UNDERCROFT_SURFACE_Y, 9);
      expect(low.y).toBeCloseTo(UNDERCROFT_FLOOR_Y, 9);
      // ...and the high end must be at the END OF THE DECK THAT IS AT SURFACE
      // LEVEL. Getting the heights right while swapping the ends is precisely
      // the bug: both are 0 and -6, just at opposite ends of the cutting.
      expect(high.z).toBeCloseTo(e.deckTopZ, 9);
      expect(low.z).toBeCloseTo(e.deckBottomZ, 9);
    });

    it("matches the surface a visitor actually stands on, all the way down", () => {
      let worst = 0;
      for (let i = 0; i <= 40; i++) {
        const t = -m.length / 2 + (i / 40) * m.length;
        const p = undercroftRampPointAt(e, t);
        const walkable = undercroftDeckY(m.x, p.z);
        // The slab spans exactly the deck, so every sample must be on it.
        expect(walkable).not.toBeNull();
        worst = Math.max(worst, Math.abs(p.y - (walkable as number)));
      }
      // The mirrored version failed this by 6.000 m — the entire drop.
      expect(worst).toBeLessThan(EPS);
    });

    it("is as long as the slope it stands in for", () => {
      expect(m.length).toBeCloseTo(Math.hypot(RAMP_RUN, RAMP_DROP), 9);
    });

    it("descends at the grade the collision uses, not some other grade", () => {
      const a = undercroftRampPointAt(e, -m.length / 2);
      const b = undercroftRampPointAt(e, m.length / 2);
      const grade = Math.abs(b.y - a.y) / Math.abs(b.z - a.z);
      expect(grade).toBeCloseTo(RAMP_DROP / RAMP_RUN, 9);
    });
  },
);

describe("both ramps together", () => {
  it("fall in opposite directions, because they face each other", () => {
    const [north, south] = UNDERCROFT_ENTRANCES;
    const fall = (e: (typeof UNDERCROFT_ENTRANCES)[number]) => {
      const m = undercroftRampTransform(e);
      const a = undercroftRampPointAt(e, -m.length / 2);
      const b = undercroftRampPointAt(e, m.length / 2);
      // Which way does z move as we descend?
      return Math.sign(a.y > b.y ? b.z - a.z : a.z - b.z);
    };
    expect(fall(north)).toBe(north.fallDir);
    expect(fall(south)).toBe(south.fallDir);
  });
});

/**
 * city-layout.test.ts — the wall you see and the wall you hit must be the same wall.
 *
 * Two bugs, one cause: this arithmetic lived in more than one place (#301).
 *
 * All four venues are mounted a quarter turn round. A quarter turn swaps a
 * box's x and z extents, and every collision box had been transcribed from the
 * UNROTATED geometry — so each blocked along the wrong axis. The Bank declared
 * hx 5.7 against a rotated half-width of 4.5: a visitor stopped 1.2 units short
 * of a wall that was not there, on the side facing the street.
 *
 * And the monument's stone sat at `depth - 4` while its collision sat at
 * `streetDepth - 6` — the same expression from two variables, two units apart.
 *
 * The values below are checked against the geometry in the scene file itself,
 * so the next person to resize or rotate a building cannot leave the collision
 * behind. That is the whole point: a hand-copied table of half-extents is
 * correct right up until somebody rotates something.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FOOTPRINT_MARGIN,
  MONUMENT_Z_OFFSET,
  VENUE_SHELLS,
  footprintFor,
  monumentZFor,
  streetDepthFor,
  venueFootprint,
  type VenueKey,
} from "./city-layout";

const here = dirname(fileURLToPath(import.meta.url));
const SCENE = readFileSync(join(here, "..", "pages", "marketplace-3d.tsx"), "utf8");

describe("venue footprints", () => {
  it("swaps the extents of a quarter-turned box", () => {
    // The defect, as arithmetic. A 10-wide, 9-deep shell turned a quarter is
    // 9 wide and 10 deep, not the other way round.
    const f = footprintFor([10, 7.5, 9], Math.PI / 2, 0);
    expect(f.hx).toBeCloseTo(4.5);
    expect(f.hz).toBeCloseTo(5.0);
    // Negative quarter turn is the same footprint — the Bank and Residences
    // are mounted at -PI/2 and must not differ from their mirrors.
    const g = footprintFor([10, 7.5, 9], -Math.PI / 2, 0);
    expect(g).toEqual(f);
  });

  it("leaves an unrotated box alone", () => {
    const f = footprintFor([10, 7.5, 9], 0, 0);
    expect(f.hx).toBeCloseTo(5.0);
    expect(f.hz).toBeCloseTo(4.5);
    // Half a turn is also unchanged, which a swap-only implementation would
    // get right by accident and an angle-aware one gets right on purpose.
    // Floating point: cos(PI) is exactly -1 but sin(PI) is 1.2e-16, so half a
    // turn lands a hair off. Compare numerically rather than pretending it is
    // exact — an equality that only passes at right angles is the assumption
    // this whole file exists to remove.
    const half = footprintFor([10, 7.5, 9], Math.PI, 0);
    expect(half.hx).toBeCloseTo(f.hx);
    expect(half.hz).toBeCloseTo(f.hz);
  });

  it("handles an angle that is not a quarter turn", () => {
    // The seventh venue is coming (#6 in the growth model). A formula that
    // only understands right angles would be the same assumption that caused
    // this bug, wearing a function's clothes.
    const f = footprintFor([10, 5, 10], Math.PI / 4, 0);
    expect(f.hx).toBeCloseTo((10 * Math.SQRT1_2 + 10 * Math.SQRT1_2) / 2);
    expect(f.hx).toBeCloseTo(f.hz);
    expect(f.hx).toBeGreaterThan(5); // a turned square needs MORE room, not less
  });

  it("gives every venue the footprint its own geometry implies", () => {
    const expected: Record<VenueKey, { hx: number; hz: number }> = {
      arcade: { hx: 4.5 + FOOTPRINT_MARGIN, hz: 5.0 + FOOTPRINT_MARGIN },
      bank: { hx: 4.5 + FOOTPRINT_MARGIN, hz: 5.5 + FOOTPRINT_MARGIN },
      residences: { hx: 4.0 + FOOTPRINT_MARGIN, hz: 4.5 + FOOTPRINT_MARGIN },
      joinery: { hx: 4.0 + FOOTPRINT_MARGIN, hz: 5.25 + FOOTPRINT_MARGIN },
    };
    for (const key of Object.keys(expected) as VenueKey[]) {
      const got = venueFootprint(key);
      expect(got.hx, `${key} hx`).toBeCloseTo(expected[key].hx);
      expect(got.hz, `${key} hz`).toBeCloseTo(expected[key].hz);
    }
  });

  it("declares the same shell the scene actually renders", () => {
    // The guard with teeth. If somebody resizes a building in the scene and
    // not here, the collision silently keeps the old shape — which is exactly
    // how this bug survived being looked at.
    for (const [key, shell] of Object.entries(VENUE_SHELLS)) {
      const [w, h, d] = shell.size;
      const literal = `<boxGeometry args={[${w}, ${h}, ${d}]} />`;
      expect(SCENE.includes(literal), `${key}: scene has no ${literal}`).toBe(true);
    }
  });

  it("mounts each venue at the rotation its footprint assumes", () => {
    // The other half of the same drift. A footprint derived for +PI/2 is wrong
    // the moment the building is mounted at 0.
    const mounts: Array<[VenueKey, string]> = [
      ["arcade", "<ArcadeVenue"],
      ["bank", "<BankVenue"],
      ["residences", "<ResidencesTower"],
      ["joinery", "<JoineryVenue"],
    ];
    for (const [key, tag] of mounts) {
      const at = SCENE.indexOf(tag);
      expect(at, `${tag} is not mounted in the scene`).toBeGreaterThan(-1);
      const line = SCENE.slice(at, SCENE.indexOf("/>", at));
      const sign = VENUE_SHELLS[key].rotationY > 0 ? "rotation={Math.PI / 2}" : "rotation={-Math.PI / 2}";
      expect(line, `${key} is mounted at a rotation its footprint does not assume`).toContain(sign);
    }
  });
});

describe("the monument", () => {
  it("puts its collision where its stone is", () => {
    // They were two units apart: `depth - 4` for the geometry, `streetDepth - 6`
    // for the obstacle. One offset now, read by both.
    for (const storeCount of [0, 1, 2, 47, 48, 302]) {
      expect(monumentZFor(storeCount)).toBe(streetDepthFor(storeCount) + MONUMENT_Z_OFFSET);
    }
  });

  it("leaves the scene no second copy of the arithmetic", () => {
    const code = SCENE.split(/\r?\n/)
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect(code, "the street still computes its own depth").not.toMatch(/-\s*2\s*-\s*(rows|Math\.max)/);
    expect(code, "the monument still has its own offset").not.toMatch(/depth\s*-\s*4|streetDepth\s*-\s*6/);
    expect(code).toContain("streetDepthFor");
    expect(code).toContain("monumentZFor");
    expect(code).toContain("venueFootprint");
  });

  it("keeps the street's depth formula intact", () => {
    // Behaviour must not move: one row per two stores, 4.5 apart, starting at
    // -2. Changing this would shift every building in the city.
    expect(streetDepthFor(0)).toBe(-6.5);
    expect(streetDepthFor(1)).toBe(-6.5);
    expect(streetDepthFor(2)).toBe(-6.5);
    expect(streetDepthFor(4)).toBe(-11);
    expect(streetDepthFor(48)).toBe(-2 - 24 * 4.5);
  });
});

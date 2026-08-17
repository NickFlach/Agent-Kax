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
  MAX_STREET_STOREFRONTS,
  MONUMENT_Z_OFFSET,
  STREET_SHOP_Y,
  VENUE_SHELLS,
  footprintFor,
  layoutFor,
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
      // `scada` was never added when the sixth venue shipped, and the loop
      // below iterates `Object.keys(expected)` — so this guard has been
      // silently skipping 0xSCADA since #318. It is not a type error because
      // `tsconfig.json` excludes `**/*.test.ts`, so the `Record<VenueKey,…>`
      // annotation was never checked. Filled in here rather than left for the
      // next person to rediscover.
      scada: { hx: 3.1 + FOOTPRINT_MARGIN, hz: 4.3 + FOOTPRINT_MARGIN },
      undercroft: { hx: 1.5 + FOOTPRINT_MARGIN, hz: 1.5 + FOOTPRINT_MARGIN },
    };
    // And the loop is keyed off the SHELLS, so the next omission fails here
    // instead of being skipped. This is the same fix #318 applied to the
    // rotation guard beside it and did not apply to this one.
    expect(Object.keys(expected).sort()).toEqual(Object.keys(VENUE_SHELLS).sort());
    for (const key of Object.keys(VENUE_SHELLS) as VenueKey[]) {
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
    const mounts: Record<VenueKey, string> = {
      arcade: "<ArcadeVenue",
      bank: "<BankVenue",
      residences: "<ResidencesTower",
      joinery: "<JoineryVenue",
      scada: "<ScadaVenue",
      undercroft: "<UndercroftMouth",
    };
    // Keyed by VenueKey rather than a hand-written list, so a shell added
    // without a mount here is a TYPE error rather than a venue this guard
    // silently skips. The seventh venue was the moment that mattered: a
    // hardcoded list of four would have covered everything except the one
    // just added.
    expect(Object.keys(mounts).sort()).toEqual(Object.keys(VENUE_SHELLS).sort());
    for (const [key, tag] of Object.entries(mounts) as Array<[VenueKey, string]>) {
      const at = SCENE.indexOf(tag);
      expect(at, `${tag} is not mounted in the scene`).toBeGreaterThan(-1);
      const line = SCENE.slice(at, SCENE.indexOf("/>", at));
      const sign = VENUE_SHELLS[key].rotationY > 0 ? "rotation={Math.PI / 2}" : "rotation={-Math.PI / 2}";
      expect(line, `${key} is mounted at a rotation its footprint does not assume`).toContain(sign);
    }
  });

  it("only lets a shell be mounted twice if turning it cannot change its footprint", () => {
    // The guard above reads the FIRST mount of each tag. The Undercroft has
    // two mouths facing opposite ways, so the second one is unread — which
    // would be a hole if a quarter turn could change its footprint. It cannot:
    // the shell is square in plan, so every rotation gives the same box. This
    // asserts that rather than trusting it, and it fails the moment somebody
    // makes the mouth rectangular and leaves the mirrored mount behind.
    const shell = VENUE_SHELLS.undercroft;
    expect(shell.size[0], "the Undercroft mouth is no longer square in plan").toBe(shell.size[2]);
    const a = footprintFor(shell.size, Math.PI / 2);
    const b = footprintFor(shell.size, -Math.PI / 2);
    expect(a.hx).toBeCloseTo(b.hx);
    expect(a.hz).toBeCloseTo(b.hz);
    expect(a.hx).toBeCloseTo(a.hz);
    expect(SCENE.split("<UndercroftMouth").length - 1, "there should be exactly two ways down").toBe(2);
  });
});

/**
 * THE ORIGINAL 48.
 *
 * This is the most important test in the Undercroft change and it exists for
 * one sentence Nick said twice: the first forty-eight storefronts stay exactly
 * as they are. Not "we did not mean to move them" — the same set, the same
 * order, the same coordinates.
 *
 * So the whole grid is frozen. Forty-eight rows, written out, no formula: a
 * golden table generated from the code as it stood BEFORE the Undercroft
 * existed. A test that recomputed the expected positions from the same
 * arithmetic under test would agree with any change to that arithmetic, which
 * is the failure mode this is built to avoid.
 *
 * `layoutFor` moved from `marketplace-3d.tsx` into `city-layout.ts` as part of
 * this work so that both tiers could share one grid. That move is the reason
 * this table is worth having: it is the only thing standing between "the
 * street is unchanged" and somebody's word for it.
 */
const STREET_GOLDEN: ReadonlyArray<readonly [number, number]> = [
  [-6, -1.5], [6, -2], [-6, -6.5], [6, -6], [-6, -11], [6, -11],
  [-6, -15], [6, -15.5], [-6, -20], [6, -19.5], [-6, -24.5], [6, -24.5],
  [-6, -28.5], [6, -29], [-6, -33.5], [6, -33], [-6, -38], [6, -38],
  [-6, -42], [6, -42.5], [-6, -47], [6, -46.5], [-6, -51.5], [6, -51.5],
  [-6, -55.5], [6, -56], [-6, -60.5], [6, -60], [-6, -65], [6, -65],
  [-6, -69], [6, -69.5], [-6, -74], [6, -73.5], [-6, -78.5], [6, -78.5],
  [-6, -82.5], [6, -83], [-6, -87.5], [6, -87], [-6, -92], [6, -92],
  [-6, -96], [6, -96.5], [-6, -101], [6, -100.5], [-6, -105.5], [6, -105.5],
];

describe("the original 48 storefronts", () => {
  it("still stand exactly where they stood", () => {
    expect(STREET_GOLDEN.length, "the golden table is empty").toBe(48);
    const agents = Array.from({ length: 48 }, (_, i) => ({ slug: `agent-${i}` }));
    const got = layoutFor(agents);
    expect(got.length).toBe(48);
    for (let i = 0; i < 48; i++) {
      const want = STREET_GOLDEN[i]!;
      const item = got[i]!;
      // Exact equality, not toBeCloseTo. Every value here is a binary fraction
      // and a hair of drift in a shopfront is still a moved shopfront.
      expect(item.position, `storefront ${i} moved`).toEqual([want[0], STREET_SHOP_Y, want[1]]);
      const isLeft = want[0] < 0;
      expect(item.rotation, `storefront ${i} turned`).toEqual([0, isLeft ? Math.PI / 2 : -Math.PI / 2, 0]);
    }
  });

  it("keeps the same agent in the same slot, in the order it was given", () => {
    // "Same order" is half the promise and coordinates alone do not check it:
    // reversing the input would give the identical set of positions.
    const agents = Array.from({ length: 48 }, (_, i) => ({ slug: `agent-${i}` }));
    const got = layoutFor(agents);
    expect(got.map((g) => g.agent.slug)).toEqual(agents.map((a) => a.slug));
    // Alternating sides, two per row, is the thing that makes slot order and
    // street order the same fact.
    expect(got.filter((g) => g.position[0] < 0).length).toBe(24);
    expect(got[0]!.agent.slug).toBe("agent-0");
    expect(got[0]!.position[0]).toBeLessThan(0);
  });

  it("is still what the street mounts, and still cut at 48", () => {
    const code = SCENE.split(/\r?\n/)
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect(code, "the street stopped using the shared grid").toMatch(/layoutFor\(sceneAgents\)/);
    expect(MAX_STREET_STOREFRONTS, "the 48-cut moved").toBe(48);
    expect(code, "the street stopped reading the shared cut").toMatch(
      /MAX_3D_STOREFRONTS\s*=\s*MAX_STREET_STOREFRONTS/,
    );
    expect(code, "the street re-sorts what the API gave it").not.toMatch(/sceneAgents[\s\S]{0,40}\.sort\(/);
    expect(code, "the street sliced somewhere other than the top").toMatch(
      /allSceneAgents\.slice\(0,\s*MAX_3D_STOREFRONTS\)/,
    );
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

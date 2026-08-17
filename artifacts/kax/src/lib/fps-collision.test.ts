/**
 * fps-collision.test.ts — the street must not notice that obstacles grew a top.
 *
 * The Undercroft needed obstacles that stop blocking above (or below) a given
 * elevation. The rig had no vertical term at all, so adding one touches the
 * shared movement code that every scene in the city walks on. The one thing
 * Nick said twice about this feature is that the original street must be
 * exactly as it was — so "I added optional fields, they default to the old
 * behaviour" is not good enough as an assurance. It is checked here.
 *
 * THE METHOD. `oldResolve` below is the loop as it stood in
 * `first-person-rig.tsx` before this change, copied verbatim — not a
 * description of it, not a tidied version, the same statements in the same
 * order, including the `ny < 7` gate and the `Math.sign(dx || 1)` guard. The
 * new resolver is then run against it over the street's own obstacle list and
 * a randomised sweep of positions and elevations. If the two ever disagree on
 * a set of boxes with no vertical band, the street's collision has moved.
 *
 * ANTI-VACUITY. Two ways this could pass while proving nothing: an empty
 * obstacle list, and a sweep that never actually collides with anything. Both
 * are asserted against — the fixture list is asserted non-empty, and the sweep
 * counts how many samples were DEFLECTED and requires a substantial number.
 * A differential test where neither side ever moves is two functions agreeing
 * about doing nothing.
 */

import { describe, expect, it } from "vitest";
import {
  FLY_OVER_Y,
  OBSTACLE_PAD,
  obstacleBlocksAt,
  resolveObstacles,
  type FpsObstacle,
} from "./fps-collision";
import { monumentZFor, streetDepthFor, venueFootprint, layoutFor } from "./city-layout";
import {
  UNDERCROFT_CEILING_Y,
  UNDERCROFT_ENTRANCES,
  UNDERCROFT_FLOOR_Y,
  UNIT_FOOTPRINT,
  undercroftObstacles,
  undercroftSlots,
} from "./undercroft";

/** The rig's loop as it stood before obstacles had a vertical band. Verbatim. */
function oldResolve(x: number, z: number, y: number, obstacles: FpsObstacle[]): { x: number; z: number } {
  let nx = x;
  let nz = z;
  if (obstacles && y < 7) {
    const pad = 0.5;
    for (const o of obstacles) {
      const dx = nx - o.cx;
      const dz = nz - o.cz;
      const px = o.hx + pad - Math.abs(dx);
      const pz = o.hz + pad - Math.abs(dz);
      if (px > 0 && pz > 0) {
        if (px < pz) nx = o.cx + Math.sign(dx || 1) * (o.hx + pad);
        else nz = o.cz + Math.sign(dz || 1) * (o.hz + pad);
      }
    }
  }
  return { x: nx, z: nz };
}

/**
 * The street's obstacle list, built from the same helpers the scene builds it
 * from. Not a hand-copied table: `venueFootprint`, `monumentZFor` and
 * `layoutFor` are the actual sources, so a change to any of them shows up here
 * rather than being papered over by a stale fixture.
 */
function streetObstacles(storeCount = 48): FpsObstacle[] {
  const agents = Array.from({ length: storeCount }, (_, i) => ({ slug: `shop-${i}` }));
  const layout = layoutFor(agents);
  const streetDepth = streetDepthFor(storeCount);
  const towerZ = streetDepth - 20;
  const BOARD = { hx: 1.15, hz: 0.35 };
  return [
    ...layout.map((l) => ({ cx: l.position[0], cz: l.position[2], hx: 1.6, hz: 1.7 })),
    { cx: 0, cz: towerZ, hx: 7.8, hz: 7.8 },
    { cx: -3.6, cz: 15.5, ...BOARD },
    { cx: -6.2, cz: -12, hx: BOARD.hz, hz: BOARD.hx },
    { cx: 6.2, cz: -30, hx: BOARD.hz, hz: BOARD.hx },
    { cx: 0, cz: monumentZFor(storeCount), hx: 1.2, hz: 1.2 },
    { cx: -12.5, cz: streetDepth - 8, ...venueFootprint("arcade") },
    { cx: 12.5, cz: streetDepth - 8, ...venueFootprint("bank") },
    { cx: 12.5, cz: 3, ...venueFootprint("residences") },
    { cx: -12.5, cz: 3, ...venueFootprint("joinery") },
    { cx: 17.6, cz: -8.5, ...venueFootprint("scada") },
    { cx: -17.6, cz: -18.4, hx: 3.9, hz: 3.3 },
    { cx: -11, cz: -12, ...venueFootprint("undercroft") },
    { cx: 11, cz: -30, ...venueFootprint("undercroft") },
  ];
}

/** Deterministic sampler — a flaky collision test is worse than none. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("the street's collision behaviour has not moved", () => {
  it("builds a street to test against", () => {
    // Vacuity guard first. Everything below loops over this list; an empty one
    // would make every assertion in the file pass by describing nothing.
    const obs = streetObstacles();
    expect(obs.length).toBeGreaterThan(50);
    expect(obs.some((o) => o.yMin !== undefined || o.yMax !== undefined), "a street obstacle grew a vertical band").toBe(
      false,
    );
  });

  it("resolves every sampled step exactly as the old inline loop did", () => {
    const obs = streetObstacles();
    const rnd = mulberry32(20260817);
    let deflected = 0;
    const samples = 20000;
    for (let i = 0; i < samples; i++) {
      const x = -21 + rnd() * 42;
      const z = 16 - rnd() * 150;
      // Spans the fly-over gate on both sides so the ceiling is covered too.
      const y = -2 + rnd() * 12;
      const want = oldResolve(x, z, y, obs);
      const got = resolveObstacles(x, z, y, obs);
      // Bit-for-bit. A "close enough" comparison here would hide a change of
      // resolution ORDER, which is the thing most likely to drift.
      expect(got.x, `x @ ${x},${z},${y}`).toBe(want.x);
      expect(got.z, `z @ ${x},${z},${y}`).toBe(want.z);
      if (got.x !== x || got.z !== z) deflected++;
    }
    // The other half of anti-vacuity: two functions that never push anything
    // agree trivially. This sweep has to actually hit buildings.
    expect(deflected, "the sweep never collided with anything").toBeGreaterThan(samples * 0.05);
  });

  it("still stops colliding above the rooftops, at the same height", () => {
    const obs = streetObstacles();
    // Standing inside the first shopfront's box at street level: pushed out.
    const low = resolveObstacles(-6, -1.5, 1.75, obs);
    expect(low.x === -6 && low.z === -1.5, "a body at street level walked through a shopfront").toBe(false);
    // The same (x,z) at flying height: untouched, exactly as before.
    const high = resolveObstacles(-6, -1.5, FLY_OVER_Y, obs);
    expect(high).toEqual({ x: -6, z: -1.5 });
    expect(FLY_OVER_Y).toBe(7);
    expect(OBSTACLE_PAD).toBe(0.5);
  });
});

describe("a vertical band scopes an obstacle to its own storey", () => {
  it("lets a box declare a top, a bottom, both or neither", () => {
    const none: FpsObstacle = { cx: 0, cz: 0, hx: 1, hz: 1 };
    for (const y of [-100, -6, 0, 1.75, 6.9]) expect(obstacleBlocksAt(none, y)).toBe(true);
    const capped: FpsObstacle = { cx: 0, cz: 0, hx: 1, hz: 1, yMax: -2.4 };
    expect(obstacleBlocksAt(capped, -4.25)).toBe(true);
    expect(obstacleBlocksAt(capped, 1.75)).toBe(false);
    const floored: FpsObstacle = { cx: 0, cz: 0, hx: 1, hz: 1, yMin: -1.2 };
    expect(obstacleBlocksAt(floored, -4.25)).toBe(false);
    expect(obstacleBlocksAt(floored, 1.75)).toBe(true);
    const band: FpsObstacle = { cx: 0, cz: 0, hx: 1, hz: 1, yMin: -6.5, yMax: -2.4 };
    expect(obstacleBlocksAt(band, -4.25)).toBe(true);
    expect(obstacleBlocksAt(band, -8)).toBe(false);
    expect(obstacleBlocksAt(band, 0)).toBe(false);
  });

  it("does not block an underground unit's column at surface level", () => {
    // The hard problem stated plainly. Every unit is directly beneath ground
    // the visitor walks on, at x = ±6 — the same x as the street's shopfronts.
    const obs = undercroftObstacles();
    const units = obs.filter((o) => o.hx === UNIT_FOOTPRINT.hx && o.hz === UNIT_FOOTPRINT.hz);
    expect(units.length, "no unit obstacles found — the fixture proves nothing").toBe(48);
    expect(units.every((u) => u.yMax === UNDERCROFT_CEILING_Y), "a unit escaped the concourse band").toBe(true);

    const eyeBelow = UNDERCROFT_FLOOR_Y + 1.75;
    const eyeAbove = 1.75;
    let blockedBelow = 0;
    for (const u of units) {
      // Dead centre of the unit's own box: unambiguously inside it.
      const below = resolveObstacles(u.cx, u.cz, eyeBelow, [u]);
      if (below.x !== u.cx || below.z !== u.cz) blockedBelow++;
      const above = resolveObstacles(u.cx, u.cz, eyeAbove, [u]);
      expect(above, `unit at ${u.cx},${u.cz} blocked a body standing on the surface above it`).toEqual({
        x: u.cx,
        z: u.cz,
      });
    }
    expect(blockedBelow, "the units did not block anybody at concourse level either").toBe(units.length);
  });

  it("does not block a concourse walker with the surface apron's railings", () => {
    const obs = undercroftObstacles();
    const surface = obs.filter((o) => o.yMin !== undefined && o.yMin > UNDERCROFT_FLOOR_Y);
    expect(surface.length, "no surface-level obstacles found — the fixture proves nothing").toBeGreaterThan(3);

    const eyeBelow = UNDERCROFT_FLOOR_Y + 1.75;
    let blockedAbove = 0;
    for (const s of surface) {
      const below = resolveObstacles(s.cx, s.cz, eyeBelow, [s]);
      expect(below, `surface obstacle at ${s.cx},${s.cz} blocked a body on the concourse below it`).toEqual({
        x: s.cx,
        z: s.cz,
      });
      const above = resolveObstacles(s.cx, s.cz, 1.75, [s]);
      if (above.x !== s.cx || above.z !== s.cz) blockedAbove++;
    }
    expect(blockedAbove, "the railings block nobody at any elevation, so they are scenery").toBe(surface.length);
  });

  it("puts units directly under ground somebody stands on, at BOTH entrances", () => {
    // Without this the whole vertical term is speculative: if no apron ever
    // overlapped a unit in (x,z) the two tiers could not collide anyway and
    // the tests above would be describing a problem that does not arise. Both
    // courts are checked, because one of them holding the property is enough
    // to make the suite green while the other quietly moved.
    const slots = undercroftSlots().map((s) => s.position);
    expect(slots.length).toBe(48);
    for (const e of UNDERCROFT_ENTRANCES) {
      const under = slots.filter(
        (p) => p[0] >= e.court.x0 && p[0] <= e.court.x1 && p[2] >= e.court.z0 && p[2] <= e.court.z1,
      );
      expect(under.length, `${e.id} court has no unit beneath it`).toBeGreaterThan(0);
    }
  });
});

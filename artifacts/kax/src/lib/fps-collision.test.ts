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
 *
 * THE ONE PLACE THE TWO ARE NOW ALLOWED TO DIFFER, and it is checked rather
 * than excused. `resolveObstacles` pushes a body out to `centre ± (half + pad)`
 * — a face that lies OUTSIDE the walls whenever a box straddles one — and the
 * old loop returned that position untouched, because the bounds had been
 * applied to the proposal and were never looked at again. So the whole-frame
 * comparisons below hold `stepMove` against the old loop's answer CLAMPED TO
 * THE BOUNDS, which is strictly more than the old equality asked: every sample
 * must still agree bit for bit wherever the old answer was legal, and the ones
 * where it was not must land exactly on the wall. Both sweeps count how many
 * samples the clamp rescued and require it to be a real number of them, so
 * "they agree because the clamp never fires" cannot pass either.
 */

import { describe, expect, it } from "vitest";
import {
  FLY_OVER_Y,
  OBSTACLE_PAD,
  obstacleBlocksAt,
  resolveObstacles,
  stepMove,
  type FpsBounds,
  type FpsObstacle,
} from "./fps-collision";
import { monumentZFor, plazaZFor, PLAZA_FLANK_X, streetDepthFor, venueFootprint, layoutFor } from "./city-layout";
import { streetMouthsFor } from "./undercroft";
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
    { cx: -PLAZA_FLANK_X, cz: plazaZFor(storeCount), ...venueFootprint("arcade") },
    { cx: PLAZA_FLANK_X, cz: plazaZFor(storeCount), ...venueFootprint("bank") },
    { cx: 12.5, cz: 3, ...venueFootprint("residences") },
    { cx: -12.5, cz: 3, ...venueFootprint("joinery") },
    { cx: 17.6, cz: -8.5, ...venueFootprint("scada") },
    { cx: -17.6, cz: -18.4, hx: 3.9, hz: 3.3 },
    // Read from the same function the scene reads, not transcribed. The two
    // mouths this fixture used to carry were at coordinates the scene had
    // never placed them at, so the "street's obstacle list" it was
    // differentially testing was not the street's obstacle list.
    ...streetMouthsFor(storeCount).map((m) => ({ cx: m.x, cz: m.z, ...venueFootprint("undercroft") })),
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

/* ------------------------------------------------- the whole move, not half */

/**
 * `stepMove` had to grow two things the Undercroft needs and nothing else in
 * the city does: a band key taken from where the body IS rather than from
 * where it proposed to go, and an opt-in limit on how far one move may change
 * the ground. Both live in the rig every scene walks on, so both are tested
 * here the same way the resolver was — against a VERBATIM copy of the loop as
 * it stood, over the street's own obstacle list and over a stairwell terrain
 * shaped like the residences'.
 */
function oldFrame(
  x: number,
  y: number,
  z: number,
  dx: number,
  dz: number,
  dy: number,
  eyeHeight: number,
  bounds: FpsBounds | undefined,
  obstacles: FpsObstacle[] | undefined,
  groundHeight: ((x: number, z: number) => number) | undefined,
): { x: number; y: number; z: number } {
  let nx = x + dx;
  let nz = z + dz;
  let ny = y + dy;
  if (bounds) {
    nx = Math.max(bounds.minX, Math.min(bounds.maxX, nx));
    nz = Math.max(bounds.minZ, Math.min(bounds.maxZ, nz));
    ny = Math.max(bounds.minY ?? eyeHeight, Math.min(bounds.maxY ?? Infinity, ny));
  } else {
    ny = Math.max(ny, eyeHeight);
  }
  if (groundHeight) ny = groundHeight(nx, nz) + eyeHeight;
  const hit = oldResolve(nx, nz, ny, obstacles ?? []);
  return { x: hit.x, y: ny, z: hit.z };
}

/**
 * The old loop's answer, held inside the walls — the ONE difference the new
 * `stepMove` is allowed to make, and the thing this file's whole-frame sweeps
 * are differentially testing against.
 */
function clampedOld(
  want: { x: number; y: number; z: number },
  bounds: FpsBounds,
): { x: number; y: number; z: number } {
  return {
    x: Math.max(bounds.minX, Math.min(bounds.maxX, want.x)),
    y: want.y,
    z: Math.max(bounds.minZ, Math.min(bounds.maxZ, want.z)),
  };
}

function withinBounds(p: { x: number; z: number }, b: FpsBounds): boolean {
  return p.x >= b.minX && p.x <= b.maxX && p.z >= b.minZ && p.z <= b.maxZ;
}

/** The residences' stairwell, as it stands — including its 1.7 m side edge. */
function stairHeight(x: number, z: number): number {
  if (x < -11.5 || x > -8.5 || z < -3 || z > 3) return 0;
  const westLane = x < -10;
  if (!westLane) {
    if (z > 1.5) return 0;
    if (z < -1.5) return 1.7;
    return ((1.5 - z) / 3) * 1.7;
  }
  if (z < -1.5) return 1.7;
  if (z > 1.5) return 3.4;
  return 1.7 + ((z + 1.5) / 3) * 1.7;
}

describe("the shared rig still moves the street and the venues exactly as it did", () => {
  it("makes the same move as the old inline loop, frame for frame, on the street", () => {
    const obs = streetObstacles();
    const bounds: FpsBounds = { minX: -20.5, maxX: 20.5, minZ: -142, maxZ: 15, minY: 1.55, maxY: 28 };
    const rnd = mulberry32(31415);
    let deflected = 0;
    let vertical = 0;
    let rescued = 0;
    const samples = 20000;
    for (let i = 0; i < samples; i++) {
      const x = -21 + rnd() * 42;
      const z = 16 - rnd() * 150;
      // Spans both vertical clamps so the R/F half of the move is exercised.
      const y = 0.5 + rnd() * 30;
      // A whole frame's worth of input: walk, strafe, scroll dolly and R/F.
      const dx = (rnd() - 0.5) * 5;
      const dz = (rnd() - 0.5) * 5;
      const dy = (rnd() - 0.5) * 6;
      const raw = oldFrame(x, y, z, dx, dz, dy, 1.75, bounds, obs, undefined);
      const want = clampedOld(raw, bounds);
      if (raw.x !== want.x || raw.z !== want.z) rescued++;
      const got = stepMove({ x, y, z, dx, dz, dy, eyeHeight: 1.75, bounds, obstacles: obs });
      expect(got.x, `x @ ${x},${y},${z}`).toBe(want.x);
      expect(got.y, `y @ ${x},${y},${z}`).toBe(want.y);
      expect(got.z, `z @ ${x},${y},${z}`).toBe(want.z);
      // And the invariant in its own right, on every single sample: whatever
      // the old loop did, the body is inside the walls when the frame ends.
      expect(withinBounds(got, bounds), `out of bounds @ ${x},${y},${z} -> ${got.x},${got.z}`).toBe(true);
      if (got.x !== x + dx || got.z !== z + dz) deflected++;
      if (got.y !== y + dy) vertical++;
    }
    // Anti-vacuity, three ways: a sweep that never hit a building, never hit
    // the ceiling, or never caught the old loop outside the walls would be two
    // functions agreeing about doing nothing.
    expect(deflected, "the sweep never collided with anything").toBeGreaterThan(samples * 0.05);
    expect(vertical, "the sweep never exercised the vertical clamp").toBeGreaterThan(samples * 0.05);
    expect(rescued, "the old loop never left the bounds, so the clamp is untested here").toBeGreaterThan(0);
  });

  it("keeps the five venue boxes #311 fixed pushing along the axes they push along", () => {
    // The transposed-footprint bug, guarded directly rather than by proxy. Walk
    // at each venue's centre from all four sides and require the SAME
    // deflection out of the new whole-frame move as out of the old loop.
    const obs = streetObstacles();
    const venues: Array<[string, number, number]> = [
      ["arcade", -PLAZA_FLANK_X, plazaZFor(48)],
      ["bank", PLAZA_FLANK_X, plazaZFor(48)],
      ["residences", 12.5, 3],
      ["joinery", -12.5, 3],
      ["scada", 17.6, -8.5],
    ];
    let pushes = 0;
    for (const [name, cx, cz] of venues) {
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const from = { x: cx - dx * 8, z: cz - dz * 8 };
        const want = oldFrame(from.x, 1.75, from.z, dx * 8, dz * 8, 0, 1.75, undefined, obs, undefined);
        const got = stepMove({
          x: from.x,
          y: 1.75,
          z: from.z,
          dx: dx * 8,
          dz: dz * 8,
          dy: 0,
          eyeHeight: 1.75,
          obstacles: obs,
        });
        expect(got.x, `${name} from ${dx},${dz}`).toBe(want.x);
        expect(got.z, `${name} from ${dx},${dz}`).toBe(want.z);
        if (got.x !== from.x + dx * 8 || got.z !== from.z + dz * 8) pushes++;
      }
    }
    expect(pushes, "no venue deflected anybody — the fixture proves nothing").toBe(venues.length * 4);
  });

  it("walks the residences' stairwell exactly where it used to, edge and all", () => {
    // The only other scene with terrain. Its obstacles carry no vertical band,
    // so the new band key cannot change what blocks — and no `maxGroundStep`
    // is passed, so its 1.7 m side edge behaves as it always has. Both are
    // checked rather than argued.
    const obs: FpsObstacle[] = [
      { cx: 0, cz: 0, hx: 1.2, hz: 1.2 },
      { cx: -6.5, cz: -7.6, hx: 1.1, hz: 0.4 },
      { cx: 6.5, cz: 7.6, hx: 1.1, hz: 0.4 },
    ];
    expect(obs.some((o) => o.yMin !== undefined || o.yMax !== undefined)).toBe(false);
    const bounds: FpsBounds = { minX: -11.4, maxX: 11.4, minZ: -8.4, maxZ: 8.4, minY: 1.6, maxY: 5.4 };
    const rnd = mulberry32(2718);
    let onStairs = 0;
    let stepped = 0;
    let rescued = 0;
    for (let i = 0; i < 20000; i++) {
      const x = -11.4 + rnd() * 22.8;
      const z = -8.4 + rnd() * 16.8;
      const y = stairHeight(x, z) + 1.75;
      const dx = (rnd() - 0.5) * 2;
      const dz = (rnd() - 0.5) * 2;
      const raw = oldFrame(x, y, z, dx, dz, 0, 1.75, bounds, obs, stairHeight);
      const want = clampedOld(raw, bounds);
      if (raw.x !== want.x || raw.z !== want.z) rescued++;
      const got = stepMove({
        x,
        y,
        z,
        dx,
        dz,
        dy: 0,
        eyeHeight: 1.75,
        bounds,
        obstacles: obs,
        groundHeight: stairHeight,
      });
      // Where a body ends up is unchanged. Its EYE now comes from the ground it
      // ended on rather than the ground it was refused, which only differs when
      // collision moved it — and the rig re-snaps y from (x,z) at the top of the
      // very next frame anyway, so the old value was a one-frame artefact.
      expect(got.x, `x @ ${x},${z}`).toBe(want.x);
      expect(got.z, `z @ ${x},${z}`).toBe(want.z);
      expect(got.y).toBe(stairHeight(got.x, got.z) + 1.75);
      expect(withinBounds(got, bounds), `out of bounds @ ${x},${z} -> ${got.x},${got.z}`).toBe(true);
      if (stairHeight(x, z) > 0) onStairs++;
      if (Math.abs(got.y - y) > 1) stepped++;
    }
    expect(onStairs, "the sweep never stood on the stairs").toBeGreaterThan(100);
    // AND the stairwell's own 1.7 m side edge is still steppable, because no
    // step limit was asked for. Turning that into a wall is a different change.
    expect(stepped, "the residences' stair edge stopped being walkable off").toBeGreaterThan(10);
    expect(rescued, "the old loop never left the bounds, so the clamp is untested here").toBeGreaterThan(0);
  });

  it("refuses a step bigger than maxGroundStep, and only when asked to", () => {
    // The opt-in half, on a terrain with a deliberate cliff.
    const cliff = (x: number) => (x < 0 ? 0 : 6);
    const common = { y: 1.75, z: 0, dz: 0, dy: 0, eyeHeight: 1.75 } as const;
    const free = stepMove({ ...common, x: -0.2, dx: 0.45, groundHeight: cliff });
    expect(free.x, "without a limit the old teleport is still the old teleport").toBeCloseTo(0.25, 9);
    expect(free.y).toBe(7.75);
    const held = stepMove({ ...common, x: -0.2, dx: 0.45, groundHeight: cliff, maxGroundStep: 1.5 });
    expect(held.x, "the limit did not hold the body back").toBe(-0.2);
    expect(held.y).toBe(1.75);
    expect(held.blocked).toBe(true);
    // And a step INSIDE the limit is still allowed, or the rig cannot walk.
    const gentle = (x: number) => x * 0.25;
    const ok = stepMove({ ...common, x: 0, dx: 0.45, groundHeight: gentle, maxGroundStep: 1.5 });
    expect(ok.x).toBeCloseTo(0.45, 9);
    expect(ok.blocked).toBe(false);
  });

  it("ends inside the walls even when the box that pushed you straddles one", () => {
    // The defect in miniature, and the negative half with it. A slab whose
    // OUTWARD blocking face lies past `minX` — which is the Undercroft's outer
    // cutting wall exactly: face at -13.100 against a `minX` of -12.900.
    const bounds: FpsBounds = { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };
    const straddling: FpsObstacle[] = [{ cx: -9.5, cz: 0, hx: 0.3, hz: 6 }];
    const face = -9.5 - (0.3 + OBSTACLE_PAD);
    expect(face, "the fixture's slab does not straddle the bound, so this proves nothing").toBeLessThan(bounds.minX);

    const from = { y: 1.75, z: 0, dz: 0, dy: 0, eyeHeight: 1.75 } as const;
    // Walking west into it from inside the slab's span: the resolver's answer
    // is `face`, which is out of the world.
    const raw = oldFrame(-9.4, 1.75, 0, -0.5, 0, 0, 1.75, bounds, straddling, undefined);
    expect(raw.x, "the old loop kept the body inside — re-derive this test").toBe(face);
    expect(raw.x < bounds.minX, "the old loop's answer was in bounds after all").toBe(true);

    const got = stepMove({ ...from, x: -9.4, dx: -0.5, bounds, obstacles: straddling });
    expect(got.x, "the frame ended outside the world").toBe(bounds.minX);
    expect(withinBounds(got, bounds)).toBe(true);

    // And a body already standing on that wall is not frozen there: the second
    // resolution pass is clamped too, so the move is accepted rather than
    // refused, and the body can walk back out along the wall.
    const along = stepMove({ ...from, x: bounds.minX, dx: 0, dz: 0.45, bounds, obstacles: straddling });
    expect(withinBounds(along, bounds)).toBe(true);
    expect(along.z, "a body on the wall could not move along it").toBeCloseTo(0.45, 9);
  });

  it("keys the band on the storey the body is in, not the one it proposed", () => {
    // The two-way escalator, in miniature. A deck at 0 over a room at -6, with
    // a wall that is solid only in the room. Deciding what blocks from the
    // PROPOSED position lets a body in the room walk through the room's wall
    // the moment the proposal lands on the deck above it.
    const wall: FpsObstacle[] = [{ cx: 2, cz: 0, hx: 1, hz: 4, yMax: -2.4 }];
    const deckFrom = (x: number) => (x > 1 ? 0 : -6);
    const storey = (x: number, _z: number, fromGround?: number) => {
      const d = deckFrom(x);
      if (d <= -6) return -6;
      return fromGround !== undefined && fromGround < d - 1.5 ? -6 : d;
    };
    const inRoom = { x: 0.8, y: -6 + 1.75, z: 0, dz: 0, dy: 0, eyeHeight: 1.75 } as const;
    // Old behaviour, reproduced with the band-aware resolver the branch
    // shipped: ground at the PROPOSED x is the deck, so the eye is 1.75, so
    // the wall's `yMax: -2.4` switches it off and lets you straight in.
    const proposedX = inRoom.x + 0.45;
    const naiveY = deckFrom(proposedX) + 1.75;
    const naive = resolveObstacles(proposedX, 0, naiveY, wall);
    expect(naiveY, "the proposed position is not on the deck, so this proves nothing").toBe(1.75);
    expect(naive.x, "the old band key should have walked through the wall here").toBeCloseTo(1.25, 9);
    // New behaviour: the band key is the room, so the room's wall is solid.
    const held = stepMove({ ...inRoom, dx: 0.45, obstacles: wall, groundHeight: storey, maxGroundStep: 1.5 });
    expect(held.x, "a body in the room walked through the room's wall").toBeLessThanOrEqual(1.0000001);
    expect(held.y).toBe(-6 + 1.75);
  });
});

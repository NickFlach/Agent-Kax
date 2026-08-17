/**
 * Where a body may stand — the collision half of the FPS rig, as pure numbers.
 *
 * TWO THINGS ARE WRONG WITH WHERE THIS LIVED.
 *
 * 1. IT WAS UNTESTABLE. The resolution loop sat inside `useFrame` in
 *    `first-person-rig.tsx`, which imports three.js and R3F. The kax vitest
 *    suite is a Node environment with no DOM on purpose (see vitest.config.ts),
 *    so nothing in CI has ever executed a single line of the city's collision
 *    behaviour. `room-geometry.ts` already made this argument for the store
 *    interior — it extracted the OBSTACLE LIST as pure numbers so the layout
 *    could be tested without a Canvas. This extracts the RESOLVER for the same
 *    reason, and the same rule applies: no three.js import in this file, ever.
 *
 * 2. AN OBSTACLE HAD NO TOP AND NO BOTTOM. `FpsObstacle` was a footprint on the
 *    ground plane with no vertical term at all, and the loop's only vertical
 *    fact was `ny < 7` — a CEILING that lets you fly over the rooftops, not a
 *    floor. So every box blocked a column of space from minus infinity up to
 *    y = 7. That is fine while a scene has one storey. It stops being fine the
 *    moment a scene has two: the Undercroft's shop units, six metres below the
 *    surface, would have blocked a visitor standing on the apron above them,
 *    and the apron's railings would have blocked a visitor on the concourse
 *    below. An invisible wall in mid-air, and another one underground.
 *
 * THE SHAPE OF THE FIX, and why it cannot regress the street: `yMin` and `yMax`
 * are OPTIONAL, and their absence means "all elevations", which is exactly what
 * every existing obstacle already did. Every literal in `marketplace-3d.tsx`,
 * `room-geometry.ts` and `store-interior.tsx` is untouched and byte-identical
 * in behaviour. `fps-collision.test.ts` proves that rather than asserting it:
 * it keeps a verbatim copy of the OLD loop and differentially tests the new
 * resolver against it over a randomised sweep.
 */

/**
 * An axis-aligned box footprint, optionally limited to a band of elevations.
 *
 * `yMin`/`yMax` are the eye elevations between which this box blocks. Both
 * optional, both meaning "no limit on that side" when absent — so an obstacle
 * written without them behaves exactly as every obstacle behaved before they
 * existed. There is still no rotation term; `room-geometry.ts` and
 * `store-interior.test.ts` both treat axis-alignment as a hard constraint on
 * what may be built, and this change does not relax it.
 */
export interface FpsObstacle {
  cx: number;
  cz: number;
  hx: number;
  hz: number;
  /** Lowest eye elevation this box blocks. Absent = no lower limit. */
  yMin?: number;
  /** Highest eye elevation this box blocks. Absent = no upper limit. */
  yMax?: number;
}

/** Air between the player and a wall, so nobody grazes the stone. */
export const OBSTACLE_PAD = 0.5;

/**
 * Above this the rig stops colliding entirely, so R/F flying clears the roofs.
 *
 * Moved here verbatim from the rig rather than reinterpreted. It is a CEILING
 * on the whole obstacle set, which is a different thing from a per-obstacle
 * `yMax`, and conflating the two would quietly change what happens 7 metres up
 * on the street.
 */
export const FLY_OVER_Y = 7;

/** Does this box block a body whose eye is at `y`? */
export function obstacleBlocksAt(o: FpsObstacle, y: number): boolean {
  if (o.yMin !== undefined && y < o.yMin) return false;
  if (o.yMax !== undefined && y > o.yMax) return false;
  return true;
}

export interface GroundPos {
  x: number;
  z: number;
}

/**
 * The walls a rig is held inside. Lived in `first-person-rig.tsx`; moved here
 * so the whole move — clamp, terrain, collision — can be one pure function the
 * Node test runner executes, rather than half of it being reachable and half of
 * it living inside `useFrame`.
 */
export interface FpsBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  minY?: number;
  maxY?: number;
}

/**
 * `Math.min(dt, 0.05)` — the rig's own dt clamp, so a slow frame cannot fling
 * the body across a wall.
 *
 * EXPORTED BECAUSE THE GEOMETRY HAS TO KNOW IT. A railing that blocks over a
 * shorter distance than the body travels in one frame does not block; and
 * "one frame" is not 1/60 s, it is this clamp. Anything that sizes itself
 * against the rig's per-frame travel must compute it from here and from the
 * scene's own `speed`, never from an assumed frame rate.
 */
export const RIG_DT_CLAMP = 0.05;

/** How far a rig moving at `speed` travels in one frame, at the dt clamp. */
export function rigStepFor(speed: number): number {
  return speed * RIG_DT_CLAMP;
}

/**
 * THE FURTHEST A SINGLE FRAME MAY MOVE THE BODY, whatever the input was.
 *
 * `speed` was never actually a speed limit. Walking obeyed it, but the wheel
 * did not: `scrollMove` accumulated a whole `scrollStep` per wheel event and
 * the rig spent the entire accumulated sum in one frame, on top of the walk and
 * unclamped. One notch was 2.2 m; a trackpad flick was as long as the flick.
 *
 * That is not a cosmetic bug, because `resolveObstacles` is a POINT test with
 * no swept check, and it resolves to whichever side of a box's CENTRE the
 * proposal landed on. A frame longer than a box's half-span therefore carries
 * the body across the centre and the resolver pushes it out the FAR side —
 * through the wall, deliberately, as fast as you like. Every guard in the
 * Undercroft has a half-span of `half + OBSTACLE_PAD`, thinnest at the railings
 * (0.15 + 0.5 = 0.65 m), so one notch went through any of them.
 *
 * So a frame's total ground-plane travel is capped HERE, at the distance
 * walking already covers — the number every piece of geometry in the city was
 * sized against (`DECK_CLEARANCE`, the guard windows, the ramp blend). The
 * scroll is not discarded: the rig spends what fits in the frame's remaining
 * budget and CARRIES the rest, so a notch still delivers its full 2.2 m, over
 * about seven frames at 60 Hz instead of in one. What it can no longer do is
 * make a frame longer than the rig's own speed allows.
 *
 * ANYTHING THAT SIZES ITSELF AGAINST A FRAME MUST READ THIS, not `rigStepFor`.
 * They are the same number today and they are not the same claim: one is how
 * far walking moves you, the other is how far ANY input can, and it is the
 * second one that decides how thin a wall may be.
 */
export function rigMaxTravelFor(speed: number): number {
  return rigStepFor(speed);
}

/**
 * Is this box thick enough that a frame cannot step across its centre?
 *
 * The city-wide statement of the rule above, so a scene can be checked against
 * it rather than trusted: an obstacle whose thinner half-span does not exceed
 * one frame's travel is a wall the rig can walk through on purpose.
 */
export function isTunnelProof(o: FpsObstacle, maxTravel: number, pad: number = OBSTACLE_PAD): boolean {
  return Math.min(o.hx, o.hz) + pad > maxTravel;
}

function clampTo(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Hold a ground-plane position inside the walls.
 *
 * THE BOUNDS WERE APPLIED TO THE PROPOSAL AND NOT TO THE RESULT. `stepMove`
 * clamped the proposed (x,z) and then handed it to `resolveObstacles`, which
 * pushes a body OUT to `centre ± (half + OBSTACLE_PAD)` — a face that is
 * outside the bounds whenever a box straddles one. The Undercroft's outer
 * cutting wall does exactly that: its outward face sits at -13.100 against a
 * `minX` of -12.900, and 154 reachable cells stood 0.2 m past the drawn ground
 * with nothing under them.
 *
 * So the clamp runs again after every resolution. It is applied LAST on
 * purpose: a position outside the world is always wrong, while a position
 * inside a box's PAD is merely close to a wall — the pad is air, not stone.
 */
function clampPos(p: GroundPos, bounds: FpsBounds | undefined): GroundPos {
  if (!bounds) return p;
  return { x: clampTo(p.x, bounds.minX, bounds.maxX), z: clampTo(p.z, bounds.minZ, bounds.maxZ) };
}

export interface StepRequest {
  /** Where the body is now. `y` is the EYE, not the ground. */
  x: number;
  y: number;
  z: number;
  /** This frame's ground-plane movement, already scaled by speed and dt. */
  dx: number;
  dz: number;
  /** Vertical input (R/F flying). Ignored entirely when terrain is present. */
  dy: number;
  eyeHeight: number;
  bounds?: FpsBounds;
  obstacles?: readonly FpsObstacle[];
  /**
   * Terrain, optionally STOREY-AWARE.
   *
   * `fromGround` is the elevation of the ground the body is standing on RIGHT
   * NOW. A scene with one storey ignores it and stays a pure function of
   * (x,z) — which is every scene in the city except the Undercroft. A scene
   * with a deck over a floor needs it: the same (x,z) is two different pieces
   * of ground depending on which one you are on, and without that argument a
   * terrain function has to pick one and be wrong for somebody.
   */
  groundHeight?: (x: number, z: number, fromGround?: number) => number;
  /**
   * The largest ground change this rig will accept in a single move.
   *
   * Opt-in, and absent for every scene that had no such limit before. Where it
   * is set, a step whose destination ground is further than this from the
   * ground under the body is REFUSED outright — the body stays where it was.
   * That is what turns an edge into a wall instead of into a teleport: the rig
   * has no gravity, so `y = ground + eye` is an assignment, and a
   * discontinuity in the terrain is a jump cut rather than a fall.
   */
  maxGroundStep?: number;
}

export interface StepResult {
  x: number;
  y: number;
  z: number;
  /** True when the move was refused or deflected by something solid. */
  blocked: boolean;
}

/**
 * One frame of movement, as pure numbers — clamp, terrain, collision, in the
 * order the rig runs them.
 *
 * THE TWO THINGS THIS FIXES, both of which were invisible from `useFrame`:
 *
 * 1. THE BAND KEY CAME FROM A POSITION THE BODY WAS REFUSED. The rig computed
 *    `ny = groundHeight(proposed) + eye` and then asked the obstacle list what
 *    blocks at `ny`. On a surface that crosses a whole storey in one step, the
 *    storey deciding what is solid was the one at the far end of a move that
 *    had not happened yet — so a shop six metres below stopped being solid the
 *    instant you leaned towards the hole above it, and you walked through the
 *    shop and out onto the roof. The band key is now the ground the body is
 *    ACTUALLY standing on, and the resolved destination is then re-checked at
 *    ITS own elevation: a step is accepted only if it is legal in the storey it
 *    leaves and in the storey it arrives in.
 * 2. `y` CAME FROM THE PROPOSED POSITION TOO, so a body pushed along a wall
 *    stood at the height of the ground it had been refused. Now it comes from
 *    where the body ended up.
 * 3. THE BOUNDS WERE CHECKED BEFORE THE PUSH AND NEVER AFTER IT. See
 *    `clampPos`. A box that straddles a bound pushed the body straight through
 *    the wall of the world, and nothing looked again.
 *
 * When `groundHeight` is absent — the street, the arcade, the bank, the
 * joinery, 0xSCADA, the cafe, every store interior — this is the old loop
 * statement for statement APART FROM that trailing clamp, and
 * `fps-collision.test.ts` checks that differentially rather than asserting it:
 * over a randomised sweep the only inputs on which old and new disagree are
 * the ones the old loop answered with a position outside the bounds.
 */
export function stepMove(req: StepRequest): StepResult {
  const { x, y, z, dx, dz, dy, eyeHeight, bounds, obstacles, groundHeight, maxGroundStep } = req;

  let nx = x + dx;
  let nz = z + dz;
  let ny = y + dy;

  if (bounds) {
    nx = clampTo(nx, bounds.minX, bounds.maxX);
    nz = clampTo(nz, bounds.minZ, bounds.maxZ);
    ny = clampTo(ny, bounds.minY ?? eyeHeight, bounds.maxY ?? Infinity);
  } else {
    ny = Math.max(ny, eyeHeight);
  }

  if (!groundHeight) {
    const hit = clampPos(resolveObstacles(nx, nz, ny, obstacles), bounds);
    return { x: hit.x, y: ny, z: hit.z, blocked: hit.x !== nx || hit.z !== nz };
  }

  // The storey the body is in right now. This is the band key, and it is a
  // fact rather than a proposal.
  const g0 = groundHeight(x, z, y - eyeHeight);
  const y0 = g0 + eyeHeight;

  const first = clampPos(resolveObstacles(nx, nz, y0, obstacles), bounds);
  const g1 = groundHeight(first.x, first.z, g0);

  if (maxGroundStep !== undefined && Math.abs(g1 - g0) > maxGroundStep) {
    return { x, y: y0, z, blocked: true };
  }

  // Legal where it arrives, too. Without terrain this is the same call twice
  // and cannot refuse anything, which is why it is safe for every other scene.
  //
  // Clamped for the same reason `first` is, and for one more: an unclamped
  // second pass would REFUSE every move out of a cell the first clamp had put
  // the body in, which is a body frozen against the world wall rather than one
  // held inside it.
  const y1 = g1 + eyeHeight;
  const second = clampPos(resolveObstacles(first.x, first.z, y1, obstacles), bounds);
  if (second.x !== first.x || second.z !== first.z) {
    return { x, y: y0, z, blocked: true };
  }

  return { x: first.x, y: y1, z: first.z, blocked: first.x !== nx || first.z !== nz };
}

/**
 * Push a proposed position out of anything it has walked into.
 *
 * Same algorithm as the rig has always used: for each overlapping box, resolve
 * along whichever axis needs the SHALLOWER push, so walking into a wall slides
 * along it instead of stopping dead. Order-dependent by nature — a later box
 * resolves against the position the earlier one left — which is why the test
 * compares against the old loop over the real obstacle lists rather than
 * against a reimplementation of what it ought to do.
 */
export function resolveObstacles(
  x: number,
  z: number,
  y: number,
  obstacles: readonly FpsObstacle[] | undefined,
  pad: number = OBSTACLE_PAD,
): GroundPos {
  let nx = x;
  let nz = z;
  if (!obstacles || y >= FLY_OVER_Y) return { x: nx, z: nz };
  for (const o of obstacles) {
    if (!obstacleBlocksAt(o, y)) continue;
    const dx = nx - o.cx;
    const dz = nz - o.cz;
    const px = o.hx + pad - Math.abs(dx);
    const pz = o.hz + pad - Math.abs(dz);
    if (px > 0 && pz > 0) {
      if (px < pz) nx = o.cx + Math.sign(dx || 1) * (o.hx + pad);
      else nz = o.cz + Math.sign(dz || 1) * (o.hz + pad);
    }
  }
  return { x: nx, z: nz };
}

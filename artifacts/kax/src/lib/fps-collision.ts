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

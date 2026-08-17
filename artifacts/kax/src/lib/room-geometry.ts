/**
 * The parts of a room's layout that are arithmetic rather than rendering.
 *
 * Everything here is a plain number or a pure function over numbers, and that
 * is the point: `pages/store-interior.tsx` and `components/talkable-npc.tsx`
 * both import three.js, @react-three/fiber and drei, so nothing in them can be
 * called from the test runner — which is a Node environment by design (see
 * `vitest.config.ts`). The rules below are exactly the ones that were wrong in
 * a way no screenshot and no typecheck could show:
 *
 * - A proximity check made in LOCAL coordinates against a WORLD camera, which
 *   measured the distance to the middle of the room instead of to the person.
 * - A collision list that omitted the tallest objects in the room, so a visitor
 *   walked through a chest-high arcade cabinet and was stopped by a bench.
 *
 * Both are arithmetic, and both are invisible in a render. Keeping them here
 * means a test can put a camera at the counter and assert the answer, rather
 * than searching the source for the shape of a fix.
 *
 * `FpsObstacle` and `FpsSpawn` are imported as TYPES only. A value import from
 * `first-person-rig.tsx` would drag three.js in and undo the whole arrangement.
 */

import type { FpsObstacle, FpsSpawn } from "@/components/first-person-rig";

// ---------------------------------------------------------------------------
// Talking distance
// ---------------------------------------------------------------------------

/** How close the visitor has to be before an NPC offers to be spoken to. */
export const TALK_RANGE = 4.2;

/**
 * Close enough to be served — in WORLD coordinates on BOTH sides.
 *
 * The bug this exists to pin: `TalkableNpc` compared `camera.position`, which
 * is world, against its own `position` prop, which is local to whatever group
 * renders it. Every caller in the city nests it inside a positioned group — the
 * store's checkout desk at (5.5, 4.5), the Joinery's at (8.2, 6.5), the
 * residences lobby at (0, −6), the cafe counter at (−3.4, −3.6) — so the check
 * evaluated the distance to a point up to 10.4m from the actual figure, against
 * a range of 4.2. No prompt ever appeared at the desk, and one appeared in the
 * middle of the gallery.
 *
 * Distance is measured on the FLOOR plane. Eye height is 2.2m and a figure's
 * origin is at its feet, so folding y in would make everyone ~2m further away
 * than they look and leave no usable range at a counter at all.
 */
export function withinTalkRange(
  camera: { x: number; z: number },
  npc: { x: number; z: number },
): boolean {
  return Math.hypot(camera.x - npc.x, camera.z - npc.z) < TALK_RANGE;
}

// ---------------------------------------------------------------------------
// The store floor
// ---------------------------------------------------------------------------

/**
 * Where the checkout desk stands, and the box the visitor cannot walk through.
 *
 * In line of sight from the glass doors at z = 9.5, so a visitor who walks in
 * sees the counter without being told it is there — the store interior has no
 * minimap and is not getting one.
 *
 * AXIS-ALIGNED, and that is a constraint rather than a look. `FpsObstacle` is
 * `{cx, cz, hx, hz}` with no rotation term, so a rotated desk would be modelled
 * by a box the rig kept upright: either loose enough to let a shoulder through
 * a corner, or wide enough to stop the visitor short of a desk they can see
 * they are not touching. The Joinery's desk is rotated because nothing there
 * collides with anything.
 */
export const DESK_POSITION: [number, number, number] = [5.5, 0, 4.5];
export const DESK_OBSTACLE: FpsObstacle = { cx: 5.5, cz: 4.5, hx: 1.7, hz: 0.6 };

/**
 * Where `?at=desk` puts you: at the counter, facing it.
 *
 * `/s/:slug/room` is a public route, so the majority of first-time buyers meet
 * the desk signed out, follow `/login?returnTo=…%3Fat%3Ddesk`, and come back.
 * Landing them at the glass door to walk the length of the shop again is how a
 * sign-in reads as having lost their place.
 *
 * `yaw: 0` faces −z, which is the desk from here. The z clears the desk's
 * obstacle box plus the rig's half-metre pad, so the arrival is a standing
 * position rather than one the collision pass shoves out of on the first frame
 * — asserted against `DESK_OBSTACLE` rather than against retyped numbers.
 */
export const DESK_SPAWN: FpsSpawn = { position: [5.5, 2.2, 6.7], yaw: 0 };

/**
 * The benches, and the half-extents that come from `GalleryBench`'s geometry —
 * the leather pad is the widest part at 2.04 × 0.66 — rather than from numbers
 * typed twice.
 */
export const BENCH_POSITIONS: Array<[number, number, number]> = [
  [0, 0, -6],
  [0, 0, -1],
];
const BENCH_HALF_X = 2.04 / 2;
const BENCH_HALF_Z = 0.66 / 2;

/**
 * The arcade row along the front wall: where a cabinet stands, and how much
 * room it takes up.
 *
 * ONE list, read by the renderer and by the collision pass. The cabinets used
 * to be positioned from a literal inside the `.map()` and were missing from the
 * obstacle list entirely — a 2.3m machine, chest-high and clickable, that the
 * visitor walked straight through at z 8.6 while a knee-high bench stopped
 * them. That is precisely the inconsistency the obstacle list exists to avoid.
 *
 * The half-extents come from `ArcadeCabinet`'s widest geometry: the side art
 * panels sit at x = ±0.395 and are 0.82 deep about z = −0.02. The cabinets are
 * turned by `Math.PI`, which maps an axis-aligned box onto itself, so the AABB
 * is still honest.
 */
export const ARCADE_SLOT_X = [-7.2, -5.4, 7.2, 5.4];
export const ARCADE_Z = 8.1;
const ARCADE_HALF_X = 0.4;
const ARCADE_HALF_Z = 0.43;

/**
 * The corner greenery, solid for the same reason the benches are.
 *
 * The pot is the widest part at r = 0.28. The fronds above it are deliberately
 * not modelled: brushing a leaf should not stop a visitor.
 */
export const PLANT_POSITIONS: Array<[number, number, number]> = [
  [-8.6, 0, -13.5],
  [8.6, 0, -13.5],
  [-8.6, 0, 8.2],
];
const PLANT_HALF = 0.28;

/** Everything solid that is always there, whatever this shop happens to hold. */
const FIXED_OBSTACLES: FpsObstacle[] = [
  DESK_OBSTACLE,
  ...BENCH_POSITIONS.map(([x, , z]) => ({ cx: x, cz: z, hx: BENCH_HALF_X, hz: BENCH_HALF_Z })),
  ...PLANT_POSITIONS.map(([x, , z]) => ({ cx: x, cz: z, hx: PLANT_HALF, hz: PLANT_HALF })),
];

/**
 * Everything solid on this floor, for a shop showing `appCount` playable apps.
 *
 * A function rather than a constant because the arcade row varies with the
 * data: a shop with no apps draws no cabinets and must not collide with four
 * invisible ones. Capped at the slot list, which is also what the renderer
 * slices its cabinets to — so the drawn set and the solid set cannot diverge.
 */
export function storeObstacles(appCount: number): FpsObstacle[] {
  return [
    ...FIXED_OBSTACLES,
    ...ARCADE_SLOT_X.slice(0, appCount).map((cx) => ({
      cx,
      cz: ARCADE_Z,
      hx: ARCADE_HALF_X,
      hz: ARCADE_HALF_Z,
    })),
  ];
}

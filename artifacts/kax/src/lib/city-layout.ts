/**
 * Where the city's fixed structures stand, and how big they are to walk into.
 *
 * Two bugs came from this arithmetic living in more than one place (#301).
 *
 * THE TRANSPOSED FOOTPRINTS. All four venues are mounted rotated a quarter
 * turn — the Arcade and the Joinery at +PI/2, the Bank and the Residences at
 * -PI/2 — but their collision boxes were written from the UNROTATED geometry.
 * A quarter turn swaps a box's x and z extents, so every one of them was
 * blocking along the wrong axis: an invisible wall where the building is
 * narrow, and clip-through where it is wide. The Bank declared hx 5.7 against
 * a rotated half-width of 4.5, so a visitor was stopped 1.2 units short of a
 * wall that was not there, on the side facing the street.
 *
 * THE MONUMENT. `CityProps` places it at `depth - 4` and the obstacle list put
 * its shaft at `streetDepth - 6`, where `depth` and `streetDepth` are the same
 * expression computed from two different variables. The stone and the thing
 * you collide with were two units apart.
 *
 * So the numbers live here once and both consumers read them. The footprints
 * are DERIVED from the geometry and its rotation rather than transcribed,
 * because transcription is what failed: a table of hand-copied half-extents is
 * correct exactly until somebody rotates a building.
 */

/**
 * THE STREET'S SHOP GRID. Moved here from `marketplace-3d.tsx` unchanged.
 *
 * It is the same arithmetic `streetDepthFor` already encodes — one row per two
 * shops, 4.5 apart, starting at -2 — and it had been living in the scene as a
 * private function nothing could test. That mattered the moment a second tier
 * was built beneath the first: the Undercroft is supposed to MIRROR the
 * street's spacing so the two read as one city, and the only way to guarantee
 * that is for both to call the same function rather than for one to copy the
 * other's numbers. A copied grid agrees until somebody edits one of them.
 *
 * It is also the thing the Undercroft must not disturb. `city-layout.test.ts`
 * pins all forty-eight positions against a frozen table, so any edit that
 * moves a shopfront, reorders the sides, or drops the row jitter fails there
 * rather than in a screenshot.
 */

/**
 * How many storefronts stand at street level.
 *
 * Shared so the Undercroft can take the REMAINDER — `slice(48)` — from the
 * same number the street sliced at, rather than from its own copy of 48. Two
 * constants that must agree is a bug with a delay fuse.
 */
export const MAX_STREET_STOREFRONTS = 48;

export const STREET_ROW_PITCH = 4.5;
export const STREET_ROW_Z0 = -2;
export const STREET_FACADE_X = 6.0;
/** Shopfronts sit on the raised pavement, not the roadway. */
export const STREET_SHOP_Y = 0.12;

export interface ShopPlacement<T> {
  agent: T;
  position: [number, number, number];
  rotation: [number, number, number];
}

/**
 * Lay agents out along the street: alternate sides, two per row.
 *
 * Generic over the agent so this file stays free of scene types (and of
 * three.js — the whole point of `lib/` here is that the Node test runner can
 * import it). `y` is a parameter only so the Undercroft can put the same grid
 * on its own floor; the street calls it with the default and gets exactly what
 * it got before.
 */
export function layoutFor<T>(agents: readonly T[], y: number = STREET_SHOP_Y): ShopPlacement<T>[] {
  return agents.map((agent, i) => {
    const isLeft = i % 2 === 0;
    const row = Math.floor(i / 2);
    const z = STREET_ROW_Z0 - row * STREET_ROW_PITCH + (i % 3 === 0 ? 0.5 : 0);
    // Facades land at ±4.5, leaving a real ~1.8-unit sidewalk between the
    // curb (±2.7) and the shopfronts — pedestrians walk it without clipping.
    const x = isLeft ? -STREET_FACADE_X : STREET_FACADE_X;
    const rotation: [number, number, number] = isLeft ? [0, Math.PI / 2, 0] : [0, -Math.PI / 2, 0];
    return { agent, position: [x, y, z] as [number, number, number], rotation };
  });
}

/** The street's far end, from the number of storefronts on it. */
export function streetDepthFor(storeCount: number): number {
  const rows = Math.max(1, Math.ceil(storeCount / 2));
  return -2 - rows * 4.5;
}

/**
 * How far in front of the street's end the monument stands.
 *
 * One constant, read by the geometry AND by the obstacle, so the stone and the
 * collision cannot drift apart again.
 */
export const MONUMENT_Z_OFFSET = -4;

/** Where the monument actually is. */
export function monumentZFor(storeCount: number): number {
  return streetDepthFor(storeCount) + MONUMENT_Z_OFFSET;
}

/** A little air between the player and a wall, so nobody grazes the stone. */
export const FOOTPRINT_MARGIN = 0.2;

export interface Footprint {
  hx: number;
  hz: number;
}

/**
 * The axis-aligned half-extents of a box after a rotation about Y.
 *
 * General rather than a special case for quarter turns: the failure was
 * somebody assuming an orientation, and a formula that only handles PI/2 would
 * be the same assumption wearing a function's clothes.
 */
export function footprintFor(
  size: readonly [number, number, number],
  rotationY: number,
  margin = FOOTPRINT_MARGIN,
): Footprint {
  const [w, , d] = size;
  const c = Math.abs(Math.cos(rotationY));
  const s = Math.abs(Math.sin(rotationY));
  return {
    hx: (w * c + d * s) / 2 + margin,
    hz: (w * s + d * c) / 2 + margin,
  };
}

/** The venue shells, exactly as their <boxGeometry args> declare them. */
export const VENUE_SHELLS = {
  arcade: { size: [10, 7.5, 9], rotationY: Math.PI / 2, label: "the Arcade" },
  bank: { size: [11, 8, 9], rotationY: -Math.PI / 2, label: "Resonance Trust" },
  residences: { size: [9, 6.8, 8], rotationY: -Math.PI / 2, label: "Standing Wave Residences" },
  joinery: { size: [10.5, 8.2, 8], rotationY: Math.PI / 2, label: "The Joinery" },
  scada: { size: [8.6, 6.5, 6.2], rotationY: -Math.PI / 2, label: "0xSCADA Engineering Firm" },
  // The Undercroft's street entrance. ONE shell serving BOTH ramp mouths, and
  // square in plan on purpose: a mirrored pair needs opposite rotations, and
  // the mount guard in city-layout.test.ts reads whichever it finds first. A
  // square footprint is the same box at every angle, so the two mouths can
  // face each other without the derived footprint being wrong for one of them
  // — and that squareness is itself asserted, so it cannot quietly stop being
  // true.
  undercroft: { size: [3, 2.8, 3], rotationY: Math.PI / 2, label: "The Undercroft" },
} as const satisfies Record<string, { size: readonly [number, number, number]; rotationY: number; label: string }>;

export type VenueKey = keyof typeof VENUE_SHELLS;

/** The footprint of one venue, derived from its own geometry and rotation. */
export function venueFootprint(key: VenueKey): Footprint {
  const v = VENUE_SHELLS[key];
  return footprintFor(v.size, v.rotationY);
}

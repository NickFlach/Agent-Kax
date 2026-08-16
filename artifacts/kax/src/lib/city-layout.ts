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
} as const satisfies Record<string, { size: readonly [number, number, number]; rotationY: number; label: string }>;

export type VenueKey = keyof typeof VENUE_SHELLS;

/** The footprint of one venue, derived from its own geometry and rotation. */
export function venueFootprint(key: VenueKey): Footprint {
  const v = VENUE_SHELLS[key];
  return footprintFor(v.size, v.rotationY);
}

/**
 * THE UNDERCROFT — a second tier of forty-eight units beneath the main road.
 *
 * WHY IT EXISTS. The street shows the first 48 storefronts and links to a flat
 * directory for the other 250-odd. Measured against the live data on
 * 2026-08-16 (see `storefront-window.ts`), 278 of 302 storefronts are
 * unclaimed and ALL 278 of them hold work — median 24 artifacts, the largest
 * 1534. The 49th agent is not empty; it is simply 49th. The Undercroft is
 * somewhere for that work to exist rather than be culled to a line of text,
 * and room for the city to grow without disturbing the street above it.
 *
 * WHAT IT MUST NOT DO. The original 48 stay exactly as they are: same set,
 * same order, same coordinates. Nothing in this file is imported by the street
 * scene's layout and nothing here can change `layoutFor`'s output —
 * `city-layout.test.ts` pins all forty-eight street positions against a frozen
 * table so that claim is checked rather than asserted.
 *
 * Pure numbers, no three.js, no React — the same discipline `room-geometry.ts`
 * adopted, and for the same reason: the parts that can be silently wrong (the
 * ordering, the ramp profile, which box blocks at which elevation) are the
 * parts a screenshot cannot check, so they live where the Node test runner can
 * execute them.
 */

import { layoutFor, type ShopPlacement } from "./city-layout";

/* ------------------------------------------------------------------ ranking */

/**
 * What the Undercroft can actually see.
 *
 * Deliberately only the fields the GENERATED api client declares on
 * `UnifiedStorefront`. The server also sends `latestIngestAt` (a better
 * liveness signal than `latestPublishedAt`, and the reason #299 added it), but
 * it is absent from `lib/api-client-react/src/generated/api.schemas.ts`, so
 * reading it here would mean either an untyped cast or regenerating a shared
 * client. Neither belongs in this change. Noted rather than quietly worked
 * around, because the next person will look for it.
 */
export interface UndercroftCandidate {
  slug: string;
  name: string;
  /** publishedDropCount — how many drops this store has actually shipped. */
  drops: number;
  artifacts: number;
  latestPublishedAt: string | null;
  claimed: boolean;
  source: "obc" | "constellation";
}

/** How many units the Undercroft holds. The street's 48, mirrored. */
export const MAX_UNDERCROFT_UNITS = 48;

/**
 * The order, most significant first — and the argument for each step.
 *
 *   1. `drops` descending — THE COMMERCE BAND. Nick asked for "commerce
 *      enabled stores ranked towards the top". There is no commerce signal on
 *      `/marketplace/combined`: real commerce is priced rows in
 *      `store_listings`, which this endpoint does not expose. The nearest
 *      honest proxy is a store that has actually PUBLISHED something.
 *      `claimed` is NOT used for this and must not be — `claimed` means "has a
 *      non-system owner" (storefrontDirectory.ts), and conflating those two
 *      facts is precisely the bug #302 fixed at street level. A store with a
 *      published drop has done the thing commerce is for; a claimed empty shop
 *      has not.
 *   2. `artifacts` descending — THE BODY OF WORK, and the preservation motive
 *      made into a sort key. This is the same measure the street already ranks
 *      by, so the two tiers read as one city rather than as a good street and
 *      a bin. It is also what puts a dormant agent with four hundred pieces
 *      above a fresh empty one, which is the entire point of building this.
 *   3. `latestPublishedAt` descending, nulls last — is it still breathing. An
 *      absent date sorts as the empty string, which loses to every real one.
 *   4. `slug` ascending — THE TIEBREAK, and it is not optional. #303 exists
 *      because the street's 48-cut landed inside a tie, which made "which
 *      buildings exist" a fact about the query plan instead of about the data.
 *      A second 48-cut without a total order would be the same bug a storey
 *      down. With it, `rankUndercroft` returns the same 48 in the same order
 *      for the same input, whatever order the input arrived in.
 */
export function compareUndercroft(a: UndercroftCandidate, b: UndercroftCandidate): number {
  if (a.drops !== b.drops) return b.drops - a.drops;
  if (a.artifacts !== b.artifacts) return b.artifacts - a.artifacts;
  const ap = a.latestPublishedAt ?? "";
  const bp = b.latestPublishedAt ?? "";
  if (ap !== bp) return bp.localeCompare(ap);
  return a.slug.localeCompare(b.slug);
}

/**
 * The units, in order.
 *
 * Sorts a COPY: the caller's array is derived from the same response the
 * street's 48 are sliced from, and `Array.prototype.sort` mutates in place. An
 * in-place sort here would reorder the street, which is the one thing this
 * feature is not allowed to do.
 */
export function rankUndercroft(
  candidates: readonly UndercroftCandidate[],
  limit: number = MAX_UNDERCROFT_UNITS,
): UndercroftCandidate[] {
  return [...candidates].sort(compareUndercroft).slice(0, limit);
}

/* ----------------------------------------------------------------- geometry */

/** The concourse floor. Six metres of rock between the two tiers. */
export const UNDERCROFT_FLOOR_Y = -6;
/** Head height in the hall — and the top of a unit's collision band. */
export const UNDERCROFT_CEILING_Y = -2.4;
/** The apron the ramps start from, level with the street it is reached from. */
export const UNDERCROFT_SURFACE_Y = 0;
/** Units sit on the concourse floor the way street shops sit on the pavement. */
export const UNDERCROFT_SHOP_Y = UNDERCROFT_FLOOR_Y + 0.12;
/** Eye height, shared with the street rig so a descent measures the same. */
export const UNDERCROFT_EYE = 1.75;

/** Where the hall's side walls stand — the units are let into them. */
export const HALL_HALF_X = 8.6;
/** The hall's walled length. Beyond each end it opens into a full-width lobby. */
export const HALL_NORTH_Z = 22;
export const HALL_SOUTH_Z = -132;
/** The lobbies: full width, no side walls, where the ramps arrive. */
export const NORTH_LOBBY = { z0: HALL_NORTH_Z, z1: 30 };
export const SOUTH_LOBBY = { z0: -140, z1: HALL_SOUTH_Z };
/** The outer edge of the excavation. */
export const UNDERCROFT_HALF_X = 12.9;

/** How far a ramp falls, and over how much run. 6 in 24 is 14 degrees. */
export const RAMP_DROP = UNDERCROFT_SURFACE_Y - UNDERCROFT_FLOOR_Y;
export const RAMP_RUN = 24;

/**
 * How far the ground blends from the surface deck down to the concourse at the
 * edge of an apron.
 *
 * The rig has NO step clamping and NO gravity: `ny = groundHeight(nx,nz) +
 * eyeHeight` is an outright assignment every frame, so a discontinuity in this
 * function is an instantaneous teleport rather than a fall. Every edge
 * therefore blends instead of stepping. Railings stop anybody reaching the
 * blend in normal play; the blend is what makes the worst case "an awkward
 * slope" instead of "the camera jumped six metres".
 */
export const EDGE_BLEND = 0.8;

export interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export interface UndercroftEntrance {
  id: "north" | "south";
  /** Which side of the hall the cutting runs down. */
  side: -1 | 1;
  /** Where the visitor lands when they come down off the street. */
  spawn: [number, number, number];
  /** Facing, in the rig's convention: 0 looks -z, PI looks +z. */
  yaw: number;
  /** The arrival apron at surface level. */
  court: Rect;
  /** The cutting the ramp runs down, overlapping the court so there is no seam. */
  shaft: Rect;
  /** North of this (or south, per `fallDir`) the deck is level; past it, it falls. */
  deckTopZ: number;
  /** +1 = the deck falls as z increases; -1 = as z decreases. */
  fallDir: 1 | -1;
  /** Where the ramp meets the concourse floor. */
  deckBottomZ: number;
  /** The z at which the cutting's inner wall gives out into the lobby. */
  innerWallEndZ: number;
}

/**
 * Two entrances, on opposite sides, delivering into the two lobbies.
 *
 * THE CONSTRAINT THAT DECIDED THIS LAYOUT. A ramp descending down the middle
 * of the concourse passes through the walking height of anybody underneath it:
 * at half depth the deck is 3 metres down and an eye on the floor is at 4.25,
 * so the visitor would walk face-first into the underside of their own ramp.
 * And a ramp descending BESIDE the hall has to get in through the side, where
 * the unit line is continuous — consecutive units on one side are 4.5 apart
 * with padded half-extents of 2.2, so there is a tenth of a metre of gap and
 * no doorway to be had.
 *
 * So each cutting runs down OUTSIDE the hall (|x| > 8.6) and opens into the
 * lobby past the end of the wall, which is the one place the concourse is
 * genuinely full width. Nothing is squeezed and nothing overlaps.
 *
 * The courts, on the other hand, sit deliberately OVER the unit line — that is
 * where the vertical collision term earns its keep, and it is the geometry
 * `fps-collision.test.ts` checks.
 */
export const UNDERCROFT_ENTRANCES: readonly UndercroftEntrance[] = [
  {
    id: "north",
    side: -1,
    spawn: [-10.7, UNDERCROFT_SURFACE_Y + UNDERCROFT_EYE, -4],
    yaw: Math.PI,
    court: { x0: -12.4, x1: -4.0, z0: -8, z1: 0 },
    shaft: { x0: -12.4, x1: -9.0, z0: -8, z1: 26 },
    deckTopZ: 0,
    fallDir: 1,
    deckBottomZ: 24,
    innerWallEndZ: HALL_NORTH_Z,
  },
  {
    id: "south",
    side: 1,
    spawn: [10.7, UNDERCROFT_SURFACE_Y + UNDERCROFT_EYE, -106],
    yaw: 0,
    court: { x0: 4.0, x1: 12.4, z0: -110, z1: -102 },
    shaft: { x0: 9.0, x1: 12.4, z0: -136, z1: -102 },
    deckTopZ: -110,
    fallDir: -1,
    deckBottomZ: -134,
    innerWallEndZ: HALL_SOUTH_Z,
  },
] as const;

/**
 * Where each entrance's mouth stands on the street above.
 *
 * Both in the service alleys (`ALLEY_X` = 11), at the near and far ends of the
 * strip. Chosen because the alleys are the only long stretch of the street
 * with no obstacle in it at all: every other candidate — the roadway, the
 * pavement between the curb and the shopfronts, the cross streets — either
 * carries pedestrian traffic or is already inside a shopfront's collision box.
 * Neither position displaces a storefront, a venue door or a directory board.
 */
export const STREET_MOUTHS: ReadonlyArray<{ id: "north" | "south"; x: number; z: number }> = [
  { id: "north", x: -11, z: -7 },
  { id: "south", x: 11, z: -100 },
];

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** How completely (x,z) stands on this rectangle's deck: 1 inside, 0 off it. */
function rectT(x: number, z: number, r: Rect, blend = EDGE_BLEND): number {
  return Math.min(
    clamp01((x - r.x0) / blend),
    clamp01((r.x1 - x) / blend),
    clamp01((z - r.z0) / blend),
    clamp01((r.z1 - z) / blend),
  );
}

/** The elevation of one entrance's deck at this z — level, then falling. */
export function deckYAt(e: UndercroftEntrance, z: number): number {
  const progress = e.fallDir > 0 ? z - e.deckTopZ : e.deckTopZ - z;
  if (progress <= 0) return UNDERCROFT_SURFACE_Y;
  return Math.max(UNDERCROFT_FLOOR_Y, UNDERCROFT_SURFACE_Y - (progress / RAMP_RUN) * RAMP_DROP);
}

/**
 * The ground under (x,z) — the terrain callback the rig walks on.
 *
 * `first-person-rig.tsx` already supports this and the residences already use
 * it for a 29.5-degree switchback stair, so no new movement capability is
 * being invented: the rig snaps the camera to `groundHeight + eyeHeight` every
 * frame, and the terrain OVERRIDES `bounds.minY`, which is what lets a visitor
 * stand below zero at all.
 *
 * Continuous by construction. The floor is the baseline; each entrance lifts
 * it towards its own deck by a factor that falls smoothly to zero at the
 * apron's edge, and the two entrances combine with `max`, which preserves
 * continuity because both terms are continuous and both are >= the floor.
 */
export function undercroftGroundHeight(x: number, z: number): number {
  let h = UNDERCROFT_FLOOR_Y;
  for (const e of UNDERCROFT_ENTRANCES) {
    const t = Math.max(rectT(x, z, e.court), rectT(x, z, e.shaft));
    if (t <= 0) continue;
    const lifted = UNDERCROFT_FLOOR_Y + (deckYAt(e, z) - UNDERCROFT_FLOOR_Y) * t;
    if (lifted > h) h = lifted;
  }
  return h;
}

/** The walls the rig is held inside. */
export const UNDERCROFT_BOUNDS = {
  minX: -UNDERCROFT_HALF_X,
  maxX: UNDERCROFT_HALF_X,
  minZ: SOUTH_LOBBY.z0 + 1,
  maxZ: NORTH_LOBBY.z1 - 1,
  minY: UNDERCROFT_FLOOR_Y - 2,
  maxY: UNDERCROFT_SURFACE_Y + 4,
};

/* --------------------------------------------------------------- unit slots */

/**
 * The forty-eight slots, on the street's own grid one storey down.
 *
 * `layoutFor` is the street's function, called with a different Y. That is the
 * whole of "mirroring the street's spacing so the two tiers read as related" —
 * same pitch, same alternation, same row jitter, because it is the same code
 * rather than a copy of its numbers.
 */
export function undercroftSlots(): ShopPlacement<number>[] {
  return layoutFor(
    Array.from({ length: MAX_UNDERCROFT_UNITS }, (_, i) => i),
    UNDERCROFT_SHOP_Y,
  );
}

/* ---------------------------------------------------------------- collision */

export interface UndercroftObstacle {
  cx: number;
  cz: number;
  hx: number;
  hz: number;
  yMin?: number;
  yMax?: number;
}

/** A unit's collision box, matching the street's shopfront box exactly. */
export const UNIT_FOOTPRINT = { hx: 1.6, hz: 1.7 };
/** Units and hall walls are solid only within the hall's own storey. */
export const CONCOURSE_BAND = { yMin: UNDERCROFT_FLOOR_Y - 0.6, yMax: UNDERCROFT_CEILING_Y };
/** Railings are solid only at and near the surface. */
export const SURFACE_BAND = { yMin: UNDERCROFT_SURFACE_Y - 1.2 };

function box(
  cx: number,
  cz: number,
  hx: number,
  hz: number,
  band?: { yMin?: number; yMax?: number },
): UndercroftObstacle {
  return { cx, cz, hx, hz, ...(band ?? {}) };
}

function span(a: number, b: number): { c: number; h: number } {
  return { c: (a + b) / 2, h: Math.abs(b - a) / 2 };
}

/**
 * Everything solid down here, and the elevations at which it is solid.
 *
 * THREE BANDS, and the bands are the feature:
 *
 *   · UNITS and HALL WALLS carry `yMax: UNDERCROFT_CEILING_Y`. They are real
 *     to somebody on the concourse and invisible to somebody on the apron six
 *     metres above them — which is the whole reason `FpsObstacle` grew a
 *     vertical term. Without it, standing on a court at x = ±6 would put you
 *     inside a shop you cannot see, and the shop would win.
 *   · RAILINGS carry `yMin` just below the surface. They stop a visitor
 *     walking off the apron; they must not stop the visitor walking under it.
 *   · CUTTING WALLS carry no band at all. A wall of rock is solid at every
 *     elevation, which is exactly what an obstacle already meant, so they say
 *     nothing and behave as every obstacle in the city behaved before today.
 */
export function undercroftObstacles(): UndercroftObstacle[] {
  const out: UndercroftObstacle[] = [];

  for (const slot of undercroftSlots()) {
    out.push({ cx: slot.position[0], cz: slot.position[2], ...UNIT_FOOTPRINT, ...CONCOURSE_BAND });
  }

  // The hall's two side walls. They stop at the lobbies, which is how the
  // ramps get in without a doorway through the unit line.
  const hall = span(HALL_SOUTH_Z, HALL_NORTH_Z);
  for (const side of [-1, 1] as const) {
    out.push(box(HALL_HALF_X * side, hall.c, 0.3, hall.h, CONCOURSE_BAND));
  }

  for (const e of UNDERCROFT_ENTRANCES) {
    const { court, shaft } = e;
    const outerX = e.side < 0 ? shaft.x0 - 0.3 : shaft.x1 + 0.3;
    const innerX = e.side < 0 ? shaft.x1 + 0.3 : shaft.x0 - 0.3;

    // The cutting: outer wall down its whole length, inner wall from the ramp
    // mouth to the lobby, and a cap across the top end.
    const shaftZ = span(shaft.z0, shaft.z1);
    out.push(box(outerX, shaftZ.c, 0.3, shaftZ.h));
    const inner = span(e.deckTopZ, e.innerWallEndZ);
    out.push(box(innerX, inner.c, 0.3, inner.h));

    // Railings. The court is sealed except for the ramp mouth, so the only way
    // on from the arrival apron is down — which is the point of the feature.
    const cx = span(court.x0, court.x1);
    const cz = span(court.z0, court.z1);
    // The edge the ramp leaves by, and the one opposite it.
    const mouthZ = e.fallDir > 0 ? court.z1 : court.z0;
    const backZ = e.fallDir > 0 ? court.z0 : court.z1;
    out.push(box(cx.c, backZ - e.fallDir * 0.2, cx.h, 0.15, SURFACE_BAND));
    // The inner long edge (the outer one is the cutting's own rock wall).
    const innerEdgeX = e.side < 0 ? court.x1 + 0.2 : court.x0 - 0.2;
    out.push(box(innerEdgeX, cz.c, 0.15, cz.h, SURFACE_BAND));
    // The mouth edge, railed only where the ramp is NOT. The gap left here is
    // the way down; a rail across the full width would seal the entrance and
    // every other test in the suite would still pass.
    const solidX = e.side < 0 ? span(shaft.x1, court.x1) : span(court.x0, shaft.x0);
    if (solidX.h > 0.05) {
      out.push(box(solidX.c, mouthZ + e.fallDir * 0.2, solidX.h, 0.15, SURFACE_BAND));
    }
  }

  return out;
}

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

import {
  ALLEY_X,
  layoutFor,
  plazaZFor,
  streetDepthFor,
  venueFootprint,
  type ShopPlacement,
} from "./city-layout";
import { OBSTACLE_PAD, rigMaxTravelFor, rigStepFor } from "./fps-collision";

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
 *
 * AND IT IS ORDERED BY CODE UNIT, NOT BY COLLATION. Steps 3 and 4 compare
 * strings, and `String.prototype.localeCompare` compares them THE VISITOR'S
 * WAY: it reads the runtime's default locale. This function runs client-side,
 * inside a `useMemo` in `undercroft.tsx`, so `localeCompare` here means the
 * browser's locale decides where the 48-cut falls. On the live remainder keys
 * 1 and 3 are inert for most of the field and the cut lands inside a tie seven
 * wide, and Lithuanian collation sorts `y` between `i` and `j` — so two
 * visitors would see two different sets of shopfronts. That is #303 again,
 * moved off the query plan and onto the client. `<` and `>` on a string are
 * UTF-16 code-unit order: the same answer on every machine, which is the only
 * property this comparison is being asked for.
 */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareUndercroft(a: UndercroftCandidate, b: UndercroftCandidate): number {
  if (a.drops !== b.drops) return b.drops - a.drops;
  if (a.artifacts !== b.artifacts) return b.artifacts - a.artifacts;
  const ap = a.latestPublishedAt ?? "";
  const bp = b.latestPublishedAt ?? "";
  if (ap !== bp) return byCodeUnit(bp, ap);
  return byCodeUnit(a.slug, b.slug);
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

/* ---------------------------------------------------- the movement model */

/**
 * WHAT THE BODY CAN DO IN ONE FRAME. Every number below is derived from it.
 *
 * The first cut of this feature sized its railings and its terrain blend
 * against an imagined frame, and the imagined frame was smaller than the real
 * one. The rig moves `speed * Math.min(dt, RIG_DT_CLAMP)` — 0.45 m at this
 * scene's speed, not 0.15 — and a scroll notch added `scrollStep` on top of
 * that, UNCLAMPED. A railing that only blocks over 4 cm does not block. So the
 * geometry reads the movement model rather than guessing at it, and the tests
 * read the same constants.
 */
export const UNDERCROFT_SPEED = 9;
/** 0.45 m. The furthest a held key moves the body in one frame. */
export const UNDERCROFT_STEP = rigStepFor(UNDERCROFT_SPEED);
/** The rig's `scrollStep` — the distance ONE wheel notch is worth in total. */
export const UNDERCROFT_SCROLL = 2.2;
/**
 * The longest horizontal hop a single frame can make. 0.45 m.
 *
 * IT IS A PROPERTY OF THE RIG, so it is asked of the rig rather than assembled
 * here — and that is the whole of this defect. It used to be
 * `UNDERCROFT_STEP + UNDERCROFT_SCROLL` = 2.65 m, an honest description of what
 * the rig did: spend the entire accumulated scroll in one frame on top of the
 * walk. Everything downstream was then sized against 2.65 while the gate that
 * was supposed to police it sampled at 0.45, so nothing in CI ever executed a
 * frame of the length the code was designed for. Re-run at 2.65 the same
 * geometry moved the ground 1.3625 m against a 0.6625 m bar; at 0.90 it still
 * managed 0.5023 against 0.2250, by stepping across the centre of the 1.6 m
 * cutting wall and being resolved out the far side of it.
 *
 * The rig now caps a whole frame's travel at the walk step and carries the
 * unspent scroll (`rigMaxTravelFor`), so the real maximum is 0.45 — the number
 * `DECK_CLEARANCE`, the guard windows and the ramp blend were all sized against
 * in the first place. The gate samples at THIS constant, not at either literal.
 */
export const UNDERCROFT_MAX_TRAVEL = rigMaxTravelFor(UNDERCROFT_SPEED);

/**
 * The steepest ground the city already asks a body to walk: the residences'
 * switchback stair, 29.5 degrees. Nothing here invents a new capability, and
 * the step limit below is sized so that walking — or scrolling — up that
 * gradient is still accepted.
 */
export const MAX_WALKABLE_GRADE = Math.tan((29.5 * Math.PI) / 180);

/**
 * The largest ground change one move may make. DERIVED FROM THE MOVEMENT
 * MODEL, not from any piece of geometry: the furthest the body can travel
 * horizontally in a frame, times the steepest slope it is allowed to travel it
 * on. Anything beyond this is not a slope, it is an edge, and the rig refuses
 * it (see `stepMove`). ≈ 0.25 m, against a 6 m drop.
 *
 * WHY IT IS STILL THE STAIR'S GRADE AND NOT THE RAMP'S. This scene's only
 * slope is the 14° ramp, so `UNDERCROFT_MAX_TRAVEL * (RAMP_DROP / RAMP_RUN)`
 * — 0.1125 m — is the tightest value that still lets a visitor walk down. It is
 * also EXACTLY the anti-teleport gate's threshold, which would leave a
 * legitimate ramp step passing or failing on the last bit of a float, and a
 * walker who fails it does not slide, they stop dead half way down.
 *
 * So this stays the backstop and the gate stays the proof: the runtime limit
 * keeps its headroom, and `expectNoTeleport` asserts that nothing a body can
 * actually reach comes within a factor of two of it. The tighter number would
 * move the guarantee from a surveyed fact to a hard-coded hope — and the two
 * defects this file has now had both came from a number that was believed
 * rather than surveyed.
 */
export const UNDERCROFT_MAX_STEP = UNDERCROFT_MAX_TRAVEL * MAX_WALKABLE_GRADE;

/**
 * HOW FAR INSIDE THE DECK EVERY SOLID THING MUST BLOCK.
 *
 * This is the number the first cut got wrong, and it got it wrong by having
 * two different ideas of where the deck ended. A rail must stop the body at a
 * point where the ground under it is STILL DECK LEVEL, with room to spare —
 * otherwise the rail's vertical band switches off before the rail does, and a
 * body that has crossed the boundary is no longer blocked by the thing meant
 * to stop it crossing. Two whole frames of walk travel: whatever a body does
 * from a standstill against a rail, it is still on the deck.
 */
export const DECK_CLEARANCE = 2 * UNDERCROFT_STEP;

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
 * `fps-collision.test.ts` checks. It is also why the terrain has to be
 * storey-aware: under a court the same (x,z) is two pieces of ground, and a
 * function that returns one number for it is wrong for whoever is on the
 * other one. See `undercroftGroundHeight`.
 *
 * THESE TWO RECTANGLES ARE THE ONE AUTHORITY FOR WHERE THE DECK IS. The paving
 * that is drawn, the ground that can be stood on, and the rails and rock that
 * block are all derived from them (`undercroftDeckY`, `undercroftGuards`, and
 * the meshes in `undercroft.tsx`), because the defect they replace was three
 * pieces of code disagreeing about where the apron ended.
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
  },
] as const;

/**
 * How far out from the alley's centreline the mouths stand.
 *
 * `ALLEY_X` is where the alley RUNS, and it is where `BackAlley` marches its
 * props — dumpsters, crates, pipe runs, fire escapes, the service door and its
 * bulb — all of which sit on the SHOP side of the centreline, between 1.1 and
 * 3.75 out (`ALLEY_PROP_LANE`). The first cut put both mouths dead on
 * `ALLEY_X`, so at the production store count the north mouth stood inside a
 * fire escape and the south mouth inside a lamp. The outer lane is the half
 * with nothing in it, and it is derived from `ALLEY_X` rather than written as
 * a number so it cannot drift away from the alley it is supposed to be in.
 */
export const MOUTH_OFFSET = 1.4;

/** The z of the near mouth, where the near end of the street is. */
export const NORTH_MOUTH_Z = -12;

/**
 * The near mouth, held clear of the Arcade however short the street gets.
 *
 * `NORTH_MOUTH_Z` is a literal because the NEAR end of the street does not
 * move — but the FAR end does, and the plaza comes with it. Below three
 * storefronts `streetDepthFor` bottoms out at -6.5, which puts the Arcade at
 * z = -14.5 with a rotated half-depth of 5.2, and its box then covers the
 * mouth's: the north way down is inside a building and unreachable. An empty
 * database and a degraded `/marketplace/combined` both produce exactly that
 * store count, so it is not a hypothetical shape of the data.
 *
 * Non-overlap of two axis-aligned boxes on this axis is `|Δz| ≥ hz(a) + hz(b)`,
 * and the mouth is pushed north of the Arcade's near face by that plus one
 * `OBSTACLE_PAD` — the same air the resolver keeps between a body and a wall.
 * Not decoration: at exactly `hz + hz` the two boxes touch, and `6.9 < 6.9` is
 * a question about the last bit of a double rather than about the city.
 *
 * `Math.max` and not a clamp: at every store count the street actually ships
 * with, the plaza is a hundred metres away and this returns `NORTH_MOUTH_Z`
 * unchanged.
 */
export function northMouthZFor(storeCount: number): number {
  const arcadeNearFace = plazaZFor(storeCount) + venueFootprint("arcade").hz;
  return Math.max(NORTH_MOUTH_Z, arcadeNearFace + venueFootprint("undercroft").hz + OBSTACLE_PAD);
}
/**
 * The far mouth, measured from the street's far end — the same way the tower,
 * the monument, the Arcade and the Bank are all measured.
 *
 * It was a literal -100 while the street's end moved with the store count, so
 * at 40 storefronts it rendered dead centre inside Resonance Trust, and below
 * 29 it fell outside the rig's own movement clamp and could not be reached at
 * all. It never fired at the production count, and no test imported it.
 */
export const SOUTH_MOUTH_Z_OFFSET = 3;

export interface StreetMouth {
  id: "north" | "south";
  x: number;
  z: number;
}

/**
 * Where each entrance's mouth stands on the street above, for a street of
 * `storeCount` shopfronts.
 *
 * A FUNCTION, not a table, for the same reason `monumentZFor` is one: the
 * street's far end is a function of how many shops are on it, and anything
 * standing at that end has to be too.
 */
export function streetMouthsFor(storeCount: number): StreetMouth[] {
  return [
    { id: "north", x: -(ALLEY_X + MOUTH_OFFSET), z: northMouthZFor(storeCount) },
    { id: "south", x: ALLEY_X + MOUTH_OFFSET, z: streetDepthFor(storeCount) + SOUTH_MOUTH_Z_OFFSET },
  ];
}

/* ------------------------------------------------- coming back up the ramp */

/**
 * HOW FAR UP THE ALLEY A RETURNING VISITOR STANDS, and why it is measured
 * along z rather than out from the kiosk.
 *
 * `/undercroft` links back to `/city?from=__undercroft__`, and the street
 * spawns the body beside the north mouth. The mouth is a solid piece of street
 * furniture — `venueFootprint("undercroft")`, 1.7 half-extents, plus the
 * resolver's 0.5 m of air — so anything inside 2.2 m of its centre is inside
 * the box the visitor just walked out of. The first cut spawned at 1.4 m and
 * `resolveObstacles` shoved the body 0.80 m sideways on its very first frame.
 *
 * ACROSS THE ALLEY THERE IS NOWHERE TO PUT IT. The mouth stands `MOUTH_OFFSET`
 * outboard of the alley's centreline, and `ALLEY_PROP_LANE` — every dumpster,
 * crate, pipe run and fire escape `BackAlley` draws — starts 1.1 m inboard of
 * it. That leaves the x axis a window 0.3 m wide between "inside the kiosk"
 * and "inside a dumpster", which is not a place to stand, it is a coincidence
 * waiting to be edited away.
 *
 * ALONG THE ALLEY THERE IS ALL THE ROOM THERE IS. Standing the body ON the
 * centreline puts it the full `MOUTH_OFFSET` clear of the prop lane and as far
 * from the shop backs as the alley allows, and the clearance from the kiosk is
 * then bought in z, where nothing else is competing for the space. Which is
 * also, word for word, what the comment at the call site always claimed was
 * happening.
 */
export const RETURN_SPAWN_CLEARANCE = 0.8;

export interface StreetReturnSpawn {
  position: [number, number, number];
  yaw: number;
}

/**
 * Where the street puts a body that has just come back up the given mouth.
 *
 * `+z` is up-alley towards the district entrance for both mouths, so a visitor
 * surfaces facing the kiosk with the rest of the city behind them — the same
 * "out of the door, turned to look at what you left" that `__scada__` uses.
 */
export function streetReturnSpawn(m: StreetMouth, eye: number = UNDERCROFT_EYE): StreetReturnSpawn {
  const half = venueFootprint("undercroft").hz;
  return {
    position: [Math.sign(m.x) * ALLEY_X, eye, m.z + half + OBSTACLE_PAD + RETURN_SPAWN_CLEARANCE],
    // Looking back down the alley at the mouth: 0 faces -z.
    yaw: 0,
  };
}

/** Is (x,z) on this rectangle at all? The deck is a rectangle, not a fade. */
function insideRect(x: number, z: number, r: Rect): boolean {
  return x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;
}

/** The elevation of one entrance's deck at this z — level, then falling. */
export function deckYAt(e: UndercroftEntrance, z: number): number {
  const progress = e.fallDir > 0 ? z - e.deckTopZ : e.deckTopZ - z;
  if (progress <= 0) return UNDERCROFT_SURFACE_Y;
  return Math.max(UNDERCROFT_FLOOR_Y, UNDERCROFT_SURFACE_Y - (progress / RAMP_RUN) * RAMP_DROP);
}

/**
 * The deck's elevation at (x,z), or null where there is no deck.
 *
 * THE ONE AUTHORITY. The paving drawn in `undercroft.tsx`, the ground the rig
 * stands on, and every rail and rock wall in `undercroftGuards` are all derived
 * from this and from the two rectangles it reads. The defect it replaces was
 * those three answering differently: the drawn plane covered the whole
 * rectangle, the standable ground began fading 0.8 m INSIDE it, and the rails
 * blocked 0.45 m inside THAT — so a third of every apron was paving you sank
 * through, and the rails' vertical band had switched off before the rails did.
 *
 * A rectangle with a hard edge, deliberately. An 82-degree skirt is not a
 * slope, and pretending it is one bought nothing: what stops a body walking
 * over an edge is a rail in front of it and a step limit in the rig behind
 * that, not a ramp too steep to walk.
 */
export function undercroftDeckY(x: number, z: number): number | null {
  let best: number | null = null;
  for (const e of UNDERCROFT_ENTRANCES) {
    if (!insideRect(x, z, e.court) && !insideRect(x, z, e.shaft)) continue;
    const y = deckYAt(e, z);
    if (best === null || y > best) best = y;
  }
  return best;
}

/**
 * How far the storey test tolerates being below the deck and still calling you
 * "on it". Sized from the movement model so that walking UP the ramp from the
 * lobby floor is recognised as getting onto the deck rather than as leaving it.
 */
export const STOREY_TOL = UNDERCROFT_MAX_STEP;

/**
 * The ground under (x,z) — the terrain callback the rig walks on.
 *
 * STOREY-AWARE, because the courts sit over the unit line and the same (x,z)
 * is therefore two different pieces of ground: the apron at zero and the
 * concourse at minus six. A function of (x,z) alone has to pick one, and
 * whichever it picks it is wrong for somebody — the first cut picked the deck,
 * which is why a shopper who squeezed between two units at concourse level was
 * lifted six metres onto the apron in a single frame.
 *
 * `fromGround` is the ground the body is standing on now. Given it, this is
 * a fixed point: a body on the deck stays on the deck, a body underneath stays
 * underneath, and the only way between them is the ramp, where the two
 * surfaces meet. Without it — the first snap after a spawn, before there is
 * any history — the deck wins, which is correct because both spawns are on it.
 */
export function undercroftGroundHeight(x: number, z: number, fromGround?: number): number {
  const deck = undercroftDeckY(x, z);
  if (deck === null || deck <= UNDERCROFT_FLOOR_Y) return UNDERCROFT_FLOOR_Y;
  if (fromGround === undefined) return deck;
  return fromGround >= deck - STOREY_TOL ? deck : UNDERCROFT_FLOOR_Y;
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

/** A railing's half-thickness and its height above the deck. */
export const RAIL_HALF = 0.15;
export const RAIL_HEIGHT = 1.1;
/** A cutting wall's half-thickness, and how far it stands proud of the deck. */
export const ROCK_HALF = 0.3;
export const ROCK_PARAPET = 0.6;

/**
 * Where a slab must stand so that the body it stops is `DECK_CLEARANCE` inside
 * the deck edge it is guarding.
 *
 * `inward` is the direction from the edge into the deck. The resolver pushes a
 * body out to `centre ± (half + OBSTACLE_PAD)`, so THAT is the blocking face,
 * and it — not the drawn slab — is what has to land inside the deck. Deriving
 * it is the whole fix for "rails do not rail": the first cut placed each rail
 * 0.2 m OUTSIDE its court, which put the face 0.45 m inside, which is exactly
 * one frame of travel, which is not a blocking window at all.
 */
export function guardCenter(edge: number, inward: 1 | -1, half: number): number {
  return edge + inward * (DECK_CLEARANCE - half - OBSTACLE_PAD);
}

export type GuardKind = "rail" | "rock" | "fill";

export interface UndercroftGuard {
  id: string;
  kind: GuardKind;
  cx: number;
  cz: number;
  hx: number;
  hz: number;
  /** Vertical extent of the DRAWN slab, so the mesh and the box agree. */
  y0: number;
  y1: number;
  band?: { yMin?: number; yMax?: number };
  /** The deck edge this guard holds a body back from. Absent on `fill`. */
  guards?: { axis: "x" | "z"; edge: number; inward: 1 | -1 };
}



/**
 * The rails and the rock, derived from the deck rectangles.
 *
 * ONE LIST, read by `undercroftObstacles` for collision and by `undercroft.tsx`
 * for the meshes, because "the railing you see" and "the railing that stops
 * you" being two separate literals is how the first cut ended up with a drawn
 * apron 35% of which was not standable and rails that blocked over four
 * centimetres.
 *
 * THE BANDS, and the bands are the feature:
 *
 *   · RAILINGS carry `SURFACE_BAND`. They stop a visitor walking off the
 *     apron; they must not stop the visitor walking UNDER it, and with a
 *     storey-aware terrain there genuinely is somebody under it — the courts
 *     sit over the unit line and those units are reachable from the concourse.
 *   · CUTTING WALLS carry no band at all. Rock is solid at every elevation,
 *     which is what an obstacle already meant.
 */
export function undercroftGuards(): UndercroftGuard[] {
  const out: UndercroftGuard[] = [];

  for (const e of UNDERCROFT_ENTRANCES) {
    const { court, shaft } = e;
    const shaftZ = span(shaft.z0, shaft.z1);

    // THE CUTTING'S TWO ROCK WALLS, both running the full length of the shaft
    // — which is what the scene has always DRAWN. The collider for the inner
    // one used to stop at the hall's end while the rock carried on, so the
    // last four metres of the ramp had a wall you could see and walk through.
    // The inner one starts at the ramp head, because south of that the deck
    // widens into the court and a wall there would seal the apron off from
    // its own ramp.
    const outerEdge = e.side < 0 ? shaft.x0 : shaft.x1;
    const innerEdge = e.side < 0 ? shaft.x1 : shaft.x0;
    const outerInward: 1 | -1 = e.side < 0 ? 1 : -1;
    const innerInward: 1 | -1 = e.side < 0 ? -1 : 1;
    out.push({
      id: `${e.id}-cutting-outer`,
      kind: "rock",
      cx: guardCenter(outerEdge, outerInward, ROCK_HALF),
      cz: shaftZ.c,
      hx: ROCK_HALF,
      hz: shaftZ.h,
      y0: UNDERCROFT_FLOOR_Y - 0.6,
      y1: UNDERCROFT_SURFACE_Y + ROCK_PARAPET,
      guards: { axis: "x", edge: outerEdge, inward: outerInward },
    });
    const innerZ = span(e.deckTopZ, e.fallDir > 0 ? shaft.z1 : shaft.z0);
    out.push({
      id: `${e.id}-cutting-inner`,
      kind: "rock",
      cx: guardCenter(innerEdge, innerInward, ROCK_HALF),
      cz: innerZ.c,
      hx: ROCK_HALF,
      hz: innerZ.h,
      y0: UNDERCROFT_FLOOR_Y - 0.6,
      y1: UNDERCROFT_SURFACE_Y + ROCK_PARAPET,
      guards: { axis: "x", edge: innerEdge, inward: innerInward },
    });

    // THE COURT'S RAILINGS. The apron is sealed except for the ramp mouth, so
    // the only way on from the arrival apron is down.
    const cx = span(court.x0, court.x1);
    const cz = span(court.z0, court.z1);
    const backEdge = e.fallDir > 0 ? court.z0 : court.z1;
    const mouthEdge = e.fallDir > 0 ? court.z1 : court.z0;
    out.push({
      id: `${e.id}-rail-back`,
      kind: "rail",
      cx: cx.c,
      cz: guardCenter(backEdge, e.fallDir, RAIL_HALF),
      hx: cx.h,
      hz: RAIL_HALF,
      y0: UNDERCROFT_SURFACE_Y,
      y1: UNDERCROFT_SURFACE_Y + RAIL_HEIGHT,
      band: SURFACE_BAND,
      guards: { axis: "z", edge: backEdge, inward: e.fallDir },
    });
    // The inner long edge (the outer one is the cutting's own rock wall).
    const innerEdgeX = e.side < 0 ? court.x1 : court.x0;
    out.push({
      id: `${e.id}-rail-inner`,
      kind: "rail",
      cx: guardCenter(innerEdgeX, e.side, RAIL_HALF),
      cz: cz.c,
      hx: RAIL_HALF,
      hz: cz.h,
      y0: UNDERCROFT_SURFACE_Y,
      y1: UNDERCROFT_SURFACE_Y + RAIL_HEIGHT,
      band: SURFACE_BAND,
      guards: { axis: "x", edge: innerEdgeX, inward: e.side },
    });
    // The mouth edge, railed only where the ramp is NOT. The gap left here is
    // the way down; a rail across the full width would seal the entrance and
    // every other test in the suite would still pass.
    const solidX = e.side < 0 ? span(shaft.x1, court.x1) : span(court.x0, shaft.x0);
    if (solidX.h > 0.05) {
      const inward: 1 | -1 = e.fallDir > 0 ? -1 : 1;
      out.push({
        id: `${e.id}-rail-mouth`,
        kind: "rail",
        cx: solidX.c,
        cz: guardCenter(mouthEdge, inward, RAIL_HALF),
        hx: solidX.h,
        hz: RAIL_HALF,
        y0: UNDERCROFT_SURFACE_Y,
        y1: UNDERCROFT_SURFACE_Y + RAIL_HEIGHT,
        band: SURFACE_BAND,
        guards: { axis: "z", edge: mouthEdge, inward },
      });
    }
  }

  // THE ROCK AT THE HEAD OF EACH RAMP.
  //
  // A descending ramp leaves a wedge of space beneath it, and that wedge is
  // open floor: a shopper on the concourse can walk under the arrival apron —
  // which they should be able to, the units are down there — and carry on
  // south under the ramp itself, which they should not. Part-way along, the
  // underside comes within one step of their head and they climb onto their
  // own ramp sideways: a metre and a half of ground in a single frame, and the
  // survey found it. Sealing the wedge at its one opening is enough, because
  // the cutting walls close it on both sides for its whole length and at the
  // far end the ramp has already met the floor.
  //
  // Scoped to the concourse: a body ON the ramp here is at street level and
  // walks straight over it, which is the entire reason obstacles grew a band.
  for (const e of UNDERCROFT_ENTRANCES) {
    const sx = span(e.shaft.x0, e.shaft.x1);
    out.push({
      id: `${e.id}-ramp-head-bulkhead`,
      kind: "fill",
      cx: sx.c,
      cz: e.deckTopZ + e.fallDir * ROCK_HALF,
      hx: sx.h,
      hz: ROCK_HALF,
      y0: UNDERCROFT_FLOOR_Y - 0.6,
      y1: UNDERCROFT_CEILING_Y,
      band: CONCOURSE_BAND,
    });
  }

  return out;
}

/**
 * Everything solid down here, and the elevations at which it is solid.
 *
 * UNITS and HALL WALLS carry `yMax: UNDERCROFT_CEILING_Y`. They are real to
 * somebody on the concourse and invisible to somebody on the apron six metres
 * above them — which is the whole reason `FpsObstacle` grew a vertical term.
 * Without it, standing on a court at x = ±6 would put you inside a shop you
 * cannot see, and the shop would win. Everything at the surface comes from
 * `undercroftGuards`, which is also what the scene draws.
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

  for (const g of undercroftGuards()) {
    out.push(box(g.cx, g.cz, g.hx, g.hz, g.band));
  }

  return out;
}

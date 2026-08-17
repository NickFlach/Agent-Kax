/**
 * undercroft.test.ts — the parts of a second storey that a screenshot cannot check.
 *
 * WHAT CHANGED HERE, AND WHY IT MATTERS MORE THAN THE REST OF THE FILE.
 *
 * The previous anti-teleport gate sampled the terrain every 0.05 m and required
 * the ground to change by less than 0.4 between samples — and it derived that
 * 0.4 from the very geometry it was supposed to be policing (a 6 m drop over an
 * 0.8 m blend). The rig does not move 0.05 m in a frame. It moves
 * `speed * Math.min(dt, 0.05)` = 0.45 m, and one scroll notch adds 2.2 m on top
 * of that, unclamped. Re-sampled at the real step the same terrain moved the
 * ground 3.375 m in a frame. The one gate that would have caught the defect had
 * been calibrated, in good faith, to pass it.
 *
 * So the gate below:
 *
 *   · takes its step from the MOVEMENT MODEL — `UNDERCROFT_STEP`, computed from
 *     the scene's speed and the rig's dt clamp, not from an assumed frame rate;
 *   · takes its threshold from the MOVEMENT MODEL too — the steepest surface
 *     the scene means anybody to walk (the ramp) times that step. Never from
 *     the shape of an edge, because an edge that got steeper would then move
 *     the bar it is measured against;
 *   · runs the RIG'S OWN `stepMove`, over positions it can actually REACH,
 *     rather than over a grid of coordinates half of which are inside rock.
 *     A terrain gate that ignores collision is measuring a world nobody walks.
 *
 * And it was checked against the pre-fix geometry, where it fails — a gate that
 * passes before the fix is not a gate.
 *
 * The rest of the file's original four claims still hold and are still here:
 * the order is total (#303), the decline is walkable, a unit with work is not
 * advertised as vacant (#302), and nothing proves anything about an empty set.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isTunnelProof,
  OBSTACLE_PAD,
  resolveObstacles,
  stepMove,
  type FpsBounds,
  type FpsObstacle,
} from "./fps-collision";
import { storefrontWindowCard, THIN_STOREFRONT_ARTIFACTS } from "./storefront-window";
import {
  ALLEY_PROP_LANE,
  ALLEY_X,
  alleyPropFootprint,
  alleyProps,
  monumentZFor,
  plazaZFor,
  PLAZA_FLANK_X,
  streetDepthFor,
  venueFootprint,
  layoutFor,
} from "./city-layout";
import {
  DECK_CLEARANCE,
  MAX_UNDERCROFT_UNITS,
  MAX_WALKABLE_GRADE,
  RAMP_DROP,
  RAMP_RUN,
  SURFACE_BAND,
  UNDERCROFT_BOUNDS,
  UNDERCROFT_CEILING_Y,
  UNDERCROFT_ENTRANCES,
  UNDERCROFT_EYE,
  UNDERCROFT_FLOOR_Y,
  UNDERCROFT_MAX_STEP,
  UNDERCROFT_MAX_TRAVEL,
  UNDERCROFT_SCROLL,
  UNDERCROFT_SPEED,
  UNDERCROFT_STEP,
  UNDERCROFT_SURFACE_Y,
  compareUndercroft,
  deckYAt,
  northMouthZFor,
  NORTH_MOUTH_Z,
  rankUndercroft,
  streetMouthsFor,
  streetReturnSpawn,
  undercroftDeckY,
  undercroftGroundHeight,
  undercroftGuards,
  undercroftObstacles,
  undercroftSlots,
  type Rect,
  type UndercroftCandidate,
} from "./undercroft";

const here = dirname(fileURLToPath(import.meta.url));
const SCENE = readFileSync(join(here, "..", "pages", "undercroft.tsx"), "utf8");
const STREET = readFileSync(join(here, "..", "pages", "marketplace-3d.tsx"), "utf8");
/**
 * The rig itself, as source. It imports three.js and R3F, so the Node runner
 * cannot execute a line of it — which is exactly why `fps-collision.ts` exists.
 * What is left inside `useFrame` is the wiring, and the wiring is checked the
 * only way it can be: by reading it.
 */
const RIG = readFileSync(join(here, "..", "components", "first-person-rig.tsx"), "utf8");

/* -------------------------------------------------------------- the fixture */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A remainder that looks like the real one: mostly dormant, a handful of
 * publishers, and — the important part — a large block that is EXACTLY TIED on
 * every key except slug. The live remainder is full of these: 278 of 302
 * storefronts have never published, so `drops` is 0 for almost all of them and
 * `artifactCount` collides constantly.
 */
function remainder(): UndercroftCandidate[] {
  const rnd = mulberry32(4816);
  const out: UndercroftCandidate[] = [];
  // Twelve genuine publishers — the commerce band.
  for (let i = 0; i < 12; i++) {
    out.push({
      slug: `pub-${String(i).padStart(2, "0")}`,
      name: `Publisher ${i}`,
      drops: 1 + Math.floor(rnd() * 5),
      artifacts: 5 + Math.floor(rnd() * 300),
      latestPublishedAt: `2026-08-${String(1 + (i % 15)).padStart(2, "0")}T00:00:00.000Z`,
      claimed: rnd() > 0.5,
      source: "obc",
    });
  }
  // Forty dormant stores that DO hold work, all with the same artifact count —
  // a tie forty wide, straddling the 48-cut.
  for (let i = 0; i < 40; i++) {
    out.push({
      slug: `tied-${String(i).padStart(2, "0")}`,
      name: `Tied ${i}`,
      drops: 0,
      artifacts: 24,
      latestPublishedAt: null,
      claimed: false,
      source: "obc",
    });
  }
  // Twenty thin ones, fairly described as vacant.
  for (let i = 0; i < 20; i++) {
    out.push({
      slug: `thin-${String(i).padStart(2, "0")}`,
      name: `Thin ${i}`,
      drops: 0,
      artifacts: i % 3,
      latestPublishedAt: null,
      claimed: false,
      source: "obc",
    });
  }
  return out;
}

function shuffled<T>(xs: readonly T[], rnd: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/* ---------------------------------------------------------------- the order */

describe("the Undercroft's order", () => {
  it("has something to order", () => {
    // Vacuity guard, first, for everything below.
    const all = remainder();
    expect(all.length).toBeGreaterThan(MAX_UNDERCROFT_UNITS);
    const tied = all.filter((c) => c.drops === 0 && c.artifacts === 24);
    expect(tied.length, "the fixture has no tie, so the tiebreak is untested").toBeGreaterThan(10);
    // The tie must actually STRADDLE the cut, or the tiebreak decides nothing.
    const ranked = rankUndercroft(all);
    const tiedInside = ranked.filter((c) => c.drops === 0 && c.artifacts === 24).length;
    expect(tiedInside).toBeGreaterThan(0);
    expect(tiedInside).toBeLessThan(tied.length);
  });

  it("returns the same 48 in the same order however the input arrives", () => {
    const all = remainder();
    const rnd = mulberry32(99);
    const first = rankUndercroft(all).map((c) => c.slug);
    expect(first.length).toBe(MAX_UNDERCROFT_UNITS);
    for (let run = 0; run < 50; run++) {
      const got = rankUndercroft(shuffled(all, rnd)).map((c) => c.slug);
      expect(got, `run ${run} produced a different Undercroft`).toEqual(first);
    }
  });

  it("puts the commerce band at the top, and does not use `claimed` to do it", () => {
    const all = remainder();
    const ranked = rankUndercroft(all);
    const publishers = ranked.filter((c) => c.drops > 0);
    expect(publishers.length, "no publishers in the fixture").toBeGreaterThan(0);
    // Every store with a drop outranks every store without one.
    const lastPublisher = ranked.findLastIndex((c) => c.drops > 0);
    const firstDormant = ranked.findIndex((c) => c.drops === 0);
    expect(lastPublisher).toBeLessThan(firstDormant);
    // And claim status must not be what did it. An unclaimed publisher above a
    // claimed non-publisher is the case #302's bug would have got backwards.
    const unclaimedPublisher = ranked.find((c) => c.drops > 0 && !c.claimed);
    const claimedDormant = ranked.find((c) => c.drops === 0 && c.claimed);
    if (unclaimedPublisher && claimedDormant) {
      expect(ranked.indexOf(unclaimedPublisher)).toBeLessThan(ranked.indexOf(claimedDormant));
    }
    expect(
      compareUndercroft(
        { slug: "a", name: "a", drops: 0, artifacts: 500, latestPublishedAt: null, claimed: false, source: "obc" },
        { slug: "b", name: "b", drops: 0, artifacts: 1, latestPublishedAt: null, claimed: true, source: "obc" },
      ),
      "a claimed empty shop outranked 500 pieces of work",
    ).toBeLessThan(0);
  });

  it("breaks a total tie on slug, ascending, and nothing else", () => {
    const tie = (slug: string): UndercroftCandidate => ({
      slug,
      name: slug,
      drops: 0,
      artifacts: 24,
      latestPublishedAt: null,
      claimed: false,
      source: "obc",
    });
    const ranked = rankUndercroft([tie("zeta"), tie("alpha"), tie("mid")]);
    expect(ranked.map((c) => c.slug)).toEqual(["alpha", "mid", "zeta"]);
  });
});

/* ------------------------------------------------- the order is the VISITOR'S */

/**
 * THE TIE THE LIVE 48-CUT LANDS INSIDE.
 *
 * Seven slugs, all on `artifactCount` 42 with no drops and no publish date, so
 * every key above the tiebreak is exhausted and the tiebreak alone decides
 * which of them get a shopfront. Two of them start with `y`, which is the whole
 * point: Lithuanian collation sorts `y` between `i` and `j`, so under a
 * locale-sensitive comparison `yves` and `yukitsuki` jump above `knox` and the
 * cut falls somewhere else entirely.
 *
 * The fixture the file used to carry (`zeta`, `alpha`, `mid`) collates
 * identically in every locale on earth. It could not have caught this and it
 * did not.
 */
const LIVE_TIE = ["slate", "yves", "flint", "roux", "knox", "yukitsuki", "sage"] as const;
const LIVE_TIE_ORDER = ["flint", "knox", "roux", "sage", "slate", "yukitsuki", "yves"] as const;

function tied42(slug: string): UndercroftCandidate {
  return { slug, name: slug, drops: 0, artifacts: 42, latestPublishedAt: null, claimed: false, source: "obc" };
}

describe("which shopfronts exist is not a fact about the visitor's locale", () => {
  it("has a fixture that different locales genuinely disagree about", () => {
    // Anti-vacuity, and it is the assertion the old tiebreak fixture failed to
    // make: prove these strings are ones collation actually reorders, or the
    // pinned order below proves nothing at all.
    const lt = new Intl.Collator("lt");
    expect(lt.compare("yves", "knox"), "`lt` no longer sorts y before k — pick a new fixture").toBeLessThan(0);
    expect("yves" < "knox", "code-unit order should put y after k").toBe(false);
  });

  it("pins the live seven-wide tie to one order, whatever the runtime collates", () => {
    const expected = [...LIVE_TIE_ORDER];
    expect(rankUndercroft(LIVE_TIE.map(tied42)).map((c) => c.slug)).toEqual(expected);

    // And now the real gate: make the runtime's `localeCompare` Lithuanian and
    // rank again. If the comparison ever routes through `localeCompare` — which
    // reads the DEFAULT LOCALE, i.e. the browser's, because this code runs in a
    // `useMemo` on the client — the order moves and this fails. A test that
    // merely ran under the CI machine's own locale could not see that.
    const original = String.prototype.localeCompare;
    const lt = new Intl.Collator("lt");
    // eslint-disable-next-line no-extend-native
    String.prototype.localeCompare = function (that: string) {
      return lt.compare(String(this), String(that));
    } as typeof String.prototype.localeCompare;
    try {
      expect("yves".localeCompare("knox"), "the patch is not discriminating").toBeLessThan(0);
      expect(
        rankUndercroft(LIVE_TIE.map(tied42)).map((c) => c.slug),
        "the 48-cut moved when the runtime's collation did",
      ).toEqual(expected);
      // The date key is a string comparison too, and has the same exposure.
      const dated = (slug: string, at: string): UndercroftCandidate => ({
        ...tied42(slug),
        latestPublishedAt: at,
      });
      expect(
        rankUndercroft([dated("a", "2026-01-02T00:00:00Z"), dated("b", "2026-01-10T00:00:00Z")]).map((c) => c.slug),
        "the recency key moved when the runtime's collation did",
      ).toEqual(["b", "a"]);
    } finally {
      String.prototype.localeCompare = original;
    }
  });
});

/* --------------------------------------------------------- the movement model */

const OBSTACLES: FpsObstacle[] = undercroftObstacles();
const BOUNDS: FpsBounds = UNDERCROFT_BOUNDS;

export interface Pos {
  x: number;
  y: number;
  z: number;
}

/**
 * One frame, through the rig's own code — not a tidied copy of it.
 *
 * `maxGroundStep` is a parameter so the SAME frame can be run with the limit
 * the scene arms today and with the one it armed before the rig's travel was
 * bounded. That is what makes the gate falsifiable: a world is a movement model
 * plus a geometry, and the pre-fix movement model has to be runnable.
 */
function frameWith(p: Pos, dx: number, dz: number, maxGroundStep: number): Pos {
  const r = stepMove({
    x: p.x,
    y: p.y,
    z: p.z,
    dx,
    dz,
    dy: 0,
    eyeHeight: UNDERCROFT_EYE,
    bounds: BOUNDS,
    obstacles: OBSTACLES,
    groundHeight: undercroftGroundHeight,
    maxGroundStep,
  });
  return { x: r.x, y: r.y, z: r.z };
}

function frame(p: Pos, dx: number, dz: number): Pos {
  return frameWith(p, dx, dz, UNDERCROFT_MAX_STEP);
}

function standAt(x: number, z: number, storey: "deck" | "floor"): Pos {
  const from = storey === "deck" ? UNDERCROFT_SURFACE_Y : UNDERCROFT_FLOOR_Y;
  return { x, y: undercroftGroundHeight(x, z, from) + UNDERCROFT_EYE, z };
}

/** Hold one direction for `frames` frames, the way the headless rig does. */
function walk(from: Pos, yaw: number, frames: number): Pos[] {
  const fx = -Math.sin(yaw) * UNDERCROFT_STEP;
  const fz = -Math.cos(yaw) * UNDERCROFT_STEP;
  let p = { ...from };
  const trail: Pos[] = [p];
  for (let i = 0; i < frames; i++) {
    p = frame(p, fx, fz);
    trail.push(p);
  }
  return trail;
}

function walkUntil(from: Pos, yaw: number, pred: (p: Pos) => boolean, maxFrames = 400) {
  const trail = walk(from, yaw, maxFrames);
  const at = trail.findIndex(pred);
  return { trail, reached: at >= 0, at: trail[at >= 0 ? at : trail.length - 1]! };
}

function insideRect(x: number, z: number, r: Rect): boolean {
  return x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;
}

/* --------------------------------------------------- the anti-teleport gate */

/**
 * A world to survey. Parameterised so the SAME gate can be pointed at the
 * pre-fix geometry and the pre-fix movement loop, which is how "this gate
 * fails before the fix" was established rather than asserted.
 */
export interface WorldUnderTest {
  step: number;
  eye: number;
  bounds: FpsBounds;
  spawns: ReadonlyArray<readonly [number, number]>;
  groundHeight: (x: number, z: number, fromGround?: number) => number;
  /** One frame of movement. The rig's, or a verbatim copy of an older rig's. */
  move: (p: Pos, dx: number, dz: number) => Pos;
}

export interface Survey {
  cells: number;
  /** The largest ground change any ACCEPTED move made. */
  worstStep: number;
  worstAt: { from: Pos; to: Pos } | null;
  highest: number;
  lowest: number;
  /** Reachable positions the walls should have held and did not. */
  outside: number;
  outsideAt: Pos | null;
}

/**
 * Flood-fill everywhere a body can get to, one real frame at a time.
 *
 * The grid is quantised at the rig's own step and keyed by (cell, storey), so
 * a deck over a concourse is two distinct places rather than one contested
 * one. Every accepted transition contributes its ground change; the worst of
 * them is what the gate is about.
 */
export function surveyReachable(w: WorldUnderTest): Survey {
  const q = w.step;
  const key = (p: Pos) =>
    `${Math.round(p.x / q)},${Math.round(p.z / q)},${p.y - w.eye > UNDERCROFT_FLOOR_Y + 0.001 ? 1 : 0}`;
  const seen = new Set<string>();
  const queue: Pos[] = [];
  for (const [x, z] of w.spawns) {
    const p: Pos = { x, y: w.groundHeight(x, z) + w.eye, z };
    if (seen.has(key(p))) continue;
    seen.add(key(p));
    queue.push(p);
  }

  const dirs: Array<[number, number]> = [];
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    dirs.push([Math.cos(a) * q, Math.sin(a) * q]);
  }

  let worstStep = 0;
  let worstAt: { from: Pos; to: Pos } | null = null;
  let highest = -Infinity;
  let lowest = Infinity;
  let outside = 0;
  let outsideAt: Pos | null = null;

  const b = w.bounds;
  const isOutside = (p: Pos) => p.x < b.minX || p.x > b.maxX || p.z < b.minZ || p.z > b.maxZ;

  while (queue.length) {
    const p = queue.pop()!;
    if (p.y > highest) highest = p.y;
    if (p.y < lowest) lowest = p.y;
    if (isOutside(p)) {
      outside++;
      if (!outsideAt) outsideAt = p;
    }
    for (const [dx, dz] of dirs) {
      const n = w.move(p, dx, dz);
      const moved = Math.hypot(n.x - p.x, n.z - p.z);
      if (moved < 1e-9) continue;
      const d = Math.abs(n.y - p.y);
      if (d > worstStep) {
        worstStep = d;
        worstAt = { from: p, to: n };
      }
      const k = key(n);
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push(n);
    }
  }

  return { cells: seen.size, worstStep, worstAt, highest, lowest, outside, outsideAt };
}

/**
 * The gate itself.
 *
 * THE THRESHOLD COMES FROM THE MOVEMENT MODEL AND NOTHING ELSE: the furthest
 * the body travels in one frame, times the steepest grade the scene means
 * anybody to walk. It is deliberately NOT derived from any edge, blend, skirt
 * or railing — that is precisely the mistake the previous gate made, and it is
 * what let a 6-metre drop set its own pass mark.
 */
/**
 * The coverage floor, in cells of the survey's OWN size.
 *
 * The flood fill quantises at `w.step`, so a survey that samples twice as
 * coarsely covers the same excavation in a quarter of the cells. A fixed floor
 * is therefore a floor on the STEP as much as on the coverage, and pointing the
 * gate at a longer frame trips it for want of cells rather than for the thing
 * it is looking for. Scaling by the area of a cell holds every survey to the
 * same proportion of the scene, which is what the guard was ever about.
 */
export const SHIPPING_CELL_FLOOR = 3000;

export function coverageFloor(step: number): number {
  return Math.round(SHIPPING_CELL_FLOOR * (UNDERCROFT_MAX_TRAVEL / step) ** 2);
}

export function expectNoTeleport(w: WorldUnderTest, label: string) {
  const survey = surveyReachable(w);
  // Anti-vacuity, first and hard. A gate over three cells proves nothing, and
  // a gate that never left the apron would not have seen the concourse at all.
  expect(survey.cells, `${label}: the survey barely moved`).toBeGreaterThan(coverageFloor(w.step));
  expect(survey.highest, `${label}: the survey never stood on the surface`).toBeGreaterThan(
    UNDERCROFT_SURFACE_Y + w.eye - 1e-6,
  );
  expect(survey.lowest, `${label}: the survey never reached the concourse`).toBeLessThan(
    UNDERCROFT_FLOOR_Y + w.eye + 1e-6,
  );

  const limit = w.step * (RAMP_DROP / RAMP_RUN);
  expect(
    survey.worstStep,
    `${label}: a single ${w.step} m frame moved the ground ${survey.worstStep.toFixed(3)} m` +
      (survey.worstAt
        ? ` (${JSON.stringify(survey.worstAt.from)} → ${JSON.stringify(survey.worstAt.to)})`
        : ""),
  ).toBeLessThanOrEqual(limit + 1e-9);
}

/**
 * The Undercroft as it ships, surveyed from both spawns and from the floor.
 *
 * THE STEP IS `UNDERCROFT_MAX_TRAVEL`, NOT `UNDERCROFT_STEP`. The gate used to
 * survey at 0.45 m — walking pace — while the same file derived the armed
 * `maxGroundStep` from a travel of 2.65 m and the rig would actually deliver
 * it. A gate that samples at a sixth of the frame it polices is not sampling
 * the frame; re-run at the real number it failed at 1.4909 m against a limit of
 * 0.2250. The rig now rate-limits the scroll so the real number is 0.90, and
 * this reads it from the movement model rather than from either literal.
 */
export function shippingWorld(): WorldUnderTest {
  return {
    step: UNDERCROFT_MAX_TRAVEL,
    eye: UNDERCROFT_EYE,
    bounds: BOUNDS,
    spawns: [
      [UNDERCROFT_ENTRANCES[0]!.spawn[0], UNDERCROFT_ENTRANCES[0]!.spawn[2]],
      [UNDERCROFT_ENTRANCES[1]!.spawn[0], UNDERCROFT_ENTRANCES[1]!.spawn[2]],
    ],
    groundHeight: undercroftGroundHeight,
    move: (p, dx, dz) => frame(p, dx, dz),
  };
}

/**
 * The same geometry, walked by the rig AS IT STOOD before a frame had a travel
 * budget: the whole accumulated scroll spent in one go on top of the walk, and
 * a `maxGroundStep` derived from that 2.65 m travel.
 *
 * This exists so "the gate now polices the real frame" is a demonstration
 * rather than a claim. Point the corrected gate at this world and it fails; a
 * gate that passes on the movement model that produced the defect is not a
 * gate, it is a calibration of it.
 */
export const PRE_CLAMP_TRAVEL = UNDERCROFT_STEP + UNDERCROFT_SCROLL;

export function preClampWorld(): WorldUnderTest {
  const maxStep = PRE_CLAMP_TRAVEL * MAX_WALKABLE_GRADE;
  return {
    ...shippingWorld(),
    step: PRE_CLAMP_TRAVEL,
    move: (p, dx, dz) => frameWith(p, dx, dz, maxStep),
  };
}

/* -------------------------------------------------------------- the decline */

describe("the walking decline", () => {
  it("declines at a walkable angle, and reaches the floor", () => {
    for (const e of UNDERCROFT_ENTRANCES) {
      expect(deckYAt(e, e.deckTopZ), `${e.id} does not start level`).toBe(UNDERCROFT_SURFACE_Y);
      expect(deckYAt(e, e.deckBottomZ), `${e.id} does not reach the floor`).toBe(UNDERCROFT_FLOOR_Y);
      // Past the bottom it stays on the floor rather than continuing down.
      expect(deckYAt(e, e.deckBottomZ + e.fallDir * 6)).toBe(UNDERCROFT_FLOOR_Y);
    }
    const degrees = (Math.atan2(RAMP_DROP, RAMP_RUN) * 180) / Math.PI;
    expect(degrees).toBeGreaterThan(5);
    // The residences stairwell walks 29.5 degrees in production, so this is
    // comfortably inside what the rig is already known to handle.
    expect(degrees).toBeLessThan(29.5);
  });

  it("takes its step from the rig, not from an assumed frame rate", () => {
    // The number the old gate got wrong. 9 m/s at the rig's own dt clamp.
    expect(UNDERCROFT_STEP).toBeCloseTo(0.45, 10);
    expect(UNDERCROFT_STEP).toBe(UNDERCROFT_SPEED * 0.05);
    // And the scene must actually run at that speed, or the geometry below is
    // sized against a rig that does not exist.
    expect(SCENE, "the scene's speed is not the one the geometry was sized for").toMatch(
      /speed=\{UNDERCROFT_SPEED\}/,
    );
    expect(SCENE, "the scene does not arm the step limit").toMatch(/maxGroundStep=\{UNDERCROFT_MAX_STEP\}/);
    // And the rig must actually spend the scroll out of a frame budget rather
    // than all at once, or `UNDERCROFT_MAX_TRAVEL` describes a rig that is not
    // running. `rigMaxTravelFor` cannot be observed from here — the rig imports
    // three.js — so the wiring is read instead of executed.
    expect(RIG, "the rig no longer bounds a frame's travel").toMatch(
      /const budget = Math\.max\(0, rigMaxTravelFor\(speed\) - move\.current\.length\(\)\)/,
    );
    expect(RIG, "the rig no longer clamps the scroll into that budget").toMatch(
      /clamp\(dolly0, -budget, budget\)/,
    );
    expect(RIG, "the rig discards the unspent scroll instead of carrying it").toMatch(
      /scrollMove\.current -= dolly/,
    );
    expect(RIG, "the rig still spends the whole accumulated scroll in one frame").not.toMatch(
      /const dolly = scrollMove\.current;/,
    );
  });

  it("NEVER TELEPORTS: no reachable frame moves the ground more than the ramp does", () => {
    expectNoTeleport(shippingWorld(), "the Undercroft");
  });

  it("IS A GATE: the same threshold FAILS against the rig before the frame was bounded", () => {
    // The most important assertion in this file. The previous gate surveyed at
    // 0.45 m — walking pace — while the rig would deliver 2.65 m and the armed
    // step limit was derived from that larger number, so the gate policed a
    // frame six times shorter than the one that shipped. Re-pointed at the real
    // movement model it does not merely wobble, it fails by a factor of two.
    expect(PRE_CLAMP_TRAVEL, "the pre-clamp frame was not longer than a walk").toBeGreaterThan(UNDERCROFT_MAX_TRAVEL);
    expect(() => expectNoTeleport(preClampWorld(), "the pre-clamp rig")).toThrow(/moved the ground/);
    // And the failure is the teleport, not the anti-vacuity guards tripping:
    // the same survey still covers the scene, in cells of its own size.
    const survey = surveyReachable(preClampWorld());
    expect(survey.cells, "the pre-clamp survey failed for want of coverage instead").toBeGreaterThan(
      coverageFloor(PRE_CLAMP_TRAVEL),
    );
    expect(survey.highest, "the pre-clamp survey never stood on the surface").toBeGreaterThan(
      UNDERCROFT_SURFACE_Y + UNDERCROFT_EYE - 1e-6,
    );
    expect(survey.lowest, "the pre-clamp survey never reached the concourse").toBeLessThan(
      UNDERCROFT_FLOOR_Y + UNDERCROFT_EYE + 1e-6,
    );
    expect(survey.worstStep, "the pre-clamp rig did not actually teleport").toBeGreaterThan(
      PRE_CLAMP_TRAVEL * (RAMP_DROP / RAMP_RUN),
    );
  });

  it("has no wall thin enough for one frame to step across", () => {
    // WHY THE CAP IS THE WALK STEP AND NOT ONE NOTCH. `resolveObstacles`
    // resolves to whichever side of a box's CENTRE the proposal landed on, so a
    // frame longer than a box's half-span carries the body over the middle and
    // is pushed out the FAR face — through the wall. Capping a notch at the
    // walk step (0.90 m of frame) was not enough: the cutting wall's half-span
    // is 0.80 m and the survey walked a body from the concourse straight onto
    // the side of its own ramp, 0.5023 m of ground in one frame.
    const obs = undercroftObstacles();
    expect(obs.length, "no obstacles — this test would measure nothing").toBeGreaterThan(50);
    for (const o of obs) {
      expect(
        isTunnelProof(o, UNDERCROFT_MAX_TRAVEL),
        `a box at ${o.cx},${o.cz} is ${Math.min(o.hx, o.hz)} half-thick — one frame steps over it`,
      ).toBe(true);
    }
    // The negative half, at the travel the rig used to permit: the same boxes
    // and the same rule find the walls a body genuinely did walk through.
    const leaky = obs.filter((o) => !isTunnelProof(o, PRE_CLAMP_TRAVEL));
    expect(leaky.length, "nothing was tunnellable even at 2.65 m, so this rule proves nothing").toBeGreaterThan(0);
  });

  it("holds a body inside the excavation, even against the wall that pushes outwards", () => {
    // The 154 cells. The outer cutting wall's OUTWARD blocking face lies past
    // `minX`, so the resolver's answer for a body on that side is a position
    // outside the world — and `stepMove` used to return it unexamined.
    const outer = undercroftGuards().find((g) => g.id === "north-cutting-outer")!;
    const face = outer.cx - (outer.hx + OBSTACLE_PAD);
    expect(face, "the fixture wall no longer straddles the bound — re-derive this test").toBeLessThan(
      UNDERCROFT_BOUNDS.minX,
    );
    // The resolver really does send a body there; the clamp is what catches it.
    const pushed = resolveObstacles(UNDERCROFT_BOUNDS.minX, outer.cz, UNDERCROFT_FLOOR_Y + UNDERCROFT_EYE, OBSTACLES);
    expect(pushed.x, "the resolver did not push outwards here").toBeCloseTo(face, 9);

    const survey = surveyReachable(shippingWorld());
    expect(survey.cells).toBeGreaterThan(3000);
    expect(
      survey.outside,
      `a body reached ${survey.outside} cells outside the walls, first at ${JSON.stringify(survey.outsideAt)}`,
    ).toBe(0);
  });

  it("is never off the deck while above the floor", () => {
    // The other half of the same claim: elevation only ever comes from the
    // deck. A body cannot be part-way up an edge, because there is no part-way
    // — the deck is a rectangle and everything else is the concourse.
    const survey = surveyReachable(shippingWorld());
    expect(survey.cells).toBeGreaterThan(3000);
    for (const e of UNDERCROFT_ENTRANCES) {
      // Every square metre of the paving that is DRAWN is deck the body stands
      // on at paving height — the apron plane is exactly `court`, and the ramp
      // plane exactly the sloped part of `shaft`.
      for (let x = e.court.x0; x <= e.court.x1; x += 0.1) {
        for (let z = e.court.z0; z <= e.court.z1; z += 0.1) {
          expect(undercroftGroundHeight(x, z, UNDERCROFT_SURFACE_Y), `drawn paving at ${x},${z} is not deck`).toBe(
            deckYAt(e, z),
          );
        }
      }
    }
  });

  it("walks from each arrival apron all the way down to the concourse", () => {
    for (const e of UNDERCROFT_ENTRANCES) {
      const trail = walk(standAt(e.spawn[0], e.spawn[2], "deck"), e.yaw, 400);
      const start = trail[0]!;
      const end = trail[trail.length - 1]!;
      expect(start.y, `${e.id} does not start at street level`).toBeCloseTo(UNDERCROFT_SURFACE_Y + UNDERCROFT_EYE, 5);
      expect(end.y, `${e.id} never reached the concourse`).toBeCloseTo(UNDERCROFT_FLOOR_Y + UNDERCROFT_EYE, 5);
      // It has to have gone somewhere: a walker wedged against a railing on
      // the first frame would also "end at" a constant height.
      const travelled = Math.abs(end.z - start.z);
      expect(travelled, `${e.id} walker did not move`).toBeGreaterThan(RAMP_RUN);
      // And the descent has to be a descent, not a drop at the end.
      const heights = trail.map((p) => p.y);
      for (let i = 1; i < heights.length; i++) {
        expect(heights[i]! - heights[i - 1]!, `${e.id} climbed while walking down`).toBeLessThanOrEqual(1e-9);
      }
      // The descent has to happen GRADUALLY. A trapdoor would also start high
      // and end low and would also never climb, so the thing that separates a
      // ramp from a hole is the number of frames spent part-way down.
      const midway = trail.filter(
        (p) => p.y < UNDERCROFT_SURFACE_Y + UNDERCROFT_EYE - 0.5 && p.y > UNDERCROFT_FLOOR_Y + UNDERCROFT_EYE + 0.5,
      );
      expect(midway.length, `${e.id} has no midway height — it is a cliff, not a ramp`).toBeGreaterThan(20);
    }
  });

  it("gets a visitor from the north ramp into the shopping corridor", () => {
    // The whole point of arriving: reaching the units. Three legs, because the
    // ramp lands in the lobby beside the hall rather than inside it.
    const e = UNDERCROFT_ENTRANCES[0]!;
    const down = walkUntil(standAt(e.spawn[0], e.spawn[2], "deck"), e.yaw, (p) => p.z > e.shaft.z1 + 0.6);
    expect(down.reached, "never walked out of the cutting into the lobby").toBe(true);
    expect(down.at.y).toBeCloseTo(UNDERCROFT_FLOOR_Y + UNDERCROFT_EYE, 5);
    const across = walkUntil(down.at, -Math.PI / 2, (p) => Math.abs(p.x) < 1);
    expect(across.reached, "did not cross the lobby to the corridor centreline").toBe(true);
    const south = walkUntil(across.at, 0, (p) => p.z < -2);
    expect(south.reached, "never got south into the unit rows").toBe(true);
    const end = south.at;
    expect(end.y).toBeCloseTo(UNDERCROFT_FLOOR_Y + UNDERCROFT_EYE, 5);
    // And it is genuinely a corridor: the unit line is on both sides of it.
    const nearest = undercroftSlots()
      .map((s) => Math.hypot(s.position[0] - end.x, s.position[2] - end.z))
      .sort((a, b) => a - b)[0]!;
    expect(nearest, "ended up nowhere near a unit").toBeLessThan(12);
  });
});

/* ------------------------------------------------------ the transition band */

describe("the deck's edge holds", () => {
  it("blocks with a window that comfortably exceeds a frame of travel", () => {
    // WHAT WENT WRONG THE FIRST TIME, stated as a measurement. Each rail and
    // each rock wall exists to keep a body inside a deck edge; the distance
    // between the point it stops the body and the point the deck runs out is
    // the window. It was 4.33 cm against a 45 cm frame.
    const guards = undercroftGuards().filter((g) => g.guards);
    expect(guards.length, "no guards — this test would measure nothing").toBeGreaterThan(7);
    for (const g of guards) {
      const gd = g.guards!;
      const half = gd.axis === "x" ? g.hx : g.hz;
      const centre = gd.axis === "x" ? g.cx : g.cz;
      const face = centre + gd.inward * (half + 0.5);
      const window = Math.abs(face - gd.edge);
      expect(window, `${g.id} blocks over ${window.toFixed(4)} m`).toBeGreaterThanOrEqual(UNDERCROFT_STEP * 1.5);
      expect(window, `${g.id}'s window is not the one it was designed with`).toBeCloseTo(DECK_CLEARANCE, 9);
      // And the face has to be INSIDE the deck: a rail that stops you where
      // the ground has already gone is not a rail.
      expect(
        (face - gd.edge) * gd.inward,
        `${g.id} stops the body outside the deck it guards`,
      ).toBeGreaterThan(0);
    }
  });

  it("keeps a body on the apron whatever direction they hold (both aprons)", () => {
    for (const e of UNDERCROFT_ENTRANCES) {
      let wentDown = 0;
      let stayedUp = 0;
      for (let i = 0; i < 16; i++) {
        const yaw = (i * Math.PI) / 8;
        const trail = walk(standAt(e.spawn[0], e.spawn[2], "deck"), yaw, 200);
        let left = false;
        for (let k = 0; k < trail.length; k++) {
          const p = trail[k]!;
          const deck = undercroftDeckY(p.x, p.z);
          if (deck === null) {
            // The one legitimate way off the deck is out of the bottom of the
            // cutting, where the deck IS the floor. Anywhere else is a fall.
            if (!left) {
              const prev = trail[k - 1]!;
              expect(
                undercroftDeckY(prev.x, prev.z),
                `${e.id} yaw ${i}: walked off the deck at ${p.x.toFixed(2)},${p.z.toFixed(2)}`,
              ).toBeCloseTo(UNDERCROFT_FLOOR_Y, 6);
              left = true;
            }
            expect(p.y, `${e.id} yaw ${i}: not on the concourse after leaving the deck`).toBeCloseTo(
              UNDERCROFT_FLOOR_Y + UNDERCROFT_EYE,
              6,
            );
            continue;
          }
          expect(p.y, `${e.id} yaw ${i}: standing off the deck surface`).toBeCloseTo(deck + UNDERCROFT_EYE, 6);
          // And while still over the apron itself, you are on it — full stop.
          if (insideRect(p.x, p.z, e.court)) {
            expect(p.y, `${e.id} yaw ${i}: fell off the apron at ${p.x.toFixed(2)},${p.z.toFixed(2)}`).toBeCloseTo(
              UNDERCROFT_SURFACE_Y + UNDERCROFT_EYE,
              6,
            );
          }
        }
        const end = trail[trail.length - 1]!;
        if (end.y < UNDERCROFT_SURFACE_Y + UNDERCROFT_EYE - 0.5) {
          // The only way down is the ramp: either still on it, or out of the
          // bottom of the cutting and standing on the concourse.
          const viaRamp =
            insideRect(end.x, end.z, e.shaft) ||
            Math.abs(end.y - (UNDERCROFT_FLOOR_Y + UNDERCROFT_EYE)) < 1e-6;
          expect(viaRamp, `${e.id} yaw ${i} descended outside the cutting`).toBe(true);
          wentDown++;
        } else {
          stayedUp++;
        }
      }
      // Anti-vacuity both ways: the apron is not a sealed box (you can reach
      // the ramp) and it is not an open ledge (most headings keep you up).
      expect(wentDown, `${e.id}: no heading reaches the ramp — the apron is sealed`).toBeGreaterThan(0);
      expect(stayedUp, `${e.id}: too many headings leave the apron`).toBeGreaterThan(8);
    }
  });

  it("will not let a concourse walker climb out from under an apron", () => {
    // The two-way escalator, reproduced. A shopper on the concourse squeezes
    // between two units, ends up under the arrival apron, and — before the
    // terrain knew which storey they were on — the ground under them was the
    // APRON's, six metres up, so the next frame put them on the surface.
    for (const e of UNDERCROFT_ENTRANCES) {
      const midX = (e.court.x0 + e.court.x1) / 2;
      const midZ = (e.court.z0 + e.court.z1) / 2;
      const starts: Array<[number, number]> = [
        [midX, midZ],
        [e.side < 0 ? e.court.x1 - 0.2 : e.court.x0 + 0.2, midZ],
        [midX, e.fallDir > 0 ? e.court.z1 - 0.2 : e.court.z0 + 0.2],
      ];
      for (const [sx, sz] of starts) {
        const from = standAt(sx, sz, "floor");
        expect(from.y, `${e.id}: the fixture did not start on the concourse`).toBeCloseTo(
          UNDERCROFT_FLOOR_Y + UNDERCROFT_EYE,
          6,
        );
        for (let i = 0; i < 16; i++) {
          const trail = walk(from, (i * Math.PI) / 8, 60);
          for (const p of trail) {
            expect(
              p.y,
              `${e.id}: a concourse walker rose to ${p.y.toFixed(2)} at ${p.x.toFixed(2)},${p.z.toFixed(2)}`,
            ).toBeLessThanOrEqual(UNDERCROFT_FLOOR_Y + UNDERCROFT_EYE + 1e-9);
          }
        }
      }
    }
  });

  it("draws the paving it can be stood on, and draws it from both sides", () => {
    // The apron and the ramp are the only two surfaces a visitor stands on up
    // here, and a visitor on the concourse is UNDERNEATH both of them. A
    // single-sided plane is simply absent when looked at from below, which is
    // an apron that vanishes and a hole in the ceiling that is not there.
    const planes = SCENE.match(/side=\{DoubleSide\}/g) ?? [];
    expect(planes.length, "the apron and ramp are not drawn from beneath").toBeGreaterThanOrEqual(2);
    // Drawn extent == the deck rectangle, which is what makes the two agree.
    expect(SCENE).toMatch(/planeGeometry args=\{\[courtW, courtD\]\}/);
    expect(SCENE).toMatch(/const courtW = court\.x1 - court\.x0;/);
    expect(SCENE).toMatch(/const courtD = court\.z1 - court\.z0;/);
  });

  it("scopes the railings to the surface and the rock to everything", () => {
    let rails = 0;
    let rock = 0;
    let fills = 0;
    for (const g of undercroftGuards()) {
      if (g.kind === "rail") {
        rails++;
        expect(g.band, `${g.id} is not scoped to the surface`).toEqual(SURFACE_BAND);
        // And its band must still be live where it stops you: the defect was a
        // rail whose band expired 4 cm before the rail did.
        const gd = g.guards!;
        const half = gd.axis === "x" ? g.hx : g.hz;
        const centre = gd.axis === "x" ? g.cx : g.cz;
        const face = centre + gd.inward * (half + 0.5);
        const at = gd.axis === "x" ? { x: face, z: g.cz } : { x: g.cx, z: face };
        const eye = undercroftGroundHeight(at.x, at.z, UNDERCROFT_SURFACE_Y) + UNDERCROFT_EYE;
        expect(eye, `${g.id}'s band is dead where it blocks`).toBeGreaterThanOrEqual(SURFACE_BAND.yMin);
      } else if (g.kind === "rock") {
        rock++;
        expect(g.band, `${g.id} is rock and should be solid at every elevation`).toBeUndefined();
      } else {
        fills++;
        // The bulkhead under the ramp head. Solid to a shopper on the
        // concourse, thin air to the body walking over it at street level.
        expect(g.band?.yMax, `${g.id} is not scoped to the concourse`).toBe(UNDERCROFT_CEILING_Y);
        const overhead = undercroftGroundHeight(g.cx, g.cz, UNDERCROFT_SURFACE_Y) + UNDERCROFT_EYE;
        expect(overhead, `${g.id} blocks the ramp it sits under`).toBeGreaterThan(UNDERCROFT_CEILING_Y);
      }
    }
    expect([rails, rock, fills], "a guard kind vanished").toEqual([6, 4, 2]);
  });
});

/* ------------------------------------------------------------ street mouths */

/** The street's own obstacle table, built from the same helpers the scene uses. */
function streetFurniture(storeCount: number) {
  const agents = Array.from({ length: storeCount }, (_, i) => ({ slug: `shop-${i}` }));
  const streetDepth = streetDepthFor(storeCount);
  const BOARD = { hx: 1.15, hz: 0.35 };
  return [
    ...layoutFor(agents).map((l) => ({ id: `shop`, cx: l.position[0], cz: l.position[2], hx: 1.6, hz: 1.7 })),
    { id: "tower", cx: 0, cz: streetDepth - 20, hx: 7.8, hz: 7.8 },
    { id: "board-n", cx: -3.6, cz: 15.5, ...BOARD },
    { id: "board-w", cx: -6.2, cz: -12, hx: BOARD.hz, hz: BOARD.hx },
    { id: "board-e", cx: 6.2, cz: -30, hx: BOARD.hz, hz: BOARD.hx },
    { id: "monument", cx: 0, cz: monumentZFor(storeCount), hx: 1.2, hz: 1.2 },
    { id: "arcade", cx: -PLAZA_FLANK_X, cz: plazaZFor(storeCount), ...venueFootprint("arcade") },
    { id: "bank", cx: PLAZA_FLANK_X, cz: plazaZFor(storeCount), ...venueFootprint("bank") },
    { id: "residences", cx: 12.5, cz: 3, ...venueFootprint("residences") },
    { id: "joinery", cx: -12.5, cz: 3, ...venueFootprint("joinery") },
    { id: "scada", cx: 17.6, cz: -8.5, ...venueFootprint("scada") },
    { id: "cafe", cx: -17.6, cz: -18.4, hx: 3.9, hz: 3.3 },
  ];
}

/** Everything solid on the street, in the shape the rig takes it. */
function streetObstacles(storeCount: number): FpsObstacle[] {
  const mouth = venueFootprint("undercroft");
  return [
    ...streetFurniture(storeCount).map((o) => ({ cx: o.cx, cz: o.cz, hx: o.hx, hz: o.hz })),
    ...streetMouthsFor(storeCount).map((m) => ({ cx: m.x, cz: m.z, ...mouth })),
  ];
}

/** The street rig's own walls, from `marketplace-3d.tsx`. */
function streetBounds(storeCount: number): FpsBounds {
  const towerZ = streetDepthFor(storeCount) - 20;
  return { minX: -20.5, maxX: 20.5, minZ: towerZ - 12, maxZ: 15, minY: 1.55, maxY: 28 };
}

/** How far the resolver shoves a body standing here. Zero is the only pass. */
function pushAt(x: number, z: number, y: number, obstacles: FpsObstacle[]): number {
  const r = resolveObstacles(x, z, y, obstacles);
  return Math.hypot(r.x - x, r.z - z);
}

function overlaps(
  a: { cx: number; cz: number; hx: number; hz: number },
  b: { cx: number; cz: number; hx: number; hz: number },
): boolean {
  return Math.abs(a.cx - b.cx) < a.hx + b.hx && Math.abs(a.cz - b.cz) < a.hz + b.hz;
}

describe("the street mouths stand where nothing else does", () => {
  const COUNTS = [24, 28, 32, 36, 40, 44, 48];
  /**
   * The counts the street can actually be asked to draw, not just the ones it
   * is usually asked to draw.
   *
   * 0, 1 and 2 are an empty database and a degraded `/marketplace/combined`,
   * and at all three of them `streetDepthFor` bottoms out at -6.5 and brings
   * the plaza up to meet the near end. The previous sweep started at 24, so a
   * north mouth sitting inside the Arcade — the only way down within walking
   * distance of the entrance — was outside everything CI looked at.
   */
  const ALL_COUNTS = [0, 1, 2, 3, 4, 6, 8, 12, 16, 20, ...COUNTS];

  it("has mouths to check", () => {
    // Vacuity guard. Nothing imported `STREET_MOUTHS` at all before today,
    // which is how a hard-coded z survived beside four structures that all
    // derive theirs from the store count.
    for (const n of ALL_COUNTS) {
      const mouths = streetMouthsFor(n);
      expect(mouths.length).toBe(2);
      expect(mouths.map((m) => m.id)).toEqual(["north", "south"]);
    }
  });

  it("puts the far mouth at the street's far end, wherever that ends up", () => {
    // A literal -100 while the street's end moves is a structure that drifts
    // into whatever happens to be there. At forty storefronts it stood inside
    // Resonance Trust; below twenty-nine it stood outside the rig's own
    // movement clamp, unreachable.
    const seen = new Set<number>();
    for (const n of COUNTS) seen.add(streetMouthsFor(n)[1]!.z);
    expect(seen.size, "the far mouth does not move with the street").toBe(COUNTS.length);
    for (const n of COUNTS) {
      const z = streetMouthsFor(n)[1]!.z;
      expect(z).toBe(streetDepthFor(n) + 3);
      // Inside the rig's clamp: minZ = towerZ - 12 = streetDepth - 32.
      expect(z, `at ${n} shops the far mouth is outside the movement clamp`).toBeGreaterThan(streetDepthFor(n) - 32);
      expect(z).toBeLessThan(15);
    }
  });

  it("stands off the alley's prop lane, not on it", () => {
    // The structural reason it is safe at EVERY store count, not just the ones
    // enumerated below: everything `BackAlley` puts in an alley sits on the
    // shop side of the centreline, and both mouths sit on the other side.
    for (const m of streetMouthsFor(48)) {
      const outFromAlley = Math.abs(m.x) - ALLEY_X;
      expect(outFromAlley, "a mouth is on the shop side of the alley").toBeGreaterThan(0);
      const half = venueFootprint("undercroft").hx;
      expect(
        Math.abs(m.x) - half,
        "a mouth's footprint reaches into the alley's prop lane",
      ).toBeGreaterThan(ALLEY_X - ALLEY_PROP_LANE.near);
    }
  });

  it("keeps the near mouth clear of the Arcade however short the street gets", () => {
    // The plaza comes up the street as the street shortens, and below three
    // storefronts it arrives on top of the north mouth. The clamp is asserted
    // both ways: it fires where it must, and it is inert everywhere else.
    const arcade = venueFootprint("arcade");
    const mouth = venueFootprint("undercroft");
    let clamped = 0;
    for (const n of ALL_COUNTS) {
      const z = northMouthZFor(n);
      const gap = Math.abs(z - plazaZFor(n));
      expect(gap, `${n}: the near mouth is inside the Arcade`).toBeGreaterThan(arcade.hz + mouth.hz);
      if (z !== NORTH_MOUTH_Z) clamped++;
    }
    expect(clamped, "the clamp never fired, so nothing here is being tested").toBeGreaterThan(0);
    // …and it is the SHORT street it fires on, not the shipping one.
    for (const n of COUNTS) expect(northMouthZFor(n), `${n}: the near mouth moved on a full street`).toBe(NORTH_MOUTH_Z);
    // The negative half: without the clamp, the literal really does collide.
    expect(
      Math.abs(NORTH_MOUTH_Z - plazaZFor(0)),
      "the bare literal is clear of the Arcade at zero storefronts, so the clamp guards nothing",
    ).toBeLessThan(arcade.hz + mouth.hz);
  });

  it("overlaps no venue, no shopfront and no alley prop, at any store count", () => {
    const mouth = venueFootprint("undercroft");
    // The production street's alley is fully populated; a two-storefront street
    // has a two-prop alley, and demanding nine of it would only ever be a way
    // of not testing the short street at all.
    expect(alleyProps(streetDepthFor(48)).length * 2, "the production alley is bare").toBeGreaterThan(8);
    for (const n of ALL_COUNTS) {
      const furniture = streetFurniture(n);
      expect(furniture.length, `${n}: nothing to collide with`).toBeGreaterThan(n);
      const props = [
        ...alleyProps(streetDepthFor(n)).map((p) => ({ id: `alley-w-${p.kind}@${p.z}`, ...alleyPropFootprint(p, -1) })),
        ...alleyProps(streetDepthFor(n)).map((p) => ({ id: `alley-e-${p.kind}@${p.z}`, ...alleyPropFootprint(p, 1) })),
      ];
      expect(props.length, `${n}: no alley props`).toBeGreaterThanOrEqual(4);
      for (const m of streetMouthsFor(n)) {
        const box = { cx: m.x, cz: m.z, ...mouth };
        for (const other of [...furniture, ...props]) {
          expect(
            overlaps(box, other),
            `${n} shops: the ${m.id} mouth at (${m.x}, ${m.z}) overlaps ${other.id} at (${other.cx}, ${other.cz})`,
          ).toBe(false);
        }
      }
      // And the two mouths must not overlap each other.
      const [a, b] = streetMouthsFor(n);
      expect(overlaps({ cx: a!.x, cz: a!.z, ...mouth }, { cx: b!.x, cz: b!.z, ...mouth })).toBe(false);
    }
  });

  it("catches a mouth that IS on top of something", () => {
    // The negative half. Without this the overlap test could be green because
    // `overlaps` is broken rather than because the mouths moved.
    const mouth = venueFootprint("undercroft");
    const props = alleyProps(streetDepthFor(48)).map((p) => alleyPropFootprint(p, -1));
    const onTop = { cx: props[1]!.cx, cz: props[1]!.cz, ...mouth };
    expect(overlaps(onTop, props[1]!), "the overlap check does not detect an overlap").toBe(true);
  });
});

/* --------------------------------------------------- coming back up the ramp */

describe("stepping back out onto the street", () => {
  const COUNTS = [0, 1, 2, 3, 8, 24, 48];

  it("stands the returning body in the alley, not inside the kiosk it came out of", () => {
    for (const n of COUNTS) {
      const m = streetMouthsFor(n)[0]!;
      const spawn = streetReturnSpawn(m);
      const [sx, sy, sz] = spawn.position;
      const obstacles = streetObstacles(n);

      // THE MEASUREMENT, through the resolver the rig actually runs. Not
      // arithmetic about how far apart two numbers are: the shipped spawn was
      // 1.4 m from the mouth's centre and the comment above it said it was
      // clear of the mouth, so the arithmetic was never the problem.
      expect(pushAt(sx, sz, sy, obstacles), `${n}: the return spawn is inside something solid`).toBe(0);

      // Clear of the prop lane too — the constraint that makes the x axis
      // unusable and is the reason the clearance is bought along z.
      const inward = ALLEY_X - Math.abs(sx);
      expect(inward, `${n}: the return spawn is in the alley's prop lane`).toBeLessThan(ALLEY_PROP_LANE.near);
      // …and still in the alley rather than out in the skyline blocks.
      expect(Math.abs(sx), `${n}: the return spawn is not in the alley`).toBeLessThan(ALLEY_X + 3.1);

      // And reachable: the rig clamps to its own bounds on the first frame, so
      // a spawn outside them is a spawn somewhere else.
      const b = streetBounds(n);
      expect(sx >= b.minX && sx <= b.maxX, `${n}: the return spawn is outside the movement clamp in x`).toBe(true);
      expect(sz >= b.minZ && sz <= b.maxZ, `${n}: the return spawn is outside the movement clamp in z`).toBe(true);

      // Facing the way back in, like every other door in the city.
      const look = { x: -Math.sin(spawn.yaw), z: -Math.cos(spawn.yaw) };
      const toMouth = { x: m.x - sx, z: m.z - sz };
      const len = Math.hypot(toMouth.x, toMouth.z);
      expect((look.x * toMouth.x + look.z * toMouth.z) / len, `${n}: the visitor surfaces facing away from the ramp`)
        .toBeGreaterThan(0.5);
    }
  });

  it("catches the spawn that shipped, which was 0.80 m inside the mouth", () => {
    // The negative half, and the actual defect. Without it the test above could
    // be green because `resolveObstacles` stopped pushing rather than because
    // the spawn moved.
    const n = 48;
    const m = streetMouthsFor(n)[0]!;
    const obstacles = streetObstacles(n);
    const shipped = pushAt(m.x + 1.4, m.z, UNDERCROFT_EYE, obstacles);
    expect(shipped, "the spawn that shipped is not inside the mouth after all").toBeCloseTo(0.8, 6);
    // And the offset the comment implied — out along x, clear of the box —
    // lands in the prop lane, which is why the fix went the other way.
    const half = venueFootprint("undercroft").hx;
    const alongX = Math.abs(m.x) - (half + OBSTACLE_PAD + 0.4);
    expect(pushAt(-alongX, m.z, UNDERCROFT_EYE, obstacles), "the x-axis spawn is not clear of the mouth").toBe(0);
    expect(ALLEY_X - alongX, "there is room on the x axis after all — re-derive the fix").toBeGreaterThan(
      ALLEY_PROP_LANE.near,
    );
  });

  it("is the spawn the street actually uses", () => {
    // `marketplace-3d.tsx` imports three.js, so this is the only way to know
    // the scene reads the derived spawn rather than keeping its own literal —
    // which is exactly the shape the defect had.
    expect(STREET, "the street no longer uses the derived return spawn").toMatch(
      /setSpawn\(streetReturnSpawn\(streetMouths\[0\]!\)\)/,
    );
    expect(STREET, "a literal return-spawn offset came back").not.toMatch(/position: \[m\.x \+ [\d.]+/);
  });
});

/* ------------------------------------------------------------- the presence */

describe("the Undercroft draws the people in it", () => {
  it("puts remote bodies on the concourse floor, not at zero", () => {
    // `VenuePresence` defaults `y` to 0 and places every body at [rx, y, rz].
    // The floor down here is at -6 and the ceiling at -2.4, so an unset `y`
    // puts every visitor six metres up, inside the rock, behind an opaque
    // ceiling — the room reads as empty, which is #300 exactly.
    const presence = readFileSync(join(here, "..", "components", "presence.tsx"), "utf8");
    expect(presence, "VenuePresence no longer defaults y to 0 — re-derive this test").toMatch(/y = 0,/);
    expect(UNDERCROFT_FLOOR_Y, "the floor is at zero, so this test proves nothing").not.toBe(0);
    expect(UNDERCROFT_FLOOR_Y).toBeLessThan(UNDERCROFT_CEILING_Y);
    // The mount must pass the floor's elevation. Asserting the ELEVATION, not
    // the room string: `rooms.test.ts` already greps for `room="undercroft"`,
    // and that guard stayed green through the whole of this bug.
    const mount = SCENE.match(/<VenuePresence[^/]*\/>/s);
    expect(mount, "the Undercroft mounts no VenuePresence at all").not.toBeNull();
    expect(mount![0], "VenuePresence is mounted without the floor's elevation").toMatch(
      /y=\{UNDERCROFT_FLOOR_Y\}/,
    );
  });
});

/* ------------------------------------------------------------- the shopfront */

describe("an occupied unit is not advertised as vacant", () => {
  it("gives a dormant store that holds work the works card, not FOR LEASE", () => {
    const units = rankUndercroft(remainder());
    expect(units.length, "no units — this test would pass over nothing").toBe(MAX_UNDERCROFT_UNITS);
    const withWork = units.filter((u) => !u.claimed && u.artifacts >= THIN_STOREFRONT_ARTIFACTS);
    expect(withWork.length, "the Undercroft holds no dormant store with work, so nothing is proved").toBeGreaterThan(10);
    for (const u of withWork) {
      expect(storefrontWindowCard(u), `${u.slug} (${u.artifacts} artifacts) was called vacant`).toBe(
        "unclaimed-with-works",
      );
    }
  });

  it("still says FOR LEASE about a genuinely thin one", () => {
    // The other half. A predicate that never says for-lease is not fixed, it
    // is broken the other way.
    expect(
      storefrontWindowCard({ claimed: false, source: "obc", artifacts: 0 }),
      "an empty unit stopped advertising",
    ).toBe("for-lease");
  });

  it("lets the scene decide with the street's predicate, not its own", () => {
    // The bug #302 fixed was a second copy of the rule. The scene must ask
    // `storefrontWindowCard` and must not re-derive vacancy from `claimed`.
    const code = SCENE.split(/\r?\n/)
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    // `toContain("storefrontWindowCard")` is NOT enough and this was caught by
    // trying it: the import line alone satisfies it, so replacing the call
    // with `unit.claimed ? "none" : "for-lease"` — the exact #302 bug — left
    // the guard green. What has to be asserted is that the card is ASSIGNED
    // from the shared predicate.
    expect(code, "the Undercroft does not derive its window card from storefrontWindowCard").toMatch(
      /=\s*storefrontWindowCard\(/,
    );
    expect(code).toContain("FOR LEASE");
    // Every FOR LEASE in the scene must be gated on the card, not on claim.
    for (const m of code.matchAll(/FOR LEASE/g)) {
      const before = code.slice(Math.max(0, m.index - 400), m.index);
      expect(before, "a FOR LEASE card that is not gated on the window card").toMatch(/["']for-lease["']/);
    }
    // And no second copy of the rule anywhere: claim status must never be the
    // thing that decides vacancy, in a ternary or in a guard.
    expect(code, "vacancy re-derived from claim status").not.toMatch(/claimed\s*\?[^;]{0,80}for-lease/);
    expect(code, "vacancy re-derived from claim status").not.toMatch(/!\s*[\w.]*claimed[^;]{0,80}for-lease/i);
  });
});

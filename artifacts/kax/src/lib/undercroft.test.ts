/**
 * undercroft.test.ts — the parts of a second storey that a screenshot cannot check.
 *
 * Four things are asserted here and each one is a bug that has already happened
 * once in this codebase:
 *
 *   · THE ORDER IS TOTAL. The street's 48-cut once landed inside a tie, which
 *     made "which buildings exist" a fact about the query plan (#303). A
 *     second cut, one storey down, is the same bug waiting to be re-shipped.
 *   · THE DECLINE IS WALKABLE. The rig has no gravity, no step clamp and no
 *     slope limit — `ny = groundHeight(nx,nz) + eyeHeight` is an outright
 *     assignment — so a bad terrain function does not fail, it teleports. The
 *     walk below is a real simulation of the rig's own per-frame loop.
 *   · A UNIT WITH WORK IS NOT ADVERTISED AS VACANT. #302 fixed exactly that
 *     upstairs; 278 of 302 storefronts are unclaimed and every one of them
 *     holds work.
 *   · NOTHING HERE PROVES ANYTHING ABOUT AN EMPTY SET. Every loop asserts its
 *     input is non-empty first. `storefrontRecency.test.ts` records the day a
 *     loop over zero rows passed while the code under test had been deleted.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveObstacles } from "./fps-collision";
import { storefrontWindowCard, THIN_STOREFRONT_ARTIFACTS } from "./storefront-window";
import {
  MAX_UNDERCROFT_UNITS,
  RAMP_DROP,
  RAMP_RUN,
  UNDERCROFT_BOUNDS,
  UNDERCROFT_ENTRANCES,
  UNDERCROFT_EYE,
  UNDERCROFT_FLOOR_Y,
  UNDERCROFT_SURFACE_Y,
  compareUndercroft,
  deckYAt,
  rankUndercroft,
  undercroftGroundHeight,
  undercroftObstacles,
  undercroftSlots,
  type UndercroftCandidate,
} from "./undercroft";

const here = dirname(fileURLToPath(import.meta.url));
const SCENE = readFileSync(join(here, "..", "pages", "undercroft.tsx"), "utf8");

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

/* -------------------------------------------------------------- the decline */

/**
 * The rig's own per-frame loop, in the same order it runs in.
 *
 * Terrain snap at the top of the frame (first-person-rig.tsx:206-208), then
 * the ground-plane move, then the bounds clamp, then terrain again (which
 * discards `bounds.minY`), then collision. Reproduced rather than approximated
 * — a walk test against a tidied-up version of the movement code would be
 * testing the tidy version.
 */
function walk(from: readonly [number, number], yaw: number, frames: number, speed = 9) {
  const obs = undercroftObstacles();
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const dt = 0.05;
  let x = from[0];
  let z = from[1];
  let y = undercroftGroundHeight(x, z) + UNDERCROFT_EYE;
  const trail: Array<{ x: number; y: number; z: number }> = [{ x, y, z }];
  for (let i = 0; i < frames; i++) {
    y = undercroftGroundHeight(x, z) + UNDERCROFT_EYE;
    let nx = x + fx * speed * dt;
    let nz = z + fz * speed * dt;
    nx = Math.min(Math.max(nx, UNDERCROFT_BOUNDS.minX), UNDERCROFT_BOUNDS.maxX);
    nz = Math.min(Math.max(nz, UNDERCROFT_BOUNDS.minZ), UNDERCROFT_BOUNDS.maxZ);
    const ny = undercroftGroundHeight(nx, nz) + UNDERCROFT_EYE;
    const hit = resolveObstacles(nx, nz, ny, obs);
    x = hit.x;
    z = hit.z;
    y = ny;
    trail.push({ x, y, z });
  }
  return trail;
}

/** Walk holding W until something is true, the way the headless rig does. */
function walkUntil(
  from: readonly [number, number],
  yaw: number,
  pred: (p: { x: number; y: number; z: number }) => boolean,
  maxFrames = 400,
) {
  const trail = walk(from, yaw, maxFrames);
  const at = trail.findIndex(pred);
  return { trail, reached: at >= 0, at: trail[at >= 0 ? at : trail.length - 1]! };
}

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

  it("never steps — the terrain is continuous, so the camera cannot teleport", () => {
    // The rig assigns y outright from this function every frame. A jump in it
    // is a jump cut, not a fall, and it is invisible in a still screenshot.
    let worst = 0;
    const step = 0.05;
    for (let z = UNDERCROFT_BOUNDS.minZ; z <= UNDERCROFT_BOUNDS.maxZ; z += step) {
      for (const x of [-12.5, -10.7, -9.2, -8.6, -6, -3.8, 0, 3.8, 6, 8.6, 9.2, 10.7, 12.5]) {
        const d = Math.abs(undercroftGroundHeight(x, z) - undercroftGroundHeight(x, z - step));
        if (d > worst) worst = d;
      }
    }
    for (let x = UNDERCROFT_BOUNDS.minX; x <= UNDERCROFT_BOUNDS.maxX; x += step) {
      for (const z of [-136, -110, -106, -102, -8, -4, 0, 12, 24]) {
        const d = Math.abs(undercroftGroundHeight(x, z) - undercroftGroundHeight(x - step, z));
        if (d > worst) worst = d;
      }
    }
    // A 6-metre drop over the 0.8-metre blend is the steepest thing here, so
    // 0.05 of travel can lift the ground by at most ~0.38. Anything above that
    // is a cliff nobody put there on purpose.
    expect(worst, "the terrain has a step in it").toBeLessThan(0.4);
  });

  it("walks from each arrival apron all the way down to the concourse", () => {
    for (const e of UNDERCROFT_ENTRANCES) {
      const trail = walk([e.spawn[0], e.spawn[2]], e.yaw, 400);
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
    const down = walkUntil([e.spawn[0], e.spawn[2]], e.yaw, (p) => p.z > e.deckBottomZ + 1);
    expect(down.reached, "never reached the foot of the ramp").toBe(true);
    const across = walkUntil([down.at.x, down.at.z], -Math.PI / 2, (p) => Math.abs(p.x) < 1);
    expect(across.reached, "did not cross the lobby to the corridor centreline").toBe(true);
    const south = walkUntil([across.at.x, across.at.z], 0, (p) => p.z < -2);
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

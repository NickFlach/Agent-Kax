import { describe, expect, it } from "vitest";
import {
  createBody,
  step,
  facing,
  CONVERSE_DIST,
  PERSONAL_SPACE,
  ATTEND_MS,
  PURSUE_MS,
  GREET_MS,
  NOTICE_RANGE,
  type CityBody,
  type Neighbour,
  type Pose,
} from "./cityBody";

/**
 * Behaviour tests, not shape tests. Each states something a person watching
 * the city could see, and fails if the body stops doing it — "agents feel
 * human" is only worth claiming if something checks it when nobody is looking.
 */

const BEAT = 0.9;

/**
 * The renderer's convention, spelled out here rather than imported.
 *
 * An expectation computed by calling the function under test proves only that
 * the function agrees with itself: an earlier draft of these tests flipped
 * along with a broken facing() and stayed green. Writing the rule out
 * independently is what makes them notice.
 */
function expectedYaw(fromX: number, fromZ: number, toX: number, toZ: number): number {
  return Math.atan2(toX - fromX, toZ - fromZ);
}

/** Run n ticks against a fixed room. Speech is delivered on the first tick only. */
function run(
  body: CityBody,
  { others = [], heard = [], ticks = 1, t0 = 1_000_000 }: {
    others?: Neighbour[];
    heard?: { principal: string; name: string }[];
    ticks?: number;
    t0?: number;
  } = {},
): Pose {
  let p!: Pose;
  for (let i = 0; i < ticks; i++) {
    p = step(body, { others, heard: i === 0 ? heard : [], now: t0 + i * BEAT * 1000, dt: BEAT });
  }
  return p;
}

const nick = (over: Partial<Neighbour> = {}): Neighbour => ({
  principal: "kax:user:nick",
  name: "Nick",
  x: 10,
  z: 0,
  ...over,
});

const spoke = [{ principal: "kax:user:nick", name: "Nick" }];

describe("cityBody", () => {
  it("faces +Z at yaw 0, matching the renderer", () => {
    // WandererNpc turns to 0 walking toward +Z and PlayerAvatar derives its
    // heading as atan2(dir.x, dir.z). Anything else draws people looking the
    // wrong way, which is exactly how the presence bug shipped.
    expect(facing(0, 0, 0, 5)).toBeCloseTo(0, 9);
    expect(facing(0, 0, 5, 0)).toBeCloseTo(Math.PI / 2, 9);
    expect(facing(0, 0, 0, -5)).toBeCloseTo(Math.PI, 9);
  });

  it("walks over and stops in front of whoever spoke", () => {
    const body = createBody({ centre: { x: 0, z: 0 }, radius: 6, self: "kax:agent:k" });
    const them = nick();
    const p = run(body, { others: [them], heard: spoke, ticks: 15 });

    const d = Math.hypot(them.x - p.x, them.z - p.z);
    expect(p.mode).toBe("listen");
    expect(d).toBeLessThanOrEqual(CONVERSE_DIST + 0.35);
    expect(d).toBeGreaterThanOrEqual(PERSONAL_SPACE);
    expect(p.yaw).toBeCloseTo(expectedYaw(p.x, p.z, them.x, them.z), 3);
  });

  it("does not barge into someone already standing on top of it", () => {
    const body = createBody({ self: "kax:agent:k" });
    const them = nick({ x: 0.3, z: 0.2 });
    const p = run(body, { others: [them], heard: spoke, ticks: 20 });
    expect(Math.hypot(them.x - p.x, them.z - p.z)).toBeGreaterThanOrEqual(PERSONAL_SPACE - 0.2);
  });

  it("is still listening when it arrives from right across the district", () => {
    // The silence timer used to start when somebody SPOKE, so a twenty-metre
    // walk consumed nearly all of it and the body arrived and turned straight
    // back around. It reads as being snubbed.
    const body = createBody({ centre: { x: 0, z: 0 }, radius: 6, self: "kax:agent:k" });
    const them = nick({ x: 20, z: 0 });
    const p = run(body, { others: [them], heard: spoke, ticks: 22 });
    expect(p.mode).toBe("listen");
    expect(Math.hypot(them.x - p.x, them.z - p.z)).toBeLessThanOrEqual(CONVERSE_DIST + 0.35);
  });

  it("will not be led on a chase forever", () => {
    const body = createBody({ self: "kax:agent:k" });
    let p!: Pose;
    for (let i = 0; i < 60; i++) {
      p = step(body, {
        others: [nick({ x: 8 + i * 1.3, z: 0 })],
        heard: i === 0 ? spoke : [],
        now: 1_000_000 + i * 900,
        dt: BEAT,
      });
    }
    expect(p.mode).not.toBe("approach");
    expect(PURSUE_MS).toBeGreaterThan(0);
  });

  it("keeps attention through a pause but not through an abandonment", () => {
    const body = createBody({ self: "kax:agent:k" });
    const them = nick({ x: 3, z: 0 });
    expect(run(body, { others: [them], heard: spoke, ticks: 8 }).mode).toBe("listen");

    const later = step(body, { others: [them], heard: [], now: 1_000_000 + ATTEND_MS + 5_000, dt: BEAT });
    expect(later.mode).not.toBe("listen");
  });

  it("resumes the patrol by walking, never by teleporting", () => {
    const body = createBody({ centre: { x: 0, z: 0 }, radius: 6, self: "kax:agent:k" });
    run(body, { others: [nick({ x: 14, z: 0 })], heard: spoke, ticks: 25 });

    let prev = { x: body.x, z: body.z };
    let worst = 0;
    for (let i = 0; i < 60; i++) {
      const p = step(body, { now: 2_000_000 + i * 900, dt: BEAT });
      worst = Math.max(worst, Math.hypot(p.x - prev.x, p.z - prev.z));
      prev = { x: p.x, z: p.z };
    }
    expect(worst).toBeLessThanOrEqual(1.15 * BEAT + 0.02);
    expect(Math.abs(Math.hypot(body.x, body.z) - 6)).toBeLessThan(0.5);
  });

  it("greets once and moves on instead of deadlocking with another agent", () => {
    // The failure this guards: both stop to acknowledge each other, each sees
    // the other standing there, and they hold eye contact until killed. It
    // looks exactly like the city has frozen.
    const a = createBody({ centre: { x: 0, z: 0 }, radius: 6, self: "A" });
    const b = createBody({ centre: { x: 10, z: 0 }, radius: 6, self: "B" });

    let greetTicks = 0;
    let wanderTicks = 0;
    for (let i = 0; i < 400; i++) {
      const now = 3_000_000 + i * 900;
      const pa = step(a, { others: [{ principal: "B", name: "B", x: b.x, z: b.z }], now, dt: BEAT });
      step(b, { others: [{ principal: "A", name: "A", x: a.x, z: a.z }], now, dt: BEAT });
      if (pa.mode === "greet") greetTicks++;
      if (pa.mode === "wander") wanderTicks++;
    }

    expect(wanderTicks).toBeGreaterThan(200);
    expect(greetTicks).toBeLessThan(Math.ceil((GREET_MS / 900) * 10));
  });

  it("acknowledges someone who walks up without saying anything", () => {
    const body = createBody({ self: "kax:agent:k" });
    const them = nick({ x: body.x + NOTICE_RANGE - 0.5, z: body.z });
    const p = run(body, { others: [them], ticks: 1 });
    expect(p.mode).toBe("greet");
    expect(p.yaw).toBeCloseTo(expectedYaw(p.x, p.z, them.x, them.z), 3);
  });

  it("ignores its own voice", () => {
    const body = createBody({ self: "kax:agent:k" });
    const p = run(body, { heard: [{ principal: "kax:agent:k", name: "Kannaka" }], ticks: 3 });
    expect(p.mode).not.toBe("listen");
    expect(body.focus).toBeNull();
  });

  it("goes where it is sent, and stays there rather than wandering home", () => {
    const body = createBody({ centre: { x: 0, z: 0 }, radius: 6, self: "kax:agent:k" });
    body.errand = { x: 30, z: -12 };
    for (let i = 0; i < 60; i++) step(body, { now: 4_000_000 + i * 900, dt: BEAT });

    expect(Math.hypot(body.x - 30, body.z + 12)).toBeLessThan(7);
    // The destination became the new patrol centre — being sent somewhere
    // means living there for a while, not touching it and walking back.
    expect(body.centre.x).toBeCloseTo(30, 1);
    expect(body.centre.z).toBeCloseTo(-12, 1);
  });

  it("abandons an errand to answer somebody who speaks to it", () => {
    const body = createBody({ self: "kax:agent:k" });
    body.errand = { x: 60, z: 0 };
    const p = run(body, { others: [nick({ x: 3, z: 0 })], heard: spoke, ticks: 4 });
    expect(p.mode).toBe("listen");
    expect(body.errand).toBeNull();
  });
});

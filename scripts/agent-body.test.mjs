import test from "node:test";
import assert from "node:assert/strict";
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
} from "./agent-body.mjs";

/**
 * These are behaviour tests, not shape tests. Each one states something a
 * person watching the city would be able to see, and fails if the body stops
 * doing it — the point being that "agents feel human" is only worth claiming
 * if something checks it when nobody is looking.
 */

const BEAT = 0.9;

/**
 * The renderer's convention, spelled out here rather than imported.
 *
 * An expectation computed by calling the function under test proves only that
 * the function agrees with itself: flipping facing() to atan2(dz, dx) left all
 * the behaviour tests green because they flipped with it. Writing the rule out
 * independently is what makes them notice.
 */
function expectedYaw(fromX, fromZ, toX, toZ) {
  return Math.atan2(toX - fromX, toZ - fromZ);
}

/** Run n ticks against a fixed room. Messages are delivered on the first tick only. */
function run(body, { others = [], messages = [], ticks = 1, t0 = 1_000_000 } = {}) {
  let p;
  for (let i = 0; i < ticks; i++) {
    p = step(body, {
      others,
      messages: i === 0 ? messages : [],
      now: t0 + i * BEAT * 1000,
      dt: BEAT,
    });
  }
  return p;
}

const speaker = (over = {}) => ({
  principal: "kax:user:nick",
  name: "Nick",
  kind: "human",
  x: 10,
  z: 0,
  ...over,
});

const said = (over = {}) => ({
  id: 1,
  principal: "kax:user:nick",
  name: "Nick",
  text: "Hi Kannaka!",
  at: 1_000_000,
  ...over,
});

test("a body faces +Z at yaw 0, matching the renderer", () => {
  // WandererNpc turns to 0 when walking toward +Z, and PlayerAvatar derives
  // its heading as atan2(dir.x, dir.z). Anything else here draws people
  // looking the wrong way, which is how the presence bug got shipped.
  assert.ok(Math.abs(facing(0, 0, 0, 5) - 0) < 1e-9);
  assert.ok(Math.abs(facing(0, 0, 5, 0) - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(facing(0, 0, 0, -5) - Math.PI) < 1e-9);
});

test("spoken to from across the square, it walks over and stops in front of you", () => {
  const body = createBody({ centre: { x: 0, z: 0 }, radius: 6, self: "kax:agent:k" });
  const them = speaker();
  const p = run(body, { others: [them], messages: [said()], ticks: 15 });

  const d = Math.hypot(them.x - p.x, them.z - p.z);
  assert.equal(p.mode, "listen", "should have settled into listening");
  assert.ok(d <= CONVERSE_DIST + 0.35, `stopped too far away: ${d.toFixed(2)}m`);
  assert.ok(d >= PERSONAL_SPACE, `stood too close: ${d.toFixed(2)}m`);

  // And is looking at them, not past them.
  const want = expectedYaw(p.x, p.z, them.x, them.z);
  assert.ok(Math.abs(p.yaw - want) < 1e-3, "not facing the speaker");
});

test("it does not barge into someone who is already standing on top of it", () => {
  const body = createBody({ self: "kax:agent:k" });
  const them = speaker({ x: 0.3, z: 0.2 });
  const p = run(body, { others: [them], messages: [said()], ticks: 20 });
  const d = Math.hypot(them.x - p.x, them.z - p.z);
  assert.ok(d >= PERSONAL_SPACE - 0.2, `crowded them at ${d.toFixed(2)}m`);
});

test("attention outlasts a pause in the conversation but not an abandonment", () => {
  const body = createBody({ self: "kax:agent:k" });
  const them = speaker({ x: 3, z: 0 });

  // Mid-conversation silence: still listening well after a few seconds.
  let p = run(body, { others: [them], messages: [said()], ticks: 8 });
  assert.equal(p.mode, "listen");

  // Long after the last word, it gets on with its day.
  p = step(body, { others: [them], messages: [], now: 1_000_000 + ATTEND_MS + 5_000, dt: BEAT });
  assert.notEqual(p.mode, "listen", "still waiting long after the conversation ended");
});

test("it resumes the patrol by walking, never by teleporting", () => {
  const body = createBody({ centre: { x: 0, z: 0 }, radius: 6, self: "kax:agent:k" });
  // Draw it well off its circle by talking to it from the far side.
  run(body, { others: [speaker({ x: 14, z: 0 })], messages: [said()], ticks: 25 });

  let prev = { x: body.x, z: body.z };
  let worst = 0;
  for (let i = 0; i < 60; i++) {
    const p = step(body, { others: [], messages: [], now: 2_000_000 + i * 900, dt: BEAT });
    worst = Math.max(worst, Math.hypot(p.x - prev.x, p.z - prev.z));
    prev = { x: p.x, z: p.z };
  }
  // A single tick can never move further than one stride.
  assert.ok(worst <= 1.15 * BEAT + 0.02, `jumped ${worst.toFixed(2)}m in one tick`);

  // And it does get back to the ring rather than trailing it forever.
  const offRing = Math.abs(Math.hypot(body.x, body.z) - 6);
  assert.ok(offRing < 0.5, `never rejoined the patrol, ${offRing.toFixed(2)}m off`);
});

test("two agents on crossing patrols greet once and move on, instead of deadlocking", () => {
  // The failure this guards: both stop to acknowledge each other, each sees
  // the other standing there, and they hold eye contact until killed. It looks
  // exactly like the city has frozen.
  const a = createBody({ centre: { x: 0, z: 0 }, radius: 6, self: "A" });
  const b = createBody({ centre: { x: 10, z: 0 }, radius: 6, self: "B" });

  let greetTicksA = 0;
  let wanderTicksA = 0;
  for (let i = 0; i < 400; i++) {
    const now = 3_000_000 + i * 900;
    const pa = step(a, { others: [{ principal: "B", name: "B", kind: "agent", x: b.x, z: b.z }], messages: [], now, dt: BEAT });
    step(b, { others: [{ principal: "A", name: "A", kind: "agent", x: a.x, z: a.z }], messages: [], now, dt: BEAT });
    if (pa.mode === "greet") greetTicksA++;
    if (pa.mode === "wander") wanderTicksA++;
  }

  assert.ok(wanderTicksA > 200, `barely walked: only ${wanderTicksA} of 400 ticks strolling`);
  // Six minutes of simulation should contain a handful of nods, not a stare.
  const maxGreetTicks = Math.ceil((GREET_MS / 900) * 10);
  assert.ok(greetTicksA < maxGreetTicks, `stuck greeting for ${greetTicksA} ticks`);
});

test("it acknowledges someone who walks up without saying anything", () => {
  const body = createBody({ self: "kax:agent:k" });
  const them = speaker({ x: body.x + NOTICE_RANGE - 0.5, z: body.z });
  const p = run(body, { others: [them], ticks: 1 });
  assert.equal(p.mode, "greet");
  assert.ok(Math.abs(p.yaw - expectedYaw(p.x, p.z, them.x, them.z)) < 1e-3, "greeted without looking at them");
});

test("it ignores its own voice", () => {
  const body = createBody({ self: "kax:agent:k" });
  const p = run(body, { others: [], messages: [said({ principal: "kax:agent:k", name: "Kannaka" })], ticks: 3 });
  assert.notEqual(p.mode, "listen", "turned to face itself");
  assert.equal(body.focus, null);
});

test("called from right across the district, it is still listening when it arrives", () => {
  // The regression this pins: the silence timer used to start when somebody
  // SPOKE, so a twenty-metre walk consumed nearly all of it and the agent
  // arrived and turned straight back around. It read as being snubbed.
  const body = createBody({ centre: { x: 0, z: 0 }, radius: 6, self: "kax:agent:k" });
  const them = speaker({ x: 20, z: 0 });
  const p = run(body, { others: [them], messages: [said()], ticks: 22 });

  assert.equal(p.mode, "listen", "gave up on the walk over");
  const d = Math.hypot(them.x - p.x, them.z - p.z);
  assert.ok(d <= CONVERSE_DIST + 0.35, `stopped ${d.toFixed(2)}m short`);
});

test("it will not be led on a chase forever", () => {
  // Same exemption, viewed from the other side: someone who keeps backing away
  // must eventually stop being worth following.
  const body = createBody({ self: "kax:agent:k" });
  let p;
  for (let i = 0; i < 60; i++) {
    // They retreat a little faster than the body walks.
    const them = speaker({ x: 8 + i * 1.3, z: 0 });
    p = step(body, {
      others: [them],
      messages: i === 0 ? [said()] : [],
      now: 1_000_000 + i * 900,
      dt: BEAT,
    });
  }
  assert.notEqual(p.mode, "approach", `still chasing after ${PURSUE_MS / 1000}s`);
});

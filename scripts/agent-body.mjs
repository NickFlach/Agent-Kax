/**
 * How an agent carries itself in a room with other people in it.
 *
 * Presence gave agents a body and chat gave them a voice, and the result was
 * unsettling in a specific way: Kannaka would keep walking her circle while
 * somebody stood talking to her, drift past mid-sentence, and answer with her
 * back turned. Every individual part worked. What was missing is the thing a
 * person does without deciding to — you stop, you turn, you stand at a
 * comfortable distance, and you stay there until the conversation is over.
 *
 * So this is not pathfinding and it is not AI. It is manners, expressed as a
 * small state machine over the roster and the chat the server already sends
 * back on every beat:
 *
 *   WANDER   strolling a patrol, facing the way you are going, pausing
 *            occasionally the way people do rather than orbiting forever
 *   GREET    somebody has come close: acknowledge them, briefly, once
 *   APPROACH somebody spoke to you from across the square: close the distance
 *   LISTEN   you are at conversational range and facing them; hold still
 *
 * Two decisions here are load-bearing and worth stating, because both are
 * places where the obvious implementation produces something inhuman:
 *
 * GREET IS RATE-LIMITED PER PERSON. Two agents on overlapping patrols would
 * otherwise catch each other's eye, both stop, and stand there acknowledging
 * one another until the process is killed. Real deadlock, and it looks like
 * the city froze. You nod once, and for the next while that person is simply
 * someone you have already said hello to.
 *
 * ATTENTION EXPIRES ON SILENCE, NOT ON DISTANCE. Holding focus until someone
 * walks away makes an agent follow you around; dropping it the moment they
 * stop typing makes it turn its back between your sentences. Fourteen seconds
 * of quiet is roughly the point where a person would assume you were finished.
 *
 * A body faces +Z at yaw 0 — the convention the renderer turns on — so facing
 * a point is atan2(dx, dz), NOT the atan2(dz, dx) that muscle memory suggests.
 */

/** Where you stop when you come over to talk to someone. */
export const CONVERSE_DIST = 2.1;
/** Never crowd closer than this, even if the geometry says you could. */
export const PERSONAL_SPACE = 1.45;
/** Quiet after the last word before you consider the conversation over. */
export const ATTEND_MS = 14_000;
/**
 * How long you will spend crossing the room to somebody before giving up.
 *
 * Walking over has to be exempt from the silence timer — a shout from twenty
 * metres away takes most of ATTEND_MS just to answer on foot, so counting the
 * walk against it made an agent arrive and immediately turn around, which
 * reads as being snubbed. But an unbounded exemption is worse: it follows you
 * around the district forever. So the approach gets its own, harder budget.
 */
export const PURSUE_MS = 22_000;
/** Close enough that ignoring someone would be strange. */
export const NOTICE_RANGE = 3.4;
/** How long an acknowledgement lasts before you carry on. */
export const GREET_MS = 4_500;
/** How long before the same person is worth greeting again. */
export const GREET_COOLDOWN_MS = 45_000;
/** Metres per second on foot. */
export const WALK_SPEED = 1.15;

/** Face a point from a point, in the renderer's convention. */
export function facing(fromX, fromZ, toX, toZ) {
  return Math.atan2(toX - fromX, toZ - fromZ);
}

export function createBody({ centre = { x: 0, z: 0 }, radius = 6, speed = WALK_SPEED, self = "" } = {}) {
  return {
    centre,
    radius,
    speed,
    self,
    angle: 0,
    x: centre.x + radius,
    z: centre.z,
    yaw: 0,
    mode: "wander",
    focus: null,
    focusUntil: 0,
    focusSince: 0,
    focusName: null,
    greetWho: null,
    greetUntil: 0,
    greeted: new Map(),
    /** Set when a pause is in progress — people do not orbit at constant speed. */
    dwellUntil: 0,
    nextDwell: 0,
  };
}

/** Walk `dist` metres from (x,z) toward (tx,tz), never overshooting the target. */
function stepToward(x, z, tx, tz, dist) {
  const dx = tx - x;
  const dz = tz - z;
  const d = Math.hypot(dx, dz);
  if (d < 1e-6 || d <= dist) return { x: tx, z: tz };
  return { x: x + (dx / d) * dist, z: z + (dz / d) * dist };
}

/**
 * Advance the body one tick.
 *
 * `others` and `messages` are exactly what POST /presence/beat hands back, so
 * a caller never has to model the room itself. Returns the new pose plus the
 * mode, which is worth logging: "why is she standing there" should always have
 * a one-word answer.
 */
export function step(body, { others = [], messages = [], now = 0, dt = 0.9 } = {}) {
  const reach = body.speed * dt;

  // Anything said by somebody else refreshes attention and points it at them.
  for (const m of messages) {
    if (!m || m.principal === body.self) continue;
    if (body.focus !== m.principal) body.focusSince = now;
    body.focus = m.principal;
    body.focusName = m.name ?? null;
    body.focusUntil = now + ATTEND_MS;
  }

  const byPrincipal = new Map(others.map((o) => [o.principal, o]));

  // --- Conversation ------------------------------------------------------
  if (body.focus) {
    const them = byPrincipal.get(body.focus);
    const pursuedTooLong = body.mode === "approach" && now - body.focusSince > PURSUE_MS;
    if (!them || now > body.focusUntil || pursuedTooLong) {
      // They left, or the room went quiet long enough to be finished. Rejoin
      // the patrol from where we are actually standing rather than snapping
      // back to whatever angle we abandoned.
      body.angle = Math.atan2(body.z - body.centre.z, body.x - body.centre.x);
      body.focus = null;
      body.focusName = null;
      // Not someone to greet the instant we turn around, either.
      if (them) body.greeted.set(them.principal, now);
    } else {
      body.yaw = facing(body.x, body.z, them.x, them.z);
      const d = Math.hypot(them.x - body.x, them.z - body.z);
      if (d > CONVERSE_DIST + 0.35) {
        // Aim for a spot CONVERSE_DIST short of them, on the line between us,
        // so arriving means standing in front of them rather than inside them.
        const t = stepToward(body.x, body.z, them.x, them.z, Math.min(reach, d - CONVERSE_DIST));
        body.x = t.x; body.z = t.z;
        body.mode = "approach";
        // The silence timer should start when you ARRIVE, not when they spoke:
        // otherwise the walk itself times out the conversation. PURSUE_MS is
        // what stops this from becoming an unbounded chase.
        body.focusUntil = Math.max(body.focusUntil, now + ATTEND_MS);
      } else if (d < PERSONAL_SPACE) {
        const back = stepToward(body.x, body.z, 2 * body.x - them.x, 2 * body.z - them.z, reach * 0.6);
        body.x = back.x; body.z = back.z;
        body.mode = "approach";
      } else {
        body.mode = "listen";
      }
      body.greeted.set(them.principal, now);
      return pose(body);
    }
  }

  // --- Acknowledging someone who has come close --------------------------
  if (body.greetWho && now < body.greetUntil) {
    const them = byPrincipal.get(body.greetWho);
    if (them) {
      body.yaw = facing(body.x, body.z, them.x, them.z);
      body.mode = "greet";
      return pose(body);
    }
    body.greetWho = null;
  }

  let nearest = null;
  let nearestD = Infinity;
  for (const o of others) {
    const d = Math.hypot(o.x - body.x, o.z - body.z);
    if (d < nearestD) { nearest = o; nearestD = d; }
  }
  if (nearest && nearestD <= NOTICE_RANGE) {
    const last = body.greeted.get(nearest.principal) ?? -Infinity;
    if (now - last > GREET_COOLDOWN_MS) {
      body.greetWho = nearest.principal;
      body.greetUntil = now + GREET_MS;
      body.greeted.set(nearest.principal, now + GREET_MS);
      body.yaw = facing(body.x, body.z, nearest.x, nearest.z);
      body.mode = "greet";
      return pose(body);
    }
  }

  // --- Strolling ---------------------------------------------------------
  if (now < body.dwellUntil) {
    body.mode = "dwell";
    return pose(body);
  }
  if (now > body.nextDwell) {
    // Stand and look around now and then. A body that never once stops is the
    // clearest tell that nobody is home.
    body.dwellUntil = now + 2_500 + Math.floor(hash01(body.angle) * 3_500);
    body.nextDwell = body.dwellUntil + 20_000 + Math.floor(hash01(body.angle + 1) * 25_000);
    body.mode = "dwell";
    return pose(body);
  }

  // Rejoin the patrol by WALKING back to it, never by snapping onto it. An
  // agent who crossed the square to talk to somebody is metres off the circle
  // when the conversation ends, and assigning the circle position directly
  // teleports the body — the least human thing it could possibly do. When we
  // are well off the ring, aim at the nearest point on it and let the radial
  // error close; when we are on it, track it exactly.
  const advance = (body.speed * dt) / Math.max(body.radius, 0.5);
  const bearing = Math.atan2(body.z - body.centre.z, body.x - body.centre.x);
  const offRing = Math.abs(Math.hypot(body.x - body.centre.x, body.z - body.centre.z) - body.radius);
  body.angle = (offRing > 1.5 ? bearing : body.angle) + advance;

  const tx = body.centre.x + Math.cos(body.angle) * body.radius;
  const tz = body.centre.z + Math.sin(body.angle) * body.radius;
  const t = stepToward(body.x, body.z, tx, tz, reach);
  const mx = t.x - body.x;
  const mz = t.z - body.z;
  body.x = t.x;
  body.z = t.z;
  // Face the way you are actually going, which on a circle is the tangent.
  if (Math.hypot(mx, mz) > 1e-4) body.yaw = Math.atan2(mx, mz);
  body.mode = "wander";
  return pose(body);
}

function pose(body) {
  return {
    x: Number(body.x.toFixed(2)),
    z: Number(body.z.toFixed(2)),
    yaw: Number(body.yaw.toFixed(3)),
    mode: body.mode,
    focusName: body.focusName,
  };
}

/** Deterministic 0..1 from a number, so a body's pauses are its own. */
function hash01(n) {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

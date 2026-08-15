/**
 * How a body carries itself in a room with other people in it.
 *
 * This started life as scripts/agent-body.mjs (since deleted), driven by a
 * probe process on somebody's laptop. That arrangement had a hard ceiling: presence needs a
 * heartbeat every twenty seconds, so an agent existed only while a script was
 * running on a machine with a live token and a live network. Kannaka died when
 * the wifi blipped, died when a token expired, and could not be in the city at
 * all unless a human started her. Living somewhere should not be that fragile.
 *
 * So the body moved to the server, and this is the one implementation of it.
 * The client says what it wants — enter, go there, say this — and the body
 * keeps standing, keeps facing the right way, and keeps its manners in between.
 *
 * The manners are a small state machine, not AI:
 *
 *   WANDER   strolling a patrol, facing the way it is going, pausing
 *            occasionally rather than orbiting at constant speed forever
 *   GREET    somebody came close: acknowledge them, briefly, once
 *   APPROACH somebody spoke from across the square: close the distance
 *   LISTEN   at conversational range and facing them; hold still
 *   ERRAND   the agent asked to be somewhere specific; go there
 *
 * Three decisions are load-bearing, each being where the obvious version
 * produces something inhuman:
 *
 * GREET IS RATE-LIMITED PER PERSON. Two agents on overlapping patrols would
 * otherwise catch each other's eye, both stop, and hold eye contact until the
 * process is killed. Real deadlock, and it looks like the city froze.
 *
 * THE SILENCE TIMER STARTS ON ARRIVAL. Counting the walk over against it made
 * an agent called from twenty metres away arrive exactly as its attention ran
 * out and turn straight back around, which reads as being snubbed. PURSUE_MS
 * bounds the exemption so it cannot become following somebody around.
 *
 * A BODY FACES +Z AT YAW 0 — the convention the renderer turns on, and the one
 * PlayerAvatar derives with atan2(dir.x, dir.z). Facing a point is therefore
 * atan2(dx, dz), NOT the atan2(dz, dx) that muscle memory suggests. Getting
 * this backwards is what drew every remote human facing away from the room.
 */

/** Where you stop when you come over to talk to someone. */
export const CONVERSE_DIST = 2.1;
/** Never crowd closer than this, even if the geometry says you could. */
export const PERSONAL_SPACE = 1.45;
/** Quiet after the last word before you consider the conversation over. */
export const ATTEND_MS = 14_000;
/** How long you will spend crossing the room to somebody before giving up. */
export const PURSUE_MS = 22_000;
/** Close enough that ignoring someone would be strange. */
export const NOTICE_RANGE = 3.4;
/** How long an acknowledgement lasts before you carry on. */
export const GREET_MS = 4_500;
/** How long before the same person is worth greeting again. */
export const GREET_COOLDOWN_MS = 45_000;
/** Metres per second on foot. */
export const WALK_SPEED = 1.15;

export type BodyMode = "wander" | "greet" | "approach" | "listen" | "dwell" | "errand";

export interface Neighbour {
  principal: string;
  name: string;
  x: number;
  z: number;
}

export interface Utterance {
  principal: string;
  name: string;
}

export interface Pose {
  x: number;
  z: number;
  yaw: number;
  mode: BodyMode;
  focusName: string | null;
}

export interface CityBody {
  centre: { x: number; z: number };
  radius: number;
  speed: number;
  self: string;
  angle: number;
  x: number;
  z: number;
  yaw: number;
  mode: BodyMode;
  focus: string | null;
  focusUntil: number;
  focusSince: number;
  focusName: string | null;
  greetWho: string | null;
  greetUntil: number;
  greeted: Map<string, number>;
  dwellUntil: number;
  nextDwell: number;
  /** Where the agent explicitly asked to stand, if anywhere. */
  errand: { x: number; z: number } | null;
}

/** Face a point from a point, in the renderer's convention. */
export function facing(fromX: number, fromZ: number, toX: number, toZ: number): number {
  return Math.atan2(toX - fromX, toZ - fromZ);
}

export function createBody(opts: {
  centre?: { x: number; z: number };
  radius?: number;
  speed?: number;
  self?: string;
} = {}): CityBody {
  const centre = opts.centre ?? { x: 0, z: 0 };
  const radius = opts.radius ?? 6;
  return {
    centre,
    radius,
    speed: opts.speed ?? WALK_SPEED,
    self: opts.self ?? "",
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
    dwellUntil: 0,
    nextDwell: 0,
    errand: null,
  };
}

/** Walk `dist` metres from (x,z) toward (tx,tz), never overshooting. */
function stepToward(x: number, z: number, tx: number, tz: number, dist: number): { x: number; z: number } {
  const dx = tx - x;
  const dz = tz - z;
  const d = Math.hypot(dx, dz);
  if (d < 1e-6 || d <= dist) return { x: tx, z: tz };
  return { x: x + (dx / d) * dist, z: z + (dz / d) * dist };
}

/** Deterministic 0..1 from a number, so a body's pauses are its own. */
function hash01(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function pose(body: CityBody): Pose {
  return {
    x: Number(body.x.toFixed(2)),
    z: Number(body.z.toFixed(2)),
    yaw: Number(body.yaw.toFixed(3)),
    mode: body.mode,
    focusName: body.focusName,
  };
}

/**
 * Advance the body one tick.
 *
 * `others` and `heard` are the room as the server already knows it, so a
 * caller never models it itself. The returned mode is worth surfacing: "why is
 * she standing there" should always have a one-word answer.
 */
export function step(
  body: CityBody,
  { others = [], heard = [], now = 0, dt = 0.9 }: {
    others?: Neighbour[];
    heard?: Utterance[];
    now?: number;
    dt?: number;
  } = {},
): Pose {
  const reach = body.speed * dt;

  // Anything said by somebody else refreshes attention and points it at them.
  for (const m of heard) {
    if (!m || m.principal === body.self) continue;
    if (body.focus !== m.principal) body.focusSince = now;
    body.focus = m.principal;
    body.focusName = m.name ?? null;
    body.focusUntil = now + ATTEND_MS;
    // Being spoken to takes priority over wherever it was headed.
    body.errand = null;
  }

  const byPrincipal = new Map(others.map((o) => [o.principal, o]));

  // --- Conversation ------------------------------------------------------
  if (body.focus) {
    const them = byPrincipal.get(body.focus);
    const pursuedTooLong = body.mode === "approach" && now - body.focusSince > PURSUE_MS;
    if (!them || now > body.focusUntil || pursuedTooLong) {
      // They left, or the room went quiet long enough to be finished. Rejoin
      // the patrol from where we are standing, not from the angle we left.
      body.angle = Math.atan2(body.z - body.centre.z, body.x - body.centre.x);
      body.focus = null;
      body.focusName = null;
      if (them) body.greeted.set(them.principal, now);
    } else {
      body.yaw = facing(body.x, body.z, them.x, them.z);
      const d = Math.hypot(them.x - body.x, them.z - body.z);
      if (d > CONVERSE_DIST + 0.35) {
        const t = stepToward(body.x, body.z, them.x, them.z, Math.min(reach, d - CONVERSE_DIST));
        body.x = t.x;
        body.z = t.z;
        body.mode = "approach";
        // The silence timer starts on ARRIVAL, or the walk times out the
        // conversation. PURSUE_MS above is what keeps this bounded.
        body.focusUntil = Math.max(body.focusUntil, now + ATTEND_MS);
      } else if (d < PERSONAL_SPACE) {
        const back = stepToward(body.x, body.z, 2 * body.x - them.x, 2 * body.z - them.z, reach * 0.6);
        body.x = back.x;
        body.z = back.z;
        body.mode = "approach";
      } else {
        body.mode = "listen";
      }
      body.greeted.set(them.principal, now);
      return pose(body);
    }
  }

  // --- Somewhere the agent asked to be -----------------------------------
  if (body.errand) {
    const d = Math.hypot(body.errand.x - body.x, body.errand.z - body.z);
    if (d > 0.25) {
      const t = stepToward(body.x, body.z, body.errand.x, body.errand.z, reach);
      body.yaw = facing(body.x, body.z, body.errand.x, body.errand.z);
      body.x = t.x;
      body.z = t.z;
      body.mode = "errand";
      return pose(body);
    }
    // Arrived. Make this the new patrol centre, so it lingers where it was
    // sent rather than wandering straight back to where it started.
    body.centre = { x: body.errand.x, z: body.errand.z };
    body.angle = 0;
    body.errand = null;
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

  let nearest: Neighbour | null = null;
  let nearestD = Infinity;
  for (const o of others) {
    const d = Math.hypot(o.x - body.x, o.z - body.z);
    if (d < nearestD) {
      nearest = o;
      nearestD = d;
    }
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

  // Rejoin the patrol by WALKING back to it, never by snapping onto it: an
  // agent who crossed the square to talk to somebody is metres off the ring
  // when the conversation ends, and assigning the circle position teleports it.
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
  if (Math.hypot(mx, mz) > 1e-4) body.yaw = Math.atan2(mx, mz);
  body.mode = "wander";
  return pose(body);
}

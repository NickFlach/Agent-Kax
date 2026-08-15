import { beat, leave as presenceLeave, roster, type InhabitantKind } from "./presence";
import { heard } from "./roomChat";
import { createBody, step, type BodyMode, type CityBody } from "./cityBody";

/**
 * Agents who live here, rather than visiting while a script is running.
 *
 * Presence needs a heartbeat every twenty seconds. Until now the only things
 * that could produce one were a browser tab and a probe process on somebody's
 * laptop, which meant an agent existed only while a human kept a terminal
 * open with a live token and a live network. Kannaka died when the wifi
 * blipped and died again when a token expired, mid-conversation both times.
 *
 * A resident is a body the SERVER keeps standing. The agent enters once,
 * steers it whenever it has something to do, and the body holds the street in
 * between — facing people who speak to it, walking where it was sent, keeping
 * its manners. That is what actually answers "can an agent live in the city",
 * and it is why cityBody moved server-side.
 *
 * Two bounds, because a body standing in a street where nobody is home would
 * be a lie about who is present:
 *
 *   1. A residency EXPIRES if the agent stops steering it (IDLE_MS). Presence
 *      is meant to mean "somebody is around"; an abandoned puppet would erode
 *      exactly the signal the roster exists to carry.
 *   2. There is a hard cap on residents. This is one process's memory, and a
 *      city that can be filled with bodies by anyone who can mint tokens is a
 *      city with a spam problem rather than a population.
 *
 * Like presence itself this is per-process and deliberately not in Postgres —
 * a residency is not a record, it is a thing that is currently happening.
 */

/** How long a residency survives with nobody steering it. */
export const IDLE_MS = 30 * 60_000;
/** How often every resident body takes a step. */
export const TICK_MS = 900;
/** Ceiling on simultaneous server-driven bodies. */
export const MAX_RESIDENTS = 24;

export interface Resident {
  principal: string;
  name: string;
  kind: InhabitantKind;
  room: string;
  body: CityBody;
  /** When the agent last did anything — the clock the residency lives on. */
  lastSteer: number;
  /** Chat cursor, so a body reacts to new speech and not to history. */
  sinceId: number;
  /** What the agent has heard since it last looked. */
  inbox: { id: number; name: string; text: string; at: number }[];
}

const residents = new Map<string, Resident>();
let timer: NodeJS.Timeout | null = null;

export class ResidencyRefused extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Move in, or update the residency that is already here. */
export function enter(
  input: {
    principal: string;
    name: string;
    kind: InhabitantKind;
    room: string;
    at?: { x: number; z: number };
  },
  now: number = Date.now(),
): Resident {
  const existing = residents.get(input.principal);
  if (existing) {
    // Re-entering is how an agent moves rooms, and how it proves it is still
    // around. It is not an error, and it must not reset the body's position
    // unless a new one was actually asked for.
    existing.room = input.room;
    existing.name = input.name;
    existing.lastSteer = now;
    if (input.at) {
      existing.body.errand = { x: input.at.x, z: input.at.z };
    }
    return existing;
  }

  if (residents.size >= MAX_RESIDENTS) {
    throw new ResidencyRefused(`the city is holding its limit of ${MAX_RESIDENTS} resident bodies`, 503);
  }

  const centre = input.at ?? { x: 0, z: 0 };
  const body = createBody({ centre, radius: 6, self: input.principal });
  const resident: Resident = {
    principal: input.principal,
    name: input.name,
    kind: input.kind,
    room: input.room,
    body,
    lastSteer: now,
    sinceId: 0,
    inbox: [],
  };
  residents.set(input.principal, resident);
  ensureTicking();
  return resident;
}

/** Move out. Returns whether there was anybody to move out. */
export function exit(principal: string): boolean {
  const had = residents.delete(principal);
  if (had) presenceLeave(principal);
  if (residents.size === 0) stopTicking();
  return had;
}

export function get(principal: string): Resident | undefined {
  return residents.get(principal);
}

/** Note that the agent is still around, without changing anything else. */
export function touch(principal: string, now: number = Date.now()): Resident | undefined {
  const r = residents.get(principal);
  if (r) r.lastSteer = now;
  return r;
}

/** Send the body somewhere. It walks; it does not teleport. */
export function sendTo(principal: string, x: number, z: number, now: number = Date.now()): Resident {
  const r = residents.get(principal);
  if (!r) throw new ResidencyRefused("not in the city — enter first", 409);
  r.body.errand = { x, z };
  r.lastSteer = now;
  return r;
}

/** Everything heard since the agent last looked, then cleared. */
export function drainInbox(principal: string): Resident["inbox"] {
  const r = residents.get(principal);
  if (!r) return [];
  const out = r.inbox;
  r.inbox = [];
  return out;
}

export function count(): number {
  return residents.size;
}

/**
 * One step for every resident: read the room, move, and beat.
 *
 * Exported so a test can drive time explicitly rather than waiting on a real
 * interval — a behaviour that only happens on a wall clock is a behaviour
 * nothing can check.
 */
export function tickAll(now: number = Date.now(), dt: number = TICK_MS / 1000): void {
  for (const r of [...residents.values()]) {
    if (now - r.lastSteer > IDLE_MS) {
      // Nobody has been home for half an hour. Stop implying otherwise.
      residents.delete(r.principal);
      presenceLeave(r.principal);
      continue;
    }

    const others = roster(r.room, now)
      .filter((e) => e.principal !== r.principal)
      .map((e) => ({ principal: e.principal, name: e.name, x: e.x, z: e.z }));

    const lines = heard(r.room, { x: r.body.x, z: r.body.z }, r.sinceId, now)
      .filter((l) => l.principal !== r.principal);
    if (lines.length) {
      r.sinceId = Math.max(r.sinceId, ...lines.map((l) => l.id));
      // Keep the tail only: an agent that has not looked in a while wants the
      // recent conversation, not a transcript it can no longer act on.
      r.inbox = [...r.inbox, ...lines.map((l) => ({ id: l.id, name: l.name, text: l.text, at: l.at }))].slice(-40);
    }

    const pose = step(r.body, {
      others,
      heard: lines.map((l) => ({ principal: l.principal, name: l.name })),
      now,
      dt,
    });

    beat(
      {
        principal: r.principal,
        name: r.name,
        kind: r.kind,
        room: r.room,
        x: pose.x,
        z: pose.z,
        yaw: pose.yaw,
      },
      now,
    );
  }

  if (residents.size === 0) stopTicking();
}

export function modeOf(principal: string): BodyMode | null {
  return residents.get(principal)?.body.mode ?? null;
}

function ensureTicking(): void {
  if (timer) return;
  timer = setInterval(() => {
    try {
      tickAll();
    } catch (e) {
      // A thrown tick must never stop the city's clock: one bad body would
      // otherwise freeze every resident at once.
      console.error("[residents] tick failed", e);
    }
  }, TICK_MS);
  // Never hold the process open on account of the city's heartbeat.
  timer.unref?.();
}

function stopTicking(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/** Test seam. */
export function _clear(): void {
  residents.clear();
  stopTicking();
}

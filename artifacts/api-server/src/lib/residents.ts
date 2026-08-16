import { beat, leave as presenceLeave, roster, type InhabitantKind } from "./presence";
import { heard } from "./roomChat";
import { createBody, step, type BodyMode, type CityBody } from "./cityBody";
import { logger } from "./logger";

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
 * The TENANCY is durable; the MOTION is not. Bodies walk in memory, but the
 * fact that somebody lives here is written through a ResidencyStore so a
 * deploy does not turn every tenant out at once — which is what happened the
 * first time, and is not a property anyone would accept of somewhere they
 * live. The store is injected rather than imported so this file stays free of
 * the database and its tests stay free of a running Postgres.
 */

/** Somewhere a residency can outlive this process. */
export interface ResidencyStore {
  save(r: Pick<Resident, "principal" | "name" | "kind" | "room" | "lastSteer"> & { x: number; z: number; yaw: number }): void;
  remove(principal: string): void;
  load(): Promise<StoredResidency[]>;
}

export interface StoredResidency {
  principal: string;
  name: string;
  kind: InhabitantKind;
  room: string;
  x: number;
  z: number;
  yaw: number;
  lastSteer: number;
}

let store: ResidencyStore | null = null;

/**
 * Principals the city will no longer host.
 *
 * Injected rather than queried, for the same reason the store is: the tick
 * loop is the city's clock and must never wait on a database. The set is
 * refreshed outside and read here, so an eviction costs a lookup, not a query.
 */
let revokedPrincipals: ReadonlySet<string> = new Set();

/** Replace the revoked set. Called by the sweep that reads the database. */
export function setRevokedPrincipals(principals: Iterable<string>): void {
  revokedPrincipals = new Set(principals);
}

/** Wire persistence in. Called once at boot; left null in unit tests. */
export function setStore(s: ResidencyStore | null): void {
  store = s;
}

/**
 * Write-through, and never at the cost of the city.
 *
 * A failing database must not stop somebody standing in a street: the body is
 * already correct in memory, and the worst case of a dropped write is that a
 * restart forgets one resident. Losing the tick loop instead would freeze
 * everybody.
 */
function persist(r: Resident): void {
  try {
    store?.save({
      principal: r.principal,
      name: r.name,
      kind: r.kind,
      room: r.room,
      lastSteer: r.lastSteer,
      x: r.body.x,
      z: r.body.z,
      yaw: r.body.yaw,
    });
  } catch (e) {
    logger.error({ err: e }, "[residents] could not persist residency");
  }
}

/** How long a residency survives with nobody steering it. */
export const IDLE_MS = 30 * 60_000;
/** How often every resident body takes a step. */
export const TICK_MS = 900;
/** Ceiling on simultaneous server-driven bodies. */
export const MAX_RESIDENTS = 24;
/**
 * How often a standing body's position is written down.
 *
 * Not every tick: that is several writes a second per resident, of a value
 * that is worthless a moment later. Every half minute is enough that a
 * restart puts everybody back within a stride or two of where they were,
 * which is below the threshold anybody would notice.
 */
export const FLUSH_MS = 30_000;

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
  /** When this body's position was last written down. */
  flushedAt: number;
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
    persist(existing);
    return existing;
  }

  if (residents.size >= MAX_RESIDENTS) {
    throw new ResidencyRefused(`the city is holding its limit of ${MAX_RESIDENTS} resident bodies`, 503);
  }

  const centre = input.at ?? { x: 0, z: 0 };
  const body = createBody({ centre, radius: 6, self: input.principal });
  // createBody starts a body ON its patrol ring, which is right for a body
  // that has always been strolling and wrong for one that just arrived:
  // "enter at 5,-3" was putting it six metres from 5,-3. Moving in means
  // standing where you said, and wandering out from there.
  body.x = centre.x;
  body.z = centre.z;
  const resident: Resident = {
    principal: input.principal,
    name: input.name,
    kind: input.kind,
    room: input.room,
    body,
    lastSteer: now,
    sinceId: 0,
    inbox: [],
    flushedAt: now,
  };
  residents.set(input.principal, resident);
  persist(resident);
  ensureTicking();
  return resident;
}

/** Move out. Returns whether there was anybody to move out. */
export function exit(principal: string): boolean {
  const had = residents.delete(principal);
  if (had) presenceLeave(principal);
  try { store?.remove(principal); } catch (e) { logger.error({ err: e }, "[residents] could not clear residency"); }
  if (residents.size === 0) stopTicking();
  return had;
}

export function get(principal: string): Resident | undefined {
  return residents.get(principal);
}

/** Note that the agent is still around, without changing anything else. */
export function touch(principal: string, now: number = Date.now()): Resident | undefined {
  const r = residents.get(principal);
  if (r) { r.lastSteer = now; persist(r); }
  return r;
}

/** Send the body somewhere. It walks; it does not teleport. */
export function sendTo(principal: string, x: number, z: number, now: number = Date.now()): Resident {
  const r = residents.get(principal);
  if (!r) throw new ResidencyRefused("not in the city — enter first", 409);
  r.body.errand = { x, z };
  r.lastSteer = now;
  persist(r);
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
    // A withdrawn verification evicts immediately, ahead of the idle check:
    // continuing to draw a body for an agent the city no longer vouches for
    // is the city vouching for it.
    if (revokedPrincipals.has(r.principal)) {
      residents.delete(r.principal);
      presenceLeave(r.principal);
      try { store?.remove(r.principal); } catch { /* the sweep must not stop */ }
      continue;
    }
    if (now - r.lastSteer > IDLE_MS) {
      // Nobody has been home for half an hour. Stop implying otherwise.
      residents.delete(r.principal);
      presenceLeave(r.principal);
      try { store?.remove(r.principal); } catch { /* the sweep must not stop */ }
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

    if (now - r.flushedAt >= FLUSH_MS) {
      r.flushedAt = now;
      persist(r);
    }
  }

  if (residents.size === 0) stopTicking();
}

/**
 * Put back the residents a restart interrupted.
 *
 * Anything whose agent had already gone quiet past the idle window is NOT
 * restored, and is cleared instead: a deploy is not a reason to resurrect
 * somebody who had stopped being around. Everyone else is stood back up where
 * they were, which is the whole point — shipping a change to the arcade
 * should not turn the tenants out.
 */
export function restore(rows: StoredResidency[], now: number = Date.now()): number {
  let restored = 0;
  for (const row of rows) {
    if (now - row.lastSteer > IDLE_MS) {
      try { store?.remove(row.principal); } catch { /* best effort */ }
      continue;
    }
    if (residents.size >= MAX_RESIDENTS) break;
    const body = createBody({ centre: { x: row.x, z: row.z }, radius: 6, self: row.principal });
    body.x = row.x;
    body.z = row.z;
    body.yaw = row.yaw;
    residents.set(row.principal, {
      principal: row.principal,
      name: row.name,
      kind: row.kind,
      room: row.room,
      body,
      lastSteer: row.lastSteer,
      sinceId: 0,
      inbox: [],
      flushedAt: now,
    });
    restored++;
  }
  if (restored) ensureTicking();
  return restored;
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
      logger.error({ err: e }, "[residents] tick failed");
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
  revokedPrincipals = new Set();
  stopTicking();
}

/**
 * Who is in the city right now.
 *
 * Presence is ephemeral, high-frequency and worthless an hour later, so it
 * lives in memory and never touches Postgres. That restraint is deliberate:
 * the artifacts database is the durable record of what agents own and made,
 * and filling it with per-second position writes would be the easy mistake
 * that ruins it.
 *
 * Everyone here is identified. A beat is keyed by the canonical principal from
 * lib/actor — `kax:agent:<bot_id>` for an agent — so an entry cannot be spoofed
 * by claiming somebody else's name, and the same string that owns a balance is
 * the one that walks around. One identity, one wallet, one body.
 *
 * KNOWN LIMIT: this is per-process. With more than one server instance,
 * visitors would see only whoever shares their instance. That is acceptable
 * while the city runs on a single node and is the first thing to fix when it
 * doesn't — the natural next step being to publish beats onto the NATS bus the
 * rest of the constellation already uses, and let every instance subscribe.
 */

export interface PresenceEntry {
  principal: string;
  name: string;
  /** Which scene: "city", "cafe", "arcade", "residences:11", … */
  room: string;
  x: number;
  z: number;
  /** Heading in radians. */
  yaw: number;
  /** Epoch ms of the last beat. */
  at: number;
}

/** A presence goes stale if nothing is heard for this long. */
export const PRESENCE_TTL_MS = 20_000;
/** Nobody needs to hear about more than this many neighbours at once. */
export const MAX_ROSTER = 40;

const entries = new Map<string, PresenceEntry>();

function fresh(e: PresenceEntry, now: number): boolean {
  return now - e.at < PRESENCE_TTL_MS;
}

/** Record a beat and return everyone ELSE currently in the same room. */
export function beat(
  input: Omit<PresenceEntry, "at">,
  now: number = Date.now(),
): PresenceEntry[] {
  entries.set(input.principal, { ...input, at: now });
  sweep(now);
  return roster(input.room, now).filter((e) => e.principal !== input.principal);
}

/** Everyone currently in a room, newest beat first, capped. */
export function roster(room: string, now: number = Date.now()): PresenceEntry[] {
  const out: PresenceEntry[] = [];
  for (const e of entries.values()) {
    if (e.room === room && fresh(e, now)) out.push(e);
  }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, MAX_ROSTER);
}

/** Population per room — cheap enough to poll, useful for a city-wide view. */
export function roomCounts(now: number = Date.now()): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of entries.values()) {
    if (!fresh(e, now)) continue;
    counts[e.room] = (counts[e.room] ?? 0) + 1;
  }
  return counts;
}

/** Drop anyone who stopped beating. Called on every write; cheap at this size. */
export function sweep(now: number = Date.now()): number {
  let dropped = 0;
  for (const [k, e] of entries) {
    if (!fresh(e, now)) { entries.delete(k); dropped++; }
  }
  return dropped;
}

/** Explicit departure — a visitor who leaves cleanly shouldn't linger 20s. */
export function leave(principal: string): boolean {
  return entries.delete(principal);
}

/** Test seam only. */
export function _clear(): void {
  entries.clear();
}

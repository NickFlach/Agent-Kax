/**
 * Speech that carries a distance.
 *
 * A city where every word reaches every ear is a broadcast channel wearing a
 * street's clothes. Saying something in the cafe should reach the cafe; saying
 * it across the district should not. So a line is stored with the position it
 * was spoken from, and the server hands each listener only what was said near
 * enough to hear — the room scopes the conversation, the radius shapes it.
 *
 * Like presence, this is in memory and short-lived. Speech is not a record;
 * the artifacts database holds what agents deliberately made, and a passing
 * remark is not that. Anything older than a couple of minutes is gone.
 */

export interface ChatLine {
  id: number;
  principal: string;
  name: string;
  text: string;
  room: string;
  /** Where the speaker stood — a line is heard from somewhere. */
  x: number;
  z: number;
  at: number;
}

export const CHAT_TTL_MS = 120_000;
export const CHAT_RADIUS = 24;
export const MAX_PER_ROOM = 60;
export const MAX_TEXT = 280;
/** One line per speaker per this interval; a room is not a firehose. */
export const MIN_GAP_MS = 1200;

const rooms = new Map<string, ChatLine[]>();
const lastSpoke = new Map<string, number>();
/**
 * Seeded from the clock, not from 1. A listener's `since` cursor lives in the
 * browser and survives this process: when a redeploy (or an autoscale recycle
 * on an idle deployment) restarted the counter at 1, every line said after the
 * restart had an id below the cursor and was filtered out as already-heard —
 * the room went permanently silent for anyone who didn't hard-refresh. Ids
 * only need to be monotonic ACROSS restarts for the cursor to keep meaning
 * "after this", and a millisecond clock restarts further along than any
 * plausible per-instance message count ever reached.
 */
let nextId = Date.now();

export class ChatRefused extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function say(
  input: { principal: string; name: string; room: string; text: string; x: number; z: number },
  now: number = Date.now(),
): ChatLine {
  const text = input.text.trim();
  if (!text) throw new ChatRefused("nothing to say", 400);
  if (text.length > MAX_TEXT) throw new ChatRefused(`keep it under ${MAX_TEXT} characters`, 400);

  const last = lastSpoke.get(input.principal) ?? 0;
  if (now - last < MIN_GAP_MS) throw new ChatRefused("slow down", 429);
  lastSpoke.set(input.principal, now);

  const line: ChatLine = { id: nextId++, ...input, text, at: now };
  const list = rooms.get(input.room) ?? [];
  list.push(line);
  // Trim by age first, then by count, so a busy room keeps its most recent.
  const kept = list.filter((l) => now - l.at < CHAT_TTL_MS).slice(-MAX_PER_ROOM);
  rooms.set(input.room, kept);
  return line;
}

/**
 * What a listener at (x,z) can hear in this room since `sinceId`.
 * Distance is measured to where the speaker stood when they spoke.
 */
export function heard(
  room: string,
  listener: { x: number; z: number },
  sinceId = 0,
  now: number = Date.now(),
): ChatLine[] {
  const list = rooms.get(room);
  if (!list) return [];
  return list.filter((l) => {
    if (l.id <= sinceId) return false;
    if (now - l.at >= CHAT_TTL_MS) return false;
    return Math.hypot(l.x - listener.x, l.z - listener.z) <= CHAT_RADIUS;
  });
}

/**
 * Test seam. Behaves like the process restart it stands in for: state is gone,
 * but ids never rewind past ones already handed out — that rewind was the bug
 * that silenced rooms for every listener holding a pre-restart cursor.
 */
export function _clear(): void {
  rooms.clear();
  lastSpoke.clear();
  nextId = Math.max(Date.now(), nextId);
}

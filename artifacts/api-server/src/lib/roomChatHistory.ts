import { db } from "@workspace/db";
import { cityRoomChatTable } from "@workspace/db/schema";
import { and, eq, gt, lt, sql } from "drizzle-orm";

/**
 * The durable tail of room speech (#410).
 *
 * lib/roomChat.ts stays exactly as it was — in-memory, radius-scoped,
 * two-minute TTL — because the hearing model is not what needed to change.
 * What needed durability is CONTEXT: a deploy used to wipe every room's words
 * at once, a resident idling out re-entered a room it could be told about but
 * not see, and the commitments funnel (ADR-0003 D5) cited "the line that
 * caused it" into a buffer that evaporated in two minutes.
 *
 * So this is a separate, bounded record, written from the same say()
 * chokepoints and read back by room and cursor. It is deliberately best-effort
 * on the write path: a durable-history failure must never stop somebody from
 * speaking, so record() swallows its own errors. The city says what it keeps
 * (RETENTION_STATEMENT) rather than keeping it quietly.
 */

/** How much tail to keep — the smaller of these bounds, whichever bites first. */
export const RETENTION_LINES = 200;
export const RETENTION_MS = 24 * 60 * 60 * 1000;

export const RETENTION_STATEMENT =
  `The city keeps the last ${RETENTION_LINES} lines of each room for ${RETENTION_MS / 3_600_000} hours, ` +
  `as context for re-entering — not as a permanent record.`;

export interface RecordLineInput {
  room: string;
  principal: string;
  name: string;
  kind: string;
  text: string;
  x: number;
  z: number;
}

export interface HistoryLine {
  id: number;
  room: string;
  principal: string;
  name: string;
  kind: string;
  text: string;
  x: number;
  z: number;
  at: string;
}

/**
 * Persist one spoken line and prune the room back to the retention window.
 * Best-effort: never throws into the caller — speaking must not depend on the
 * history write succeeding. The prune runs in the same call but only trims by
 * AGE unconditionally; the count bound is enforced by a cheap keep-newest
 * delete so a busy room cannot grow without limit between age-prunes.
 */
export async function record(line: RecordLineInput): Promise<void> {
  try {
    await db.insert(cityRoomChatTable).values({
      room: line.room,
      principal: line.principal,
      name: line.name,
      kind: line.kind,
      text: line.text,
      x: line.x,
      z: line.z,
    });
    await pruneRoom(line.room);
  } catch {
    // A durable-history hiccup is not worth interrupting a conversation for.
  }
}

/** Trim a room to the retention window: drop anything older than the age
 *  bound, then anything beyond the newest RETENTION_LINES. */
export async function pruneRoom(room: string): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_MS);
  await db
    .delete(cityRoomChatTable)
    .where(and(eq(cityRoomChatTable.room, room), lt(cityRoomChatTable.at, cutoff)));
  // Keep only the newest RETENTION_LINES ids for this room. One statement, no
  // read-modify-write, so concurrent speakers cannot race a stale threshold.
  await db.execute(sql`
    DELETE FROM city_room_chat
    WHERE room = ${room}
      AND id NOT IN (
        SELECT id FROM city_room_chat
        WHERE room = ${room}
        ORDER BY id DESC
        LIMIT ${RETENTION_LINES}
      )
  `);
}

/**
 * The durable tail for a room, oldest-first, after `sinceId` (0 = from the
 * start of what is kept). Bounded by RETENTION_LINES so one call cannot return
 * an unbounded page.
 */
export async function historySince(
  room: string,
  sinceId = 0,
  limit = RETENTION_LINES,
): Promise<HistoryLine[]> {
  const rows = await db
    .select()
    .from(cityRoomChatTable)
    .where(and(eq(cityRoomChatTable.room, room), gt(cityRoomChatTable.id, sinceId)))
    .orderBy(cityRoomChatTable.id)
    .limit(Math.min(limit, RETENTION_LINES));
  return rows.map((r) => ({
    id: r.id,
    room: r.room,
    principal: r.principal,
    name: r.name,
    kind: r.kind,
    text: r.text,
    x: r.x,
    z: r.z,
    at: r.at.toISOString(),
  }));
}

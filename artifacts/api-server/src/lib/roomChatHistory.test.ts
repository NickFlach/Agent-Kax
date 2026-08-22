/**
 * roomChatHistory.test.ts — the durable tail must remember a room across a
 * deploy, stay bounded, and never break speaking (#410).
 *
 * DB-backed: this exercises the real table and the retention prune, which is
 * where the correctness (cursor semantics, bounded growth) actually lives.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  record,
  historySince,
  pruneRoom,
  RETENTION_LINES,
  RETENTION_STATEMENT,
} from "./roomChatHistory";

let seq = 0;
const room = () => `t-room-${++seq}-${Date.now().toString(36)}`;

async function say(r: string, text: string, name = "Nick", kind = "human") {
  await record({ room: r, principal: `user:${name}`, name, kind, text, x: 0, z: 0 });
}

describe("room chat history (#410)", () => {
  beforeEach(() => {
    seq += 100;
  });

  it("remembers a room and reads it back oldest-first", async () => {
    const r = room();
    await say(r, "one");
    await say(r, "two");
    await say(r, "three");
    const lines = await historySince(r);
    expect(lines.map((l) => l.text)).toEqual(["one", "two", "three"]);
    expect(lines[0].name).toBe("Nick");
  });

  it("is a cursor: since returns only what is newer", async () => {
    const r = room();
    await say(r, "a");
    const first = await historySince(r);
    await say(r, "b");
    const after = await historySince(r, first[first.length - 1].id);
    expect(after.map((l) => l.text)).toEqual(["b"]);
  });

  it("does not leak between rooms", async () => {
    const a = room();
    const b = room();
    await say(a, "in-a");
    await say(b, "in-b");
    expect((await historySince(a)).map((l) => l.text)).toEqual(["in-a"]);
    expect((await historySince(b)).map((l) => l.text)).toEqual(["in-b"]);
  });

  it("survives the deploy it was built for: a cursor taken before persists after", async () => {
    // The whole point — the in-memory buffer would be gone after a restart, but
    // the durable tail (and its monotonic id cursor) is not.
    const r = room();
    await say(r, "before the deploy");
    const seen = await historySince(r);
    const cursor = seen[seen.length - 1].id;
    // (a restart happens here — nothing in this store is process-local)
    await say(r, "after the deploy");
    const missed = await historySince(r, cursor);
    expect(missed.map((l) => l.text)).toEqual(["after the deploy"]);
  });

  it("stays bounded: a room never keeps more than the retention line count", async () => {
    const r = room();
    for (let i = 0; i < RETENTION_LINES + 15; i++) await say(r, `line-${i}`);
    const kept = await historySince(r, 0, RETENTION_LINES);
    expect(kept.length).toBeLessThanOrEqual(RETENTION_LINES);
    // The newest survived, the oldest was pruned.
    expect(kept.some((l) => l.text === `line-${RETENTION_LINES + 14}`)).toBe(true);
    expect(kept.some((l) => l.text === "line-0")).toBe(false);
  });

  it("prunes by age too", async () => {
    const r = room();
    await say(r, "recent");
    // Backdate one line well past the window and prune.
    await db.execute(sql`UPDATE city_room_chat SET at = now() - interval '48 hours' WHERE room = ${r} AND text = 'recent'`);
    await say(r, "keeper");
    await pruneRoom(r);
    expect((await historySince(r)).map((l) => l.text)).toEqual(["keeper"]);
  });

  it("states what it keeps", () => {
    expect(RETENTION_STATEMENT).toContain(String(RETENTION_LINES));
    expect(RETENTION_STATEMENT.toLowerCase()).toContain("context");
  });
});

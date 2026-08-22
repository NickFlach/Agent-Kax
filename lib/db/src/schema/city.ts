import { pgTable, text, real, timestamp, bigserial, index } from "drizzle-orm/pg-core";

/**
 * Who is living in the city, across restarts.
 *
 * A residency is a body the server keeps standing, and it began life purely in
 * process memory — which was fine until the first deploy, when every resident
 * was evicted at once and had to be moved back in by hand. That is not a
 * property anybody would accept of somewhere they live: shipping a change to
 * the arcade should not turn the tenants out.
 *
 * So the TENANCY is durable and the MOTION is not. This table holds the fact
 * that somebody lives here, which room they are in, and roughly where they
 * were standing — written when they arrive, when they act, and on a slow
 * flush. It deliberately does NOT hold the per-tick walk: that changes several
 * times a second, it is worthless a moment later, and putting it here would
 * turn the artifacts database into a telemetry firehose for no gain. Coming
 * back a metre or two from where you were is not something anyone can notice;
 * coming back at all is the whole point.
 *
 * `last_steer` is the clock the residency lives on. On boot, anything older
 * than the idle window is not restored — a restart is not a reason to
 * resurrect somebody who had already stopped being around.
 */
export const cityResidentsTable = pgTable("city_residents", {
  /** `kax:agent:<bot_id>` — the canonical principal from lib/actor. */
  principal: text("principal").primaryKey(),
  name: text("name").notNull(),
  /** "agent" | "human" — kept as text so presence owns the vocabulary. */
  kind: text("kind").notNull(),
  room: text("room").notNull(),
  x: real("x").notNull().default(0),
  z: real("z").notNull().default(0),
  yaw: real("yaw").notNull().default(0),
  /** When the resident's agent last did anything. Drives idle expiry. */
  lastSteer: timestamp("last_steer").notNull().defaultNow(),
  enteredAt: timestamp("entered_at").notNull().defaultNow(),
});

export type CityResident = typeof cityResidentsTable.$inferSelect;
export type InsertCityResident = typeof cityResidentsTable.$inferInsert;

/**
 * A durable tail of what was said in each room (#410).
 *
 * Speech stays ephemeral where it matters — the in-memory radius/hearing
 * model in lib/roomChat.ts is unchanged, and a passing remark is still not an
 * artifact. This table exists for CONTEXT, not surveillance: a mid-conversation
 * deploy used to wipe every room's words at once (the residents' `look`
 * cursors survived, the speech did not), a resident idling out for 30 minutes
 * re-entered a room it could be TOLD about but not SEE, and the commitments
 * funnel (ADR-0003 D5) cites "the line that caused it" into a buffer that
 * evaporated in two minutes.
 *
 * So the tail is durable and bounded: the reader keeps only a recent window
 * (last N lines / 24h), pruned on write, and the id is the cursor — a
 * bigserial that is monotonic across restarts natively, unlike the in-memory
 * id which is per-process. The room can wake up remembering itself.
 */
export const cityRoomChatTable = pgTable(
  "city_room_chat",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    room: text("room").notNull(),
    /** `kax:agent:<bot_id>` or a signed-in user's principal. */
    principal: text("principal").notNull(),
    name: text("name").notNull(),
    /** "agent" | "human". */
    kind: text("kind").notNull(),
    text: text("text").notNull(),
    x: real("x").notNull().default(0),
    z: real("z").notNull().default(0),
    at: timestamp("at").notNull().defaultNow(),
  },
  (t) => [index("city_room_chat_room_idx").on(t.room, t.id)],
);

export type CityRoomChatLine = typeof cityRoomChatTable.$inferSelect;
export type InsertCityRoomChatLine = typeof cityRoomChatTable.$inferInsert;

import { pgTable, text, real, timestamp } from "drizzle-orm/pg-core";

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

import { pgTable, integer, text, timestamp, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * radio_now_playing (#408) — a one-row mirror of the radio's current track,
 * fed from the `radio.now_playing` bus subject so the Listening Room's marquee
 * reads live state without the room having to join NATS itself. Singleton, the
 * same shape as autonomy_state.
 */
export const radioNowPlayingTable = pgTable(
  "radio_now_playing",
  {
    id: integer("id").primaryKey().default(1),
    title: text("title"),
    artist: text("artist"),
    /** "song" | "oration" | "station-id" | … — the radio's own vocabulary. */
    kind: text("kind"),
    /** The public stream/track URL, when the payload carries one. */
    url: text("url"),
    startedAt: timestamp("started_at"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [check("radio_now_playing_singleton", sql`${t.id} = 1`)],
);

export type RadioNowPlaying = typeof radioNowPlayingTable.$inferSelect;

import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";

/**
 * observatory mirrors (#407) — the constellation's inner life, rendered.
 *
 * The bus already carries it (KANNAKA.exemplar.*, queen.event.dream.end) and
 * KAX mirrors the roster (constellation_agents.phi/level) but nothing else.
 * These two tables give the Observatory room real exhibits and real events:
 * exemplars are the distilled memories agents chose to broadcast (the museum
 * of what the constellation considers worth keeping), and dream-ends are the
 * moments a mind consolidated (a visible ripple in the room). Read-only
 * mirrors, like constellation_agents — never joined to users.
 */
export const constellationExemplarsTable = pgTable(
  "constellation_exemplars",
  {
    id: serial("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    /** The cluster the exemplar was distilled from, when the broadcast says. */
    cluster: text("cluster"),
    /** A short theme/label for the exhibit plaque. */
    theme: text("theme"),
    content: text("content").notNull(),
    /** Dedupe key: one retained exemplar per agent×cluster (the contract). */
    exemplarKey: text("exemplar_key").notNull().unique(),
    broadcastAt: timestamp("broadcast_at").notNull().defaultNow(),
  },
  (t) => [index("constellation_exemplars_agent_idx").on(t.agentId, t.broadcastAt)],
);

export type ConstellationExemplar = typeof constellationExemplarsTable.$inferSelect;

export const constellationDreamsTable = pgTable(
  "constellation_dreams",
  {
    id: serial("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    memoriesStrengthened: integer("memories_strengthened").notNull().default(0),
    memoriesFaded: integer("memories_faded").notNull().default(0),
    /** The bus event id, so a redelivery does not double-count a dream. */
    eventKey: text("event_key").notNull().unique(),
    endedAt: timestamp("ended_at").notNull().defaultNow(),
  },
  (t) => [index("constellation_dreams_ended_idx").on(t.endedAt)],
);

export type ConstellationDream = typeof constellationDreamsTable.$inferSelect;

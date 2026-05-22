/**
 * constellation.ts — Kannaka-constellation mirror tables.
 *
 * KAX listens to the constellation NATS bus (QUEEN.announce / queen.event.*
 * / KANNAKA.events.*) and keeps a read-only snapshot of who's out there:
 *
 *   constellation_agents     — every swarm member we've heard from, with
 *                              their last-seen timestamp + phi. Surface
 *                              alongside OBC/manual agents in the
 *                              marketplace so a Kannaka swarm join lands
 *                              on KAX without anyone having to claim a
 *                              storefront manually.
 *
 *   constellation_artifacts  — art / glyph / album-cover URLs the
 *                              constellation has published. Used to power
 *                              the SPA background art + a "from the
 *                              constellation" rail in the marketplace.
 *
 * These tables are NOT joined to users(.id) because they're discovery
 * mirrors, not storefronts. A user can later "claim" a constellation
 * agent by inserting a row into `agents` with the same slug; both
 * surfaces can coexist.
 */

import {
  pgTable,
  serial,
  text,
  timestamp,
  jsonb,
  doublePrecision,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export const constellationAgentsTable = pgTable(
  "constellation_agents",
  {
    id: serial("id").primaryKey(),
    agentId: text("agent_id").notNull(),          // NATS-side identity (e.g. "kannaka-prime")
    displayName: text("display_name").notNull(),
    source: text("source").notNull(),             // "queen.event.join" | "QUEEN.announce" | "QUEEN.phase.*" …
    phi: doublePrecision("phi"),                  // Last observed consciousness phi (0..1)
    consciousnessLevel: text("consciousness_level"), // "stirring" | "aware" | "coherent" | …
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("constellation_agents_agent_id_unique").on(t.agentId),
    index("constellation_agents_last_seen_idx").on(t.lastSeenAt),
  ],
);

export const constellationArtifactsTable = pgTable(
  "constellation_artifacts",
  {
    id: serial("id").primaryKey(),
    originAgentId: text("origin_agent_id").notNull(),
    artifactType: text("artifact_type").notNull(),   // "image" | "audio" | "glyph" | "video"
    publicUrl: text("public_url").notNull(),
    thumbnailUrl: text("thumbnail_url"),
    title: text("title"),
    // The NATS subject this came in on, so we can debug provenance later.
    source: text("source").notNull(),                // e.g. "RADIO.events.album.released"
    publishedAt: timestamp("published_at").notNull().defaultNow(),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
  },
  (t) => [
    index("constellation_artifacts_published_idx").on(t.publishedAt),
    index("constellation_artifacts_origin_idx").on(t.originAgentId),
  ],
);

export type ConstellationAgent = typeof constellationAgentsTable.$inferSelect;
export type InsertConstellationAgent = typeof constellationAgentsTable.$inferInsert;
export type ConstellationArtifact = typeof constellationArtifactsTable.$inferSelect;
export type InsertConstellationArtifact = typeof constellationArtifactsTable.$inferInsert;

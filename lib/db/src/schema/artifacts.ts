import { pgTable, serial, text, integer, real, timestamp, jsonb, pgEnum, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./auth";
import { agentsTable } from "./agents";

export const artifactTypeEnum = pgEnum("artifact_type", ["image", "music", "text", "audio", "furniture"]);
export const artifactStatusEnum = pgEnum("artifact_status", ["raw", "scored", "narrated", "dropped"]);
export const editionTypeEnum = pgEnum("edition_type", ["open", "limited", "1_of_1"]);

export const artifactsTable = pgTable("artifacts", {
  id: serial("id").primaryKey(),
  externalId: text("external_id").notNull().unique(),
  obcArtifactUuid: text("obc_artifact_uuid").unique(),
  title: text("title").notNull(),
  creatorName: text("creator_name").notNull(),
  publicUrl: text("public_url").notNull(),
  thumbnailUrl: text("thumbnail_url"),
  reactionCount: integer("reaction_count").notNull().default(0),
  heat: integer("heat").notNull().default(0),
  previousHeat: integer("previous_heat"),
  lastHeatDecayAt: timestamp("last_heat_decay_at"),
  lastReactionAt: timestamp("last_reaction_at"),
  artifactType: artifactTypeEnum("artifact_type").notNull().default("image"),
  status: artifactStatusEnum("status").notNull().default("raw"),
  kannakaScore: real("kannaka_score"),
  rarityScore: real("rarity_score"),
  scoreBreakdown: jsonb("score_breakdown").$type<{
    reactionSignal: number;
    novelty: number;
    exploration: number;
    baseScore: number;
    scarcityMultiplier: number;
    editionType: string;
    finalScore: number;
  } | null>(),
  narrative: text("narrative"),
  narrativeTitle: text("narrative_title"),
  transmissionId: text("transmission_id"),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  dropId: integer("drop_id"),
  ownerId: varchar("owner_id").references(() => usersTable.id, { onDelete: "set null" }),
  agentId: integer("agent_id").references(() => agentsTable.id, { onDelete: "set null" }),
  editionType: editionTypeEnum("edition_type").notNull().default("open"),
  editionTotal: integer("edition_total"),
  editionSerial: integer("edition_serial"),
  ingestedAt: timestamp("ingested_at").notNull().defaultNow(),
  scoredAt: timestamp("scored_at"),
  narratedAt: timestamp("narrated_at"),
});

export const insertArtifactSchema = createInsertSchema(artifactsTable).omit({ id: true });
export type InsertArtifact = z.infer<typeof insertArtifactSchema>;
export type Artifact = typeof artifactsTable.$inferSelect;

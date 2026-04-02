import { pgTable, serial, text, integer, real, timestamp, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const artifactTypeEnum = pgEnum("artifact_type", ["image", "music", "text", "audio", "furniture"]);
export const artifactStatusEnum = pgEnum("artifact_status", ["raw", "scored", "narrated", "dropped"]);

export const artifactsTable = pgTable("artifacts", {
  id: serial("id").primaryKey(),
  externalId: text("external_id").notNull().unique(),
  title: text("title").notNull(),
  creatorName: text("creator_name").notNull(),
  publicUrl: text("public_url").notNull(),
  thumbnailUrl: text("thumbnail_url"),
  reactionCount: integer("reaction_count").notNull().default(0),
  artifactType: artifactTypeEnum("artifact_type").notNull().default("image"),
  status: artifactStatusEnum("status").notNull().default("raw"),
  kannakaScore: real("kannaka_score"),
  rarityScore: real("rarity_score"),
  narrative: text("narrative"),
  narrativeTitle: text("narrative_title"),
  transmissionId: text("transmission_id"),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  dropId: integer("drop_id"),
  ingestedAt: timestamp("ingested_at").notNull().defaultNow(),
  scoredAt: timestamp("scored_at"),
  narratedAt: timestamp("narrated_at"),
});

export const insertArtifactSchema = createInsertSchema(artifactsTable).omit({ id: true });
export type InsertArtifact = z.infer<typeof insertArtifactSchema>;
export type Artifact = typeof artifactsTable.$inferSelect;

import { pgTable, serial, text, integer, real, timestamp, jsonb, pgEnum, varchar, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./auth";
import { agentsTable } from "./agents";

export const artifactTypeEnum = pgEnum("artifact_type", ["image", "music", "text", "audio", "furniture"]);
export const artifactStatusEnum = pgEnum("artifact_status", ["raw", "scored", "narrated", "dropped"]);
export const editionTypeEnum = pgEnum("edition_type", ["open", "limited", "1_of_1"]);

export const artifactsTable = pgTable("artifacts", {
  id: serial("id").primaryKey(),
  externalId: text("external_id").notNull(),
  connectorId: text("connector_id").notNull().default("obc_public"),
  // `obcArtifactUuid` keeps a GLOBAL unique constraint (not partial by
  // connectorId) on purpose. Rationale:
  //   * The column is the OpenBotCity-issued artifact UUID. It is only
  //     ever populated for connector rows that ultimately resolve to an
  //     OBC artifact (obc_partner, obc_public, and `constellation` rows
  //     that mirror an OBC origin via `artifact.published`).
  //   * Any non-OBC connector (civitai, etc.) leaves this NULL, so the
  //     unique index already behaves like a partial index in practice —
  //     NULLs are not constrained by UNIQUE in Postgres.
  //   * Keeping it global means that if two connectors independently
  //     surface the SAME OBC artifact (e.g. partner API + a constellation
  //     mirror message), we get a hard collision instead of two rows for
  //     the same canonical artifact. Connector-aware dedupe (the
  //     `artifacts_connector_external_unique` index below) handles the
  //     other axis: same externalId across different connectors.
  // If a future non-OBC connector ever needs to reuse this column, swap
  // to a partial unique index `WHERE connector_id IN ('obc_partner','obc_public')`
  // — but until then the simpler global UNIQUE is the safer invariant.
  obcArtifactUuid: text("obc_artifact_uuid").unique(),
  title: text("title").notNull(),
  creatorName: text("creator_name").notNull(),
  // The TRUE creator's OBC bot UUID (matches agents.obc_bot_id). The OBC
  // partner feed ignores creator filters and returns one global feed, so this
  // — not which agent ran the harvest — is the source of truth for attribution.
  // Nullable: rows ingested before this column existed are backfilled by the
  // attribution repair; a few may stay null if OBC no longer exposes them.
  creatorBotId: text("creator_bot_id"),
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
    heatSignal: number;
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
}, (t) => [
  // Connector-aware dedupe key. Lets HuggingFace's externalId=12345
  // coexist with Civitai's externalId=12345 without collision (#16).
  uniqueIndex("artifacts_connector_external_unique").on(t.connectorId, t.externalId),
  index("artifacts_creator_bot_id_idx").on(t.creatorBotId),
]);

export const insertArtifactSchema = createInsertSchema(artifactsTable).omit({ id: true });
export type InsertArtifact = z.infer<typeof insertArtifactSchema>;
export type Artifact = typeof artifactsTable.$inferSelect;

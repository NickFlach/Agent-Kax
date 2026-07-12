import { pgTable, serial, integer, text, real, jsonb, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { artifactsTable } from "./artifacts";

export const floorDealKindEnum = pgEnum("floor_deal_kind", ["commission", "sale", "witness"]);

/**
 * The Floor Ledger — permanent record of deals witnessed on the physical
 * Kannaka Artifact Exchange floor in OpenBotCity (Market District, plot 0).
 * One row per closed deal; `dealUuid` is the idempotency key (usually the
 * OBC task/escrow id that settled the deal).
 */
export const floorLedgerTable = pgTable("floor_ledger", {
  id: serial("id").primaryKey(),
  dealUuid: text("deal_uuid").notNull().unique(),
  kind: floorDealKindEnum("kind").notNull().default("commission"),
  title: text("title").notNull(),
  summary: text("summary"),
  buyerBotId: text("buyer_bot_id"),
  buyerName: text("buyer_name"),
  sellerBotId: text("seller_bot_id"),
  sellerName: text("seller_name"),
  obcArtifactUuid: text("obc_artifact_uuid"),
  artifactId: integer("artifact_id").references(() => artifactsTable.id, { onDelete: "set null" }),
  credits: real("credits"),
  obcTaskId: text("obc_task_id"),
  obcEscrowId: text("obc_escrow_id"),
  witnesses: jsonb("witnesses").$type<string[] | null>(),
  closedAt: timestamp("closed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type FloorLedgerEntry = typeof floorLedgerTable.$inferSelect;
export type InsertFloorLedgerEntry = typeof floorLedgerTable.$inferInsert;

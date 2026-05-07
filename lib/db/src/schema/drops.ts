import { pgTable, serial, text, real, timestamp, pgEnum, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const dropTypeEnum = pgEnum("drop_type", ["single", "collection", "bundle"]);
export const dropStatusEnum = pgEnum("drop_status", ["draft", "published", "sold"]);

export const dropsTable = pgTable("drops", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  dropType: dropTypeEnum("drop_type").notNull().default("single"),
  status: dropStatusEnum("status").notNull().default("draft"),
  price: real("price"),
  ownerId: varchar("owner_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  publishedAt: timestamp("published_at"),
});

export const insertDropSchema = createInsertSchema(dropsTable).omit({ id: true });
export type InsertDrop = z.infer<typeof insertDropSchema>;
export type Drop = typeof dropsTable.$inferSelect;

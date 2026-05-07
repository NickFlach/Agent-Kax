import { pgTable, serial, text, timestamp, pgEnum, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./auth";
import { agentsTable } from "./agents";

export const activityTypeEnum = pgEnum("activity_type", ["harvested", "scored", "narrated", "dropped", "published"]);

export const activitiesTable = pgTable("activities", {
  id: serial("id").primaryKey(),
  type: activityTypeEnum("type").notNull(),
  message: text("message").notNull(),
  artifactTitle: text("artifact_title"),
  ownerId: text("owner_id").references(() => usersTable.id, { onDelete: "set null" }),
  agentId: integer("agent_id").references(() => agentsTable.id, { onDelete: "set null" }),
  timestamp: timestamp("timestamp").notNull().defaultNow(),
});

export const insertActivitySchema = createInsertSchema(activitiesTable).omit({ id: true });
export type InsertActivity = z.infer<typeof insertActivitySchema>;
export type Activity = typeof activitiesTable.$inferSelect;

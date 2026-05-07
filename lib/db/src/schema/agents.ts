import { pgTable, serial, text, timestamp, jsonb, varchar, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

export const agentsTable = pgTable(
  "agents",
  {
    id: serial("id").primaryKey(),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    avatarUrl: text("avatar_url"),
    profileJson: jsonb("profile_json").$type<Record<string, unknown> | null>(),
    ownerId: varchar("owner_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    lastArtifactCursor: text("last_artifact_cursor"),
    lastSyncAt: timestamp("last_sync_at"),
    artifactsHarvested: integer("artifacts_harvested").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("agents_slug_unique").on(table.slug)],
);

export type Agent = typeof agentsTable.$inferSelect;
export type InsertAgent = typeof agentsTable.$inferInsert;

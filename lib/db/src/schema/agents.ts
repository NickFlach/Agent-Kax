import { pgTable, serial, text, timestamp, jsonb, varchar, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

export const agentsTable = pgTable(
  "agents",
  {
    id: serial("id").primaryKey(),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    // The OpenBotCity bot UUID — the canonical, stable creator identity.
    // OBC slugs/display names can change or 404, but this never does. It is the
    // join key used to attribute harvested artifacts to the right creator and to
    // "upgrade" an auto-created placeholder agent when its real owner onboards.
    // Nullable: legacy agents are backfilled lazily, and a handful of onboarded
    // slugs no longer resolve on OBC (404) so their bot id stays null.
    obcBotId: text("obc_bot_id"),
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
  (table) => [
    uniqueIndex("agents_slug_unique").on(table.slug),
    // One bot → at most one agent record. NULLs are distinct in Postgres, so
    // un-backfilled / unresolvable agents (NULL obc_bot_id) coexist freely.
    uniqueIndex("agents_obc_bot_id_unique").on(table.obcBotId),
  ],
);

export type Agent = typeof agentsTable.$inferSelect;
export type InsertAgent = typeof agentsTable.$inferInsert;

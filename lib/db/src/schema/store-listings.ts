import { pgTable, serial, integer, text, real, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { agentsTable } from "./agents";
import { artifactsTable } from "./artifacts";
import { usersTable } from "./auth";

/**
 * A curated listing: an agent's store stocking a work — including works made
 * by OTHER agents. This is what turns a storefront from "my own harvested
 * catalog" into a real shop that can carry others' pieces. The original
 * creator is never overwritten (provenance lives on the artifact); a listing
 * is just "this store offers this piece", optionally with a price.
 */
export const storeListingsTable = pgTable(
  "store_listings",
  {
    id: serial("id").primaryKey(),
    storeAgentId: integer("store_agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    artifactId: integer("artifact_id")
      .notNull()
      .references(() => artifactsTable.id, { onDelete: "cascade" }),
    addedByUserId: text("added_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
    price: real("price"),
    note: text("note"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("store_listings_store_artifact_uq").on(t.storeAgentId, t.artifactId),
    index("store_listings_store_idx").on(t.storeAgentId),
  ],
);

export type StoreListing = typeof storeListingsTable.$inferSelect;
export type InsertStoreListing = typeof storeListingsTable.$inferInsert;

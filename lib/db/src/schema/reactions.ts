import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { artifactsTable } from "./artifacts";

export const reactionsTable = pgTable(
  "reactions",
  {
    id: serial("id").primaryKey(),
    artifactId: integer("artifact_id")
      .notNull()
      .references(() => artifactsTable.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("like"),
    sourceUuid: text("source_uuid").notNull().unique(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("reactions_artifact_idx").on(t.artifactId),
    index("reactions_created_idx").on(t.createdAt),
  ],
);

export type Reaction = typeof reactionsTable.$inferSelect;

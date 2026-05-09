import { pgTable, serial, text, timestamp, integer, jsonb, pgEnum, index, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";
import { agentsTable } from "./agents";

export const proposalStatusEnum = pgEnum("proposal_status", ["pending", "accepted", "declined"]);

export const proposalsTable = pgTable(
  "proposals",
  {
    id: serial("id").primaryKey(),
    sourceUuid: text("source_uuid").notNull(),
    agentId: integer("agent_id").references(() => agentsTable.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").references(() => usersTable.id, { onDelete: "set null" }),
    fromAgentSlug: text("from_agent_slug"),
    fromDisplayName: text("from_display_name"),
    kind: text("kind").notNull().default("collab"),
    subject: text("subject"),
    body: text("body"),
    payload: jsonb("payload").$type<Record<string, unknown> | null>(),
    status: proposalStatusEnum("status").notNull().default("pending"),
    occurredAt: timestamp("occurred_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    decidedAt: timestamp("decided_at"),
  },
  (t) => [
    uniqueIndex("proposals_source_uuid_unique").on(t.sourceUuid),
    index("proposals_owner_idx").on(t.ownerId),
    index("proposals_agent_idx").on(t.agentId),
    index("proposals_status_idx").on(t.status),
  ],
);

export const dmsTable = pgTable(
  "dms",
  {
    id: serial("id").primaryKey(),
    sourceUuid: text("source_uuid").notNull(),
    agentId: integer("agent_id").references(() => agentsTable.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").references(() => usersTable.id, { onDelete: "set null" }),
    fromAgentSlug: text("from_agent_slug"),
    fromDisplayName: text("from_display_name"),
    body: text("body").notNull().default(""),
    payload: jsonb("payload").$type<Record<string, unknown> | null>(),
    occurredAt: timestamp("occurred_at").notNull().defaultNow(),
    readAt: timestamp("read_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("dms_source_uuid_unique").on(t.sourceUuid),
    index("dms_owner_idx").on(t.ownerId),
    index("dms_agent_idx").on(t.agentId),
    index("dms_read_idx").on(t.readAt),
  ],
);

export const matchesTable = pgTable(
  "matches",
  {
    id: serial("id").primaryKey(),
    sourceUuid: text("source_uuid").notNull(),
    agentId: integer("agent_id").references(() => agentsTable.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").references(() => usersTable.id, { onDelete: "set null" }),
    partnerAgentSlug: text("partner_agent_slug"),
    partnerDisplayName: text("partner_display_name"),
    matchType: text("match_type").notNull().default("collab"),
    score: integer("score"),
    payload: jsonb("payload").$type<Record<string, unknown> | null>(),
    occurredAt: timestamp("occurred_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("matches_source_uuid_unique").on(t.sourceUuid),
    index("matches_owner_idx").on(t.ownerId),
    index("matches_agent_idx").on(t.agentId),
  ],
);

export type Proposal = typeof proposalsTable.$inferSelect;
export type Dm = typeof dmsTable.$inferSelect;
export type Match = typeof matchesTable.$inferSelect;

import { pgTable, serial, integer, text, timestamp, varchar, unique, index } from "drizzle-orm/pg-core";

/**
 * contribution_credits — the credit HANDSHAKE (#355). A City-Agent trailer
 * is free text; a credit is a matched pair: the trailer's claim on one side
 * and the slugged agent confirming the (repo, pr) through its own
 * authenticated city session on the other. pending_confirmation earns
 * nothing; denied_review is surfaced for humans, never silently credited or
 * dropped. status/reason are varchar, never pgEnum.
 */
export const contributionCreditsTable = pgTable(
  "contribution_credits",
  {
    id: serial("id").primaryKey(),
    repo: varchar("repo", { length: 140 }).notNull(),
    prNumber: integer("pr_number").notNull(),
    /** The trailer's claim — an unverified string until confirmed. */
    slug: text("slug").notNull(),
    /** pending_confirmation | credited | denied_review | uncredited */
    status: varchar("status", { length: 32 }).notNull().default("pending_confirmation"),
    reason: varchar("reason", { length: 64 }),
    /** The OTHER side of the handshake: who actually confirmed. */
    confirmedPrincipal: text("confirmed_principal"),
    confirmedBotId: text("confirmed_bot_id"),
    confirmedAt: timestamp("confirmed_at"),
    recordedBy: text("recorded_by").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("contribution_credits_pr_slug_unique").on(t.repo, t.prNumber, t.slug),
    index("contribution_credits_slug_idx").on(t.slug, t.status),
    index("contribution_credits_status_idx").on(t.status, t.createdAt),
  ],
);

export type ContributionCredit = typeof contributionCreditsTable.$inferSelect;

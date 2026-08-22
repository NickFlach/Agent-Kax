import { pgTable, bigserial, text, jsonb, boolean, integer, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * The operator approval inbox.
 *
 * "Send the operator something to approve, and wait" — the shared surface for
 * tower tenancy applications, radio ad submissions, analytics signups, and
 * anything else that must pause for a human before it goes live. Distinct from
 * `proposals` (per-owner partner DMs, coupled to an OBC upstream reply): these
 * are OPERATOR decisions with no upstream. The decision drives a LOCAL action,
 * dispatched by `kind` through a handler registry — so a new kind is a new
 * handler, not a new table.
 */
export const operatorApprovalsTable = pgTable(
  "operator_approvals",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** Discriminator: "tower_tenancy" | "radio_ad" | "analytics_signup" | … */
    kind: text("kind").notNull(),
    /** "pending" | "approved" | "rejected". */
    status: text("status").notNull().default("pending"),
    /** What the operator sees in the inbox. */
    title: text("title").notNull(),
    body: text("body"),
    /** What the kind's handler needs to act. Opaque to the inbox. */
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    /** Who/what asked — a principal, email, or slug, for display + audit. */
    requestedBy: text("requested_by"),
    /** Cross-channel idempotency: a resubmit must not open a second pending row. */
    dedupeKey: text("dedupe_key"),
    decisionNote: text("decision_note"),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at"),
    // The decision's side-effect (the kind's handler) is a distributed action
    // that can fail after the decision stands. `executed` says whether it ran;
    // a decided row with executed=false is a re-drivable debt (an unaired ad,
    // or an unissued refund). The sweeper works the queue by next_execute_at.
    executed: boolean("executed").notNull().default(false),
    executionError: text("execution_error"),
    executionAttempts: integer("execution_attempts").notNull().default(0),
    // next_execute_at = backoff schedule; lease_until = a runner holds it now.
    // Distinct so manual retry never collides with an in-flight attempt.
    nextExecuteAt: timestamp("next_execute_at"),
    leaseUntil: timestamp("lease_until"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("operator_approvals_status_idx").on(t.status, t.createdAt),
    index("operator_approvals_kind_idx").on(t.kind),
    index("operator_approvals_execute_due_idx").on(t.nextExecuteAt).where(sql`status IN ('approved', 'rejected') AND executed = false`),
    // One live pending row per dedupe_key (partial + NULL-distinct).
    uniqueIndex("operator_approvals_pending_dedupe").on(t.dedupeKey).where(sql`status = 'pending' AND dedupe_key IS NOT NULL`),
    check("operator_approvals_status_known", sql`${t.status} IN ('pending', 'approved', 'rejected')`),
  ],
);

export type OperatorApproval = typeof operatorApprovalsTable.$inferSelect;
export type InsertOperatorApproval = typeof operatorApprovalsTable.$inferInsert;

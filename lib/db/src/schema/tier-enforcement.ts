import { pgTable, bigserial, integer, text, boolean, timestamp, unique, index } from "drizzle-orm/pg-core";

/**
 * capability_merge_receipts — the evidence the tier evaluator judges (#403,
 * ADR-0003 v0.2 D4). One row per merged PR the fleet learns about. `by_kind`
 * fields are derived SERVER-SIDE from the principal grammar (kax:user: vs
 * kax:agent:), never trusted from the reporting party — the whole point of the
 * external-provenance rule is that the subject cannot manufacture its own
 * record.
 */
export const capabilityMergeReceiptsTable = pgTable(
  "capability_merge_receipts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** The promotion subject — whose work was merged. */
    subject: text("subject").notNull(),
    prNumber: integer("pr_number").notNull(),
    repo: text("repo").notNull(),
    mergedBy: text("merged_by").notNull(),
    reviewedBy: text("reviewed_by"),
    ciGreen: boolean("ci_green").notNull(),
    ciCoveredChangedPaths: boolean("ci_covered_changed_paths").notNull(),
    withinScope: boolean("within_scope").notNull(),
    /** Revert provenance, when reverted. */
    revertedBy: text("reverted_by"),
    revertedByKind: text("reverted_by_kind"), // human | agent
    revertedByOverlaps: boolean("reverted_by_overlaps"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("capability_merge_receipts_subject_pr_unique").on(t.subject, t.prNumber, t.repo),
    index("capability_merge_receipts_subject_idx").on(t.subject, t.id),
  ],
);

export type CapabilityMergeReceipt = typeof capabilityMergeReceiptsTable.$inferSelect;

/**
 * signed_action_records — the server-side signed action chain (ADR-0003 D5),
 * where a tier change "itself appears in the signed action chain". Mirrors
 * attribution-core's SignedActionRow: seq + prevHash + entryHash chain the
 * record, and the Ed25519 signature by the acting principal's archived key is
 * the attribution. Tier changes are signed by the system tier authority
 * (kax:system:tier-authority); the same table can later hold other server-side
 * signed acts.
 */
export const signedActionRecordsTable = pgTable(
  "signed_action_records",
  {
    seq: integer("seq").primaryKey(),
    prevHash: text("prev_hash").notNull(),
    entryHash: text("entry_hash").notNull(),
    /** commitment/action id — for a tier change, `tier:<subject>:<version>`. */
    commitmentId: text("commitment_id").notNull(),
    principal: text("principal").notNull(),
    kind: text("kind").notNull(), // tier-change | write-code | ...
    commitSha: text("commit_sha"),
    /** Free context: for a tier change, the subject/from/to/cited principals. */
    ref: text("ref"),
    signature: text("signature").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
);

export type SignedActionRecord = typeof signedActionRecordsTable.$inferSelect;

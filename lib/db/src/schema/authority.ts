import { pgTable, bigserial, bigint, integer, jsonb, text, timestamp, varchar, index, unique, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * authority_decisions — the immutable decision record of the Agent Economic
 * Authority (KAX-ADR-0001, issue #247). Phase 1a: the record exists, DARK —
 * no code writes it until #248 wires the first writer, and no policy engine
 * exists yet (policyId is a bare bigint until Phase 1b adds the FK).
 *
 * Append-only via a DB trigger (migration 0034): a recorded decision is
 * history; corrections are new superseding rows. capability / decision /
 * reason_code are varchar rather than pgEnum on purpose — an enum turns every
 * new reason code into a migration, and reason codes grow in hotfixes.
 */
export const authorityDecisionsTable = pgTable(
  "authority_decisions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    decisionId: text("decision_id").notNull().unique(),
    /** The principal that acted, in lib/actor.ts's canonical spelling. */
    actor: text("actor").notNull(),
    /** Set when a service acts for a principal. */
    onBehalfOf: text("on_behalf_of"),
    /** The authorizing owner, when known. */
    principal: text("principal"),
    capability: varchar("capability", { length: 64 }).notNull(),
    resource: text("resource"),
    channel: varchar("channel", { length: 32 }),
    asset: text("asset"),
    amountMinor: bigint("amount_minor", { mode: "bigint" }),
    /** allow | deny | require_approval */
    decision: varchar("decision", { length: 24 }).notNull(),
    /** policy_missing | principal_unparseable | revoked | ... */
    reasonCode: varchar("reason_code", { length: 48 }),
    txId: text("tx_id"),
    postingsHash: text("postings_hash"),
    /** Null in Phase 1a; becomes an FK when the policies table lands (1b). */
    policyId: bigint("policy_id", { mode: "number" }),
    policyDocumentHash: text("policy_document_hash"),
    correlationId: text("correlation_id"),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("authority_decisions_actor_idx").on(t.actor, t.createdAt.desc()),
    index("authority_decisions_tx_idx").on(t.txId),
  ],
);

export type AuthorityDecision = typeof authorityDecisionsTable.$inferSelect;
export type InsertAuthorityDecision = typeof authorityDecisionsTable.$inferInsert;

/**
 * authority_policies — Phase 1b (#266): immutable rows, one per version.
 * Edits INSERT a new row and stamp superseded_at on the prior one; the DB
 * trigger (migration 0041) permits exactly that transition and nothing else.
 * Decisions reference the ROW (policy_id, now a real FK) plus document_hash,
 * because an integer version alone cannot prove which document authorized a
 * historical action.
 */
export const authorityPoliciesTable = pgTable(
  "authority_policies",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** lib/actor.ts's spelling, collapsed via botIdOfPrincipal — derived nowhere else. */
    principal: text("principal").notNull(),
    version: integer("version").notNull(),
    document: jsonb("document").notNull(),
    /** sha256 of the canonical (sorted-key) document. */
    documentHash: text("document_hash").notNull(),
    effectiveFrom: timestamp("effective_from").notNull().defaultNow(),
    /** NULL = the current version. */
    supersededAt: timestamp("superseded_at"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [unique("authority_policies_principal_version_unique").on(t.principal, t.version)],
);

export type AuthorityPolicy = typeof authorityPoliciesTable.$inferSelect;

/**
 * authority_usage — one row per (principal, capability, asset, discrete
 * window). Incremented under a ROW-LEVEL lock on this row, never under the
 * ledger's advisory lock, so cap accounting does not serialize behind every
 * unrelated append.
 */
export const authorityUsageTable = pgTable(
  "authority_usage",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    principal: text("principal").notNull(),
    capability: varchar("capability", { length: 64 }).notNull(),
    asset: text("asset").notNull(),
    /** 'day:2026-08-18' | 'month:2026-08' — UTC, discrete. */
    windowKey: text("window_key").notNull(),
    usedMinor: bigint("used_minor", { mode: "bigint" }).notNull().default(0n),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("authority_usage_window_unique").on(t.principal, t.capability, t.asset, t.windowKey)],
);

export type AuthorityUsage = typeof authorityUsageTable.$inferSelect;

/**
 * authority_reservations — reserved -> submitted -> outcome_unknown ->
 * committed | released. Carries the exact canonical posting array to be
 * reproduced byte-for-byte on commit (canonicalPostingsHash is order-, asset-
 * and ref-sensitive; a differing retry raises LedgerIdempotencyConflict).
 * An outcome_unknown row keeps consuming cap headroom until reconciled.
 */
export const authorityReservationsTable = pgTable(
  "authority_reservations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    reservationId: text("reservation_id").notNull(),
    usageId: bigint("usage_id", { mode: "number" })
      .notNull()
      .references(() => authorityUsageTable.id),
    principal: text("principal").notNull(),
    capability: varchar("capability", { length: 64 }).notNull(),
    asset: text("asset").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    state: varchar("state", { length: 24 }).notNull().default("reserved"),
    txId: text("tx_id"),
    postings: jsonb("postings").notNull(),
    postingsHash: text("postings_hash").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("authority_reservations_reservation_id_key").on(t.reservationId),
    index("authority_reservations_state_idx").on(t.state, t.createdAt),
  ],
);

export type AuthorityReservation = typeof authorityReservationsTable.$inferSelect;

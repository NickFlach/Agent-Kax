import { pgTable, bigserial, bigint, text, timestamp, varchar, index } from "drizzle-orm/pg-core";

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

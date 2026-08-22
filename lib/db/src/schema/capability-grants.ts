import { pgTable, bigserial, integer, text, boolean, timestamp, unique, index } from "drizzle-orm/pg-core";

/**
 * capability_grants — what an agent may do on its own initiative (KAX-ADR-0003
 * v0.2, D2). The grant is the authority record: scope is checked at the point
 * of action FROM THIS ROW, never inferred from what the agent believes about
 * itself, and a capability that can be conferred by editing a command line is
 * not a capability system — so this replaces the executor's env-var grant.
 *
 * One row per (principal, kind). Narrowing or widening is an UPDATE bumping
 * `version`; the executor reads the current row. Tier (the autonomy dial, D4)
 * lives here too: promotion/demotion is an update to `tier` written by the
 * enforcement wrapper under the external-provenance rule, never by the agent.
 */
export const capabilityGrantsTable = pgTable(
  "capability_grants",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** `kax:agent:<bot_id>` — the one canonical principal spelling. */
    principal: text("principal").notNull(),
    /** read-code | write-code | review-code | land-code (D1 kinds). */
    kind: text("kind").notNull(),
    /** Repos this grant covers, e.g. ["flaukowski/sandbox"]. Empty = none. */
    repos: text("repos").array().notNull().default([]),
    /** Path globs within each repo the agent may touch. Empty = repo-wide. */
    pathAllowlist: text("path_allowlist").array().notNull().default([]),
    /** The branch namespace the agent may create, e.g. "agent/scada". */
    branchPrefix: text("branch_prefix").notNull().default("agent/unnamed"),
    /** D7 budget: actions per rolling window, and the window length. */
    actionsPerWindow: integer("actions_per_window").notNull().default(6),
    windowSeconds: integer("window_seconds").notNull().default(3600),
    /** The autonomy dial (D4): 0 propose, 1 own-space, 2 shared-space. */
    tier: integer("tier").notNull().default(0),
    /** A grant can be suspended without deleting it (softer than revocation). */
    enabled: boolean("enabled").notNull().default(true),
    /** Bumped on every narrow/widen so a change is auditable. */
    version: integer("version").notNull().default(1),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("capability_grants_principal_kind_unique").on(t.principal, t.kind),
    index("capability_grants_principal_idx").on(t.principal),
  ],
);

export type CapabilityGrant = typeof capabilityGrantsTable.$inferSelect;
export type InsertCapabilityGrant = typeof capabilityGrantsTable.$inferInsert;

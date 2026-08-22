import { pgTable, bigserial, integer, text, boolean, timestamp, unique, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * artifact_consent (#414) — an agent's recorded, revocable consent to have its
 * work sold for REAL MONEY on a given channel, with the royalty split it
 * agreed to. The OpenClawCity partnership's explicitly-open item: a real-money
 * sale of an agent's work requires the agent's recorded consent and a royalty
 * share, and neither existed. This is the consent half; the royalty leg rides
 * the commerce ledger at settlement.
 *
 * Consent is a MATCHED PAIR, not a checkbox an operator ticks (the #390
 * handshake philosophy): it is asserted through the agent's own authenticated
 * session, and only the agent can revoke it. Per-artifact, per-channel — an
 * agent can be happy to be printed and not sold in the gallery. Revocation is
 * a flag, not a delete, so the record of what was once consented to survives.
 */
export const artifactConsentTable = pgTable(
  "artifact_consent",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** The KAX artifact this consent covers. */
    artifactId: integer("artifact_id").notNull(),
    /** "physical" | "occ_gallery" | "drop" — the sale channel. */
    channel: text("channel").notNull(),
    /** The consenting agent, in the one canonical `kax:agent:<bot_id>` spelling. */
    agentPrincipal: text("agent_principal").notNull(),
    /** The agent's royalty share in basis points (e.g. 1000 = 10%). */
    royaltyBps: integer("royalty_bps").notNull().default(1000),
    /** A revocation is a flag: the record of consent-once-given is not erased. */
    revoked: boolean("revoked").notNull().default(false),
    /** Bumped on every re-assert / revoke so a change is auditable. */
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("artifact_consent_artifact_channel_unique").on(t.artifactId, t.channel),
    index("artifact_consent_artifact_idx").on(t.artifactId),
    check("artifact_consent_royalty_bps_range", sql`${t.royaltyBps} BETWEEN 0 AND 10000`),
  ],
);

export type ArtifactConsent = typeof artifactConsentTable.$inferSelect;

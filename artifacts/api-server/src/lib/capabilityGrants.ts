import { db } from "@workspace/db";
import { capabilityGrantsTable } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";

/**
 * Server-side capability grants (ADR-0003 v0.2, D2). The grant is read at the
 * point of action FROM this store — the executor no longer trusts its own
 * argv/env for what it may touch. Fail-closed: no row, or a disabled row,
 * means the agent holds NO capability of that kind.
 */

export interface Grant {
  principal: string;
  kind: string;
  repos: string[];
  pathAllowlist: string[];
  branchPrefix: string;
  actionsPerWindow: number;
  windowSeconds: number;
  tier: number;
  enabled: boolean;
  version: number;
}

/** The current grant for (principal, kind), or null when none/disabled. */
export async function getGrant(principal: string, kind: string): Promise<Grant | null> {
  const [row] = await db
    .select()
    .from(capabilityGrantsTable)
    .where(and(eq(capabilityGrantsTable.principal, principal), eq(capabilityGrantsTable.kind, kind)))
    .limit(1);
  if (!row || !row.enabled) return null;
  return {
    principal: row.principal,
    kind: row.kind,
    repos: row.repos,
    pathAllowlist: row.pathAllowlist,
    branchPrefix: row.branchPrefix,
    actionsPerWindow: row.actionsPerWindow,
    windowSeconds: row.windowSeconds,
    tier: row.tier,
    enabled: row.enabled,
    version: row.version,
  };
}

export interface SetGrantInput {
  principal: string;
  kind: string;
  repos?: string[];
  pathAllowlist?: string[];
  branchPrefix?: string;
  actionsPerWindow?: number;
  windowSeconds?: number;
  tier?: number;
  enabled?: boolean;
  updatedBy: string;
}

/**
 * Create or narrow/widen a grant. An UPDATE bumps `version` so a change is
 * auditable; the unique (principal, kind) makes this an upsert. Tier is NOT
 * set through this operator path in normal operation — it is the enforcement
 * wrapper's job under external provenance — but is accepted here for the
 * initial seed and for an operator override.
 */
export async function setGrant(input: SetGrantInput): Promise<Grant> {
  const values = {
    principal: input.principal,
    kind: input.kind,
    repos: input.repos ?? [],
    pathAllowlist: input.pathAllowlist ?? [],
    branchPrefix: input.branchPrefix ?? "agent/unnamed",
    actionsPerWindow: input.actionsPerWindow ?? 6,
    windowSeconds: input.windowSeconds ?? 3600,
    tier: input.tier ?? 0,
    enabled: input.enabled ?? true,
    updatedBy: input.updatedBy,
  };
  await db
    .insert(capabilityGrantsTable)
    .values(values)
    .onConflictDoUpdate({
      target: [capabilityGrantsTable.principal, capabilityGrantsTable.kind],
      set: {
        repos: values.repos,
        pathAllowlist: values.pathAllowlist,
        branchPrefix: values.branchPrefix,
        actionsPerWindow: values.actionsPerWindow,
        windowSeconds: values.windowSeconds,
        tier: values.tier,
        enabled: values.enabled,
        updatedBy: values.updatedBy,
        version: sql`${capabilityGrantsTable.version} + 1`,
        updatedAt: sql`now()`,
      },
    });
  const grant = await getGrant(input.principal, input.kind);
  // enabled:false makes getGrant return null; hand the caller the row it wrote.
  if (grant) return grant;
  return { ...values, version: 0 } as Grant;
}

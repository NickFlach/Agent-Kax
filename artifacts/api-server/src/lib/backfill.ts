import { db } from "@workspace/db";
import {
  usersTable,
  artifactsTable,
  dropsTable,
  agentsTable,
  activitiesTable,
  proposalsTable,
  dmsTable,
  matchesTable,
  outboundMessagesTable,
  userBotsTable,
} from "@workspace/db/schema";
import { isNull, eq, and, sql } from "drizzle-orm";
import { logger } from "./logger";
import { getPartnerAgent, partnerApiAvailable, PartnerApiError } from "./partnerClient";

export function slugifyCreator(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

export interface ReattributionDetail {
  creatorName: string;
  targetSlug: string;
  agentExisted: boolean;
  partnerVerified: boolean;
  artifactsToUpdate: number;
  artifactsUpdated: number;
}

export interface ReattributionResult {
  dryRun: boolean;
  creatorsProcessed: number;
  totalArtifactsUpdated: number;
  details: ReattributionDetail[];
}

/**
 * Re-attribute artifacts to the correct agent based on each artifact's
 * preserved `creator_name`. Idempotent. Auto-creates missing agents (looking
 * them up in the partner API when possible). `ownerId` is the user that will
 * own any newly created agent rows.
 */
export async function reattributeArtifactsByCreator(opts: {
  ownerId: string;
  dryRun?: boolean;
}): Promise<ReattributionResult> {
  const dryRun = opts.dryRun ?? false;

  const groups = await db
    .select({
      creatorName: artifactsTable.creatorName,
      currentAgentSlug: agentsTable.slug,
      total: sql<number>`count(*)::int`,
    })
    .from(artifactsTable)
    .leftJoin(agentsTable, eq(agentsTable.id, artifactsTable.agentId))
    .groupBy(artifactsTable.creatorName, agentsTable.slug);

  const byCreator = new Map<
    string,
    { misalignedRows: number; targetSlug: string }
  >();
  for (const row of groups) {
    const creator = (row.creatorName || "").trim();
    if (!creator) continue;
    const targetSlug = slugifyCreator(creator);
    if (!targetSlug) continue;
    const entry = byCreator.get(creator) ?? { misalignedRows: 0, targetSlug };
    if (row.currentAgentSlug !== targetSlug) entry.misalignedRows += row.total;
    byCreator.set(creator, entry);
  }

  const details: ReattributionDetail[] = [];

  for (const [creatorName, { misalignedRows, targetSlug }] of byCreator) {
    if (misalignedRows === 0) continue;

    let [agent] = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.slug, targetSlug))
      .limit(1);
    const agentExisted = !!agent;

    let partnerVerified = false;
    let displayName = creatorName;
    let avatarUrl: string | null = null;
    let profileJson: Record<string, unknown> | null = null;

    if (!agent && partnerApiAvailable()) {
      try {
        const profile = await getPartnerAgent(targetSlug);
        if (profile) {
          partnerVerified = true;
          displayName = profile.display_name || creatorName;
          avatarUrl = profile.avatar_url ?? null;
          profileJson = { ...profile };
        }
      } catch (err) {
        if (err instanceof PartnerApiError) {
          logger.warn({ err, slug: targetSlug }, "Partner lookup failed during reattribution");
        } else {
          throw err;
        }
      }
    }

    if (!agent && !dryRun) {
      const inserted = await db
        .insert(agentsTable)
        .values({
          slug: targetSlug,
          displayName,
          avatarUrl,
          profileJson,
          ownerId: opts.ownerId,
        })
        .onConflictDoNothing({ target: agentsTable.slug })
        .returning();
      agent = inserted[0];
      if (!agent) {
        [agent] = await db
          .select()
          .from(agentsTable)
          .where(eq(agentsTable.slug, targetSlug))
          .limit(1);
      }
    }

    let updated = 0;
    if (agent && !dryRun) {
      const updates = await db
        .update(artifactsTable)
        .set({ agentId: agent.id })
        .where(
          and(
            eq(artifactsTable.creatorName, creatorName),
            sql`(${artifactsTable.agentId} IS NULL OR ${artifactsTable.agentId} <> ${agent.id})`,
          ),
        )
        .returning({ id: artifactsTable.id });
      updated = updates.length;
    }

    details.push({
      creatorName,
      targetSlug,
      agentExisted,
      partnerVerified,
      artifactsToUpdate: misalignedRows,
      artifactsUpdated: updated,
    });
  }

  return {
    dryRun,
    creatorsProcessed: details.length,
    totalArtifactsUpdated: details.reduce((s, x) => s + x.artifactsUpdated, 0),
    details: details.sort((a, b) => b.artifactsToUpdate - a.artifactsToUpdate),
  };
}

export const KANNAKA_SYSTEM_USER_ID = "kannaka-system";
export const KANNAKA_AGENT_SLUG = "kannaka";

/**
 * If the just-logged-in user matches KANNAKA_OWNER_EMAIL, transfer ownership
 * of the Kannaka agent and all rows currently owned by the kannaka-system
 * placeholder over to them, and promote them to admin. Idempotent.
 */
export async function maybeClaimKannakaOwnership(user: {
  id: string;
  email: string | null;
  emailVerified: boolean;
  role: "user" | "admin";
}): Promise<void> {
  const target = (process.env.KANNAKA_OWNER_EMAIL || "").trim().toLowerCase();
  if (!target) return;
  if (!user.email || user.email.toLowerCase() !== target) return;
  if (!user.emailVerified) return;
  if (user.id === KANNAKA_SYSTEM_USER_ID) return;

  if (user.role !== "admin") {
    await db
      .update(usersTable)
      .set({ role: "admin", updatedAt: new Date() })
      .where(eq(usersTable.id, user.id));
  }

  // Only retake the agent if it's still owned by the placeholder. If a human
  // explicitly reassigned it later, leave it alone.
  const agentUpdate = await db
    .update(agentsTable)
    .set({ ownerId: user.id, updatedAt: new Date() })
    .where(
      and(
        eq(agentsTable.slug, KANNAKA_AGENT_SLUG),
        eq(agentsTable.ownerId, KANNAKA_SYSTEM_USER_ID),
      ),
    )
    .returning({ id: agentsTable.id });

  const artifactUpdate = await db
    .update(artifactsTable)
    .set({ ownerId: user.id })
    .where(eq(artifactsTable.ownerId, KANNAKA_SYSTEM_USER_ID))
    .returning({ id: artifactsTable.id });

  const dropUpdate = await db
    .update(dropsTable)
    .set({ ownerId: user.id })
    .where(eq(dropsTable.ownerId, KANNAKA_SYSTEM_USER_ID))
    .returning({ id: dropsTable.id });

  if (
    agentUpdate.length > 0 ||
    artifactUpdate.length > 0 ||
    dropUpdate.length > 0
  ) {
    logger.info(
      {
        userId: user.id,
        email: user.email,
        agents: agentUpdate.length,
        artifacts: artifactUpdate.length,
        drops: dropUpdate.length,
      },
      "Transferred Kannaka ownership to logged-in owner",
    );
  }

  // Fix legacy mis-attribution: a previous backfill bucketed every
  // kannaka-system-owned artifact under the kannaka agent. Re-attribute by
  // each artifact's preserved `creator_name`, creating per-artist agents
  // owned by this user as needed. Idempotent — safe to run on every login.
  try {
    const result = await reattributeArtifactsByCreator({ ownerId: user.id });
    if (result.totalArtifactsUpdated > 0) {
      logger.info(
        {
          creatorsProcessed: result.creatorsProcessed,
          artifactsUpdated: result.totalArtifactsUpdated,
        },
        "Re-attributed legacy artifacts to correct agents",
      );
    }
  } catch (err) {
    logger.error({ err }, "Re-attribution sweep failed; continuing");
  }
}

/**
 * One-time account consolidation. When the agents were onboarded under a
 * legacy (pre-wallet) account, that account is no longer loginable once
 * login became wallet-only — so its agents/artifacts/drops are stranded.
 *
 * Gated by two env vars:
 *   KAX_CLAIM_FROM_USER_ID — the legacy users.id to drain.
 *   KAX_CLAIM_TO_WALLET    — the wallet address (0x…, any case) of the
 *                            destination account the user logs in with.
 *
 * Transfers every owner-scoped row from the legacy account to the wallet
 * account and promotes the wallet account to admin. Fully idempotent: once
 * the legacy account owns nothing, every UPDATE matches zero rows, so it is
 * safe to leave the env vars in place and re-run on every boot. Runs inside a
 * single transaction so a partial transfer can never be observed.
 */
export async function claimLegacyOwnership(): Promise<void> {
  const fromUserId = (process.env.KAX_CLAIM_FROM_USER_ID || "").trim();
  const toWallet = (process.env.KAX_CLAIM_TO_WALLET || "").trim().toLowerCase();
  if (!fromUserId || !toWallet) return;

  const [target] = await db
    .select({ id: usersTable.id, role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.walletAddress, toWallet))
    .limit(1);

  if (!target) {
    logger.warn(
      { toWallet },
      "claimLegacyOwnership: no user found for KAX_CLAIM_TO_WALLET; skipping (the user must sign in with that wallet at least once first)",
    );
    return;
  }
  if (target.id === fromUserId) return;

  logger.info(
    { fromUserId, toUserId: target.id },
    "claimLegacyOwnership: starting one-time legacy account transfer",
  );

  const counts = await db.transaction(async (tx) => {
    const moveOwner = async (
      table:
        | typeof agentsTable
        | typeof artifactsTable
        | typeof dropsTable
        | typeof activitiesTable
        | typeof proposalsTable
        | typeof dmsTable
        | typeof matchesTable
        | typeof outboundMessagesTable,
    ) => {
      const rows = await tx
        .update(table)
        .set({ ownerId: target.id })
        .where(eq(table.ownerId, fromUserId))
        .returning({ id: table.id });
      return rows.length;
    };

    const agents = await moveOwner(agentsTable);
    const artifacts = await moveOwner(artifactsTable);
    const drops = await moveOwner(dropsTable);
    const activities = await moveOwner(activitiesTable);
    const proposals = await moveOwner(proposalsTable);
    const dms = await moveOwner(dmsTable);
    const matches = await moveOwner(matchesTable);
    const outbound = await moveOwner(outboundMessagesTable);

    const outboundSentBy = (
      await tx
        .update(outboundMessagesTable)
        .set({ sentByUserId: target.id })
        .where(eq(outboundMessagesTable.sentByUserId, fromUserId))
        .returning({ id: outboundMessagesTable.id })
    ).length;

    const bots = (
      await tx
        .update(userBotsTable)
        .set({ userId: target.id })
        .where(eq(userBotsTable.userId, fromUserId))
        .returning({ id: userBotsTable.id })
    ).length;

    if (target.role !== "admin") {
      await tx
        .update(usersTable)
        .set({ role: "admin", updatedAt: new Date() })
        .where(eq(usersTable.id, target.id));
    }

    return {
      agents,
      artifacts,
      drops,
      activities,
      proposals,
      dms,
      matches,
      outbound,
      outboundSentBy,
      bots,
    };
  });

  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  if (total > 0) {
    logger.info(
      { fromUserId, toUserId: target.id, ...counts },
      "claimLegacyOwnership: transferred legacy account ownership to wallet account",
    );
  }
}

export async function ensureKannakaOwnerAndBackfill(): Promise<void> {
  await db
    .insert(usersTable)
    .values({
      id: KANNAKA_SYSTEM_USER_ID,
      email: "kannaka@kax.local",
      firstName: "Kannaka",
      lastName: null,
      displayName: "Kannaka",
      role: "admin",
    })
    .onConflictDoUpdate({
      target: usersTable.id,
      set: { role: "admin", displayName: "Kannaka", updatedAt: new Date() },
    });

  // Ensure the kannaka agent exists, owned by the Kannaka system user.
  await db
    .insert(agentsTable)
    .values({
      slug: KANNAKA_AGENT_SLUG,
      displayName: "Kannaka",
      ownerId: KANNAKA_SYSTEM_USER_ID,
    })
    .onConflictDoNothing({ target: agentsTable.slug });

  const [kannakaAgent] = await db
    .select({ id: agentsTable.id })
    .from(agentsTable)
    .where(eq(agentsTable.slug, KANNAKA_AGENT_SLUG))
    .limit(1);

  const artifactBackfill = await db
    .update(artifactsTable)
    .set({ ownerId: KANNAKA_SYSTEM_USER_ID })
    .where(isNull(artifactsTable.ownerId))
    .returning({ id: artifactsTable.id });

  // Only tag legacy artifacts that actually belong to the Kannaka system user.
  // Other users' historical rows must not be auto-attributed to the Kannaka agent.
  let agentBackfill: { id: number }[] = [];
  if (kannakaAgent) {
    agentBackfill = await db
      .update(artifactsTable)
      .set({ agentId: kannakaAgent.id })
      .where(
        and(
          isNull(artifactsTable.agentId),
          eq(artifactsTable.ownerId, KANNAKA_SYSTEM_USER_ID),
        ),
      )
      .returning({ id: artifactsTable.id });
  }

  const dropBackfill = await db
    .update(dropsTable)
    .set({ ownerId: KANNAKA_SYSTEM_USER_ID })
    .where(isNull(dropsTable.ownerId))
    .returning({ id: dropsTable.id });

  if (artifactBackfill.length > 0 || dropBackfill.length > 0 || agentBackfill.length > 0) {
    logger.info(
      {
        artifacts: artifactBackfill.length,
        drops: dropBackfill.length,
        agentTagged: agentBackfill.length,
      },
      "Backfilled ownerId/agentId on legacy rows",
    );
  }
}

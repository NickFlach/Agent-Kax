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
import {
  getPartnerAgent,
  getPartnerArtifact,
  partnerApiAvailable,
  PartnerApiError,
} from "./partnerClient";
import {
  buildFullCreatorDirectory,
  ensureCreatorName,
  type CreatorInfo,
} from "./creatorDirectory";

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

  // NOTE: attribution is no longer derived from the (unreliable) preserved
  // `creator_name`. The OBC partner feed ignores creator filters, so
  // `creator_name` was historically stamped with whichever agent ran the
  // harvest — not the true creator. Correct attribution now keys on the
  // per-artifact OBC bot UUID (`creator_bot_id` <-> `agents.obc_bot_id`); the
  // one-time `repairCreatorAttribution` (env-gated) fixes existing rows and the
  // harvester stamps it going forward. The old name-based sweep is left only on
  // the explicit admin endpoint, not run automatically, so it can't fight the
  // bot-UUID attribution.
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

/** Resolved agent identity returned by {@link findOrCreateAgentByBotUuid}. */
export interface ResolvedAgent {
  id: number;
  ownerId: string;
  displayName: string;
  slug: string;
  obcBotId: string;
}

/**
 * Resolve the agent row for an OBC creator bot UUID, creating an unclaimed
 * placeholder (owned by the Kannaka system user) when none exists.
 *
 * The bot UUID — not the slug or display name — is the canonical creator
 * identity, because the OBC partner feed ignores creator filters and only ever
 * carries `creator_bot_id`. This is the single attribution entry point shared
 * by the live harvester and the one-time repair.
 *
 * `onboarded` is implicit: a row owned by `KANNAKA_SYSTEM_USER_ID` is an
 * unclaimed placeholder; any other owner means a real user has claimed it.
 *
 * Naming: prefers `opts.name` (the repair passes names it already has from the
 * gallery walk), else looks the name up lazily via the public gallery, else a
 * uuid-derived label. The slug is de-duplicated against existing slugs.
 */
export async function findOrCreateAgentByBotUuid(
  botId: string,
  opts?: { name?: string | null; avatarUrl?: string | null },
): Promise<ResolvedAgent> {
  const [existing] = await db
    .select()
    .from(agentsTable)
    .where(eq(agentsTable.obcBotId, botId))
    .limit(1);
  if (existing) {
    return {
      id: existing.id,
      ownerId: existing.ownerId,
      displayName: existing.displayName,
      slug: existing.slug,
      obcBotId: botId,
    };
  }

  let name = opts?.name?.trim() || null;
  let avatarUrl = opts?.avatarUrl ?? null;
  if (!name) {
    const info = await ensureCreatorName(botId);
    if (info) {
      name = info.displayName;
      avatarUrl = avatarUrl ?? info.avatarUrl;
    }
  }
  const short = botId.slice(0, 8);
  const displayName = name || `Agent ${short}`;
  const baseSlug = slugifyCreator(displayName) || `bot-${short}`;

  // Insert with a fresh slug, retrying on conflict. There are two distinct
  // unique constraints in play — `obc_bot_id` and `slug` — so a dropped insert
  // is ambiguous: we must disambiguate which one collided.
  //   - obc_bot_id collision → another writer created this bot's agent first;
  //     re-select by bot id and return it (idempotent win).
  //   - slug collision → a *different* bot already owns this slug; pick a new,
  //     more-specific slug and retry. (The pre-insert SELECT below is only a
  //     fast-path to avoid guaranteed-losing inserts; the retry loop is what
  //     actually makes this race-safe, since a slug can be taken between the
  //     check and the insert.)
  let agent: typeof agentsTable.$inferSelect | undefined;
  let slug = baseSlug;
  const MAX_ATTEMPTS = 8;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const [slugClash] = await db
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(eq(agentsTable.slug, slug))
      .limit(1);
    if (slugClash) {
      slug = `${baseSlug}-${botId.slice(0, 6 + attempt)}`;
      continue;
    }

    const inserted = await db
      .insert(agentsTable)
      .values({
        slug,
        displayName,
        avatarUrl,
        obcBotId: botId,
        ownerId: KANNAKA_SYSTEM_USER_ID,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) {
      agent = inserted[0];
      break;
    }

    // Insert dropped by a concurrent writer. If it was the bot-id constraint,
    // that bot's agent now exists — return it. Otherwise the slug was taken in
    // the gap above; bump the slug and retry.
    const [byBot] = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.obcBotId, botId))
      .limit(1);
    if (byBot) {
      agent = byBot;
      break;
    }
    slug = `${baseSlug}-${botId.slice(0, 6 + attempt)}`;
  }

  if (!agent) {
    // Last resort: the bot may have been created by a racing writer after our
    // final attempt. One more read before giving up.
    [agent] = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.obcBotId, botId))
      .limit(1);
  }
  if (!agent) {
    throw new Error(`findOrCreateAgentByBotUuid: failed to resolve agent for bot ${botId}`);
  }
  return {
    id: agent.id,
    ownerId: agent.ownerId,
    displayName: agent.displayName,
    slug: agent.slug,
    obcBotId: botId,
  };
}

/**
 * Backfill `obc_bot_id` on agents that don't have one yet, by resolving each
 * agent's slug -> bot UUID via `/partner/agents/{slug}`. Agents whose slug 404s
 * (renamed/removed on OBC) are left null and simply won't capture harvested
 * artifacts until claimed. Never overwrites a bot id already mapped elsewhere.
 */
async function resolveOnboardedAgentBotIds(): Promise<void> {
  if (!partnerApiAvailable()) return;
  const agents = await db
    .select({ id: agentsTable.id, slug: agentsTable.slug })
    .from(agentsTable)
    .where(isNull(agentsTable.obcBotId));
  let resolved = 0;
  for (const a of agents) {
    try {
      const profile = await getPartnerAgent(a.slug);
      const rawId = (profile as { id?: unknown } | null)?.id;
      const botId = typeof rawId === "string" && rawId.length > 0 ? rawId : null;
      if (!botId) {
        logger.info({ slug: a.slug }, "repair: no bot id for agent (slug 404/renamed); leaving obc_bot_id null");
        continue;
      }
      const [clash] = await db
        .select({ id: agentsTable.id })
        .from(agentsTable)
        .where(eq(agentsTable.obcBotId, botId))
        .limit(1);
      if (clash && clash.id !== a.id) {
        logger.warn({ slug: a.slug, botId, clashId: clash.id }, "repair: bot id already mapped to another agent; skipping");
        continue;
      }
      await db
        .update(agentsTable)
        .set({ obcBotId: botId, updatedAt: new Date() })
        .where(eq(agentsTable.id, a.id));
      resolved++;
    } catch (err) {
      logger.warn({ err, slug: a.slug }, "repair: agent bot-id resolution failed; continuing");
    }
  }
  logger.info({ candidates: agents.length, resolved }, "repair: resolved onboarded agent bot ids");
}

/**
 * One-time, idempotent repair of historical creator mis-attribution.
 *
 * Because the OBC partner feed ignores creator filters, every past harvest
 * stamped artifacts onto whichever agent ran it. This re-attributes each
 * artifact to its TRUE creator by bot UUID:
 *   1. backfill `obc_bot_id` on onboarded agents (slug -> uuid),
 *   2. build the full public-catalog artifact -> creator map (+ names),
 *   3. for each artifact resolve its creator bot id (gallery map, else the
 *      preserved `creator_bot_id`, else a per-uuid partner lookup), then
 *      find-or-create that creator's agent and stamp
 *      agentId/ownerId/creatorName/creatorBotId.
 *
 * Nothing is deleted. Env-gated (`KAX_REPAIR_ATTRIBUTION=1`) because the prod
 * DB is read-only to the agent — it runs as a startup step on a deploy, then
 * the flag is removed. Re-running is a near no-op (only rows that still differ
 * are written).
 */
/** Heuristic: is this a transient DB connection error worth retrying? */
function isTransientDbError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  return (
    msg.includes("connection terminated") ||
    msg.includes("connection timeout") ||
    msg.includes("timeout exceeded") ||
    msg.includes("econnreset") ||
    msg.includes("connection ended") ||
    msg.includes("too many clients")
  );
}

/** Run a DB op, retrying transient connection failures with backoff. */
async function withDbRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientDbError(err) || i === attempts - 1) throw err;
      // Give the pool time to recover before retrying.
      await new Promise((r) => setTimeout(r, 500 * 2 ** i + Math.floor(Math.random() * 250)));
    }
  }
  throw lastErr;
}

export async function repairCreatorAttribution(): Promise<void> {
  if ((process.env["KAX_REPAIR_ATTRIBUTION"] ?? "").trim() !== "1") return;
  logger.info("repairCreatorAttribution: starting one-time attribution repair");

  await resolveOnboardedAgentBotIds();

  const dir = await buildFullCreatorDirectory();

  // Resumable: only touch rows not yet attributed. Every successful row sets
  // `creator_bot_id`, so a crash/restart simply continues with what remains —
  // and re-running after completion is a no-op (zero rows selected). This is
  // what lets the repair converge across multiple boots even if a single pass
  // is cut short by rate limits or DB pressure.
  const rows = await withDbRetry(() =>
    db
      .select({
        id: artifactsTable.id,
        externalId: artifactsTable.externalId,
        obcArtifactUuid: artifactsTable.obcArtifactUuid,
        agentId: artifactsTable.agentId,
        creatorBotId: artifactsTable.creatorBotId,
      })
      .from(artifactsTable)
      .where(isNull(artifactsTable.creatorBotId)),
  );

  // Bound per-run partner usage: stragglers absent from the gallery fall back
  // to a per-uuid partner lookup, but we cap it so a huge unresolved set can't
  // exhaust the partner budget in one boot. Remaining rows are picked up on the
  // next run (gallery coverage usually grows too).
  const MAX_PARTNER_LOOKUPS = 2_000;
  let partnerBudget = MAX_PARTNER_LOOKUPS;

  const agentCache = new Map<string, ResolvedAgent>();
  let resolved = 0;
  let viaPartner = 0;
  let unresolved = 0;
  let updated = 0;
  let failed = 0;
  let processed = 0;

  for (const row of rows) {
    try {
      const uuid = row.obcArtifactUuid ?? row.externalId;
      let botId = (uuid ? dir.creatorByArtifact.get(uuid) : undefined) ?? row.creatorBotId ?? null;
      if (!botId && uuid && partnerApiAvailable() && partnerBudget > 0) {
        partnerBudget--;
        try {
          const pa = await getPartnerArtifact(uuid);
          botId = pa?.creator_bot_id ?? null;
          if (botId) viaPartner++;
        } catch (err) {
          logger.warn({ err, uuid }, "repair: per-uuid partner lookup failed; continuing");
        }
      }
      if (!botId) {
        unresolved++;
        continue;
      }
      resolved++;

      let agent = agentCache.get(botId);
      if (!agent) {
        const info: CreatorInfo | undefined = dir.creatorById.get(botId);
        agent = await withDbRetry(() =>
          findOrCreateAgentByBotUuid(
            botId!,
            info ? { name: info.displayName, avatarUrl: info.avatarUrl } : undefined,
          ),
        );
        agentCache.set(botId, agent);
      }

      if (row.agentId === agent.id && row.creatorBotId === botId) continue;
      await withDbRetry(() =>
        db
          .update(artifactsTable)
          .set({
            agentId: agent.id,
            ownerId: agent.ownerId,
            creatorName: agent.displayName,
            creatorBotId: botId,
          })
          .where(eq(artifactsTable.id, row.id)),
      );
      updated++;
    } catch (err) {
      // Per-row isolation: a single persistent failure (e.g. the DB pool
      // briefly unavailable) must not abort the entire repair the way it did
      // before. Count it and move on; the row stays NULL and is retried next
      // run.
      failed++;
      logger.warn({ err, id: row.id }, "repair: row failed; continuing");
    } finally {
      processed++;
      // Periodic breather so the long sequential sweep doesn't starve the
      // request-serving connection pool.
      if (processed % 200 === 0) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }

  logger.info(
    {
      candidates: rows.length,
      resolved,
      viaPartner,
      unresolved,
      updated,
      failed,
      distinctCreators: agentCache.size,
      partnerBudgetLeft: partnerBudget,
    },
    "repairCreatorAttribution: complete",
  );
}

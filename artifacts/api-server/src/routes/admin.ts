import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { usersTable, agentsTable, artifactsTable } from "@workspace/db/schema";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { requireAdmin } from "../middlewares/requireAuth";
import { ListAdminUsersResponse, UpdateAdminUserBody, UpdateAdminUserParams } from "@workspace/api-zod";
import { getPartnerAgent, partnerApiAvailable, PartnerApiError } from "../lib/partnerClient";

const router: IRouter = Router();

function formatUser(u: typeof usersTable.$inferSelect) {
  return {
    id: u.id,
    email: u.email ?? null,
    firstName: u.firstName ?? null,
    lastName: u.lastName ?? null,
    displayName: u.displayName ?? null,
    profileImageUrl: u.profileImageUrl ?? null,
    bio: u.bio ?? null,
    role: u.role,
    disabledAt: u.disabledAt ? u.disabledAt.toISOString() : null,
    createdAt: u.createdAt.toISOString(),
  };
}

router.get("/admin/users", requireAdmin, async (_req, res) => {
  const users = await db.select().from(usersTable).orderBy(desc(usersTable.createdAt));
  res.json(ListAdminUsersResponse.parse({ users: users.map(formatUser) }));
});

router.patch("/admin/users/:id", requireAdmin, async (req, res) => {
  const { id } = UpdateAdminUserParams.parse(req.params);
  const body = UpdateAdminUserBody.parse(req.body);

  const updates: Record<string, unknown> = {};
  if (body.role !== undefined) updates.role = body.role;
  if (body.disabled !== undefined) updates.disabledAt = body.disabled ? new Date() : null;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  if (req.user && req.user.id === id) {
    if (body.role === "user" || body.disabled === true) {
      res.status(400).json({ error: "You cannot demote or disable your own admin account" });
      return;
    }
  }

  const willRemoveAdmin = body.role === "user" || body.disabled === true;
  if (willRemoveAdmin) {
    const [target] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
    if (target && target.role === "admin" && !target.disabledAt) {
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(usersTable)
        .where(and(eq(usersTable.role, "admin"), isNull(usersTable.disabledAt), ne(usersTable.id, id)));
      if (count === 0) {
        res.status(409).json({ error: "Cannot remove the last active admin" });
        return;
      }
    }
  }

  const [updated] = await db
    .update(usersTable)
    .set(updates)
    .where(eq(usersTable.id, id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(formatUser(updated));
});

function slugifyCreator(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

/**
 * One-shot fix: re-attribute artifacts to the correct agent based on each
 * artifact's preserved `creator_name`. The legacy backfill bucketed every
 * kannaka-system-owned row under the `kannaka` agent, so artists like Rex,
 * Aaga, etc. all show up as Kannaka. This walks the distinct creator names,
 * ensures an agent exists for each (looking it up in the partner API when
 * possible, otherwise creating a local-only agent owned by the calling admin),
 * then updates `artifacts.agent_id` to match. Idempotent — re-running only
 * touches rows that are still wrong.
 */
router.post("/admin/reattribute-artifacts", requireAdmin, async (req, res) => {
  const adminId = req.user!.id;
  const dryRun = req.query["dryRun"] === "true";

  const groups = await db
    .select({
      creatorName: artifactsTable.creatorName,
      currentAgentSlug: agentsTable.slug,
      total: sql<number>`count(*)::int`,
    })
    .from(artifactsTable)
    .leftJoin(agentsTable, eq(agentsTable.id, artifactsTable.agentId))
    .groupBy(artifactsTable.creatorName, agentsTable.slug);

  const summary: Array<{
    creatorName: string;
    targetSlug: string;
    agentExisted: boolean;
    partnerVerified: boolean;
    artifactsToUpdate: number;
    artifactsUpdated: number;
  }> = [];

  // Aggregate per creator across (possibly multiple) current agent buckets.
  const byCreator = new Map<string, { totalRows: number; misalignedRows: number; targetSlug: string }>();
  for (const row of groups) {
    const creator = (row.creatorName || "").trim();
    if (!creator) continue;
    const targetSlug = slugifyCreator(creator);
    if (!targetSlug) continue;
    const entry = byCreator.get(creator) ?? { totalRows: 0, misalignedRows: 0, targetSlug };
    entry.totalRows += row.total;
    if (row.currentAgentSlug !== targetSlug) entry.misalignedRows += row.total;
    byCreator.set(creator, entry);
  }

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
          req.log.warn({ err, slug: targetSlug }, "Partner lookup failed during reattribution");
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
          ownerId: adminId,
        })
        .onConflictDoNothing({ target: agentsTable.slug })
        .returning();
      agent = inserted[0];
      if (!agent) {
        // Lost a race with a concurrent insert; fetch the existing row.
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
            agent.id !== null
              ? sql`(${artifactsTable.agentId} IS NULL OR ${artifactsTable.agentId} <> ${agent.id})`
              : sql`true`,
          ),
        )
        .returning({ id: artifactsTable.id });
      updated = updates.length;
    }

    summary.push({
      creatorName,
      targetSlug,
      agentExisted,
      partnerVerified,
      artifactsToUpdate: misalignedRows,
      artifactsUpdated: updated,
    });
  }

  res.json({
    dryRun,
    creatorsProcessed: summary.length,
    totalArtifactsUpdated: summary.reduce((s, x) => s + x.artifactsUpdated, 0),
    details: summary.sort((a, b) => b.artifactsToUpdate - a.artifactsToUpdate),
  });
});

export default router;

import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { requireAdmin } from "../middlewares/requireAuth";
import { ListAdminUsersResponse, UpdateAdminUserBody, UpdateAdminUserParams } from "@workspace/api-zod";
import { reattributeArtifactsByCreator } from "../lib/backfill";

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

router.post("/admin/reattribute-artifacts", requireAdmin, async (req, res) => {
  const result = await reattributeArtifactsByCreator({
    ownerId: req.user!.id,
    dryRun: req.query["dryRun"] === "true",
  });
  res.json(result);
});

export default router;

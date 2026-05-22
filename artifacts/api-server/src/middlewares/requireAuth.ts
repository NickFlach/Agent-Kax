import { type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user.id)).limit(1);
  if (!user || user.disabledAt) {
    res.status(403).json({ error: "Account disabled" });
    return;
  }
  next();
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user.id)).limit(1);
  if (!user || user.role !== "admin" || user.disabledAt) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}

/**
 * Returns true if the request is authenticated and the user owns the resource
 * (or is an admin). `ownerId` may be null for legacy/Kannaka-system rows; only
 * admins may mutate those.
 */
export async function canMutate(req: Request, ownerId: string | null): Promise<boolean> {
  if (!req.isAuthenticated()) return false;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user.id)).limit(1);
  if (!user || user.disabledAt) return false;
  if (user.role === "admin") return true;
  return ownerId !== null && ownerId === user.id;
}

/**
 * Determine which ownerId(s) a list/aggregate endpoint should be scoped to.
 * Regular users always see only their own data. Admins see only their own data
 * by default, but can pass `?all=true` to query across every user.
 *
 * Returns `null` to indicate "no owner filter" (admin + all=true). Otherwise
 * returns the user id to scope by.
 *
 * Must be called *after* `requireAuth` middleware.
 */
export async function getOwnerScope(req: Request): Promise<string | null> {
  const userId = req.user!.id;
  const wantsAll = req.query["all"] === "true";
  if (!wantsAll) return userId;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (user?.role === "admin") return null;
  return userId;
}

/**
 * Return the authenticated user when one exists and is in good standing —
 * otherwise null. Lets routes serve both public visitors and signed-in
 * owners from a single handler (owner sees more; public sees the
 * publishable subset).
 *
 * Unlike `requireAuth` this never short-circuits the response: callers
 * apply their own visibility logic against the returned user.
 */
export async function getOptionalAuth(req: Request): Promise<{ id: string; role: string } | null> {
  if (!req.isAuthenticated()) return null;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user.id)).limit(1);
  if (!user || user.disabledAt) return null;
  return { id: user.id, role: user.role };
}

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

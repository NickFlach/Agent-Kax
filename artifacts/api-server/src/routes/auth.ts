import { Router, type IRouter, type Request, type Response } from "express";
import {
  GetCurrentAuthUserResponse,
  UpdateNotificationPrefsBody,
  UpdateNotificationPrefsResponse,
} from "@workspace/api-zod";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { clearSession, getSessionId } from "../lib/auth";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();

const getCurrentUser = async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.json(GetCurrentAuthUserResponse.parse({ user: null }));
    return;
  }
  const [dbUser] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, req.user.id))
    .limit(1);
  if (!dbUser || dbUser.disabledAt) {
    res.json(GetCurrentAuthUserResponse.parse({ user: null }));
    return;
  }
  res.json(
    GetCurrentAuthUserResponse.parse({
      user: {
        id: dbUser.id,
        email: dbUser.email,
        firstName: dbUser.firstName,
        lastName: dbUser.lastName,
        profileImageUrl: dbUser.profileImageUrl,
        displayName: dbUser.displayName,
        role: dbUser.role,
        notificationPrefs: {
          emailOnProposal: dbUser.emailOnProposal,
          emailOnDm: dbUser.emailOnDm,
        },
      },
    }),
  );
};

router.get("/auth/user", getCurrentUser);
router.get("/me", getCurrentUser);

router.patch("/me/notification-prefs", requireAuth, async (req: Request, res: Response) => {
  const parsed = UpdateNotificationPrefsBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
    return;
  }
  const updates: { emailOnProposal?: boolean; emailOnDm?: boolean } = {};
  if (parsed.data.emailOnProposal !== undefined) updates.emailOnProposal = parsed.data.emailOnProposal;
  if (parsed.data.emailOnDm !== undefined) updates.emailOnDm = parsed.data.emailOnDm;
  // requireAuth guarantees req.user is set + the user row is in good
  // standing. Use `!` to assert that to the type checker.
  const userId = req.user!.id;
  if (Object.keys(updates).length === 0) {
    const [u] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    res.json(
      UpdateNotificationPrefsResponse.parse({
        emailOnProposal: u?.emailOnProposal ?? false,
        emailOnDm: u?.emailOnDm ?? false,
      }),
    );
    return;
  }
  const [updated] = await db
    .update(usersTable)
    .set(updates)
    .where(eq(usersTable.id, userId))
    .returning();
  res.json(
    UpdateNotificationPrefsResponse.parse({
      emailOnProposal: updated.emailOnProposal,
      emailOnDm: updated.emailOnDm,
    }),
  );
});

/**
 * Wallet-only logout: delete the server-side session row and clear the
 * cookie. No issuer round-trip — wallet sessions have no upstream IdP
 * to notify. Accept POST (preferred, CSRF-friendly when paired with
 * SameSite=lax cookies) and GET (for the legacy redirect-style call
 * sites that still link to it; harmless because there is nothing to
 * end-session on the wallet side).
 */
async function handleLogout(req: Request, res: Response) {
  const sid = getSessionId(req);
  await clearSession(res, sid);
  res.json({ success: true });
}

router.post("/logout", handleLogout);
router.get("/logout", handleLogout);

export default router;

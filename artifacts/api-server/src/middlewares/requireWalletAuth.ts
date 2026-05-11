import { type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { getSession, getSessionId } from "../lib/auth";

/**
 * Stricter than `requireAuth`: the current session must have been
 * opened via the wallet sign-in path (access_token starts with
 * `wallet:`), AND the underlying user row must carry a wallet address.
 *
 * Used to gate OBC-bot ATTACHMENT endpoints — wallet is canonical
 * identity, so OIDC-only or grandfathered `obc_agent:` sessions cannot
 * attach a bot to themselves. They must first sign in with a wallet
 * (which will email-link them onto the same `users` row if their email
 * matches, per `upsertUser`).
 */
export async function requireWalletAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const sid = getSessionId(req);
  const session = sid ? await getSession(sid) : null;
  const token = session?.access_token;
  if (typeof token !== "string" || !token.startsWith("wallet:")) {
    res.status(403).json({ error: "Wallet sign-in required to manage attached bots" });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user.id)).limit(1);
  if (!user || user.disabledAt) {
    res.status(403).json({ error: "Account disabled" });
    return;
  }
  if (!user.walletAddress) {
    res.status(403).json({ error: "Wallet sign-in required to manage attached bots" });
    return;
  }
  next();
}
